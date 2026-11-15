"""Copy the local SQLite stores into Postgres (Neon), table for table.

Each SQLite file becomes the Postgres schema of the same name with the same tables and columns, exactly the
layout the app uses in production (see app/core/db.py):

    backend/data/evolve.sqlite3          -> schema "evolve"   (docs, blobs)
    backend/data/keeper/keeper.sqlite3   -> schema "keeper"   (entries, meta, photos)
    backend/data/vectors/vectors.sqlite3 -> schema "vectors"  (chunks)

Rows that already exist in Postgres (same primary key) are kept unless you pass --overwrite. Safe to re-run.

    cd backend
    python scripts/sqlite_to_postgres.py --url "postgresql://...neon.tech/neondb?sslmode=require"
    python scripts/sqlite_to_postgres.py --dry-run          # only list what would be copied

Without --url the database comes from DATABASE_URL (or any Neon variable) in the environment / .env file.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from collections.abc import Sequence
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import _pg_url, get_settings  # noqa: E402
from app.core import docstore  # noqa: E402
from app.core.db import Database  # noqa: E402
from app.keeper import store as keeper_store  # noqa: E402
from app.rag import vectorstore  # noqa: E402

# Which schema (CREATE TABLE statements) each store uses; every other *.sqlite3 file is a product DocStore.
SCHEMAS: dict[str, Sequence[str]] = {"keeper": keeper_store._SCHEMA, "vectors": vectorstore._SCHEMA}
BATCH = 500


def find_stores(data_dir: Path) -> list[Path]:
    files = [*sorted(data_dir.glob("*.sqlite3")), data_dir / "keeper" / "keeper.sqlite3"]
    files.append(data_dir / "vectors" / "vectors.sqlite3")
    return [f for f in files if f.is_file()]


def copy_store(path: Path, url: str, *, overwrite: bool, dry_run: bool) -> int:
    namespace = path.stem
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as src:
        listing = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        tables = [r[0] for r in src.execute(listing)]
        if dry_run:
            for t in tables:
                n = src.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]  # noqa: S608 - name from sqlite_master
                print(f"  {namespace}.{t}: {n} row(s)")
            return 0

        db = Database(namespace, url=url)
        db.migrate(SCHEMAS.get(namespace, docstore._SCHEMA))  # same DDL the app runs at startup
        copied = 0
        for table in tables:
            info = src.execute(f'PRAGMA table_info("{table}")').fetchall()  # (cid, name, type, notnull, dflt, pk)
            cols = [c[1] for c in info]
            keys = [c[1] for c in sorted(info, key=lambda c: c[5]) if c[5]]
            others = [c for c in cols if c not in keys]
            conflict = f"ON CONFLICT ({', '.join(keys)}) " if keys else ""
            if conflict:
                updates = ", ".join(f"{c} = excluded.{c}" for c in others)
                conflict += f"DO UPDATE SET {updates}" if overwrite and others else "DO NOTHING"
            sql = (
                f"INSERT INTO {{{table}}} ({', '.join(cols)}) "  # noqa: S608 - names from the SQLite schema
                f"VALUES ({', '.join('?' * len(cols))}) {conflict}"
            )
            rows = src.execute(f'SELECT {", ".join(cols)} FROM "{table}"').fetchall()  # noqa: S608
            for i in range(0, len(rows), BATCH):
                with db.tx() as c:
                    c.executemany(sql, rows[i : i + BATCH])
            with db.tx() as c:
                total = c.execute(f"SELECT COUNT(*) AS n FROM {{{table}}}").fetchone()["n"]  # noqa: S608
            print(f"  {namespace}.{table}: {len(rows)} row(s) from SQLite -> {total} row(s) in Postgres")
            copied += len(rows)
        return copied


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", help="Postgres connection string (default: DATABASE_URL / Neon variables)")
    parser.add_argument("--data-dir", type=Path, help="Folder with the SQLite files (default: backend/data)")
    parser.add_argument("--overwrite", action="store_true", help="Replace rows that already exist in Postgres")
    parser.add_argument("--dry-run", action="store_true", help="Only list the tables and row counts to copy")
    args = parser.parse_args()

    settings = get_settings()
    url = _pg_url(args.url) if args.url else settings.db_url
    if not url and not args.dry_run:
        parser.error("no Postgres URL: pass --url or set DATABASE_URL")
    data_dir = args.data_dir or settings.data_dir
    stores = find_stores(data_dir)
    if not stores:
        print(f"No SQLite stores found in {data_dir}")
        return 1
    total = 0
    for path in stores:
        print(f'{path.relative_to(data_dir)} -> schema "{path.stem}"')
        total += copy_store(path, url or "", overwrite=args.overwrite, dry_run=args.dry_run)
    if not args.dry_run:
        print(f"Done: {total} row(s) copied from {len(stores)} store(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
