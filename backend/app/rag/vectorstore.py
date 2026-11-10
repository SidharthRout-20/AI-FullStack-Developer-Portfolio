"""Thin wrapper around a *persistent, local* ChromaDB collection.

We pass our own embeddings (FastEmbed) instead of letting Chroma embed, so the
embedding model is explicit, swappable and identical at index and query time.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import chromadb
import numpy as np
from chromadb.config import Settings as ChromaSettings

from app.config import Settings


@dataclass(frozen=True)
class Chunk:
    id: str
    text: str
    source: str
    page: int
    chunk_index: int


class VectorStore:
    def __init__(self, settings: Settings) -> None:
        settings.chroma_dir.mkdir(parents=True, exist_ok=True)
        self._client = chromadb.PersistentClient(
            path=str(settings.chroma_dir),
            settings=ChromaSettings(anonymized_telemetry=False, allow_reset=False),
        )
        self._collection = self._client.get_or_create_collection(
            name=settings.collection_name,
            embedding_function=None,
            metadata={"hnsw:space": "cosine"},
        )

    # ── writes ─────────────────────────────────────────────────────────────
    def upsert(self, chunks: list[Chunk], embeddings: np.ndarray, file_hash: str) -> None:
        if not chunks:
            return
        self._collection.upsert(
            ids=[c.id for c in chunks],
            documents=[c.text for c in chunks],
            embeddings=embeddings.tolist(),
            metadatas=[
                {
                    "source": c.source,
                    "page": c.page,
                    "chunk_index": c.chunk_index,
                    "file_hash": file_hash,
                }
                for c in chunks
            ],
        )

    def delete_source(self, source: str) -> None:
        self._collection.delete(where={"source": source})

    # ── reads ──────────────────────────────────────────────────────────────
    def count(self) -> int:
        return self._collection.count()

    def all_chunks(self) -> list[Chunk]:
        res = self._collection.get(include=["documents", "metadatas"])
        return [
            _to_chunk(id_, doc, meta)
            for id_, doc, meta in zip(res["ids"], res["documents"] or [], res["metadatas"] or [], strict=True)
        ]

    def indexed_sources(self) -> dict[str, str]:
        """Map of source file → file hash currently stored in the index."""
        res = self._collection.get(include=["metadatas"])
        return {str(m["source"]): str(m["file_hash"]) for m in res["metadatas"] or []}

    def query(self, embedding: np.ndarray, k: int) -> list[tuple[Chunk, float]]:
        """Nearest neighbours as (chunk, cosine similarity)."""
        if self.count() == 0:
            return []
        res = self._collection.query(
            query_embeddings=[embedding.tolist()],
            n_results=min(k, self.count()),
            include=["documents", "metadatas", "distances"],
        )
        out: list[tuple[Chunk, float]] = []
        for id_, doc, meta, dist in zip(
            res["ids"][0], res["documents"][0], res["metadatas"][0], res["distances"][0], strict=True
        ):
            out.append((_to_chunk(id_, doc, meta), 1.0 - float(dist)))  # cosine distance → similarity
        return out

    def embeddings_for(self, ids: list[str]) -> dict[str, np.ndarray]:
        if not ids:
            return {}
        res = self._collection.get(ids=ids, include=["embeddings"])
        return {i: np.asarray(e, dtype=np.float32) for i, e in zip(res["ids"], res["embeddings"], strict=True)}


def _to_chunk(id_: str, doc: str | None, meta: Any) -> Chunk:
    meta = meta or {}
    return Chunk(
        id=id_,
        text=doc or "",
        source=str(meta.get("source", "unknown")),
        page=int(meta.get("page", 1)),
        chunk_index=int(meta.get("chunk_index", 0)),
    )
