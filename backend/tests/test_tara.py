"""Tara's experts, its sparing use of the user's name, and its read-only knowledge of this portfolio (code and docs).

The model is always scripted here: no live requests.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import re

import pytest

from app.config import PROJECT_ROOT
from app.keeper.agent import KeeperAgent, drop_name, name_allowed
from app.keeper.personas import PERSONAS, valid
from app.keeper.repo import RepoIndex
from app.keeper.store import KeeperStore
from app.keeper.tools import ToolBox, ToolError
from tests.test_keeper import _Seen

NOW = dt.datetime(2030, 5, 1, 19, 0)


def test_personas_match_the_app():
    js = (PROJECT_ROOT / "frontend/src/products/keeper/personas.js").read_text(encoding="utf-8")
    keys = re.findall(r"\{ key: '([a-z]+)'", js)
    assert set(keys) - {"auto"} == set(PERSONAS)
    assert valid("Chef") == "chef" and valid("auto") is None and valid("pirate") is None


def test_tara_answers_as_the_expert_the_router_picks(tmp_path):
    llm = _Seen(['{"action": "chat", "persona": "chef"}', "Make a quick egg bhurji with the spinach folded in."])
    agent = KeeperAgent(KeeperStore(tmp_path), llm, tools=ToolBox())
    out = asyncio.run(agent.run("I have eggs and spinach, what can I cook?", NOW))
    assert out["persona"] == "chef"
    system = llm.prompts[1][0]
    assert "renowned chef" in system and "up to 8 clear sentences" in system  # experts get room to answer
    assert '"chef" (Chef): recipes' in llm.prompts[0][0]  # the router sees the menu of experts


def test_the_users_pick_wins_for_that_question(tmp_path):
    llm = _Seen(['{"action": "chat", "persona": "chef"}', "Use Postgres: bookings need transactions."])
    agent = KeeperAgent(KeeperStore(tmp_path), llm, tools=ToolBox())
    out = asyncio.run(agent.run("Postgres or Mongo for bookings?", NOW, persona="architect"))
    assert out["persona"] == "architect" and "senior software architect" in llm.prompts[1][0]


def test_saves_and_device_actions_have_no_persona(tmp_path):
    llm = _Seen(['{"action": "assist", "tool": "open", "args": {"target": "CodeLens"}, "persona": "engineer"}'])
    agent = KeeperAgent(KeeperStore(tmp_path), llm, tools=ToolBox())
    out = asyncio.run(agent.run("open CodeLens", NOW))
    assert out.get("persona") is None
    assert out["client_action"]["url"] == "/codelens"  # this site's products open in place


def test_the_users_name_is_used_sparingly():
    a = {"role": "assistant", "text": "Done."}
    assert name_allowed("Sid", []) is True  # the first answer may greet them
    assert [name_allowed("Sid", [a] * n) for n in range(1, 9)] == [False, False, False, True, False, False, False, True]
    assert name_allowed("Sid", [{"role": "assistant", "text": "Done, Sid."}] * 4) is False  # never twice in a row
    assert name_allowed("", []) is False
    assert drop_name("Sure, Sid! It's 9 pm.", "Sid") == "Sure! It's 9 pm."
    assert drop_name("Sid, your passport is in the drawer.", "Sid") == "Your passport is in the drawer."
    assert drop_name("Sidharth built CodeLens.", "Sid") == "Sidharth built CodeLens."  # only the form of address


def test_a_reply_that_overuses_the_name_is_trimmed(tmp_path):
    llm = _Seen(['{"action": "chat"}', "Of course, Sid! Drink some water and rest."])
    agent = KeeperAgent(KeeperStore(tmp_path), llm, tools=ToolBox())
    history = [{"role": "user", "text": "hi"}, {"role": "assistant", "text": "Hi! How can I help?"}]
    out = asyncio.run(agent.run("I have a headache", NOW, history=history, prefs={"name": "Sid"}))
    assert out["reply"] == "Of course! Drink some water and rest."
    assert "Don't address the user by name" in llm.prompts[1][0]


def test_tara_reads_this_apps_own_code_read_only():
    repo = RepoIndex(PROJECT_ROOT)
    files = [p.relative_to(PROJECT_ROOT).as_posix() for p in repo.files()]
    assert "frontend/src/products/keeper/voice.js" in files and "backend/app/keeper/agent.py" in files
    assert not any(re.search(r"(^|/)(tests?/|test_|.*\.test\.)|\.env|node_modules|/data/", f) for f in files)
    out = asyncio.run(ToolBox(repo=repo).code({"query": "Hey Tara wake word afterWake"}))
    assert any(h["path"].endswith("keeper/voice.js") for h in out["card"]["hits"])
    assert "FILE frontend/src/products/keeper/voice.js" in out["facts"]
    with pytest.raises(ToolError):
        asyncio.run(ToolBox().code({"query": "anything"}))  # no source on this server: said plainly


def test_code_answers_survive_the_answering_model_being_down(tmp_path):
    llm = _Seen(
        ['{"action": "assist", "tool": "code", "args": {"query": "wake word Hey Tara afterWake"}}']
    )  # then fails
    agent = KeeperAgent(KeeperStore(tmp_path), llm, tools=ToolBox(repo=RepoIndex(PROJECT_ROOT)))
    out = asyncio.run(agent.run("how does the wake word work in the code?", NOW))
    assert out["reply"].startswith("Here's where that lives in the code:") and "voice.js" in out["reply"]


def test_code_questions_are_answered_from_the_files(tmp_path):
    llm = _Seen(
        [
            '{"action": "assist", "tool": "code", "args": {"query": "wake word Hey Tara"}, "persona": "engineer"}',
            "The wake word is handled in voice.js by startVoice, which listens in one session.",
        ]
    )
    agent = KeeperAgent(KeeperStore(tmp_path), llm, tools=ToolBox(repo=RepoIndex(PROJECT_ROOT)))
    out = asyncio.run(agent.run("how does the Hey Tara wake word work?", NOW))
    assert out["card"]["type"] == "code" and out["persona"] == "engineer"
    assert "LOOK-UP RESULT: FILE " in llm.prompts[1][0]


def test_portfolio_questions_come_from_the_documents():
    async def knowledge(q):
        return [{"source": "resume.pdf", "text": "Built GenAI proofs of concept at Deloitte."}]

    out = asyncio.run(ToolBox(knowledge=knowledge).portfolio({"query": "What did he build at Deloitte?"}))
    assert out["card"] == {"type": "sources", "query": "What did he build at Deloitte?", "items": ["resume.pdf"],
                           "source": "Sidharth's résumé and project notes"}  # fmt: skip
    assert "Deloitte" in out["facts"]

    async def nothing(q):
        return []

    with pytest.raises(ToolError):
        asyncio.run(ToolBox(knowledge=nothing).portfolio({"query": "favourite colour"}))


def test_command_api_takes_a_persona_per_question(client):
    ok = client.post("/api/keeper/command", json={"text": "what should I cook tonight?", "persona": "chef"})
    assert ok.status_code == 200 and ok.json()["persona"] in ("chef", None)
    bad = client.post("/api/keeper/command", json={"text": "hi", "persona": "Chef!"})
    assert bad.status_code == 422


def test_a_wordy_model_is_trimmed_not_thrown_away():
    from app.keeper.models import Command

    c = Command(action="add", kind="stash", title="Passport " * 40, note="detail " * 200)
    assert len(c.title) <= 120 and len(c.note) <= 500  # still a usable command, not a fallback to rules
