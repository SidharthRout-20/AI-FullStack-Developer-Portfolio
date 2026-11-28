"""CodeLens hand-over readiness: is this repository ready to hand over, and what will bite the new owner?

Deterministic checks over the indexed code and the archive's file list. No model is involved and nothing is guessed:
every finding names the files (and lines) it rests on.

  checks   – what a hand-over depends on: it runs from the README, its configuration is written down, it has tests and
             CI, installs are reproducible, how it ships is in the repo, ownership and licence are recorded, there is
             documentation beyond the README, and no secrets sit in the code. Each check has its evidence and a fix; the
             score weighs them.
  risks    – files many others import that no test touches, the biggest files, debt markers (TODO/FIXME/HACK/XXX) and
             possible secrets (file and line only: the matched value is never stored, returned or shown).
  modules  – the folder-level dependency map from the import graph, with a Mermaid version for Markdown viewers.
  sessions – a hand-over meeting plan built from the checks, the risks and the onboarding pack.
  starter  – files that close gaps: an .env.example (variable names only) and a CODEOWNERS draft.

Pure functions (unit-tested in tests/test_suite.py); the route lives in codelens.py.
"""

from __future__ import annotations

import io
import json
import posixpath
import re
import zipfile
from typing import Any

from app.products.handover import TEST_FILE, facts, file_texts

# Files that say something about the project as a whole, kept from the archive even though they aren't indexed.
META_FILE = re.compile(
    r"(?i)^(\.env\.(example|sample|template|dist)|example\.env|\.env\.local\.example|(\.github/|docs/)?codeowners|"
    r"dockerfile|makefile|procfile)$|(^|/)requirements[\w.-]*\.txt$"
)
SKIP_PARTS = {"node_modules", ".git", "vendor", "__pycache__", ".venv", "venv", "dist", "build", "target", ".next"}
MAX_PATHS = 4000
MAX_META_KB = 8

LOCKS = {
    "package.json": ("package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "npm-shrinkwrap.json"),
    "pyproject.toml": ("poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock", "requirements.lock"),
    "Pipfile": ("Pipfile.lock",),
    "go.mod": ("go.sum",),
    "Gemfile": ("Gemfile.lock",),
    "composer.json": ("composer.lock",),
    "Cargo.toml": ("Cargo.lock",),
}  # fmt: skip
DEPLOY = re.compile(
    r"(?i)(^|/)(dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|procfile|vercel\.json|netlify\.toml|"
    r"fly\.toml|render\.ya?ml|app\.ya?ml|serverless\.ya?ml|railway\.json|[^/]+\.tf|chart\.yaml|skaffold\.yaml)$|"
    r"(^|/)(k8s|kubernetes|helm|deploy|infra|terraform)/"
)
LICENCE = re.compile(r"(?i)^(licen[cs]e|copying)(\.[a-z]+)?$")
DOCS = re.compile(r"(?i)^docs?/.+\.(md|mdx|rst)$|(^|/)(contributing|architecture|design|runbook|operations)\.md$")
RUN_LINE = re.compile(
    r"(?m)^\s*(?:\$\s*)?(npm|npx|yarn|pnpm|bun|pip|pip3|python3?|uv|poetry|pipenv|docker|docker-compose|make|go|cargo|"
    r"mvn|gradle|\./gradlew|bundle|rails|composer|php|dotnet|deno|flask|uvicorn|node)\s+\S"
)
DEBT = re.compile(r"(?:#|//|/\*|\*|<!--|--)\s*(TODO|FIXME|HACK|XXX)\b[\s:(\-]*(.{0,90})")
SECRETS = [
    ("AWS access key", "high", re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("Private key", "high", re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY")),
    ("GitHub token", "high", re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b")),
    ("Slack token", "high", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}")),
    ("Google API key", "high", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("Stripe live key", "high", re.compile(r"\b(sk|rk)_live_[0-9A-Za-z]{20,}\b")),
    ("AI provider key", "high", re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{32,}\b")),
    (
        "Hard-coded credential",
        "possible",
        re.compile(
            r"(?i)\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b"
            r"['\"]?\s*[:=]\s*['\"]([^'\"\s]{8,})['\"]"
        ),
    ),
]
PLACEHOLDER = re.compile(
    r"(?i)(x{4,}|your[_-]|<[^>]+>|\$\{|example|dummy|changeme|placeholder|test|fake|sample|\*{3,})"
)
CODE_SUFFIX = re.compile(r"\.(py|js|jsx|ts|tsx|mjs|go|java|kt|rs|rb|php|cs|cpp|c|h|swift|scala|vue|svelte|sh|sql)$")
GROUP_ROOTS = {"src", "app", "lib", "packages", "apps", "services", "internal", "pkg", "cmd", "modules", "libs"}


def archive_meta(blob: bytes) -> dict[str, Any]:
    """Every path in the archive (names only, build and vendored folders skipped) and the text of a few small files
    that say how the project is configured, owned and shipped (.env.example, CODEOWNERS, Dockerfile, Makefile)."""
    paths: list[str] = []
    meta: dict[str, str] = {}
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        for info in zf.infolist():
            if info.is_dir() or "/" not in info.filename:
                continue
            path = info.filename.split("/", 1)[1]
            if not path or any(p in SKIP_PARTS for p in path.split("/")[:-1]):
                continue
            if len(paths) < MAX_PATHS:
                paths.append(path)
            if META_FILE.search(path) and info.file_size <= MAX_META_KB * 1024 and len(meta) < 12:
                with zf.open(info) as fh:
                    raw = fh.read(MAX_META_KB * 1024)
                if b"\x00" not in raw[:1024]:
                    meta[path] = raw.decode("utf-8", errors="replace")
    return {"all_paths": sorted(paths), "meta": meta}


def _lines(chunks: list[dict[str, Any]]):
    """(path, line number or None, text) for every indexed line. Python module-level chunks gather lines that aren't
    next to each other and carry their numbers ("lines"); in an index made before that, those report the file only."""
    seen: set[tuple[str, int]] = set()
    for c in chunks:
        numbers = c.get("lines")
        exact = c.get("symbol") != "(module)"
        for i, text in enumerate(c["text"].splitlines()):
            line = numbers[i] if numbers and i < len(numbers) else c["start"] + i if exact else None
            if line is not None:
                if (c["path"], line) in seen:
                    continue
                seen.add((c["path"], line))
            yield c["path"], line, text


def scan(chunks: list[dict[str, Any]]) -> dict[str, Any]:
    """Debt markers and possible secrets in the indexed code. Secrets are reported by kind, file and line only."""
    debt: list[dict[str, Any]] = []
    secrets: list[dict[str, Any]] = []
    debt_total = 0
    for path, line, text in _lines(chunks):
        if not CODE_SUFFIX.search(path):
            continue
        m = DEBT.search(text)
        if m:
            debt_total += 1
            if len(debt) < 40:
                debt.append({"path": path, "line": line, "tag": m[1], "text": m[2].strip().rstrip("*/-> ").strip()})
        for kind, confidence, pat in SECRETS:
            s = pat.search(text)
            if not s:
                continue
            if confidence == "possible" and (PLACEHOLDER.search(s[2]) or "environ" in text or "getenv" in text):
                continue
            if confidence == "possible" and TEST_FILE.search(path):
                continue  # fixtures in tests are expected to hold fake credentials
            secrets.append({"path": path, "line": line, "kind": kind, "confidence": confidence})
            break
    return {"debt": debt, "debt_total": debt_total, "secrets": secrets[:30]}


def _group(path: str) -> str:
    parts = path.split("/")
    if len(parts) == 1:
        return "(root)"
    if parts[0] in GROUP_ROOTS and len(parts) > 2:
        return f"{parts[0]}/{parts[1]}"
    return parts[0]


def modules(files: list[str], edges: list[list[str]] | list[tuple[str, str]], limit: int = 12) -> dict[str, Any]:
    """Folder-level dependencies from the import graph: which part of the code uses which, and how often."""
    size: dict[str, int] = {}
    for p in files:
        size[_group(p)] = size.get(_group(p), 0) + 1
    links: dict[tuple[str, str], int] = {}
    for a, b in edges:
        ga, gb = _group(a), _group(b)
        if ga != gb:
            links[(ga, gb)] = links.get((ga, gb), 0) + 1
    degree: dict[str, int] = {}
    for (a, b), n in links.items():
        degree[a] = degree.get(a, 0) + n
        degree[b] = degree.get(b, 0) + n
    keep = sorted(degree, key=lambda g: (-degree[g], g))[:limit]
    nodes = [{"id": g, "files": size.get(g, 0)} for g in keep]
    kept = set(keep)
    out_edges = sorted(
        ({"from": a, "to": b, "imports": n} for (a, b), n in links.items() if a in kept and b in kept),
        key=lambda e: (-e["imports"], e["from"], e["to"]),
    )[:24]
    ids = {g: f"m{i}" for i, g in enumerate(keep)}
    label = lambda g: g.replace('"', "'")  # noqa: E731
    mermaid = "\n".join(
        ["graph LR"]
        + [f'  {ids[n["id"]]}["{label(n["id"])} ({n["files"]} files)"]' for n in nodes]
        + [f"  {ids[e['from']]} -->|{e['imports']}| {ids[e['to']]}" for e in out_edges]
    )
    return {"nodes": nodes, "edges": out_edges, "mermaid": mermaid if out_edges else ""}


def _tested(path: str, tests: list[str], importers: dict[str, set[str]]) -> bool:
    if any(TEST_FILE.search(src) for src in importers.get(path, set())):
        return True
    stem = posixpath.splitext(posixpath.basename(path))[0]
    names = {f"test_{stem}.py", f"{stem}_test.py", f"{stem}_test.go"} | {
        f"{stem}.{kind}.{ext}" for kind in ("test", "spec") for ext in ("js", "jsx", "ts", "tsx", "mjs")
    }
    return any(posixpath.basename(t) in names for t in tests)


def risks(repo: dict[str, Any], tests: list[str], found: dict[str, Any]) -> dict[str, Any]:
    files: list[str] = repo["files"]
    lines: dict[str, int] = repo.get("file_lines") or {}
    importers: dict[str, set[str]] = {}
    for a, b in repo.get("edges") or []:
        importers.setdefault(b, set()).add(a)
    used = lambda p: len({s for s in importers.get(p, set()) if not TEST_FILE.search(s)})  # noqa: E731
    critical = [
        {"path": p, "used_by": used(p), "lines": lines.get(p)}
        for p in files
        if CODE_SUFFIX.search(p) and not TEST_FILE.search(p) and used(p) >= 2 and not _tested(p, tests, importers)
    ]
    critical.sort(key=lambda r: (-r["used_by"], r["path"]))
    large = [
        {"path": p, "lines": n, "used_by": used(p)}
        for p, n in lines.items()
        if n >= 400 and CODE_SUFFIX.search(p) and not TEST_FILE.search(p)
    ]
    large.sort(key=lambda r: -r["lines"])
    return {
        "untested_critical": critical[:8],
        "graph": bool(repo.get("edges")),
        "large": large[:6],
        "debt": found["debt"][:12],
        "debt_total": found["debt_total"],
        "secrets": found["secrets"],
    }


def _check(
    cid: str, title: str, weight: int, status: str, detail: str, fix: str = "", evidence: list[str] | None = None
):
    return {"id": cid, "title": title, "weight": weight, "status": status, "detail": detail, "fix": fix,
            "evidence": (evidence or [])[:8]}  # fmt: skip


def checks(repo: dict[str, Any], f: dict[str, Any], texts: dict[str, str], found: dict[str, Any], pack: dict | None):
    paths: list[str] | None = repo.get("all_paths")
    meta: dict[str, str] = repo.get("meta") or {}
    known = paths is not None
    everything = set(paths or []) | set(repo["files"])
    base = {posixpath.basename(p) for p in everything}
    readme = repo.get("readme") or ""
    out = []

    # 1. It runs from the README
    commands = (pack or {}).get("run") or RUN_LINE.findall(readme)
    out.append(
        _check("run", "Runs from the README", 3, "pass" if commands else "fail",
               "The README shows how to install and run it." if commands else "The README has no setup or run commands.",
               "" if commands else "Add the exact commands to install, configure and start it, from a clean machine.")
    )  # fmt: skip

    # 2. Configuration is written down
    docs = "\n".join([readme, *meta.values(), *(t for p, t in texts.items() if p.lower().endswith((".md", ".mdx")))])
    names = [e["name"] for e in f["env"]]
    missing = [n for n in names if n not in docs]
    if not names:
        out.append(
            _check("config", "Configuration is written down", 3, "pass", "The code reads no environment variables.")
        )
    else:
        status = "pass" if not missing else "warn" if len(missing) <= len(names) / 2 else "fail"
        out.append(
            _check("config", "Configuration is written down", 3, status,
                   f"{len(names) - len(missing)} of {len(names)} environment variables the code reads are documented."
                   + (f" Not documented: {', '.join(missing[:6])}{'…' if len(missing) > 6 else ''}." if missing else ""),
                   "Add an .env.example listing every variable (CodeLens drafted one below) and say in the README what each is for."
                   if missing else "", missing)
        )  # fmt: skip

    # 3. Tests and 4. CI
    out.append(
        _check("tests", "Has tests", 3, "pass" if f["tests"] else "fail",
               f"{len(f['tests'])} test file(s) in the indexed code." if f["tests"] else "No test files in the indexed code.",
               "" if f["tests"] else "Add tests around the files many others depend on (see Risks) before the hand-over.",
               f["tests"][:4])
    )  # fmt: skip
    out.append(
        _check("ci", "Checks run automatically (CI)", 2, "pass" if f["ci"] else "fail",
               ", ".join(f["ci"]) if f["ci"] else "No CI workflow found.",
               "" if f["ci"] else "Add a CI workflow that installs, lints and runs the tests on every pull request.",
               f["ci"][:4])
    )  # fmt: skip

    # 5. No secrets in the code
    high = [s for s in found["secrets"] if s["confidence"] == "high"]
    where = [f"{s['path']}" + (f":{s['line']}" if s["line"] else "") for s in found["secrets"]]
    out.append(
        _check("secrets", "No secrets in the code", 3, "fail" if high else "warn" if found["secrets"] else "pass",
               (f"{len(high)} likely secret(s) and " if high else "") + f"{len(found['secrets']) - len(high)} possible hard-coded credential(s) found."
               if found["secrets"] else "No keys, tokens or hard-coded credentials found in the indexed code.",
               "Rotate anything real now, move it to the environment or a secrets manager, and remove it from the git history."
               if found["secrets"] else "", where)
    )  # fmt: skip

    # 6. Reproducible installs
    if not known:
        out.append(
            _check("lock", "Installs are reproducible", 2, "unknown", "Re-index the repository to check lockfiles.")
        )
    else:
        need = [(m, locks) for m, locks in LOCKS.items() if m in base]
        unlocked = [m for m, locks in need if not any(lock in base for lock in locks)]
        reqs = [t for p, t in {**texts, **meta}.items() if posixpath.basename(p) == "requirements.txt"]
        if "requirements.txt" in base and not reqs:
            reqs = [""]  # on the file list but not readable: treat as present
        loose = [
            ln for t in reqs for ln in t.splitlines() if ln.strip() and not ln.startswith(("#", "-")) and "==" not in ln
        ]
        if "pyproject.toml" in unlocked and reqs and not loose:
            unlocked.remove("pyproject.toml")  # pinned requirements do the job
        if not need and not reqs:
            out.append(_check("lock", "Installs are reproducible", 2, "unknown", "No package manifest found."))
        else:
            # A published npm library conventionally leaves its lockfile out; an app should commit one.
            library = "package.json" in unlocked and _npm_library(texts)
            status = "pass" if not unlocked and not loose else "warn" if not unlocked or loose or library else "fail"
            detail = (
                "Every manifest has a lockfile." if status == "pass" else
                (f"No lockfile next to {', '.join(unlocked)}." if unlocked else "")
                + (" It's a published library, where that's common; an app should commit one." if library else "")
                + (f" {len(loose)} requirement(s) without an exact version." if loose else "")
            )  # fmt: skip
            out.append(_check("lock", "Installs are reproducible", 2, status, detail.strip(),
                              "" if status == "pass" else "Commit the lockfile (or pin exact versions) so the new owner installs what works today."))  # fmt: skip

    # 7. How it ships
    ships = sorted(p for p in everything if DEPLOY.search(p))[:6] + [p for p in f["ci"] if "deploy" in p.lower()]
    out.append(
        _check("deploy", "How it ships is in the repo", 1, "pass" if ships else "warn",
               ", ".join(ships[:4]) if ships else "No container, deploy config or deploy workflow found.",
               "" if ships else "Write down where it runs and how a release goes out (a Dockerfile, deploy workflow or runbook).",
               ships)
    )  # fmt: skip

    # 8. Ownership, 9. Licence, 10. Docs
    owners = [p for p in everything if posixpath.basename(p).upper() == "CODEOWNERS"]
    out.append(
        _check("owners", "Ownership is written down", 1, "unknown" if not known else "pass" if owners else "warn",
               "Re-index the repository to check." if not known else ", ".join(owners) if owners else "No CODEOWNERS file.",
               "" if owners or not known else "Add a CODEOWNERS file so reviews reach the new owner (CodeLens drafted one below).", owners)
    )  # fmt: skip
    licences = [p for p in everything if "/" not in p and LICENCE.match(p)]
    out.append(
        _check("licence", "Has a licence", 1, "unknown" if not known else "pass" if licences else "warn",
               "Re-index the repository to check." if not known else ", ".join(licences) if licences else "No licence file at the top level.",
               "" if licences or not known else "Add a LICENSE (or a note that it's internal and who may use it).", licences)
    )  # fmt: skip
    doc_files = sorted(p for p in everything if DOCS.search(p))
    out.append(
        _check("docs", "Docs beyond the README", 1, "pass" if doc_files else "warn",
               f"{len(doc_files)} document(s), e.g. {', '.join(doc_files[:3])}." if doc_files else "Only the README.",
               "" if doc_files else "Add an architecture note and a runbook: how it works, how to debug and how to recover.",
               doc_files)
    )  # fmt: skip
    return out


def _npm_library(texts: dict[str, str]) -> bool:
    """A package.json at the top that's published (not private, with an entry point): a library, not an app."""

    try:
        pkg = json.loads(texts.get("package.json") or "{}")
    except ValueError:
        return False
    return (
        isinstance(pkg, dict)
        and not pkg.get("private")
        and any(k in pkg for k in ("main", "exports", "module", "files"))
    )


def score(items: list[dict[str, Any]]) -> dict[str, Any]:
    value = {"pass": 1.0, "warn": 0.5, "fail": 0.0}
    rated = [c for c in items if c["status"] in value]
    total = sum(c["weight"] for c in rated) or 1
    n = round(100 * sum(c["weight"] * value[c["status"]] for c in rated) / total)
    grade = "Ready to hand over" if n >= 80 else "Nearly there" if n >= 55 else "Needs work before the hand-over"
    return {"score": n, "grade": grade, "unknown": sum(1 for c in items if c["status"] == "unknown")}


def sessions(
    repo: dict[str, Any], f: dict[str, Any], items: list[dict[str, Any]], r: dict[str, Any], pack: dict | None
):
    """A hand-over meeting plan: run it together, walk through the main areas, then the risks and the checklist."""
    pack = pack or {}
    critical = [x["path"] for x in r["untested_critical"]]
    plan = [
        {
            "title": "Run it together", "minutes": 45,
            "goal": "The new owner runs it from a clean machine and knows where every setting comes from.",
            "open": (["README.md"] if repo.get("readme") else []) + f["entry_points"][:3],
            "ask": ["Walk through setup from scratch: what isn't in the README?"]
            + ([f"Where do the values for the {len(f['env'])} environment variables live, and who can rotate them?"] if f["env"] else [])
            + ["Which environments exist (local, staging, production) and how do you reach each?"],
        }
    ]  # fmt: skip
    for a in (pack.get("areas") or [])[:3]:
        files = a.get("paths") or []
        hot = [p for p in critical if any(p.startswith(posixpath.dirname(x) + "/") for x in files if "/" in x)][:2]
        plan.append({
            "title": a["name"], "minutes": 45, "goal": a.get("what") or "",
            "open": (files + hot)[:5],
            "ask": [f"What breaks if {p} changes? Nothing tests it yet." for p in hot]
            + ["What changes most often here, and what's fragile?", "What would you do differently if you built it again?"],
        })  # fmt: skip
    if not pack.get("areas"):
        for n in modules(repo["files"], repo.get("edges") or [])["nodes"][:2]:
            plan.append({"title": n["id"], "minutes": 45, "goal": f"Walk through {n['id']} ({n['files']} files).",
                         "open": [p for p in critical if p.startswith(n["id"] + "/")][:3],
                         "ask": ["What changes most often here, and what's fragile?"]})  # fmt: skip
    gaps = [c for c in items if c["status"] in ("fail", "warn")]
    plan.append({
        "title": "Risks and the checklist", "minutes": 30,
        "goal": "Agree who closes each gap the readiness check found, and by when.",
        "open": critical[:3],
        "ask": [f"{c['title']}: {c['fix']}" for c in gaps if c["fix"]][:5] + list(pack.get("questions") or [])[:3],
    })  # fmt: skip
    return plan


def starter(repo: dict[str, Any], f: dict[str, Any]) -> dict[str, str]:
    """Files to add that close common gaps. Names and paths only; never a value."""
    out: dict[str, str] = {}
    if f["env"]:
        lines = [
            f"# Environment variables {repo['owner']}/{repo['name']} reads (drafted by CodeLens from the code).",
            "# Fill in the values locally; never commit real secrets.",
            "",
        ]
        for e in f["env"]:
            lines += [f"# Read in {', '.join(e['files'])}", f"{e['name']}=", ""]
        out[".env.example"] = "\n".join(lines)
    has_owners = any(posixpath.basename(p).upper() == "CODEOWNERS" for p in repo.get("all_paths") or [])
    if not has_owners:
        tops = sorted({p.split("/", 1)[0] for p in repo["files"] if "/" in p})[:15]
        out["CODEOWNERS"] = "\n".join(
            ["# Draft CODEOWNERS from CodeLens: replace each @owner-to-fill with the real person or team.",
             "# Put it in .github/CODEOWNERS. Later lines win.", "*  @owner-to-fill"]
            + [f"/{t}/  @owner-to-fill" for t in tops]
        ) + "\n"  # fmt: skip
    return out


def assess(repo: dict[str, Any], chunks: list[dict[str, Any]], pack: dict[str, Any] | None = None) -> dict[str, Any]:
    """The whole readiness report for one indexed repository."""
    f = facts(repo, chunks)
    texts = file_texts(chunks)
    found = scan(chunks)
    items = checks(repo, f, texts, found, pack)
    r = risks(repo, f["tests"], found)
    return {
        **score(items),
        "checks": items,
        "risks": r,
        "modules": modules(repo["files"], repo.get("edges") or []),
        "sessions": sessions(repo, f, items, r, pack),
        "starter": starter(repo, f),
        "complete": repo.get("all_paths") is not None,
    }
