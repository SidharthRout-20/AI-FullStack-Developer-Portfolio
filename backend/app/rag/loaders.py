"""Document loading: turn files on disk into page-level text records.

Security notes
--------------
* Only files *inside* the configured documents directory are read
  (resolved-path check defeats `../` tricks and symlinks pointing outside).
* Only an allow-list of extensions is parsed; everything else is ignored.
* Files above `max_file_mb` are skipped to avoid memory exhaustion.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from pathlib import Path

from pypdf import PdfReader

logger = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = {".pdf", ".md", ".txt"}


@dataclass(frozen=True)
class Page:
    text: str
    source: str  # file name relative to the documents dir
    page: int  # 1-based page number (always 1 for text files)


@dataclass
class LoadedFile:
    source: str
    file_hash: str
    pages: list[Page] = field(default_factory=list)


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 16), b""):
            h.update(block)
    return h.hexdigest()


def discover_files(documents_dir: Path, max_file_mb: int) -> list[Path]:
    """Return supported files that live safely inside `documents_dir`."""
    root = documents_dir.resolve()
    if not root.is_dir():
        logger.warning("Documents directory %s does not exist", root)
        return []

    files: list[Path] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue
        resolved = path.resolve()
        if not resolved.is_relative_to(root):
            logger.warning("Skipping %s: resolves outside documents dir", path)
            continue
        if resolved.stat().st_size > max_file_mb * 1024 * 1024:
            logger.warning("Skipping %s: larger than %d MB", path, max_file_mb)
            continue
        files.append(resolved)
    return files


def load_file(path: Path, documents_dir: Path) -> LoadedFile:
    source = path.relative_to(documents_dir.resolve()).as_posix()
    loaded = LoadedFile(source=source, file_hash=file_sha256(path))

    if path.suffix.lower() == ".pdf":
        reader = PdfReader(str(path))
        for i, pdf_page in enumerate(reader.pages, start=1):
            text = (pdf_page.extract_text() or "").strip()
            if text:
                loaded.pages.append(Page(text=text, source=source, page=i))
    else:
        text = path.read_text(encoding="utf-8", errors="replace").strip()
        if text:
            loaded.pages.append(Page(text=text, source=source, page=1))

    return loaded
