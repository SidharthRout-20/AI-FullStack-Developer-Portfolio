"""Deterministic artifact parsing for EFI: no LLM here.

Each parser turns one (already redacted) artifact into raw evidence items. Evidence IDs (EV-001…) are assigned
later, after all artifacts are parsed, in a deterministic order, so the same input always yields the same IDs.

Supported: build / CI / deploy logs (GitHub Actions, GitLab, Jenkins, npm, pytest, Maven, Gradle, Docker…), stack
traces (Python, JS/TS, Java/Kotlin, Go), compiler-style `file:line` errors, unified git diffs (including dependency
version changes inside manifest diffs), JUnit XML, dependency manifests and config files.
"""

from __future__ import annotations

import json
import posixpath
import re
import xml.etree.ElementTree as ET  # noqa: S405 - DTDs/entities are rejected before parsing (see parse_junit)
from dataclasses import dataclass, field
from typing import Any

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
SNIPPET = 500  # max characters of content kept per evidence item

ARCHIVE_EXT = (".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war", ".whl")
TEXT_EXT = (
    ".log",
    ".txt",
    ".out",
    ".err",
    ".trace",
    ".diff",
    ".patch",
    ".xml",
    ".json",
    ".lock",
    ".toml",
    ".yaml",
    ".yml",
    ".ini",
    ".cfg",
    ".conf",
    ".env",
    ".md",
    ".mod",
    ".sum",
    ".gradle",
    ".properties",
    ".csv",
)
KNOWN_NAMES = {"dockerfile", "makefile", "pipfile", "gemfile", "procfile", "jenkinsfile", "go.mod", "go.sum", ".env"}
MANIFESTS = {
    "requirements.txt",
    "requirements-dev.txt",
    "requirements.in",
    "constraints.txt",
    "pyproject.toml",
    "poetry.lock",
    "pipfile",
    "pipfile.lock",
    "setup.cfg",
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "go.mod",
    "go.sum",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "gemfile",
    "gemfile.lock",
    "cargo.toml",
    "cargo.lock",
    "composer.json",
    "composer.lock",
}
CONFIG_EXT = (".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".env", ".properties", ".json")
CODE_EXT = (
    "py",
    "js",
    "jsx",
    "ts",
    "tsx",
    "mjs",
    "cjs",
    "go",
    "rs",
    "java",
    "kt",
    "kts",
    "scala",
    "groovy",
    "c",
    "cc",
    "cpp",
    "h",
    "hpp",
    "cs",
    "rb",
    "php",
    "swift",
    "vue",
    "svelte",
    "dart",
)
KINDS = ("log", "stacktrace", "diff", "junit", "manifest", "config", "notes")


@dataclass
class Item:
    """One evidence item before its ID is assigned."""

    kind: str  # error | exception | stack_frame | source_reference | test_failure | test_summary | diff_file |
    #            diff_hunk | dependency_change | dependency | command | stage | config_line | note
    artifact: int  # index of the artifact in submission order
    line: int | None
    content: str
    attrs: dict[str, Any] = field(default_factory=dict)
    status: str = "parsed"  # parsed | partial (truncated / approximate location) | user_provided

    def key(self) -> tuple[int, int, int, str]:
        return (
            self.artifact,
            self.line if self.line is not None else 10**9,
            KIND_ORDER.get(self.kind, 99),
            self.content,
        )


KIND_ORDER = {
    k: i
    for i, k in enumerate(
        (
            "stage",
            "command",
            "diff_file",
            "diff_hunk",
            "dependency_change",
            "error",
            "exception",
            "source_reference",
            "stack_frame",
            "test_failure",
            "test_summary",
            "dependency",
            "config_line",
            "note",
        )
    )
}


def clip(text: str, n: int = SNIPPET) -> str:
    text = text.strip()
    return text if len(text) <= n else text[: n - 1] + "…"


def norm_path(p: str) -> str:
    """Comparable path: forward slashes, no `./`, `a/`/`b/` diff prefixes or Windows drive."""
    p = p.strip().strip("'\"").replace("\\", "/")
    p = re.sub(r"^[A-Za-z]:/", "/", p)
    p = re.sub(r"^(?:\./)+", "", p)
    return posixpath.normpath(p) if p else p


def same_file(a: str, b: str) -> bool:
    """True when two references point at the same repo file (absolute CI paths end with the repo-relative path)."""
    a, b = norm_path(a), norm_path(b)
    if not a or not b:
        return False
    if a == b:
        return True
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    return "/" in short and long_.endswith("/" + short)


# ── kind detection ─────────────────────────────────────────────────────────
def detect_kind(name: str, content: str) -> str:
    low = name.lower()
    base = posixpath.basename(low)
    head = content[:4000]
    if low.endswith(".xml") and re.search(r"<testsuites?\b", head):
        return "junit"
    if (
        low.endswith((".diff", ".patch"))
        or re.search(r"^diff --git ", head, re.M)
        or (re.search(r"^--- ", head, re.M) and re.search(r"^\+\+\+ ", head, re.M) and re.search(r"^@@ ", head, re.M))
    ):
        return "diff"
    if base in MANIFESTS or re.fullmatch(r"requirements[\w.-]*\.txt", base):
        return "manifest"
    if low.endswith(CONFIG_EXT) or base in {"dockerfile", "makefile", "procfile", "jenkinsfile"}:
        return "config"
    return "log"


def allowed_name(name: str) -> bool:
    low = name.lower()
    base = posixpath.basename(low)
    return low.endswith(TEXT_EXT) or base in KNOWN_NAMES or base in MANIFESTS or "." not in base


# ── logs & stack traces ────────────────────────────────────────────────────
TIMESTAMP = re.compile(
    r"^\s*\[?(?P<ts>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s?"
)
STAGE_PATTERNS = [
    re.compile(r"^##\[group\](?P<s>.+)"),  # GitHub Actions
    re.compile(r"^section_start:\d+:(?P<s>\S+)"),  # GitLab
    re.compile(r"^\[Pipeline\] \{? ?\(?(?P<s>[^)]+)\)?$"),  # Jenkins (stage)
    re.compile(r"^Step (?P<s>\d+/\d+ : .+)"),  # docker build
    re.compile(r"^#\d+ \[(?P<s>[^\]]+)\]"),  # buildkit
    re.compile(r"^> Task (?P<s>:\S+)"),  # gradle
    re.compile(r"^\[INFO\] --- (?P<s>.+) ---$"),  # maven
    re.compile(r"^==> (?P<s>.+)"),
]
COMMAND_PATTERNS = [
    re.compile(r"^##\[group\]Run (?P<c>.+)"),
    re.compile(r"^Run (?P<c>(?!s?\d)\S.+)"),
    re.compile(r"^\$ (?P<c>\S.+)"),
    re.compile(r"^\+ (?P<c>[a-zA-Z.\/][\w./-]*(?:\s.+)?)$"),  # `set -x` trace
    re.compile(r"^> (?P<c>(?!Task )[a-z][\w.@/-]*(?: .+)?)$"),  # npm / yarn script echo
]
ERROR_PATTERNS = [
    re.compile(r"^##\[error\](?P<m>.+)"),
    re.compile(r"(?P<m>(?:Process completed|exited|failed) with exit code \d+.*)", re.I),
    re.compile(r"^(?P<m>npm ERR! .+|ERR_PNPM_\S+.*|error Command failed.*)"),
    re.compile(r"^(?P<m>(?:FAILED|ERROR) [\w./\\:-]+::\S+.*)"),  # pytest short summary
    re.compile(r"^(?P<m>\[ERROR\] .+)"),  # maven
    re.compile(r"^(?P<m>(?:BUILD FAILED|FAILURE: Build failed).*)"),
    re.compile(r"^(?P<m>(?:error|fatal)(?:\[[A-Z]?\d+\])?: .+)"),  # rustc, git, gcc
    re.compile(r"^(?P<m>Error: .+)"),  # node
    re.compile(r"(?P<m>\b(?:ERROR|FATAL|CRITICAL)\b[:\]]? .+)"),
]
EXCEPTION = re.compile(
    r"^(?:Exception in thread \"[^\"]*\" |Caused by: |Uncaught |Unhandled (?:promise )?rejection:? )?"
    r"(?P<type>[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:Error|Exception|Exit|Interrupt|Failure|Fault))"
    r"(?::\s*(?P<msg>.*))?$"
)
PY_FRAME = re.compile(r'^\s*File "(?P<file>[^"]+)", line (?P<line>\d+)(?:, in (?P<func>\S+))?')
JS_FRAME = re.compile(
    r"^\s*at (?:(?P<func>[^\s(][^(]*?) \()?(?P<file>(?:[A-Za-z]:)?[^\s():]+):(?P<line>\d+):\d+\)?\s*$"
)
JVM_FRAME = re.compile(r"^\s*at (?P<func>[\w$.<>]+)\((?P<file>[\w$-]+\.(?:java|kt|scala|groovy)):(?P<line>\d+)\)")
GO_FRAME = re.compile(r"^\s+(?P<file>/?[\w./-]+\.go):(?P<line>\d+)(?: \+0x[0-9a-f]+)?\s*$")
EXTS = "|".join(CODE_EXT)
SOURCE_REF = re.compile(
    rf"^(?P<file>(?:[A-Za-z]:)?[\w./\\@-]+\.(?:{EXTS}))(?::(?P<line>\d+)(?::\d+)?|\((?P<line2>\d+),\d+\))[:\s]+(?P<msg>.*\S)"
)
PYTEST_SUMMARY = re.compile(r"^=+ (?P<m>.*\b\d+ (?:failed|errors?)\b.*) =+$")
JEST_FAIL = re.compile(r"^\s*● (?P<m>.+ › .+)$")
PYTEST_E = re.compile(r"^E\s{2,}")
LIBRARY = re.compile(r"(?:site-packages|dist-packages|node_modules|/usr/lib/|/lib/python\d|<frozen |internal/)")
MAX_ERRORS = 60
MAX_FRAMES = 80


def clean_lines(content: str) -> list[str]:
    return ANSI.sub("", content).replace("\r\n", "\n").replace("\r", "\n").split("\n")


def _strip_ts(line: str) -> tuple[str | None, str]:
    m = TIMESTAMP.match(line)
    return (m["ts"], line[m.end() :]) if m else (None, line)


def parse_log(idx: int, content: str) -> list[Item]:  # noqa: C901 - one pass over the lines, one rule per shape
    items: list[Item] = []
    stage: str | None = None
    errors = frames = 0
    seen_errors: set[str] = set()
    for n, raw in enumerate(clean_lines(content), start=1):
        ts, line = _strip_ts(raw)
        text = PYTEST_E.sub("", line.strip())  # pytest prints assertion details as "E   AssertionError: …"
        if not text:
            continue
        base = {"timestamp": ts} if ts else {}
        if stage:
            base["stage"] = stage
        for p in STAGE_PATTERNS:
            if m := p.match(text):
                stage = clip(m["s"], 120)
                items.append(Item("stage", idx, n, stage, {**base, "stage": stage}))
                break
        for p in COMMAND_PATTERNS:
            if m := p.match(text):
                items.append(Item("command", idx, n, clip(m["c"], 300), {**base, "command": clip(m["c"], 300)}))
                break
        if text.startswith("Traceback (most recent call last)"):
            continue
        frame = PY_FRAME.match(line) or JVM_FRAME.match(line) or JS_FRAME.match(line) or GO_FRAME.match(line)
        if frame and frames < MAX_FRAMES:
            frames += 1
            f = frame.groupdict()
            items.append(
                Item(
                    "stack_frame",
                    idx,
                    n,
                    clip(text, 300),
                    {
                        **base,
                        "file": norm_path(f["file"]),
                        "line": int(f["line"]),
                        "function": (f.get("func") or "").strip() or None,
                        "library": bool(LIBRARY.search(f["file"])),
                    },
                )
            )
            continue
        if m := SOURCE_REF.match(text):
            items.append(
                Item(
                    "source_reference",
                    idx,
                    n,
                    clip(text),
                    {
                        **base,
                        "file": norm_path(m["file"]),
                        "line": int(m["line"] or m["line2"]),
                        "message": clip(m["msg"], 300),
                    },
                )
            )
            continue
        if m := EXCEPTION.match(text):
            key = text[:200]
            if key not in seen_errors and errors < MAX_ERRORS:
                seen_errors.add(key)
                errors += 1
                items.append(
                    Item(
                        "exception",
                        idx,
                        n,
                        clip(text),
                        {**base, "type": m["type"], "message": clip(m["msg"] or "", 300)},
                    )
                )
            continue
        if m := PYTEST_SUMMARY.match(text):
            items.append(Item("test_summary", idx, n, clip(m["m"]), base))
            continue
        if m := JEST_FAIL.match(text):
            items.append(
                Item("test_failure", idx, n, clip(m["m"]), {**base, "test": clip(m["m"], 200), "source": "log"})
            )
            continue
        for p in ERROR_PATTERNS:
            if m := p.search(text):
                key = text[:200]
                if key not in seen_errors and errors < MAX_ERRORS:
                    seen_errors.add(key)
                    errors += 1
                    code = re.search(r"exit code (\d+)", text, re.I)
                    items.append(
                        Item("error", idx, n, clip(text), {**base, **({"exit_code": int(code[1])} if code else {})})
                    )
                break
    if errors >= MAX_ERRORS or frames >= MAX_FRAMES:
        for it in items:
            if it.kind in ("error", "exception", "stack_frame"):
                it.status = "partial"
    return items


# ── unified diffs ──────────────────────────────────────────────────────────
DIFF_GIT = re.compile(r"^diff --git a/(?P<a>.+?) b/(?P<b>.+)$")
HUNK = re.compile(r"^@@ -(?P<os>\d+)(?:,(?P<ol>\d+))? \+(?P<ns>\d+)(?:,(?P<nl>\d+))? @@(?P<ctx>.*)$")
DEP_RULES = [
    re.compile(r"^(?P<pkg>[A-Za-z0-9][A-Za-z0-9_.\-\[\]]*)\s*(?P<op>==|>=|<=|~=|!=|>|<|===)\s*(?P<ver>[^\s;#,]+)"),
    re.compile(r"^\s*\"(?P<pkg>@?[\w.\-]+(?:/[\w.\-]+)?)\"\s*:\s*\"(?P<ver>[~^<>=*\d][^\"]*)\""),  # package.json
    re.compile(r"^\s*(?P<pkg>[A-Za-z0-9][\w.\-]*)\s*=\s*\"(?P<ver>[~^<>=*\d][^\"]*)\""),  # pyproject / Cargo
    re.compile(r"^\s*\"(?P<pkg>[A-Za-z0-9][\w.\-]*)\s*(?P<op>[<>=!~]=?)\s*(?P<ver>[^\"]+)\""),  # PEP 621 arrays
    re.compile(r"^\s*(?:require\s+)?(?P<pkg>[\w.\-]+\.[\w.\-/]+)\s+(?P<ver>v\d[\w.\-+]*)"),  # go.mod
]
MAX_HUNK_LINES = 14


def dep_of(line: str) -> tuple[str, str] | None:
    for rule in DEP_RULES:
        if m := rule.match(line):
            return m["pkg"].split("[")[0], m["ver"].strip()
    return None


def _is_manifest(path: str) -> bool:
    base = posixpath.basename(path.lower())
    return base in MANIFESTS or bool(re.fullmatch(r"requirements[\w.-]*\.txt", base))


def parse_diff(idx: int, content: str) -> list[Item]:  # noqa: C901
    items: list[Item] = []
    lines = clean_lines(content)
    file: dict[str, Any] | None = None
    hunk: dict[str, Any] | None = None
    removed: dict[str, tuple[str, int]] = {}
    added: dict[str, tuple[str, int]] = {}

    def close_hunk() -> None:
        nonlocal hunk
        if hunk and file:
            snippet = "\n".join(hunk["body"][:MAX_HUNK_LINES])
            items.append(
                Item(
                    "diff_hunk",
                    idx,
                    hunk["at"],
                    clip(f"{file['path']} {hunk['header']}\n{snippet}"),
                    {
                        "file": file["path"],
                        "new_start": hunk["ns"],
                        "new_end": hunk["ns"] + max(hunk["nl"] - 1, 0),
                        "old_start": hunk["os"],
                        "old_end": hunk["os"] + max(hunk["ol"] - 1, 0),
                    },
                    "partial" if len(hunk["body"]) > MAX_HUNK_LINES else "parsed",
                )
            )
        hunk = None

    def close_file() -> None:
        nonlocal file
        close_hunk()
        if file:
            items.append(
                Item(
                    "diff_file",
                    idx,
                    file["at"],
                    f"{file['status']}: {file['path']} (+{file['added']} −{file['removed']})",
                    {
                        "file": file["path"],
                        "status": file["status"],
                        "added": file["added"],
                        "removed": file["removed"],
                    },
                )
            )
            if _is_manifest(file["path"]):
                for pkg in sorted(set(removed) | set(added)):
                    old, new = removed.get(pkg), added.get(pkg)
                    if old and new and old[0] == new[0]:
                        continue
                    change = "upgraded/changed" if old and new else "added" if new else "removed"
                    text = f"{pkg}: {old[0] if old else '∅'} → {new[0] if new else '∅'} in {file['path']}"
                    items.append(
                        Item(
                            "dependency_change",
                            idx,
                            (new or old)[1],
                            text,
                            {  # type: ignore[index]
                                "package": pkg,
                                "old": old[0] if old else None,
                                "new": new[0] if new else None,
                                "file": file["path"],
                                "change": change,
                            },
                        )
                    )
        removed.clear()
        added.clear()
        file = None

    for n, line in enumerate(lines, start=1):
        if m := DIFF_GIT.match(line):
            close_file()
            file = {"path": norm_path(m["b"]), "status": "modified", "added": 0, "removed": 0, "at": n}
            continue
        if line.startswith("--- ") and (n < len(lines) and lines[n].startswith("+++ ")):
            if file is None or hunk is not None:
                close_file()
                file = {"path": "", "status": "modified", "added": 0, "removed": 0, "at": n}
            old = line[4:].split("\t")[0].strip()
            if old == "/dev/null":
                file["status"] = "added"
            continue
        if line.startswith("+++ ") and file is not None and hunk is None:
            new = line[4:].split("\t")[0].strip()
            if new == "/dev/null":
                file["status"] = "deleted"
            else:
                file["path"] = norm_path(re.sub(r"^b/", "", new))
            continue
        if file is None:
            continue
        if line.startswith(("new file mode", "deleted file mode", "rename from", "rename to")):
            file["status"] = {"new": "added", "deleted": "deleted"}.get(line.split()[0], "renamed")
            continue
        if m := HUNK.match(line):
            close_hunk()
            hunk = {
                "os": int(m["os"]),
                "ol": int(m["ol"] or 1),
                "ns": int(m["ns"]),
                "nl": int(m["nl"] or 1),
                "header": line[: line.index("@@", 2) + 2],
                "body": [],
                "at": n,
            }
            continue
        if hunk is None:
            continue
        if line.startswith("+") and not line.startswith("+++"):
            file["added"] += 1
            hunk["body"].append(line)
            if _is_manifest(file["path"]) and (dep := dep_of(line[1:])):
                added.setdefault(dep[0].lower(), (dep[1], n))
        elif line.startswith("-") and not line.startswith("---"):
            file["removed"] += 1
            hunk["body"].append(line)
            if _is_manifest(file["path"]) and (dep := dep_of(line[1:])):
                removed.setdefault(dep[0].lower(), (dep[1], n))
    close_file()
    return [i for i in items if i.attrs.get("file") or i.kind != "diff_file"]


# ── JUnit XML ──────────────────────────────────────────────────────────────
class ArtifactError(ValueError):
    """The artifact can't be processed (malformed, unsafe or unsupported). The message is user-facing."""


def parse_junit(idx: int, content: str) -> list[Item]:
    if re.search(r"<!(?:DOCTYPE|ENTITY)", content, re.I):
        raise ArtifactError("JUnit XML with DOCTYPE or ENTITY declarations is not accepted.")
    try:
        # bytes: a str with an `encoding=` declaration is rejected by ElementTree
        root = ET.fromstring(content.encode("utf-8"))  # noqa: S314 - no DTD/entities allowed (checked above)
    except (ET.ParseError, ValueError) as exc:
        raise ArtifactError(f"Malformed JUnit XML ({str(exc)[:120] or 'parse error'}).") from None
    if root.tag not in ("testsuites", "testsuite"):
        raise ArtifactError("The XML file is not a JUnit report (expected <testsuites> or <testsuite>).")
    lines = content.split("\n")
    items: list[Item] = []
    total = failed = skipped = 0
    cursor = 0
    for case in root.iter("testcase"):
        total += 1
        name, cls = case.get("name", "?"), case.get("classname", "")
        if case.find("skipped") is not None:
            skipped += 1
        bad = case.find("failure") if case.find("failure") is not None else case.find("error")
        if bad is None:
            continue
        failed += 1
        needle = f'name="{name}"'
        line = next((i + 1 for i in range(cursor, len(lines)) if needle in lines[i]), None)
        if line:
            cursor = line
        message = bad.get("message") or ""
        body = "\n".join((bad.text or "").strip().splitlines()[:15])
        test_id = f"{cls}::{name}" if cls else name
        items.append(
            Item(
                "test_failure",
                idx,
                line,
                clip(f"{test_id} — {message}\n{body}"),
                {
                    "test": test_id,
                    "classname": cls or None,
                    "file": norm_path(case.get("file") or "") or None,
                    "outcome": bad.tag,
                    "type": bad.get("type"),
                    "message": clip(message, 300),
                    "time_s": _float(case.get("time")),
                },
                "parsed" if line else "partial",
            )
        )
        for frame in parse_log(idx, bad.text or ""):  # frames inside the failure text
            if frame.kind in ("stack_frame", "source_reference", "exception"):
                frame.line = line
                frame.status = "partial"  # location is the test case, not the exact line in the XML
                frame.attrs["test"] = test_id
                items.append(frame)
    items.append(
        Item(
            "test_summary",
            idx,
            1,
            f"JUnit: {total} tests, {failed} failed/errored, {skipped} skipped",
            {"tests": total, "failed": failed, "skipped": skipped},
        )
    )
    return items


def _float(v: str | None) -> float | None:
    try:
        return float(v) if v is not None else None
    except ValueError:
        return None


# ── manifests & config ─────────────────────────────────────────────────────
MAX_DEPS = 200


def parse_manifest(idx: int, name: str, content: str) -> list[Item]:
    items: list[Item] = []
    base = posixpath.basename(name.lower())
    if base == "package.json":
        try:
            data = json.loads(content)
        except ValueError:
            raise ArtifactError(f"{name} is not valid JSON.") from None
        lines = content.split("\n")
        for section in ("dependencies", "devDependencies", "peerDependencies"):
            for pkg, ver in (data.get(section) or {}).items():
                line = next((i + 1 for i, ln in enumerate(lines) if f'"{pkg}"' in ln), None)
                items.append(
                    Item(
                        "dependency",
                        idx,
                        line,
                        f"{pkg} {ver} ({section})",
                        {"package": pkg, "version": str(ver), "file": name},
                    )
                )
    else:
        for n, line in enumerate(clean_lines(content), start=1):
            if line.strip().startswith(("#", "//")):
                continue
            if dep := dep_of(line):
                items.append(
                    Item(
                        "dependency",
                        idx,
                        n,
                        clip(line.strip(), 200),
                        {"package": dep[0], "version": dep[1], "file": name},
                    )
                )
            if len(items) >= MAX_DEPS:
                break
    return items[:MAX_DEPS]


def config_lines(idx: int, content: str) -> list[tuple[int, str]]:
    """Non-empty, non-comment config lines; selected later by relevance to the failure."""
    out = []
    for n, line in enumerate(clean_lines(content), start=1):
        s = line.strip()
        if s and not s.startswith(("#", "//", ";")):
            out.append((n, clip(s, 300)))
    return out
