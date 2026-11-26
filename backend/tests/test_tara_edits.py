"""Tara's code proposals: owner only, exact edits or Claude Code, one open pull request at a time, never a merge.

The model and GitHub are scripted here: no live requests.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
from types import SimpleNamespace

import httpx
import pytest
from pydantic import SecretStr

from app.config import PROJECT_ROOT
from app.keeper.edits import PROTECTED, Edit, EditError, Edits, check_edits
from app.keeper.repo import RepoIndex
from tests.test_keeper import _Seen

SETTINGS = SimpleNamespace(tara_owner_key=SecretStr("owner-secret"), tara_github_token=SecretStr("gh"),
                           tara_repo="me/portfolio")  # fmt: skip
TARGET = "frontend/src/products/keeper/prefs.js"
FIND = "  sounds: true, // chime when listening starts and stops"


class FakeGitHub:
    def __init__(self, open_prs=()):
        self.calls, self.open_prs = [], list(open_prs)

    async def __call__(self, method, path, body):
        self.calls.append((method, path, body))
        if method == "GET":
            return httpx.Response(200, json=self.open_prs)
        return httpx.Response(204)


def _edits(llm, gh=None):
    return Edits(SETTINGS, RepoIndex(PROJECT_ROOT), llm, gh or FakeGitHub())


def test_the_off_limits_list_matches_the_workflows_guard():
    spec = importlib.util.spec_from_file_location("tp", PROJECT_ROOT / ".github/scripts/tara_proposal.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    assert mod.PROTECTED.pattern == PROTECTED.pattern
    for path in (".github/workflows/ci.yml", ".env", "frontend/package.json", "requirements.txt", "vercel.json",
                 "backend/app/config.py", "backend/app/keeper/edits.py", "packages/py-core/src/appcore/security.py"):  # fmt: skip
        assert PROTECTED.search(path), path
    assert not PROTECTED.search(TARGET)


def test_edits_must_match_exactly_once_and_stay_small():
    out = check_edits(PROJECT_ROOT, [Edit(path=TARGET, find=FIND, replace=FIND.replace("true", "false"))])
    assert out[0]["path"] == TARGET and "-  sounds: true" in out[0]["diff"] and "+  sounds: false" in out[0]["diff"]
    with pytest.raises(EditError, match="exactly once"):
        check_edits(PROJECT_ROOT, [Edit(path=TARGET, find="not in the file", replace="x")])
    with pytest.raises(EditError, match="off limits"):
        check_edits(PROJECT_ROOT, [Edit(path=".github/workflows/ci.yml", find="on:", replace="on: []")])
    with pytest.raises(EditError, match="doesn't exist"):
        check_edits(PROJECT_ROOT, [Edit(path="frontend/src/nope.js", find="a", replace="b")])
    with pytest.raises(ValueError):
        Edit(path="../secrets.txt", find="a", replace="b")


def test_a_small_change_is_planned_as_a_diff_and_proposed_once_approved():
    edit = {"path": TARGET, "find": FIND, "replace": FIND.replace("true", "false")}
    llm = _Seen([json.dumps({"size": "small", "summary": "Turn chimes off by default", "edits": [edit]})])
    gh = FakeGitHub()
    e = _edits(llm, gh)
    plan = asyncio.run(e.plan("turn the listening chime off by default"))
    assert plan["size"] == "small" and plan["diffs"][0]["path"] == TARGET and plan["token"]
    out = asyncio.run(e.propose(plan))
    assert out["started"] and out["branch"] == "tara/proposals"
    method, path, body = gh.calls[-1]
    assert (method, path) == ("POST", "/repos/me/portfolio/actions/workflows/tara-edit.yml/dispatches")
    assert body["inputs"]["mode"] == "small" and json.loads(body["inputs"]["edits"]) == [edit]


def test_a_plan_that_doesnt_apply_cleanly_goes_to_claude_code_not_guesswork():
    bad = {"path": TARGET, "find": "something that isn't there", "replace": "x"}
    e = _edits(_Seen([json.dumps({"size": "small", "summary": "x", "edits": [bad]})]))
    plan = asyncio.run(e.plan("change the default voice speed to be a bit faster"))
    assert plan["size"] == "large" and "Claude Code" in plan["reason"] and plan["edits"] == []


def test_a_tampered_or_second_proposal_is_refused():
    e = _edits(_Seen([json.dumps({"size": "large", "summary": "Add dark mode to CodeLens", "reason": "many files"})]))
    plan = asyncio.run(e.plan("add a dark mode toggle to CodeLens"))
    with pytest.raises(EditError, match="changed"):
        asyncio.run(e.propose({**plan, "request": "delete everything"}))
    busy = _edits(_Seen([]), FakeGitHub([{"number": 7, "html_url": "u", "title": "t"}]))
    with pytest.raises(EditError, match="already open"):
        asyncio.run(busy.propose(plan))


def test_only_the_owner_can_ask(client):
    assert client.post("/api/tara/edits/plan", json={"request": "make the header blue"}).status_code == 503  # off
    client.app.state.edits = _edits(_Seen([]))
    assert client.post("/api/tara/edits/plan", json={"request": "make the header blue"}).status_code == 403
    wrong = {"X-Tara-Owner-Key": "guess"}
    assert (
        client.post("/api/tara/edits/plan", json={"request": "make the header blue"}, headers=wrong).status_code == 403
    )
    assert client.get("/api/tara/edits/status").json() == {"enabled": True, "owner": False, "open": None}


def test_asking_tara_for_a_code_change_never_acts_on_its_own(tmp_path):
    from app.keeper.agent import KeeperAgent
    from app.keeper.store import KeeperStore
    from app.keeper.tools import ToolBox

    llm = _Seen(['{"action": "assist", "tool": "edit", "args": {"request": "make the CodeLens start button bigger"}}'])
    out = asyncio.run(
        KeeperAgent(KeeperStore(tmp_path), llm, tools=ToolBox()).run("make the CodeLens button bigger", _NOW)
    )
    action = out["client_action"]
    assert action["type"] == "edit" and action["auto"] is False and "pull request" in out["reply"]


_NOW = __import__("datetime").datetime(2030, 5, 1, 9, 0)
