"""A small, persistent, local vector store: SQLite for storage, NumPy for exact cosine search.

The corpus is a handful of documents (hundreds of chunks at most), so an exact brute-force search is
both faster than an ANN index at this size and needs no heavy dependency. (ChromaDB was used before;
its dependency tree alone pushed the serverless bundle past Vercel's 500 MB limit.)

We pass our own embeddings (FastEmbed), so the embedding model is explicit, swappable and identical at
index and query time.
"""

from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass

import numpy as np

from app.config import Settings


@dataclass(frozen=True)
class Chunk:
    id: str
    text: str
    source: str
    page: int
    chunk_index: int


_SCHEMA = """
CREATE TABLE IF NOT EXISTS chunks (
    id          TEXT PRIMARY KEY,
    text        TEXT NOT NULL,
    source      TEXT NOT NULL,
    page        INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    file_hash   TEXT NOT NULL,
    embedding   BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source);
"""


class VectorStore:
    def __init__(self, settings: Settings) -> None:
        settings.vector_dir.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(settings.vector_dir / "vectors.sqlite3", check_same_thread=False)
        self._db.executescript(_SCHEMA)
        self._lock = threading.Lock()
        self._matrix: tuple[list[Chunk], np.ndarray] | None = None  # cached, normalised, for search

    # ── writes ─────────────────────────────────────────────────────────────
    def upsert(self, chunks: list[Chunk], embeddings: np.ndarray, file_hash: str) -> None:
        if not chunks:
            return
        vectors = np.asarray(embeddings, dtype=np.float32)
        rows = [
            (c.id, c.text, c.source, c.page, c.chunk_index, file_hash, vectors[i].tobytes())
            for i, c in enumerate(chunks)
        ]
        with self._lock, self._db:
            self._db.executemany("INSERT OR REPLACE INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
            self._matrix = None

    def delete_source(self, source: str) -> None:
        with self._lock, self._db:
            self._db.execute("DELETE FROM chunks WHERE source = ?", (source,))
            self._matrix = None

    # ── reads ──────────────────────────────────────────────────────────────
    def count(self) -> int:
        with self._lock:
            return int(self._db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0])

    def all_chunks(self) -> list[Chunk]:
        with self._lock:
            rows = self._db.execute("SELECT id, text, source, page, chunk_index FROM chunks ORDER BY rowid").fetchall()
        return [Chunk(*r) for r in rows]

    def indexed_sources(self) -> dict[str, str]:
        """Map of source file → file hash currently stored in the index."""
        with self._lock:
            return dict(self._db.execute("SELECT DISTINCT source, file_hash FROM chunks").fetchall())

    def query(self, embedding: np.ndarray, k: int) -> list[tuple[Chunk, float]]:
        """Nearest neighbours as (chunk, cosine similarity)."""
        chunks, matrix = self._search_matrix()
        if not chunks or k <= 0:
            return []
        q = np.asarray(embedding, dtype=np.float32).ravel()
        q = q / (np.linalg.norm(q) or 1.0)
        sims = matrix @ q
        top = np.argsort(-sims, kind="stable")[: min(k, len(chunks))]
        return [(chunks[i], float(sims[i])) for i in top]

    def embeddings_for(self, ids: list[str]) -> dict[str, np.ndarray]:
        if not ids:
            return {}
        marks = ",".join("?" * len(ids))
        with self._lock:
            rows = self._db.execute(f"SELECT id, embedding FROM chunks WHERE id IN ({marks})", ids).fetchall()  # noqa: S608
        return {i: np.frombuffer(blob, dtype=np.float32).copy() for i, blob in rows}

    # ── internals ──────────────────────────────────────────────────────────
    def _search_matrix(self) -> tuple[list[Chunk], np.ndarray]:
        with self._lock:
            if self._matrix is None:
                rows = self._db.execute(
                    "SELECT id, text, source, page, chunk_index, embedding FROM chunks ORDER BY rowid"
                ).fetchall()
                chunks = [Chunk(*r[:5]) for r in rows]
                if rows:
                    m = np.stack([np.frombuffer(r[5], dtype=np.float32) for r in rows])
                    m = m / np.clip(np.linalg.norm(m, axis=1, keepdims=True), 1e-12, None)
                else:
                    m = np.zeros((0, 0), dtype=np.float32)
                self._matrix = (chunks, m)
            return self._matrix
