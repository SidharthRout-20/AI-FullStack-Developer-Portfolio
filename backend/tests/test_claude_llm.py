"""ClaudeLLM tests with a fake SDK client: no network, no API key, no cost."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from pydantic import SecretStr

from app.config import Settings
from app.rag.llm import FALLBACK_BETA, ClaudeLLM, LLMNotConfiguredError, LLMRefusalError, user_facing_error


def _message(text: str, stop_reason: str = "end_turn"):
    return SimpleNamespace(
        content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=text)],
        stop_reason=stop_reason,
        stop_details=SimpleNamespace(category="cyber") if stop_reason == "refusal" else None,
        usage=SimpleNamespace(output_tokens=10),
    )


class _FakeStream:
    def __init__(self, chunks, final):
        self._chunks, self._final = chunks, final

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    @property
    def text_stream(self):
        async def gen():
            for c in self._chunks:
                yield c

        return gen()

    async def get_final_message(self):
        return self._final


class _FakeMessages:
    def __init__(self, stop_reason="end_turn"):
        self.calls: list[dict] = []
        self.stop_reason = stop_reason

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return _message("rewritten query", self.stop_reason)

    def stream(self, **kwargs):
        self.calls.append(kwargs)
        return _FakeStream(["Hello ", "world [1]"], _message("Hello world [1]", self.stop_reason))


def _llm(stop_reason="end_turn") -> tuple[ClaudeLLM, _FakeMessages]:
    llm = ClaudeLLM(Settings(_env_file=None, anthropic_api_key=SecretStr("sk-test"), claude_effort="medium"))
    fake = _FakeMessages(stop_reason)
    llm._client = SimpleNamespace(beta=SimpleNamespace(messages=fake))  # type: ignore[assignment]
    return llm, fake


async def _collect(agen):
    return [x async for x in agen]


def test_stream_request_shape_and_text():
    llm, fake = _llm()
    out = asyncio.run(_collect(llm.stream("SYS", [{"role": "user", "content": "hi"}])))
    assert "".join(out) == "Hello world [1]"

    call = fake.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["system"] == "SYS"
    assert call["output_config"] == {"effort": "medium"}
    assert call["fallbacks"] == "default" and call["betas"] == [FALLBACK_BETA]
    assert call["max_tokens"] >= 16000
    # Claude Opus 5.5 rejects sampling params and explicit thinking budgets.
    assert not {"temperature", "top_p", "top_k", "thinking"} & call.keys()


def test_complete_uses_low_effort_and_returns_only_text_blocks():
    llm, fake = _llm()
    assert asyncio.run(llm.complete(None, [{"role": "user", "content": "q"}], short=True)) == "rewritten query"
    assert fake.calls[0]["output_config"] == {"effort": "low"} and "system" not in fake.calls[0]


def test_refusal_raises():
    llm, _ = _llm(stop_reason="refusal")
    with pytest.raises(LLMRefusalError):
        asyncio.run(_collect(llm.stream("SYS", [{"role": "user", "content": "x"}])))
    with pytest.raises(LLMRefusalError):
        asyncio.run(llm.complete(None, [{"role": "user", "content": "x"}]))


def test_missing_key_is_reported(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    with pytest.raises(LLMNotConfiguredError, match="ANTHROPIC_API_KEY"):
        ClaudeLLM(Settings(_env_file=None, anthropic_api_key=None))


def test_user_facing_errors():
    assert user_facing_error(LLMRefusalError("declined")) == "declined"
    assert user_facing_error(ValueError("internal detail")) is None  # unknown → generic message


def test_certificate_errors_get_an_actionable_message():
    import ssl

    try:
        try:
            raise ssl.SSLCertVerificationError("CERTIFICATE_VERIFY_FAILED: self-signed certificate in chain")
        except ssl.SSLError as inner:
            raise RuntimeError("Connection error.") from inner
    except RuntimeError as exc:
        assert "certificate" in user_facing_error(exc)


def test_groq_errors_are_mapped():
    import groq
    import httpx

    req = httpx.Request("POST", "https://api.groq.com")
    exc = groq.RateLimitError("slow down", response=httpx.Response(429, request=req), body=None)
    assert "rate-limiting" in user_facing_error(exc)
