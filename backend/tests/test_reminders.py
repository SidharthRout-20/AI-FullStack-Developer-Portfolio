"""Keeper reminders: alert timing, quiet hours, escalation, signed action links, cron tick and API."""

from __future__ import annotations

import datetime as dt

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.keeper import notify
from app.keeper.models import Entry
from app.keeper.reminders import ReminderSettings, alerts_for, due_now, in_quiet_hours, to_push
from app.main import create_app

IST = -330  # Date#getTimezoneOffset() in India: local = UTC + 5:30


def entry(**kw) -> Entry:
    base = {"id": "e1", "kind": "care", "title": "Call the bank", "status": "active", "data": {"subject": "other"},
            "created_at": "2026-01-01T00:00:00", "updated_at": "2026-01-01T00:00:00"}  # fmt: skip
    return Entry.model_validate({**base, **kw})


def utc(local: str) -> dt.datetime:
    """A local IST wall-clock time as naive UTC."""
    return dt.datetime.fromisoformat(local) + dt.timedelta(minutes=IST)


def test_one_off_reminders_nudge_an_hour_before_and_on_time():
    e = entry(due="2026-03-02", due_time="17:00")
    alerts = alerts_for(e, IST)
    assert [a.at for a in alerts] == [utc("2026-03-02T16:00"), utc("2026-03-02T17:00")]
    assert alerts[0].label == "Call the bank: in 1 hour (17:00)" and alerts[1].label == "Call the bank"
    medicine = entry(data={"subject": "medicine"}, due="2026-03-02", due_time="09:00")
    assert len(alerts_for(medicine, IST)) == 1  # schedules alert on time only
    assert alerts_for(entry(due="2026-03-02"), IST) == []  # no time → covered by the daily brief instead


def test_quiet_hours_cross_midnight():
    s = ReminderSettings(quiet_start="22:00", quiet_end="07:00")
    assert in_quiet_hours(dt.datetime(2026, 3, 2, 23, 30), s)
    assert in_quiet_hours(dt.datetime(2026, 3, 2, 6, 59), s)
    assert not in_quiet_hours(dt.datetime(2026, 3, 2, 7, 0), s)
    assert not in_quiet_hours(dt.datetime(2026, 3, 2, 23, 30), s.model_copy(update={"quiet_enabled": False}))


def test_push_sends_latest_alert_once_and_drops_stale_ones():
    s = ReminderSettings(quiet_enabled=False)
    e = entry(due="2026-03-02", due_time="17:00")
    send, skip = to_push([e], utc("2026-03-02T17:01"), IST, s)  # both nudges are due → only the on-time one
    assert [a.key for a in send] == ["2026-03-02T17:00/0"] and skip == {"e1": ["2026-03-02T17:00/60"]}
    sent = entry(due="2026-03-02", due_time="17:00", data={"subject": "other", "notified": [a.key for a in send]})
    assert to_push([sent], utc("2026-03-02T17:02"), IST, s)[0] == []  # not sent twice
    send, skip = to_push([e], utc("2026-03-03T09:00"), IST, s)  # 16 h late: dropped, not spammed
    assert send == [] and set(skip["e1"]) == {"2026-03-02T17:00/60", "2026-03-02T17:00/0"}


def test_quiet_hours_hold_normal_alerts_but_not_urgent_ones():
    s = ReminderSettings(quiet_start="22:00", quiet_end="07:00")
    late = entry(due="2026-03-02", due_time="23:00", data={"subject": "medicine"})
    assert to_push([late], utc("2026-03-02T23:00"), IST, s)[0] == []
    urgent = entry(due="2026-03-02", due_time="23:00", data={"subject": "medicine", "urgent": True})
    assert [a.urgent for a in to_push([urgent], utc("2026-03-02T23:00"), IST, s)[0]] == [True]


def test_unacknowledged_alert_escalates_once():
    s = ReminderSettings(quiet_enabled=False, escalate_min=15)
    e = entry(due="2026-03-02", due_time="17:00", data={"subject": "medicine", "notified": ["2026-03-02T17:00/0"]})
    assert to_push([e], utc("2026-03-02T17:10"), IST, s)[0] == []
    (again,) = to_push([e], utc("2026-03-02T17:16"), IST, s)[0]
    assert again.escalation and again.urgent and again.key == "2026-03-02T17:00/0/again"
    acked = entry(due="2026-03-02", due_time="17:00",
                  data={"subject": "medicine", "notified": ["2026-03-02T17:00/0"], "acked": ["2026-03-02T17:00/0"]})  # fmt: skip
    assert to_push([acked], utc("2026-03-02T17:16"), IST, s)[0] == []


def test_snooze_raises_a_new_alert_and_ack_hides_due_ones():
    e = entry(due="2026-03-02", due_time="17:00", data={"subject": "medicine", "acked": ["2026-03-02T17:00/0"],
                                                        "snooze_until": "2026-03-02T11:40"})  # fmt: skip
    (alert,) = due_now([e], dt.datetime(2026, 3, 2, 11, 41), IST)
    assert alert.key == "snooze/2026-03-02T11:40" and alert.label.endswith("(snoozed)")


def test_action_tokens_are_signed_and_expire():
    secret = b"s" * 32
    token = notify.sign(secret, "e1", "2026-03-02T17:00/0", now=1000)
    assert notify.verify(secret, token, now=1001) == ("e1", "2026-03-02T17:00/0")
    assert notify.verify(b"x" * 32, token, now=1001) is None  # wrong secret
    assert notify.verify(secret, token, now=1000 + notify.TOKEN_TTL_S + 1) is None  # expired
    assert notify.verify(secret, token[:-2] + "AA", now=1001) is None  # tampered


@pytest.fixture
def cron_client(settings, service_factory, monkeypatch):
    sent: list[dict] = []

    async def fake_ntfy(_client, server, topic, title, message, *, urgent=False, actions=None):
        sent.append({"topic": topic, "title": title, "urgent": urgent, "actions": actions})

    monkeypatch.setattr(notify, "send_ntfy", fake_ntfy)
    s = settings.model_copy(update={"cron_secret": SecretStr("tick-secret"), "background_jobs": False})
    with TestClient(create_app(s, service_factory=service_factory)) as c:
        c.sent = sent  # type: ignore[attr-defined]
        yield c


def test_cron_tick_pushes_due_reminders_with_one_tap_actions(cron_client):
    c = cron_client
    assert c.get("/api/cron/tick").status_code == 401
    assert c.put("/api/keeper/reminders/settings", json={"ntfy_topic": "keeper-test-123", "quiet_enabled": False,
                                                         "brief_push": False}).status_code == 200  # fmt: skip
    now = dt.datetime.now(dt.UTC) + dt.timedelta(minutes=IST * -1)  # local IST wall clock
    due_local = now - dt.timedelta(minutes=1)
    body = {"kind": "care", "title": "Take vitamins", "due": due_local.date().isoformat(),
            "due_time": due_local.strftime("%H:%M"), "data": {"subject": "medicine"}}  # fmt: skip
    e = c.post("/api/keeper/entries", json=body, headers={"X-TZ-Offset": str(IST)}).json()

    due = c.get("/api/keeper/reminders/due", headers={"X-TZ-Offset": str(IST)}).json()
    assert [d["title"] for d in due] == ["Take vitamins"]  # the open app would chime + speak this

    out = c.get("/api/cron/tick", headers={"Authorization": "Bearer tick-secret"}).json()
    assert out["keeper"]["alerts_sent"] == 1 and len(c.sent) == 1
    assert c.get("/api/cron/tick?key=tick-secret").json()["keeper"]["alerts_sent"] == 0  # once only
    done_url = c.sent[0]["actions"][0]["url"]
    assert c.post(done_url.replace("http://testserver", "")).status_code == 200
    assert c.get("/api/keeper/entries?include_done=true").status_code == 200
    page = c.get(done_url.replace("http://testserver", "").replace("t=", "t=x"))
    assert page.status_code == 410
    assert c.get("/api/keeper/reminders/due", headers={"X-TZ-Offset": str(IST)}).json() == []
    assert c.post(f"/api/keeper/entries/{e['id']}/snooze", json={"minutes": 5}).status_code == 200


def test_cron_is_disabled_without_a_secret(client):
    assert client.get("/api/cron/tick").status_code == 503
