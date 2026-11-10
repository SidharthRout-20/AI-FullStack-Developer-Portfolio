"""Tiny document store on SQLite: JSON documents grouped in collections.

Each product keeps its records here (applications, meetings, repos, flows, trips). One file per product,
WAL mode, parameterised SQL only. Documents are plain dicts; validation happens in the product's
Pydantic models before anything is written.
"""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
import threading
import uuid
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS docs (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    parent TEXT,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS ix_docs_parent ON docs(collection, parent);
"""


def now_iso() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


class DocStore:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._path = path
        self._lock = threading.Lock()
        with self._conn() as c:
            c.executescript(_SCHEMA)
            c.execute("PRAGMA journal_mode=WAL")

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        with self._lock, closing(sqlite3.connect(self._path, timeout=10)) as conn:
            conn.row_factory = sqlite3.Row
            with conn:
                yield conn

    @staticmethod
    def _doc(r: sqlite3.Row) -> dict[str, Any]:
        return {**json.loads(r["data"]), "id": r["id"], "created_at": r["created_at"], "updated_at": r["updated_at"]}

    def put(
        self, collection: str, data: dict[str, Any], *, id: str | None = None, parent: str | None = None
    ) -> dict[str, Any]:
        """Insert or replace a document; returns it with id and timestamps."""
        doc_id = id or data.get("id") or new_id()
        body = {k: v for k, v in data.items() if k not in ("id", "created_at", "updated_at")}
        now = now_iso()
        with self._conn() as c:
            c.execute(
                "INSERT INTO docs(collection, id, parent, data, created_at, updated_at) VALUES(?,?,?,?,?,?) "
                "ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, parent = excluded.parent, "
                "updated_at = excluded.updated_at",
                (collection, doc_id, parent, json.dumps(body, ensure_ascii=False, default=str), now, now),
            )
        return self.get(collection, doc_id)  # type: ignore[return-value]

    def get(self, collection: str, doc_id: str) -> dict[str, Any] | None:
        with self._conn() as c:
            r = c.execute("SELECT * FROM docs WHERE collection = ? AND id = ?", (collection, doc_id)).fetchone()
        return self._doc(r) if r else None

    def patch(self, collection: str, doc_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
        current = self.get(collection, doc_id)
        if current is None:
            return None
        parent = self.parent_of(collection, doc_id)
        return self.put(collection, {**current, **changes}, id=doc_id, parent=parent)

    def parent_of(self, collection: str, doc_id: str) -> str | None:
        with self._conn() as c:
            r = c.execute("SELECT parent FROM docs WHERE collection = ? AND id = ?", (collection, doc_id)).fetchone()
        return r["parent"] if r else None

    def list(self, collection: str, *, parent: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
        sql, args = "SELECT * FROM docs WHERE collection = ?", [collection]
        if parent is not None:
            sql += " AND parent = ?"
            args.append(parent)
        sql += " ORDER BY updated_at DESC LIMIT ?"
        args.append(limit)
        with self._conn() as c:
            return [self._doc(r) for r in c.execute(sql, args).fetchall()]

    def delete(self, collection: str, doc_id: str) -> bool:
        with self._conn() as c:
            n = c.execute("DELETE FROM docs WHERE collection = ? AND id = ?", (collection, doc_id)).rowcount
            c.execute("DELETE FROM docs WHERE parent = ? AND collection != ?", (doc_id, collection))  # children
        return n > 0
