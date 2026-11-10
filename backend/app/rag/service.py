"""RAGService — the composition root that wires storage, retrieval, LLM and graph.

The API layer only talks to this class, which keeps HTTP concerns (FastAPI)
separate from AI concerns (LangGraph/Chroma) and makes both easy to test.
"""

from __future__ import annotations

import logging
import threading
from collections import defaultdict
from collections.abc import AsyncIterator, Callable
from typing import Any

from app.config import Settings
from app.rag.briefs import BriefService
from app.rag.embeddings import Embedder
from app.rag.graph import build_graph, describe_graph
from app.rag.ingestion import IngestReport, ingest
from app.rag.llm import ChatLLM, LLMNotConfiguredError, build_llm
from app.rag.retriever import HybridRetriever
from app.rag.vectorstore import VectorStore

logger = logging.getLogger(__name__)


class RAGService:
    def __init__(
        self,
        settings: Settings,
        *,
        llm_factory: Callable[[Settings], ChatLLM] = build_llm,
        embedder: Embedder | None = None,
    ) -> None:
        self.settings = settings
        self._llm_factory = llm_factory
        self._llm: ChatLLM | None = None
        self._llm_lock = threading.Lock()
        self._ingest_lock = threading.Lock()

        self.embedder = embedder or Embedder(settings)
        self.store = VectorStore(settings)
        self.retriever = HybridRetriever(self.store, self.embedder)
        self.graph = build_graph(settings, self.retriever, self.get_llm, lambda: sorted(self.store.indexed_sources()))
        self.topology = describe_graph(self.graph)
        self.briefs = BriefService(settings, self.store, self.get_llm)

    # ── LLM (lazy, so the app boots and serves retrieval even without a key) ──
    def get_llm(self) -> ChatLLM:
        if self._llm is None:
            with self._llm_lock:
                if self._llm is None:
                    self._llm = self._llm_factory(self.settings)
        return self._llm

    @property
    def llm_ready(self) -> bool:
        try:
            self.get_llm()
            return True
        except LLMNotConfiguredError:
            return False

    # ── indexing ───────────────────────────────────────────────────────────
    def ingest(self) -> IngestReport:
        # One ingest at a time; queries keep working against the current index.
        with self._ingest_lock:
            report = ingest(self.settings, self.store, self.embedder)
            if report.changed:
                self.retriever.refresh()
            return report

    def documents(self) -> list[dict[str, Any]]:
        stats: dict[str, dict[str, Any]] = defaultdict(lambda: {"chunks": 0, "pages": set()})
        for c in self.store.all_chunks():
            stats[c.source]["chunks"] += 1
            stats[c.source]["pages"].add(c.page)
        return [{"source": s, "chunks": v["chunks"], "pages": len(v["pages"])} for s, v in sorted(stats.items())]

    # ── querying ───────────────────────────────────────────────────────────
    @staticmethod
    def _initial_state(question: str, history: list[dict[str, str]]) -> dict[str, Any]:
        return {"question": question, "history": history}

    async def stream(self, question: str, history: list[dict[str, str]]) -> AsyncIterator[dict[str, Any]]:
        """Yield UI events (node / sources / token) and finally a `done` event."""
        final: dict[str, Any] = {}
        async for mode, chunk in self.graph.astream(
            self._initial_state(question, history), stream_mode=["custom", "values"]
        ):
            if mode == "custom":
                yield chunk
            else:
                final = chunk
        yield {
            "event": "done",
            "route": final.get("route"),
            "search_query": final.get("search_query"),
            "answer": final.get("answer", ""),
        }

    async def answer(self, question: str, history: list[dict[str, str]]) -> dict[str, Any]:
        """Non-streaming variant: collects the same events into one response."""
        trace: list[dict[str, Any]] = []
        sources: list[dict[str, Any]] = []
        done: dict[str, Any] = {}
        async for ev in self.stream(question, history):
            if ev["event"] == "node" and ev["status"] == "end":
                trace.append({"node": ev["node"], "ms": ev["ms"]})
            elif ev["event"] == "sources":
                sources = ev["sources"]
            elif ev["event"] == "done":
                done = ev
        return {"answer": done.get("answer", ""), "route": done.get("route"), "sources": sources, "trace": trace}
