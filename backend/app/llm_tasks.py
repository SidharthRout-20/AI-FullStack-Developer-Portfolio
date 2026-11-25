"""The portfolio's LLM tasks and quota priorities, registered with appcore's router.

Every LLM call site declares one of these tasks ("product.feature"); the profile maps it to routing needs.
Safarnaama registers its own tasks in its package (safarnama/tasks.py).
"""

from __future__ import annotations

from appcore.llm.classify import Complexity, TaskProfile, register_tasks

S, M, C, A = Complexity.SIMPLE, Complexity.STANDARD, Complexity.COMPLEX, Complexity.ADVANCED

register_tasks(
    {
        # EFI
        "efi.investigate": TaskProfile(A, "engineering_debugging", "json", signals=False),
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
        "codelens.pack": TaskProfile(C, "multi_document_analysis", "json"),
        "flowforge.prompt": TaskProfile(M, "automation_step", background=True),
        "flowforge.extract": TaskProfile(S, "extraction", "json", background=True),
        "evolve.run": TaskProfile(M, "prompt_execution"),
        "evolve.judge": TaskProfile(M, "evaluation", "json"),
        "evolve.reflect": TaskProfile(C, "reasoning", "json"),
    },
    # Quota priority: 1 is protected the most (Safarnaama registers "tripweaver": 2).
    {"efi": 1, "keeper": 3, "documind": 3, "meetingmind": 3},
)
