"""CodeLens: onboard onto a public GitHub repository without a KT session.

It indexes the repo, then builds an onboarding pack (what the project is, how it's put together, how to run it, a
reading path and a week-one plan, every file reference checked against the repo) and answers questions with
file-and-line citations.

Pipeline (streamed as SSE progress events):
  download (zip over HTTPS, size-capped, read in memory: no extraction, no zip-slip)
  → filter (text source files only, vendored/build dirs skipped, per-file and file-count caps)
  → chunk  (Python: `ast` functions/classes with exact line ranges; other languages: symbol-boundary regex,
            falling back to 60-line windows)
  → embed  (local FastEmbed, same model as DocuMind) + BM25, fused with Reciprocal Rank Fusion at query time
  → graph  (import edges between files: Python `ast`, JS/TS `import`/`require` relative paths)

Beyond questions and the pack: a hand-over readiness report (readiness.py: checks with evidence, risks, a module
map, a meeting plan and starter files) and the hand-over document (handover.py), both deterministic.
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
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from rank_bm25 import BM25Okapi

from app.identity import OWNER, account, browser, tenant
from app.products import handover as handover_doc
from app.products import readiness as readiness_report
from app.rag.retriever import reciprocal_rank_fusion, tokenize
from appcore.ai import Lenient, ask_json, ask_text, clip, llm_failure, sse
from appcore.docstore import DocStore, new_id
from appcore.security import limiter, rate_limit_value

logger = logging.getLogger(__name__)

REPO_URL = re.compile(
    r"^https://github\.com/([A-Za-z0-9][\w.-]{0,38})/([\w.-]{1,100}?)(?:\.git)?(?:/tree/([\w./-]{1,100}))?/?$"
)
MAX_ZIP_MB = 40
MAX_FILES = 1500
MAX_FILE_KB = 160
MAX_CHUNKS = 2500
WINDOW_LINES = 60
EMBED_SLICE = 48  # chunks embedded per step while indexing
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
# Definitions that don't start with a keyword: `morgan.format('dev', function …)`, `exports.parse = …`,
# `Router.prototype.handle = function …`.
REGISTERED = re.compile(
    r"^\s*(?:[\w$]+\.)+\w+\(\s*['\"]([\w:-]+)['\"]\s*,\s*(?:async\s+)?(?:function|\()|"
    r"^\s*(?:module\.)?exports\.([\w$]+)\s*=|^\s*(?:[\w$]+\.)+([\w$]+)\s*=\s*(?:async\s+)?function"
)
# Control-flow words the method pattern would otherwise take for names (`  if (x) {` is not a function called "if").
NOT_SYMBOLS = {"if", "else", "for", "while", "switch", "catch", "return", "do", "try", "with", "new", "typeof", "await"}


def symbol_at(line: str) -> str | None:
    """The name a line starts defining, or None (control flow is never a definition)."""
    for pattern in (SYMBOL_START, REGISTERED):
        if m := pattern.match(line):
            name = next((g for g in m.groups() if g), None)
            if name and name not in NOT_SYMBOLS:
                return name
    return None


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


class Area(Lenient):
    name: str = Field(max_length=80)
    what: str = Field(max_length=400)
    paths: list[str] = Field(default_factory=list, max_length=6)


class Task(Lenient):
    text: str = Field(max_length=300)
    paths: list[str] = Field(default_factory=list, max_length=4)


class PlanDay(Lenient):
    day: int = Field(ge=1, le=5)
    goal: str = Field(max_length=160)
    tasks: list[Task] = Field(default_factory=list, max_length=5)
    checkpoint: str = Field("", max_length=240)


class Pack(Lenient):
    _aliases = {"week": "week_plan", "plan": "week_plan", "modules": "areas", "faq": "questions"}
    purpose: str = Field(max_length=600)
    architecture: str = Field(max_length=1200)
    areas: list[Area] = Field(default_factory=list, max_length=8)
    run: list[str] = Field(default_factory=list, max_length=8)
    week_plan: list[PlanDay] = Field(default_factory=list, max_length=5)
    questions: list[str] = Field(default_factory=list, max_length=6)


ASK_SYSTEM = """You are a senior engineer explaining a codebase. The numbered excerpts below were retrieved from the
repository for this question (the user did not write them); answer using ONLY them.
Cite every claim with [n] (the excerpt number). Mention file paths and function names. Use short paragraphs or
bullets and fenced code only when quoting. Name only files that appear in the excerpts: never guess a path.
If the excerpts don't answer the question, say so plainly and say which of the excerpted files is the closest lead."""

TOUR_SYSTEM = """You create onboarding tours for engineers new to a repository.
Reply with ONE JSON object: {"overview": str (what the project is, its architecture, 4-6 sentences),
 "steps": [{"title": str, "path": str (an existing file path from the list), "explanation": str}] (5-8 steps,
 ordered as a newcomer should read the code: entry points first, then core modules, then supporting code)}"""


PACK_SYSTEM = """You write the onboarding pack a new engineer gets on their first day, replacing a KT session.
Use ONLY the README, file list and connections given. Reply with ONE JSON object:
{"purpose": str (2-3 plain sentences: what the project does and for whom),
 "architecture": str (4-6 sentences: the main parts and how a request or data flows through them),
 "areas": [{"name": str, "what": str (one sentence), "paths": [existing file paths]}] (3-7 areas of the code),
 "run": [str] (setup / run / test commands that appear in the README, copied exactly; [] if it has none),
 "week_plan": [{"day": 1-5, "goal": str, "tasks": [{"text": str, "paths": [existing file paths]}] (2-4 tasks),
   "checkpoint": str (how they know the day went well)}] (exactly 5 days: day 1 set up and run it, then read the
   core flow, then the main areas, then make a small safe change, day 5 review and own a starter task),
 "questions": [str] (5 questions a newcomer would ask about THIS codebase)}
Only use file paths from the list. Never invent commands, services or people."""


_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def code_tokens(text: str) -> list[str]:
    """Search terms for code: identifiers also count as their words (cartTotal → cart total, save_user → save user)."""
    words = _CAMEL.sub(" ", text).replace("_", " ")
    return tokenize(f"{text} {words}")


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
            # the lines aren't next to each other: keep their numbers so findings can point at the right one
            chunks.append({"path": path, "start": block[0], "end": block[-1], "symbol": "(module)", "lines": block,
                           "text": "\n".join(lines[n - 1] for n in block)})  # fmt: skip
    return chunks


DOC_FILE = re.compile(r"(?i)\.(md|mdx|rst|txt|adoc)$|(^|/)(readme|license|contributing|code_of_conduct)[^/]*$")
CHANGELOG = re.compile(r"(?i)(^|/)(changelog|history|changes|news|releases?)[^/]*$")
ABOUT_DOCS = re.compile(r"(?i)\b(readme|docs?|documentation|install|setup|usage|changelog|history|release|license)\b")


def select(chunks: list[dict[str, Any]], fused: list[tuple[str, float]], query: str, k: int) -> list[tuple[str, float]]:
    """The top k by fused rank, but a question about the code gets code: at most 2 doc excerpts and 1 changelog
    excerpt (they mention every feature by name, so they outrank the code that implements it)."""
    caps = (4, 2) if ABOUT_DOCS.search(query) else (2, 1)
    docs = logs = 0
    out = []
    for i, score in fused:
        path = chunks[int(i)]["path"]
        if CHANGELOG.search(path):
            if logs >= caps[1]:
                continue
            logs += 1
        elif DOC_FILE.search(path):
            if docs >= caps[0]:
                continue
            docs += 1
        out.append((i, score))
        if len(out) == k:
            break
    return out


def focus(text: str, query: str, limit: int = 1800) -> str:
    """A long excerpt cut to the lines that match the question (not just its first lines)."""
    if len(text) <= limit:
        return text
    terms = {t for t in code_tokens(query) if len(t) > 2}
    lines = text.splitlines()
    best = max(range(len(lines)), key=lambda n: sum(t in lines[n].lower() for t in terms), default=0)
    start = end = best
    size = len(lines[best]) if lines else 0
    while size < limit and (start > 0 or end < len(lines) - 1):
        if start > 0:
            start -= 1
            size += len(lines[start]) + 1
        if end < len(lines) - 1 and size < limit:
            end += 1
            size += len(lines[end]) + 1
    return ("…\n" if start else "") + "\n".join(lines[start : end + 1]) + ("\n…" if end < len(lines) - 1 else "")


def chunk_generic(path: str, source: str) -> list[dict[str, Any]]:
    lines = source.splitlines()
    starts = [(i + 1, name) for i, ln in enumerate(lines) if (name := symbol_at(ln))]
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
        extra = await asyncio.to_thread(readiness_report.archive_meta, blob)  # every path + .env.example, CODEOWNERS…
        if not files:
            raise HTTPException(422, "No supported source files found in this repository.")
        langs: dict[str, int] = {}
        for p, t in files.items():
            lang = CODE_EXT[Path(p).suffix.lower()]
            langs[lang] = langs.get(lang, 0) + t.count("\n") + 1
        yield {"event": "preview", **preview_of(files, langs, readme)}
        yield {"event": "stage", "stage": "chunk", "detail": f"{len(files)} files"}
        chunks: list[dict[str, Any]] = []
        for path, text in files.items():
            if CODE_EXT[Path(path).suffix.lower()] == "python":
                chunks += chunk_python(path, text)
            else:
                chunks += chunk_generic(path, text)
        chunks = [c for c in chunks if c["text"].strip()][:MAX_CHUNKS]
        yield {"event": "stage", "stage": "embed", "detail": f"{len(chunks)} chunks"}
        texts = [f"{c['path']} {c['symbol'] or ''}\n{c['text'][:1500]}" for c in chunks]
        parts = []
        for i in range(0, len(texts), EMBED_SLICE):  # in slices: bounded memory, and progress the reader can see
            parts.append(np.asarray(await asyncio.to_thread(self.embedder.embed_documents, texts[i : i + EMBED_SLICE])))
            yield {"event": "progress", "done": min(i + EMBED_SLICE, len(texts)), "total": len(texts)}
        vectors = np.concatenate(parts) if parts else np.zeros((0, 0), dtype=np.float32)
        yield {"event": "stage", "stage": "graph", "detail": "import edges"}
        file_set = set(files)
        edges = sorted({(src, dst) for src, text in files.items() for dst in imports_of(src, text, file_set)})
        yield {"event": "found", "edges": len(edges), "symbols": sum(1 for c in chunks if c.get("symbol"))}

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
                "chunks": len(chunks), "readme": readme[:6000], "tour": None, "pack": None, **extra,
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
            bm25 = BM25Okapi([code_tokens(f"{c['path']} {c['symbol'] or ''} {c['text']}") or ["_"] for c in chunks])
            self._cache = {repo_id: (chunks, vecs, bm25)}  # keep one repo hot
        return self._cache[repo_id]

    async def search(self, repo_id: str, query: str, k: int = 8) -> list[dict[str, Any]]:
        chunks, vecs, bm25 = await asyncio.to_thread(self._load, repo_id)
        q = np.asarray(await asyncio.to_thread(self.embedder.embed_query, query), dtype=np.float32)
        sims = (vecs @ q) / (np.linalg.norm(vecs, axis=1) * (np.linalg.norm(q) or 1) + 1e-9)
        dense = [str(i) for i in np.argsort(-sims)[:40]]
        lexical = [str(i) for i in np.argsort(-bm25.get_scores(code_tokens(query)))[:40]]
        fused = sorted(reciprocal_rank_fusion([dense, lexical]).items(), key=lambda kv: -kv[1])
        return [{**chunks[int(i)], "score": round(s, 4)} for i, s in select(chunks, fused, query, k)]

    async def ask(self, repo: dict[str, Any], question: str) -> dict[str, Any]:
        hits = await self.search(repo["id"], question)
        context = "\n\n".join(
            f"[{n}] {h['path']} L{h['start']}-{h['end']} ({h['symbol'] or 'block'})\n```\n{focus(h['text'], question)}\n```"
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

    async def pack(self, repo: dict[str, Any]) -> dict[str, Any]:
        """The onboarding pack: generated once per repo, every file path checked against the index."""
        if repo.get("pack"):
            return repo["pack"]
        tour = await self.tour(repo)
        files = repo["files"]
        degree: dict[str, int] = {}
        for a, b in repo["edges"]:
            degree[a] = degree.get(a, 0) + 1
            degree[b] = degree.get(b, 0) + 2
        central = sorted(files, key=lambda f: -degree.get(f, 0))[:30]
        prompt = (
            f"REPO: {repo['owner']}/{repo['name']}  LANGUAGES: {repo['languages']}\n\n"
            f"README:\n{clip(repo.get('readme') or '(none)', 5000)}\n\n"
            f"FILES ({len(files)}):\n" + "\n".join(files[:300]) + "\n\nMOST CONNECTED FILES:\n" + "\n".join(central)
        )
        raw = await ask_json(self.get_llm, PACK_SYSTEM, prompt, Pack, task="codelens.pack")
        known = set(files)
        readme = repo.get("readme") or ""

        def real(paths: list[str]) -> list[str]:
            return [x for x in paths if x in known]

        result = {
            "purpose": raw.purpose,
            "architecture": raw.architecture,
            "areas": [{**a.model_dump(), "paths": real(a.paths)} for a in raw.areas],
            # Commands are shown only when they really appear in the README (never invented).
            "run": [c for c in raw.run if c.strip() and c.strip() in readme],
            "reading_path": tour["steps"],
            "week_plan": [
                {**d.model_dump(), "tasks": [{**t.model_dump(), "paths": real(t.paths)} for t in d.tasks]}
                for d in sorted(raw.week_plan, key=lambda d: d.day)
            ],
            "questions": raw.questions,
        }
        self.db.patch("repos", repo["id"], {"pack": result})
        return result

    async def readiness(self, repo: dict[str, Any]) -> dict[str, Any]:
        """Is it ready to hand over? Deterministic checks, risks, module map, meeting plan and starter files."""
        chunks, _, _ = await asyncio.to_thread(self._load, repo["id"])
        return await asyncio.to_thread(readiness_report.assess, repo, chunks, repo.get("pack"))

    async def handover(self, repo: dict[str, Any]) -> dict[str, Any]:
        """The hand-over document (Markdown + printable HTML): the pack, plus facts read from the code itself."""
        pack = await self.pack(repo)
        chunks, _, _ = await asyncio.to_thread(self._load, repo["id"])
        facts = handover_doc.facts(repo, chunks)
        ready = await asyncio.to_thread(readiness_report.assess, repo, chunks, pack)
        return {
            "markdown": handover_doc.markdown(repo, pack, facts, ready=ready),
            "html": handover_doc.to_html(repo, pack, facts, ready=ready),
            "filename": handover_doc.filename(repo, "md"),
            "html_filename": handover_doc.filename(repo, "html"),
        }

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


def preview_of(files: dict[str, str], langs: dict[str, int], readme: str) -> dict[str, Any]:
    """What CodeLens has found so far, shown while it keeps working: real numbers, never placeholders."""
    total = sum(langs.values()) or 1
    folders: dict[str, int] = {}
    for p in files:
        top = p.split("/", 1)[0] if "/" in p else "(root)"
        folders[top] = folders.get(top, 0) + 1
    heading = (ln.lstrip("# ").strip() for ln in readme.splitlines() if ln.startswith("#"))
    title = next((h for h in heading if h), "")
    step = max(1, len(files) // 40)
    return {
        "files": len(files),
        "lines": total,
        "languages": [
            {"name": k, "share": round(v * 100 / total)} for k, v in sorted(langs.items(), key=lambda kv: -kv[1])[:5]
        ],
        "folders": [k for k, _ in sorted(folders.items(), key=lambda kv: -kv[1])[:6]],
        "sample": sorted(files)[::step][:40],
        "title": title[:120],
    }


def public(doc: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in doc.items() if k not in ("readme", "file_lines", "pack", "all_paths", "meta")}


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


# Whose list a repository is on. Indexed code is public GitHub code, so a repo page opens for anyone with its link
# (share it with a new joiner); the list and deleting are per person (app.identity).
Who = Annotated[str, Depends(tenant)]


def _mine(doc: dict[str, Any], who: str) -> bool:
    tenants = doc.get("tenants")
    return who in tenants if tenants is not None else who == OWNER  # made before identities: the site owner's


@router.post("/repos")
@limiter.limit("5/minute")
async def index_repo(request: Request, body: RepoIn, svc: Code, who: Who) -> StreamingResponse:
    async def events() -> AsyncIterator[str]:
        try:
            async for ev in svc.index(body.url):
                if ev.get("event") == "done" and ev.get("repo", {}).get("id"):
                    svc.db.patch("repos", ev["repo"]["id"], {"tenants": [who]})
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


@router.post("/claim")
def claim_repos(
    request: Request,
    svc: Code,
    authorization: Annotated[str | None, Header()] = None,
    x_visitor: Annotated[str | None, Header()] = None,
) -> dict[str, int]:
    """Just signed in: the repos this browser indexed join the account's list (on every device)."""
    to, came_from = account(request, authorization), browser(x_visitor)
    if not to:
        raise HTTPException(401, "Sign in first.")
    moved = 0
    for r in svc.db.list("repos", limit=500):
        tenants = r.get("tenants") or []
        if came_from in tenants and to not in tenants:
            svc.db.patch("repos", r["id"], {"tenants": [t for t in tenants if t != came_from] + [to]})
            moved += 1
    return {"moved": moved}


@router.get("/repos")
def list_repos(svc: Code, who: Who) -> list[dict[str, Any]]:
    """Your repositories (each person sees only the ones they indexed)."""
    return [public(r) for r in svc.db.list("repos", limit=500) if _mine(r, who)][:50]


@router.get("/repos/{repo_id}")
def get_repo(repo_id: str, svc: Code) -> dict[str, Any]:
    return public(_repo(svc, repo_id))


@router.delete("/repos/{repo_id}", status_code=204)
def delete_repo(repo_id: str, svc: Code, who: Who) -> None:
    """Only the person who indexed it can remove it (anyone else gets 404, as if it weren't there)."""
    doc = _repo(svc, repo_id)
    if not _mine(doc, who):
        raise HTTPException(404, "Repository not indexed.")
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


@router.post("/repos/{repo_id}/pack")
@limiter.limit(rate_limit_value)
async def pack(request: Request, repo_id: str, svc: Code) -> dict[str, Any]:
    repo = _repo(svc, repo_id)
    try:
        return await svc.pack(repo)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, llm_failure(exc)) from None


@router.post("/repos/{repo_id}/handover")
@limiter.limit(rate_limit_value)
async def handover(request: Request, repo_id: str, svc: Code) -> dict[str, Any]:
    """A hand-over document to download and share (Markdown, and HTML to print or save as PDF)."""
    repo = _repo(svc, repo_id)
    try:
        return await svc.handover(repo)
    except KeyError:
        raise HTTPException(404, "This repository's index is gone. Index it again.") from None
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, llm_failure(exc)) from None


@router.get("/repos/{repo_id}/readiness")
@limiter.limit("20/minute")
async def readiness(request: Request, repo_id: str, svc: Code) -> dict[str, Any]:
    repo = _repo(svc, repo_id)
    try:
        return await svc.readiness(repo)
    except KeyError as exc:
        raise HTTPException(404, "This repository's index is gone. Index it again.") from exc


@router.get("/repos/{repo_id}/file")
def file_snippet(repo_id: str, path: str, svc: Code, start: int = 1, end: int = 200) -> dict[str, Any]:
    repo = _repo(svc, repo_id)
    if path not in set(repo["files"]):  # only paths we indexed
        raise HTTPException(404, "File not in index.")
    return svc.snippet(repo["id"], path, max(1, start), min(max(start, end), start + 400))
