"""LLM providers behind one small interface.

* **anthropic** (default) – Claude via the official `anthropic` SDK.
* **groq**   – hosted open-weight models, free tier (via LangChain).
* **ollama** – fully local/offline models (via LangChain).

The graph only depends on the `ChatLLM` protocol below (`complete` + `stream`),
so swapping providers is a config change (Strategy / Dependency-Inversion).
"""

from __future__ import annotations

import logging
import os
import ssl
from collections.abc import AsyncIterator, Sequence
from typing import Literal, Protocol, TypedDict

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage

from appcore.settings import CoreSettings as Settings

logger = logging.getLogger(__name__)


class ChatTurn(TypedDict):
    role: Literal["user", "assistant"]
    content: str


class LLMNotConfiguredError(RuntimeError):
    """The selected provider is missing required configuration (e.g. an API key)."""


class LLMRefusalError(RuntimeError):
    """The model declined the request (Claude `stop_reason == "refusal"`)."""


class ChatLLM(Protocol):
    async def complete(self, system: str | None, messages: Sequence[ChatTurn], *, short: bool = False) -> str:
        """Return the full reply. `short=True` marks small utility calls (e.g. query rewrite)."""
        ...

    def stream(self, system: str | None, messages: Sequence[ChatTurn]) -> AsyncIterator[str]:
        """Yield the reply as text deltas."""
        ...


# ── Claude (official Anthropic SDK) ─────────────────────────────────────────
# Server-side refusal fallback: if Claude's safety classifiers decline, the API
# re-runs the request on Anthropic's recommended fallback model in the same call.
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class ClaudeLLM:
    def __init__(self, settings: Settings) -> None:
        import anthropic

        key = settings.anthropic_api_key.get_secret_value() if settings.anthropic_api_key else None
        if not key and not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
            raise LLMNotConfiguredError(
                "ANTHROPIC_API_KEY is not set. Create a key at https://platform.claude.com/settings/keys "
                "or set LLM_PROVIDER=groq / ollama."
            )
        # api_key=None lets the SDK resolve credentials from the environment itself.
        self._client = anthropic.AsyncAnthropic(api_key=key, timeout=settings.llm_timeout_s, max_retries=2)
        self._s = settings

    def _params(self, system: str | None, messages: Sequence[ChatTurn], *, short: bool) -> dict:
        params: dict = {
            "model": self._s.claude_model,
            # Thinking is always on for Claude Opus 5.5 and its tokens count toward
            # max_tokens, so leave generous headroom. Depth is controlled by effort.
            "max_tokens": 4096 if short else self._s.claude_max_tokens,
            "output_config": {"effort": "low" if short else self._s.claude_effort},
            "messages": [{"role": m["role"], "content": m["content"]} for m in messages],
        }
        if "haiku" not in self._s.claude_model:  # Haiku has no server-side fallback model
            params["betas"], params["fallbacks"] = [FALLBACK_BETA], "default"
        if system:
            params["system"] = system
        return params

    @staticmethod
    def _check(message) -> None:
        if message.stop_reason == "refusal":
            category = getattr(message.stop_details, "category", None) if message.stop_details else None
            logger.warning("Claude refused the request (category=%s)", category)
            raise LLMRefusalError("The model declined to answer this request.")
        if message.stop_reason == "max_tokens":
            logger.warning("Claude reply hit max_tokens=%s and was truncated", message.usage.output_tokens)

    async def complete(self, system: str | None, messages: Sequence[ChatTurn], *, short: bool = False) -> str:
        msg = await self._client.beta.messages.create(**self._params(system, messages, short=short))
        self.last_usage = msg.usage  # input/output tokens, read by the spend meter
        self._check(msg)
        return "".join(b.text for b in msg.content if b.type == "text")

    async def stream(self, system: str | None, messages: Sequence[ChatTurn]) -> AsyncIterator[str]:
        async with self._client.beta.messages.stream(**self._params(system, messages, short=False)) as stream:
            async for text in stream.text_stream:
                yield text
            final = await stream.get_final_message()
            self.last_usage = final.usage
            self._check(final)


# ── LangChain-backed providers (Groq / Ollama) ─────────────────────────────
class LangChainLLM:
    def __init__(self, model: BaseChatModel) -> None:
        self._model = model

    @staticmethod
    def _to_messages(system: str | None, messages: Sequence[ChatTurn]) -> list[BaseMessage]:
        out: list[BaseMessage] = [SystemMessage(content=system)] if system else []
        out += [HumanMessage(m["content"]) if m["role"] == "user" else AIMessage(m["content"]) for m in messages]
        return out

    async def complete(self, system: str | None, messages: Sequence[ChatTurn], *, short: bool = False) -> str:
        msg = await self._model.ainvoke(self._to_messages(system, messages))
        return str(msg.content)

    async def stream(self, system: str | None, messages: Sequence[ChatTurn]) -> AsyncIterator[str]:
        async for chunk in self._model.astream(self._to_messages(system, messages)):
            if isinstance(chunk.content, str) and chunk.content:
                yield chunk.content


def build_llm(settings: Settings) -> ChatLLM:
    if settings.llm_provider == "anthropic":
        return ClaudeLLM(settings)

    if settings.llm_provider == "groq":
        if settings.groq_api_key is None or not settings.groq_api_key.get_secret_value():
            raise LLMNotConfiguredError(
                "GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys "
                "or set LLM_PROVIDER=anthropic / ollama."
            )
        # Every Groq call goes through the central router (app/llm). Call sites re-bind this to their declared
        # task with `appcore.llm.for_task`; anything undeclared keeps the safe default model (settings.groq_model).
        from appcore.llm import routed_llm

        return routed_llm(settings, "app.unspecified")

    if settings.llm_provider == "ollama":
        from langchain_ollama import ChatOllama

        return LangChainLLM(
            ChatOllama(
                model=settings.ollama_model,
                base_url=settings.ollama_base_url,
                temperature=settings.llm_temperature,
                num_predict=settings.llm_max_tokens,
            )
        )

    raise LLMNotConfiguredError(f"Unknown LLM provider: {settings.llm_provider}")


def _provider_sdks() -> list:
    """Anthropic and Groq SDKs share exception class names (both generated by Stainless)."""
    mods = []
    for name in ("anthropic", "groq"):
        try:
            mods.append(__import__(name))
        except ImportError:  # pragma: no cover
            pass
    return mods


def _is_certificate_error(exc: BaseException) -> bool:
    seen: BaseException | None = exc
    for _ in range(8):  # walk the __cause__ / __context__ chain
        if seen is None:
            return False
        if isinstance(seen, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(seen):
            return True
        seen = seen.__cause__ or seen.__context__
    return False


def user_facing_error(exc: Exception) -> str | None:
    """Map provider errors to safe, actionable messages (never leak internals)."""
    if isinstance(exc, LLMNotConfiguredError | LLMRefusalError):
        return str(exc)
    from appcore.llm.router import RouterError

    if isinstance(exc, RouterError):  # already safe, user-facing text (quota, no compatible model, …)
        return str(exc)
    if _is_certificate_error(exc):
        return (
            "Secure connection to the LLM provider failed (certificate verification). If this machine uses "
            "antivirus or a proxy that inspects HTTPS, make sure its certificate is trusted by the OS."
        )
    for sdk in _provider_sdks():
        if isinstance(exc, sdk.AuthenticationError):
            return "The LLM provider rejected the API key. Check the key in your .env file."
        if isinstance(exc, sdk.PermissionDeniedError):
            return "The API key doesn't have access to the configured model."
        if isinstance(exc, sdk.NotFoundError):
            return "The configured model was not found. Check the model name in your .env file."
        if isinstance(exc, sdk.RateLimitError):
            return "The LLM provider is rate-limiting requests (free-tier limits). Please try again shortly."
        if isinstance(exc, sdk.APIStatusError) and exc.status_code >= 500:
            return "The LLM provider is temporarily unavailable. Please try again."
        if isinstance(exc, sdk.APIConnectionError):
            return "Couldn't reach the LLM provider. Check the server's network connection."
    return None
