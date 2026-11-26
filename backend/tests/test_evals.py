"""The Quality page's engine: suites run through the API, results are stored with their date and read back."""

from __future__ import annotations


def test_app_checks_run_store_and_read_back(client):
    assert {s["product"] for s in client.get("/api/evals/suites").json()} == {
        "tara",
        "codelens",
        "safarnaama",
        "jasoos",
        "platform",
    }
    out = client.post("/api/evals/run", json={"product": "all"}).json()["results"]
    assert out and all(r["kind"] == "app" for r in out)  # model evals only when asked for
    scores = {r["suite"]: r for r in out}
    for sid in ("tara.rules", "tara.actions", "safarnaama.moments", "jasoos.evidence", "platform.json"):
        assert scores[sid]["status"] == "ok" and scores[sid]["value"] == 1.0, (sid, scores[sid]["failures"])
    assert scores["codelens.retrieval"]["status"] == "ok" and "hit_at_1" in scores["codelens.retrieval"]["extra"]
    latest = client.get("/api/evals/latest").json()["results"]
    assert {r["suite"] for r in latest} >= set(scores) and all(r["ran_at"] for r in latest)


def test_model_evals_record_what_the_run_measured(client):
    out = client.post("/api/evals/run", json={"product": "tara", "models": True}).json()["results"]
    routing = next(r for r in out if r["suite"] == "tara.routing")
    # The test model answers in prose, so no case reaches the model: nothing is scored, and the run says so
    # (a fallback to the offline rules is "not measured", never "wrong").
    assert routing["status"] == "unmeasured" and routing["value"] is None and routing["measured"] == 0
    assert routing["extra"]["fallback_rate"] == 1.0 and routing["total"] == len(__import__("app.evals").evals.ROUTING)
    assert client.post("/api/evals/run", json={"product": "nope"}).status_code == 422
    one = client.post("/api/evals/run", json={"product": "tara", "models": True, "suite": "tara.emotion"}).json()
    assert [r["suite"] for r in one["results"]] == ["tara.emotion"]  # the page runs model suites one at a time


def test_only_cases_the_model_answered_are_scored():
    from app.evals import _model_result

    items = [("a", "x"), ("b", "y"), ("c", "z"), ("d", "w")]
    answers = {"0": {"got": "x", "ms": 400}, "1": {"got": "nope", "ms": 600}}  # c fell back, d never ran
    r = _model_result(items, answers)
    assert r["status"] == "partial" and r["measured"] == 2 and r["total"] == 4 and r["value"] == 0.5
    assert r["extra"]["coverage"] == 0.5 and r["extra"]["fallback_rate"] == 0.5 and r["extra"]["p50_ms"] == 500
    assert r["failures"] == [{"input": "b", "expected": "y", "got": "nope"}]


def test_a_partial_run_is_resumed_only_for_the_same_recent_cases(client):
    import datetime as dt

    from app import evals

    suite = next(s for s in evals.SUITES if s.id == "tara.emotion")

    class Req:  # the store helper only needs request.app.state
        app = client.app

    store = evals._store(Req())
    now = dt.datetime.now(dt.UTC)
    base = {"suite": suite.id, "status": "partial", "answers": {"0": {"got": "sad", "ms": 500}}}
    store.put("results", {**base, "fingerprint": suite.fingerprint, "ran_at": now.isoformat()}, id="resume-test")
    assert evals._prior(store, suite) == {"0": {"got": "sad", "ms": 500}}
    store.put("results", {**base, "fingerprint": "other", "ran_at": now.isoformat()}, id="resume-test")
    assert evals._prior(store, suite) is None  # the labelled set changed: measure from scratch
    old = (now - dt.timedelta(hours=2)).isoformat()
    store.put("results", {**base, "fingerprint": suite.fingerprint, "ran_at": old}, id="resume-test")
    assert evals._prior(store, suite) is None  # too old to combine with a new run
    # Stored answers never leave the server.
    latest = client.get("/api/evals/latest").json()["results"]
    assert all("answers" not in r and "fingerprint" not in r for r in latest)
