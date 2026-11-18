"""Tiny document store: JSON documents grouped in collections, plus binary blobs.

Each product keeps its records here (applications, meetings, repos, flows, trips). Locally that's one SQLite
file per product; with DATABASE_URL set it's a pair of tables per product in the shared Postgres database
(see appcore.db). Parameterised SQL only. Documents are plain dicts; validation happens in the product's
Pydantic models before anything is written.
"""

from __future__ import annotations

import datetime as dt
import json
import uuid
from pathlib import Path
from typing import Any

from appcore.db import Database, open_db

_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS {docs} (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        parent TEXT,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, id)
    )""",
    "CREATE INDEX IF NOT EXISTS {ix_docs_parent} ON {docs}(collection, parent)",
    "CREATE TABLE IF NOT EXISTS {blobs} (key TEXT PRIMARY KEY, data {blob} NOT NULL, updated_at TEXT NOT NULL)",
)


def now_iso() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


class DocStore:
    def __init__(self, path: Path, url: str | None = None) -> None:
        """`path` is the local SQLite file; its stem ("evolve") names the store's tables in Postgres."""
        self.db: Database = open_db(path.stem, path, url)
        self.db.migrate(_SCHEMA)

    @staticmethod
    def _doc(r: Any) -> dict[str, Any]:
        return {**json.loads(r["data"]), "id": r["id"], "created_at": r["created_at"], "updated_at": r["updated_at"]}

    def put(
        self, collection: str, data: dict[str, Any], *, id: str | None = None, parent: str | None = None
    ) -> dict[str, Any]:
        """Insert or replace a document; returns it with id and timestamps."""
        doc_id = id or data.get("id") or new_id()
        body = {k: v for k, v in data.items() if k not in ("id", "created_at", "updated_at")}
        now = now_iso()
        with self.db.tx() as c:
            c.execute(
                "INSERT INTO {docs}(collection, id, parent, data, created_at, updated_at) VALUES(?,?,?,?,?,?) "
                "ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, parent = excluded.parent, "
                "updated_at = excluded.updated_at",
                (collection, doc_id, parent, json.dumps(body, ensure_ascii=False, default=str), now, now),
            )
        return self.get(collection, doc_id)  # type: ignore[return-value]

    def get(self, collection: str, doc_id: str) -> dict[str, Any] | None:
        with self.db.tx() as c:
            r = c.execute("SELECT * FROM {docs} WHERE collection = ? AND id = ?", (collection, doc_id)).fetchone()
        return self._doc(r) if r else None

    def patch(self, collection: str, doc_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
        current = self.get(collection, doc_id)
        if current is None:
            return None
        parent = self.parent_of(collection, doc_id)
        return self.put(collection, {**current, **changes}, id=doc_id, parent=parent)

    def parent_of(self, collection: str, doc_id: str) -> str | None:
        with self.db.tx() as c:
            r = c.execute("SELECT parent FROM {docs} WHERE collection = ? AND id = ?", (collection, doc_id)).fetchone()
        return r["parent"] if r else None

    def list(self, collection: str, *, parent: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
        sql, args = "SELECT * FROM {docs} WHERE collection = ?", [collection]
        if parent is not None:
            sql += " AND parent = ?"
            args.append(parent)
        sql += " ORDER BY updated_at DESC LIMIT ?"
        args.append(limit)
        with self.db.tx() as c:
            return [self._doc(r) for r in c.execute(sql, args).fetchall()]

    def delete(self, collection: str, doc_id: str) -> bool:
        with self.db.tx() as c:
            n = c.execute("DELETE FROM {docs} WHERE collection = ? AND id = ?", (collection, doc_id)).rowcount
            c.execute("DELETE FROM {docs} WHERE parent = ? AND collection != ?", (doc_id, collection))  # children
        return n > 0

    # ── blobs (binary payloads such as search indexes) ─────────────────────
    def put_blob(self, key: str, data: bytes) -> None:
        with self.db.tx() as c:
            c.execute(
                "INSERT INTO {blobs}(key, data, updated_at) VALUES(?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
                (key, data, now_iso()),
            )

    def get_blob(self, key: str) -> bytes | None:
        with self.db.tx() as c:
            r = c.execute("SELECT data FROM {blobs} WHERE key = ?", (key,)).fetchone()
        return bytes(r["data"]) if r else None

    def delete_blob(self, key: str) -> None:
        with self.db.tx() as c:
            c.execute("DELETE FROM {blobs} WHERE key = ?", (key,))
