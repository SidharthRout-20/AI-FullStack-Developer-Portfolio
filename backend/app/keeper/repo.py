"""Tara's read-only view of this portfolio's own source code, so it can answer "how does X work" with real files.

The app's source ships with the backend (see .vercelignore), so it is indexed in place on first use: the same
symbol-aware chunking and identifier-splitting BM25 that CodeLens uses for any GitHub repo, with no embeddings and no
network. Only application code and the README are indexed: no tests, data, lock files, environment files or notes.
Tara never edits anything.
"""

from __future__ import annotations

import os
import re
import threading
from pathlib import Path
from typing import Any

from rank_bm25 import BM25Okapi

from app.products.codelens import chunk_generic, chunk_python, code_tokens

# Where the product code lives, relative to the repository root.
ROOTS = ("backend/app", "frontend/src", "packages", "products")
EXTS = {".py", ".js", ".jsx", ".ts", ".tsx"}
SKIP_DIRS = {"node_modules", "dist", "build", "tests", "test", "__pycache__", ".venv", "venv", "data", "public",
             "coverage", ".pytest_cache", ".ruff_cache"}  # fmt: skip
SKIP_FILE = re.compile(r"(\.test\.|\.spec\.|^test_|_test\.py$|\.min\.|\.d\.ts$)")
MAX_BYTES = 150_000


def _terms(text: str) -> list[str]:
    """CodeLens's code tokens with plurals folded ("tools" finds `tool`, "results" finds `result`)."""
    return [t[:-1] if len(t) > 3 and t.endswith("s") and not t.endswith("ss") else t for t in code_tokens(text)]


class RepoIndex:
    def __init__(self, root: Path) -> None:
        self.root = root
        self._lock = threading.Lock()
        self._chunks: list[dict[str, Any]] | None = None
        self._bm25: BM25Okapi | None = None

    def files(self) -> list[Path]:
        out: list[Path] = []
        readme = self.root / "README.md"
        if readme.is_file():
            out.append(readme)
        for top in ROOTS:
            base = self.root / top
            if not base.is_dir():
                continue
            for dirpath, dirnames, filenames in os.walk(base):
                dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
                for f in sorted(filenames):
                    p = Path(dirpath) / f
                    if p.suffix in EXTS and not SKIP_FILE.search(f) and p.stat().st_size <= MAX_BYTES:
                        out.append(p)
        return out

    def _build(self) -> None:
        chunks: list[dict[str, Any]] = []
        for p in self.files():
            rel = p.relative_to(self.root).as_posix()
            try:
                src = p.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            parts = chunk_python(rel, src) if p.suffix == ".py" else chunk_generic(rel, src)
            chunks.extend(c for c in parts if c["text"].strip())
        self._chunks = chunks
        # The file path and symbol name count three times, so a question lands on the function it names.
        docs = [_terms(f"{(c['path'] + ' ' + (c.get('symbol') or '') + ' ') * 3}{c['text']}") for c in chunks]
        self._bm25 = BM25Okapi(docs) if docs else None

    @property
    def ready(self) -> bool:
        return self._chunks is not None

    def search(self, query: str, k: int = 4, per_file: int = 2) -> list[dict[str, Any]]:
        """The best-matching pieces of code, at most `per_file` from one file, best first."""
        with self._lock:
            if self._chunks is None:
                self._build()
        if not self._bm25 or not self._chunks:
            return []
        terms = _terms(query)
        if not terms:
            return []
        scores = self._bm25.get_scores(terms)
        ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
        out: list[dict[str, Any]] = []
        seen: dict[str, int] = {}
        for i in ranked:
            if scores[i] <= 0 or len(out) >= k:
                break
            c = self._chunks[i]
            if seen.get(c["path"], 0) >= per_file:
                continue
            seen[c["path"]] = seen.get(c["path"], 0) + 1
            out.append({**c, "score": round(float(scores[i]), 2)})
        return out

    def stats(self) -> dict[str, int]:
        with self._lock:
            if self._chunks is None:
                self._build()
        chunks = self._chunks or []
        return {"files": len({c["path"] for c in chunks}), "chunks": len(chunks)}
