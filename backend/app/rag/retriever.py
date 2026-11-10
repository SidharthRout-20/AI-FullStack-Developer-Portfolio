"""Hybrid retrieval: dense vectors + sparse BM25, fused with Reciprocal Rank Fusion.

Why hybrid?
* Dense (semantic) search understands paraphrases: "work history" ≈ "experience".
* Sparse (BM25) search nails exact tokens dense models blur: "FastAPI", "AWS", years.
* RRF merges the two rankings without needing their scores to be comparable:
      score(d) = Σ_r 1 / (k + rank_r(d))      (k = 60 per the original paper)
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass

import numpy as np
from rank_bm25 import BM25Okapi

from app.rag.embeddings import Embedder
from app.rag.vectorstore import Chunk, VectorStore

_TOKEN_RE = re.compile(r"[a-z0-9]+(?:[.+#][a-z0-9]+)*[+#]*")  # keeps node.js, c++, c#
RRF_K = 60


def tokenize(text: str) -> list[str]:
    return _TOKEN_RE.findall(text.lower())


@dataclass(frozen=True)
class ScoredChunk:
    chunk: Chunk
    similarity: float  # cosine similarity to the query (used for relevance grading)
    rrf_score: float  # fused rank score (used for ordering)
    dense_rank: int | None = None  # 1-based rank in the vector search (None = not in its top-k)
    sparse_rank: int | None = None  # 1-based rank in BM25 (None = not in its top-k)


def reciprocal_rank_fusion(rankings: list[list[str]], k: int = RRF_K) -> dict[str, float]:
    scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking, start=1):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank)
    return scores


class HybridRetriever:
    def __init__(self, store: VectorStore, embedder: Embedder) -> None:
        self._store = store
        self._embedder = embedder
        self._lock = threading.Lock()
        self._chunks: dict[str, Chunk] = {}
        self._ids: list[str] = []
        self._bm25: BM25Okapi | None = None
        self.refresh()

    def refresh(self) -> None:
        """(Re)build the in-memory BM25 index from the vector store."""
        chunks = self._store.all_chunks()
        with self._lock:
            self._chunks = {c.id: c for c in chunks}
            self._ids = [c.id for c in chunks]
            self._bm25 = BM25Okapi([tokenize(c.text) for c in chunks]) if chunks else None

    def search(self, query: str, top_k: int, candidate_k: int) -> list[ScoredChunk]:
        q_vec = self._embedder.embed_query(query)

        # 1) dense ranking
        dense = self._store.query(q_vec, candidate_k)
        dense_ids = [c.id for c, _ in dense]
        similarity = {c.id: s for c, s in dense}

        # 2) sparse ranking
        sparse_ids: list[str] = []
        with self._lock:
            bm25, ids, chunks = self._bm25, self._ids, dict(self._chunks)
        if bm25 is not None:
            scores = bm25.get_scores(tokenize(query))
            order = np.argsort(scores)[::-1][:candidate_k]
            sparse_ids = [ids[i] for i in order if scores[i] > 0]

        # 3) fuse
        fused = reciprocal_rank_fusion([dense_ids, sparse_ids])
        ranked = sorted(fused, key=fused.get, reverse=True)[:top_k]  # type: ignore[arg-type]

        # BM25-only hits have no similarity yet → compute it from stored vectors.
        missing = [i for i in ranked if i not in similarity]
        for doc_id, vec in self._store.embeddings_for(missing).items():
            similarity[doc_id] = float(np.dot(q_vec, vec))

        chunk_lookup = {c.id: c for c, _ in dense} | chunks
        dense_rank = {doc_id: r for r, doc_id in enumerate(dense_ids, start=1)}
        sparse_rank = {doc_id: r for r, doc_id in enumerate(sparse_ids, start=1)}
        return [
            ScoredChunk(
                chunk=chunk_lookup[i],
                similarity=similarity.get(i, 0.0),
                rrf_score=fused[i],
                dense_rank=dense_rank.get(i),
                sparse_rank=sparse_rank.get(i),
            )
            for i in ranked
            if i in chunk_lookup
        ]
