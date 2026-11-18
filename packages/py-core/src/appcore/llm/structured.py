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


_TRAILING_COMMA = re.compile(r",(\s*[}\]])")


def _body(text: str) -> str:
    fenced = _FENCE.search(text)
    return (fenced.group(1) if fenced else text).strip()


def _start(candidate: str) -> int:
    """Where the JSON value starts: the first "{" or "[" (prose before it is ignored)."""
    hits = [i for i in (candidate.find("{"), candidate.find("[")) if i != -1]
    return min(hits) if hits else -1


def _loads(raw: str) -> Any:
    try:
        return json.loads(raw)
    except ValueError:
        return json.loads(_TRAILING_COMMA.sub(r"\1", raw))  # models often leave a comma before } or ]


def extract_json(text: str) -> Any:
    """Parse the first JSON object (or array) in `text`: tolerates ```json fences, prose around it, trailing commas."""
    candidate = _body(text)
    start = _start(candidate)
    if start == -1:
        raise ValueError("no JSON object found")
    closer = "}" if candidate[start] == "{" else "]"
    end = candidate.rfind(closer)
    if end <= start:
        raise ValueError("no complete JSON value found")
    try:
        return _loads(candidate[start : end + 1])
    except ValueError:
        return json.JSONDecoder().raw_decode(candidate[start:])[0]  # valid JSON followed by more text


def _scan(candidate: str) -> tuple[list[str], bool, list[tuple[int, list[str]]]]:
    """Open containers at the end, whether a string is still open, and every top-level-safe cut point.

    A comma outside strings always follows a complete value, so cutting just before it and closing the open
    containers gives valid JSON with everything up to that value.
    """
    stack: list[str] = []
    cuts: list[tuple[int, list[str]]] = []
    in_str = escaped = False
    for i, ch in enumerate(candidate):
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]":
            if stack:
                stack.pop()
            if stack:
                cuts.append((i + 1, list(stack)))
        elif ch == "," and stack:
            cuts.append((i, list(stack)))
    return stack, in_str, cuts


def looks_truncated(text: str) -> bool:
    """A JSON reply that stopped early: it opens an object but its brackets never balance (strings ignored)."""
    candidate = _body(text)
    start = _start(candidate)
    if start == -1:
        return False
    stack, in_str, _ = _scan(candidate[start:])
    return bool(stack) or in_str


def salvage_json(text: str) -> Any | None:
    """The complete part of a cut-off JSON reply: drop the unfinished tail and close what is still open.

    Returns None when nothing usable is left. Tries the latest cut points first, so as much as possible is kept.
    """
    candidate = _body(text)
    start = _start(candidate)
    if start == -1:
        return None
    candidate = candidate[start:]
    stack, in_str, cuts = _scan(candidate)
    if not stack and not in_str:
        return None
    for pos, open_ in reversed(cuts[-60:]):
        try:
            return _loads(candidate[:pos] + "".join(reversed(open_)))
        except ValueError:
            continue
    return None


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
            cut_off = looks_truncated(reply)
            # A reply cut off by the output budget usually holds most of the answer: keep its complete part when
            # that is valid for the schema (callers can ask for what is missing) instead of failing or re-asking.
            if cut_off and (partial := salvage_json(reply)) is not None:
                try:
                    result = schema.model_validate(partial)
                except ValidationError:
                    pass
                else:
                    logger.info("Structured output: kept the complete part of a cut-off reply")
                    return result
            logger.warning("Structured output attempt %d failed: %s", attempt + 1, error[:120])
            ask = (
                "Your reply was cut off before the JSON ended. Reply again with the complete JSON only, shorter: keep "
                "every required field, but make free-text fields (notes, summaries, tips) brief."
                if cut_off
                else f"That was not valid JSON for the schema ({error}). Reply with the JSON only."
            )
            # A cut-off reply is not worth echoing back (it only eats the budget of the retry).
            turns = [*turns, {"role": "assistant", "content": "[reply cut off]" if cut_off else reply[:4000]},
                     {"role": "user", "content": ask}]  # fmt: skip
    raise StructuredOutputError(f"Model returned invalid structured output: {error}")
