"""Keeper storage: entries, settings and photos in one database (local SQLite file, or shared Postgres)."""

from __future__ import annotations

import datetime as dt
import json
import re
import uuid
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from app.keeper.models import Entry, EntryIn
from appcore.db import open_db

_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS {entries} (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        place TEXT, person TEXT, note TEXT, photo_id TEXT,
        lat {real}, lng {real},
        due TEXT, due_time TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        data TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS {ix_entries_kind} ON {entries}(kind, status)",
    "CREATE TABLE IF NOT EXISTS {meta} (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS {photos} "
    "(id TEXT PRIMARY KEY, mime TEXT NOT NULL, data {blob} NOT NULL, created_at TEXT NOT NULL)",
)

_COLUMNS = ("title", "place", "person", "note", "photo_id", "lat", "lng", "due", "due_time", "status", "data")
_WORD = re.compile(r"[a-z0-9]+")
_STOP = {"my", "the", "a", "an", "is", "are", "of", "where", "did", "i", "put", "keep", "kept", "find", "to", "me"}

PHOTO_TYPES = {b"\xff\xd8\xff": ("jpg", "image/jpeg"), b"\x89PNG": ("png", "image/png")}
PHOTO_ID = re.compile(r"^[0-9a-f]{32}$")


def _now() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds")


def _words(text: str | None) -> set[str]:
    return {w for w in _WORD.findall((text or "").lower()) if w not in _STOP}


def _stem(w: str) -> str:
    return w[:-1] if len(w) > 3 and w.endswith("s") else w


def relevance(query: str, e: Entry) -> float:
    """Keyword + fuzzy score across title, place, person, notes and photo caption."""
    q = {_stem(w) for w in _words(query)}
    if not q:
        return 0.0
    haystack = " ".join(filter(None, [e.title, e.place, e.person, e.note, e.data.get("caption")]))
    words = {_stem(w) for w in _words(haystack)}
    title = {_stem(w) for w in _words(e.title)}
    exact = len(q & words) / len(q) + 0.5 * len(q & title) / len(q)
    fuzzy = max((SequenceMatcher(None, a, b).ratio() for a in q for b in words), default=0.0)
    return exact + (0.6 * fuzzy if fuzzy >= 0.8 else 0.0)


def image_type(blob: bytes) -> tuple[str, str] | None:
    for magic, kind in PHOTO_TYPES.items():
        if blob.startswith(magic):
            return kind
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return ("webp", "image/webp")
    return None


class KeeperStore:
    def __init__(self, root: Path, url: str | None = None) -> None:
        self.db = open_db("keeper", root / "keeper.sqlite3", url)
        self.db.migrate(_SCHEMA)

    @staticmethod
    def _row(r: Any) -> Entry:
        d = dict(r)
        d["data"] = json.loads(d["data"] or "{}")
        return Entry.model_validate(d)

    # ── CRUD ───────────────────────────────────────────────────────────────
    def add(self, item: EntryIn | dict[str, Any]) -> Entry:
        e = item.model_dump() if isinstance(item, EntryIn) else dict(item)
        now = _now()
        row = {
            "id": uuid.uuid4().hex[:12],
            "kind": e["kind"],
            "title": e["title"],
            **{k: e.get(k) for k in _COLUMNS if k not in ("title", "status", "data")},
            "status": "active",
            "data": json.dumps(e.get("data") or {}),
            "created_at": now,
            "updated_at": now,
        }
        if isinstance(row["due"], dt.date):
            row["due"] = row["due"].isoformat()
        with self.db.tx() as c:
            c.execute(
                # Column names come from the fixed _COLUMNS whitelist; values are always bound parameters.
                f"INSERT INTO {{entries}} ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})",  # noqa: S608
                tuple(row.values()),
            )
        return self.get(row["id"])  # type: ignore[return-value]

    def get(self, entry_id: str) -> Entry | None:
        with self.db.tx() as c:
            r = c.execute("SELECT * FROM {entries} WHERE id = ?", (entry_id,)).fetchone()
        return self._row(r) if r else None

    def update(self, entry_id: str, changes: dict[str, Any]) -> Entry | None:
        sets = {k: v for k, v in changes.items() if k in _COLUMNS}
        if "data" in sets:
            sets["data"] = json.dumps(sets["data"])
        if isinstance(sets.get("due"), dt.date):
            sets["due"] = sets["due"].isoformat()
        if not sets:
            return self.get(entry_id)
        sets["updated_at"] = _now()
        with self.db.tx() as c:
            c.execute(
                f"UPDATE {{entries}} SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?",  # noqa: S608 - whitelisted columns
                (*sets.values(), entry_id),
            )
        return self.get(entry_id)

    def delete(self, entry_id: str) -> bool:
        entry = self.get(entry_id)
        if entry is None:
            return False
        with self.db.tx() as c:
            c.execute("DELETE FROM {entries} WHERE id = ?", (entry_id,))
        if entry.photo_id:
            self.delete_photo(entry.photo_id)
        return True

    def list(self, kind: str | None = None, *, include_done: bool = False) -> list[Entry]:
        sql, args = "SELECT * FROM {entries} WHERE 1=1", []
        if kind:
            sql += " AND kind = ?"
            args.append(kind)
        if not include_done:
            sql += " AND status = 'active'"
        sql += " ORDER BY (due IS NULL), due, due_time, updated_at DESC, title, id"  # fully deterministic
        with self.db.tx() as c:
            return [self._row(r) for r in c.execute(sql, args).fetchall()]

    def search(self, query: str, kind: str | None = None, limit: int = 5) -> list[Entry]:
        scored = [(relevance(query, e), e) for e in self.list(kind)]
        scored = [(s, e) for s, e in scored if s >= 0.5]
        scored.sort(key=lambda t: (t[0], t[1].updated_at), reverse=True)  # best, then newest
        return [e for _, e in scored[:limit]]

    def find_one(self, title: str, kind: str | None = None) -> Entry | None:
        """Exact title match first (case-insensitive), then the best fuzzy match."""
        candidates = self.list(kind)
        for e in candidates:
            if e.title.lower() == title.lower():
                return e
        hits = self.search(title, kind, limit=1)
        return hits[0] if hits else None

    def counts(self) -> dict[str, int]:
        with self.db.tx() as c:
            rows = c.execute("SELECT kind, COUNT(*) n FROM {entries} WHERE status = 'active' GROUP BY kind").fetchall()
        return {r["kind"]: r["n"] for r in rows}

    # ── Meta (small key/value: last timezone seen, last brief sent) ────────
    def get_meta(self, key: str) -> str | None:
        with self.db.tx() as c:
            r = c.execute("SELECT value FROM {meta} WHERE key = ?", (key,)).fetchone()
        return r["value"] if r else None

    def set_meta(self, key: str, value: str) -> None:
        with self.db.tx() as c:
            c.execute(
                "INSERT INTO {meta}(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

    # ── Photos ─────────────────────────────────────────────────────────────
    def save_photo(self, blob: bytes) -> str:
        kind = image_type(blob)
        if kind is None:
            raise ValueError("Only JPEG, PNG or WebP images are accepted.")
        photo_id = uuid.uuid4().hex
        with self.db.tx() as c:
            c.execute(
                "INSERT INTO {photos}(id, mime, data, created_at) VALUES(?,?,?,?)", (photo_id, kind[1], blob, _now())
            )
        return photo_id

    def photo(self, photo_id: str) -> tuple[bytes, str] | None:
        """(image bytes, mime type), or None for an unknown id."""
        if not PHOTO_ID.match(photo_id):
            return None
        with self.db.tx() as c:
            r = c.execute("SELECT data, mime FROM {photos} WHERE id = ?", (photo_id,)).fetchone()
        return (bytes(r["data"]), r["mime"]) if r else None

    def prune_photos(self, older_than_hours: float = 24) -> int:
        """Delete photos no entry references (e.g. a scan that was never saved), once they are a day old."""
        cutoff = (dt.datetime.now(dt.UTC) - dt.timedelta(hours=older_than_hours)).isoformat(timespec="seconds")
        with self.db.tx() as c:
            return c.execute(
                "DELETE FROM {photos} WHERE created_at < ? AND id NOT IN "
                "(SELECT photo_id FROM {entries} WHERE photo_id IS NOT NULL)",
                (cutoff,),
            ).rowcount

    def delete_photo(self, photo_id: str) -> None:
        with self.db.tx() as c:
            c.execute("DELETE FROM {photos} WHERE id = ?", (photo_id,))
