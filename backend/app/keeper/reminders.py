"""Timed reminders: when each entry should alert, which alerts are due now, quiet hours and escalation.

Pure logic (no I/O), unit-tested directly. Entry dates/times are the user's *local* time; `offset` is the
browser's `Date#getTimezoneOffset()` (UTC minus local, minutes), so `utc = local + offset`.

Per-entry state lives in `entry.data`:
  leads        minutes before the due time to alert (default: [60, 0] for one-off reminders, else [0])
  urgent       alerts break through quiet hours and are sent at high priority
  snooze_until UTC ISO time of a snoozed alert
  notified     alert keys already pushed to the phone
  acked        alert keys the user acknowledged ("got it", snooze, done)
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.keeper.models import Entry

TIMED_KINDS = {"care", "bill", "loan", "expiry", "occasion", "appliance"}
STALE_AFTER = dt.timedelta(hours=12)  # alerts missed by more than this are dropped, not spammed late
_HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"


class ReminderSettings(BaseModel):
    """User-level delivery settings (stored in Keeper's meta table)."""

    model_config = ConfigDict(extra="ignore")

    ntfy_topic: str | None = Field(None, max_length=64, pattern=r"^[A-Za-z0-9_-]{6,64}$")
    ntfy_server: str = Field("https://ntfy.sh", max_length=200, pattern=r"^https?://")
    telegram: bool = True
    quiet_enabled: bool = True
    quiet_start: str = Field("22:00", pattern=_HHMM)
    quiet_end: str = Field("07:00", pattern=_HHMM)
    escalate_min: int = Field(15, ge=0, le=240)  # 0 = never re-send
    brief_push: bool = True
    brief_hour: int = Field(8, ge=0, le=23)


@dataclass(frozen=True)
class Alert:
    key: str
    entry: Entry
    at: dt.datetime  # UTC, naive
    label: str
    urgent: bool
    escalation: bool = False


def _to_utc(local: dt.datetime, offset: int) -> dt.datetime:
    return local + dt.timedelta(minutes=offset)


def _to_local(utc: dt.datetime, offset: int) -> dt.datetime:
    return utc - dt.timedelta(minutes=offset)


def leads(e: Entry) -> list[int]:
    raw = e.data.get("leads")
    if isinstance(raw, list) and all(isinstance(x, int) and 0 <= x <= 10080 for x in raw):
        return sorted(set(raw), reverse=True)
    return [60, 0] if e.kind == "care" and e.data.get("subject") == "other" else [0]


def _label(e: Entry, lead: int) -> str:
    if lead == 0:
        return e.title
    if lead % 1440 == 0:
        n = lead // 1440
        return f"{e.title}: due in {n} day{'s' if n > 1 else ''}" + (f" ({e.due_time})" if e.due_time else "")
    if lead >= 60 and lead % 60 == 0:
        return f"{e.title}: in {lead // 60} hour{'s' if lead > 60 else ''} ({e.due_time})"
    return f"{e.title}: in {lead} min ({e.due_time})"


def alerts_for(e: Entry, offset: int) -> list[Alert]:
    """Every alert this entry will raise for its current due date/time (plus an active snooze)."""
    if e.status != "active" or e.kind not in TIMED_KINDS or not e.due or not e.due_time:
        return []
    h, m = map(int, e.due_time.split(":"))
    due_utc = _to_utc(dt.datetime.combine(e.due, dt.time(h, m)), offset)
    urgent = bool(e.data.get("urgent"))
    out = [
        Alert(
            f"{e.due.isoformat()}T{e.due_time}/{lead}", e, due_utc - dt.timedelta(minutes=lead), _label(e, lead), urgent
        )
        for lead in leads(e)
    ]
    if snooze := e.data.get("snooze_until"):
        try:
            at = dt.datetime.fromisoformat(snooze).replace(tzinfo=None)
            out.append(Alert(f"snooze/{snooze}", e, at, f"{e.title} (snoozed)", urgent))
        except ValueError:
            pass
    return out


def in_quiet_hours(local: dt.datetime, s: ReminderSettings) -> bool:
    if not s.quiet_enabled or s.quiet_start == s.quiet_end:
        return False
    t = local.strftime("%H:%M")
    if s.quiet_start < s.quiet_end:
        return s.quiet_start <= t < s.quiet_end
    return t >= s.quiet_start or t < s.quiet_end  # window crosses midnight


def due_now(entries: list[Entry], now_utc: dt.datetime, offset: int) -> list[Alert]:
    """Alerts whose time has come, not acknowledged and not stale (what the open app should show/say)."""
    out: list[Alert] = []
    for e in entries:
        acked = set(e.data.get("acked") or [])
        for a in alerts_for(e, offset):
            if a.at <= now_utc and now_utc - a.at <= STALE_AFTER and a.key not in acked:
                out.append(a)
    return _latest_per_entry(out)


def to_push(
    entries: list[Entry], now_utc: dt.datetime, offset: int, s: ReminderSettings
) -> tuple[list[Alert], dict[str, list[str]]]:
    """Alerts to send to the phone now, plus keys to mark as handled without sending (stale or superseded).

    Rules: one alert per entry per run (the latest one); non-urgent alerts wait out quiet hours; an unacknowledged
    on-time alert is re-sent once, `escalate_min` minutes later, at high priority.
    """
    quiet = in_quiet_hours(_to_local(now_utc, offset), s)
    send: list[Alert] = []
    skip: dict[str, list[str]] = {}
    for e in entries:
        done = set(e.data.get("notified") or []) | set(e.data.get("acked") or [])
        handled = [a.at for a in alerts_for(e, offset) if a.key in done]
        newest_handled = max(handled, default=None)
        pending: list[Alert] = []
        for a in alerts_for(e, offset):
            if a.at > now_utc or a.key in done:
                continue
            # Older than an alert that already went out (e.g. the 1-hour nudge after the on-time alert): skip it.
            if now_utc - a.at > STALE_AFTER or (newest_handled is not None and a.at <= newest_handled):
                skip.setdefault(e.id, []).append(a.key)
            else:
                pending.append(a)
        if pending:
            latest = max(pending, key=lambda a: a.at)
            skip.setdefault(e.id, []).extend(a.key for a in pending if a is not latest)
            if not quiet or latest.urgent:
                send.append(latest)
            continue
        # Escalation: the on-time alert went out, nobody reacted, the entry is still pending.
        if s.escalate_min and not quiet:
            for a in alerts_for(e, offset):
                esc = f"{a.key}/again"
                if (
                    a.key.endswith("/0")
                    and a.key in (e.data.get("notified") or [])
                    and a.key not in (e.data.get("acked") or [])
                    and esc not in done
                    and a.at + dt.timedelta(minutes=s.escalate_min) <= now_utc <= a.at + STALE_AFTER
                ):
                    send.append(Alert(esc, e, a.at, f"Still pending: {e.title}", True, escalation=True))
    return send, skip


def remember(data: dict[str, Any], field: str, keys: list[str]) -> dict[str, Any]:
    """Add keys to a bounded list in entry data (newest kept)."""
    seen = [k for k in (data.get(field) or []) if k not in keys] + keys
    return {**data, field: seen[-30:]}


def _latest_per_entry(alerts: list[Alert]) -> list[Alert]:
    best: dict[str, Alert] = {}
    for a in alerts:
        if a.entry.id not in best or a.at > best[a.entry.id].at:
            best[a.entry.id] = a
    return sorted(best.values(), key=lambda a: a.at)
