"""EFI persistence on the existing database layer (app.core.db): `efi.*` tables in Neon Postgres, or a local
`efi.sqlite3` file. Additive only: three new tables, nothing existing is touched.

Every read and write takes the server-derived `owner` and filters on it in SQL (`WHERE owner = ? AND id = ?`), so a
wrong owner simply finds nothing (the API answers 404). Raw artifacts (already redacted) expire after the retention
period; the investigation report (evidence snippets, hypotheses, feedback) stays until the owner deletes it.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import uuid
from pathlib import Path
from typing import Any

from app.core.db import open_db

logger = logging.getLogger(__name__)

_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS {investigations} (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        artifacts_expire_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS {ix_investigations_owner} ON {investigations}(owner, updated_at)",
    """CREATE TABLE IF NOT EXISTS {artifacts} (
        id TEXT NOT NULL,
        investigation_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        content TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (investigation_id, id)
    )""",
    "CREATE INDEX IF NOT EXISTS {ix_artifacts_owner} ON {artifacts}(owner, investigation_id)",
    "CREATE INDEX IF NOT EXISTS {ix_artifacts_expiry} ON {artifacts}(expires_at)",
    """CREATE TABLE IF NOT EXISTS {usage_log} (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        investigation_id TEXT NOT NULL,
        model TEXT NOT NULL,
        calls INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        estimated INTEGER NOT NULL,
        ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS {ix_usage_log_created} ON {usage_log}(created_at)",
)


class ConflictError(RuntimeError):
    """The investigation changed since it was read (optimistic concurrency)."""


def now() -> dt.datetime:
    return dt.datetime.now(dt.UTC).replace(microsecond=0)


def iso(t: dt.datetime) -> str:
    return t.isoformat()


class EFIStore:
    def __init__(self, data_dir: Path, url: str | None) -> None:
        self.db = open_db("efi", data_dir / "efi.sqlite3", url)
        self.db.migrate(_SCHEMA)
        self._upgrade_artifact_key()

    def _upgrade_artifact_key(self) -> None:
        """Artifact IDs ("A1", "A2", …) are per investigation, so the key must be (investigation_id, id). Early
        databases keyed on `id` alone, which made the second investigation collide. Rebuild such a table in place,
        keeping every row (idempotent; a no-op once upgraded)."""
        with self.db.tx() as c:
            if self.db.dialect == "postgres":
                c.execute("SELECT pg_advisory_xact_lock(hashtext(?))", ("efi:artifacts-key",))
                cols = [
                    r["attname"]
                    for r in c.execute(
                        "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid "
                        "AND a.attnum = ANY(i.indkey) WHERE i.indrelid = to_regclass(?) AND i.indisprimary",
                        (self.db.sql("{artifacts}"),),
                    ).fetchall()
                ]
                if cols == ["id"]:
                    name = c.execute(
                        "SELECT conname FROM pg_constraint WHERE conrelid = to_regclass(?) AND contype = 'p'",
                        (self.db.sql("{artifacts}"),),
                    ).fetchone()["conname"]
                    c.execute(
                        f'ALTER TABLE {{artifacts}} DROP CONSTRAINT "{name}", ADD PRIMARY KEY (investigation_id, id)'
                    )
                    logger.info("EFI: upgraded artifacts primary key to (investigation_id, id)")
                return
            pk = [
                r["name"]
                for r in sorted(c.execute("PRAGMA table_info({artifacts})").fetchall(), key=lambda r: r["pk"])
                if r["pk"]
            ]
            if pk == ["id"]:
                c.execute("ALTER TABLE {artifacts} RENAME TO artifacts_v1")
                c.execute("DROP INDEX IF EXISTS {ix_artifacts_owner}")
                c.execute("DROP INDEX IF EXISTS {ix_artifacts_expiry}")
                for stmt in _SCHEMA[2:5]:  # the artifacts table and its two indexes
                    c.execute(stmt)
                c.execute(
                    "INSERT INTO {artifacts} SELECT id, investigation_id, owner, name, kind, size, sha256, content, "
                    "expires_at, created_at FROM artifacts_v1"
                )
                c.execute("DROP TABLE artifacts_v1")
                logger.info("EFI: upgraded artifacts primary key to (investigation_id, id)")

    # ── investigations ────────────────────────────────────────────────────
    def create(
        self,
        owner: str,
        title: str,
        status: str,
        data: dict[str, Any],
        artifacts: list[dict[str, Any]],
        retention_days: int,
    ) -> dict[str, Any]:
        inv_id = uuid.uuid4().hex
        t = now()
        expires = iso(t + dt.timedelta(days=retention_days))
        with self.db.tx() as c:
            c.execute(
                "INSERT INTO {investigations}(id, owner, title, status, data, artifacts_expire_at, version, "
                "created_at, "
                "updated_at) VALUES(?,?,?,?,?,?,1,?,?)",
                (inv_id, owner, title, status, json.dumps(data, ensure_ascii=False), expires, iso(t), iso(t)),
            )
            for a in artifacts:
                c.execute(
                    "INSERT INTO {artifacts}(id, investigation_id, owner, name, kind, size, sha256, content, "
                    "expires_at, "
                    "created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (
                        a["id"],
                        inv_id,
                        owner,
                        a["name"],
                        a["kind"],
                        a["size"],
                        a["sha256"],
                        a["content"],
                        expires,
                        iso(t),
                    ),
                )
        return self.get(owner, inv_id)  # type: ignore[return-value]

    def get(self, owner: str, inv_id: str) -> dict[str, Any] | None:
        with self.db.tx() as c:
            r = c.execute("SELECT * FROM {investigations} WHERE owner = ? AND id = ?", (owner, inv_id)).fetchone()
        return _row(r) if r else None

    def list(self, owner: str, limit: int = 100) -> list[dict[str, Any]]:
        with self.db.tx() as c:
            rows = c.execute(
                "SELECT * FROM {investigations} WHERE owner = ? ORDER BY updated_at DESC, id LIMIT ?", (owner, limit)
            ).fetchall()
        return [_row(r) for r in rows]

    def update(
        self, owner: str, inv_id: str, version: int, *, status: str | None = None, data: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Compare-and-set on `version`; raises ConflictError if someone else changed it first."""
        sets, args = ["version = version + 1", "updated_at = ?"], [iso(now())]
        if status is not None:
            sets.append("status = ?")
            args.append(status)
        if data is not None:
            sets.append("data = ?")
            args.append(json.dumps(data, ensure_ascii=False))
        with self.db.tx() as c:
            n = c.execute(
                f"UPDATE {{investigations}} SET {', '.join(sets)} WHERE owner = ? AND id = ? AND version = ?",  # noqa: S608 - fixed column list
                (*args, owner, inv_id, version),
            ).rowcount
        if n != 1:
            raise ConflictError(inv_id)
        return self.get(owner, inv_id)  # type: ignore[return-value]

    def delete(self, owner: str, inv_id: str) -> bool:
        with self.db.tx() as c:
            n = c.execute("DELETE FROM {investigations} WHERE owner = ? AND id = ?", (owner, inv_id)).rowcount
            c.execute("DELETE FROM {artifacts} WHERE owner = ? AND investigation_id = ?", (owner, inv_id))
        return n > 0

    # ── raw artifacts (redacted, time-limited) ────────────────────────────
    def artifacts(self, owner: str, inv_id: str) -> list[dict[str, Any]]:
        with self.db.tx() as c:
            rows = c.execute(
                "SELECT id, name, kind, size, sha256, expires_at FROM {artifacts} "
                "WHERE owner = ? AND investigation_id = ? "
                "AND expires_at > ? ORDER BY id",
                (owner, inv_id, iso(now())),
            ).fetchall()
        return [dict(r) for r in rows]

    def artifact_content(self, owner: str, inv_id: str, artifact_id: str) -> str | None:
        with self.db.tx() as c:
            r = c.execute(
                "SELECT content FROM {artifacts} "
                "WHERE owner = ? AND investigation_id = ? AND id = ? AND expires_at > ?",
                (owner, inv_id, artifact_id, iso(now())),
            ).fetchone()
        return r["content"] if r else None

    def purge_expired(self) -> int:
        """Delete raw artifacts past their retention date (reports are kept)."""
        with self.db.tx() as c:
            return c.execute("DELETE FROM {artifacts} WHERE expires_at <= ?", (iso(now()),)).rowcount

    # ── usage (no prompt contents) ────────────────────────────────────────
    def record_usage(self, owner: str, inv_id: str, meta: dict[str, Any], status: str) -> None:
        with self.db.tx() as c:
            c.execute(
                "INSERT INTO {usage_log}(id, owner, investigation_id, model, calls, input_tokens, output_tokens, "
                "estimated, ms, "
                "status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    uuid.uuid4().hex,
                    owner,
                    inv_id,
                    meta.get("model", ""),
                    int(meta.get("calls", 0)),
                    int(meta.get("input_tokens", 0)),
                    int(meta.get("output_tokens", 0)),
                    int(bool(meta.get("estimated_tokens"))),
                    int(meta.get("ms", 0)),
                    status,
                    iso(now()),
                ),
            )

    def analyses_since(self, since: dt.datetime, owner: str | None = None) -> int:
        sql, args = "SELECT COUNT(*) AS n FROM {usage_log} WHERE created_at >= ?", [iso(since)]
        if owner is not None:
            sql += " AND owner = ?"
            args.append(owner)
        with self.db.tx() as c:
            return int(c.execute(sql, args).fetchone()["n"])


def _row(r: Any) -> dict[str, Any]:
    d = dict(r)
    d["data"] = json.loads(d["data"])
    return d
