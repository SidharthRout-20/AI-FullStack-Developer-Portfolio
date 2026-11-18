"""Deterministic request classification: no model call is ever spent deciding which model to call.

Complexity (how much reasoning a request needs) and modality (text / image / audio) are independent dimensions.
Each application call declares a task ("tripweaver.plan"); the task profile gives the base complexity, and
measurable signals (context size, multi-step wording, images, tools, strict JSON) adjust it. Undeclared tasks keep
the safe default model (see the router).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Literal

Structured = Literal["none", "json", "schema", "strict"]


class Complexity(IntEnum):
    SIMPLE = 1
    STANDARD = 2
    COMPLEX = 3
    ADVANCED = 4


@dataclass(frozen=True)
class TaskProfile:
    complexity: Complexity
    category: str
    structured: Structured = "none"
    background: bool = False  # optional/background work: lowest quota priority
    signals: bool = True  # allow wording/size signals to raise the complexity
    # Long structured outputs (a multi-day plan) need more room than settings.llm_max_tokens. Reasoning models spend
    # part of the budget thinking, so long JSON tasks also ask for less reasoning. Stay under the free tier's
    # tokens-per-minute limit (8k on Groq), which counts the requested output budget.
    max_output_tokens: int | None = None
    reasoning_effort: str | None = None


S, M, C, A = Complexity.SIMPLE, Complexity.STANDARD, Complexity.COMPLEX, Complexity.ADVANCED

# Every LLM call site declares a task. Each product registers its own tasks (and its quota priority) with
# `register_tasks` when its package is imported; the table below holds only what appcore itself uses.
TASKS: dict[str, TaskProfile] = {
    # Safety classification (only task category the safeguard model may serve)
    "safety.classify": TaskProfile(S, "safety_classification", "json", signals=False),
}

# Quota priority per product prefix ("efi", "tripweaver"…): 1 is protected the most.
PRODUCT_PRIORITY: dict[str, int] = {}


def register_tasks(tasks: dict[str, TaskProfile], priorities: dict[str, int] | None = None) -> None:
    """Declare a product's LLM tasks ("product.feature" → profile) and, optionally, its quota priority."""
    TASKS.update(tasks)
    PRODUCT_PRIORITY.update(priorities or {})


LABS_PRIORITY = 3
BACKGROUND_PRIORITY = 4

_MULTI_STEP = re.compile(
    r"\b(step[- ]by[- ]step|compare|comparison|trade-?offs?|why|root cause|re-?plan|reorgani[sz]e|re-?schedule|"
    r"optimi[sz]e|multi-?day|several|across|analy[sz]e|plan (?:my|our|the) (?:whole|entire))\b",
    re.I,
)
CHARS_PER_TOKEN = 4  # conservative estimate when no tokenizer is available


def estimate_tokens(text_chars: int, images: int = 0, image_tokens: int = 2048) -> int:
    return text_chars // CHARS_PER_TOKEN + images * image_tokens + 16


@dataclass
class LLMRequest:
    """One application request to a model. Only metadata about it is ever logged, never the content."""

    task: str  # "product.feature", e.g. "tripweaver.plan"
    messages: list[dict[str, Any]] = field(default_factory=list)  # [{"role", "content"}]
    system: str | None = None
    images: list[tuple[str, bytes]] = field(default_factory=list)  # (mime, data), attached to the last user turn
    audio: tuple[str, bytes] | None = None  # (filename, data) for transcription
    structured: Structured | None = None  # None → the task profile's default
    schema: dict[str, Any] | None = None  # JSON schema for "schema"/"strict"
    tools: list[dict[str, Any]] | None = None
    parallel_tools: bool = False
    max_output_tokens: int | None = None
    reasoning_effort: str | None = None
    temperature: float | None = None
    complexity: Complexity | None = None  # explicit override (e.g. `short=True` utility calls → SIMPLE)
    priority: int | None = None
    prefer_model: str | None = None  # still has to pass every hard filter
    timeout_s: float | None = None
    max_retries: int | None = None
    response_params: dict[str, Any] = field(default_factory=dict)  # e.g. transcription response_format

    @property
    def product(self) -> str:
        return self.task.split(".", 1)[0]

    @property
    def feature(self) -> str:
        return self.task.split(".", 1)[1] if "." in self.task else "default"

    def text_chars(self) -> int:
        body = sum(len(m.get("content") or "") if isinstance(m.get("content"), str) else 0 for m in self.messages)
        return body + len(self.system or "")


@dataclass
class Classification:
    task: str
    task_known: bool
    category: str
    complexity: Complexity
    modality: Literal["text", "image", "audio"]
    structured: Structured
    needs_tools: bool
    needs_parallel_tools: bool
    est_input_tokens: int
    images: int
    priority: int
    reasons: list[str]

    def as_dict(self) -> dict[str, Any]:
        return {
            "task": self.task, "task_known": self.task_known, "category": self.category,
            "complexity": self.complexity.name, "modality": self.modality, "structured": self.structured,
            "needs_tools": self.needs_tools, "needs_parallel_tools": self.needs_parallel_tools,
            "est_input_tokens": self.est_input_tokens, "images": self.images, "priority": self.priority,
            "reasons": self.reasons,
        }  # fmt: skip


def priority_for(product: str, profile: TaskProfile | None) -> int:
    if profile and profile.background:
        return BACKGROUND_PRIORITY
    return PRODUCT_PRIORITY.get(product, LABS_PRIORITY)


def classify_request(req: LLMRequest) -> Classification:
    profile = TASKS.get(req.task)
    reasons: list[str] = []
    if profile:
        complexity, category = profile.complexity, profile.category
        reasons.append(f"task profile {req.task}: {complexity.name.lower()} {category}")
    else:
        complexity, category = Complexity.STANDARD, "general"
        reasons.append(f"undeclared task {req.task!r}: standard, safe default model preferred")

    modality: Literal["text", "image", "audio"] = "audio" if req.audio else "image" if req.images else "text"
    if modality != "text":
        reasons.append(f"{modality} input")
    est = estimate_tokens(req.text_chars(), len(req.images))

    if req.complexity is not None:
        complexity = req.complexity
        reasons.append(f"caller set complexity {complexity.name.lower()}")
    elif modality != "audio" and (profile is None or profile.signals):
        last_user = next((m.get("content") for m in reversed(req.messages) if m.get("role") == "user"), "") or ""
        text = last_user if isinstance(last_user, str) else ""
        if est > 24_000 and complexity < Complexity.COMPLEX:
            complexity = Complexity.COMPLEX
            reasons.append(f"large context (~{est} tokens) → complex")
        elif est > 6_000 and complexity < Complexity.STANDARD:
            complexity = Complexity.STANDARD
            reasons.append(f"long input (~{est} tokens) → at least standard")
        if (
            profile
            and profile.complexity == Complexity.STANDARD
            and len(text) >= 80
            and len(_MULTI_STEP.findall(text)) >= 1
        ):
            complexity = Complexity.COMPLEX
            reasons.append("multi-step / comparative wording → complex")
        if req.tools and len(req.tools) >= 4 and complexity < Complexity.COMPLEX:
            complexity = Complexity.COMPLEX
            reasons.append(f"{len(req.tools)} tools → complex tool use")

    structured: Structured = req.structured or (profile.structured if profile else "none")
    if req.schema and structured in ("none", "json"):
        structured = "schema"
    return Classification(
        task=req.task,
        task_known=profile is not None,
        category=category,
        complexity=complexity,
        modality=modality,
        structured=structured,
        needs_tools=bool(req.tools),
        needs_parallel_tools=bool(req.tools) and req.parallel_tools,
        est_input_tokens=est,
        images=len(req.images),
        priority=req.priority or priority_for(req.product, profile),
        reasons=reasons,
    )
