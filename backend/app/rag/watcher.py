"""Keeps the index in sync with the documents folder while the server runs.

Polling (not inotify/ReadDirectoryChanges) so it behaves the same on Windows, macOS, Linux and Docker
volumes. A change is applied only once the folder has been *stable* for one extra tick, so a file that
is still being written or copied is never indexed half-way. Ingestion itself is incremental (SHA-256
per file), so an unchanged file costs nothing.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from app.rag.loaders import discover_files
from app.rag.service import RAGService

logger = logging.getLogger(__name__)

Snapshot = dict[str, tuple[int, int]]  # relative path → (mtime_ns, size)


def snapshot(documents_dir: Path, max_file_mb: int) -> Snapshot:
    out: Snapshot = {}
    for path in discover_files(documents_dir, max_file_mb):
        try:
            st = path.stat()
        except OSError:
            continue
        out[path.relative_to(documents_dir.resolve()).as_posix()] = (st.st_mtime_ns, st.st_size)
    return out


class DocumentWatcher:
    def __init__(self, rag: RAGService) -> None:
        self.rag = rag
        self._seen = snapshot(rag.settings.documents_dir, rag.settings.max_file_mb)
        self._pending: Snapshot | None = None

    # The index version lives on RAGService so manual re-indexes bump it too.
    @property
    def version(self) -> int:
        return self.rag.index_version

    @property
    def last_ingest(self) -> dict[str, Any] | None:
        return self.rag.last_ingest

    def poll(self) -> dict[str, Any] | None:
        """One tick. Returns the ingest report when a stable change was applied, else None."""
        current = snapshot(self.rag.settings.documents_dir, self.rag.settings.max_file_mb)
        if current == self._seen:
            self._pending = None
            return None
        if current != self._pending:  # changed since last tick: wait until it settles
            self._pending = current
            return None
        changed = sorted(k for k in set(current) | set(self._seen) if current.get(k) != self._seen.get(k))
        logger.info("Documents changed on disk: %s", changed)
        report = self.rag.ingest()
        self._seen = current
        self._pending = None
        logger.info(
            "Documents changed → re-indexed: added=%s updated=%s removed=%s failed=%s",
            report.added,
            report.updated,
            report.removed,
            report.failed,
        )
        if not report.changed:
            return None  # e.g. only mtime changed (file touched/re-saved with identical content)
        return self.last_ingest

    async def run(self, interval_s: float) -> None:
        while True:
            await asyncio.sleep(interval_s)
            try:
                await asyncio.to_thread(self.poll)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - keep watching after a bad file
                logger.exception("Document watcher tick failed")
