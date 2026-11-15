"""CodeLens: index a public GitHub repository and answer questions with file-and-line citations.

Pipeline (streamed as SSE progress events):
  download (zip over HTTPS, size-capped, read in memory: no extraction, no zip-slip)
  → filter (text source files only, vendored/build dirs skipped, per-file and file-count caps)
  → chunk  (Python: `ast` functions/classes with exact line ranges; other languages: symbol-boundary regex,
            falling back to 60-line windows)
  → embed  (local FastEmbed, same model as DocuMind) + BM25, fused with Reciprocal Rank Fusion at query time
  → graph  (import edges between files: Python `ast`, JS/TS `import`/`require` relative paths)
"""

from __future__ import annotations

import ast
import asyncio
import io
import json
import logging
import posixpath
import re
import zipfile
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated, Any

import httpx
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from rank_bm25 import BM25Okapi

from app.core.ai import Lenient, ask_json, ask_text, clip, llm_failure, sse
from app.core.docstore import DocStore, new_id
from app.core.security import limiter, rate_limit_value
from app.rag.retriever import reciprocal_rank_fusion, tokenize

logger = logging.getLogger(__name__)

REPO_URL = re.compile(
    r"^https://github\.com/([A-Za-z0-9][\w.-]{0,38})/([\w.-]{1,100}?)(?:\.git)?(?:/tree/([\w./-]{1,100}))?/?$"
)
MAX_ZIP_MB = 40
MAX_FILES = 1500
MAX_FILE_KB = 160
MAX_CHUNKS = 2500
WINDOW_LINES = 60
CODE_EXT = {
    ".py": "python", ".js": "javascript", ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript",
    ".mjs": "javascript", ".go": "go", ".java": "java", ".kt": "kotlin", ".rs": "rust", ".rb": "ruby",
    ".php": "php", ".cs": "csharp", ".cpp": "cpp", ".c": "c", ".h": "c", ".swift": "swift", ".scala": "scala",
    ".md": "markdown", ".toml": "config", ".yaml": "config", ".yml": "config", ".json": "config",
    ".sql": "sql", ".sh": "shell", ".css": "css", ".html": "html", ".vue": "vue", ".svelte": "svelte",
}  # fmt: skip
SKIP_DIRS = {"node_modules", "dist", "build", ".git", "vendor", "__pycache__", ".venv", "venv", "target", ".next",
             "coverage", ".idea", ".vscode", "site-packages", "third_party", "out", ".pytest_cache"}  # fmt: skip
SKIP_FILES = re.compile(r"(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.min\.(js|css)|\.map)$")
SYMBOL_START = re.compile(
    r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|class\s+(\w+)|interface\s+(\w+)|"
    r"type\s+(\w+)\s*=|const\s+(\w+)\s*=\s*(?:async\s*)?\(|func\s+(?:\([^)]*\)\s*)?(\w+)|"
    r"(?:public|private|protected|static|\s)+[\w<>\[\],\s]+\s+(\w+)\s*\([^)]*\)\s*\{|fn\s+(\w+)|def\s+(\w+))"
)


class RepoIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(max_length=300)


class AskIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=3, max_length=600)


class TourStep(Lenient):
    title: str = Field(max_length=120)
    path: str = Field(max_length=300)
    explanation: str = Field(max_length=800)


class Tour(Lenient):
    overview: str = Field(max_length=1500)
    steps: list[TourStep] = Field(min_length=3, max_length=10)


ASK_SYSTEM = """You are a senior engineer explaining a codebase. Answer using ONLY the numbered code excerpts.
Cite every claim with [n] (the excerpt number). Mention file paths and function names. Use short paragraphs or
bullets and fenced code only when quoting. If the excerpts don't answer the question, say what's missing."""

TOUR_SYSTEM = """You create onboarding tours for engineers new to a repository.
Reply with ONE JSON object: {"overview": str (what the project is, its architecture, 4-6 sentences),
 "steps": [{"title": str, "path": str (an existing file path from the list), "explanation": str}] (5-8 steps,
 ordered as a newcomer should read the code: entry points first, then core modules, then supporting code)}"""


# ── Chunking ─────────────────────────────────────────────────────────────
def chunk_python(path: str, source: str) -> list[dict[str, Any]]:
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return chunk_generic(path, source)
    lines = source.splitlines()
    chunks: list[dict[str, Any]] = []
    covered: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef) and hasattr(node, "end_lineno"):
            start = min([d.lineno for d in getattr(node, "decorator_list", [])] + [node.lineno])
            end = node.end_lineno or start
            if isinstance(node, ast.ClassDef) and end - start > WINDOW_LINES * 2:
                end = start + 15  # big class: header + docstring; methods are chunked on their own
            chunks.append({"path": path, "start": start, "end": end, "symbol": node.name,
                           "text": "\n".join(lines[start - 1 : end])})  # fmt: skip
            covered.update(range(start, end + 1))
    rest = [i for i in range(1, len(lines) + 1) if i not in covered and lines[i - 1].strip()]
    if rest:  # module-level code (imports, constants, main block)
        for i in range(0, len(rest), WINDOW_LINES):
            block = rest[i : i + WINDOW_LINES]
            chunks.append({"path": path, "start": block[0], "end": block[-1], "symbol": "(module)",
                           "text": "\n".join(lines[n - 1] for n in block)})  # fmt: skip
    return chunks


def chunk_generic(path: str, source: str) -> list[dict[str, Any]]:
    lines = source.splitlines()
    starts = [
        (i + 1, next((g for g in m.groups() if g), None)) for i, ln in enumerate(lines) if (m := SYMBOL_START.match(ln))
    ]
    chunks: list[dict[str, Any]] = []
    if not starts:
        for i in range(0, len(lines), WINDOW_LINES):
            chunks.append({"path": path, "start": i + 1, "end": min(len(lines), i + WINDOW_LINES), "symbol": None,
                           "text": "\n".join(lines[i : i + WINDOW_LINES])})  # fmt: skip
        return chunks
    if starts[0][0] > 1:
        starts.insert(0, (1, "(header)"))
    for (start, sym), nxt in zip(starts, [s[0] for s in starts[1:]] + [len(lines) + 1], strict=True):
        end = nxt - 1
        for s in range(start, end + 1, WINDOW_LINES * 2):  # split very long symbols
            e = min(end, s + WINDOW_LINES * 2 - 1)
            text = "\n".join(lines[s - 1 : e])
            if text.strip():
                chunks.append({"path": path, "start": s, "end": e, "symbol": sym, "text": text})
    return chunks


def imports_of(path: str, source: str, files: set[str]) -> set[str]:
    """Edges from `path` to other files in the repo."""
    out: set[str] = set()
    base = posixpath.dirname(path)
    if path.endswith(".py"):
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return out
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                if node.level:
                    parent = base
                    for _ in range(node.level - 1):
                        parent = posixpath.dirname(parent)
                    names = [posixpath.join(parent, mod.replace(".", "/")).replace("/", ".")] + [
                        posixpath.join(parent, mod.replace(".", "/"), a.name).replace("/", ".") for a in node.names
                    ]
                else:
                    names = [mod] + [f"{mod}.{a.name}" for a in node.names]
            for name in names:
                rel = name.strip(".").replace(".", "/")
                for cand in (f"{rel}.py", f"{rel}/__init__.py"):
                    for f in files:  # match full path or any suffix (src/ layouts)
                        if f == cand or f.endswith("/" + cand):
                            out.add(f)
    else:
        for m in re.finditer(
            r"""(?:import\s[^'"]*?from\s*|import\s*\(?\s*|require\(\s*)['"](\.{1,2}/[^'"]+)['"]""", source
        ):
            target = posixpath.normpath(posixpath.join(base, m[1]))
            for cand in (
                target,
                *(target + e for e in (".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js")),
            ):
                if cand in files:
                    out.add(cand)
                    break
    out.discard(path)
    return out


def read_zip(blob: bytes) -> tuple[dict[str, str], str]:
    """→ ({path: text}, readme). Reads entries in memory only; never writes archive paths to disk."""
    files: dict[str, str] = {}
    readme = ""
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        for info in zf.infolist():
            if info.is_dir() or "/" not in info.filename:
                continue
            path = info.filename.split("/", 1)[1]  # strip the "<repo>-<sha>/" root folder
            parts = path.split("/")
            if any(p in SKIP_DIRS or p.startswith(".") and p not in (".github",) for p in parts[:-1]):
                continue
            ext = Path(path).suffix.lower()
            if ext not in CODE_EXT or SKIP_FILES.search(path) or info.file_size > MAX_FILE_KB * 1024:
                continue
            with zf.open(info) as fh:
                raw = fh.read(MAX_FILE_KB * 1024 + 1)
            if b"\x00" in raw[:2048]:
                continue  # binary
            text = raw.decode("utf-8", errors="replace")
            if path.lower() in ("readme.md", "readme.rst", "readme"):
                readme = text
            files[path] = text
            if len(files) >= MAX_FILES:
                break
    return files, readme


class CodeService:
    def __init__(self, store: DocStore, get_llm, embedder) -> None:  # noqa: ANN001
        self.db = store  # repo metadata as documents; the search index (vectors + chunks) as blobs
        self.get_llm = get_llm
        self.embedder = embedder
        self.fetcher = None  # injectable for tests: async (owner, repo, ref) -> bytes
        self._cache: dict[str, tuple[list[dict[str, Any]], np.ndarray, BM25Okapi]] = {}

    async def download(self, owner: str, repo: str, ref: str | None) -> bytes:
        if self.fetcher is not None:
            return await self.fetcher(owner, repo, ref)
        url = f"https://codeload.github.com/{owner}/{repo}/zip/{'refs/heads/' + ref if ref else 'HEAD'}"
        limit = MAX_ZIP_MB * 1024 * 1024
        async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:  # fixed host: no SSRF surface
            async with client.stream("GET", url, headers={"User-Agent": "CodeLens-portfolio"}) as r:
                if r.status_code == 404:
                    raise HTTPException(404, "Repository not found (it must be public).")
                if r.status_code != 200:
                    raise HTTPException(502, f"GitHub returned {r.status_code}.")
                buf = bytearray()
                async for part in r.aiter_bytes():
                    buf += part
                    if len(buf) > limit:
                        raise HTTPException(413, f"Repository archive is larger than {MAX_ZIP_MB} MB.")
        return bytes(buf)

    async def index(self, url: str) -> AsyncIterator[dict[str, Any]]:
        m = REPO_URL.match(url.strip())
        if not m:
            raise HTTPException(422, "Use a public GitHub URL like https://github.com/owner/repo")
        owner, name, ref = m[1], m[2], m[3]
        if ref and (".." in ref or ref.startswith("/")):
            raise HTTPException(422, "Invalid branch name.")
        yield {"event": "stage", "stage": "download", "detail": f"{owner}/{name}"}
        blob = await self.download(owner, name, ref)
        yield {"event": "stage", "stage": "read", "detail": f"{len(blob) / 1e6:.1f} MB archive"}
        files, readme = await asyncio.to_thread(read_zip, blob)
        if not files:
            raise HTTPException(422, "No supported source files found in this repository.")
        yield {"event": "stage", "stage": "chunk", "detail": f"{len(files)} files"}
        chunks: list[dict[str, Any]] = []
        for path, text in files.items():
            if CODE_EXT[Path(path).suffix.lower()] == "python":
                chunks += chunk_python(path, text)
            else:
                chunks += chunk_generic(path, text)
        chunks = [c for c in chunks if c["text"].strip()][:MAX_CHUNKS]
        yield {"event": "stage", "stage": "embed", "detail": f"{len(chunks)} chunks"}
        vectors = await asyncio.to_thread(
            self.embedder.embed_documents, [f"{c['path']} {c['symbol'] or ''}\n{c['text'][:1500]}" for c in chunks]
        )
        yield {"event": "stage", "stage": "graph", "detail": "import edges"}
        file_set = set(files)
        edges = sorted({(src, dst) for src, text in files.items() for dst in imports_of(src, text, file_set)})
        langs: dict[str, int] = {}
        for p, t in files.items():
            lang = CODE_EXT[Path(p).suffix.lower()]
            langs[lang] = langs.get(lang, 0) + t.count("\n") + 1

        repo_id = new_id()
        buf = io.BytesIO()
        np.save(buf, np.asarray(vectors, dtype=np.float32))
        self.db.put_blob(f"{repo_id}.npy", buf.getvalue())
        self.db.put_blob(f"{repo_id}.json", json.dumps(chunks).encode("utf-8"))
        doc = self.db.put(
            "repos",
            {
                "owner": owner, "name": name, "ref": ref, "url": f"https://github.com/{owner}/{name}",
                "files": sorted(files), "file_lines": {p: t.count("\n") + 1 for p, t in files.items()},
                "edges": edges, "languages": dict(sorted(langs.items(), key=lambda kv: -kv[1])),
                "chunks": len(chunks), "readme": readme[:6000], "tour": None,
            },
            id=repo_id,
        )  # fmt: skip
        yield {"event": "done", "repo": public(doc)}

    def _load(self, repo_id: str) -> tuple[list[dict[str, Any]], np.ndarray, BM25Okapi]:
        if repo_id not in self._cache:
            raw_chunks, raw_vecs = self.db.get_blob(f"{repo_id}.json"), self.db.get_blob(f"{repo_id}.npy")
            if raw_chunks is None or raw_vecs is None:
                raise KeyError(repo_id)
            chunks = json.loads(raw_chunks)
            vecs = np.load(io.BytesIO(raw_vecs))
            bm25 = BM25Okapi([tokenize(f"{c['path']} {c['symbol'] or ''} {c['text']}") or ["_"] for c in chunks])
            self._cache = {repo_id: (chunks, vecs, bm25)}  # keep one repo hot
        return self._cache[repo_id]

    async def search(self, repo_id: str, query: str, k: int = 8) -> list[dict[str, Any]]:
        chunks, vecs, bm25 = await asyncio.to_thread(self._load, repo_id)
        q = np.asarray(await asyncio.to_thread(self.embedder.embed_query, query), dtype=np.float32)
        sims = (vecs @ q) / (np.linalg.norm(vecs, axis=1) * (np.linalg.norm(q) or 1) + 1e-9)
        dense = [str(i) for i in np.argsort(-sims)[:40]]
        lexical = [str(i) for i in np.argsort(-bm25.get_scores(tokenize(query)))[:40]]
        fused = sorted(reciprocal_rank_fusion([dense, lexical]).items(), key=lambda kv: -kv[1])[:k]
        return [{**chunks[int(i)], "score": round(s, 4)} for i, s in fused]

    async def ask(self, repo: dict[str, Any], question: str) -> dict[str, Any]:
        hits = await self.search(repo["id"], question)
        context = "\n\n".join(
            f"[{n}] {h['path']} L{h['start']}-{h['end']} ({h['symbol'] or 'block'})\n```\n{clip(h['text'], 1800)}\n```"
            for n, h in enumerate(hits, start=1)
        )
        answer = await ask_text(
            self.get_llm,
            ASK_SYSTEM,
            f"REPOSITORY: {repo['owner']}/{repo['name']}\n\n{context}\n\nQUESTION: {question}",
            task="codelens.ask",
        )
        return {"answer": answer.strip(), "sources": [{"n": n, **h} for n, h in enumerate(hits, start=1)]}

    async def tour(self, repo: dict[str, Any]) -> dict[str, Any]:
        if repo.get("tour"):
            return repo["tour"]
        files = repo["files"]
        degree: dict[str, int] = {}
        for a, b in repo["edges"]:
            degree[a] = degree.get(a, 0) + 1
            degree[b] = degree.get(b, 0) + 2
        central = sorted(files, key=lambda f: -degree.get(f, 0))[:25]
        prompt = (
            f"REPO: {repo['owner']}/{repo['name']}  LANGUAGES: {repo['languages']}\n\nREADME:\n{clip(repo.get('readme') or '(none)', 3500)}\n\n"
            f"FILES ({len(files)}):\n" + "\n".join(files[:250]) + "\n\nMOST CONNECTED FILES:\n" + "\n".join(central)
        )
        tour = await ask_json(self.get_llm, TOUR_SYSTEM, prompt, Tour, task="codelens.tour")
        steps = [s for s in tour.steps if s.path in set(files)] or tour.steps  # drop hallucinated paths
        result = {"overview": tour.overview, "steps": [s.model_dump() for s in steps]}
        self.db.patch("repos", repo["id"], {"tour": result})
        return result

    def snippet(self, repo_id: str, path: str, start: int, end: int) -> dict[str, Any]:
        chunks, _, _ = self._load(repo_id)
        parts = sorted((c for c in chunks if c["path"] == path), key=lambda c: c["start"])
        text = "\n".join(c["text"] for c in parts if c["end"] >= start and c["start"] <= end)
        return {"path": path, "start": start, "end": end, "text": text}

    def delete(self, repo_id: str) -> None:
        for ext in ("npy", "json"):
            self.db.delete_blob(f"{repo_id}.{ext}")
        self._cache.pop(repo_id, None)
        self.db.delete("repos", repo_id)


def public(doc: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in doc.items() if k not in ("readme", "file_lines")}


# ── API ───────────────────────────────────────────────────────────────────
def get_code(request: Request) -> CodeService:
    return request.app.state.suite.code


Code = Annotated[CodeService, Depends(get_code)]
router = APIRouter(prefix="/api/code", tags=["codelens"])


def _repo(svc: CodeService, repo_id: str) -> dict[str, Any]:
    doc = svc.db.get("repos", repo_id[:40])
    if doc is None:
        raise HTTPException(404, "Repository not indexed.")
    return doc


@router.post("/repos")
@limiter.limit("5/minute")
async def index_repo(request: Request, body: RepoIn, svc: Code) -> StreamingResponse:
    async def events() -> AsyncIterator[str]:
        try:
            async for ev in svc.index(body.url):
                yield sse(ev.pop("event"), ev)
        except HTTPException as exc:
            yield sse("error", {"message": exc.detail})
        except zipfile.BadZipFile:
            yield sse("error", {"message": "GitHub returned an invalid archive."})
        except httpx.HTTPError:
            yield sse("error", {"message": "Couldn't reach GitHub. Check the connection and try again."})
        except Exception as exc:  # noqa: BLE001
            yield sse("error", {"message": llm_failure(exc)})

    return StreamingResponse(
        events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@router.get("/repos")
def list_repos(svc: Code) -> list[dict[str, Any]]:
    return [public(r) for r in svc.db.list("repos", limit=50)]


@router.get("/repos/{repo_id}")
def get_repo(repo_id: str, svc: Code) -> dict[str, Any]:
    return public(_repo(svc, repo_id))


@router.delete("/repos/{repo_id}", status_code=204)
def delete_repo(repo_id: str, svc: Code) -> None:
    _repo(svc, repo_id)
    svc.delete(repo_id[:40])


@router.post("/repos/{repo_id}/ask")
@limiter.limit(rate_limit_value)
async def ask(request: Request, repo_id: str, body: AskIn, svc: Code) -> dict[str, Any]:
    repo = _repo(svc, repo_id)
    try:
        return await svc.ask(repo, body.question)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, llm_failure(exc)) from None


@router.post("/repos/{repo_id}/tour")
@limiter.limit(rate_limit_value)
async def tour(request: Request, repo_id: str, svc: Code) -> dict[str, Any]:
    repo = _repo(svc, repo_id)
    try:
        return await svc.tour(repo)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, llm_failure(exc)) from None


@router.get("/repos/{repo_id}/file")
def file_snippet(repo_id: str, path: str, svc: Code, start: int = 1, end: int = 200) -> dict[str, Any]:
    repo = _repo(svc, repo_id)
    if path not in set(repo["files"]):  # only paths we indexed
        raise HTTPException(404, "File not in index.")
    return svc.snippet(repo["id"], path, max(1, start), min(max(start, end), start + 400))
