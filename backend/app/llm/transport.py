"""The only code that talks to Groq. The SDK's own retries are disabled: the router owns retry/backoff/fallback so
retries are bounded, sequential and visible in routing metadata. Raw responses are used to read rate-limit headers.

Errors are normalised into `ProviderError` with a `kind` the router can act on. Provider messages are kept for
server-side logs only; users get safe text from the router.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

ErrorKind = Literal[
    "rate_limit", "model_unavailable", "context_exceeded", "server", "connection", "timeout", "auth",
    "bad_request", "malformed",
]  # fmt: skip


class ProviderError(Exception):
    def __init__(
        self,
        kind: ErrorKind,
        message: str = "",
        *,
        status: int | None = None,
        retry_after: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(message or kind)
        self.kind, self.status, self.retry_after = kind, status, retry_after
        self.headers = dict(headers or {})


@dataclass
class ChatResult:
    text: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    headers: dict[str, str] = field(default_factory=dict)
    finish_reason: str | None = None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class StreamHandle:
    headers: dict[str, str]
    chunks: AsyncIterator[str]
    usage: dict[str, int | None] = field(default_factory=dict)  # filled when the stream ends (if reported)


class Transport(Protocol):
    async def list_models(self) -> list[dict[str, Any]]: ...
    async def chat(self, model: str, messages: list[dict[str, Any]], params: dict[str, Any]) -> ChatResult: ...
    async def chat_stream(self, model: str, messages: list[dict[str, Any]], params: dict[str, Any]) -> StreamHandle: ...
    async def transcribe(
        self, model: str, file: tuple[str, bytes], params: dict[str, Any]
    ) -> tuple[Any, dict[str, str]]: ...


def build_messages(
    system: str | None, messages: list[dict[str, Any]], images: list[tuple[str, bytes]]
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = [{"role": "system", "content": system}] if system else []
    out += [{"role": m["role"], "content": m["content"]} for m in messages]
    if images:
        # Attach images to the last user message (OpenAI-compatible content parts, as Groq documents).
        idx = max((i for i, m in enumerate(out) if m["role"] == "user"), default=None)
        text = out[idx]["content"] if idx is not None else ""
        parts: list[dict[str, Any]] = [{"type": "text", "text": text}]
        parts += [
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}"}}
            for mime, data in images
        ]
        if idx is None:
            out.append({"role": "user", "content": parts})
        else:
            out[idx] = {"role": "user", "content": parts}
    return out


def _error_code(exc: Any) -> str:
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        err = body.get("error", body)
        if isinstance(err, dict):
            return f"{err.get('code') or ''} {err.get('type') or ''} {err.get('message') or ''}".lower()
    return str(exc).lower()


def classify_error(exc: BaseException) -> ProviderError:
    """Map Groq SDK exceptions to router error kinds."""
    if isinstance(exc, ProviderError):
        return exc
    try:
        import groq
    except ImportError:  # pragma: no cover
        return ProviderError("server", str(exc))
    resp = getattr(exc, "response", None)
    headers = dict(resp.headers) if resp is not None else {}
    status = getattr(exc, "status_code", None)
    code = _error_code(exc)
    if isinstance(exc, groq.APITimeoutError):
        return ProviderError("timeout", "Groq request timed out")
    if isinstance(exc, groq.APIConnectionError):
        return ProviderError("connection", "Couldn't reach Groq")
    if isinstance(exc, groq.RateLimitError) or status == 429:
        ra = headers.get("retry-after")
        try:
            retry = float(ra) if ra else None
        except ValueError:
            retry = None
        return ProviderError("rate_limit", "Groq rate limit", status=429, retry_after=retry, headers=headers)
    if isinstance(exc, groq.AuthenticationError | groq.PermissionDeniedError):
        if "model" in code and ("access" in code or "not have" in code):
            return ProviderError("model_unavailable", "model not accessible to this key", status=status)
        return ProviderError("auth", "Groq rejected the API key", status=status)
    if isinstance(exc, groq.NotFoundError) or "model_not_found" in code or "decommissioned" in code:
        return ProviderError("model_unavailable", "model not found or decommissioned", status=status)
    if status == 413 or "context_length" in code or "reduce the length" in code or "too large" in code:
        return ProviderError("context_exceeded", "request too large for the model", status=status, headers=headers)
    if "json_validate_failed" in code or "tool_use_failed" in code:
        return ProviderError("malformed", "model output failed provider-side validation", status=status)
    if isinstance(exc, groq.APIStatusError) and (status or 0) >= 500:
        return ProviderError("server", "Groq server error", status=status)
    if isinstance(exc, groq.APIStatusError):
        return ProviderError("bad_request", "Groq rejected the request", status=status)
    return ProviderError("server", type(exc).__name__)


class GroqTransport:
    def __init__(self, api_key: str, timeout_s: float) -> None:
        from groq import AsyncGroq

        self._client = AsyncGroq(api_key=api_key, timeout=timeout_s, max_retries=0)

    async def list_models(self) -> list[dict[str, Any]]:
        try:
            page = await self._client.models.list()
        except Exception as exc:  # noqa: BLE001
            raise classify_error(exc) from None
        return [m.model_dump() if hasattr(m, "model_dump") else dict(m) for m in page.data]

    async def chat(self, model: str, messages: list[dict[str, Any]], params: dict[str, Any]) -> ChatResult:
        try:
            raw = await self._client.chat.completions.with_raw_response.create(model=model, messages=messages, **params)
            completion = await raw.parse()
        except Exception as exc:  # noqa: BLE001
            raise classify_error(exc) from None
        headers = dict(raw.headers)
        if not completion.choices:
            raise ProviderError("malformed", "no choices in completion", headers=headers)
        choice = completion.choices[0]
        msg = choice.message
        usage = completion.usage
        calls = [
            {"id": c.id, "name": c.function.name, "arguments": _args(c.function.arguments)}
            for c in (getattr(msg, "tool_calls", None) or [])
        ]
        return ChatResult(
            text=msg.content or "",
            input_tokens=getattr(usage, "prompt_tokens", None),
            output_tokens=getattr(usage, "completion_tokens", None),
            headers=headers,
            finish_reason=choice.finish_reason,
            tool_calls=calls,
        )

    async def chat_stream(self, model: str, messages: list[dict[str, Any]], params: dict[str, Any]) -> StreamHandle:
        try:
            raw = await self._client.chat.completions.with_raw_response.create(
                model=model, messages=messages, stream=True, **params
            )
            stream = await raw.parse()
        except Exception as exc:  # noqa: BLE001
            raise classify_error(exc) from None
        usage: dict[str, int | None] = {}

        async def chunks() -> AsyncIterator[str]:
            try:
                async for chunk in stream:
                    x = getattr(chunk, "x_groq", None)
                    if x is not None and getattr(x, "usage", None) is not None:
                        usage["input_tokens"] = getattr(x.usage, "prompt_tokens", None)
                        usage["output_tokens"] = getattr(x.usage, "completion_tokens", None)
                    if chunk.choices and (delta := chunk.choices[0].delta.content):
                        yield delta
            except Exception as exc:  # noqa: BLE001
                raise classify_error(exc) from None

        return StreamHandle(headers=dict(raw.headers), chunks=chunks(), usage=usage)

    async def transcribe(
        self, model: str, file: tuple[str, bytes], params: dict[str, Any]
    ) -> tuple[Any, dict[str, str]]:
        try:
            raw = await self._client.audio.transcriptions.with_raw_response.create(model=model, file=file, **params)
            return await raw.parse(), dict(raw.headers)
        except Exception as exc:  # noqa: BLE001
            raise classify_error(exc) from None


def _args(raw: str | None) -> Any:
    try:
        return json.loads(raw or "{}")
    except ValueError:
        return {"_unparsed": (raw or "")[:2000]}
