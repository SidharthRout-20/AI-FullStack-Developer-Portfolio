"""Incremental ingestion pipeline: load → chunk → embed → upsert.

Each file's SHA-256 is stored alongside its chunks. On re-ingest we only touch
files whose hash changed, and we remove chunks for files that were deleted —
so re-indexing is idempotent and cheap.

Run manually with:  python -m app.rag.ingestion
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field

from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.config import Settings
from app.rag.embeddings import Embedder
from app.rag.loaders import LoadedFile, discover_files, file_sha256, load_file
from app.rag.vectorstore import Chunk, VectorStore

logger = logging.getLogger(__name__)


@dataclass
class IngestReport:
    added: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    chunks_written: int = 0

    @property
    def changed(self) -> bool:
        return bool(self.added or self.updated or self.removed)


def chunk_file(loaded: LoadedFile, settings: Settings) -> list[Chunk]:
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=settings.chunk_size,
        chunk_overlap=settings.chunk_overlap,
        separators=["\n\n", "\n", ". ", " ", ""],
    )
    chunks: list[Chunk] = []
    idx = 0
    for page in loaded.pages:
        for piece in splitter.split_text(page.text):
            # Deterministic id → re-ingesting the same content is a no-op upsert.
            digest = hashlib.sha256(f"{loaded.source}|{page.page}|{idx}|{piece}".encode()).hexdigest()
            chunks.append(Chunk(id=digest[:24], text=piece, source=loaded.source, page=page.page, chunk_index=idx))
            idx += 1
    return chunks


def ingest(settings: Settings, store: VectorStore, embedder: Embedder) -> IngestReport:
    report = IngestReport()
    indexed = store.indexed_sources()
    files = discover_files(settings.documents_dir, settings.max_file_mb)
    seen: set[str] = set()

    for path in files:
        source = path.relative_to(settings.documents_dir.resolve()).as_posix()
        seen.add(source)

        # Hash first (cheap) — only parse files whose content actually changed.
        previous_hash = indexed.get(source)
        if previous_hash == file_sha256(path):
            report.unchanged.append(source)
            continue

        loaded = load_file(path, settings.documents_dir)
        chunks = chunk_file(loaded, settings)
        if previous_hash is not None:
            store.delete_source(loaded.source)
            report.updated.append(loaded.source)
        else:
            report.added.append(loaded.source)

        if chunks:
            vectors = embedder.embed_documents([c.text for c in chunks])
            store.upsert(chunks, vectors, loaded.file_hash)
            report.chunks_written += len(chunks)
        logger.info("Indexed %s -> %d chunks", loaded.source, len(chunks))

    for stale in set(indexed) - seen:
        store.delete_source(stale)
        report.removed.append(stale)
        logger.info("Removed stale source %s", stale)

    return report


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    from app.config import get_settings
    from app.core.logging import configure_logging

    configure_logging("INFO")
    from app.core.tls import use_system_certificates

    use_system_certificates()
    s = get_settings()
    r = ingest(s, VectorStore(s), Embedder(s))
    print(
        f"added={r.added} updated={r.updated} removed={r.removed} "
        f"unchanged={len(r.unchanged)} chunks_written={r.chunks_written}"
    )
