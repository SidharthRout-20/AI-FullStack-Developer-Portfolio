"""Control room: the site owner's settings for the AI provider, the products and Tara, changed from the UI.

Safe by construction:

* Owner only: every read and write needs the owner key (X-Tara-Owner-Key, compared in constant time).
* Nothing secret goes through it: API keys stay in the server's environment (ANTHROPIC_API_KEY, GROQ_API_KEY). The UI
  only sees whether each key is present.
* A strict schema: fixed choices (providers, models, effort levels), bounded numbers, unknown fields refused. Security
  settings (CORS, the owner key, rate limits, safety checks) are deliberately not on it.
* Paid models need a monthly budget. Spend is metered per call from the provider's token counts; when the budget is
  used up, calls go back to the free tier on their own. Evals always run on the free tier.
* Every change is recorded (when, what changed from what) and shown in the control room.
* If the paid provider fails (no key, an outage), the call falls back to the free tier, so the site keeps working.
"""

from __future__ import annotations

import asyncio
import contextvars
import datetime as dt
import logging
import secrets
import time
from collections.abc import AsyncIterator, Callable, Sequence
from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.responses import JSONResponse

from appcore.docstore import DocStore
from appcore.security import limiter

logger = logging.getLogger(__name__)

# ── The settings ─────────────────────────────────────────────────────────────
# Claude models and their list prices per million tokens (input, output), from Anthropic's model catalogue.
CLAUDE_MODELS: dict[str, tuple[str, float, float]] = {
    "claude-haiku-5-5": ("Claude Haiku 5.5 · fast, lowest cost", 0.10, 0.50),
    "claude-sonnet-5-5": ("Claude Sonnet 5.5 · balanced", 2.0, 10.0),
    "claude-opus-5-5": ("Claude Opus 5.5 · most capable", 4.0, 20.0),
}
PRODUCTS = {
    "tara": ("Tara", ("/api/keeper", "/api/tara")),
    "safarnaama": ("Safarnaama", ("/api/trips",)),
    "codelens": ("CodeLens", ("/api/code",)),
    "jasoos": ("Jasoos", ("/api/efi",)),
    "labs": ("Labs (in development)", ("/api/career", "/api/evolve", "/api/flows", "/api/hooks", "/api/meetings")),
}
Product = Literal["tara", "safarnaama", "codelens", "jasoos", "labs"]


class AIConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: Literal["groq", "anthropic"] = "groq"
    claude_model: Literal["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"] = "claude-haiku-5-5"
    claude_effort: Literal["low", "medium", "high"] = "low"
    monthly_budget_usd: float = Field(0.0, ge=0, le=500)  # a hard cap: past it, calls go back to the free tier
    paid_for: list[Product] = Field(default_factory=lambda: ["tara"])  # which products may use the paid model

    @model_validator(mode="after")
    def _paid_needs_budget(self) -> AIConfig:
        if self.provider == "anthropic" and self.monthly_budget_usd <= 0:
            raise ValueError("Set a monthly budget above $0 to use a paid provider.")
        return self


class TaraConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lookups: bool = True  # weather, news, facts, rates: calls to outside services
    product_handoff: bool = True  # hand requests to the site's own products first
    code_proposals: bool = True  # the owner's code change requests (still owner-only)
    history_turns: int = Field(6, ge=0, le=8)  # how much of the conversation the model sees


class ControlConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ai: AIConfig = Field(default_factory=AIConfig)
    # The in-development apps keep one shared store for every visitor, so they stay paused until they have per-person
    # data like the four featured products (the owner can open them here for a demo).
    products: dict[Product, bool] = Field(default_factory=lambda: {**dict.fromkeys(PRODUCTS, True), "labs": False})
    tara: TaraConfig = Field(default_factory=TaraConfig)


# Evals always measure on the free tier, so a public "Run with live model" can never spend the owner's budget.
FREE_ONLY: contextvars.ContextVar[bool] = contextvars.ContextVar("free_only", default=False)


def product_of(task: str) -> str:
    head = task.split(".", 1)[0]
    return {"keeper": "tara", "tara": "tara", "tripweaver": "safarnaama", "safarnaama": "safarnaama",
            "codelens": "codelens", "efi": "jasoos", "jasoos": "jasoos"}.get(head, "labs")  # fmt: skip


def _diff(old: dict[str, Any], new: dict[str, Any], path: str = "") -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for k in sorted(set(old) | set(new)):
        a, b, p = old.get(k), new.get(k), f"{path}{k}"
        if isinstance(a, dict) and isinstance(b, dict):
            out += _diff(a, b, p + ".")
        elif a != b:
            out.append({"setting": p, "from": a, "to": b})
    return out


class Control:
    """The current settings (cached briefly per process), their history, and paid-model spend."""

    TTL_S = 10.0

    def __init__(self, settings: Any) -> None:
        self.settings = settings
        self.store = DocStore(settings.data_dir / "control.sqlite3", settings.db_url)
        self._cached: tuple[float, ControlConfig] | None = None

    def now(self) -> ControlConfig:
        if self._cached and time.monotonic() - self._cached[0] < self.TTL_S:
            return self._cached[1]
        doc = self.store.get("config", "current")
        try:
            cfg = ControlConfig.model_validate(
                {k: v for k, v in (doc or {}).items() if k in ControlConfig.model_fields}
            )
        except ValueError:  # a stored config the schema no longer accepts: safe defaults, never a crash
            logger.warning("Stored control config is invalid; using defaults")
            cfg = ControlConfig()
        self._cached = (time.monotonic(), cfg)
        return cfg

    def save(self, cfg: ControlConfig) -> list[dict[str, Any]]:
        old = self.now().model_dump()
        new = cfg.model_dump()
        changes = _diff(old, new)
        if changes:
            self.store.put("config", new, id="current")
            self.store.put("audit", {"at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"), "changes": changes})
        self._cached = (time.monotonic(), cfg)
        return changes

    def audit(self, limit: int = 30) -> list[dict[str, Any]]:
        return [{"at": d["at"], "changes": d["changes"]} for d in self.store.list("audit", limit=limit)]

    # ── spend ──
    @staticmethod
    def _month() -> str:
        return dt.datetime.now(dt.UTC).strftime("%Y-%m")

    def spend(self) -> dict[str, Any]:
        d = self.store.get("spend", self._month()) or {}
        return {"month": self._month(), "usd": round(float(d.get("usd", 0)), 4), "calls": int(d.get("calls", 0)),
                "input_tokens": int(d.get("input_tokens", 0)), "output_tokens": int(d.get("output_tokens", 0)),
                "budget_fallbacks": int(d.get("budget_fallbacks", 0)), "errors": int(d.get("errors", 0))}  # fmt: skip

    def record(self, *, usd: float = 0, input_tokens: int = 0, output_tokens: int = 0, budget_fallback: bool = False,
               error: bool = False) -> None:  # fmt: skip
        s = self.spend()
        self.store.put("spend", {
            "usd": s["usd"] + usd, "calls": s["calls"] + (0 if budget_fallback or error else 1),
            "input_tokens": s["input_tokens"] + input_tokens, "output_tokens": s["output_tokens"] + output_tokens,
            "budget_fallbacks": s["budget_fallbacks"] + int(budget_fallback), "errors": s["errors"] + int(error),
        }, id=self._month())  # fmt: skip

    def keys(self) -> dict[str, bool]:
        import os

        s = self.settings
        has = lambda v: bool(v and v.get_secret_value())  # noqa: E731
        return {
            "groq": has(s.groq_api_key),
            "anthropic": has(s.anthropic_api_key) or bool(os.environ.get("ANTHROPIC_API_KEY")),
        }


# ── The model every product uses: free tier or the paid provider, per call ─────────
class SwitchableLLM:
    """A ChatLLM that follows the control room. Speech and photos stay on the free router (text only here)."""

    def __init__(self, base: Any, control: Control, settings: Any, task: str = "app.unspecified",
                 claude_factory: Callable[[Any], Any] | None = None) -> None:  # fmt: skip
        self.base, self.control, self.settings, self.task = base, control, settings, task
        self._claude_factory = claude_factory
        self._claude: dict[tuple[str, str], Any] = {}

    def for_task(self, task: str) -> SwitchableLLM:
        twin = SwitchableLLM(self.base, self.control, self.settings, task, self._claude_factory)
        twin._claude = self._claude
        return twin

    def _free(self) -> Any:
        return self.base.for_task(self.task) if hasattr(self.base, "for_task") else self.base

    def _paid(self) -> tuple[Any, tuple[float, float]] | None:
        """The Claude client to use for this call, or None (free tier): provider, scope, budget and key all agree."""
        if FREE_ONLY.get():
            return None
        ai = self.control.now().ai
        if ai.provider != "anthropic" or product_of(self.task) not in ai.paid_for:
            return None
        if self.control.spend()["usd"] >= ai.monthly_budget_usd:
            self.control.record(budget_fallback=True)
            return None
        key = (ai.claude_model, ai.claude_effort)
        if key not in self._claude:
            try:
                factory = self._claude_factory or _claude_factory
                self._claude[key] = factory(self.settings.model_copy(update={"claude_model": ai.claude_model,
                                                                             "claude_effort": ai.claude_effort}))  # fmt: skip
            except Exception as exc:  # noqa: BLE001 - no key / SDK missing: stay on the free tier
                logger.warning("Paid provider unavailable (%s); using the free tier", type(exc).__name__)
                return None
        _, price_in, price_out = CLAUDE_MODELS[ai.claude_model]
        return self._claude[key], (price_in, price_out)

    def _meter(self, client: Any, prices: tuple[float, float]) -> None:
        usage = getattr(client, "last_usage", None)
        if usage is None:
            return
        i, o = int(getattr(usage, "input_tokens", 0) or 0), int(getattr(usage, "output_tokens", 0) or 0)
        self.control.record(usd=(i * prices[0] + o * prices[1]) / 1_000_000, input_tokens=i, output_tokens=o)

    async def complete(self, system: str | None, messages: Sequence[Any], *, short: bool = False) -> str:
        paid = await asyncio.to_thread(self._paid)
        if paid:
            client, prices = paid
            try:
                text = await client.complete(system, messages, short=short)
                await asyncio.to_thread(self._meter, client, prices)
                return text
            except Exception as exc:  # noqa: BLE001 - the paid provider failing must not take the site down
                logger.warning("Paid model call failed (%s); falling back to the free tier", type(exc).__name__)
                await asyncio.to_thread(self.control.record, error=True)
        return await self._free().complete(system, messages, short=short)

    async def stream(self, system: str | None, messages: Sequence[Any]) -> AsyncIterator[str]:
        paid = await asyncio.to_thread(self._paid)
        if paid:
            client, prices = paid
            try:
                async for chunk in client.stream(system, messages):
                    yield chunk
                await asyncio.to_thread(self._meter, client, prices)
                return
            except Exception as exc:  # noqa: BLE001
                logger.warning("Paid model stream failed (%s); falling back to the free tier", type(exc).__name__)
                await asyncio.to_thread(self.control.record, error=True)
        async for chunk in self._free().stream(system, messages):
            yield chunk


def _claude_factory(settings: Any) -> Any:
    from appcore.llm.chat import ClaudeLLM

    return ClaudeLLM(settings)


# ── Pausing a product ────────────────────────────────────────────────────────
class ProductGate:
    """ASGI middleware: a product the owner paused answers 503 with a plain message (the control API never pauses)."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] == "http" and (control := getattr(scope["app"].state, "control", None)) is not None:
            path = scope.get("path", "")
            on = control.now().products
            for key, (name, prefixes) in PRODUCTS.items():
                if not on.get(key, True) and any(path == p or path.startswith(p + "/") for p in prefixes):
                    res = JSONResponse({"detail": f"{name} is paused by the site owner for now."}, status_code=503)
                    await res(scope, receive, send)
                    return
        await self.app(scope, receive, send)


_ACTIVE: Control | None = None


def set_active(control: Control | None) -> None:
    global _ACTIVE
    _ACTIVE = control


def active() -> ControlConfig:
    """The settings now (defaults when no control room is running, e.g. in unit tests)."""
    return _ACTIVE.now() if _ACTIVE else ControlConfig()


def current(request: Request) -> ControlConfig:
    control = getattr(request.app.state, "control", None)
    return control.now() if control else ControlConfig()


# ── API (owner only, except the public product switches) ─────────────────────
router = APIRouter(prefix="/api/control", tags=["control"])


def _owner(request: Request, key: str | None) -> Control:
    s = request.app.state.keeper.settings
    want = s.tara_owner_key.get_secret_value() if getattr(s, "tara_owner_key", None) else ""
    if not want:
        raise HTTPException(503, "Set TARA_OWNER_KEY on the server to use the control room.")
    if not key or not secrets.compare_digest(key, want):
        raise HTTPException(403, "The control room is for the site's owner. Enter the owner key.")
    return request.app.state.control


def _view(control: Control) -> dict[str, Any]:
    return {
        "config": control.now().model_dump(),
        "keys": control.keys(),
        "spend": control.spend(),
        "options": {
            "claude_models": [{"id": k, "label": v[0], "input_per_mtok": v[1], "output_per_mtok": v[2]} for k, v in CLAUDE_MODELS.items()],
            "products": [{"id": k, "name": v[0]} for k, v in PRODUCTS.items()],
        },
        "audit": control.audit(),
    }  # fmt: skip


@router.get("")
def read(request: Request, x_tara_owner_key: str | None = Header(None)) -> dict[str, Any]:
    return _view(_owner(request, x_tara_owner_key))


@router.put("")
@limiter.limit("30/minute")
def write(request: Request, body: ControlConfig, x_tara_owner_key: str | None = Header(None)) -> dict[str, Any]:
    control = _owner(request, x_tara_owner_key)
    if body.ai.provider == "anthropic" and not control.keys()["anthropic"]:
        raise HTTPException(409, "ANTHROPIC_API_KEY is not set on the server. Add it in Vercel first, then switch.")
    changes = control.save(body)
    return {**_view(control), "changed": changes}


@router.get("/public")
def public(request: Request) -> dict[str, Any]:
    """What visitors may know: which products are open (so a paused one can say so)."""
    return {"products": current(request).products}
