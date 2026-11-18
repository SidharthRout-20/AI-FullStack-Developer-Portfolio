"""Lightweight input guardrails (first line of defence, not the only one).

Heuristics catch the most common prompt-injection / jailbreak phrasings cheaply,
before any LLM tokens are spent. The system prompt and context tagging in
`prompts.py` are the second line; output rendering without raw HTML on the
frontend is the third (defence in depth).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

_INJECTION_PATTERNS = [
    r"\bignore\b.{0,40}\b(instructions?|rules|prompt|above|previous)\b",
    r"\bdisregard\b.{0,40}\b(instructions?|rules|prompt)\b",
    r"\b(reveal|show|print|repeat|leak)\b.{0,40}\b(system|hidden|initial)\s+(prompt|instructions?)\b",
    r"\byou\s+are\s+now\b",
    r"\b(jailbreak|DAN mode|developer mode)\b",
    r"\bact\s+as\b.{0,40}\b(unrestricted|unfiltered|without (rules|restrictions))\b",
    r"</?\s*(system|context|source)\b",  # attempts to forge our prompt delimiters
]
_COMPILED = [re.compile(p, re.IGNORECASE | re.DOTALL) for p in _INJECTION_PATTERNS]
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


@dataclass(frozen=True)
class GuardResult:
    allowed: bool
    reason: str | None = None


def normalize(text: str) -> str:
    """NFKC-normalise (defeats look-alike Unicode tricks) and strip control chars."""
    return _CONTROL_CHARS.sub("", unicodedata.normalize("NFKC", text)).strip()


def check_input(text: str) -> GuardResult:
    if not text:
        return GuardResult(False, "empty")
    for pattern in _COMPILED:
        if pattern.search(text):
            return GuardResult(False, "possible prompt injection")
    return GuardResult(True)
