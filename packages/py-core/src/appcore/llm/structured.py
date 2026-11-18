"""Structured (JSON) outputs that work with any provider.

Groq, Ollama and Claude all return text; we ask for JSON, extract it robustly (code fences, prose
around it), validate it against a Pydantic schema, and retry once with the validation error fed
back to the model. Downstream code only ever sees validated objects.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from pydantic import BaseModel, ValidationError

from appcore.llm.chat import ChatLLM, ChatTurn

logger = logging.getLogger(__name__)

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


class StructuredOutputError(RuntimeError):
    """The model did not return valid JSON for the schema, even after a retry."""


def extract_json(text: str) -> Any:
    """Parse the first JSON object in `text` (tolerates ```json fences and surrounding prose)."""
    fenced = _FENCE.search(text)
    candidate = fenced.group(1) if fenced else text
    start, end = candidate.find("{"), candidate.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object found")
    return json.loads(candidate[start : end + 1])


async def complete_json[T: BaseModel](
    llm: ChatLLM, system: str, prompt: str, schema: type[T], *, retries: int = 1
) -> T:
    turns: list[ChatTurn] = [{"role": "user", "content": prompt}]
    error = ""
    for attempt in range(retries + 1):
        reply = await llm.complete(system, turns)
        try:
            return schema.model_validate(extract_json(reply))
        except (ValueError, ValidationError) as exc:
            error = str(exc)[:500]
            logger.warning("Structured output attempt %d failed: %s", attempt + 1, error[:120])
            turns = [
                *turns,
                {"role": "assistant", "content": reply[:4000]},
                {
                    "role": "user",
                    "content": f"That was not valid JSON for the schema ({error}). Reply with the JSON only.",
                },
            ]
    raise StructuredOutputError(f"Model returned invalid structured output: {error}")
