"""Central Groq LLM router: classification, eligibility, scoring, fallback, quota, transparency. Fully mocked."""

from __future__ import annotations

import asyncio

import pytest

from app.efi import reasoning
from app.llm import Complexity, LLMRequest, LLMRouter, NoCompatibleModelError, RoutedLLM, classify_request
from app.llm.catalog import REGISTRY
from app.llm.quota import parse_duration
from app.llm.transport import ChatResult, ProviderError, StreamHandle

LISTED = [
    {"id": m, "owned_by": "x", "active": True}
    for m in (
        "openai/gpt-oss-120b",
        "openai/gpt-oss-20b",
        "qwen/qwen3.8-27b",
        "openai/gpt-oss-safeguard-20b",
        "whisper-large-v3",
        "whisper-large-v3-turbo",
        "llama-3.1-8b-instant",
    )
]


class FakeTransport:
    """Scripted Groq: per-model queues of results/exceptions; records every call (model + params, no content)."""

    def __init__(self, models=None, script=None, headers=None):
        self.models = LISTED if models is None else models
        self.script = {k: list(v) for k, v in (script or {}).items()}
        self.headers = headers or {}
        self.calls: list[tuple[str, dict]] = []
        self.list_calls = 0

    async def list_models(self):
        self.list_calls += 1
        if isinstance(self.models, Exception):
            raise self.models
        return self.models

    def _next(self, model):
        queue = self.script.get(model)
        item = queue.pop(0) if queue else f"reply from {model}"
        if isinstance(item, Exception):
            raise item
        return item

    async def chat(self, model, messages, params):
        self.calls.append((model, params))
        text = self._next(model)
        return ChatResult(text=text, input_tokens=50, output_tokens=7, headers=self.headers.get(model, {}))

    async def chat_stream(self, model, messages, params):
        self.calls.append((model, params))
        text = self._next(model)

        async def chunks():
            for part in text.split(" "):
                yield part + " "

        return StreamHandle(headers={}, chunks=chunks())

    async def transcribe(self, model, file, params):
        self.calls.append((model, params))

        class R:
            text = "hello world"

        return R(), {}


def make(settings, **kw):
    sleeps: list[float] = []

    async def sleep(s):
        sleeps.append(s)

    t = kw.pop("transport", None) or FakeTransport(**kw)
    r = LLMRouter(settings, transport=t, sleep=sleep)
    return r, t, sleeps


def req(task, text="hello", **kw):
    return LLMRequest(task=task, messages=[{"role": "user", "content": text}], **kw)


def run(coro):
    return asyncio.run(coro)


# ── classification ──────────────────────────────────────────────────────────
def test_complexity_levels_from_task_profiles():
    assert classify_request(req("keeper.command")).complexity == Complexity.SIMPLE
    assert classify_request(req("documind.answer")).complexity == Complexity.STANDARD
    assert classify_request(req("tripweaver.plan")).complexity == Complexity.COMPLEX
    c = classify_request(req("efi.investigate", "x" * 100_000))
    assert c.complexity == Complexity.ADVANCED and c.priority == 1 and c.structured == "json"
    u = classify_request(req("app.unspecified"))
    assert not u.task_known and u.complexity == Complexity.STANDARD


def test_signals_raise_complexity_but_explicit_override_wins():
    msg = (
        "Compare the two museums and re-plan tomorrow so we avoid the rain, step by step, keeping lunch near the hotel"
    )
    assert classify_request(req("tripweaver.companion", msg)).complexity == Complexity.COMPLEX
    assert classify_request(req("documind.answer", "y" * 120_000)).complexity == Complexity.COMPLEX  # ~30k tokens
    assert classify_request(req("documind.answer", "y" * 120_000, complexity=Complexity.SIMPLE)).complexity == 1
    assert classify_request(req("keeper.command", "why " * 400)).complexity == Complexity.SIMPLE  # signals off


def test_modality_and_requirements_are_independent_of_complexity():
    img = classify_request(req("keeper.photo", images=[("image/jpeg", b"x")]))
    assert img.modality == "image" and img.complexity == Complexity.SIMPLE and img.est_input_tokens >= 2048
    audio = classify_request(LLMRequest(task="meetingmind.transcribe", audio=("a.webm", b"x")))
    assert audio.modality == "audio"
    tools = classify_request(req("documind.answer", tools=[{"type": "function"}] * 5, parallel_tools=True))
    assert tools.needs_tools and tools.needs_parallel_tools and tools.complexity == Complexity.COMPLEX
    assert (
        classify_request(req("documind.answer", schema={"type": "object"}, structured="strict")).structured == "strict"
    )


def test_product_priorities():
    assert classify_request(req("efi.investigate")).priority == 1
    assert classify_request(req("tripweaver.plan")).priority == 2
    assert classify_request(req("keeper.command")).priority == 3
    assert classify_request(req("documind.brief")).priority == 4  # background


# ── selection ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    ("task", "kw", "expected"),
    [
        ("keeper.command", {}, "openai/gpt-oss-20b"),  # simple → lightweight
        ("documind.answer", {}, "openai/gpt-oss-20b"),  # standard → smallest adequate
        ("tripweaver.plan", {}, "openai/gpt-oss-120b"),  # complex → production reasoning model over preview
        ("efi.investigate", {}, "openai/gpt-oss-120b"),  # advanced
        ("app.unspecified", {}, "openai/gpt-oss-120b"),  # undeclared → safe default
        ("keeper.photo", {"images": [("image/png", b"x")]}, "qwen/qwen3.8-27b"),  # only verified vision model
        ("documind.answer", {"tools": [{"type": "function"}], "parallel_tools": True}, "qwen/qwen3.8-27b"),
        ("safety.classify", {}, "openai/gpt-oss-safeguard-20b"),
    ],
)
def test_selects_compatible_model(settings, task, kw, expected):
    r, _, _ = make(settings)
    d = r.select_model(req(task, **kw))
    assert d.selected == expected and d.reason


def test_hard_filters_beat_scores(settings):
    r, _, _ = make(settings)
    d = r.select_model(req("keeper.photo", images=[("image/png", b"x")]))
    assert "vision" in d.rejected["openai/gpt-oss-120b"]  # never wins an image request on general score
    d = r.select_model(req("documind.answer"))
    assert "specialised" in d.rejected["openai/gpt-oss-safeguard-20b"]  # safety model isn't a general model
    assert "endpoint" in d.rejected["whisper-large-v3"]  # transcription model never used for chat
    assert d.rejected["llama-3.1-8b-instant"] == "not free-tier eligible"
    strict = r.select_model(req("safety.classify", structured="strict", schema={"type": "object"}))
    assert strict.selected is None and "strict" in strict.rejected["openai/gpt-oss-safeguard-20b"]
    assert r.select_model(req("keeper.photo", images=[("image/png", b"x")] * 4)).selected is None  # max 3 images


def test_context_size_filter(settings):
    r, _, _ = make(settings)
    d = r.select_model(req("documind.answer", "z" * 600_000))  # ~150k tokens > 131k context
    assert d.selected is None and d.rejected["openai/gpt-oss-120b"].startswith("context too small")
    with pytest.raises(NoCompatibleModelError, match="Reduce the request size"):
        run(r.execute_request(req("documind.answer", "z" * 600_000)))


def test_discovery_unknown_and_deprecated_models(settings):
    models = [m for m in LISTED if m["id"] != "openai/gpt-oss-20b"] + [{"id": "newco/shiny-1", "owned_by": "newco"}]
    r, t, _ = make(settings, models=models)
    out = run(r.execute_request(req("keeper.command")))
    assert t.list_calls == 1
    snap = {m["id"]: m for m in r.catalog.snapshot()}
    assert snap["newco/shiny-1"]["known"] is False and snap["newco/shiny-1"]["available"] is True
    assert snap["openai/gpt-oss-20b"]["deprecated"] is True  # no longer listed → never selected
    assert out.model == "openai/gpt-oss-120b"  # 20b gone: next eligible; unknown model never chosen
    assert out.decision.rejected["newco/shiny-1"] == "capabilities not verified"
    run(r.execute_request(req("keeper.command")))
    assert t.list_calls == 1  # cached


def test_discovery_failure_falls_back_to_verified_registry(settings):
    r, _, _ = make(settings, models=ProviderError("connection"))
    out = run(r.execute_request(req("tripweaver.plan")))
    assert out.model == "openai/gpt-oss-120b" and "discovery failed" in r.catalog.discovery_error


# ── execution, params, fallback, quota ──────────────────────────────────────
def test_model_specific_params(settings):
    r, t, _ = make(settings)
    run(r.execute_request(req("keeper.command")))
    model, p = t.calls[-1]
    assert model == "openai/gpt-oss-20b" and p["reasoning_effort"] == "low" and "reasoning_format" not in p
    run(r.execute_request(req("keeper.photo", images=[("image/png", b"x")])))
    model, p = t.calls[-1]
    assert model == "qwen/qwen3.8-27b" and p["reasoning_effort"] == "none" and p["reasoning_format"] == "hidden"
    run(r.execute_request(req("evolve.reflect", structured="strict", schema={"type": "object"})))
    assert t.calls[-1][1]["response_format"]["json_schema"]["strict"] is True


def test_server_errors_retry_then_fall_back_without_downgrading(settings):
    err = ProviderError("server", status=503)
    r, t, sleeps = make(settings, script={"openai/gpt-oss-120b": [err, err]})
    out = run(r.execute_request(req("tripweaver.plan")))
    assert out.model == "qwen/qwen3.8-27b" and out.decision.fallback  # tier 3 still meets the complex floor
    assert sleeps == [0.5]  # one bounded backoff on the same model, then fallback
    assert [a["model"] for a in out.decision.attempts] == ["openai/gpt-oss-120b"] * 2 + ["qwen/qwen3.8-27b"]
    # Advanced work has no lower-tier fallback: controlled error instead of a silent downgrade.
    r2, t2, _ = make(settings, script={"openai/gpt-oss-120b": [err, err]})
    with pytest.raises(NoCompatibleModelError):
        run(r2.execute_request(req("efi.investigate")))
    assert {m for m, _ in t2.calls} == {"openai/gpt-oss-120b"}


def test_429_short_retry_after_waits_once(settings):
    r, t, sleeps = make(settings, script={"openai/gpt-oss-20b": [ProviderError("rate_limit", retry_after=1.0)]})
    out = run(r.execute_request(req("keeper.command")))
    assert sleeps == [1.0] and out.model == "openai/gpt-oss-20b" and len(t.calls) == 2


def test_429_long_retry_after_falls_back_and_quota_error_when_none_left(settings):
    rl = ProviderError("rate_limit", retry_after=40.0, headers={"x-ratelimit-remaining-requests": "0"})
    r, t, sleeps = make(settings, script={"openai/gpt-oss-20b": [rl]})
    out = run(r.execute_request(req("keeper.command")))
    assert out.model == "openai/gpt-oss-120b" and sleeps == []  # no in-request waiting for 40 s
    assert r.select_model(req("keeper.command")).rejected["openai/gpt-oss-20b"].startswith("rate-limited")
    r2, _, _ = make(settings, script={"openai/gpt-oss-120b": [ProviderError("rate_limit", retry_after=60.0)]})
    with pytest.raises(NoCompatibleModelError) as exc:
        run(r2.execute_request(req("efi.investigate")))
    assert exc.value.quota and exc.value.retry_after == 60.0 and "no paid provider" in str(exc.value)


def test_quota_headers_and_priority_reservation(settings):
    low = {"x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "100",
           "x-ratelimit-reset-requests": "2h0m0s", "x-ratelimit-limit-tokens": "8000",
           "x-ratelimit-remaining-tokens": "7000", "x-ratelimit-reset-tokens": "7.5s"}  # fmt: skip
    r, _, _ = make(settings, headers={"openai/gpt-oss-120b": low})
    run(r.execute_request(req("efi.investigate")))
    q = r.quota.snapshot()["openai/gpt-oss-120b"]
    assert q["source"] == "headers" and q["requests_per_day"]["remaining"] == 100
    assert q["tokens_per_minute"]["resets_in_s"] == pytest.approx(7.5, abs=0.5)
    # 10% left: background work (needs 15% kept free) may not use it; EFI (priority 1) may.
    bg = r.select_model(req("app.unspecified", priority=4))
    assert "reserved" in bg.rejected["openai/gpt-oss-120b"]
    assert r.select_model(req("efi.investigate")).selected == "openai/gpt-oss-120b"
    # Requests bigger than the remaining tokens-per-minute budget are not sent to that model.
    big = r.select_model(req("efi.investigate", "q" * 40_000))
    assert big.selected is None and "tokens-per-minute" in big.rejected["openai/gpt-oss-120b"]


def test_model_not_found_and_malformed_fall_back(settings):
    r, _, _ = make(settings, script={"openai/gpt-oss-20b": [ProviderError("model_unavailable", status=404)]})
    assert run(r.execute_request(req("keeper.command"))).model == "openai/gpt-oss-120b"
    assert r.catalog.available("openai/gpt-oss-20b")[0] is False
    r2, _, _ = make(settings, script={"openai/gpt-oss-120b": [ProviderError("malformed")]})
    assert run(r2.execute_request(req("tripweaver.plan"))).model == "qwen/qwen3.8-27b"


def test_context_overflow_falls_back_only_to_larger_context(settings):
    r, t, _ = make(settings, script={"openai/gpt-oss-20b": [ProviderError("context_exceeded", status=413)]})
    with pytest.raises(NoCompatibleModelError):
        run(r.execute_request(req("keeper.command")))  # every other text model has the same 131k context
    assert [m for m, _ in t.calls] == ["openai/gpt-oss-20b"]


def test_auth_error_is_not_retried_on_other_models(settings):
    from app.llm import RouterError

    r, t, _ = make(settings, script={"openai/gpt-oss-20b": [ProviderError("auth", status=401)]})
    with pytest.raises(RouterError, match="API key"):
        run(r.execute_request(req("keeper.command")))
    assert len(t.calls) == 1


def test_usage_recording_and_no_content_in_metadata(settings):
    r, _, _ = make(settings)
    secret = "my private itinerary text"
    out = run(r.execute_request(req("tripweaver.companion", secret)))
    d = out.decision.as_dict()
    assert d["input_tokens"] == 50 and d["output_tokens"] == 7 and d["final_model"] == out.model
    assert d["latency_ms"] is not None and d["product"] == "tripweaver" and d["feature"] == "companion"
    diag = r.diagnostics()
    assert secret not in str(diag) and diag["usage_since_start"][f"tripweaver · {out.model}"]["requests"] == 1
    assert r.get_routing_decision(out.decision.id)["selected"] == out.model


def test_no_paid_provider_path(settings):
    eligible = {m for m, s in REGISTRY.items() if s.free_tier is True}
    assert eligible == {"openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b",
                        "openai/gpt-oss-safeguard-20b", "whisper-large-v3", "whisper-large-v3-turbo"}  # fmt: skip
    every = ProviderError("server", status=500)
    script = {m: [every] * 10 for m in eligible}
    r, t, _ = make(settings, script=script)
    with pytest.raises(NoCompatibleModelError, match="no paid provider"):
        run(r.execute_request(req("documind.answer")))
    assert {m for m, _ in t.calls} <= eligible and len(t.calls) <= settings.llm_router_max_attempts


def test_streaming_falls_back_before_first_chunk(settings):
    r, _, _ = make(settings, script={"openai/gpt-oss-20b": [ProviderError("server", status=502)] * 2})

    async def collect():
        return "".join([c async for c in r.stream_request(req("documind.answer"))])

    assert run(collect()).strip() == "reply from openai/gpt-oss-120b"


def test_transcription_routes_to_whisper(settings):
    r, t, _ = make(settings)
    out = run(r.transcribe(LLMRequest(task="meetingmind.transcribe", audio=("a.webm", b"x" * 100))))
    assert out.model == "whisper-large-v3-turbo" and out.text == "hello world"
    tr = LLMRequest(task="meetingmind.transcribe", audio=("a.webm", b"x"), response_params={"task": "translate"})
    assert r.select_model(tr).selected == "whisper-large-v3"
    big = LLMRequest(task="meetingmind.transcribe", audio=("a.webm", b"x" * 26 * 1_048_576))
    assert r.select_model(big).selected is None  # over the 25 MB free-tier upload limit


def test_routed_chat_llm_adapter(settings):
    r, t, _ = make(settings)
    llm = RoutedLLM(r, "app.unspecified")
    assert run(llm.for_task("keeper.command").complete("sys", [{"role": "user", "content": "hi"}])).startswith("reply")
    assert t.calls[-1][0] == "openai/gpt-oss-20b"
    run(llm.complete(None, [{"role": "user", "content": "rewrite"}], short=True))  # short utility call → simple
    assert t.calls[-1][1]["reasoning_effort"] == "low"


def test_build_llm_uses_the_router_for_groq(settings):
    from pydantic import SecretStr

    from app.rag.llm import build_llm

    llm = build_llm(settings.model_copy(update={"groq_api_key": SecretStr("gsk_" + "x" * 30)}))
    assert isinstance(llm, RoutedLLM) and llm.task == "app.unspecified"


def test_parse_duration():
    assert parse_duration("2m59.56s") == pytest.approx(179.56)
    assert parse_duration("7.66s") == pytest.approx(7.66)
    assert parse_duration("1h0m0s") == 3600
    assert parse_duration("300ms") == pytest.approx(0.3)
    assert parse_duration("12") == 12 and parse_duration("soon") is None and parse_duration(None) is None


# ── EFI through the router ──────────────────────────────────────────────────
def test_efi_runs_through_the_router_with_its_bounds(settings):
    r, t, _ = make(settings)
    caller = reasoning.router_caller(settings, r)
    out = run(caller(reasoning.SYSTEM, "evidence"))
    model, params = t.calls[-1]
    assert model == out.model == "openai/gpt-oss-120b"  # existing default preserved for investigations
    assert params["max_completion_tokens"] == settings.efi_max_output_tokens
    assert params["reasoning_effort"] == settings.efi_reasoning_effort and params["temperature"] == 0.1
    assert r.decisions[-1].classification["complexity"] == "ADVANCED"


def test_efi_quota_maps_to_controlled_error(settings):
    r, _, _ = make(settings, script={"openai/gpt-oss-120b": [ProviderError("rate_limit", retry_after=30.0)]})
    with pytest.raises(reasoning.EFIQuotaError) as exc:
        run(reasoning.router_caller(settings, r)(reasoning.SYSTEM, "evidence"))
    assert exc.value.retry_after == 30.0


def test_router_diagnostics_require_admin(client):
    # Same convention as the other admin endpoints: hidden (404) unless ADMIN_API_KEY is configured.
    assert client.get("/api/llm/router").status_code == 404
    assert client.post("/api/llm/router/preview", json={"task": "keeper.command"}).status_code == 404
