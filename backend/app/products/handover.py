"""CodeLens hand-over document: what an outgoing owner hands to the next one, as a file to download and share.

Built from two sources, kept apart on purpose:
  * the onboarding pack (written by the model from the README and file list; every path in it already checked
    against the index, commands already checked against the README), and
  * facts read straight from the indexed code (no model): languages, folders, manifests and dependencies,
    environment variable NAMES the code reads (never values), test files, CI workflows, entry points and the most
    connected files.
Anything only the outgoing owner can know (where it runs, who uses it, known issues, secrets) is left as a blank
checklist to fill in, never guessed. With a readiness report (readiness.py) the document also carries the readiness
score and its gaps, the module map, the risks and a hand-over meeting plan. Sections are numbered as they're built.

Pure functions (unit-tested); the route lives in codelens.py. Output: Markdown and a self-contained, printable HTML
page (open it and "Save as PDF").
"""

from __future__ import annotations

import html
import json
import posixpath
import re
from datetime import UTC, datetime
from typing import Any

ENV_PATTERNS = [
    re.compile(r"os\.environ(?:\.get)?\(\s*['\"]([A-Z][A-Z0-9_]{1,60})['\"]"),
    re.compile(r"os\.environ\[\s*['\"]([A-Z][A-Z0-9_]{1,60})['\"]\s*\]"),
    re.compile(r"os\.getenv\(\s*['\"]([A-Z][A-Z0-9_]{1,60})['\"]"),
    re.compile(r"process\.env\.([A-Z][A-Z0-9_]{1,60})\b"),
    re.compile(r"process\.env\[\s*['\"]([A-Z][A-Z0-9_]{1,60})['\"]\s*\]"),
    re.compile(r"import\.meta\.env\.([A-Z][A-Z0-9_]{1,60})\b"),
    re.compile(r"System\.getenv\(\s*\"([A-Z][A-Z0-9_]{1,60})\""),
    re.compile(r"os\.Getenv\(\s*\"([A-Z][A-Z0-9_]{1,60})\""),
    re.compile(r"ENV\[\s*['\"]([A-Z][A-Z0-9_]{1,60})['\"]\s*\]"),
    re.compile(r"env::var\(\s*\"([A-Z][A-Z0-9_]{1,60})\""),
]
MANIFESTS = {
    "package.json": "Node.js (npm)", "pyproject.toml": "Python (pyproject)", "requirements.txt": "Python (pip)",
    "setup.py": "Python (setuptools)", "go.mod": "Go modules", "Cargo.toml": "Rust (Cargo)", "pom.xml": "Java (Maven)",
    "build.gradle": "Java/Kotlin (Gradle)", "build.gradle.kts": "Kotlin (Gradle)", "Gemfile": "Ruby (Bundler)",
    "composer.json": "PHP (Composer)", "docker-compose.yml": "Docker Compose", "docker-compose.yaml": "Docker Compose",
}  # fmt: skip
TEST_FILE = re.compile(r"(^|/)(tests?|__tests__|spec)/|(^|/)test_[^/]+\.py$|_test\.(py|go)$|\.(test|spec)\.[jt]sx?$")
NOT_TESTS = re.compile(r"\.(ya?ml|json|toml|md|txt|cfg|ini|snap)$|(^|/)\.[^/]+$")  # config next to the tests
CI_FILE = re.compile(r"^\.github/workflows/[^/]+\.ya?ml$|(^|/)\.gitlab-ci\.ya?ml$|(^|/)\.circleci/config\.ya?ml$")
ENTRY_NAMES = {
    "main.py", "app.py", "__main__.py", "manage.py", "cli.py", "server.py", "wsgi.py", "asgi.py", "index.js", "index.ts",
    "server.js", "server.ts", "app.js", "app.ts", "main.js", "main.ts", "main.jsx", "main.tsx", "App.jsx", "App.tsx",
    "main.go", "main.rs", "lib.rs", "Main.java", "Application.java", "Program.cs",
}  # fmt: skip


def file_texts(chunks: list[dict[str, Any]]) -> dict[str, str]:
    """Each indexed file's text, put back together from its chunks (in line order)."""
    by_path: dict[str, list[dict[str, Any]]] = {}
    for c in chunks:
        by_path.setdefault(c["path"], []).append(c)
    return {p: "\n".join(c["text"] for c in sorted(cs, key=lambda c: c.get("start", 0))) for p, cs in by_path.items()}


def env_vars(texts: dict[str, str], limit: int = 40) -> list[dict[str, Any]]:
    """Environment variable names the code reads, with the files that read them. Names only, never values."""
    found: dict[str, set[str]] = {}
    for path, text in texts.items():
        for pat in ENV_PATTERNS:
            for name in pat.findall(text):
                found.setdefault(name, set()).add(path)
    rows = [{"name": n, "files": sorted(ps)[:3]} for n, ps in sorted(found.items())]
    return rows[:limit]


def dependencies(texts: dict[str, str], limit: int = 25) -> list[dict[str, Any]]:
    """Declared dependencies (names only) from the manifests that were indexed."""
    out: list[dict[str, Any]] = []
    for path, text in sorted(texts.items()):
        base = posixpath.basename(path)
        names: list[str] = []
        if base == "package.json":
            try:
                data = json.loads(text)
            except ValueError:
                continue
            names = list((data.get("dependencies") or {}).keys())
            dev = list((data.get("devDependencies") or {}).keys())
            if names or dev:
                out.append({"file": path, "runtime": names[:limit], "dev": dev[:limit]})
            continue
        if base == "requirements.txt":
            names = [re.split(r"[<>=!~\[; ]", ln.strip(), maxsplit=1)[0] for ln in text.splitlines()]
            names = [n for n in names if n and not n.startswith(("#", "-"))]
        elif base == "pyproject.toml":
            block = re.search(r"(?ms)^dependencies\s*=\s*\[(.*?)\]", text)
            if block:
                names = [
                    re.split(r"[<>=!~\[; ]", s, maxsplit=1)[0] for s in re.findall(r"['\"]([^'\"]+)['\"]", block[1])
                ]
        elif base == "go.mod":
            names = re.findall(r"(?m)^\s*([\w.\-]+/[\w.\-/]+)\s+v[\d.]+", text)
        elif base == "Cargo.toml":
            block = re.search(r"(?ms)^\[dependencies\](.*?)(^\[|\Z)", text)
            if block:
                names = re.findall(r"(?m)^([\w\-]+)\s*=", block[1])
        if names:
            out.append({"file": path, "runtime": sorted(set(names))[:limit], "dev": []})
    return out[:6]


def facts(repo: dict[str, Any], chunks: list[dict[str, Any]]) -> dict[str, Any]:
    """Everything the document states about the code itself, read from the index (no model)."""
    files: list[str] = repo["files"]
    meta: dict[str, str] = repo.get("meta") or {}  # small project files kept at indexing (requirements.txt…)
    texts = {**file_texts(chunks), **meta}
    listed = files + [p for p in meta if p not in set(files)]
    total = sum(repo["languages"].values()) or 1
    folders: dict[str, int] = {}
    for p in files:
        top = p.split("/", 1)[0] if "/" in p else "(root)"
        folders[top] = folders.get(top, 0) + 1
    degree: dict[str, int] = {}
    for a, b in repo.get("edges") or []:
        degree[a] = degree.get(a, 0) + 1
        degree[b] = degree.get(b, 0) + 2
    return {
        "languages": [
            {"name": k, "share": round(v * 100 / total)}
            for k, v in sorted(repo["languages"].items(), key=lambda kv: -kv[1])[:6]
        ],
        "lines": total,
        "files": len(files),
        "folders": sorted(folders.items(), key=lambda kv: (-kv[1], kv[0]))[:12],
        "manifests": [
            {"file": p, "kind": MANIFESTS[posixpath.basename(p)]} for p in listed if posixpath.basename(p) in MANIFESTS
        ][:10],
        "dependencies": dependencies(texts),
        "env": env_vars(texts),
        "tests": [p for p in files if TEST_FILE.search(p) and not NOT_TESTS.search(p)],
        "ci": [p for p in files if CI_FILE.search(p)],
        "entry_points": [p for p in files if posixpath.basename(p) in ENTRY_NAMES and p.count("/") <= 3][:10],
        "central": [p for p, _ in sorted(degree.items(), key=lambda kv: -kv[1]) if p in set(files)][:10],
    }


STATUS = {"pass": "Done", "warn": "Partly", "fail": "Missing", "unknown": "Not checked"}


def _renumber_md(text: str) -> str:
    n = 0

    def number(m: re.Match[str]) -> str:
        nonlocal n
        n += 1
        return f"## {n}. "

    return re.sub(r"(?m)^## (?:\d+\. )?", number, text)


def _renumber_html(page: str) -> str:
    n = 0

    def number(_: re.Match[str]) -> str:
        nonlocal n
        n += 1
        return f"<h2>{n}. "

    return re.sub(r"<h2>(?:\d+\. )?", number, page)


def _where(item: dict[str, Any]) -> str:
    return item["path"] + (f":{item['line']}" if item.get("line") else "")


def _date(now: datetime | None) -> str:
    return (now or datetime.now(UTC)).strftime("%d %b %Y")


def filename(repo: dict[str, Any], ext: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", f"{repo['owner']}-{repo['name']}").strip("-")
    return f"handover-{safe}.{ext}"


def markdown(
    repo: dict[str, Any],
    pack: dict[str, Any],
    f: dict[str, Any],
    now: datetime | None = None,
    ready: dict[str, Any] | None = None,
) -> str:
    """The hand-over document as Markdown (GitHub, Confluence, Notion and most wikis take it as is)."""
    code = lambda p: f"`{p}`"  # noqa: E731
    out: list[str] = [
        f"# Hand-over: {repo['owner']}/{repo['name']}",
        "",
        f"_Prepared with CodeLens on {_date(now)} from <{repo['url']}>"
        + (f" (branch `{repo['ref']}`)" if repo.get("ref") else "")
        + ". Every file path below exists in the indexed code; commands are copied from the README. Sections marked "
        "**To fill in** need the outgoing owner._",
        "",
        "## Summary",
        "",
        pack.get("purpose") or "_No summary yet._",
        "",
    ]
    if ready:
        out += [
            "## Hand-over readiness",
            "",
            f"**{ready['score']}/100: {ready['grade']}.** Checked by CodeLens from the code and the file list, not estimated.",
            "",
            "| Check | Status | What CodeLens found | To do |",
            "| --- | --- | --- | --- |",
        ]
        out += [
            f"| {c['title']} | {STATUS[c['status']]} | {c['detail']} | {c['fix'] or '—'} |".replace("\n", " ")
            for c in ready["checks"]
        ]
        out.append("")
    out += [
        "## How it fits together",
        "",
        pack.get("architecture") or "_Not described yet._",
        "",
    ]
    if ready and ready["modules"]["mermaid"]:
        out += [
            "Which part of the code uses which (from the imports; the numbers count imports):",
            "",
            "```mermaid",
            ready["modules"]["mermaid"],
            "```",
            "",
        ]
    out += [
        "## Tech stack",
        "",
        f"- **Size:** {f['files']} files, about {f['lines']:,} lines.",
        "- **Languages:** " + ", ".join(f"{x['name']} {x['share']}%" for x in f["languages"]) + ".",
    ]
    if f["manifests"]:
        out.append(
            "- **Build and packaging:** " + ", ".join(f"{m['kind']} ({code(m['file'])})" for m in f["manifests"]) + "."
        )
    for d in f["dependencies"]:
        if d["runtime"]:
            out.append(f"- **Dependencies in {code(d['file'])}:** " + ", ".join(d["runtime"]) + ".")
        if d["dev"]:
            out.append(f"- **Development-only in {code(d['file'])}:** " + ", ".join(d["dev"]) + ".")
    out += ["", "## Repository map", "", "| Folder | Files |", "| --- | ---: |"]
    out += [f"| {code(name)} | {n} |" for name, n in f["folders"]]
    out += ["", "## Main areas", ""]
    for a in pack.get("areas") or []:
        paths = ", ".join(code(p) for p in a.get("paths") or [])
        out.append(f"- **{a['name']}:** {a['what']}" + (f" Files: {paths}." if paths else ""))
    if not pack.get("areas"):
        out.append("_Not described yet._")
    out += ["", "## Key files", ""]
    if f["entry_points"]:
        out.append("- **Entry points:** " + ", ".join(code(p) for p in f["entry_points"]) + ".")
    if f["central"]:
        out.append("- **Most connected (imported by many others):** " + ", ".join(code(p) for p in f["central"]) + ".")
    if ready:
        r = ready["risks"]
        out += ["", "## Risks to know", ""]
        if r["untested_critical"]:
            out.append("- **Many files depend on these, and no test touches them:** " + ", ".join(
                f"{code(x['path'])} (used by {x['used_by']})" for x in r["untested_critical"]) + ".")  # fmt: skip
        if r["large"]:
            out.append("- **Biggest files (read them with the outgoing owner):** " + ", ".join(
                f"{code(x['path'])} ({x['lines']:,} lines)" for x in r["large"]) + ".")  # fmt: skip
        if r["secrets"]:
            out.append("- **Possible secrets in the code (rotate and remove):** " + ", ".join(
                f"{x['kind']} in {code(_where(x))}" for x in r["secrets"][:8]) + ".")  # fmt: skip
        if r["debt_total"]:
            out.append(f"- **{r['debt_total']} TODO / FIXME / HACK notes**, for example:")
            out += [f"  - {code(_where(x))} {x['tag']}: {x['text']}" for x in r["debt"][:6]]
        if not (r["untested_critical"] or r["large"] or r["secrets"] or r["debt_total"]):
            out.append("Nothing stood out in the indexed code.")
    out += ["", "## Run, test and ship", ""]
    if pack.get("run"):
        out += ["From the README:", "", "```sh", *pack["run"], "```", ""]
    else:
        out += ["The README lists no setup commands. **To fill in:** how to run it locally.", ""]
    out.append(
        f"- **Tests:** {len(f['tests'])} test file(s)"
        + (
            ", for example " + ", ".join(code(p) for p in f["tests"][:4])
            if f["tests"]
            else "; none found in the indexed code"
        )
        + "."
    )
    out.append(
        "- **CI:** "
        + (", ".join(code(p) for p in f["ci"]) if f["ci"] else "no CI workflow found in the indexed code")
        + "."
    )
    out += ["", "## Configuration", ""]
    if f["env"]:
        out += [
            "Environment variables the code reads (names only; get the values from the outgoing owner, never from chat or email):",
            "",
        ]
        out += ["| Variable | Read in |", "| --- | --- |"]
        out += [f"| {code(e['name'])} | " + ", ".join(code(p) for p in e["files"]) + " |" for e in f["env"]]
    else:
        out.append("No environment variables found in the indexed code.")
    out += ["", "## What to read first", ""]
    for i, s in enumerate(pack.get("reading_path") or [], 1):
        out.append(f"{i}. **{s['title']}** ({code(s['path'])}): {s['explanation']}")
    if ready:
        out += ["", "## Hand-over sessions", "", "A plan for the meetings with the outgoing owner:", ""]
        for i, m in enumerate(ready["sessions"], 1):
            out.append(f"**Session {i}: {m['title']}** ({m['minutes']} min). {m['goal']}")
            if m["open"]:
                out.append("- Open: " + ", ".join(code(p) for p in m["open"]))
            out += [f"- Ask: {q}" for q in m["ask"]]
            out.append("")
    out += ["", "## First week for the new owner", ""]
    for d in pack.get("week_plan") or []:
        out.append(f"**Day {d['day']}: {d['goal']}**")
        out += [
            f"- [ ] {t['text']}"
            + (" (" + ", ".join(code(p) for p in t.get("paths") or []) + ")" if t.get("paths") else "")
            for t in d.get("tasks") or []
        ]
        if d.get("checkpoint"):
            out.append(f"- Checkpoint: {d['checkpoint']}")
        out.append("")
    out += ["## Questions for the hand-over meeting", ""]
    out += [f"- {q}" for q in pack.get("questions") or []]
    out += [
        "",
        "## To fill in by the outgoing owner",
        "",
        "- [ ] **Where it runs:** environments, URLs, how it's deployed and who can deploy.",
        "- [ ] **Access:** repository, CI, cloud and third-party accounts the new owner needs.",
        "- [ ] **Secrets:** where each variable under Configuration is stored and who can rotate it.",
        "- [ ] **Who uses it:** teams, customers or services that depend on it, and how to reach them.",
        "- [ ] **Known issues and risks:** open bugs, fragile areas, debt worth knowing about.",
        "- [ ] **In flight:** open pull requests, half-done work and upcoming deadlines.",
        "- [ ] **People:** who to ask about what.",
        "",
    ]
    if ready and ready["starter"]:
        out += [
            "CodeLens drafted "
            + " and ".join(code(n) for n in ready["starter"])
            + " to start from (in the CodeLens app).",
            "",
        ]
    return _renumber_md("\n".join(out))


_CSS = """
:root{--ink:#1d1d1f;--muted:#5f6368;--line:#e3e3e8;--chip:#f4f4f6;--accent:#e8590c}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:15px/1.6 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:48px 24px 72px}h1{font-size:30px;line-height:1.2;margin:0 0 6px}
h2{font-size:19px;margin:36px 0 10px;padding-top:14px;border-top:1px solid var(--line)}p,li{margin:6px 0}
.meta{color:var(--muted);font-size:13px}code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--chip);
padding:1px 5px;border-radius:5px;word-break:break-word}pre{background:#0f1115;color:#c8f7c5;padding:14px;border-radius:10px;
overflow:auto;font:12.5px/1.5 ui-monospace,Consolas,monospace}table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{text-align:left;border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top}td.n{text-align:right}
.day{margin:14px 0 4px;font-weight:600}.score{font-size:17px}.s-pass{color:#137333}.s-warn{color:#b06000}
.s-fail{color:#c5221f;font-weight:600}.s-unknown{color:var(--muted)}.todo li{list-style:none}.todo li::before{content:"\\2610  ";color:var(--muted)}
.fill{background:#fff8f2;border:1px solid #ffd8bf;border-radius:12px;padding:6px 18px}
.bar{display:flex;gap:8px;margin:18px 0 0}.bar button{font:inherit;font-size:13px;padding:7px 14px;border-radius:999px;
border:1px solid var(--line);background:#fff;cursor:pointer}@media print{.bar{display:none}main{padding:0}h2{break-after:avoid}
pre,table,li{break-inside:avoid}}
"""


def to_html(
    repo: dict[str, Any],
    pack: dict[str, Any],
    f: dict[str, Any],
    now: datetime | None = None,
    ready: dict[str, Any] | None = None,
) -> str:
    """The same document as one printable HTML page (no scripts from elsewhere, no external assets)."""
    e = html.escape
    c = lambda p: f"<code>{e(p)}</code>"  # noqa: E731
    title = f"Hand-over: {repo['owner']}/{repo['name']}"
    parts: list[str] = [
        f"<h1>{e(title)}</h1>",
        f'<p class=meta>Prepared with CodeLens on {_date(now)} from <a href="{e(repo["url"])}">{e(repo["url"])}</a>'
        + (f" (branch {c(repo['ref'])})" if repo.get("ref") else "")
        + ". Every file path exists in the indexed code; commands are copied from the README.</p>",
        '<div class=bar><button onclick="print()">Print or save as PDF</button></div>',
        "<h2>Summary</h2>",
        f"<p>{e(pack.get('purpose') or 'No summary yet.')}</p>",
    ]
    if ready:
        parts.append(
            f"<h2>Hand-over readiness</h2><p class=score><b>{ready['score']}/100</b> {e(ready['grade'])}</p>"
            "<table><tr><th>Check</th><th>Status</th><th>What CodeLens found</th><th>To do</th></tr>"
        )
        parts += [
            f"<tr><td>{e(c['title'])}</td><td class=s-{c['status']}>{STATUS[c['status']]}</td><td>{e(c['detail'])}</td>"
            f"<td>{e(c['fix'] or '—')}</td></tr>"
            for c in ready["checks"]
        ]
        parts.append("</table>")
    parts += [
        "<h2>How it fits together</h2>",
        f"<p>{e(pack.get('architecture') or 'Not described yet.')}</p>",
    ]
    if ready and ready["modules"]["edges"]:
        parts.append(
            "<p class=meta>Which part of the code uses which (from the imports):</p><table><tr><th>From</th><th>Uses</th><th>Imports</th></tr>"
        )
        parts += [
            f"<tr><td>{c(m['from'])}</td><td>{c(m['to'])}</td><td class=n>{m['imports']}</td></tr>"
            for m in ready["modules"]["edges"][:12]
        ]
        parts.append("</table>")
    parts += [
        "<h2>Tech stack</h2><ul>",
        f"<li><b>Size:</b> {f['files']} files, about {f['lines']:,} lines.</li>",
        "<li><b>Languages:</b> " + e(", ".join(f"{x['name']} {x['share']}%" for x in f["languages"])) + ".</li>",
    ]
    if f["manifests"]:
        parts.append(
            "<li><b>Build and packaging:</b> "
            + ", ".join(f"{e(m['kind'])} ({c(m['file'])})" for m in f["manifests"])
            + ".</li>"
        )
    for d in f["dependencies"]:
        if d["runtime"]:
            parts.append(f"<li><b>Dependencies in {c(d['file'])}:</b> {e(', '.join(d['runtime']))}.</li>")
        if d["dev"]:
            parts.append(f"<li><b>Development-only in {c(d['file'])}:</b> {e(', '.join(d['dev']))}.</li>")
    parts.append("</ul><h2>Repository map</h2><table><tr><th>Folder</th><th>Files</th></tr>")
    parts += [f"<tr><td>{c(name)}</td><td class=n>{n}</td></tr>" for name, n in f["folders"]]
    parts.append("</table><h2>Main areas</h2><ul>")
    for a in pack.get("areas") or []:
        paths = ", ".join(c(p) for p in a.get("paths") or [])
        parts.append(f"<li><b>{e(a['name'])}:</b> {e(a['what'])}" + (f" Files: {paths}." if paths else "") + "</li>")
    parts.append("</ul><h2>Key files</h2><ul>")
    if f["entry_points"]:
        parts.append("<li><b>Entry points:</b> " + ", ".join(c(p) for p in f["entry_points"]) + ".</li>")
    if f["central"]:
        parts.append("<li><b>Most connected:</b> " + ", ".join(c(p) for p in f["central"]) + ".</li>")
    parts.append("</ul>")
    if ready:
        r = ready["risks"]
        rows = []
        if r["untested_critical"]:
            rows.append("<li><b>Many files depend on these, and no test touches them:</b> " + ", ".join(
                f"{c(x['path'])} (used by {x['used_by']})" for x in r["untested_critical"]) + ".</li>")  # fmt: skip
        if r["large"]:
            rows.append(
                "<li><b>Biggest files:</b> "
                + ", ".join(f"{c(x['path'])} ({x['lines']:,} lines)" for x in r["large"])
                + ".</li>"
            )
        if r["secrets"]:
            rows.append("<li><b>Possible secrets (rotate and remove):</b> " + ", ".join(
                f"{e(x['kind'])} in {c(_where(x))}" for x in r["secrets"][:8]) + ".</li>")  # fmt: skip
        if r["debt_total"]:
            rows.append(f"<li><b>{r['debt_total']} TODO / FIXME / HACK notes</b>, for example: " + "; ".join(
                f"{c(_where(x))} {e(x['tag'])}: {e(x['text'])}" for x in r["debt"][:5]) + ".</li>")  # fmt: skip
        parts.append(
            "<h2>Risks to know</h2><ul>"
            + ("".join(rows) or "<li>Nothing stood out in the indexed code.</li>")
            + "</ul>"
        )
    parts.append("<h2>Run, test and ship</h2>")
    parts.append(
        f"<pre>{e(chr(10).join(pack['run']))}</pre>"
        if pack.get("run")
        else "<p>The README lists no setup commands. <b>To fill in:</b> how to run it locally.</p>"
    )
    parts.append(
        f"<ul><li><b>Tests:</b> {len(f['tests'])} test file(s)"
        + (
            ", for example " + ", ".join(c(p) for p in f["tests"][:4])
            if f["tests"]
            else "; none found in the indexed code"
        )
        + ".</li><li><b>CI:</b> "
        + (", ".join(c(p) for p in f["ci"]) if f["ci"] else "no CI workflow found in the indexed code")
        + ".</li></ul><h2>Configuration</h2>"
    )
    if f["env"]:
        parts.append(
            "<p>Environment variables the code reads (names only; get the values from the outgoing owner).</p><table><tr><th>Variable</th><th>Read in</th></tr>"
        )
        parts += [f"<tr><td>{c(v['name'])}</td><td>{', '.join(c(p) for p in v['files'])}</td></tr>" for v in f["env"]]
        parts.append("</table>")
    else:
        parts.append("<p>No environment variables found in the indexed code.</p>")
    parts.append("<h2>What to read first</h2><ol>")
    parts += [
        f"<li><b>{e(s['title'])}</b> ({c(s['path'])}): {e(s['explanation'])}</li>"
        for s in pack.get("reading_path") or []
    ]
    parts.append("</ol>")
    if ready:
        parts.append("<h2>Hand-over sessions</h2>")
        for i, m in enumerate(ready["sessions"], 1):
            parts.append(
                f"<p class=day>Session {i}: {e(m['title'])} <span class=meta>({m['minutes']} min)</span></p><p>{e(m['goal'])}</p><ul>"
            )
            if m["open"]:
                parts.append("<li>Open: " + ", ".join(c(p) for p in m["open"]) + "</li>")
            parts += [f"<li>Ask: {e(q)}</li>" for q in m["ask"]]
            parts.append("</ul>")
    parts.append("<h2>First week for the new owner</h2>")
    for d in pack.get("week_plan") or []:
        parts.append(f"<p class=day>Day {d['day']}: {e(d['goal'])}</p><ul class=todo>")
        for t in d.get("tasks") or []:
            paths = ", ".join(c(p) for p in t.get("paths") or [])
            parts.append(f"<li>{e(t['text'])}" + (f" ({paths})" if paths else "") + "</li>")
        parts.append("</ul>" + (f"<p class=meta>Checkpoint: {e(d['checkpoint'])}</p>" if d.get("checkpoint") else ""))
    parts.append("<h2>Questions for the hand-over meeting</h2><ul>")
    parts += [f"<li>{e(q)}</li>" for q in pack.get("questions") or []]
    parts.append(
        "</ul><h2>To fill in by the outgoing owner</h2><div class=fill><ul class=todo>"
        "<li><b>Where it runs:</b> environments, URLs, how it's deployed and who can deploy.</li>"
        "<li><b>Access:</b> repository, CI, cloud and third-party accounts the new owner needs.</li>"
        "<li><b>Secrets:</b> where each variable under Configuration is stored and who can rotate it.</li>"
        "<li><b>Who uses it:</b> teams, customers or services that depend on it, and how to reach them.</li>"
        "<li><b>Known issues and risks:</b> open bugs, fragile areas, debt worth knowing about.</li>"
        "<li><b>In flight:</b> open pull requests, half-done work and upcoming deadlines.</li>"
        "<li><b>People:</b> who to ask about what.</li></ul></div>"
    )
    return (
        '<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">'
        f"<title>{e(title)}</title><style>{_CSS}</style></head><body><main>"
        + _renumber_html("".join(parts))
        + "</main></body></html>"
    )
