"""Shared helpers for product endpoints: structured LLM calls with timeouts, safe error text, SSE framing."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from typing import Any

from pydantic import BaseModel, model_validator

from appcore.llm import for_task
from appcore.llm.chat import ChatLLM, user_facing_error
from appcore.llm.structured import StructuredOutputError, complete_json

logger = logging.getLogger(__name__)

GetLLM = Callable[[], ChatLLM]


def llm_for(get_llm: GetLLM, task: str | None) -> ChatLLM:
    """The LLM for one declared task ("product.feature"): with Groq it is routed by the central LLM router."""
    llm = get_llm()
    return for_task(llm, task) if task else llm


async def ask_json[T: BaseModel](
    get_llm: GetLLM, system: str, prompt: str, schema: type[T], limit_s: float = 90, *, task: str | None = None
) -> T:
    """One structured LLM call: JSON → Pydantic, with one repair retry and an overall timeout."""
    return await asyncio.wait_for(complete_json(llm_for(get_llm, task), system, prompt, schema), limit_s)


async def ask_text(get_llm: GetLLM, system: str, prompt: str, limit_s: float = 90, *, task: str | None = None) -> str:
    llm = llm_for(get_llm, task)
    return await asyncio.wait_for(llm.complete(system, [{"role": "user", "content": prompt}]), limit_s)


def llm_failure(exc: Exception) -> str:
    """Map any failure to a safe, actionable sentence (internals are logged, never returned)."""
    if isinstance(exc, StructuredOutputError):
        return "The model's response couldn't be parsed. Please try again."
    if isinstance(exc, TimeoutError):
        return "The model took too long to respond (the free tier may be busy). Please try again."
    message = user_facing_error(exc)
    if message is None:
        logger.exception("product request failed", exc_info=exc)
    return message or "Something went wrong while talking to the model."


def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


def clip(text: str, limit: int) -> str:
    """Trim long inputs before they reach a prompt (keeps free-tier token budgets predictable)."""
    return text if len(text) <= limit else text[:limit] + "\n…[truncated]"


class Lenient(BaseModel):
    """Base for LLM *output* schemas: over-long strings/lists are trimmed to the field's max_length instead of
    failing validation (models often return 12 items when asked for 8). Required fields and types stay strict."""

    @model_validator(mode="before")
    @classmethod
    def _clip(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        for name, field in cls.model_fields.items():
            value = out.get(name)
            if not isinstance(value, str | list):
                continue
            for meta in field.metadata:
                limit = getattr(meta, "max_length", None)
                if limit is not None and len(value) > limit:
                    out[name] = value[:limit]
        return out
