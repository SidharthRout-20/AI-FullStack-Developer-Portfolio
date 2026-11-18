"""Safarnaama's LLM tasks, registered with appcore's router when the package is imported."""

from __future__ import annotations

from appcore.llm.classify import Complexity, TaskProfile, register_tasks

S, M, C = Complexity.SIMPLE, Complexity.STANDARD, Complexity.COMPLEX

# The task prefix stays "tripweaver" (Safarnaama's former name) so quota history and logs remain continuous.
register_tasks(
    {
        "tripweaver.understand": TaskProfile(S, "extraction", "json", signals=False),
        # A multi-day plan is long JSON: room for it (within the 8k tokens/minute free tier) and light reasoning, so
        # the reply isn't cut off before the JSON ends.
        "tripweaver.plan": TaskProfile(C, "planning", "json", max_output_tokens=6500, reasoning_effort="low"),
        "tripweaver.replan": TaskProfile(C, "planning", "json", max_output_tokens=5000, reasoning_effort="low"),
        "tripweaver.companion": TaskProfile(M, "travel_assistance", "json"),
        "tripweaver.specialities": TaskProfile(M, "recommendation", "json"),
        "tripweaver.next_ideas": TaskProfile(M, "recommendation", "json"),
        "tripweaver.receipt": TaskProfile(S, "image_extraction", "json"),
    },
    {"tripweaver": 2},
)
