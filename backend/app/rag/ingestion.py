"""Incremental ingestion pipeline: load → chunk → embed → upsert.

Each file's SHA-256 is stored alongside its chunks. On re-ingest we only touch
files whose hash changed, and we remove chunks for files that were deleted —
so re-indexing is idempotent and cheap.

Run manually with:  python -m app.rag.ingestion
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.config import Settings
from app.rag.embeddings import Embedder
from app.rag.loaders import LoadedFile, discover_files, file_sha256, load_file
from app.rag.redact import REDACTION_VERSION, redact_clients
from app.rag.vectorstore import Chunk, VectorStore

logger = logging.getLogger(__name__)


@dataclass
class IngestReport:
    added: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)  # unreadable files; their previous chunks are kept
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
        for piece in splitter.split_text(redact_clients(page.text)):  # client names never enter the index
            # Deterministic id → re-ingesting the same content is a no-op upsert.
            digest = hashlib.sha256(f"{loaded.source}|{page.page}|{idx}|{piece}".encode()).hexdigest()
            chunks.append(Chunk(id=digest[:24], text=piece, source=loaded.source, page=page.page, chunk_index=idx))
            idx += 1
    return chunks


def _textless_path(settings: Settings) -> Path:
    return settings.data_dir / "textless_sources.json"


def _load_textless(settings: Settings) -> dict[str, str]:
    """Files that parsed to no text (empty, or scanned/image-only PDFs) → their hash.

    They have no chunks in the vector store, so without this record they would be re-parsed
    (and reported as "added") on every ingest.
    """
    try:
        data = json.loads(_textless_path(settings).read_text(encoding="utf-8"))
        return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_textless(settings: Settings, textless: dict[str, str]) -> None:
    path = _textless_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(textless, indent=1, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def index_hash(path: Path) -> str:
    """The file's content plus the redaction rules it was indexed with: changing either re-indexes the file."""
    return f"{file_sha256(path)}+{REDACTION_VERSION}"


def ingest(settings: Settings, store: VectorStore, embedder: Embedder) -> IngestReport:
    report = IngestReport()
    indexed = store.indexed_sources()
    textless = _load_textless(settings)
    textless_before = dict(textless)
    files = discover_files(settings.documents_dir, settings.max_file_mb)
    seen: set[str] = set()

    for path in files:
        source = path.relative_to(settings.documents_dir.resolve()).as_posix()
        seen.add(source)
        previous_hash = indexed.get(source) or textless.get(source)

        try:
            # Hash first (cheap) — only parse files whose content actually changed.
            current_hash = index_hash(path)
            if previous_hash == current_hash:
                report.unchanged.append(source)
                continue
            # Parse and embed *before* touching the index: if either fails, the old chunks stay searchable.
            loaded = load_file(path, settings.documents_dir)
            chunks = chunk_file(loaded, settings)
            vectors = embedder.embed_documents([c.text for c in chunks]) if chunks else None
        except Exception:  # noqa: BLE001 - one corrupt/locked file must not stop the whole ingest
            logger.exception("Could not index %s; keeping its previous version (if any)", source)
            report.failed.append(source)
            continue

        if source in indexed:
            store.delete_source(source)
        (report.updated if previous_hash is not None else report.added).append(source)

        if chunks:
            store.upsert(chunks, vectors, current_hash)
            textless.pop(source, None)
            report.chunks_written += len(chunks)
        else:
            textless[source] = current_hash
            logger.warning("%s contains no extractable text (empty or scanned?); nothing indexed", source)
        logger.info("Indexed %s -> %d chunks", source, len(chunks))

    for stale in sorted((set(indexed) | set(textless)) - seen):
        if stale in indexed:
            store.delete_source(stale)
        textless.pop(stale, None)
        report.removed.append(stale)
        logger.info("Removed stale source %s", stale)

    if textless != textless_before:
        _save_textless(settings, textless)
    return report


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    from app.config import get_settings
    from appcore.logs import configure_logging

    configure_logging("INFO")
    from appcore.tls import use_system_certificates

    use_system_certificates()
    s = get_settings()
    r = ingest(s, VectorStore(s), Embedder(s))
    print(
        f"added={r.added} updated={r.updated} removed={r.removed} failed={r.failed} "
        f"unchanged={len(r.unchanged)} chunks_written={r.chunks_written}"
    )
