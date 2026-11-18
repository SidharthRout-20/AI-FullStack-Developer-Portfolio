"""The central LLM router: every application model call goes through `LLMRouter`.

Pipeline (all deterministic, no model call to choose a model):
  request → classify (task, complexity, modality, structured output, tools, context size, priority)
  → discover models (cached `GET /openai/v1/models`) → hard filters → score → select → model-specific params
  → execute (bounded, sequential retries) → record usage & rate-limit headers → result + routing metadata
  → on failure: fall back to the next model that still passes every hard filter, or a controlled error.

Hard requirements are filters, never scores: modality, endpoint type, verified capabilities, free-tier eligibility,
availability, context fit, quota and the reasoning floor for the request's complexity. A complex request is never
silently downgraded. There is no path to any paid provider: only Groq models marked free-tier eligible in the
verified registry can be selected, and if none can serve the request the caller gets `NoCompatibleModelError`.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import Counter, deque
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from appcore.llm.catalog import ModelCatalog, ModelSpec
from appcore.llm.classify import TASKS, Classification, Complexity, LLMRequest, classify_request
from appcore.llm.quota import QuotaTracker
from appcore.llm.transport import ChatResult, GroqTransport, ProviderError, Transport, build_messages
from appcore.settings import CoreSettings as Settings

logger = logging.getLogger(__name__)

# Minimum reasoning tier per complexity (see ModelSpec.tier). Fallback may never go below the floor.
FLOOR = {Complexity.SIMPLE: 1, Complexity.STANDARD: 2, Complexity.COMPLEX: 3, Complexity.ADVANCED: 4}
WEIGHTS = {
    "base": 100.0,
    "overkill_per_tier": 12.0,  # prefer the smallest adequate model (saves the big model's quota)
    "preview": 25.0,  # production models first; preview ones may be discontinued at short notice
    "speed_per_100_tps": 2.0,
    "speed_cap": 20.0,
    "headroom": 10.0,  # more remaining daily requests → small bonus
    "safe_default": 5.0,
    "preferred": 30.0,
}


class RouterError(RuntimeError):
    """Routing or provider failure. The message is safe to show to users."""


class NoCompatibleModelError(RouterError):
    def __init__(self, message: str, retry_after: float | None = None, quota: bool = False) -> None:
        super().__init__(message)
        self.retry_after = retry_after
        self.quota = quota


@dataclass
class Candidate:
    spec: ModelSpec
    score: float
    reasons: list[str]


@dataclass
class RoutingDecision:
    id: str
    at: str
    product: str
    feature: str
    classification: dict[str, Any]
    selected: str | None = None
    reason: str = ""
    candidates: list[dict[str, Any]] = field(default_factory=list)
    rejected: dict[str, str] = field(default_factory=dict)
    attempts: list[dict[str, Any]] = field(default_factory=list)
    fallback: bool = False
    final_model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    usage_estimated: bool = False
    latency_ms: int | None = None
    outcome: str = "pending"
    error: str | None = None
    rate_limit: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


@dataclass
class RouterResult:
    text: str
    model: str
    input_tokens: int | None
    output_tokens: int | None
    decision: RoutingDecision
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    finish_reason: str | None = None
    raw: Any = None  # transcription result object


def _iso() -> str:
    import datetime as dt

    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds")


class LLMRouter:
    def __init__(
        self,
        settings: Settings,
        transport: Transport | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
        catalog: ModelCatalog | None = None,
    ) -> None:
        self.settings = settings
        self._transport = transport
        self.clock, self.sleep = clock, sleep
        self.catalog = catalog or ModelCatalog()
        s = settings
        self.quota = QuotaTracker(
            {1: 0.0, 2: s.llm_router_reserve_p2, 3: s.llm_router_reserve_p3, 4: s.llm_router_reserve_p4}, clock
        )
        self.decisions: deque[RoutingDecision] = deque(maxlen=200)
        self.usage: Counter[str] = Counter()
        self._discovery_lock = asyncio.Lock()

    # ── provider access ─────────────────────────────────────────────────────
    @property
    def configured(self) -> bool:
        key = self.settings.groq_api_key
        return self._transport is not None or bool(key and key.get_secret_value())

    @property
    def transport(self) -> Transport:
        if self._transport is None:
            from appcore.llm.chat import LLMNotConfiguredError

            key = self.settings.groq_api_key.get_secret_value() if self.settings.groq_api_key else ""
            if not key:
                raise LLMNotConfiguredError(
                    "GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys. "
                    "(No paid provider is used as a fallback.)"
                )
            self._transport = GroqTransport(key, self.settings.llm_timeout_s)
        return self._transport

    # ── discovery & registry ────────────────────────────────────────────────
    async def discover_models(self, force: bool = False) -> bool:
        """Refresh availability from Groq's models endpoint (cached for `llm_router_discovery_ttl_s`).
        On failure the verified registry is used as-is and the failure is reported in diagnostics."""
        ttl = self.settings.llm_router_discovery_ttl_s
        if not force and self.catalog.discovered_at is not None and self.clock() - self.catalog.discovered_at < ttl:
            return True
        async with self._discovery_lock:
            if not force and self.catalog.discovered_at is not None and self.clock() - self.catalog.discovered_at < ttl:
                return True
            try:
                models = await asyncio.wait_for(self.transport.list_models(), 10)
            except Exception as exc:  # noqa: BLE001 - discovery must never break a request
                kind = exc.kind if isinstance(exc, ProviderError) else type(exc).__name__
                self.catalog.discovery_error = f"model discovery failed ({kind}); using the verified registry"
                self.catalog.discovered_at = self.clock() - max(0, ttl - 300)  # retry in ~5 minutes
                logger.info("LLM router: %s", self.catalog.discovery_error)
                return False
            self.catalog.apply_discovery(models, self.clock())
            logger.info("LLM router: discovered %d Groq models", len(models))
            return True

    def get_model_capabilities(self, model_id: str) -> dict[str, Any] | None:
        return next((m for m in self.catalog.snapshot() if m["id"] == model_id), None)

    classify_request = staticmethod(classify_request)

    # ── selection ─────────────────────────────────────────────────────────────
    def _reject(self, spec: ModelSpec, cls: Classification, req: LLMRequest, min_context: int | None) -> str | None:
        """Hard filters. Returns why a model can't serve this request, or None."""
        if not spec.known:
            return "capabilities not verified"
        if spec.free_tier is not True:
            return "not free-tier eligible"
        endpoint = "transcription" if cls.modality == "audio" else "chat"
        if spec.endpoint != endpoint:
            return f"wrong endpoint ({spec.endpoint}) for {cls.modality} input"
        if cls.category == "safety_classification":
            if "safety" not in spec.roles:
                return "not a safety-classification model"
        elif not spec.general_purpose and endpoint == "chat":
            return f"specialised model ({', '.join(spec.roles)}) not used for {cls.category}"
        if spec.stage == "preview" and not self.settings.llm_router_allow_preview:
            return "preview models disabled"
        ok, why = self.catalog.available(spec.id)
        if not ok:
            return why
        if endpoint == "transcription":
            if req.response_params.get("task") == "translate" and "translation" not in spec.roles:
                return "no translation support"
            size_mb = len(req.audio[1]) / 1_048_576 if req.audio else 0
            if spec.max_file_mb and size_mb > spec.max_file_mb:
                return f"audio larger than {spec.max_file_mb} MB"
        else:
            if cls.modality == "image" and spec.vision is not True:
                return "no verified vision support"
            if cls.images and spec.max_images is not None and cls.images > spec.max_images:
                return f"more than {spec.max_images} images"
            if cls.structured == "strict" and spec.strict_schema is not True:
                return "no verified strict structured outputs"
            if cls.structured == "schema" and spec.json_schema is not True:
                return "no verified JSON-schema output"
            if cls.structured == "json" and spec.json_object is not True and spec.json_schema is not True:
                return "no verified JSON output"
            if cls.needs_tools and spec.tools is not True:
                return "no verified tool calling"
            if cls.needs_parallel_tools and spec.parallel_tools is not True:
                return "no verified parallel tool calling"
            if spec.tier < FLOOR[cls.complexity]:
                return f"below the reasoning floor for a {cls.complexity.name.lower()} request"
            out = self._max_out(spec, req)
            if spec.context_window is None:
                return "context window unknown"
            if cls.est_input_tokens + out > spec.context_window:
                return f"context too small (~{cls.est_input_tokens}+{out} > {spec.context_window})"
            if min_context and spec.context_window < min_context:
                return "context smaller than a model that already overflowed"
        ok, why, _ = self.quota.can_serve(spec.id, self._quota_tokens(cls, req, spec), cls.priority)
        return None if ok else why

    def _max_out(self, spec: ModelSpec, req: LLMRequest) -> int:
        profile = TASKS.get(req.task)
        want = req.max_output_tokens or (profile and profile.max_output_tokens) or self.settings.llm_max_tokens
        return min(want, spec.max_output_tokens or want)

    def _quota_tokens(self, cls: Classification, req: LLMRequest, spec: ModelSpec) -> int:
        return cls.est_input_tokens + (min(self._max_out(spec, req), 1024) if spec.endpoint == "chat" else 0)

    def rank(
        self, req: LLMRequest, cls: Classification, exclude: set[str] | None = None, min_context: int | None = None
    ) -> tuple[list[Candidate], dict[str, str]]:
        exclude = exclude or set()
        cands: list[Candidate] = []
        rejected: dict[str, str] = {}
        default = self.settings.groq_model
        for spec in self.catalog.specs.values():
            if spec.id in exclude:
                rejected[spec.id] = "already failed for this request"
                continue
            if why := self._reject(spec, cls, req, min_context):
                rejected[spec.id] = why
                continue
            w, reasons = WEIGHTS, []
            floor = FLOOR[cls.complexity] if spec.endpoint == "chat" else 1
            score = w["base"] - w["overkill_per_tier"] * max(0, spec.tier - floor)
            if spec.tier > floor:
                reasons.append(f"tier {spec.tier} > needed {floor}")
            if spec.stage == "preview":
                score -= w["preview"]
                reasons.append("preview")
            if spec.speed_tps:
                score += min(w["speed_cap"], spec.speed_tps / 100 * w["speed_per_100_tps"])
            if (h := self.quota.headroom(spec.id)) is not None:
                score += w["headroom"] * h
                reasons.append(f"{round(h * 100)}% daily requests left")
            if spec.id == default:
                score += w["safe_default"]
            if req.prefer_model and spec.id == req.prefer_model:
                score += w["preferred"]
                reasons.append("preferred by the caller")
            cands.append(Candidate(spec, round(score, 1), reasons))
        cands.sort(key=lambda c: -c.score)
        # Undeclared tasks: routing can't be determined reliably → the configured safe default, if it qualifies.
        if not cls.task_known and cls.modality == "text":
            for i, c in enumerate(cands):
                if c.spec.id == default:
                    cands.insert(0, cands.pop(i))
                    c.reasons.insert(0, "safe default for an undeclared task")
                    break
        return cands, rejected

    def _new_decision(self, req: LLMRequest, cls: Classification) -> RoutingDecision:
        return RoutingDecision(
            id=uuid.uuid4().hex[:16], at=_iso(), product=req.product, feature=req.feature, classification=cls.as_dict()
        )

    def select_model(self, req: LLMRequest) -> RoutingDecision:
        """Dry run: which model would serve this request now, and why (no provider call)."""
        cls = classify_request(req)
        d = self._new_decision(req, cls)
        cands, rejected = self.rank(req, cls)
        self._describe(d, cands, rejected)
        d.outcome = "dry_run" if cands else "no_compatible_model"
        return d

    @staticmethod
    def _describe(d: RoutingDecision, cands: list[Candidate], rejected: dict[str, str]) -> None:
        d.candidates = [{"model": c.spec.id, "score": c.score, "notes": c.reasons} for c in cands]
        d.rejected = rejected
        if cands and d.selected is None:
            top = cands[0]
            d.selected = top.spec.id
            cls = d.classification
            d.reason = (
                f"{cls['complexity'].lower()} {cls['modality']} {cls['category']} request; "
                f"{top.spec.id} is the best eligible match (score {top.score}"
                + (f"; {', '.join(top.reasons)}" if top.reasons else "")
                + ")"
            )

    # ── execution ─────────────────────────────────────────────────────────────
    def _params(self, spec: ModelSpec, cls: Classification, req: LLMRequest) -> dict[str, Any]:
        p: dict[str, Any] = {
            "max_completion_tokens": self._max_out(spec, req),
            "temperature": req.temperature if req.temperature is not None else self.settings.llm_temperature,
        }
        profile = TASKS.get(req.task)
        effort = req.reasoning_effort or (profile and profile.reasoning_effort)
        if effort is None and cls.complexity == Complexity.SIMPLE:
            effort = "none" if "none" in spec.effort_values else "low"
        if effort and spec.effort_values:
            p["reasoning_effort"] = effort if effort in spec.effort_values else spec.effort_values[0]
        if spec.hides_reasoning_param and spec.reasoning:
            p["reasoning_format"] = "hidden"  # keep thinking out of the content (JSON parsing stays reliable)
        if cls.structured == "json" and spec.json_object:
            # Groq checks the reply is one well-formed JSON object (a malformed one fails over to another model)
            p["response_format"] = {"type": "json_object"}
        elif cls.structured in ("schema", "strict") and req.schema:
            p["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "response", "schema": req.schema, "strict": cls.structured == "strict"},
            }
        if req.tools:
            p["tools"] = req.tools
            if req.parallel_tools and spec.parallel_tools:
                p["parallel_tool_calls"] = True
        return p

    def _backoff(self, attempt: int) -> float:
        return min(8.0, self.settings.llm_router_backoff_s * (2**attempt))

    async def _run(
        self,
        req: LLMRequest,
        call: Callable[[ModelSpec, Classification], Awaitable[ChatResult | Any]],
        *,
        keep_partial: bool = False,
    ) -> tuple[Any, RoutingDecision, ModelSpec]:
        cls = classify_request(req)
        d = self._new_decision(req, cls)
        self.decisions.append(d)
        if self.configured:
            await self.discover_models()
        started = self.clock()
        exclude: set[str] = set()
        min_context: int | None = None
        retry_hint: float | None = None
        quota_only = True
        max_retries = self.settings.llm_router_max_retries if req.max_retries is None else req.max_retries
        budget = self.settings.llm_router_max_attempts
        timeout = req.timeout_s or self.settings.llm_timeout_s
        last_rejected: dict[str, str] = {}

        while budget > 0:
            cands, rejected = self.rank(req, cls, exclude, min_context)
            last_rejected = rejected
            if d.selected is None:
                self._describe(d, cands, rejected)
            if not cands:
                break
            spec = cands[0].spec
            if d.attempts:
                d.fallback = True
            for retry in range(max_retries + 1):
                if budget <= 0:
                    break
                budget -= 1
                t0 = self.clock()
                try:
                    result = await asyncio.wait_for(call(spec, cls), timeout)
                except TimeoutError:
                    err: ProviderError = ProviderError("timeout", "model call timed out")
                except ProviderError as exc:
                    err = exc
                else:
                    headers = getattr(result, "headers", None) or (result[1] if isinstance(result, tuple) else None)
                    self.quota.update(spec.id, headers)
                    self.catalog.mark_ok(spec.id)
                    d.attempts.append({"model": spec.id, "ok": True, "ms": round((self.clock() - t0) * 1000)})
                    d.final_model, d.outcome = spec.id, "ok"
                    d.latency_ms = round((self.clock() - started) * 1000)
                    d.rate_limit = self.quota.snapshot().get(spec.id)
                    return result, d, spec
                d.attempts.append({"model": spec.id, "ok": False, "error": err.kind, "status": err.status})
                logger.info("LLM router: %s failed on %s (%s)", req.task, spec.id, err.kind)
                if keep_partial and err.kind == "malformed" and err.partial and cls.structured == "json":
                    # JSON mode rejected the reply (usually cut off by the output budget). Hand the text back: the
                    # structured-output layer keeps its complete part or asks again, which beats a weaker fallback.
                    d.final_model, d.outcome = spec.id, "ok"
                    d.latency_ms = round((self.clock() - started) * 1000)
                    return ChatResult(text=err.partial, finish_reason="malformed", headers=err.headers), d, spec
                if err.kind == "rate_limit":
                    wait = self.quota.rate_limited(spec.id, err.retry_after, err.headers)
                    retry_hint = wait if retry_hint is None else min(retry_hint, wait)
                    if wait <= self.settings.llm_router_max_wait_s and retry < max_retries and budget > 0:
                        await self.sleep(wait)
                        self.quota.models[spec.id].cooldown_until = None
                        continue
                    exclude.add(spec.id)
                    break
                quota_only = False
                if err.kind in ("auth", "bad_request"):
                    d.outcome, d.error = "error", err.kind
                    raise RouterError(
                        "Groq rejected the API key. Check GROQ_API_KEY on the server."
                        if err.kind == "auth"
                        else "The model provider rejected this request. Try shortening or rephrasing it."
                    )
                if err.kind == "model_unavailable":
                    self.catalog.mark_unavailable(spec.id, "model not found or decommissioned (provider error)")
                    exclude.add(spec.id)
                    break
                if err.kind == "context_exceeded":
                    min_context = (spec.context_window or 0) + 1
                    exclude.add(spec.id)
                    break
                if err.kind in ("server", "connection", "timeout") and retry < max_retries and budget > 0:
                    await self.sleep(self._backoff(retry))
                    continue
                exclude.add(spec.id)  # malformed, or retries exhausted: try another eligible model
                break

        d.latency_ms = round((self.clock() - started) * 1000)
        d.outcome = "no_compatible_model"
        d.rejected = last_rejected or d.rejected
        for m, why in (last_rejected or {}).items():
            if "rate-limited" in why or "quota" in why or "reserved" in why or "tokens-per-minute" in why:
                _, _, left = self.quota.can_serve(m, 0, cls.priority)
                if left is not None:
                    retry_hint = left if retry_hint is None else min(retry_hint, left)
        only_quota = (
            quota_only
            and any(a.get("error") == "rate_limit" for a in d.attempts)
            or (
                not d.attempts
                and any(("quota" in w or "rate-limited" in w or "reserved" in w) for w in d.rejected.values())
            )
        )
        d.error = "quota" if only_quota else "no_model"
        wait = f" in about {int(retry_hint) + 1} s" if retry_hint else " later"
        if only_quota:
            msg = (
                "Groq's free-tier limit for the models that can handle this request has been reached. Nothing was "
                f"charged and no paid provider was used. Please try again{wait}."
            )
        elif d.attempts:
            msg = (
                "The free-tier Groq models that can handle this request are unavailable right now. Nothing was "
                f"charged and no paid provider was used. Please try again{wait}, or reduce the request size."
            )
        else:
            msg = (
                f"No free-tier Groq model can handle this {cls.modality} request "
                f"({cls.complexity.name.lower()}, ~{cls.est_input_tokens} input tokens). Reduce the request size or "
                "try again later. No paid provider is used as a fallback."
            )
        raise NoCompatibleModelError(msg, retry_after=retry_hint, quota=only_quota)

    def record_usage(
        self, d: RoutingDecision, input_tokens: int | None, output_tokens: int | None, est_in: int, text_len: int
    ) -> None:
        d.usage_estimated = input_tokens is None or output_tokens is None
        d.input_tokens = input_tokens if input_tokens is not None else est_in
        d.output_tokens = output_tokens if output_tokens is not None else text_len // 4
        key = f"{d.product}|{d.final_model}"
        self.usage[f"{key}|requests"] += 1
        self.usage[f"{key}|input_tokens"] += d.input_tokens
        self.usage[f"{key}|output_tokens"] += d.output_tokens
        if d.fallback:
            self.usage[f"{key}|fallbacks"] += 1

    async def execute_request(self, req: LLMRequest) -> RouterResult:
        async def call(spec: ModelSpec, cls: Classification) -> ChatResult:
            msgs = build_messages(req.system, req.messages, req.images)
            return await self.transport.chat(spec.id, msgs, self._params(spec, cls, req))

        try:
            res, d, spec = await self._run(req, call, keep_partial=True)
        except NoCompatibleModelError as exc:
            self.usage[f"{req.product}|-|failed"] += 1
            logger.info("LLM router: %s → no model (%s)", req.task, exc)
            raise
        if not res.text.strip() and not res.tool_calls:
            d.outcome = "empty"
        self.record_usage(d, res.input_tokens, res.output_tokens, d.classification["est_input_tokens"], len(res.text))
        logger.info("LLM router: %s → %s (%s ms, fallback=%s)", req.task, spec.id, d.latency_ms, d.fallback)
        return RouterResult(res.text, spec.id, d.input_tokens, d.output_tokens, d, res.tool_calls, res.finish_reason)

    route_request = execute_request

    async def stream_request(self, req: LLMRequest) -> AsyncIterator[str]:
        """Stream text. Fallback is possible only until the first chunk has been sent."""
        state: dict[str, Any] = {}

        async def call(spec: ModelSpec, cls: Classification) -> Any:
            msgs = build_messages(req.system, req.messages, req.images)
            handle = await self.transport.chat_stream(spec.id, msgs, self._params(spec, cls, req))
            it = handle.chunks.__aiter__()
            try:
                first = await it.__anext__()
            except StopAsyncIteration:
                first = ""
            state.update(handle=handle, it=it, first=first)
            return handle

        handle, d, spec = await self._run(req, call)
        text_len = len(state["first"])
        if state["first"]:
            yield state["first"]
        try:
            async for chunk in state["it"]:
                text_len += len(chunk)
                yield chunk
        except ProviderError as exc:
            d.outcome, d.error = "stream_interrupted", exc.kind
            raise RouterError("The model's answer was interrupted. Please try again.") from None
        self.record_usage(
            d, handle.usage.get("input_tokens"), handle.usage.get("output_tokens"),
            d.classification["est_input_tokens"], text_len,
        )  # fmt: skip

    async def transcribe(self, req: LLMRequest) -> RouterResult:
        if req.audio is None:
            raise ValueError("transcription needs audio")

        async def call(spec: ModelSpec, cls: Classification) -> Any:
            return await self.transport.transcribe(spec.id, req.audio, dict(req.response_params))  # type: ignore[arg-type]

        (raw, _headers), d, spec = await self._run(req, call)
        self.record_usage(d, None, None, 0, 0)
        return RouterResult(str(getattr(raw, "text", "") or ""), spec.id, None, None, d, raw=raw)

    # ── transparency ─────────────────────────────────────────────────────────
    def get_routing_decision(self, decision_id: str) -> dict[str, Any] | None:
        return next((d.as_dict() for d in self.decisions if d.id == decision_id), None)

    def diagnostics(self, limit: int = 50) -> dict[str, Any]:
        usage: dict[str, dict[str, Any]] = {}
        for k, v in self.usage.items():
            product, model, metric = k.split("|")
            usage.setdefault(f"{product} · {model}", {})[metric] = v
        return {
            "provider": "groq",
            "safe_default": self.settings.groq_model,
            "configured": self.configured,
            "discovery": {
                "at": self.catalog.discovered_iso,
                "error": self.catalog.discovery_error,
                "ttl_s": self.settings.llm_router_discovery_ttl_s,
            },
            "models": self.catalog.snapshot(),
            "quota": self.quota.snapshot(),
            "usage_since_start": usage,
            "recent_decisions": [d.as_dict() for d in list(self.decisions)[-limit:][::-1]],
            "notes": [
                "Quota numbers are shown only when Groq reported them in rate-limit headers.",
                "Usage counters are per server instance and reset on restart (serverless instances are separate).",
                "Prompts and outputs are never logged; decisions hold metadata only.",
            ],
        }
