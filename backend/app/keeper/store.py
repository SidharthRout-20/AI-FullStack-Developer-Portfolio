"""Local SQLite storage for Keeper (one file, no server) plus photo files on disk."""

from __future__ import annotations

import datetime as dt
import json
import re
import sqlite3
import threading
import uuid
from collections.abc import Iterator
from contextlib import closing, contextmanager
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from app.keeper.models import Entry, EntryIn

_SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    place TEXT, person TEXT, note TEXT, photo_id TEXT,
    lat REAL, lng REAL,
    due TEXT, due_time TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_entries_kind ON entries(kind, status);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

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
    def __init__(self, root: Path) -> None:
        self.root = root
        self.photos = root / "photos"
        self.photos.mkdir(parents=True, exist_ok=True)
        self._db = root / "keeper.sqlite3"
        self._lock = threading.Lock()
        with self._conn() as c:
            c.executescript(_SCHEMA)
            c.execute("PRAGMA journal_mode=WAL")

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        with self._lock, closing(sqlite3.connect(self._db, timeout=10)) as conn:
            conn.row_factory = sqlite3.Row
            with conn:  # commit / rollback
                yield conn

    @staticmethod
    def _row(r: sqlite3.Row) -> Entry:
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
        with self._conn() as c:
            c.execute(
                # Column names come from the fixed _COLUMNS whitelist; values are always bound parameters.
                f"INSERT INTO entries ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})",  # noqa: S608
                tuple(row.values()),
            )
        return self.get(row["id"])  # type: ignore[return-value]

    def get(self, entry_id: str) -> Entry | None:
        with self._conn() as c:
            r = c.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
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
        with self._conn() as c:
            c.execute(
                f"UPDATE entries SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?",  # noqa: S608 - whitelisted columns
                (*sets.values(), entry_id),
            )
        return self.get(entry_id)

    def delete(self, entry_id: str) -> bool:
        entry = self.get(entry_id)
        if entry is None:
            return False
        with self._conn() as c:
            c.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
        if entry.photo_id:
            self.delete_photo(entry.photo_id)
        return True

    def list(self, kind: str | None = None, *, include_done: bool = False) -> list[Entry]:
        sql, args = "SELECT * FROM entries WHERE 1=1", []
        if kind:
            sql += " AND kind = ?"
            args.append(kind)
        if not include_done:
            sql += " AND status = 'active'"
        sql += " ORDER BY (due IS NULL), due, due_time, updated_at DESC"
        with self._conn() as c:
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
        with self._conn() as c:
            rows = c.execute("SELECT kind, COUNT(*) n FROM entries WHERE status = 'active' GROUP BY kind").fetchall()
        return {r["kind"]: r["n"] for r in rows}

    # ── Meta (small key/value: last timezone seen, last brief sent) ────────
    def get_meta(self, key: str) -> str | None:
        with self._conn() as c:
            r = c.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return r["value"] if r else None

    def set_meta(self, key: str, value: str) -> None:
        with self._conn() as c:
            c.execute(
                "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

    # ── Photos ─────────────────────────────────────────────────────────────
    def save_photo(self, blob: bytes) -> str:
        kind = image_type(blob)
        if kind is None:
            raise ValueError("Only JPEG, PNG or WebP images are accepted.")
        photo_id = uuid.uuid4().hex
        (self.photos / f"{photo_id}.{kind[0]}").write_bytes(blob)
        return photo_id

    def photo_path(self, photo_id: str) -> tuple[Path, str] | None:
        if not PHOTO_ID.match(photo_id):  # ids are generated by us: no path traversal possible
            return None
        for ext, mime in (("jpg", "image/jpeg"), ("png", "image/png"), ("webp", "image/webp")):
            p = self.photos / f"{photo_id}.{ext}"
            if p.is_file():
                return p, mime
        return None

    def prune_photos(self, older_than_hours: float = 24) -> int:
        """Delete photos no entry references (e.g. a scan that was never saved), once they are a day old."""
        with self._conn() as c:
            used = {r["photo_id"] for r in c.execute("SELECT photo_id FROM entries WHERE photo_id IS NOT NULL")}
        cutoff = dt.datetime.now().timestamp() - older_than_hours * 3600
        removed = 0
        for f in self.photos.iterdir():
            if f.is_file() and f.stem not in used and f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)
                removed += 1
        return removed

    def delete_photo(self, photo_id: str) -> None:
        if found := self.photo_path(photo_id):
            found[0].unlink(missing_ok=True)
