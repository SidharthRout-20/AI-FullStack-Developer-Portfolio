"""The RAG workflow as an explicit LangGraph state machine.

                 ┌──────────┐ blocked  ┌────────┐
    START ─────► │  guard   │ ───────► │ refuse │ ──► END
                 └────┬─────┘          └────────┘
                      │ allowed
                 ┌────▼─────┐
                 │ rewrite  │  (condense follow-ups using chat history)
                 └────┬─────┘
                 ┌────▼─────┐
                 │ retrieve │  (hybrid: dense + BM25 → RRF)
                 └────┬─────┘
                 ┌────▼─────┐ nothing relevant ┌──────────┐
                 │  grade   │ ───────────────► │ general  │ ──► END  (general knowledge +
                 └────┬─────┘                  └──────────┘          nudge to the documents)
                      │ relevant
                 ┌────▼─────┐
                 │ generate │  (streams tokens, cites [n])  ──► END
                 └──────────┘

Every node is wrapped by `traced`, which pushes `node start/end` events (with
timings and a small detail payload) onto LangGraph's *custom* stream. The API
forwards those events over SSE and the React UI animates the graph from them.
The same compiled graph also works with plain `ainvoke` (writer becomes a no-op).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any, Literal, TypedDict

from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.types import StreamWriter

from app.config import Settings
from app.rag import prompts
from app.rag.guardrails import check_input
from app.rag.llm import ChatLLM, ChatTurn
from app.rag.retriever import HybridRetriever, ScoredChunk

logger = logging.getLogger(__name__)

Route = Literal["answered", "general", "blocked"]


class RAGState(TypedDict, total=False):
    question: str
    history: list[dict[str, str]]
    search_query: str
    candidates: list[ScoredChunk]
    documents: list[ScoredChunk]
    answer: str
    route: Route


# Human-friendly metadata the frontend renders on each graph node.
NODE_INFO: dict[str, dict[str, str]] = {
    "__start__": {"label": "Question", "description": "User question enters the workflow"},
    "guard": {"label": "Guardrails", "description": "Validates input and blocks prompt-injection attempts"},
    "rewrite": {"label": "Query Rewrite", "description": "Turns follow-ups into standalone search queries"},
    "retrieve": {"label": "Hybrid Retrieval", "description": "Dense vectors + BM25, fused with Reciprocal Rank Fusion"},
    "grade": {"label": "Relevance Grading", "description": "Gates on best similarity, keeps chunks close to the best"},
    "generate": {"label": "Generate Answer", "description": "LLM answers from context with inline citations"},
    "general": {
        "label": "General Knowledge",
        "description": "Off-topic: answer from general knowledge, then point back to the documents",
    },
    "refuse": {"label": "Refuse", "description": "Politely declines unsafe or off-policy requests"},
    "__end__": {"label": "Answer", "description": "Response streamed to the user"},
}

NodeFn = Callable[[RAGState, StreamWriter], Awaitable[dict[str, Any]]]


def traced(name: str, fn: NodeFn) -> Callable[[RAGState], Awaitable[dict[str, Any]]]:
    """Decorate a node so it emits start/end/error trace events with timings."""

    async def wrapper(state: RAGState) -> dict[str, Any]:
        writer = get_stream_writer()
        writer({"event": "node", "node": name, "status": "start"})
        started = time.perf_counter()
        try:
            update = await fn(state, writer)
        except Exception:
            writer({"event": "node", "node": name, "status": "error"})
            raise
        detail = update.pop("_detail", {})
        elapsed = round((time.perf_counter() - started) * 1000, 1)
        writer({"event": "node", "node": name, "status": "end", "ms": elapsed, "detail": detail})
        return update

    wrapper.__name__ = name
    return wrapper


def serialize_sources(docs: list[ScoredChunk]) -> list[dict[str, Any]]:
    return [
        {
            "id": i,
            "source": d.chunk.source,
            "page": d.chunk.page,
            "similarity": round(d.similarity, 3),
            "snippet": d.chunk.text[:400],
        }
        for i, d in enumerate(docs, start=1)
    ]


def confidence(best: float, threshold: float) -> str:
    """Human-readable retrieval confidence from the best similarity score."""
    if best >= threshold + 0.08:
        return "high"
    if best >= threshold:
        return "medium"
    return "low"


async def _stream_answer(
    llm: ChatLLM, system: str, turns: list[ChatTurn], writer: StreamWriter
) -> tuple[str, dict[str, Any]]:
    """Stream tokens to the client and measure time-to-first-token and throughput."""
    started = time.perf_counter()
    first: float | None = None
    parts: list[str] = []
    async for text in llm.stream(system, turns):
        if first is None:
            first = time.perf_counter()
        parts.append(text)
        writer({"event": "token", "text": text})
    ended = time.perf_counter()
    answer = "".join(parts).strip()
    gen_s = (ended - first) if first else 0.0
    return answer, {
        "chars": len(answer),
        "words": len(answer.split()),
        "ttft_ms": round(((first or ended) - started) * 1000, 1),
        "chars_per_s": round(len(answer) / gen_s) if gen_s > 0 else None,
    }


def build_graph(
    settings: Settings,
    retriever: HybridRetriever,
    get_llm: Callable[[], ChatLLM],
    document_names: Callable[[], list[str]] = list,
):
    # ── nodes ──────────────────────────────────────────────────────────────
    async def guard(state: RAGState, _w: StreamWriter) -> dict[str, Any]:
        result = check_input(state["question"])
        return {
            "route": "answered" if result.allowed else "blocked",
            "_detail": {"allowed": result.allowed, "reason": result.reason},
        }

    async def rewrite(state: RAGState, _w: StreamWriter) -> dict[str, Any]:
        history = state.get("history") or []
        if not history:  # first turn: no LLM call needed
            return {"search_query": state["question"], "_detail": {"query": state["question"], "rewritten": False}}
        prompt = prompts.REWRITE_PROMPT.format(
            history=prompts.format_history(history[-settings.max_history_messages :]), question=state["question"]
        )
        try:
            reply = await get_llm().complete(None, [{"role": "user", "content": prompt}], short=True)
        except Exception as exc:
            # Rewriting is an optimisation, not a requirement: degrade gracefully to the raw
            # question so retrieval (and the no-context fallback) still work if the LLM is down.
            logger.warning("Query rewrite failed, using original question: %s", type(exc).__name__)
            return {
                "search_query": state["question"],
                "_detail": {"query": state["question"], "rewritten": False, "degraded": True},
            }
        query = reply.strip().strip('"')[: settings.max_question_chars] or state["question"]
        return {"search_query": query, "_detail": {"query": query, "rewritten": True}}

    async def retrieve(state: RAGState, _w: StreamWriter) -> dict[str, Any]:
        # Embedding + BM25 are CPU-bound: run off the event loop so other requests stay responsive.
        hits = await asyncio.to_thread(retriever.search, state["search_query"], settings.top_k, settings.candidate_k)
        return {
            "candidates": hits,
            "_detail": {
                "query": state["search_query"],
                "count": len(hits),
                "candidates": [
                    {
                        "rank": r,
                        "source": h.chunk.source,
                        "page": h.chunk.page,
                        "similarity": round(h.similarity, 3),
                        "rrf": round(h.rrf_score, 4),
                        "dense_rank": h.dense_rank,
                        "sparse_rank": h.sparse_rank,
                        "preview": h.chunk.text[:160],
                    }
                    for r, h in enumerate(hits, start=1)
                ],
            },
        }

    async def grade(state: RAGState, writer: StreamWriter) -> dict[str, Any]:
        candidates = state.get("candidates") or []
        best = max((c.similarity for c in candidates), default=0.0)
        cutoff = best - settings.relevance_margin
        grounded = best >= settings.relevance_threshold
        relevant = [c for c in candidates if c.similarity >= cutoff] if grounded else []
        if relevant:
            writer({"event": "sources", "sources": serialize_sources(relevant)})
        kept = {id(c) for c in relevant}
        return {
            "documents": relevant,
            "route": "answered" if relevant else "general",
            "_detail": {
                "decision": "grounded" if relevant else "general",
                "kept": len(relevant),
                "dropped": len(candidates) - len(relevant),
                "best": round(best, 3),
                "threshold": settings.relevance_threshold,
                "margin": settings.relevance_margin,
                "cutoff": round(cutoff, 3),
                "kept_ranks": [r for r, c in enumerate(candidates, start=1) if id(c) in kept],
                "confidence": confidence(best, settings.relevance_threshold),
            },
        }

    async def generate(state: RAGState, writer: StreamWriter) -> dict[str, Any]:
        turns: list[ChatTurn] = [
            {"role": m["role"], "content": m["content"]}  # type: ignore[typeddict-item]
            for m in (state.get("history") or [])[-settings.max_history_messages :]
        ]
        context = prompts.format_context(state["documents"])
        turns.append({"role": "user", "content": f"{context}\n\nQuestion: {state['question']}"})

        answer, stats = await _stream_answer(get_llm(), prompts.SYSTEM_PROMPT, turns, writer)
        return {"answer": answer, "_detail": stats}

    async def general(state: RAGState, writer: StreamWriter) -> dict[str, Any]:
        nudge = prompts.general_nudge(document_names())
        turns: list[ChatTurn] = [
            {"role": m["role"], "content": m["content"]}  # type: ignore[typeddict-item]
            for m in (state.get("history") or [])[-settings.max_history_messages :]
        ]
        turns.append({"role": "user", "content": state["question"]})
        try:
            answer, stats = await _stream_answer(get_llm(), prompts.GENERAL_PROMPT, turns, writer)
        except Exception as exc:
            # No LLM available (or it failed): stay useful with a static reply instead of an error.
            logger.warning("General answer unavailable, using static reply: %s", type(exc).__name__)
            writer({"event": "token", "text": prompts.NO_CONTEXT_ANSWER})
            return {"answer": prompts.NO_CONTEXT_ANSWER, "_detail": {"degraded": True}}
        writer({"event": "token", "text": nudge})
        return {"answer": answer + nudge, "_detail": stats}

    async def refuse(_s: RAGState, writer: StreamWriter) -> dict[str, Any]:
        writer({"event": "token", "text": prompts.BLOCKED_ANSWER})
        return {"answer": prompts.BLOCKED_ANSWER}

    # ── wiring ─────────────────────────────────────────────────────────────
    g = StateGraph(RAGState)
    for name, fn in {
        "guard": guard,
        "rewrite": rewrite,
        "retrieve": retrieve,
        "grade": grade,
        "generate": generate,
        "general": general,
        "refuse": refuse,
    }.items():
        g.add_node(name, traced(name, fn))

    g.add_edge(START, "guard")
    g.add_conditional_edges(
        "guard",
        lambda s: "refuse" if s["route"] == "blocked" else "rewrite",
        {"rewrite": "rewrite", "refuse": "refuse"},
    )
    g.add_edge("rewrite", "retrieve")
    g.add_edge("retrieve", "grade")
    g.add_conditional_edges(
        "grade",
        lambda s: "generate" if s["route"] == "answered" else "general",
        {"generate": "generate", "general": "general"},
    )
    for terminal in ("generate", "general", "refuse"):
        g.add_edge(terminal, END)

    return g.compile()


def describe_graph(compiled) -> dict[str, Any]:
    """Topology for the frontend, derived from the compiled graph itself
    (single source of truth — change the graph, the UI follows)."""
    gg = compiled.get_graph()
    return {
        "nodes": [
            {"id": node_id, **NODE_INFO.get(node_id, {"label": node_id, "description": ""})} for node_id in gg.nodes
        ],
        "edges": [{"source": e.source, "target": e.target, "conditional": bool(e.conditional)} for e in gg.edges],
    }
