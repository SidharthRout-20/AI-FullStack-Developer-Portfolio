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


S, M, C, A = Complexity.SIMPLE, Complexity.STANDARD, Complexity.COMPLEX, Complexity.ADVANCED

# Every LLM call site in the application declares one of these. Keep this table the single place where product
# features are mapped to routing needs.
TASKS: dict[str, TaskProfile] = {
    # EFI
    "efi.investigate": TaskProfile(A, "engineering_debugging", "json", signals=False),
    # TripWeaver
    "tripweaver.understand": TaskProfile(S, "extraction", "json", signals=False),
    "tripweaver.plan": TaskProfile(C, "planning", "json"),
    "tripweaver.replan": TaskProfile(C, "planning", "json"),
    "tripweaver.companion": TaskProfile(M, "travel_assistance", "json"),
    "tripweaver.specialities": TaskProfile(M, "recommendation", "json"),
    "tripweaver.next_ideas": TaskProfile(M, "recommendation", "json"),
    "tripweaver.receipt": TaskProfile(S, "image_extraction", "json"),
    # DocuMind (RAG) & Respond prototype
    "documind.rewrite": TaskProfile(S, "rewrite", signals=False),
    "documind.answer": TaskProfile(M, "rag_answer"),
    "documind.general": TaskProfile(M, "conversation"),
    "documind.brief": TaskProfile(M, "summarisation", "json", background=True),
    "documind.match": TaskProfile(C, "multi_document_analysis", "json"),
    # Keeper
    "keeper.command": TaskProfile(S, "intent_classification", "json", signals=False),
    "keeper.brief": TaskProfile(S, "summarisation", background=True),
    "keeper.photo": TaskProfile(S, "image_extraction", "json"),
    # Follow-through prototype (MeetingMind)
    "meetingmind.analyse": TaskProfile(M, "summarisation", "json"),
    "meetingmind.ask": TaskProfile(M, "rag_answer"),
    "meetingmind.transcribe": TaskProfile(S, "transcription"),
    # Labs
    "careerpilot.tailor": TaskProfile(M, "rewriting", "json"),
    "careerpilot.questions": TaskProfile(M, "generation", "json"),
    "careerpilot.assess": TaskProfile(M, "evaluation", "json"),
    "codelens.ask": TaskProfile(M, "rag_answer"),
    "codelens.tour": TaskProfile(C, "multi_document_analysis", "json"),
    "flowforge.prompt": TaskProfile(M, "automation_step", background=True),
    "flowforge.extract": TaskProfile(S, "extraction", "json", background=True),
    "evolve.run": TaskProfile(M, "prompt_execution"),
    "evolve.judge": TaskProfile(M, "evaluation", "json"),
    "evolve.reflect": TaskProfile(C, "reasoning", "json"),
    # Safety classification (only task category the safeguard model may serve)
    "safety.classify": TaskProfile(S, "safety_classification", "json", signals=False),
}

# Quota priority: 1 is protected the most. Matches the product priorities of the approved portfolio.
PRODUCT_PRIORITY = {"efi": 1, "tripweaver": 2, "keeper": 3, "documind": 3, "meetingmind": 3}
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
