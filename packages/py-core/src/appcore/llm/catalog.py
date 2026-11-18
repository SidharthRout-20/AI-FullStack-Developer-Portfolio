"""Groq model capability & eligibility registry.

Two separate sources, deliberately kept apart:

* **Verified capabilities** (this file): written from Groq's official documentation, checked 2026-11-14:
  https://console.groq.com/docs/models, /docs/rate-limits, /docs/structured-outputs, /docs/tool-use/overview,
  /docs/model/qwen/qwen3.8-27b, /docs/model/openai/gpt-oss-safeguard-20b, /docs/speech-to-text.
  `None` means "not verified" and is treated as *unsupported* for any capability-critical request.
* **Discovery** (`GET https://api.groq.com/openai/v1/models`, done by the router): which model IDs this API key can
  see right now, whether they are active, and their current context window. A model the API lists but this registry
  doesn't know is recorded with unknown capabilities and is never selected. A registry model the API no longer lists
  is treated as unavailable (removed or deprecated).

Free-tier eligibility is a registry fact, not an assumption: only models that appear in Groq's published free-plan
rate-limit table are eligible. Models shown as "Contact sales" (enterprise) are listed but never selected.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field, replace
from typing import Any, Literal

VERIFIED_AT = "2026-11-14"
DOC_SOURCES = (
    "https://console.groq.com/docs/models",
    "https://console.groq.com/docs/rate-limits",
    "https://console.groq.com/docs/structured-outputs",
    "https://console.groq.com/docs/tool-use/overview",
    "https://console.groq.com/docs/model/qwen/qwen3.8-27b",
    "https://console.groq.com/docs/model/openai/gpt-oss-safeguard-20b",
    "https://console.groq.com/docs/speech-to-text",
)

Endpoint = Literal["chat", "transcription"]
CAPABILITIES = ("text", "vision", "audio", "json_object", "json_schema", "strict_schema", "tools", "parallel_tools",
                "reasoning")  # fmt: skip


@dataclass(frozen=True)
class Limits:
    """Documented base limits. Groq's page doesn't clearly label the plan for this table, and limits vary by
    organisation, so these are only a starting estimate; live `x-ratelimit-*` headers always win."""

    rpm: int | None = None
    rpd: int | None = None
    tpm: int | None = None
    tpd: int | None = None
    audio_seconds_hour: int | None = None
    audio_seconds_day: int | None = None


@dataclass(frozen=True)
class ModelSpec:
    id: str
    owner: str
    stage: Literal["production", "preview", "unknown"]
    endpoint: Endpoint | None
    # modalities & output modes (None = not verified → never relied on)
    text: bool | None = True
    vision: bool | None = False
    audio: bool | None = False
    json_object: bool | None = None
    json_schema: bool | None = None  # best-effort json_schema (strict: false)
    strict_schema: bool | None = None  # constrained decoding (strict: true)
    tools: bool | None = None
    parallel_tools: bool | None = None
    reasoning: bool | None = None
    context_window: int | None = None
    max_output_tokens: int | None = None
    max_images: int | None = None
    image_tokens: int | None = None  # input tokens each image counts as
    max_file_mb: int | None = None  # transcription upload limit on the free tier
    free_tier: bool | None = None
    limits: Limits = field(default_factory=Limits)
    # routing hints (ours, not Groq's): relative reasoning strength 1-4 and documented speed
    tier: int = 0
    speed_tps: int | None = None
    general_purpose: bool = True  # False: only for its specialised role (e.g. safety classification)
    roles: tuple[str, ...] = ()
    effort_values: tuple[str, ...] = ()  # accepted `reasoning_effort` values; () = don't send it
    hides_reasoning_param: bool = False  # supports reasoning_format="hidden"
    known: bool = True  # False for IDs discovered from the API that this registry doesn't describe
    notes: str = ""


_GPT_OSS = dict(
    owner="OpenAI", endpoint="chat", text=True, vision=False, audio=False, json_object=True, json_schema=True,
    strict_schema=True, tools=True, parallel_tools=False, reasoning=True, context_window=131_072,
    max_output_tokens=65_536, free_tier=True, limits=Limits(rpm=30, rpd=1_000, tpm=8_000, tpd=200_000),
    effort_values=("low", "medium", "high"),
)  # fmt: skip

REGISTRY: dict[str, ModelSpec] = {
    s.id: s
    for s in (
        ModelSpec(id="openai/gpt-oss-120b", stage="production", tier=4, speed_tps=500,
                  roles=("reasoning", "analysis", "planning"), **_GPT_OSS),  # type: ignore[arg-type]
        ModelSpec(id="openai/gpt-oss-20b", stage="production", tier=2, speed_tps=1000,
                  roles=("routine", "extraction", "classification"), **_GPT_OSS),  # type: ignore[arg-type]
        ModelSpec(
            id="qwen/qwen3.8-27b", owner="Alibaba Cloud", stage="preview", endpoint="chat", text=True, vision=True,
            audio=False, json_object=True, json_schema=True, strict_schema=True, tools=True, parallel_tools=True,
            reasoning=True, context_window=131_072, max_output_tokens=16_384, max_images=3, image_tokens=2048,
            free_tier=True, limits=Limits(rpm=30, rpd=1_000, tpm=8_000, tpd=200_000), tier=3, speed_tps=450,
            roles=("vision", "multimodal"), effort_values=("none", "default", "low", "medium", "high"),
            hides_reasoning_param=True,
            notes="Preview: may be discontinued at short notice. Images need at least 32 px per side (live-checked).",
        ),
        ModelSpec(
            id="openai/gpt-oss-safeguard-20b", owner="OpenAI", stage="preview", endpoint="chat", text=True,
            vision=False, audio=False, json_object=True, json_schema=True, strict_schema=False, tools=True,
            parallel_tools=False, reasoning=True, context_window=131_072, max_output_tokens=65_536, free_tier=True,
            limits=Limits(rpm=3, rpd=1_000, tpm=2_000, tpd=200_000), tier=2, speed_tps=1000, general_purpose=False,
            roles=("safety",), effort_values=("low", "medium", "high"),
            notes="Trained for policy-based safety classification; never used as a general model.",
        ),
        ModelSpec(
            id="whisper-large-v3", owner="OpenAI", stage="production", endpoint="transcription", text=False,
            audio=True, free_tier=True, max_file_mb=25,
            limits=Limits(rpm=20, rpd=2_000, audio_seconds_hour=7_200, audio_seconds_day=28_800), tier=2,
            general_purpose=False, roles=("transcription", "translation"), notes="Lower WER (10.3%); translation.",
        ),
        ModelSpec(
            id="whisper-large-v3-turbo", owner="OpenAI", stage="production", endpoint="transcription", text=False,
            audio=True, free_tier=True, max_file_mb=25,
            limits=Limits(rpm=20, rpd=2_000, audio_seconds_hour=7_200, audio_seconds_day=28_800), tier=1,
            general_purpose=False, roles=("transcription",),
            notes="Faster (speed factor 216), WER 12%; no translation.",
        ),
        # Listed by Groq but enterprise-only ("Contact sales", absent from the free rate-limit table): never selected.
        *(
            ModelSpec(id=mid, owner=owner, stage=stage, endpoint="chat", free_tier=None, context_window=ctx,
                      notes="Enterprise / contact-sales pricing; not free-tier eligible.")  # type: ignore[arg-type]
            for mid, owner, stage, ctx in (
                ("llama-3.1-8b-instant", "Meta", "production", 131_072),
                ("llama-3.3-70b-versatile", "Meta", "production", 131_072),
                ("meta-models/muse-spark-open", "Meta", "preview", 131_072),
                ("minimaxai/minimax-m2.7", "MiniMaxAI", "preview", 196_608),
            )
        ),
    )
}  # fmt: skip


def unknown_spec(model_id: str, owner: str | None) -> ModelSpec:
    """A model the API lists but this registry doesn't describe: capabilities unknown, never selected."""
    return ModelSpec(id=model_id, owner=owner or "unknown", stage="unknown", endpoint=None, text=None,
                     vision=None, audio=None, free_tier=None, known=False,
                     notes="Listed by the Groq API but not in the verified registry.")  # fmt: skip


@dataclass
class Availability:
    listed: bool | None = None  # None: discovery hasn't succeeded yet
    active: bool | None = None
    unavailable_reason: str | None = None  # set after a model-not-found / decommissioned error
    last_ok_at: str | None = None  # last successful call or discovery sighting


class ModelCatalog:
    """Registry + live discovery state."""

    def __init__(self, registry: dict[str, ModelSpec] | None = None) -> None:
        self.specs: dict[str, ModelSpec] = dict(registry or REGISTRY)
        self.state: dict[str, Availability] = {m: Availability() for m in self.specs}
        self.discovered_at: float | None = None  # monotonic time of the last successful discovery
        self.discovered_iso: str | None = None
        self.discovery_error: str | None = None

    def apply_discovery(self, models: list[dict[str, Any]], at_monotonic: float) -> None:
        listed = {str(m.get("id")): m for m in models if m.get("id")}
        now = _iso()
        for mid, raw in listed.items():
            if mid not in self.specs:
                self.specs[mid] = unknown_spec(mid, raw.get("owned_by"))
            spec = self.specs[mid]
            # The API is authoritative for current limits when it reports them.
            ctx, out = raw.get("context_window"), raw.get("max_completion_tokens")
            if spec.known and (isinstance(ctx, int) or isinstance(out, int)):
                self.specs[mid] = replace(
                    spec,
                    context_window=ctx if isinstance(ctx, int) and ctx > 0 else spec.context_window,
                    max_output_tokens=out if isinstance(out, int) and out > 0 else spec.max_output_tokens,
                )
            st = self.state.setdefault(mid, Availability())
            st.listed, st.active = True, raw.get("active", True) is not False
            st.last_ok_at = now
            if st.unavailable_reason == "not listed by the Groq models API":
                st.unavailable_reason = None
        for mid, st in self.state.items():
            if mid not in listed:
                st.listed, st.active = False, False
                st.unavailable_reason = "not listed by the Groq models API"
        self.discovered_at, self.discovered_iso, self.discovery_error = at_monotonic, now, None

    def available(self, model_id: str) -> tuple[bool, str]:
        st = self.state.get(model_id) or Availability()
        if st.unavailable_reason:
            return False, st.unavailable_reason
        if st.listed is False or st.active is False:
            return False, "inactive in the Groq models API"
        return True, "listed and active" if st.listed else "availability not yet verified (discovery pending)"

    def mark_unavailable(self, model_id: str, reason: str) -> None:
        self.state.setdefault(model_id, Availability()).unavailable_reason = reason

    def mark_ok(self, model_id: str) -> None:
        self.state.setdefault(model_id, Availability()).last_ok_at = _iso()

    def snapshot(self) -> list[dict[str, Any]]:
        out = []
        for mid, spec in sorted(self.specs.items()):
            ok, why = self.available(mid)
            st = self.state.get(mid) or Availability()
            out.append({
                "id": mid, "owner": spec.owner, "stage": spec.stage, "endpoint": spec.endpoint, "known": spec.known,
                "free_tier": spec.free_tier, "available": ok, "availability": why, "listed": st.listed,
                "last_ok_at": st.last_ok_at, "deprecated": st.listed is False,
                "capabilities": {k: getattr(spec, k) for k in CAPABILITIES},
                "context_window": spec.context_window, "max_output_tokens": spec.max_output_tokens,
                "max_images": spec.max_images, "documented_limits": spec.limits.__dict__, "tier": spec.tier,
                "general_purpose": spec.general_purpose, "roles": list(spec.roles), "notes": spec.notes,
            })  # fmt: skip
        return out


def _iso() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds")
