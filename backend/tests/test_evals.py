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
    # The test model answers in prose, so every request falls back to the offline rules: the run says so.
    assert routing["status"] == "ok" and routing["extra"]["fallback_rate"] == 1.0 and routing["total"] == 24
    assert client.post("/api/evals/run", json={"product": "nope"}).status_code == 422
