"""One small database layer for every store: SQLite locally, Postgres (e.g. Neon) when DATABASE_URL is set.

Serverless hosts (Vercel) give each instance its own throwaway /tmp, so anything saved there disappears on
the next cold start or redeploy and is invisible to other instances. With DATABASE_URL set, all stores
share one Postgres database instead; locally (and in tests) each store keeps its own SQLite file.

Stores write portable SQL with `?` placeholders and `{name}` table placeholders. On Postgres every table
is prefixed with the store's namespace ("evolve_docs", "keeper_entries"), so stores never collide.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import threading
from collections.abc import Iterator, Sequence
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger(__name__)

# Type words that differ between the two dialects, used as {real} / {blob} in schemas.
_TYPES = {
    "sqlite": {"real": "REAL", "blob": "BLOB"},
    "postgres": {"real": "DOUBLE PRECISION", "blob": "BYTEA"},
}
_PLACEHOLDER = re.compile(r"\{(\w+)\}")


class Result(Protocol):
    rowcount: int

    def fetchone(self) -> Any: ...
    def fetchall(self) -> list[Any]: ...


class Conn:
    """What a store sees inside `db.tx()`: `execute(sql, params)` with `?` placeholders; rows behave like dicts."""

    def __init__(self, raw: Any, db: Database) -> None:
        self._raw = raw
        self._db = db

    def execute(self, sql: str, params: Sequence[Any] = ()) -> Result:
        return self._raw.execute(self._db.sql(sql), tuple(params))


class Database:
    def __init__(self, namespace: str, *, sqlite_path: Path | None = None, url: str | None = None) -> None:
        if not namespace.isidentifier():
            raise ValueError(f"Invalid namespace: {namespace!r}")
        self.namespace = namespace
        self.dialect = "postgres" if url else "sqlite"
        self._url = url
        self._path = sqlite_path
        self._lock = threading.RLock()
        if self.dialect == "sqlite":
            if sqlite_path is None:
                raise ValueError("sqlite_path is required without a database URL")
            sqlite_path.parent.mkdir(parents=True, exist_ok=True)

    # ── SQL helpers ────────────────────────────────────────────────────────
    def name(self, table: str) -> str:
        return f"{self.namespace}_{table}" if self.dialect == "postgres" else table

    def sql(self, text: str) -> str:
        """Resolve {table} / {real} / {blob} placeholders and, for Postgres, `?` → `%s`."""
        types = _TYPES[self.dialect]
        text = _PLACEHOLDER.sub(lambda m: types.get(m[1]) or self.name(m[1]), text)
        if self.dialect == "postgres":
            text = text.replace("%", "%%").replace("?", "%s")
        return text

    def migrate(self, statements: Sequence[str]) -> None:
        with self.tx() as c:
            for stmt in statements:
                c.execute(stmt)
            if self.dialect == "sqlite":
                c.execute("PRAGMA journal_mode=WAL")

    # ── connections ────────────────────────────────────────────────────────
    @contextmanager
    def tx(self) -> Iterator[Conn]:
        """One transaction: commits on success, rolls back on error."""
        if self.dialect == "sqlite":
            with self._lock, closing(sqlite3.connect(self._path, timeout=10)) as raw:  # type: ignore[arg-type]
                raw.row_factory = sqlite3.Row
                with raw:
                    yield Conn(raw, self)
            return
        with _pg_lock(self._url):  # type: ignore[arg-type]
            raw = _pg_connection(self._url)  # type: ignore[arg-type]
            try:
                with raw.transaction():
                    yield Conn(raw, self)
            except Exception:
                if raw.broken:
                    _drop_pg(self._url)  # type: ignore[arg-type]
                raise


# ── shared Postgres connections (one per URL per process) ──────────────────
_pg: dict[str, Any] = {}
_pg_locks: dict[str, threading.RLock] = {}
_registry_lock = threading.Lock()


def _pg_lock(url: str) -> threading.RLock:
    with _registry_lock:
        return _pg_locks.setdefault(url, threading.RLock())


def _pg_connection(url: str) -> Any:
    import psycopg
    from psycopg.rows import dict_row

    conn = _pg.get(url)
    if conn is None or conn.closed or conn.broken:
        # prepare_threshold=None: Neon's pooled endpoint (PgBouncer, transaction mode) can't keep prepared statements.
        conn = psycopg.connect(url, row_factory=dict_row, prepare_threshold=None, connect_timeout=15, autocommit=True)
        _pg[url] = conn
        logger.info("Connected to Postgres")
    return conn


def _drop_pg(url: str) -> None:
    conn = _pg.pop(url, None)
    if conn is not None:
        try:
            conn.close()
        except Exception:  # noqa: BLE001, S110 - already broken
            pass


def open_db(namespace: str, sqlite_path: Path, url: str | None) -> Database:
    return Database(namespace, sqlite_path=None if url else sqlite_path, url=url or None)
