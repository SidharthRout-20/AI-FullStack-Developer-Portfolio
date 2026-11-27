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


def test_scores_carry_their_interval_and_per_label_quality():
    from app.evals import macro_f1, wilson

    lo, hi = wilson(10, 12)
    assert 0.55 < lo < 0.6 and 0.95 < hi <= 0.98  # 10/12 could be anywhere from ~55% to ~97%
    assert wilson(0, 0) == [0.0, 1.0]
    f1, worst = macro_f1([("a", "a"), ("a", "b"), ("b", "b"), ("c", "c")])
    assert f1 == round((2 / 3 + 2 / 3 + 1) / 3, 3) and worst[0]["label"] in ("a", "b")


def test_the_security_controls_all_hold_and_each_names_its_standard(client):
    out = client.post("/api/evals/run", json={"product": "platform"}).json()["results"]
    sec = next(r for r in out if r["suite"] == "platform.security")
    controls = sec["extra"]["controls"]
    assert sec["status"] == "ok" and len(controls) == sec["total"] == 13
    assert sec["value"] == 1.0, [c["name"] for c in controls if not c["passed"]]
    assert all(c["standards"] for c in controls) and any("OWASP LLM01" in c["standards"] for c in controls)


def test_history_and_regressions_are_tracked_run_over_run(client):
    from app import evals

    for _ in range(2):
        client.post("/api/evals/run", json={"product": "safarnaama"})
    hist = client.get("/api/evals/history", params={"suite": "safarnaama.moments"}).json()["runs"]
    assert len(hist) >= 2 and hist[0]["ci95"] and hist[0]["ran_at"]
    latest = {r["suite"]: r for r in client.get("/api/evals/latest").json()["results"]}
    trend = latest["safarnaama.moments"]["trend"]
    assert trend["values"][-1] == 1.0 and trend["delta"] == 0 and trend["regression"] is False
    docs = [{"suite": "x", "value": v, "status": "ok", "ran_at": str(i)} for i, v in enumerate([0.7, 0.9, 0.95])]
    assert evals._trends(docs)["x"]["regression"] is True  # newest first: 0.7 after 0.9 is a 20-point drop
    assert all(s["standards"] for s in client.get("/api/evals/suites").json())
