"""One small database layer for every store: SQLite locally, Postgres (e.g. Neon) when DATABASE_URL is set.

Serverless hosts (Vercel) give each instance its own throwaway /tmp, so anything saved there disappears on
the next cold start or redeploy and is invisible to other instances. With DATABASE_URL set, all stores
share one Postgres database instead; locally (and in tests) each store keeps its own SQLite file.

The Postgres layout mirrors SQLite one to one: each SQLite file (`keeper.sqlite3`, `evolve.sqlite3`, ...) is a
Postgres *schema* of the same name, holding the same tables, columns and indexes (`keeper.entries`,
`evolve.docs`). Every transaction sets `search_path` to the store's schema, so the SQL is identical on both
engines. Only two type words differ, written as {real} / {blob}: REAL → DOUBLE PRECISION (both 8-byte floats)
and BLOB → BYTEA. Stores write portable SQL with `?` placeholders and `{table}` placeholders.
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
_CREATE_TABLE = re.compile(r"CREATE TABLE IF NOT EXISTS \{(\w+)\}", re.I)
_CREATE_INDEX = re.compile(r"CREATE INDEX IF NOT EXISTS \{(\w+)\}", re.I)


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

    def executemany(self, sql: str, rows: Sequence[Sequence[Any]]) -> None:
        """Bulk insert/update (one round trip per batch on Postgres, not per row)."""
        if self._db.dialect == "sqlite":
            self._raw.executemany(self._db.sql(sql), [tuple(r) for r in rows])
            return
        with self._raw.cursor() as cur:
            cur.executemany(self._db.sql(sql), [tuple(r) for r in rows])


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
        """A table's name: the same on both engines (on Postgres it lives in the schema named after the store)."""
        return table

    def sql(self, text: str) -> str:
        """Resolve {table} / {real} / {blob} placeholders and, for Postgres, `?` → `%s`."""
        types = _TYPES[self.dialect]
        text = _PLACEHOLDER.sub(lambda m: types.get(m[1]) or self.name(m[1]), text)
        if self.dialect == "postgres":
            text = text.replace("%", "%%").replace("?", "%s")
        return text

    def migrate(self, statements: Sequence[str]) -> None:
        """Create the store's tables and indexes if missing (idempotent, safe to run on every start)."""
        with self.tx() as c:
            if self.dialect == "postgres":
                # Serialise concurrent cold starts: parallel CREATE ... IF NOT EXISTS can still collide in Postgres.
                c.execute("SELECT pg_advisory_xact_lock(hashtext(?))", (f"schema:{self.namespace}",))
                c.execute(f'CREATE SCHEMA IF NOT EXISTS "{self.namespace}"')
                self._adopt_prefixed_tables(c, statements)
            for stmt in statements:
                c.execute(stmt)
            if self.dialect == "sqlite":
                c.execute("PRAGMA journal_mode=WAL")

    def _adopt_prefixed_tables(self, c: Conn, statements: Sequence[str]) -> None:
        """Move tables from the old layout (public.<store>_<table>) into the store's schema, keeping their rows."""
        for table in _CREATE_TABLE.findall("\n".join(statements)):
            old = f"{self.namespace}_{table}"
            r = c.execute(
                "SELECT to_regclass(?) AS old, to_regclass(?) AS new",
                (f'public."{old}"', f'"{self.namespace}"."{table}"'),
            ).fetchone()
            if r["old"] and not r["new"]:
                c.execute(f'ALTER TABLE public."{old}" SET SCHEMA "{self.namespace}"')
                c.execute(f'ALTER TABLE "{self.namespace}"."{old}" RENAME TO "{table}"')
                logger.info("Moved table public.%s to %s.%s", old, self.namespace, table)
        for index in _CREATE_INDEX.findall("\n".join(statements)):  # indexes moved with their tables; rename them
            old, new = f'"{self.namespace}"."{self.namespace}_{index}"', f'"{self.namespace}"."{index}"'
            r = c.execute("SELECT to_regclass(?) AS old, to_regclass(?) AS new", (old, new)).fetchone()
            if r["old"] and not r["new"]:
                c.execute(f'ALTER INDEX {old} RENAME TO "{index}"')

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
                    # Transaction-scoped, so it is safe on a shared connection and behind PgBouncer.
                    raw.execute(f'SET LOCAL search_path TO "{self.namespace}"')
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


_health: dict[str, tuple[float, bool, str | None]] = {}


def check_postgres(url: str, max_age_s: float = 30.0) -> tuple[bool, str | None]:
    """Round-trip `SELECT 1` on the shared connection (cached for `max_age_s`). Returns (ok, reason). The reason is a
    category only ("authentication failed", "unreachable"…): connection strings and host names are never echoed."""
    import time

    hit = _health.get(url)
    if hit and time.monotonic() - hit[0] < max_age_s:
        return hit[1], hit[2]
    ok, reason = True, None
    try:
        with _pg_lock(url):
            _pg_connection(url).execute("SELECT 1").fetchone()
    except Exception as exc:  # noqa: BLE001 - reported as a health state, never raised
        _drop_pg(url)
        text = str(exc).lower()
        ok = False
        if "password" in text or "authentication" in text:
            reason = "authentication failed (check the database credentials in DATABASE_URL)"
        elif "timeout" in text or "timed out" in text:
            reason = "connection timed out (the database may be suspended or unreachable)"
        elif "could not translate host" in text or "name or service" in text or "nodename" in text:
            reason = "database host not found"
        elif "does not exist" in text:
            reason = "database does not exist"
        elif "ssl" in text:
            reason = "TLS/SSL negotiation failed"
        else:
            reason = f"connection failed ({type(exc).__name__})"
    _health[url] = (time.monotonic(), ok, reason)
    return ok, reason
