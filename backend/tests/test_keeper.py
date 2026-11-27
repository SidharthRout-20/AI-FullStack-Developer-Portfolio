"""Keeper: parser, scheduling rules, store, and the HTTP API (offline: fake LLM + fake vision)."""

from __future__ import annotations

import asyncio
import datetime as dt
import itertools
import json

import pytest
from fastapi.testclient import TestClient
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from pydantic import SecretStr

from app.keeper import schedule
from app.keeper.models import Entry
from app.keeper.parser import parse_date, parse_times, rule_parse
from app.keeper.service import KeeperService
from app.keeper.store import KeeperStore, image_type
from app.main import create_app
from app.rag.service import RAGService
from appcore.llm.chat import LangChainLLM
from tests.conftest import FakeEmbedder

TODAY = dt.date(2026, 11, 10)  # a Tuesday
NOW = dt.datetime(2026, 11, 10, 10, 0)
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


# ── Parser (offline understanding) ────────────────────────────────────────
@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            "Passport is in the top drawer",
            {"action": "add", "kind": "stash", "title": "Passport", "place": "in the top drawer"},
        ),
        (
            "spare keys, blue box in hall cupboard",
            {"kind": "stash", "title": "Spare keys", "place": "blue box in hall cupboard"},
        ),
        ("Where are my spare keys?", {"action": "find", "query": "spare keys"}),
        (
            "I parked the car at level B2, pillar 14",
            {"kind": "parking", "title": "Car", "place": "level B2, pillar 14"},
        ),
        ("where did I park", {"action": "find", "kind": "parking"}),
        ("lent my drill to Raj", {"kind": "loan", "direction": "lent", "title": "Drill", "person": "Raj"}),
        ("Raj returned the drill", {"action": "done", "kind": "loan", "title": "Drill"}),
        ("borrowed a tent from Priya until 20 Dec", {"direction": "borrowed", "date": dt.date(2026, 12, 20)}),
        ("we're out of milk and eggs", {"action": "add", "kind": "pantry", "items": ["Milk", "Eggs"]}),
        ("bought milk", {"action": "done", "kind": "pantry", "items": ["Milk"]}),
        ("shopping list", {"action": "list", "kind": "pantry"}),
        ("Mom's birthday is on 14 March", {"kind": "occasion", "person": "Mom", "date": dt.date(2027, 3, 14)}),
        ("gift idea for mom: silk scarf", {"kind": "occasion", "person": "Mom", "gift_idea": "Silk scarf"}),
        ("Car insurance expires on 12/03/2027", {"kind": "expiry", "title": "Car insurance", "category": "insurance"}),
        ("passport expiry March 2031", {"kind": "expiry", "date": dt.date(2031, 3, 31)}),
        (
            "Netflix subscription 649 rs monthly renews on 2 Dec",
            {"kind": "bill", "amount": 649, "recurring": "monthly", "subscription": True},
        ),
        (
            "HDFC: Rs 2,340.00 debited for your Airtel postpaid bill due 18/11/2026",
            {"kind": "bill", "title": "Airtel postpaid bill", "amount": 2340},
        ),
        ("Rent 18000 due on 1st every month", {"kind": "bill", "amount": 18000, "date": dt.date(2026, 12, 1)}),
        ("AC filter needs cleaning every 3 months", {"kind": "appliance", "title": "AC filter", "every_months": 3}),
        ("the water purifier was serviced", {"action": "done", "kind": "appliance", "title": "Water purifier"}),
        (
            "take vitamin D at 9am daily",
            {"kind": "care", "subject": "medicine", "title": "Vitamin D", "times": ["09:00"]},
        ),
        ("water the monstera every 3 days", {"kind": "care", "subject": "plant", "every_days": 3}),
        ("Metformin 500mg at 8am and 8pm", {"kind": "care", "subject": "medicine", "times": ["08:00", "20:00"]}),
        ("Remind me to pay rent tomorrow at 9am", {"kind": "care", "subject": "other", "title": "Pay rent"}),
        ("what's due today", {"action": "brief"}),
    ],
)
def test_rule_parse(text, expected):
    cmd = rule_parse(text, TODAY).model_dump()
    for key, value in expected.items():
        assert cmd[key] == value, (text, key, cmd[key])


def test_parse_dates_and_times():
    assert parse_date("on the 15th", TODAY) == dt.date(2026, 11, 15)
    assert parse_date("on the 5th", TODAY) == dt.date(2026, 12, 5)  # already passed this month
    assert parse_date("in 2 weeks", TODAY) == dt.date(2026, 11, 24)
    assert parse_date("on friday", TODAY) == dt.date(2026, 11, 13)
    assert parse_date("2027-01-31", TODAY) == dt.date(2027, 1, 31)
    assert parse_date("31/02/2027", TODAY) is None  # invalid → no date, not a crash
    assert parse_times("at 8am and 8:30 pm") == ["08:00", "20:30"]


# ── Scheduling rules ──────────────────────────────────────────────────────
def _entry(**kw) -> Entry:
    base = {
        "id": "x",
        "kind": "bill",
        "title": "T",
        "created_at": "2026-01-01T00:00:00",
        "updated_at": "2026-01-01T00:00:00",
    }
    return Entry.model_validate(base | kw)


def test_month_math_and_yearly():
    assert schedule.add_months(dt.date(2026, 1, 31), 1) == dt.date(2026, 2, 28)
    assert schedule.next_yearly(2, 29, dt.date(2026, 3, 1)) == dt.date(2027, 2, 28)
    assert schedule.next_yearly(11, 10, TODAY) == TODAY


def test_done_rolls_recurring_forward():
    bill = _entry(due=dt.date(2026, 9, 2), data={"recurring": "monthly"})
    assert schedule.on_done(bill, NOW)["due"] == dt.date(2026, 12, 2)  # caught up past today
    once = _entry(due=TODAY, data={"recurring": "none"})
    assert schedule.on_done(once, NOW) == {"status": "done"}
    med = _entry(kind="care", due=TODAY, due_time="09:00", data={"times": ["09:00", "21:00"]})
    assert schedule.on_done(med, NOW)["due_time"] == "21:00"
    reminder = _entry(kind="care", due=TODAY, data={"subject": "other"})
    assert schedule.on_done(reminder, NOW) == {"status": "done"}


def test_agenda_buckets_and_nudges():
    entries = [
        _entry(id="a", kind="expiry", title="Passport", due=TODAY + dt.timedelta(days=20)),
        _entry(
            id="b",
            kind="loan",
            title="Drill",
            person="Raj",
            due=TODAY - dt.timedelta(days=2),
            data={"direction": "lent"},
        ),
        _entry(
            id="c",
            kind="bill",
            title="Gym",
            due=TODAY + dt.timedelta(days=60),
            data={"subscription": True, "last_used": "2026-09-01"},
        ),
        _entry(id="d", kind="appliance", title="AC", due=TODAY + dt.timedelta(days=20)),  # outside the 7-day window
    ]
    items = schedule.agenda(entries, NOW)
    assert [(i.bucket, i.entry.id) for i in items] == [("overdue", "b"), ("soon", "a"), ("nudge", "c")]
    assert items[0].label == "Get Drill back from Raj (was due 2 days ago)"


# ── Store ─────────────────────────────────────────────────────────────────
def test_store_search_and_photos(tmp_path):
    store = KeeperStore(tmp_path)
    store.add(
        {"kind": "stash", "title": "Spare keys", "place": "blue box", "data": {"caption": "silver keys on a red ring"}}
    )
    store.add({"kind": "stash", "title": "Passport", "place": "top drawer"})
    assert store.search("where are the keys")[0].title == "Spare keys"
    assert store.search("red ring")[0].title == "Spare keys"  # found through the photo caption
    assert store.search("pasport")[0].title == "Passport"  # typo-tolerant
    assert image_type(PNG) == ("png", "image/png")
    with pytest.raises(ValueError):
        store.save_photo(b"<svg onload=alert(1)>")
    assert store.photo("../../etc/passwd") is None
    kept = store.save_photo(PNG)
    store.add({"kind": "stash", "title": "Bag", "photo_id": kept})
    orphan = store.save_photo(PNG)
    assert store.prune_photos(older_than_hours=24) == 0  # too recent
    assert store.prune_photos(older_than_hours=-1) == 1  # orphan removed, referenced photo kept
    assert store.photo(kept) and store.photo(orphan) is None


# ── API ───────────────────────────────────────────────────────────────────
def say(client: TestClient, text: str, **extra) -> dict:
    r = client.post("/api/keeper/command", json={"text": text, **extra}, headers={"X-TZ-Offset": "-330"})
    assert r.status_code == 200, r.text
    return r.json()


def test_capture_find_and_move(client):
    out = say(client, "Passport is in the top drawer")
    assert out["routed_by"] == "rules" and out["kind"] == "stash"  # fake LLM returns prose → offline rules
    assert [s["node"] for s in out["trace"]] == ["understand", "act", "respond"]
    say(client, "Passport, bedroom safe")  # moved → same entry, new place
    found = say(client, "where is my passport?")
    assert "bedroom safe" in found["reply"]
    assert len(client.get("/api/keeper/entries?kind=stash").json()) == 1


def test_loans_pantry_and_brief(client):
    say(client, "lent my drill to Raj")
    assert say(client, "Raj returned the drill")["entries"][0]["status"] == "done"
    say(client, "we're out of milk and eggs")
    assert "Eggs, Milk" in say(client, "shopping list")["reply"]
    say(client, "bought milk")
    assert [e["title"] for e in say(client, "shopping list")["entries"]] == ["Eggs"]
    say(client, "remind me to call the bank today")
    brief = client.get("/api/keeper/brief", headers={"X-TZ-Offset": "-330"}).json()  # same tz as `say`
    assert brief["agenda"][0]["bucket"] == "today" and brief["agenda"][0]["label"].startswith("Call the bank")
    assert brief["source"] == "llm"  # the fake LLM's prose is used as the brief text
    text = schedule.template_brief(
        schedule.agenda([_entry(kind="care", title="Call the bank", due=TODAY)], NOW), ["Eggs"], None
    )
    assert text == "Today: Call the bank. Shopping list (1): Eggs."


def test_entry_crud_and_done(client):
    r = client.post(
        "/api/keeper/entries",
        json={"kind": "occasion", "title": "Mom's birthday", "person": "Mom", "due": "2000-03-14"},
    )
    assert r.status_code == 201
    entry = r.json()
    assert entry["due"].endswith("-03-14") and entry["due"] >= dt.date.today().isoformat()  # next occurrence
    r = client.patch(f"/api/keeper/entries/{entry['id']}", json={"note": "likes silk"})
    assert r.json()["note"] == "likes silk"
    done = client.post(f"/api/keeper/entries/{entry['id']}/done").json()
    assert done["status"] == "active" and done["due"] > entry["due"]  # yearly → rolls to next year
    assert client.delete(f"/api/keeper/entries/{entry['id']}").status_code == 204
    assert client.delete(f"/api/keeper/entries/{entry['id']}").status_code == 404
    assert client.get("/api/keeper/entries?kind=bogus").status_code == 422
    assert client.post("/api/keeper/entries", json={"kind": "stash", "title": "x", "evil": 1}).status_code == 422


class FakeVision:
    async def read(self, image, mime, prompt):
        if "JSON" in prompt:
            return json.dumps({"kind": "expiry", "title": "Passport", "date": "2031-03-31", "category": "id"})
        return "A blue passport in a wooden drawer."


def test_photos_scan_and_caption(client):
    client.app.state.keeper._vision = FakeVision()
    import base64

    r = client.post("/api/keeper/photos", json={"image": "data:image/png;base64," + base64.b64encode(PNG).decode()})
    assert r.status_code == 201
    photo_id = r.json()["photo_id"]
    assert client.get(f"/api/keeper/photos/{photo_id}").headers["content-type"] == "image/png"
    scan = client.post("/api/keeper/scan", json={"photo_id": photo_id}).json()
    assert scan == scan | {"kind": "expiry", "title": "Passport", "date": "2031-03-31"}
    out = say(client, "spare keys, hall drawer", photo_id=photo_id)
    assert out["entries"][0]["data"]["caption"].startswith("A blue passport")
    bad = client.post("/api/keeper/photos", json={"image": base64.b64encode(b"GIF89a" + b"0" * 40).decode()})
    assert bad.status_code == 415
    assert client.post("/api/keeper/photos", json={"image": "not base64 at all!!!" * 3}).status_code == 422


def test_status_reports_capabilities(client):
    s = client.get("/api/keeper/status").json()
    assert s["protected"] is False and s["telegram"] is False


def test_access_key_and_llm_router(settings):
    """With an access key every Keeper route needs it; a JSON-speaking LLM takes over routing."""
    command = {"action": "add", "kind": "loan", "title": "Ladder", "person": "Sam", "direction": "borrowed"}
    llm = LangChainLLM(GenericFakeChatModel(messages=itertools.cycle([AIMessage(content=json.dumps(command))])))
    s = settings.model_copy(update={"keeper_access_key": SecretStr("s3cret-key")})
    app = create_app(
        s,
        service_factory=lambda st: RAGService(st, llm_factory=lambda _: llm, embedder=FakeEmbedder()),
        keeper_factory=lambda st, rag: KeeperService(st, rag.get_llm),
    )
    with TestClient(app) as c:
        assert c.get("/api/keeper/entries").status_code == 401
        assert c.get("/api/keeper/entries", headers={"X-Keeper-Key": "wrong"}).status_code == 401
        r = c.post(
            "/api/keeper/command",
            json={"text": "got the ladder from sam"},
            headers={"X-Keeper-Key": "s3cret-key", "X-Visitor": "test-browser-0000000001"},
        )
        body = r.json()
        assert body["routed_by"] == "llm" and body["entries"][0]["data"]["direction"] == "borrowed"
        assert c.get("/api/health").status_code == 200  # other products unaffected


# ── Tijori as a personal assistant ─────────────────────────────────────────
class _Seen:
    """A scripted model that records what it was asked."""

    def __init__(self, replies):
        self.replies, self.prompts = iter(replies), []

    def __call__(self):
        outer = self

        class _LLM:
            async def complete(self, system, messages, **_):
                outer.prompts.append((system, messages[-1]["content"]))
                return next(outer.replies)

            async def stream(self, system, messages):
                yield await self.complete(system, messages)

        return _LLM()


def test_tijori_answers_questions_and_follows_the_conversation(tmp_path):
    asyncio.run(_answers(tmp_path))


async def _answers(tmp_path):
    from app.keeper.agent import KeeperAgent

    llm = _Seen(['{"action": "chat"}', "Boil it for **9 minutes**, then cool it in cold water."])
    agent = KeeperAgent(KeeperStore(tmp_path), llm)
    history = [{"role": "user", "text": "I want a hard-boiled egg"}, {"role": "assistant", "text": "Sure."}]
    prefs = {"name": "Sid", "tone": "professional", "length": "detailed"}
    out = await agent.run("how long should I boil it?", dt.datetime(2030, 5, 1, 8, 0), history=history, prefs=prefs)
    assert out["command"].action == "chat"
    assert out["reply"] == "Boil it for 9 minutes, then cool it in cold water."  # no markdown: it's read aloud
    router_msg, chat_msg = llm.prompts[0][1], llm.prompts[1][1]
    assert "I want a hard-boiled egg" in router_msg and "Now the user says: how long should I boil it?" in chat_msg
    assert "TODAY'S AGENDA: nothing due" in llm.prompts[1][0]
    system = llm.prompts[1][0]
    assert "concise, professional" in system and "up to 6 clear sentences" in system
    assert "Don't address the user by name" in system  # one answer in already: the name is kept for later


def test_tijori_still_answers_the_time_without_a_model(tmp_path):
    asyncio.run(_offline_time(tmp_path))


async def _offline_time(tmp_path):
    from app.keeper.agent import KeeperAgent

    class Down:
        async def complete(self, *a, **k):
            raise RuntimeError("offline")

    agent = KeeperAgent(KeeperStore(tmp_path), lambda: Down())
    state = {"text": "what time is it", "now": dt.datetime(2030, 5, 1, 14, 5), "history": []}
    assert await agent._chat(state) == "It's 14:05 on Wednesday, 01 May."


def test_voice_commands_are_transcribed_without_storing_audio(client):
    async def fake(audio, filename):
        assert audio == b"RIFFdata" and filename == "command.webm"
        return "  remind me to call mom at 6 pm "

    client.app.state.keeper.transcriber = fake
    import base64

    r = client.post(
        "/api/keeper/transcribe",
        json={"audio": base64.b64encode(b"RIFFdata").decode(), "mime": "audio/webm;codecs=opus"},
    )
    assert r.json() == {"text": "remind me to call mom at 6 pm"}
    assert client.post("/api/keeper/transcribe", json={"audio": "!!", "mime": "audio/webm"}).status_code == 422
    assert client.post("/api/keeper/transcribe", json={"audio": "AA==", "mime": "text/html"}).status_code == 422
    # history is accepted with commands, for follow-ups
    assert say(client, "where is my passport", history=[{"role": "user", "text": "hi"}])["action"] == "find"


# ── Tijori's tools (fake sources: no network in tests) ──────────────────────
class _Resp:
    def __init__(self, data=None, text=""):
        self._data, self.text = data, text

    def json(self):
        return self._data


async def _fake_fetch(url, params):
    if "geocoding" in url:
        return _Resp(
            {
                "results": [
                    {
                        "name": "Pune",
                        "admin1": "Maharashtra",
                        "country": "India",
                        "latitude": 18.5,
                        "longitude": 73.8,
                        "timezone": "Asia/Kolkata",
                    }
                ]
            }
        )
    if "api.open-meteo.com" in url:
        return _Resp(
            {
                "current": {
                    "temperature_2m": 27.4,
                    "apparent_temperature": 29,
                    "relative_humidity_2m": 61,
                    "weather_code": 2,
                    "wind_speed_10m": 9,
                },
                "daily": {
                    "time": ["2030-05-01", "2030-05-02"],
                    "weather_code": [2, 63],
                    "temperature_2m_max": [31, 29],
                    "temperature_2m_min": [21, 22],
                    "precipitation_probability_max": [10, 70],
                },
            }
        )
    if "news.google.com" in url:
        rss = (
            "<rss><channel><item><title>Monsoon arrives early - The Hindu</title><source>The Hindu</source>"
            "<link>https://news.example/1</link></item><item><title>No link item</title><link>javascript:x</link></item></channel></rss>"
        )
        return _Resp(text=rss)
    raise AssertionError(url)


def test_tijori_tools_look_things_up_from_real_shaped_sources():
    from app.keeper.tools import ToolBox, ToolError

    tb = ToolBox(_fake_fetch)
    w = asyncio.run(tb.weather({"place": "Pune"}, None, None, ""))
    assert (
        w["card"]["place"] == "Pune, Maharashtra, India"
        and w["card"]["temp"] == 27
        and w["card"]["days"][1]["rain"] == 70
    )
    assert "Tomorrow: 22–29°C, rain, rain chance 70%" in w["facts"]
    with pytest.raises(ToolError):  # no place, no location, no home city: ask, don't guess
        asyncio.run(tb.weather({}, None, None, ""))
    n = asyncio.run(tb.news({"topic": "monsoon"}, "en-IN"))
    assert n["card"]["items"] == [
        {"title": "Monsoon arrives early", "source": "The Hindu", "link": "https://news.example/1", "published": ""}
    ]


def test_tijori_actions_are_prepared_for_the_device_never_done_silently():
    from app.keeper.tools import ToolBox

    now = dt.datetime(2030, 5, 1, 9, 0)
    act, said = ToolBox.action("open", {"target": "YouTube"}, now)
    assert act["url"] == "https://www.youtube.com" and said == "Opening YouTube."
    act, said = ToolBox.action("call", {"contact": "Mom"}, now)
    assert act is None and "number" in said  # no contacts: ask instead of guessing
    act, _ = ToolBox.action(
        "message", {"contact": "Ravi", "number": "+91 98765 43210", "text": "Running late", "app": "whatsapp"}, now
    )
    assert act["url"] == "https://wa.me/919876543210?text=Running%20late" and act["confirm"] is True
    act, said = ToolBox.action("timer", {"minutes": 10, "label": "Tea"}, now)
    assert act == {"type": "timer", "seconds": 600, "label": "Tea"} and said == "Timer set for 10 minutes."
    act, _ = ToolBox.action("calendar", {"title": "Dentist", "date": "2030-05-03", "time": "16:30", "minutes": 30}, now)
    assert "dates=20300503T163000%2F20300503T170000" in act["url"]
    act, _ = ToolBox.action("directions", {"destination": "Pune airport", "mode": "train"}, now)
    assert "travelmode=transit" in act["url"]


def test_tijori_answers_the_weather_instead_of_refusing(tmp_path):
    from app.keeper.agent import KeeperAgent
    from app.keeper.tools import ToolBox

    llm = _Seen(
        [
            '{"action": "assist", "tool": "weather", "args": {"place": "Pune"}}',
            "It's 27 degrees and partly cloudy in Pune.",
        ]
    )
    agent = KeeperAgent(KeeperStore(tmp_path), llm, tools=ToolBox(_fake_fetch))
    out = asyncio.run(agent.run("how's the weather in Pune today?", dt.datetime(2030, 5, 1, 9, 0)))
    assert out["reply"] == "It's 27 degrees and partly cloudy in Pune." and out["card"]["type"] == "weather"
    assert "LOOK-UP RESULT: (Source: Open-Meteo) Weather for Pune" in llm.prompts[1][0]
    assert "never say you have no internet" in llm.prompts[1][0]


def test_glance_gives_the_home_screen_weather_without_a_model(client):
    from app.keeper.tools import ToolBox

    client.app.state.keeper.agent.tools = ToolBox(_fake_fetch)
    w = client.get("/api/keeper/glance", params={"city": "Pune"}).json()["weather"]
    assert w["type"] == "weather" and w["place"].startswith("Pune")
    assert client.get("/api/keeper/glance").json() == {"weather": None}  # nowhere to look: nothing, not an error


def test_tara_reads_the_mood_and_answers_a_crisis_with_care(tmp_path):
    from app.keeper.agent import KeeperAgent

    llm = _Seen(['{"action": "chat", "emotion": "stressed"}', "Let's take it one thing at a time."])
    agent = KeeperAgent(KeeperStore(tmp_path), llm)
    out = asyncio.run(agent.run("I have so much to do and I'm panicking", dt.datetime(2030, 5, 1, 9, 0)))
    assert out["command"].emotion == "stressed" and "be calm and brief" in llm.prompts[1][0]

    crisis = _Seen(['{"action": "chat", "emotion": "crisis"}'])
    out = asyncio.run(
        KeeperAgent(KeeperStore(tmp_path), crisis).run("I don't want to live anymore", dt.datetime(2030, 5, 1, 9, 0))
    )
    assert "14416" in out["reply"] and len(crisis.prompts) == 1  # a fixed, safe reply: no model improvising

    saved = _Seen(
        ['{"action": "add", "kind": "stash", "title": "Passport", "place": "top drawer", "emotion": "tired"}']
    )
    out = asyncio.run(
        KeeperAgent(KeeperStore(tmp_path), saved).run(
            "ugh, passport is in the top drawer", dt.datetime(2030, 5, 1, 9, 0)
        )
    )
    assert out["reply"].startswith("Leave this one to me.")


def test_common_tools_work_even_when_the_model_is_down():
    from app.keeper.tools import rule_tool

    assert rule_tool("what's the weather") == ("weather", {"place": None})
    assert rule_tool("how's the weather in Pune today?") == ("weather", {"place": "Pune"})
    assert rule_tool("news about cricket") == ("news", {"topic": "cricket"})
    assert rule_tool("set a timer for 10 minutes") == ("timer", {"seconds": 600, "label": "Timer"})
    assert rule_tool("open YouTube") == ("open", {"target": "YouTube"})
    assert rule_tool("passport is in the top drawer") is None
