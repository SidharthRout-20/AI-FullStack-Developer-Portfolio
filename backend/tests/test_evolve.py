"""Evolve: validate → learn from failures → propose → regression-test → promote (offline, scripted LLM)."""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.products.evolve import Validators, run_checks
from app.rag.service import RAGService
from tests.conftest import FakeEmbedder, as_visitor
from tests.test_api import parse_sse

BETTER_PROMPT = (
    "You write replies to customer support messages. Be polite and helpful. Always thank the customer first."
)


class LearningLLM:
    """Outputs only say 'thank' once the system prompt tells them to; the judge rewards exactly that."""

    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, system, messages, *, short=False):
        self.calls += 1
        text = messages[0]["content"]
        sys_ = (system or "").lower()
        if "strict but fair evaluator" in sys_:
            output = text.split("OUTPUT:", 1)[-1].lower()
            good = "thank" in output
            return json.dumps(
                {
                    "score": 5 if good else 2,
                    "reasons": ["warm"] if good else ["no acknowledgement"],
                    "failed_criteria": [] if good else ["warm tone"],
                }
            )
        if "prompt engineer improving" in sys_:
            return json.dumps(
                {
                    "prompt": BETTER_PROMPT,
                    "rationale": "Added an explicit thank-you rule.",
                    "lessons": ["Always thank the customer."],
                }
            )
        return (
            "Thank you for reaching out. A replacement ships Friday."
            if "thank" in sys_
            else "We will look into your order."
        )

    async def stream(self, system, messages):
        yield await self.complete(system, messages)


@pytest.fixture
def client(settings):
    llm = LearningLLM()
    app = create_app(
        settings, service_factory=lambda s: RAGService(s, llm_factory=lambda _: llm, embedder=FakeEmbedder())
    )
    with TestClient(app) as c:
        yield as_visitor(c)


def test_checks():
    v = Validators(must_include=["thank"], must_avoid=["unfortunately"], max_words=5, json_keys=["a"])
    names = {c["name"]: c["passed"] for c in run_checks('Thanks! {"a": 1} unfortunately long sentence here', v)}
    assert names["includes “thank”"] and not names["avoids “unfortunately”"] and not names["≤ 5 words"]
    assert names["valid JSON with required keys"]
    assert not run_checks("no json", Validators(json_keys=["a"]))[0]["passed"]


def test_learn_loop_promotes_only_when_better(client):
    c = client
    template = c.get("/api/evolve/templates").json()[0]
    task = c.post(
        "/api/evolve/tasks",
        json={
            **{k: template[k] for k in ("name", "goal", "input_label", "prompt", "validators")},
            "auto_reflect_after": 20,
        },
    ).json()
    assert task["current_version"] == 1 and task["versions"][0]["source"] == "seed"

    r1 = c.post(f"/api/evolve/tasks/{task['id']}/run", json={"input": template["samples"][0]}).json()
    assert r1["passed"] is False and r1["judge"]["score"] == 2 and r1["auto_reflect"] is False
    assert [x["name"] for x in r1["checks"] if not x["passed"]] == ["includes “thank”"]
    c.post(f"/api/evolve/tasks/{task['id']}/run", json={"input": template["samples"][1]})
    assert c.get(f"/api/evolve/tasks/{task['id']}").json()["failures_since_reflect"] == 2
    lessons = c.get(f"/api/evolve/tasks/{task['id']}/lessons").json()
    assert len(lessons) == 2 and "includes “thank”" in lessons[0]["why"]

    events = parse_sse(c.post(f"/api/evolve/tasks/{task['id']}/reflect").text)
    steps = [d["step"] for e, d in events if e == "step"]
    assert steps[:2] == ["gather", "propose"] and steps.count("evaluate") == 2 and events[-1][0] == "done"
    done = events[-1][1]
    assert done["promoted"] is True and done["baseline"] == 0.0 and done["score"] == 1.0 and done["fixed"] == 2
    t = done["task"]
    assert t["current_version"] == 2 and t["versions"][1]["prompt"] == BETTER_PROMPT and t["summary"]["promotions"] == 1

    r3 = c.post(f"/api/evolve/tasks/{task['id']}/run", json={"input": template["samples"][2]}).json()
    assert r3["passed"] is True and r3["version_n"] == 2  # the system got better with use

    # Human feedback can overrule the judge, and it counts as a lesson.
    fb = c.post(f"/api/evolve/runs/{r3['id']}/feedback", json={"feedback": "bad", "note": "Too generic."}).json()
    assert fb["passed"] is False
    assert any("Human: Too generic." in x["why"] for x in c.get(f"/api/evolve/tasks/{task['id']}/lessons").json())

    # Reflecting again from v2: the proposal equals the current prompt → no change, nothing promoted.
    events = parse_sse(c.post(f"/api/evolve/tasks/{task['id']}/reflect").text)
    assert events[-1][0] == "error" and "no change" in events[-1][1]["message"]

    # Manual edit + rollback.
    t = c.post(
        f"/api/evolve/tasks/{task['id']}/versions",
        json={"prompt": "Reply briefly. Thank the customer.", "rationale": "shorter"},
    ).json()
    assert t["current_version"] == 3
    assert c.post(f"/api/evolve/tasks/{task['id']}/versions/1/promote").json()["current_version"] == 1
    assert c.post(f"/api/evolve/tasks/{task['id']}/versions/9/promote").status_code == 404
    assert c.delete(f"/api/evolve/tasks/{task['id']}").status_code == 204
    assert c.get(f"/api/evolve/tasks/{task['id']}").status_code == 404


def test_auto_reflect_runs_in_background(client):
    c = client
    template = c.get("/api/evolve/templates").json()[0]
    task = c.post(
        "/api/evolve/tasks",
        json={
            **{k: template[k] for k in ("name", "goal", "input_label", "prompt", "validators")},
            "auto_reflect_after": 2,
        },
    ).json()
    c.post(f"/api/evolve/tasks/{task['id']}/run", json={"input": template["samples"][0]})
    r2 = c.post(f"/api/evolve/tasks/{task['id']}/run", json={"input": template["samples"][1]}).json()
    assert r2["auto_reflect"] is True
    for _ in range(100):  # the reflection runs on the app's event loop; wait for it
        t = c.get(f"/api/evolve/tasks/{task['id']}").json()
        if t["current_version"] == 2 and not t["reflecting"]:
            break
        time.sleep(0.05)
    assert (
        t["current_version"] == 2
        and t["versions"][1]["source"] == "reflection (auto)"
        and t["failures_since_reflect"] == 0
    )
