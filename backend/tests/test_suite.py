"""CareerPilot, MeetingMind, CodeLens, FlowForge, TripWeaver: offline tests (scripted LLM, fake network tools)."""

from __future__ import annotations

import asyncio
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.products.codelens import chunk_generic, chunk_python, imports_of, read_zip
from app.products.flowforge import FlowIn, check, render, safe_http, validate
from app.products.meetingmind import text_to_segments, windows
from app.rag.service import RAGService
from tests.conftest import FakeEmbedder
from tests.test_api import parse_sse

TAILOR = {"headline": "Backend AI engineer", "summary": "Builds RAG systems.", "cover_letter": "Dear team,\n\nHello.",
          "bullets": [{"original": "Built APIs", "rewritten": "Built FastAPI services", "why": "matches JD"}],
          "keywords_matched": ["Python"], "keywords_missing": ["Kubernetes"]}  # fmt: skip
QUESTIONS = {"questions": [{"id": 1, "text": "Explain RAG.", "kind": "technical"}, {"id": 2, "text": "A conflict?", "kind": "behavioral"},
                           {"id": 3, "text": "Kubernetes?", "kind": "gap"}]}  # fmt: skip
ASSESS = {
    "score": 2,
    "feedback": "Too vague.",
    "strengths": ["honest"],
    "improve": ["add metrics"],
    "follow_up": "Give one concrete example?",
}
ANALYSIS = {"title": "Sprint planning", "summary": "We planned the sprint.", "decisions": [{"text": "Ship v2 on Friday", "owner": "Asha"}],
            "action_items": [{"text": "Write release notes", "owner": "Ben", "due": "Thursday"}], "risks": ["QA capacity"],
            "topics": ["release"], "sentiment": "positive"}  # fmt: skip
TOUR = {"overview": "A tiny demo app.", "steps": [{"title": "Entry", "path": "app/main.py", "explanation": "Start here."},
        {"title": "Utils", "path": "app/utils.py", "explanation": "Helpers."}, {"title": "UI", "path": "web/index.ts", "explanation": "Front."}]}  # fmt: skip
TRIP_REQ = {
    "destination": "Lisbon",
    "country": "Portugal",
    "start_date": "2030-05-01",
    "days": 2,
    "interests": ["food"],
    "pace": "balanced",
}
PLAN = {"title": "Lisbon long weekend", "summary": "Hills and pastries.", "tips": ["Wear good shoes"],
        "days": [{"day": 1, "theme": "Old town", "activities": [{"time": "09:00", "name": "Castelo de São Jorge", "place_query": "Castelo de São Jorge Lisbon", "kind": "outdoor", "duration_min": 120}]},
                 {"day": 2, "theme": "Belém", "activities": [{"time": "10:00", "name": "Jerónimos Monastery", "place_query": "Jerónimos Monastery", "kind": "indoor"}]}]}  # fmt: skip
REPLAN = {"explanation": "Swapped the castle for a museum because of rain.",
          "changed_days": [{"day": 1, "theme": "Museums", "activities": [{"time": "10:00", "name": "Gulbenkian Museum", "place_query": "Gulbenkian Lisbon", "kind": "indoor"}]}]}  # fmt: skip


class ScriptedLLM:
    """Answers by recognising which product prompt it was given."""

    RULES = [
        ("resume writer", TAILOR), ("senior interviewer", QUESTIONS), ("interview coach", ASSESS),
        ("analyse meeting", ANALYSIS), ("onboarding tours", TOUR), ("Extract a trip request", TRIP_REQ),
        ("travel planner", PLAN), ("revise an existing itinerary", REPLAN),
        ("extract structured data", {"topic": "bill", "urgency": "high", "due_date": "15th", "amount": "1840"}),
    ]  # fmt: skip

    async def complete(self, system, messages, *, short=False):
        for needle, reply in self.RULES:
            if system and needle.lower() in system.lower():
                return json.dumps(reply)
        return "Answer citing [1]."

    async def stream(self, system, messages):
        yield await self.complete(system, messages)


class FakeTools:
    async def geocode_city(self, name, country):
        return {"name": "Lisbon", "country": "Portugal", "lat": 38.72, "lng": -9.14, "timezone": "Europe/Lisbon"}

    async def geocode_place(self, query, near):
        return {"lat": near[0] + 0.01, "lng": near[1] + 0.01, "label": query}

    async def forecast(self, lat, lng, tz):
        return {
            "2030-05-01": {"code": 61, "tmax": 18, "tmin": 12, "rain": 80},
            "2030-05-02": {"code": 1, "tmax": 22, "tmin": 14, "rain": 5},
        }


def make_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("demo-abc/README.md", "# Demo\nA tiny demo app.")
        z.writestr("demo-abc/app/__init__.py", "")
        z.writestr(
            "demo-abc/app/main.py",
            "from app.utils import slugify\n\n\ndef create_app():\n    '''Build the app.'''\n    return slugify('Hello World')\n",
        )
        z.writestr(
            "demo-abc/app/utils.py",
            "import re\n\n\ndef slugify(text):\n    return re.sub(r'\\W+', '-', text).lower()\n",
        )
        z.writestr(
            "demo-abc/web/index.ts", "import { api } from './api'\nexport function boot() {\n  return api()\n}\n"
        )
        z.writestr("demo-abc/web/api.ts", "export const api = () => fetch('/x')\n")
        z.writestr("demo-abc/node_modules/x/index.js", "ignored")
        z.writestr("demo-abc/logo.png", b"\x89PNG\x00\x00binary")
    return buf.getvalue()


@pytest.fixture
def app_client(settings):
    llm = ScriptedLLM()
    app = create_app(
        settings, service_factory=lambda s: RAGService(s, llm_factory=lambda _: llm, embedder=FakeEmbedder())
    )
    with TestClient(app) as c:
        suite = app.state.suite
        suite.trips.tools = FakeTools()

        async def fetch(owner, repo, ref):
            return make_zip()

        suite.code.fetcher = fetch
        yield c


# ── CareerPilot ──────────────────────────────────────────────────────────
JD = "We need a senior Python engineer with FastAPI, RAG and Kubernetes experience to build AI products."


def test_career_tailor_interview_and_tracker(app_client):
    c = app_client
    assert "Python" in c.get("/api/career/resume").json()["text"]  # falls back to the knowledge-base resume
    out = c.post("/api/career/tailor", json={"jd": JD, "company": "Acme"}).json()
    assert out["keywords_missing"] == ["Kubernetes"] and out["bullets"][0]["rewritten"].startswith("Built")

    session = c.post("/api/career/interviews", json={"jd": JD, "gaps": ["Kubernetes"]}).json()
    assert [q["id"] for q in session["questions"]] == [1, 2, 3]
    r = c.post(
        f"/api/career/interviews/{session['id']}/answers", json={"question_id": 1, "answer": "It's retrieval."}
    ).json()
    assert r["assessment"]["score"] == 2 and r["follow_up"]["kind"] == "follow_up"
    ids = [q["id"] for q in r["session"]["questions"]]
    assert ids[:2] == [1, r["follow_up"]["id"]]  # follow-up inserted right after the weak answer
    follow = c.post(
        f"/api/career/interviews/{session['id']}/answers", json={"question_id": r["follow_up"]["id"], "answer": "x"}
    ).json()
    assert follow["follow_up"] is None  # never a follow-up to a follow-up
    assert follow["summary"] == {"answered": 2, "total": 4, "average": 2.0}
    assert c.delete(f"/api/career/interviews/{session['id']}").status_code == 204
    assert c.get(f"/api/career/interviews/{session['id']}").status_code == 404

    app_ = c.post("/api/career/applications", json={"company": "Acme", "role": "AI Engineer", "match_score": 72}).json()
    assert c.patch(f"/api/career/applications/{app_['id']}", json={"stage": "interview"}).json()["stage"] == "interview"
    assert c.patch(f"/api/career/applications/{app_['id']}", json={"stage": "hired!"}).status_code == 422
    assert (
        c.post("/api/career/applications", json={"company": "x", "role": "y", "url": "javascript:alert(1)"}).status_code
        == 422
    )
    assert c.delete(f"/api/career/applications/{app_['id']}").status_code == 204


# ── MeetingMind ──────────────────────────────────────────────────────────
TRANSCRIPT = "[00:00] Asha: Let's ship v2 on Friday.\n[00:42] Ben: I'll write the release notes by Thursday.\n[01:10] Asha: QA capacity is a risk."


def test_meeting_analysis_board_and_archive(app_client):
    c = app_client
    m = c.post("/api/meetings", json={"transcript": TRANSCRIPT}).json()
    assert m["title"] == "Sprint planning" and m["decisions"][0]["owner"] == "Asha" and "windows" not in m
    tasks = c.get("/api/meetings/tasks").json()
    assert tasks[0]["text"] == "Write release notes" and tasks[0]["status"] == "todo"
    assert c.patch(f"/api/meetings/tasks/{tasks[0]['id']}", json={"status": "done"}).json()["status"] == "done"
    ans = c.post("/api/meetings/ask", json={"question": "who writes the release notes?"}).json()
    assert ans["sources"] and ans["sources"][0]["meeting_title"] == "Sprint planning"
    full = c.get(f"/api/meetings/{m['id']}").json()
    assert full["segments"][1]["start"] == 42.0

    async def fake_whisper(audio, name):
        return [{"start": 0.0, "end": 3.0, "text": "Asha: let's ship on Friday."}]

    c.app.state.suite.meetings.transcriber = fake_whisper
    r = c.post(
        "/api/meetings/audio?title=Standup",
        content=b"\x1a\x45\xdf\xa3" + b"0" * 2000,
        headers={"Content-Type": "audio/webm"},
    )
    assert r.status_code == 201 and r.json()["source"] == "audio" and r.json()["title"] == "Standup"
    assert c.post("/api/meetings/audio", content=b"x" * 2000, headers={"Content-Type": "text/plain"}).status_code == 415
    assert c.delete(f"/api/meetings/{m['id']}").status_code == 204
    assert all(t["meeting_id"] != m["id"] for t in c.get("/api/meetings/tasks").json())


def test_lenient_llm_schemas_trim_instead_of_failing():
    from app.products.tripweaver import Plan

    plan = Plan.model_validate(
        {"title": "t" * 300, "summary": "s", "days": [{"day": 1, "activities": [{"name": f"a{i}"} for i in range(12)]}]}
    )
    assert len(plan.title) == 120 and len(plan.days[0].activities) == 8


def test_meeting_helpers():
    segs = text_to_segments("[01:02:03] hello\nworld")
    assert segs[0]["start"] == 3723 and segs[1]["text"] == "world"
    wins = windows([{"start": i, "text": "x" * 300} for i in range(5)])
    assert [w["start"] for w in wins] == [0, 3]


# ── CodeLens ─────────────────────────────────────────────────────────────
def test_codelens_chunking_and_imports():
    py = "import os\n\n@dec\ndef a():\n    return 1\n\nclass B:\n    def m(self):\n        pass\n"
    chunks = chunk_python("x.py", py)
    a = next(c for c in chunks if c["symbol"] == "a")
    assert (a["start"], a["end"]) == (3, 5)  # decorator included, exact lines
    assert any(c["symbol"] == "m" for c in chunks) and any(c["symbol"] == "(module)" for c in chunks)
    ts = chunk_generic("a.ts", "import x from 'y'\nexport function go() {\n  return 1\n}\nexport class K {}\n")
    assert [c["symbol"] for c in ts] == ["(header)", "go", "K"]
    files, readme = read_zip(make_zip())
    assert "node_modules/x/index.js" not in files and "logo.png" not in files and readme.startswith("# Demo")
    assert imports_of("app/main.py", files["app/main.py"], set(files)) == {"app/utils.py"}
    assert imports_of("web/index.ts", files["web/index.ts"], set(files)) == {"web/api.ts"}


def test_codelens_index_ask_tour(app_client):
    c = app_client
    bad = parse_sse(c.post("/api/code/repos", json={"url": "https://evil.example/x/y"}).text)
    assert bad[-1][0] == "error"
    events = parse_sse(c.post("/api/code/repos", json={"url": "https://github.com/acme/demo"}).text)
    assert [e for e, _ in events if e == "stage"] and events[-1][0] == "done"
    repo = events[-1][1]["repo"]
    assert ["app/main.py", "app/utils.py"] in repo["edges"] and repo["languages"]
    ans = c.post(f"/api/code/repos/{repo['id']}/ask", json={"question": "how is slugify implemented?"}).json()
    assert any(s["path"] == "app/utils.py" for s in ans["sources"])
    tour = c.post(f"/api/code/repos/{repo['id']}/tour").json()
    assert [s["path"] for s in tour["steps"]] == ["app/main.py", "app/utils.py", "web/index.ts"]
    snip = c.get(f"/api/code/repos/{repo['id']}/file", params={"path": "app/utils.py", "start": 1, "end": 5}).json()
    assert "def slugify" in snip["text"]
    assert c.get(f"/api/code/repos/{repo['id']}/file", params={"path": "../../.env"}).status_code == 404
    assert c.delete(f"/api/code/repos/{repo['id']}").status_code == 204


# ── FlowForge ────────────────────────────────────────────────────────────
def test_flow_validation_and_helpers():
    base = {"name": "x", "nodes": [{"id": "t", "type": "trigger"}, {"id": "o", "type": "output", "data": {"value": "{{nope}}"}}],
            "edges": [{"source": "t", "target": "o"}]}  # fmt: skip
    assert any("unknown node" in e for e in validate(FlowIn.model_validate(base)))
    cyc = {**base, "nodes": [*base["nodes"], {"id": "l", "type": "llm", "data": {"prompt": "hi"}}],
           "edges": [{"source": "t", "target": "l"}, {"source": "l", "target": "o"}, {"source": "o", "target": "l"}]}  # fmt: skip
    assert any("cycle" in e for e in validate(FlowIn.model_validate(cyc)))
    no_trigger = {"name": "x", "nodes": [{"id": "o", "type": "output", "data": {"value": "a"}}]}
    assert "exactly one trigger" in " ".join(validate(FlowIn.model_validate(no_trigger)))
    assert render("Hi {{a}} / {{b.k}}", {"a": "A", "b": {"k": 1}}) == "Hi A / 1"
    assert check("contains", "Price list", "price") and check("gt", "5", "3") and not check("regex", "x", "(")
    for url in ("http://example.com", "https://localhost/x", "https://127.0.0.1/", "https://user:pw@example.com/"):
        with pytest.raises(ValueError):
            asyncio.run(safe_http("GET", url, None))


def test_flow_run_branches_and_webhook(app_client):
    c = app_client
    templates = c.get("/api/flows/templates").json()

    async def fake_http(method, url, body):
        return "HTTP 200\nOur price is great."

    c.app.state.suite.flows.http = fake_http
    flow = c.post("/api/flows", json=templates[0]).json()
    events = parse_sse(c.post(f"/api/flows/{flow['id']}/run", json={"payload": "https://example.com"}).text)
    names = [(e, d.get("node")) for e, d in events]
    assert ("node_end", "out_yes") in names and ("node_skip", "out_no") in names
    assert events[-1][0] == "done" and events[-1][1]["output"].startswith("💰")
    assert c.get(f"/api/flows/{flow['id']}/runs").json()[0]["status"] == "ok"

    hook = c.post("/api/flows", json=templates[1]).json()
    r = c.post(f"/api/hooks/{hook['hook_token']}", json={"text": "Electricity bill ₹1,840 due on the 15th"})
    assert r.status_code == 200 and r.json()["output"].startswith("Saved to Keeper")
    assert c.get("/api/keeper/entries?kind=bill").json()[0]["title"].lower().startswith("electricity")
    assert c.post("/api/hooks/not-a-token", json={}).status_code == 404
    bad = {**templates[0], "nodes": templates[0]["nodes"][:1]}
    assert c.post("/api/flows", json=bad).status_code == 422


# ── TripWeaver ───────────────────────────────────────────────────────────
def test_trip_plan_replan_vote_weather(app_client):
    c = app_client
    events = parse_sse(c.post("/api/trips/plan", json={"prompt": "2 days in Lisbon from May 1 2030, love food"}).text)
    steps = [d["step"] for e, d in events if e == "step"]
    assert steps == ["understand", "geocode", "weather", "plan", "map"] and events[-1][0] == "done"
    trip = events[-1][1]["trip"]
    act = trip["days"][0]["activities"][0]
    assert act["lat"] and trip["days"][0]["weather"]["rain"] == 80 and trip["days"][0]["date"] == "2030-05-01"

    wx = c.post(f"/api/trips/{trip['id']}/weather-check").json()
    assert wx["alerts"][0]["day"] == 1 and "Castelo de São Jorge" in wx["alerts"][0]["outdoor"]
    out = c.post(f"/api/trips/{trip['id']}/replan", json={"event": "Heavy rain on day 1"}).json()
    assert out["days_changed"] == [1] and out["trip"]["version"] == 2
    assert (
        out["trip"]["days"][0]["activities"][0]["name"] == "Gulbenkian Museum"
        and out["trip"]["days"][1]["changed"] is False
    )

    new_act = out["trip"]["days"][1]["activities"][0]["id"]
    voted = c.post(f"/api/trips/{trip['id']}/votes", json={"activity_id": new_act, "voter": "Sam", "value": 1}).json()
    assert voted["days"][1]["activities"][0]["votes"] == {"Sam": 1}
    assert (
        c.post(f"/api/trips/{trip['id']}/votes", json={"activity_id": "nope", "voter": "Sam", "value": 1}).status_code
        == 404
    )


# ── Portfolio contact form ───────────────────────────────────────────────
def test_contact_form(app_client):
    c = app_client
    ok = {"name": "Asha", "email": "asha@example.com", "message": "Loved CodeLens, let's talk!"}
    assert c.post("/api/contact", json=ok).status_code == 202
    assert c.post("/api/contact", json={**ok, "email": "not-an-email"}).status_code == 422
    assert c.post("/api/contact", json={**ok, "message": "hi"}).status_code == 422
    assert (
        c.post("/api/contact", json={**ok, "website": "http://spam"}).status_code == 202
    )  # honeypot: silently dropped
    assert c.get("/api/contact").status_code == 404  # inbox hidden without an admin key configured
    assert [m["name"] for m in c.app.state.suite.inbox.list("messages")] == ["Asha"]
