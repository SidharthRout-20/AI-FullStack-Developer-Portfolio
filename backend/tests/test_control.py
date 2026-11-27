"""The control room: owner-only settings for the AI provider, products and Tara; spend capped; nothing secret exposed.

No live provider calls: the paid model is a stub that reports token counts like Claude does.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.control import FREE_ONLY, Control, ControlConfig, SwitchableLLM, set_active
from app.main import create_app

KEY = {"X-Tara-Owner-Key": "owner-secret"}


@pytest.fixture
def owned(settings, service_factory):
    s = settings.model_copy(
        update={"tara_owner_key": SecretStr("owner-secret"), "anthropic_api_key": SecretStr("sk-test-not-real")}
    )
    with TestClient(create_app(s, service_factory=service_factory)) as c:
        yield c
    set_active(None)


def _cfg(**ai):
    return {"ai": {"provider": "groq", **ai}, "products": {"tara": True, "safarnaama": True, "codelens": True, "jasoos": True, "labs": True},
            "tara": {"lookups": True, "product_handoff": True, "code_proposals": True, "history_turns": 6}}  # fmt: skip


def test_only_the_owner_can_read_or_change_it_and_no_secret_is_ever_returned(owned):
    assert owned.get("/api/control").status_code == 403
    assert owned.get("/api/control", headers={"X-Tara-Owner-Key": "wrong"}).status_code == 403
    d = owned.get("/api/control", headers=KEY).json()
    body = json.dumps(d)
    assert (
        d["keys"] == {"groq": d["keys"]["groq"], "anthropic": True}
        and "sk-test-not-real" not in body
        and "owner-secret" not in body
    )
    assert d["config"]["ai"]["provider"] == "groq" and owned.put("/api/control", json=_cfg()).status_code == 403


def test_the_schema_refuses_anything_outside_its_fixed_choices(owned):
    bad = [
        _cfg(claude_model="gpt-9"),  # not on the list
        {**_cfg(), "cors": "*"},  # security settings are not on it at all
        _cfg(provider="anthropic", monthly_budget_usd=0),  # paid needs a budget
        _cfg(monthly_budget_usd=10_000),  # bounded
        {**_cfg(), "tara": {"history_turns": 50}},
    ]
    for body in bad:
        assert owned.put("/api/control", json=body, headers=KEY).status_code == 422, body


def test_changes_apply_and_are_audited(owned):
    r = owned.put(
        "/api/control",
        json=_cfg(provider="anthropic", claude_model="claude-sonnet-5-5", monthly_budget_usd=5),
        headers=KEY,
    )
    assert r.status_code == 200
    changed = {c["setting"]: (c["from"], c["to"]) for c in r.json()["changed"]}
    assert changed["ai.provider"] == ("groq", "anthropic") and changed["ai.monthly_budget_usd"] == (0.0, 5.0)
    audit = owned.get("/api/control", headers=KEY).json()["audit"]
    assert audit[0]["changes"] and audit[0]["at"]


def test_a_paused_product_answers_503_and_the_rest_keep_working(owned):
    body = _cfg()
    body["products"]["codelens"] = False
    assert owned.put("/api/control", json=body, headers=KEY).status_code == 200
    r = owned.get("/api/code/repos")
    assert r.status_code == 503 and "paused" in r.json()["detail"]
    assert (
        owned.get("/api/health").status_code == 200
        and owned.get("/api/control/public").json()["products"]["codelens"] is False
    )
    assert owned.get("/api/control", headers=KEY).status_code == 200  # the control room itself never pauses


def test_without_a_key_on_the_server_paid_cannot_be_switched_on(settings, service_factory):
    s = settings.model_copy(update={"tara_owner_key": SecretStr("owner-secret"), "anthropic_api_key": None})
    with TestClient(create_app(s, service_factory=service_factory)) as c:
        r = c.put("/api/control", json=_cfg(provider="anthropic", monthly_budget_usd=5), headers=KEY)
        assert r.status_code == 409 and "ANTHROPIC_API_KEY" in r.json()["detail"]
    set_active(None)


# ── The switch itself ──────────────────────────────────────────────────────
class _Free:
    def __init__(self):
        self.tasks = []

    def for_task(self, task):
        self.tasks.append(task)
        return self

    async def complete(self, system, messages, **_):
        return "free"


class _Claude:
    calls = 0
    fail = False

    def __init__(self, settings):
        self.model = settings.claude_model

    async def complete(self, system, messages, **_):
        if _Claude.fail:
            raise RuntimeError("provider down")
        _Claude.calls += 1
        self.last_usage = SimpleNamespace(input_tokens=1_000_000, output_tokens=100_000)  # Sonnet: $2 + $1
        return f"paid:{self.model}"


def _switch(settings, cfg: ControlConfig):
    control = Control(settings)
    control.save(cfg)
    free = _Free()
    return control, free, SwitchableLLM(free, control, settings, claude_factory=_Claude)


def test_paid_calls_are_metered_capped_scoped_and_fall_back_safely(settings):
    _Claude.calls, _Claude.fail = 0, False
    cfg = ControlConfig.model_validate(
        _cfg(provider="anthropic", claude_model="claude-sonnet-5-5", monthly_budget_usd=5, paid_for=["tara"])
    )
    control, free, llm = _switch(settings, cfg)
    ask = lambda task: asyncio.run(llm.for_task(task).complete("s", [{"role": "user", "content": "hi"}]))  # noqa: E731

    assert ask("keeper.chat") == "paid:claude-sonnet-5-5"
    assert control.spend()["usd"] == pytest.approx(3.0) and control.spend()["input_tokens"] == 1_000_000
    assert ask("codelens.ask") == "free"  # CodeLens is not in "paid for"
    token = FREE_ONLY.set(True)
    assert ask("keeper.chat") == "free"  # evals never spend the budget
    FREE_ONLY.reset(token)
    assert ask("keeper.chat") == "paid:claude-sonnet-5-5"  # $6 now: over the $5 budget
    assert ask("keeper.chat") == "free" and control.spend()["budget_fallbacks"] == 1
    _Claude.fail = True
    control.save(
        ControlConfig.model_validate(_cfg(provider="anthropic", claude_model="claude-haiku-5-5", monthly_budget_usd=50))
    )
    assert ask("keeper.chat") == "free" and control.spend()["errors"] == 1  # the site keeps working
    assert control.spend()["month"] == dt.datetime.now(dt.UTC).strftime("%Y-%m")


def test_taras_switches_apply_per_request(owned):
    body = _cfg()
    body["tara"] = {"lookups": False, "product_handoff": False, "code_proposals": False, "history_turns": 6}
    assert owned.put("/api/control", json=body, headers=KEY).status_code == 200
    r = owned.post("/api/keeper/command", json={"text": "weather in Pune"}).json()
    assert "turned off" in r["reply"].lower()
    r = owned.post("/api/keeper/command", json={"text": "plan a trip to Goa"}).json()
    assert not (r.get("client_action") or {}).get("url", "").startswith("/safarnaama")
    assert (
        owned.post("/api/tara/edits/plan", json={"request": "make the button bigger"}, headers=KEY).status_code == 503
    )
