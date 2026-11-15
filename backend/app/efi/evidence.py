"""Evidence assembly for EFI: parse every artifact, assign stable IDs, correlate, build the timeline, pick context.

Everything here is deterministic: the same artifacts (in the same order) always produce the same evidence IDs,
correlations and timeline. Correlations are only created from facts present in the artifacts (a stack frame that
points into a changed hunk, a failing test defined in a changed file, a changed dependency named in an error, a
changed config file named in an error). Nothing is inferred.
"""

from __future__ import annotations

import posixpath
import re
from dataclasses import asdict
from typing import Any

from rank_bm25 import BM25Okapi

from app.efi import parsers
from app.efi.parsers import Item, clip, same_file
from app.rag.retriever import tokenize

FAILURE_KINDS = {"error", "exception", "test_failure", "source_reference"}
SIGNAL_KINDS = FAILURE_KINDS | {"stack_frame"}
PRIORITY = {
    "exception": 100,
    "test_failure": 95,
    "error": 90,
    "test_summary": 85,
    "source_reference": 80,
    "dependency_change": 75,
    "stack_frame": 70,
    "note": 65,
    "diff_hunk": 60,
    "diff_file": 55,
    "command": 50,
    "config_line": 45,
    "dependency": 25,
    "stage": 20,
}
DROP_ORDER = ("stage", "dependency", "config_line", "command", "diff_file", "stack_frame")
CONFIG_LINES_PER_FILE = 6
PROMPT_SNIPPET = 400


def build(artifacts: list[dict[str, Any]], notes: str | None, max_items: int) -> dict[str, Any]:
    """artifacts: [{name, kind, content}] (redacted). Returns {evidence, correlations, timeline, stats}."""
    items: list[Item] = []
    configs: list[tuple[int, str, list[tuple[int, str]]]] = []
    for idx, a in enumerate(artifacts):
        kind, content, name = a["kind"], a["content"], a["name"]
        if kind == "junit":
            items += parsers.parse_junit(idx, content)
        elif kind == "diff":
            items += parsers.parse_diff(idx, content)
        elif kind == "manifest":
            items += parsers.parse_manifest(idx, name, content)
        elif kind == "config":
            configs.append((idx, name, parsers.config_lines(idx, content)))
        else:  # log / stacktrace
            items += parsers.parse_log(idx, content)
    if notes:
        items.append(Item("note", len(artifacts), 1, clip(notes, 1500), {"source": "user"}, "user_provided"))

    # Config files are long: keep only the lines most related to the failure (BM25 against failure text).
    query = tokenize(" ".join(i.content for i in items if i.kind in FAILURE_KINDS))
    changed = {i.attrs["file"] for i in items if i.kind == "diff_file"}
    for idx, name, lines in configs:
        if not lines:
            continue
        picked: list[tuple[int, str]] = []
        if query:
            bm = BM25Okapi([tokenize(t) or ["_"] for _, t in lines])
            scores = bm.get_scores(query)
            order = sorted(range(len(lines)), key=lambda k: (-scores[k], k))
            picked = [lines[k] for k in order[:CONFIG_LINES_PER_FILE] if scores[k] > 0]
        if not picked and any(same_file(name, c) for c in changed):
            picked = lines[:CONFIG_LINES_PER_FILE]
        for n, text in sorted(picked):
            items.append(Item("config_line", idx, n, text, {"file": parsers.norm_path(name)}))

    truncated = 0
    if len(items) > max_items:  # drop the least useful kinds first (DROP_ORDER), then later items; deterministic
        rank = {k: r for r, k in enumerate(DROP_ORDER)}
        ordered = sorted(items, key=lambda i: (-rank.get(i.kind, len(DROP_ORDER)), i.key()))
        truncated = len(items) - max_items
        items = ordered[:max_items]

    items.sort(key=lambda i: i.key())
    names = [a["name"] for a in artifacts] + ["investigation notes"]
    evidence = []
    for n, it in enumerate(items, start=1):
        evidence.append(
            {
                "id": f"EV-{n:03d}",
                "kind": it.kind,
                "artifact_index": it.artifact,
                "artifact": names[it.artifact],
                "line": it.line,
                "content": it.content,
                "status": it.status,
                "attrs": {k: v for k, v in it.attrs.items() if v is not None},
            }
        )
    correlations = correlate(evidence)
    return {
        "evidence": evidence,
        "correlations": correlations,
        "timeline": timeline(evidence),
        "stats": {
            "evidence": len(evidence),
            "truncated": truncated,
            "failure_signals": sum(1 for e in evidence if e["kind"] in SIGNAL_KINDS or _failed_summary(e)),
            "by_kind": _count(evidence),
        },
    }


def _count(evidence: list[dict[str, Any]]) -> dict[str, int]:
    out: dict[str, int] = {}
    for e in evidence:
        out[e["kind"]] = out.get(e["kind"], 0) + 1
    return out


def _failed_summary(e: dict[str, Any]) -> bool:
    if e["kind"] != "test_summary":
        return False
    if "failed" in e["attrs"]:
        return e["attrs"]["failed"] > 0
    return bool(re.search(r"\b[1-9]\d* (?:failed|errors?)\b", e["content"]))


def has_failure_signal(evidence: list[dict[str, Any]]) -> bool:
    return any(e["kind"] in SIGNAL_KINDS or _failed_summary(e) for e in evidence)


# ── correlations ───────────────────────────────────────────────────────────
def _pkg_norm(p: str) -> str:
    return re.sub(r"[-_.]+", "-", p.lower())


def correlate(evidence: list[dict[str, Any]]) -> list[dict[str, Any]]:  # noqa: C901
    out: list[dict[str, Any]] = []
    hunks = [e for e in evidence if e["kind"] == "diff_hunk"]
    files = [e for e in evidence if e["kind"] == "diff_file"]
    failures = [e for e in evidence if e["kind"] in FAILURE_KINDS]

    def add(kind: str, strength: str, ids: list[str], text: str) -> None:
        key = (kind, tuple(ids))
        if any((c["type"], tuple(c["evidence_ids"])) == key for c in out):
            return
        out.append(
            {
                "id": f"CR-{len(out) + 1:02d}",
                "type": kind,
                "strength": strength,
                "evidence_ids": ids,
                "description": text,
            }
        )

    # 1) stack frames / compiler references that point into the change
    for ref in (e for e in evidence if e["kind"] in ("stack_frame", "source_reference")):
        path, line = ref["attrs"].get("file"), ref["attrs"].get("line")
        if not path or ref["attrs"].get("library"):
            continue
        inside = [
            h
            for h in hunks
            if same_file(path, h["attrs"]["file"])
            and line is not None
            and h["attrs"]["new_start"] <= line <= h["attrs"]["new_end"]
        ]
        if inside:
            h = inside[0]
            add(
                "frame_in_changed_lines",
                "strong",
                [ref["id"], h["id"]],
                f"{ref['id']} references {h['attrs']['file']} line {line}, inside lines "
                f"{h['attrs']['new_start']}–{h['attrs']['new_end']} changed in {h['id']}.",
            )
            continue
        same = [f for f in files if same_file(path, f["attrs"]["file"])]
        if same:
            add(
                "frame_in_changed_file",
                "moderate",
                [ref["id"], same[0]["id"]],
                f"{ref['id']} references {same[0]['attrs']['file']}, a file changed in {same[0]['id']} "
                f"(the referenced line is outside the changed hunks).",
            )

    # 2) failing tests defined in a changed file
    for t in (e for e in evidence if e["kind"] == "test_failure"):
        candidates = [t["attrs"].get("file") or ""]
        test = t["attrs"].get("test") or ""
        if "::" in test and "/" in test.split("::")[0]:
            candidates.append(test.split("::")[0])
        cls = t["attrs"].get("classname") or ""
        if cls and "." in cls:
            candidates += [cls.replace(".", "/") + ext for ext in (".py", ".java", ".kt", ".ts", ".js")]
        for f in files:
            if any(c and same_file(c, f["attrs"]["file"]) for c in candidates):
                add(
                    "failing_test_in_changed_file",
                    "moderate",
                    [t["id"], f["id"]],
                    f"Failing test {t['id']} is defined in {f['attrs']['file']}, which changed in {f['id']}.",
                )
                break

    # 3) a changed dependency is named in a failure
    for d in (e for e in evidence if e["kind"] == "dependency_change"):
        pkg = _pkg_norm(d["attrs"]["package"])
        names = {pkg, pkg.replace("-", "_"), pkg.split("/")[-1]}
        for f in failures:
            text = _pkg_norm(f["content"])
            if any(len(n) >= 3 and re.search(rf"(?<![\w-]){re.escape(n)}(?![\w-])", text) for n in names):
                add(
                    "changed_dependency_in_failure",
                    "moderate",
                    [d["id"], f["id"]],
                    f"{d['attrs']['package']} changed "
                    f"({d['attrs'].get('old') or '∅'} → {d['attrs'].get('new') or '∅'}) "
                    f"in {d['id']} and is named in failure {f['id']}.",
                )

    # 4) a changed config file is named in a failure
    for f in files:
        base = posixpath.basename(f["attrs"]["file"]).lower()
        if not base.endswith(parsers.CONFIG_EXT) and base not in ("dockerfile", "makefile"):
            continue
        for e in failures:
            if base in e["content"].lower():
                add(
                    "changed_config_in_failure",
                    "moderate",
                    [f["id"], e["id"]],
                    f"Config file {f['attrs']['file']} changed in {f['id']} and is named in failure {e['id']}.",
                )
    return out


# ── timeline ───────────────────────────────────────────────────────────────
TIMELINE_KINDS = ("stage", "command", "error", "exception", "test_failure", "test_summary", "source_reference")
MAX_TIMELINE = 60


def timeline(evidence: list[dict[str, Any]]) -> list[dict[str, Any]]:
    events = [e for e in evidence if e["kind"] in TIMELINE_KINDS]
    stamped = [e for e in events if e["attrs"].get("timestamp")]
    # With timestamps, sort by them (ISO strings sort correctly once 'T'/' ' are unified); else keep the log order.
    if stamped and len(stamped) == len(events):
        events = sorted(events, key=lambda e: (e["attrs"]["timestamp"].replace(" ", "T"), e["id"]))
    first_failure = next((e["id"] for e in events if e["kind"] in FAILURE_KINDS), None)
    out = []
    for e in events[:MAX_TIMELINE]:
        out.append(
            {
                "evidence_id": e["id"],
                "kind": e["kind"],
                "at": e["attrs"].get("timestamp"),
                "stage": e["attrs"].get("stage"),
                "artifact": e["artifact"],
                "line": e["line"],
                "text": clip(e["content"], 200),
                "first_failure": e["id"] == first_failure,
            }
        )
    return out


# ── context selection for the model ────────────────────────────────────────
def select_context(
    evidence: list[dict[str, Any]], correlations: list[dict[str, Any]], budget: int
) -> tuple[list[dict[str, Any]], int]:
    """Highest-value evidence that fits `budget` characters. Returns (selected in ID order, number left out)."""
    correlated = {i for c in correlations for i in c["evidence_ids"]}
    failure_text = tokenize(" ".join(e["content"] for e in evidence if e["kind"] in FAILURE_KINDS))
    others = [e for e in evidence if e["kind"] not in FAILURE_KINDS]
    relevance: dict[str, float] = {}
    if failure_text and others:
        scores = BM25Okapi([tokenize(e["content"]) or ["_"] for e in others]).get_scores(failure_text)
        top = max(scores) if len(scores) and max(scores) > 0 else 1.0
        relevance = {e["id"]: 30.0 * float(s) / top for e, s in zip(others, scores, strict=True)}

    def score(e: dict[str, Any]) -> float:
        s = PRIORITY.get(e["kind"], 10) + (40 if e["id"] in correlated else 0) + relevance.get(e["id"], 0.0)
        return s - (40 if e["attrs"].get("library") else 0)

    ranked = sorted(evidence, key=lambda e: (-score(e), e["id"]))
    chosen, used = [], 0
    for e in ranked:
        size = len(render(e))
        if used + size > budget:
            continue
        chosen.append(e)
        used += size
    chosen.sort(key=lambda e: e["id"])
    return chosen, len(evidence) - len(chosen)


def render(e: dict[str, Any]) -> str:
    where = f"{e['artifact']}:L{e['line']}" if e["line"] else e["artifact"]
    extras = {
        k: v
        for k, v in e["attrs"].items()
        if k
        in ("file", "line", "function", "test", "package", "old", "new", "stage", "exit_code", "new_start", "new_end")
    }
    meta = " ".join(f"{k}={v}" for k, v in extras.items())
    return f"[{e['id']}] ({e['kind']} · {where}{' · ' + meta if meta else ''})\n{clip(e['content'], PROMPT_SNIPPET)}\n"


def as_dict(item: Item) -> dict[str, Any]:  # pragma: no cover - debugging helper
    return asdict(item)
