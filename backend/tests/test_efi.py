"""EFI: redaction, deterministic parsing, correlation, bounded model stage, verification, ownership, retention.

The model is always a scripted fake: no test calls Groq (or any network service).
"""

from __future__ import annotations

import asyncio
import hashlib
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.efi import evidence as ev
from app.efi import parsers, reasoning
from app.efi.redact import redact
from app.efi.service import EFIService
from app.main import create_app
from appcore.llm.chat import LLMNotConfiguredError

GROQ_SECRET = "gsk_" + "a1B2c3D4e5F6g7H8i9J0kLmNoPqRsT"
LOG = f"""2026-11-10T10:00:00.0000000Z ##[group]Run pip install -r requirements.txt
2026-11-10T10:00:05.0000000Z Successfully installed fastapi-0.115.0 pydantic-2.9.0
2026-11-10T10:00:06.0000000Z ##[group]Run pytest -q
2026-11-10T10:00:07.0000000Z export GROQ_API_KEY={GROQ_SECRET}
2026-11-10T10:00:09.0000000Z Traceback (most recent call last):
2026-11-10T10:00:09.0000000Z   File "/home/runner/work/app/app/src/billing/invoice.py", line 42, in total
2026-11-10T10:00:09.0000000Z     return sum(i.price for i in items) * (1 + tax)
2026-11-10T10:00:09.0000000Z TypeError: unsupported operand type(s) for +: 'int' and 'NoneType'
2026-11-10T10:00:10.0000000Z FAILED tests/test_invoice.py::test_total - TypeError: unsupported operand
2026-11-10T10:00:10.0000000Z ========================= 1 failed, 12 passed in 1.20s =========================
2026-11-10T10:00:11.0000000Z ##[error]Process completed with exit code 1.
"""
DIFF = """diff --git a/src/billing/invoice.py b/src/billing/invoice.py
index 1111111..2222222 100644
--- a/src/billing/invoice.py
+++ b/src/billing/invoice.py
@@ -38,7 +38,7 @@ def total(items, tax=None):
     \"\"\"Sum line items.\"\"\"
-    tax = tax or 0
+    tax = tax
     subtotal = 0
diff --git a/requirements.txt b/requirements.txt
--- a/requirements.txt
+++ b/requirements.txt
@@ -1,2 +1,2 @@
-pydantic==2.8.0
+pydantic==2.9.0
 fastapi==0.115.0
diff --git a/tests/test_invoice.py b/tests/test_invoice.py
--- a/tests/test_invoice.py
+++ b/tests/test_invoice.py
@@ -1,3 +1,4 @@
+import pydantic
 from src.billing.invoice import total
"""
JUNIT = """<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" tests="2" failures="1">
<testcase classname="tests.test_invoice" name="test_total" file="tests/test_invoice.py" time="0.01">
<failure message="TypeError: unsupported operand">Traceback (most recent call last):
  File "/home/runner/work/app/app/src/billing/invoice.py", line 42, in total
TypeError: unsupported operand type(s) for +: 'int' and 'NoneType'</failure></testcase>
<testcase classname="tests.test_invoice" name="test_empty" time="0.01"/>
</testsuite></testsuites>
"""


def ids_of(evidence, kind, **attrs):
    return [e["id"] for e in evidence if e["kind"] == kind and all(e["attrs"].get(k) == v for k, v in attrs.items())]


class FakeCaller:
    """Scripted model: returns queued replies (str or Exception) and records every prompt it was sent."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.prompts: list[str] = []

    async def __call__(self, system, prompt):
        self.prompts.append(system + "\n" + prompt)
        reply = self.replies.pop(0) if self.replies else "not json"
        if isinstance(reply, Exception):
            raise reply
        if callable(reply):
            reply = reply(prompt)
        return reasoning.Completion(reply if isinstance(reply, str) else json.dumps(reply), 1000, 200)


@pytest.fixture
def efi_env(settings, service_factory):
    caller = FakeCaller()
    app = create_app(settings, service_factory=service_factory, efi_factory=lambda s: EFIService(s, caller=caller))
    with TestClient(app) as c:
        yield c, caller, app


def owner(c):
    return {"X-EFI-Owner": c.post("/api/efi/owner").json()["token"]}


def create(c, headers, artifacts=None, **extra):
    body = {"title": "CI failure", "artifacts": artifacts or [
        {"name": "ci.log", "content": LOG}, {"name": "change.diff", "content": DIFF},
        {"name": "junit.xml", "content": JUNIT}], **extra}  # fmt: skip
    return c.post("/api/efi/investigations", json=body, headers=headers)


# ── redaction ──────────────────────────────────────────────────────────────
def test_redaction_covers_common_secret_shapes():
    text = "\n".join([
        f"GROQ_API_KEY={GROQ_SECRET}",
        "aws key AKIAABCDEFGHIJKLMNOP",
        "token ghp_" + "a" * 36,
        "DATABASE_URL=postgresql://admin:Sup3rS3cret@db.neon.tech/app",
        "Authorization: Bearer abcdef1234567890xyz",
        'config: {"api_key": "live-value-123456"}',
        "password = hunter2hunter2",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        "max_tokens=4096",
        "env: ${{ secrets.GROQ_API_KEY }}",
    ])  # fmt: skip
    out, counts = redact(text)
    for secret in (GROQ_SECRET, "AKIAABCDEFGHIJKLMNOP", "Sup3rS3cret", "abcdef1234567890xyz", "live-value-123456",
                   "hunter2hunter2", "MIIEow", "dozjgNry", "ghp_aaaa"):  # fmt: skip
        assert secret not in out, secret
    assert "max_tokens=4096" in out  # not a secret
    assert "${{ secrets.GROQ_API_KEY }}" in out  # a reference, not a value
    assert "db.neon.tech" in out and "admin:" in out  # only the password is replaced
    assert sum(counts.values()) >= 9


# ── deterministic parsing ──────────────────────────────────────────────────
def test_log_parser_extracts_stages_commands_frames_and_errors():
    items = parsers.parse_log(0, LOG)
    kinds = {i.kind for i in items}
    assert {"stage", "command", "stack_frame", "exception", "error", "test_summary"} <= kinds
    frame = next(i for i in items if i.kind == "stack_frame")
    assert frame.attrs["file"].endswith("src/billing/invoice.py") and frame.attrs["line"] == 42
    assert frame.attrs["function"] == "total" and frame.line == 6
    exc = next(i for i in items if i.kind == "exception")
    assert exc.attrs["type"] == "TypeError" and exc.attrs["timestamp"].startswith("2026-11-10T10:00:09")
    assert any(i.kind == "error" and i.attrs.get("exit_code") == 1 for i in items)
    assert any(i.kind == "command" and i.attrs["command"] == "pytest -q" for i in items)


def test_js_java_go_frames_and_compiler_references():
    text = (
        "TypeError: Cannot read properties of undefined (reading 'id')\n"
        "    at getUser (/app/src/users.ts:17:9)\n"
        "    at Object.<anonymous> (/app/node_modules/express/lib/router.js:5:3)\n"
        "java.lang.IllegalStateException: boom\n"
        "\tat com.acme.Billing.charge(Billing.java:88)\n"
        "\t/home/ci/go/src/acme/main.go:31 +0x1d\n"
        "src/api/handler.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n"
    )
    items = parsers.parse_log(0, text)
    frames = {(i.attrs["file"], i.attrs["line"]) for i in items if i.kind == "stack_frame"}
    assert ("/app/src/users.ts", 17) in frames and ("Billing.java", 88) in frames
    assert ("/home/ci/go/src/acme/main.go", 31) in frames
    lib = next(i for i in items if i.kind == "stack_frame" and "node_modules" in i.attrs["file"])
    assert lib.attrs["library"] is True
    ref = next(i for i in items if i.kind == "source_reference")
    assert ref.attrs["file"] == "src/api/handler.ts" and ref.attrs["line"] == 12
    assert {i.attrs["type"] for i in items if i.kind == "exception"} >= {"TypeError", "java.lang.IllegalStateException"}


def test_diff_parser_files_hunks_and_dependency_changes():
    items = parsers.parse_diff(0, DIFF)
    files = {i.attrs["file"]: i for i in items if i.kind == "diff_file"}
    assert set(files) == {"src/billing/invoice.py", "requirements.txt", "tests/test_invoice.py"}
    assert files["src/billing/invoice.py"].attrs["added"] == 1 and files["src/billing/invoice.py"].attrs["removed"] == 1
    hunk = next(i for i in items if i.kind == "diff_hunk" and i.attrs["file"] == "src/billing/invoice.py")
    assert (hunk.attrs["new_start"], hunk.attrs["new_end"]) == (38, 44)
    dep = next(i for i in items if i.kind == "dependency_change")
    assert (dep.attrs["package"], dep.attrs["old"], dep.attrs["new"]) == ("pydantic", "2.8.0", "2.9.0")


def test_junit_parser_and_unsafe_xml_rejected():
    items = parsers.parse_junit(0, JUNIT)
    fail = next(i for i in items if i.kind == "test_failure")
    assert fail.attrs["test"] == "tests.test_invoice::test_total" and fail.attrs["file"] == "tests/test_invoice.py"
    assert any(i.kind == "stack_frame" and i.attrs["line"] == 42 for i in items)
    summary = next(i for i in items if i.kind == "test_summary")
    assert summary.attrs == {"tests": 2, "failed": 1, "skipped": 0}
    with pytest.raises(parsers.ArtifactError):
        parsers.parse_junit(0, '<!DOCTYPE x [<!ENTITY a "b">]><testsuite>&a;</testsuite>')
    with pytest.raises(parsers.ArtifactError):
        parsers.parse_junit(0, "<testsuite><testcase></testsuite>")
    with pytest.raises(parsers.ArtifactError):
        parsers.parse_junit(0, "<html></html>")


def _artifacts():
    out = []
    for name, content in (("ci.log", LOG), ("change.diff", DIFF), ("junit.xml", JUNIT)):
        clean, _ = redact(content)
        out.append({"name": name, "kind": parsers.detect_kind(name, clean), "content": clean, "size": len(clean)})
    return out


def test_evidence_ids_are_stable_and_correlations_are_factual():
    first = ev.build(_artifacts(), "Started after the tax refactor", 300)
    second = ev.build(_artifacts(), "Started after the tax refactor", 300)
    assert first == second  # same input → same IDs, same correlations, same timeline
    evidence = first["evidence"]
    assert [e["id"] for e in evidence] == [f"EV-{n:03d}" for n in range(1, len(evidence) + 1)]
    types = {c["type"]: c for c in first["correlations"]}
    strong = types["frame_in_changed_lines"]
    assert strong["strength"] == "strong" and all(i in {e["id"] for e in evidence} for i in strong["evidence_ids"])
    assert "changed_dependency_in_failure" not in types  # "pydantic" isn't named in any failure: no correlation
    assert "failing_test_in_changed_file" in types
    assert ev.has_failure_signal(evidence)
    assert first["timeline"][0]["kind"] in ("stage", "command")
    assert sum(1 for t in first["timeline"] if t["first_failure"]) == 1
    assert ids_of(evidence, "note")  # user notes are evidence of kind "note", marked user-provided


def test_context_selection_respects_budget_and_prefers_failures():
    built = ev.build(_artifacts(), None, 300)
    selected, left_out = ev.select_context(built["evidence"], built["correlations"], 1200)
    assert sum(len(ev.render(e)) for e in selected) <= 1200 and left_out > 0
    assert selected and all(e["kind"] not in ("stage", "dependency") for e in selected)


# ── Groq request construction & error mapping ─────────────────────────────
def test_efi_request_is_advanced_and_prefers_gpt_oss_120b(settings):
    r = reasoning.efi_request(settings, reasoning.SYSTEM, "evidence")
    assert r.task == "efi.investigate" and r.prefer_model == "openai/gpt-oss-120b"
    assert r.max_output_tokens == settings.efi_max_output_tokens and r.reasoning_effort == "low"
    assert r.max_retries == settings.efi_max_retries
    with pytest.raises(LLMNotConfiguredError):
        asyncio.run(reasoning.router_caller(settings.model_copy(update={"groq_api_key": None}))("s", "p"))


def test_groq_rate_limit_maps_to_quota_error():
    import groq

    resp = httpx.Response(429, headers={"retry-after": "30"}, request=httpx.Request("POST", "https://api.groq.com/x"))
    mapped = reasoning._map_error(groq.RateLimitError("rate limited", response=resp, body=None))
    assert isinstance(mapped, reasoning.EFIQuotaError) and mapped.retry_after == 30
    resp5 = httpx.Response(503, request=httpx.Request("POST", "https://api.groq.com/x"))
    assert isinstance(
        reasoning._map_error(groq.InternalServerError("down", response=resp5, body=None)), reasoning.EFIModelError
    )


# ── API: intake, ownership, analysis, verification ────────────────────────
def test_owner_token_required_and_ownership_enforced(efi_env):
    c, _, _ = efi_env
    assert c.get("/api/efi/investigations").status_code == 401
    assert c.get("/api/efi/investigations", headers={"X-EFI-Owner": "short"}).status_code == 401
    alice, bob = owner(c), owner(c)
    inv = create(c, alice).json()
    assert c.get(f"/api/efi/investigations/{inv['id']}", headers=alice).status_code == 200
    assert c.get(f"/api/efi/investigations/{inv['id']}", headers=bob).status_code == 404
    assert c.delete(f"/api/efi/investigations/{inv['id']}", headers=bob).status_code == 404
    assert c.post(f"/api/efi/investigations/{inv['id']}/analyze", headers=bob).status_code == 404
    assert c.get(f"/api/efi/investigations/{inv['id']}/artifacts/A1", headers=bob).status_code == 404
    assert c.get("/api/efi/investigations", headers=bob).json() == []
    assert [i["id"] for i in c.get("/api/efi/investigations", headers=alice).json()] == [inv["id"]]
    assert c.delete(f"/api/efi/investigations/{inv['id']}", headers=alice).status_code == 204
    assert c.get(f"/api/efi/investigations/{inv['id']}", headers=alice).status_code == 404


def test_create_redacts_before_storing_and_extracts_evidence(efi_env):
    c, caller, app = efi_env
    h = owner(c)
    r = create(c, h, notes="password=topsecretvalue")
    assert r.status_code == 201
    inv = r.json()
    dumped = json.dumps(inv)
    assert GROQ_SECRET not in dumped and "topsecretvalue" not in dumped
    assert inv["status"] == "ready" and inv["data"]["redaction"]["total"] >= 2
    assert caller.prompts == []  # creating an investigation never calls the model
    assert "owner" not in inv
    owner_hash = hashlib.sha256(b"efi-owner|" + h["X-EFI-Owner"].encode()).hexdigest()
    content = app.state.efi.store.artifact_content(owner_hash, inv["id"], "A1")
    assert content and GROQ_SECRET not in content and "[REDACTED:groq_api_key]" in content
    ctx = c.get(f"/api/efi/investigations/{inv['id']}/artifacts/A1?line=6&radius=1", headers=h).json()
    assert [ln["n"] for ln in ctx["lines"]] == [5, 6, 7]


@pytest.mark.parametrize(
    ("artifact", "fragment"),
    [
        ({"name": "repo.zip", "content": "PK..."}, "archives"),
        ({"name": "app.exe", "content": "MZ"}, "unsupported file type"),
        ({"name": "bin.log", "content": "abc\x00def"}, "binary"),
        ({"name": "empty.log", "content": "   "}, "empty"),
        ({"name": "bad.xml", "content": "<testsuite><oops></testsuite>"}, "Malformed JUnit"),
    ],
)
def test_invalid_artifacts_are_rejected(efi_env, artifact, fragment):
    c, _, _ = efi_env
    r = create(c, owner(c), artifacts=[artifact])
    assert r.status_code == 422 and fragment.lower() in r.json()["detail"].lower()


def test_request_size_and_artifact_count_limits(settings, service_factory):
    s = settings.model_copy(update={"efi_max_request_bytes": 10_000, "efi_max_artifacts": 2})
    app = create_app(s, service_factory=service_factory, efi_factory=lambda st: EFIService(st, caller=FakeCaller()))
    with TestClient(app) as c:
        h = owner(c)
        assert create(c, h, artifacts=[{"name": "big.log", "content": "x" * 20_000}]).status_code == 413
        many = [{"name": f"{i}.log", "content": "error: x"} for i in range(3)]
        assert create(c, h, artifacts=many).status_code == 422
        bad_json = c.post("/api/efi/investigations", content=b"{not json", headers=h)
        assert bad_json.status_code == 422


def _good_reply(evidence):
    frame = ids_of(evidence, "stack_frame")[0]
    exc = ids_of(evidence, "exception")[0]
    hunk = next(
        e["id"] for e in evidence if e["kind"] == "diff_hunk" and e["attrs"]["file"] == "src/billing/invoice.py"
    )
    return {
        "summary": "test_total fails with a TypeError in invoice.total.",
        "insufficient_evidence": False,
        "hypotheses": [
            {"id": "H1", "title": "tax default removed", "description": "The diff removed `tax or 0`, so tax is None.",
             "supporting_evidence": [frame, exc.replace("EV-0", "EV-"), hunk], "contradicting_evidence": [],
             "confidence": "high", "reasoning": "Frame line 42 is inside the changed hunk.",
             "affected_files": ["src/billing/invoice.py", "src/imaginary/module.py"],
             "remediation": ["Restore `tax = tax or 0` in src/billing/invoice.py"],
             "validation_steps": ["Run pytest tests/test_invoice.py"]},
            {"id": "H2", "title": "made up", "description": "Something in ghost.py", "supporting_evidence": ["EV-999"],
             "confidence": "high"},
            *([{"id": "H3", "title": "only notes", "description": "User suspects refactor",
                "supporting_evidence": ids_of(evidence, "note")[:1], "confidence": "high"}]
              if ids_of(evidence, "note") else []),
        ],
        "reproduction_steps": [{"step": "`pytest -q`", "evidence_ids": [frame]}, {"step": "`make magic`"}],
    }  # fmt: skip


def test_analysis_verifies_model_output(efi_env):
    c, caller, _ = efi_env
    h = owner(c)
    inv = create(c, h, notes="Started after the tax refactor").json()
    caller.replies = [_good_reply(inv["data"]["evidence"])]
    r = c.post(f"/api/efi/investigations/{inv['id']}/analyze", headers=h)
    assert r.status_code == 200, r.text
    out = r.json()
    report = out["data"]["report"]
    assert out["status"] == "analyzed" and report["model"] == "openai/gpt-oss-120b"
    h1 = report["hypotheses"][0]
    assert h1["title"] == "tax default removed" and h1["confidence"] == "high"  # backed by a strong correlation
    assert len(h1["supporting_evidence"]) == 3  # "EV-12" style id normalised, not dropped
    assert h1["affected_files"] == ["src/billing/invoice.py"]  # invented path removed
    assert any("not present in the artifacts" in n for n in h1["verification_notes"])
    notes_only = next(x for x in report["hypotheses"] if x["title"] == "only notes")
    assert notes_only["confidence"] == "low"
    assert [x["title"] for x in report["rejected_hypotheses"]] == ["made up"]
    steps = {s["step"]: s["observed"] for s in report["reproduction_steps"]}
    assert steps == {"`pytest -q`": True, "`make magic`": False}
    checklist = [i["text"] for i in report["validation_checklist"]]
    assert any("tests.test_invoice::test_total" in t for t in checklist)
    assert any("pytest -q" in t for t in checklist)
    assert out["data"]["analysis"]["calls"] == 1
    prompt = caller.prompts[0]
    assert "<evidence>" in prompt and GROQ_SECRET not in prompt and "untrusted data" in prompt


def test_malformed_model_output_is_bounded_and_reported(efi_env):
    c, caller, _ = efi_env
    h = owner(c)
    inv = create(c, h).json()
    caller.replies = ["no json here", '{"hypotheses": "nope"']
    r = c.post(f"/api/efi/investigations/{inv['id']}/analyze", headers=h)
    assert r.status_code == 503 and "unreadable" in r.json()["detail"]
    assert len(caller.prompts) == 2  # efi_max_model_calls: never more
    after = c.get(f"/api/efi/investigations/{inv['id']}", headers=h).json()
    assert after["status"] == "failed" and after["data"]["error"]["kind"] == "failed"


def test_quota_exhaustion_returns_429_without_fallback(efi_env):
    c, caller, _ = efi_env
    h = owner(c)
    inv = create(c, h).json()
    caller.replies = [reasoning.EFIQuotaError(30)]
    r = c.post(f"/api/efi/investigations/{inv['id']}/analyze", headers=h)
    assert r.status_code == 429 and r.headers["retry-after"] == "30" and "quota" in r.json()["detail"]
    after = c.get(f"/api/efi/investigations/{inv['id']}", headers=h).json()
    assert after["status"] == "ready"  # can be retried later
    caller.replies = [_good_reply(inv["data"]["evidence"])]
    assert c.post(f"/api/efi/investigations/{inv['id']}/analyze", headers=h).status_code == 200


def test_no_failure_signal_means_insufficient_evidence_without_model_call(efi_env):
    c, caller, _ = efi_env
    h = owner(c)
    inv = create(c, h, artifacts=[{"name": "ok.log", "content": "Step 1/2 : FROM python\nall good\ndone"}]).json()
    out = c.post(f"/api/efi/investigations/{inv['id']}/analyze", headers=h).json()
    assert out["status"] == "insufficient_evidence" and caller.prompts == []
    report = out["data"]["report"]
    assert report["insufficient_evidence"] and report["hypotheses"] == [] and report["missing_artifacts"]


def test_model_saying_insufficient_is_respected(efi_env):
    c, caller, _ = efi_env
    h = owner(c)
    inv = create(c, h).json()
    caller.replies = [{"summary": "", "insufficient_evidence": True, "insufficient_reason": "Need the full log.",
                       "hypotheses": []}]  # fmt: skip
    out = c.post(f"/api/efi/investigations/{inv['id']}/analyze", headers=h).json()
    assert out["status"] == "insufficient_evidence"
    assert out["data"]["report"]["insufficient_reason"] == "Need the full log."


def test_feedback_and_daily_limit(settings, service_factory):
    s = settings.model_copy(update={"efi_daily_analyses_per_owner": 1})
    caller = FakeCaller()
    app = create_app(s, service_factory=service_factory, efi_factory=lambda st: EFIService(st, caller=caller))
    with TestClient(app) as c:
        h = owner(c)
        inv = create(c, h).json()
        caller.replies = [_good_reply(inv["data"]["evidence"])]
        assert c.post(f"/api/efi/investigations/{inv['id']}/analyze", headers=h).status_code == 200
        assert c.post(f"/api/efi/investigations/{inv['id']}/analyze", headers=h).status_code == 429
        url = f"/api/efi/investigations/{inv['id']}/feedback"
        assert c.post(url, json={"outcome": "confirmed", "hypothesis_id": "H5"}, headers=h).status_code == 422
        r = c.post(
            url, json={"outcome": "confirmed", "hypothesis_id": "H1", "note": "fixed, token=abcd1234"}, headers=h
        )
        fb = r.json()["data"]["feedback"]
        assert fb["hypothesis_id"] == "H1" and "abcd1234" not in fb["note"]


def test_raw_artifacts_expire_but_reports_remain(efi_env):
    c, caller, app = efi_env
    h = owner(c)
    inv = create(c, h).json()
    store = app.state.efi.store
    with store.db.tx() as tx:
        tx.execute("UPDATE {artifacts} SET expires_at = ?", ("2000-01-01T00:00:00+00:00",))
    assert store.purge_expired() == 3
    assert c.get(f"/api/efi/investigations/{inv['id']}/artifacts/A1", headers=h).status_code == 410
    again = c.get(f"/api/efi/investigations/{inv['id']}", headers=h).json()
    assert again["raw_artifacts_available"] == [] and again["data"]["evidence"]  # snippets kept in the report


def test_limits_endpoint_reports_groq_model(efi_env):
    c, _, _ = efi_env
    info = c.get("/api/efi/limits").json()
    assert info["provider"] == "groq" and info["model"] == "openai/gpt-oss-120b" and info["retention_days"] == 14


# ── storage: artifact IDs are per investigation ───────────────────────────
def test_artifact_ids_are_scoped_to_their_investigation(efi_env):
    """Every investigation numbers its artifacts A1, A2…: two investigations in one database must not collide
    (this failed on the shared Postgres database before the key became (investigation_id, id))."""
    c, _, _ = efi_env
    alice, bob = owner(c), owner(c)
    first, second, third = create(c, alice).json(), create(c, alice).json(), create(c, bob).json()
    assert len({first["id"], second["id"], third["id"]}) == 3
    for inv, who in ((first, alice), (second, alice), (third, bob)):
        assert c.get(f"/api/efi/investigations/{inv['id']}/artifacts/A1", headers=who).status_code == 200


def test_old_single_column_artifact_key_is_upgraded_in_place(tmp_path):
    import sqlite3

    from app.efi.store import EFIStore

    db = tmp_path / "efi.sqlite3"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE artifacts (id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL, owner TEXT NOT NULL, "
                "name TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, "
                "content TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)")  # fmt: skip
    con.execute("INSERT INTO artifacts VALUES ('A1','inv1','o','ci.log','log',3,'x','abc','2999-01-01','2026-01-01')")
    con.commit()
    con.close()
    store = EFIStore(tmp_path, None)
    store._upgrade_artifact_key()  # idempotent
    with store.db.tx() as c:
        c.execute("INSERT INTO {artifacts} VALUES ('A1','inv2','o','b.log','log',1,'y','d','2999-01-01','2026-01-01')")
        rows = c.execute("SELECT investigation_id FROM {artifacts} ORDER BY investigation_id").fetchall()
    assert [r["investigation_id"] for r in rows] == ["inv1", "inv2"]  # old row kept, no collision
