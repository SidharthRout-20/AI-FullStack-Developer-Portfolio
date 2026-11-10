"""Pure date logic: next due dates, "done" transitions and the agenda.

No I/O here, so every rule is unit-tested directly. All dates are the user's *local* dates;
the API converts using the client's timezone offset.
"""

from __future__ import annotations

import calendar
import datetime as dt
from typing import Any

from app.keeper.models import AgendaItem, Entry

EXPIRY_WINDOW_DAYS = 30  # expiries surface a month ahead
SOON_DAYS = 7  # everything else a week ahead
UNUSED_SUBSCRIPTION_DAYS = 30
DEFAULT_LOAN_DAYS = 14
DEFAULT_SERVICE_MONTHS = 6


def local_now(tz_offset_min: int) -> dt.datetime:
    """`tz_offset_min` follows JS `Date#getTimezoneOffset()`: UTC minus local, in minutes."""
    return dt.datetime.now(dt.UTC).replace(tzinfo=None) - dt.timedelta(minutes=tz_offset_min)


def add_months(d: dt.date, months: int) -> dt.date:
    m = d.month - 1 + months
    year, month = d.year + m // 12, m % 12 + 1
    return dt.date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


def next_yearly(month: int, day: int, today: dt.date) -> dt.date:
    """Next occurrence of an annual date (29 Feb falls back to 28 Feb in common years)."""
    for year in (today.year, today.year + 1):
        candidate = dt.date(year, month, min(day, calendar.monthrange(year, month)[1]))
        if candidate >= today:
            return candidate
    raise AssertionError("unreachable")


def advance(due: dt.date, recurring: str) -> dt.date | None:
    if recurring == "weekly":
        return due + dt.timedelta(days=7)
    if recurring == "monthly":
        return add_months(due, 1)
    if recurring == "yearly":
        return add_months(due, 12)
    return None


def next_care(data: dict[str, Any], now: dt.datetime) -> tuple[dt.date, str | None]:
    """Next dose / watering / walk: either fixed daily times or every N days."""
    times = sorted(data.get("times") or [])
    if times:
        current = now.strftime("%H:%M")
        upcoming = [t for t in times if t > current]
        if upcoming:
            return now.date(), upcoming[0]
        return now.date() + dt.timedelta(days=1), times[0]
    return now.date() + dt.timedelta(days=int(data.get("every_days") or 1)), None


def on_done(entry: Entry, now: dt.datetime) -> dict[str, Any]:
    """Field changes when the user marks an entry done. Recurring kinds roll forward instead of closing."""
    today = now.date()
    data = dict(entry.data)
    if entry.kind == "bill" and entry.due and (nxt := advance(entry.due, data.get("recurring") or "none")):
        data["last_paid"] = today.isoformat()
        while nxt < today:  # catch up if several periods were missed
            nxt = advance(nxt, data["recurring"]) or nxt
        return {"due": nxt, "data": data}
    if entry.kind == "occasion" and "month" in data:
        data.setdefault("celebrated", []).append(today.year)
        return {
            "due": next_yearly(data["month"], data["day"], max(today, entry.due or today) + dt.timedelta(days=1)),
            "data": data,
        }
    if entry.kind == "appliance":
        data["last_service"] = today.isoformat()
        months = int(data.get("every_months") or DEFAULT_SERVICE_MONTHS)
        return {"due": add_months(today, months), "data": data}
    if entry.kind == "care" and (data.get("times") or data.get("every_days")):
        data["last_done"] = now.isoformat(timespec="minutes")
        due, due_time = next_care(data, now)
        return {"due": due, "due_time": due_time, "data": data}
    if entry.kind == "pantry":
        data["state"] = "have"
        return {"data": data}
    return {"status": "done"}


def _days(n: int) -> str:
    return "today" if n == 0 else "tomorrow" if n == 1 else f"in {n} days"


def _late(n: int) -> str:
    return "yesterday" if n == 1 else f"{n} days ago"


def _label(e: Entry, delta: int) -> str:
    when = _days(delta) if delta >= 0 else _late(-delta)
    match e.kind:
        case "expiry":
            return f"{e.title} {'expires' if delta >= 0 else 'expired'} {when}"
        case "loan":
            who = e.person or "someone"
            verb = (
                f"Return {e.title} to {who}"
                if e.data.get("direction") == "borrowed"
                else f"Get {e.title} back from {who}"
            )
            return f"{verb} {when}" if delta >= 0 else f"{verb} (was due {when})"
        case "bill":
            amount = e.data.get("amount")
            money = f" ({e.data.get('currency') or ''}{amount:g})" if isinstance(amount, int | float) else ""
            return f"{e.title}{money} due {when}"
        case "occasion":
            return f"{e.title} {when}"
        case "appliance":
            return f"{e.title} service due {when}"
        case "care":
            at = f" at {e.due_time}" if e.due_time and delta == 0 else ""
            return f"{e.title}{at} {when}" if delta else f"{e.title}{at}"
        case _:
            return f"{e.title} {when}"


def agenda(entries: list[Entry], now: dt.datetime) -> list[AgendaItem]:
    today = now.date()
    items: list[AgendaItem] = []
    for e in entries:
        if e.status != "active":
            continue
        if e.due is not None and e.kind not in ("stash", "parking", "pantry"):
            delta = (e.due - today).days
            window = EXPIRY_WINDOW_DAYS if e.kind == "expiry" else SOON_DAYS
            bucket = "overdue" if delta < 0 else "today" if delta == 0 else "soon" if delta <= window else None
            if bucket:
                items.append(AgendaItem(bucket=bucket, label=_label(e, delta), entry=e))
        if e.kind == "bill" and e.data.get("subscription"):
            last = e.data.get("last_used") or e.created_at[:10]
            idle = (today - dt.date.fromisoformat(last)).days
            if idle >= UNUSED_SUBSCRIPTION_DAYS:
                items.append(
                    AgendaItem(bucket="nudge", label=f"{e.title}: not used for {idle} days. Cancel it?", entry=e)
                )
    order = {"overdue": 0, "today": 1, "soon": 2, "nudge": 3}
    items.sort(key=lambda i: (order[i.bucket], i.entry.due or dt.date.max, i.entry.due_time or ""))
    return items


def template_brief(items: list[AgendaItem], shopping: list[str], parking: Entry | None) -> str:
    """Deterministic daily brief, used when no LLM is available."""
    parts: list[str] = []
    overdue = [i.label for i in items if i.bucket == "overdue"]
    today = [i.label for i in items if i.bucket == "today"]
    soon = [i.label for i in items if i.bucket == "soon"][:4]
    nudges = [i.label for i in items if i.bucket == "nudge"][:2]
    if overdue:
        parts.append("Overdue: " + "; ".join(overdue) + ".")
    parts.append(("Today: " + "; ".join(today) + ".") if today else "Nothing is due today.")
    if soon:
        parts.append("Coming up: " + "; ".join(soon) + ".")
    if shopping:
        parts.append(f"Shopping list ({len(shopping)}): " + ", ".join(shopping[:8]) + ".")
    if parking:
        parts.append(f"Your {parking.title.lower()} is parked at {parking.place or 'the saved pin'}.")
    parts += nudges
    return " ".join(parts)
