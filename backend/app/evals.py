"""Quality: evaluation suites for every product and the platform, run on demand and stored with their date.

Two kinds of suite:

* **App checks** are deterministic: they exercise the real code paths (retrieval, parsers, rules, action builders)
  on small labelled sets. Free, fast, and safe to run any time.
* **Model evals** call the live model through the router on labelled sets (Tara's intent routing and emotion
  reading) and also record what the run itself measured: latency (p50/p95), fallbacks to offline rules, errors.

Every number comes from a run stored with its date, dataset size and failures, so nothing on the Quality page is
typed in by hand. Labelled sets are small and say so; they are a starting point, not a benchmark.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import statistics
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from rank_bm25 import BM25Okapi

from app.efi.parsers import parse_log
from app.keeper.tools import ToolBox, rule_tool
from app.products.codelens import chunk_generic, chunk_python, code_tokens
from app.rag.retriever import reciprocal_rank_fusion
from appcore.docstore import DocStore
from appcore.llm.structured import extract_json, salvage_json
from appcore.security import limiter

Result = dict[str, Any]


@dataclass
class Suite:
    id: str
    product: str  # tara | codelens | safarnaama | jasoos | platform
    title: str
    kind: str  # "app" (deterministic) | "model" (calls the live model)
    metric: str  # what the score means
    description: str
    run: Callable[..., Awaitable[Result]]
    size: int
    fingerprint: str | None = None  # model suites: identifies the labelled set (see _prior)


def _score(cases: list[tuple[Any, Any, Any]]) -> Result:
    """cases: (input, expected, got) → accuracy with the first few misses."""
    misses = [{"input": str(i)[:160], "expected": str(e)[:160], "got": str(g)[:160]} for i, e, g in cases if e != g]
    return {
        "value": (len(cases) - len(misses)) / max(1, len(cases)),
        "passed": len(cases) - len(misses),
        "total": len(cases),
        "failures": misses[:6],
    }


# ── Tara ─────────────────────────────────────────────────────────────────
TOOL_RULES = [
    ("what's the weather", ("weather", None)), ("how's the weather in Pune today?", ("weather", "Pune")),
    ("will it rain tomorrow", ("weather", None)), ("temperature in Delhi", ("weather", "Delhi")),
    ("news about cricket", ("news", "cricket")), ("latest headlines", ("news", None)),
    ("what time is it in London", ("time", "London")), ("set a timer for 10 minutes", ("timer", 600)),
    ("start a countdown of 30 seconds", ("timer", 30)), ("open YouTube", ("open", "YouTube")),
    ("launch spotify", ("open", "spotify")), ("play lo-fi beats", ("play", "lo-fi beats")),
    ("passport is in the top drawer", None), ("remind me to call mom at 6", None), ("where did I park", None),
]  # fmt: skip


async def _tara_rules(_: Request) -> Result:
    def key(hit: tuple[str, dict[str, Any]] | None) -> Any:
        if hit is None:
            return None
        tool, a = hit
        return (tool, a.get("place") or a.get("topic") or a.get("seconds") or a.get("target") or a.get("query"))

    return _score([(t, exp, key(rule_tool(t))) for t, exp in TOOL_RULES])


ACTION_CASES = [
    ("open", {"target": "YouTube"}, "https://www.youtube.com"),
    ("open", {"target": "example.org"}, "https://example.org"),
    ("play", {"query": "lofi", "service": "spotify"}, "https://open.spotify.com/search/lofi"),
    ("directions", {"destination": "Airport", "mode": "walk"}, "https://www.google.com/maps/dir/?api=1&destination=Airport&travelmode=walking"),
    ("call", {"contact": "Mom"}, None),  # no number: must ask, never guess
    ("call", {"number": "+91 98765 43210"}, "tel:+919876543210"),
    ("message", {"number": "9876543210", "text": "hi", "app": "whatsapp"}, "https://wa.me/9876543210?text=hi"),
    ("timer", {"minutes": 5}, 300),
]  # fmt: skip


async def _tara_actions(_: Request) -> Result:
    now = dt.datetime(2030, 5, 1, 9, 0)
    cases = []
    for tool, args, expected in ACTION_CASES:
        action, _said = ToolBox.action(tool, args, now)
        got = None if action is None else action.get("seconds") if tool == "timer" else action.get("url")
        cases.append((f"{tool} {args}", expected, got))
    return _score(cases)


ROUTING = [
    ("change your voice to a female one", ("assist", "settings")), ("make the CodeLens start button bigger", ("assist", "edit")),
    ("passport is in the top drawer", ("add", "stash")), ("I parked on level 2, B14", ("add", "parking")),
    ("where did I keep my passport?", ("find", None)), ("remind me to call mom at 8 pm", ("add", "care")),
    ("netflix renews on the 5th, 649 rupees", ("add", "bill")), ("I lent my drill to Ravi", ("add", "loan")),
    ("add milk and eggs to my shopping list", ("add", "pantry")), ("what's due today?", ("brief", None)),
    ("how's the weather in Mumbai?", ("assist", "weather")), ("top news in India", ("assist", "news")),
    ("who is Sundar Pichai?", ("assist", "wiki")), ("convert 100 dollars to rupees", ("assist", "currency")),
    ("what time is it in Tokyo?", ("assist", "time")), ("open YouTube", ("assist", "open")),
    ("play Arijit Singh on Spotify", ("assist", "play")), ("directions to the airport", ("assist", "directions")),
    ("message Ravi on WhatsApp that I'm running late", ("assist", "message")), ("set a timer for 10 minutes", ("assist", "timer")),
    ("add a dentist appointment on Friday at 4 pm to my calendar", ("assist", "calendar")), ("email my manager that I'm on leave", ("assist", "email")),
    ("how long should I boil an egg?", ("chat", None)), ("what's 18% of 2450?", ("chat", None)),
    ("thanks, that was helpful", ("chat", None)), ("tell me a joke", ("chat", None)),
]  # fmt: skip
EMOTION = [
    ("I have three deadlines today and I'm panicking", "stressed"), ("I'm so nervous about my interview tomorrow", "anxious"),
    ("I feel really low today, nothing is going right", "sad"), ("This app keeps failing, it's so annoying", "frustrated"),
    ("I got the job!!!", "excited"), ("thank you so much, you're a life saver", "grateful"),
    ("I'm exhausted, long day", "tired"), ("I don't understand how this works at all", "confused"),
    ("nobody ever calls me anymore", "lonely"), ("set a timer for 5 minutes", "neutral"),
    ("I'm furious, they cancelled my flight again", "angry"), ("what a lovely morning!", "happy"),
]  # fmt: skip
# Who should answer: the expert a person would ask. Neighbouring experts count (an architect or an engineer for code).
PERSONA = [
    ("Should we use Postgres or MongoDB for a booking system?", "architect"),
    ("Why does my React effect run twice?", "engineer"), ("Write user stories for a refund feature", "product"),
    ("I have chicken, rice and yoghurt. What can I cook tonight?", "chef"),
    ("I've been feeling anxious about everything lately", "therapist"), ("Mock interview me for a backend role", "interviewer"),
    ("How do I say 'where is the station' in Spanish?", "language"), ("Plan 3 relaxed days in Goa", "travel"),
    ("Is a SIP better than a fixed deposit for 5 years?", "finance"), ("My landlord won't return my deposit", "legal"),
    ("Explain photosynthesis simply", "teacher"), ("Give me a 20 minute home workout", "fitness"),
]  # fmt: skip
NEAR = [{"architect", "engineer"}, {"coach", "interviewer"}, {"teacher", "language"}, {"product", "designer"}]

# Close feelings count as right: the reply adapts the same way.
SAME = [{"stressed", "anxious"}, {"angry", "frustrated"}, {"sad", "lonely"}, {"happy", "excited", "grateful"}]


def _close(a: str | None, b: str | None) -> bool:
    return a == b or any(a in g and b in g for g in SAME)


async def _route_all(request: Request, texts: list[str]) -> tuple[list[Any | None], list[float | None]]:
    """Route each text with the live model, one at a time, inside a time budget.

    Groq's free tier allows a few thousand tokens per model per minute, so a burst of routing calls gets refused and the
    router falls back to offline rules. Scoring those would measure the rules, not the model, so a refused call waits
    for the provider's own retry hint and tries again (at most twice). Texts the model never answered come back as
    None or as a rules result; the suites report them as "not measured" instead of counting them as wrong.
    """
    agent = request.app.state.keeper.agent
    now = dt.datetime.now()
    deadline = time.perf_counter() + MODEL_BUDGET_S
    times: list[float | None] = [None] * len(texts)
    outs: list[Any | None] = [None] * len(texts)
    for i, text in enumerate(texts):
        if time.perf_counter() > deadline:
            break  # out of time: the rest stay unmeasured
        for _ in range(3):
            t0 = time.perf_counter()
            out = await agent._understand({"text": text, "now": now, "history": [], "prefs": {}, "trace": []})
            if out.get("routed_by") == "llm":
                times[i] = (time.perf_counter() - t0) * 1000
                break
            if not _rate_limited(out.get("router_error")):
                break  # no model at all (or bad output): waiting won't help
            wait = min(max(float(out.get("router_retry_after") or 6), 2.0), 20.0)
            if time.perf_counter() + wait > deadline:
                break
            await asyncio.sleep(wait)
        outs[i] = out
    return outs, times


MODEL_BUDGET_S = 110.0  # per suite (one suite per request), inside the serverless time limit


Answers = dict[str, dict[str, Any]]  # case index → {"got": what the model said (as text), "ms": its latency}


def _fingerprint(items: list[tuple[str, Any]]) -> str:
    """Identifies a labelled set: answers kept from an earlier run are reused only for the very same cases."""
    return hashlib.sha256(repr(items).encode()).hexdigest()[:16]


async def _model_suite(request: Request, items: list[tuple[str, Any]], grade: Callable[[Any, Any], str],
                       prior: Answers | None = None) -> Result:  # fmt: skip
    """Route the cases not answered yet (all of them, or the ones an earlier pass of this run could not reach),
    then score every case the model has answered. grade(expected, routed) → what the model said, as text that
    equals str(expected) when it is right."""
    answers: Answers = dict(prior or {})
    todo = [i for i in range(len(items)) if str(i) not in answers]
    outs, times = await _route_all(request, [items[i][0] for i in todo])
    for i, out, ms in zip(todo, outs, times, strict=True):
        if out is not None and out.get("routed_by") == "llm":
            answers[str(i)] = {"got": grade(items[i][1], out), "ms": round(ms or 0)}
    return {**_model_result(items, answers), "answers": answers, "fingerprint": _fingerprint(items)}


def _model_result(items: list[tuple[str, Any]], answers: Answers) -> Result:
    """Score only what the model answered; say how much that covers (a refused call is "not measured", not wrong)."""
    keep = sorted(int(i) for i in answers)
    total = len(items)
    if not keep:
        return {"value": None, "passed": 0, "total": total, "measured": 0, "failures": [], "status": "unmeasured",
                "extra": {"coverage": 0.0, "fallback_rate": 1.0}}  # fmt: skip
    scored = _score([(items[i][0], str(items[i][1]), answers[str(i)]["got"]) for i in keep])
    times = [float(answers[str(i)]["ms"]) for i in keep]
    return {**scored, "total": total, "measured": len(keep), "status": "ok" if len(keep) == total else "partial",
            "extra": {**_latency(times), "coverage": round(len(keep) / total, 3),
                      "fallback_rate": round(1 - len(keep) / total, 3)}}  # fmt: skip


def _rate_limited(error: str | None) -> bool:
    """A busy free tier (worth waiting for), as opposed to no model at all (nothing to wait for)."""
    return bool(error) and ("NoCompatibleModel" in error or "RateLimit" in error)


def _latency(times: list[float]) -> dict[str, Any]:
    """Latency of the calls the model answered (refused calls return in a millisecond and would flatter it)."""
    q = statistics.quantiles(times, n=20) if len(times) >= 2 else times or [0]
    return {"p50_ms": round(statistics.median(times or [0])), "p95_ms": round(q[-1])}


def _grade_routing(want: tuple[str, str | None], out: Any) -> str:
    action, sub = want
    c = out["command"]
    got_sub = c.tool if action == "assist" else c.kind if action == "add" else None
    return str((c.action, got_sub if sub else None))


def _grade_emotion(want: str, out: Any) -> str:
    got = out["command"].emotion or "neutral"
    return want if _close(want, got) else got


def _grade_persona(want: str, out: Any) -> str:
    got = out["command"].persona or "assistant"
    return want if got == want or any(want in g and got in g for g in NEAR) else got


async def _tara_routing(request: Request, prior: Answers | None = None) -> Result:
    return await _model_suite(request, ROUTING, _grade_routing, prior)


async def _tara_emotion(request: Request, prior: Answers | None = None) -> Result:
    return await _model_suite(request, EMOTION, _grade_emotion, prior)


async def _tara_persona(request: Request, prior: Answers | None = None) -> Result:
    return await _model_suite(request, PERSONA, _grade_persona, prior)


# ── CodeLens ─────────────────────────────────────────────────────────────
REPO = {
    "app/main.py": "from app.auth import login\nfrom app.db import save_user\n\n\ndef create_app():\n    '''Build the web app and register routes.'''\n    return {'routes': ['/login', '/signup']}\n",
    "app/auth.py": "import hashlib\n\n\ndef hash_password(pw):\n    return hashlib.sha256(pw.encode()).hexdigest()\n\n\ndef login(user, pw):\n    '''Check a password against the stored hash and start a session.'''\n    return user.hash == hash_password(pw)\n",
    "app/db.py": "import sqlite3\n\n\ndef connect(path='app.db'):\n    return sqlite3.connect(path)\n\n\ndef save_user(conn, name, email):\n    conn.execute('INSERT INTO users VALUES (?, ?)', (name, email))\n",
    "app/email.py": "import smtplib\n\n\ndef send_welcome(address):\n    '''Send the welcome email to a new user over SMTP.'''\n    with smtplib.SMTP('localhost') as s:\n        s.sendmail('noreply@example.com', address, 'Welcome!')\n",
    "web/api.ts": "export async function fetchProfile(id: string) {\n  const res = await fetch(`/api/users/${id}`)\n  return res.json()\n}\n",
    "web/cart.ts": "export function cartTotal(items: { price: number; qty: number }[]) {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0)\n}\n",
    "README.md": "# Demo shop\nA tiny web shop. Run `python -m app.main` to start it.\n",
}  # fmt: skip
QUESTIONS = [
    ("how are passwords hashed?", "app/auth.py"), ("where are users saved to the database?", "app/db.py"),
    ("how is the welcome email sent?", "app/email.py"), ("where is the app created?", "app/main.py"),
    ("how does the frontend fetch a user profile?", "web/api.ts"), ("how is the cart total calculated?", "web/cart.ts"),
    ("how do I start the project?", "README.md"), ("which database is used?", "app/db.py"),
]  # fmt: skip


async def _codelens_retrieval(request: Request) -> Result:
    embedder = request.app.state.suite.code.embedder
    chunks = [c for p, t in REPO.items() for c in (chunk_python(p, t) if p.endswith(".py") else chunk_generic(p, t))]
    texts = [f"{c['path']} {c['symbol'] or ''}\n{c['text']}" for c in chunks]
    vecs = np.asarray(await asyncio.to_thread(embedder.embed_documents, texts), dtype=np.float32)
    bm25 = BM25Okapi([code_tokens(t) or ["_"] for t in texts])
    hits1 = hits3 = 0
    misses = []
    for q, want in QUESTIONS:
        qv = np.asarray(await asyncio.to_thread(embedder.embed_query, q), dtype=np.float32)
        sims = (vecs @ qv) / (np.linalg.norm(vecs, axis=1) * (np.linalg.norm(qv) or 1) + 1e-9)
        dense = [str(i) for i in np.argsort(-sims)]
        lexical = [str(i) for i in np.argsort(-bm25.get_scores(code_tokens(q)))]
        fused = sorted(reciprocal_rank_fusion([dense, lexical]).items(), key=lambda kv: -kv[1])
        paths = list(dict.fromkeys(chunks[int(i)]["path"] for i, _ in fused))
        hits1 += paths[:1] == [want]
        hits3 += want in paths[:3]
        if want not in paths[:3]:
            misses.append({"input": q, "expected": want, "got": ", ".join(paths[:3])})
    n = len(QUESTIONS)
    return {
        "value": hits3 / n,
        "passed": hits3,
        "total": n,
        "failures": misses,
        "extra": {"hit_at_1": round(hits1 / n, 3)},
    }


# ── Safarnaama ───────────────────────────────────────────────────────────
MOMENTS = [
    ("Breakfast at Hotel", True), ("Taxi to Patan", True), ("Check-out and taxi to the airport", True),
    ("Return & Rest at Hotel", True), ("Drive to Eravikulam National Park", True), ("Short hike to the viewpoint", True),
    ("Patan Museum", False), ("Lunch at Sundarijal Guesthouse", False), ("Tata Tea Museum", False),
    ("Cable-car ride to Chandragiri Hills", False), ("Eravikulam National Park", False), ("Kumari Ghar", False),
]  # fmt: skip


async def _safarnaama_moments(_: Request) -> Result:
    from safarnama.stops import placeless

    return _score([(name, want, placeless(name)) for name, want in MOMENTS])


# ── Platform ─────────────────────────────────────────────────────────────
BROKEN_JSON = [
    ('{"title": "Trip", "days": [{"day": 1}, {"day": 2}', "title"), ('```json\n{"title": "A"}\n```', "title"),
    ('Sure! Here it is: {"title": "B", "days": []}', "title"), ('{"title": "C", "days": [1, 2,],}', "title"),
    ('{"title": "D", "summary": "cut off here', "title"), ('[{"day": 1, "activities": []}]', 0),
    ('{"title": "E", "days": [{"day": 1, "activities": [{"name": "Fort"', "title"), ("no json at all", None),
]  # fmt: skip


async def _platform_json(_: Request) -> Result:
    def recover(text: str) -> Any:
        try:
            v = extract_json(text)
        except Exception:  # noqa: BLE001
            v = salvage_json(text)
        if v is None:
            return None
        return 0 if isinstance(v, list) else ("title" if isinstance(v, dict) and "title" in v else "other")

    return _score([(t[:40], want, recover(t)) for t, want in BROKEN_JSON])


# ── Jasoos ───────────────────────────────────────────────────────────────
LOGS = [
    ("pytest", "tests/test_tax.py::test_gst FAILED\nE       TypeError: breakdown() got an unexpected keyword argument 'rate'\nFAILED tests/test_tax.py::test_gst - TypeError\n========= 1 failed, 4 passed in 0.5s =========", {"test_failure", "exception"}),
    ("github", "##[error]Process completed with exit code 1.", {"error"}),
    ("jest", "  ● Cart › computes the total\n\n    expect(received).toBe(expected)\nTests:       1 failed, 3 passed, 4 total", {"test_failure"}),
    ("node", "TypeError: Cannot read properties of undefined (reading 'map')\n    at render (src/App.jsx:12:5)", {"exception"}),
]  # fmt: skip


async def _jasoos_evidence(_: Request) -> Result:
    cases = []
    for name, log, want in LOGS:
        kinds = {i.kind for i in parse_log(0, log)}
        cases.append((name, sorted(want), sorted(want & kinds)))
    return _score(cases)


SUITES = [
    Suite("tara.routing", "tara", "Understands what you ask", "model", "routing accuracy",
          "Labelled requests: does Tara pick the right action, kind of thing and tool?", _tara_routing, len(ROUTING),
          _fingerprint(ROUTING)),
    Suite("tara.emotion", "tara", "Reads how you feel", "model", "emotion accuracy",
          "Labelled messages: does Tara sense the feeling (close feelings count, e.g. stressed/anxious)?", _tara_emotion, len(EMOTION),
          _fingerprint(EMOTION)),
    Suite("tara.persona", "tara", "Picks the right expert", "model", "expert accuracy",
          "Labelled questions: on Auto, does Tara answer as the expert a person would ask (chef, architect, listener…)?",
          _tara_persona, len(PERSONA), _fingerprint(PERSONA)),
    Suite("tara.rules", "tara", "Works without the model", "app", "offline tool recognition",
          "Weather, news, time, timers, open and play are recognised even when the model is down.", _tara_rules, len(TOOL_RULES)),
    Suite("tara.actions", "tara", "Device actions are exact", "app", "action correctness",
          "Links for open, play, directions, calls, messages and timers; calls without a number must ask, not guess.", _tara_actions, len(ACTION_CASES)),
    Suite("codelens.retrieval", "codelens", "Finds the right file", "app", "hit@3",
          "Hybrid search (local embeddings + BM25, fused with RRF) on a labelled demo repo: is the right file in the top 3?", _codelens_retrieval, len(QUESTIONS)),
    Suite("safarnaama.moments", "safarnaama", "Tells places from moments", "app", "classification accuracy",
          "Itinerary stops: real places go on the map; hotel meals, taxi rides and rests don't.", _safarnaama_moments, len(MOMENTS)),
    Suite("jasoos.evidence", "jasoos", "Extracts the evidence", "app", "evidence recall",
          "CI logs from pytest, Jest, Node and GitHub Actions: are the failures and exceptions extracted?", _jasoos_evidence, len(LOGS)),
    Suite("platform.json", "platform", "Survives broken model output", "app", "recovery accuracy",
          "Truncated, fenced, chatty or trailing-comma JSON from a model is recovered; non-JSON is refused.", _platform_json, len(BROKEN_JSON)),
]  # fmt: skip
PRODUCTS = ["tara", "codelens", "safarnaama", "jasoos", "platform"]


# ── API ──────────────────────────────────────────────────────────────────
router = APIRouter(prefix="/api/evals", tags=["quality"])


def _store(request: Request) -> DocStore:
    st = request.app.state
    if getattr(st, "evals", None) is None:
        s = st.keeper.settings  # the portfolio backend keeps its settings on its services
        st.evals = DocStore(s.data_dir / "evals.sqlite3", s.db_url)
    return st.evals


class RunIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    product: str = Field("all", pattern=r"^(all|tara|codelens|safarnaama|jasoos|platform)$")
    models: bool = False  # also run the suites that call the live model
    suite: str | None = Field(
        None, max_length=40, pattern=r"^[a-z.]+$"
    )  # just this one (the page runs models one at a time)
    # Pick up where this suite's last run stopped: only the cases the free tier refused are asked again (the page
    # does this for a run that came back partial, so one click ends with every case measured when the limits allow).
    resume: bool = False


RESUME_WITHIN = dt.timedelta(minutes=30)


def _prior(store: DocStore, s: Suite) -> Answers | None:
    """The answers of this suite's latest run, if it was recent, partial and on the same labelled cases."""
    last = next((d for d in store.list("results", limit=200) if d.get("suite") == s.id), None)
    if not last or last.get("status") != "partial" or not last.get("answers"):
        return None
    ran = dt.datetime.fromisoformat(last["ran_at"])
    if dt.datetime.now(dt.UTC) - ran > RESUME_WITHIN or last.get("fingerprint") != s.fingerprint:
        return None
    return last["answers"]


def _public(doc: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in doc.items() if k not in ("answers", "fingerprint")}


def _meta(s: Suite) -> dict[str, Any]:
    return {
        "id": s.id,
        "product": s.product,
        "title": s.title,
        "kind": s.kind,
        "metric": s.metric,
        "description": s.description,
        "size": s.size,
    }


@router.get("/suites")
def suites() -> list[dict[str, Any]]:
    return [_meta(s) for s in SUITES]


@router.get("/latest")
def latest(request: Request) -> dict[str, Any]:
    """The most recent result of every suite (each stored with its own run date)."""
    out: dict[str, Any] = {}
    for doc in _store(request).list("results", limit=200):
        out.setdefault(doc["suite"], doc)
    return {"results": [_public(out[s.id]) for s in SUITES if s.id in out], "suites": [_meta(s) for s in SUITES]}


@router.post("/run")
@limiter.limit("60/hour")  # one "Run with live model" click is up to 1 + 3 suites × 3 passes
async def run(request: Request, body: RunIn) -> dict[str, Any]:
    chosen = [
        s
        for s in SUITES
        if (body.product == "all" or s.product == body.product)
        and (body.models or s.kind == "app")
        and (body.suite is None or s.id == body.suite)
    ]
    if not chosen:
        raise HTTPException(422, "No suites match.")
    store = _store(request)
    results = []
    for s in chosen:
        t0 = time.perf_counter()
        try:
            prior = _prior(store, s) if body.resume and s.kind == "model" else None
            r = await (s.run(request, prior) if prior else s.run(request))
            status = r.pop("status", "ok")  # model suites: ok | partial (some cases not measured) | unmeasured
        except Exception as exc:  # noqa: BLE001 - a broken suite is reported, not hidden
            r, status = (
                {"value": None, "passed": 0, "total": s.size, "failures": [], "error": type(exc).__name__},
                "error",
            )
        doc = {**_meta(s), **r, "suite": s.id, "status": status, "ms": round((time.perf_counter() - t0) * 1000),
               "ran_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds")}  # fmt: skip
        results.append(_public(store.put("results", doc)))
    return {"results": results}
