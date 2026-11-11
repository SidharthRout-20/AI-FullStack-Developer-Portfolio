"""A small, persistent vector store: SQLite (or the shared Postgres) for storage, NumPy for exact cosine search.

The corpus is a handful of documents (hundreds of chunks at most), so an exact brute-force search is
both faster than an ANN index at this size and needs no heavy dependency. (ChromaDB was used before;
its dependency tree alone pushed the serverless bundle past Vercel's 500 MB limit.)

We pass our own embeddings (FastEmbed), so the embedding model is explicit, swappable and identical at
index and query time.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass

import numpy as np

from app.config import Settings
from app.core.db import open_db


@dataclass(frozen=True)
class Chunk:
    id: str
    text: str
    source: str
    page: int
    chunk_index: int


_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS {chunks} (
        id          TEXT PRIMARY KEY,
        text        TEXT NOT NULL,
        source      TEXT NOT NULL,
        page        INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        file_hash   TEXT NOT NULL,
        embedding   {blob} NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS {chunks_source} ON {chunks}(source)",
)


class VectorStore:
    def __init__(self, settings: Settings) -> None:
        self._db = open_db("vectors", settings.vector_dir / "vectors.sqlite3", settings.db_url)
        self._db.migrate(_SCHEMA)
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
        with self._lock, self._db.tx() as c:
            for row in rows:
                c.execute(
                    "INSERT INTO {chunks} VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "
                    "text = excluded.text, source = excluded.source, page = excluded.page, "
                    "chunk_index = excluded.chunk_index, file_hash = excluded.file_hash, "
                    "embedding = excluded.embedding",
                    row,
                )
            self._matrix = None

    def delete_source(self, source: str) -> None:
        with self._lock, self._db.tx() as c:
            c.execute("DELETE FROM {chunks} WHERE source = ?", (source,))
            self._matrix = None

    # ── reads ──────────────────────────────────────────────────────────────
    def count(self) -> int:
        with self._lock, self._db.tx() as c:
            return int(c.execute("SELECT COUNT(*) AS n FROM {chunks}").fetchone()["n"])

    def all_chunks(self) -> list[Chunk]:
        with self._lock, self._db.tx() as c:
            rows = c.execute(
                "SELECT id, text, source, page, chunk_index FROM {chunks} ORDER BY source, chunk_index, id"
            ).fetchall()
        return [_chunk(r) for r in rows]

    def indexed_sources(self) -> dict[str, str]:
        """Map of source file → file hash currently stored in the index."""
        with self._lock, self._db.tx() as c:
            return {r["source"]: r["file_hash"] for r in c.execute("SELECT DISTINCT source, file_hash FROM {chunks}")}

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
        with self._lock, self._db.tx() as c:
            rows = c.execute(f"SELECT id, embedding FROM {{chunks}} WHERE id IN ({marks})", ids).fetchall()  # noqa: S608
        return {r["id"]: np.frombuffer(bytes(r["embedding"]), dtype=np.float32).copy() for r in rows}

    # ── internals ──────────────────────────────────────────────────────────
    def _search_matrix(self) -> tuple[list[Chunk], np.ndarray]:
        with self._lock:
            if self._matrix is None:
                with self._db.tx() as c:
                    rows = c.execute(
                        "SELECT id, text, source, page, chunk_index, embedding FROM {chunks} "
                        "ORDER BY source, chunk_index, id"
                    ).fetchall()
                chunks = [_chunk(r) for r in rows]
                if rows:
                    m = np.stack([np.frombuffer(bytes(r["embedding"]), dtype=np.float32) for r in rows])
                    m = m / np.clip(np.linalg.norm(m, axis=1, keepdims=True), 1e-12, None)
                else:
                    m = np.zeros((0, 0), dtype=np.float32)
                self._matrix = (chunks, m)
            return self._matrix


def _chunk(r: object) -> Chunk:
    return Chunk(id=r["id"], text=r["text"], source=r["source"], page=r["page"], chunk_index=r["chunk_index"])  # type: ignore[index]
