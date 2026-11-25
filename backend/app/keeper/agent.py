"""Keeper's routing agent: understand → act → respond, as a small LangGraph.

* **understand** – the LLM turns a free-form message into a validated `Command` (JSON + Pydantic);
  if the LLM is unavailable or returns junk, the rule-based parser takes over, so Keeper never stops working.
* **act** – applies the command to the store with per-chore rules (upsert, roll recurring dates…).
* **respond** – a short, deterministic confirmation (no second LLM call → fast and predictable).

Every node is timed and returned as a trace, which the UI shows as the "how I routed this" strip.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from app.keeper import schedule
from app.keeper.models import KINDS, Command, Entry
from app.keeper.parser import rule_parse
from app.keeper.store import KeeperStore
from appcore.llm import for_task
from appcore.llm.chat import ChatLLM
from appcore.llm.structured import complete_json

logger = logging.getLogger(__name__)

ROUTER_SYSTEM = """You are the intent router of "Tijori", a personal assistant that remembers everyday things.
Convert the user's message into ONE JSON object (no prose) with these keys (omit or null when unknown):

action: "add" | "find" | "done" | "list" | "brief" | "help" | "chat"
        ("chat": anything that is not about saving or finding the user's things: questions, advice,
         general knowledge, planning help, the time or date, small talk, thanks)
kind:   "stash"     – where an object is kept ("passport, top drawer")
        "parking"   – where the vehicle is parked
        "loan"      – something lent to / borrowed from a person (direction: "lent" | "borrowed")
        "expiry"    – a document / warranty / policy / card with an expiry or renewal date
        "bill"      – a bill, rent, EMI or subscription (amount, currency, recurring, subscription: true/false)
        "occasion"  – birthday / anniversary (person, date) or a gift idea (gift_idea)
        "appliance" – appliance or vehicle servicing (every_months)
        "pantry"    – groceries: items to buy (add) or bought (done); items: [..]
        "care"      – medicines, plants, pets and one-off reminders (subject: medicine|plant|pet|other,
                      times: ["HH:MM"], every_days)
title, place, person, date (YYYY-MM-DD, resolve relative dates from today), time (HH:MM), amount, currency,
recurring ("none"|"weekly"|"monthly"|"yearly"), subscription, every_days, every_months, times, subject,
category, items, gift_idea, query (for find), note.

Conventions:
- Questions like "where is X / where did I put X" → action "find", query "X".
- "where did I park" → find + kind parking.  "what's due / my day" → brief.  "shopping list" → list + pantry.
- "X returned the Y" / "got Y back" → done + loan.  "bought milk" → done + pantry.  "AC was serviced" → done + appliance.
- "remind me to X at/on T" → add + care (subject "other", title X, date/time) — a one-off reminder.
- Questions that aren't about the user's saved things ("how long to boil an egg", "what's 15% of 840") → chat.
- Use the earlier conversation (if given) to resolve "it", "that", "same time", "tomorrow too".
- Titles are short nouns ("Passport", "Drill", "Car insurance"), never full sentences.
Today is {today} ({weekday}); the user's local time is {time}."""


ASSISTANT_SYSTEM = """You are Tijori, a {tone} personal assistant. Your reply will be read aloud, so:
answer in {length} of plain speech (no markdown, lists, emojis or URLs), lead with the answer, and be
specific.{name} Use the user's saved items and today's agenda below when relevant; never invent their data, bookings,
messages or events, and never claim to have done something (calls, emails, purchases, web searches) you cannot do.
If you need live information you don't have (weather, news, prices), say so briefly and suggest what you can do.
Now: {now} ({weekday}).
TODAY'S AGENDA: {agenda}"""


TONES = {"warm": "warm, capable", "professional": "concise, professional", "cheerful": "upbeat, cheerful"}
LENGTHS = {"short": "1-3 short sentences", "detailed": "up to 6 clear sentences"}


class KeeperState(TypedDict, total=False):
    text: str
    photo_id: str | None
    history: list[dict[str, str]]
    prefs: dict[str, str]
    lat: float | None
    lng: float | None
    now: dt.datetime
    command: Command
    routed_by: str
    entries: list[Entry]
    reply: str
    trace: list[dict[str, Any]]


def _trace(state: KeeperState, node: str, start: float, detail: str) -> list[dict[str, Any]]:
    return [
        *state.get("trace", []),
        {"node": node, "ms": round((time.perf_counter() - start) * 1000), "detail": detail},
    ]


class KeeperAgent:
    def __init__(
        self,
        store: KeeperStore,
        get_llm: Callable[[], ChatLLM],
        caption: Callable[[str], Awaitable[str | None]] | None = None,
        llm_timeout_s: float = 25.0,
    ) -> None:
        self.store = store
        self._get_llm = get_llm
        self._caption = caption
        self._timeout = llm_timeout_s
        g = StateGraph(KeeperState)
        g.add_node("understand", self._understand)
        g.add_node("act", self._act)
        g.add_node("respond", self._respond)
        g.add_edge(START, "understand")
        g.add_edge("understand", "act")
        g.add_edge("act", "respond")
        g.add_edge("respond", END)
        self.graph = g.compile()

    async def run(self, text: str, now: dt.datetime, photo_id: str | None = None,
                  lat: float | None = None, lng: float | None = None,
                  history: list[dict[str, str]] | None = None,
                  prefs: dict[str, str] | None = None) -> KeeperState:  # fmt: skip
        return await self.graph.ainvoke(
            {"text": text, "now": now, "photo_id": photo_id, "lat": lat, "lng": lng, "trace": [],
             "history": history or [], "prefs": prefs or {}}
        )  # fmt: skip

    # ── understand ─────────────────────────────────────────────────────────
    async def _understand(self, state: KeeperState) -> KeeperState:
        start = time.perf_counter()
        now = state["now"]
        rules = rule_parse(state["text"], now.date())
        command, routed_by = rules, "rules"
        try:
            system = ROUTER_SYSTEM.format(
                today=now.date().isoformat(), weekday=now.strftime("%A"), time=now.strftime("%H:%M")
            )
            llm_cmd = await asyncio.wait_for(
                complete_json(for_task(self._get_llm(), "keeper.command"), system, _with_history(state), Command),
                self._timeout,
            )
            if _plausible(llm_cmd):
                command, routed_by = llm_cmd, "llm"
        except Exception as exc:  # noqa: BLE001 - any LLM failure → rules
            logger.info("Keeper router fell back to rules: %s", type(exc).__name__)
        detail = f"{command.action}{' · ' + command.kind if command.kind else ''} (via {'LLM' if routed_by == 'llm' else 'offline rules'})"
        return {"command": command, "routed_by": routed_by, "trace": _trace(state, "understand", start, detail)}

    # ── act ────────────────────────────────────────────────────────────────
    async def _act(self, state: KeeperState) -> KeeperState:
        start = time.perf_counter()
        cmd, now = state["command"], state["now"]
        entries: list[Entry] = []
        if cmd.action == "add" and cmd.kind:
            entries = await self._add(cmd, state, now)
        elif cmd.action == "find":
            entries = self._find(cmd)
        elif cmd.action == "done":
            entries = self._done(cmd, now)
        elif cmd.action == "list" and cmd.kind:
            entries = self.store.list(cmd.kind)
            if cmd.kind == "pantry":
                # alphabetical: a stable order (timestamps have 1-second resolution, so ties are arbitrary)
                entries = sorted((e for e in entries if e.data.get("state") == "need"), key=lambda e: e.title.lower())
        detail = f"{len(entries)} entr{'y' if len(entries) == 1 else 'ies'} {'matched' if cmd.action in ('find', 'list') else 'updated'}"
        return {"entries": entries, "trace": _trace(state, "act", start, detail)}

    async def _add(self, c: Command, state: KeeperState, now: dt.datetime) -> list[Entry]:  # noqa: C901
        today = now.date()
        title = c.title or (c.items[0] if c.items else None) or (c.person and f"{c.person}") or "Untitled"
        photo_id = state.get("photo_id")
        caption = await self._caption(photo_id) if photo_id and self._caption else None
        base: dict[str, Any] = {"kind": c.kind, "title": title, "photo_id": photo_id, "note": c.note, "data": {}}
        if _URGENT.search(state.get("text") or ""):
            base["data"]["urgent"] = True  # alerts break through quiet hours, sent at high priority
        if caption:
            base["data"]["caption"] = caption

        match c.kind:
            case "stash":
                if existing := self.store.find_one(title, "stash"):  # moved → update the place, keep history
                    moves = [*existing.data.get("moves", []), {"place": existing.place, "at": existing.updated_at}][-5:]
                    data = {**existing.data, "moves": moves, **({"caption": caption} if caption else {})}
                    return [
                        self.store.update(
                            existing.id, {"place": c.place, "photo_id": photo_id or existing.photo_id, "data": data}
                        )
                    ]  # type: ignore[list-item]
                return [self.store.add({**base, "place": c.place})]
            case "parking":
                for old in self.store.list("parking"):  # only one active parking spot per vehicle
                    if old.title.lower() == title.lower():
                        self.store.update(old.id, {"status": "done"})
                return [self.store.add({**base, "place": c.place, "lat": state.get("lat"), "lng": state.get("lng")})]
            case "loan":
                due = c.date or today + dt.timedelta(days=schedule.DEFAULT_LOAN_DAYS)
                return [
                    self.store.add(
                        {
                            **base,
                            "person": c.person,
                            "due": due,
                            "data": {**base["data"], "direction": c.direction or "lent"},
                        }
                    )
                ]
            case "expiry":
                return [
                    self.store.add({**base, "due": c.date, "data": {**base["data"], "category": c.category or "other"}})
                ]
            case "bill":
                currency = _CURRENCY.get((c.currency or "").upper(), c.currency)
                data = {**base["data"], "amount": c.amount, "currency": currency, "recurring": c.recurring or "none",
                        "subscription": bool(c.subscription)}  # fmt: skip
                if data["subscription"]:
                    data["last_used"] = today.isoformat()
                return [self.store.add({**base, "due": c.date, "data": data})]
            case "occasion":
                return [self._occasion(c, base, today)]
            case "appliance":
                months = c.every_months or schedule.DEFAULT_SERVICE_MONTHS
                due = c.date or schedule.add_months(today, months)
                data = {**base["data"], "every_months": months, "manual_url": _manual_url(title)}
                if existing := self.store.find_one(title, "appliance"):
                    return [self.store.update(existing.id, {"due": due, "data": {**existing.data, **data}})]  # type: ignore[list-item]
                return [self.store.add({**base, "due": due, "data": data})]
            case "pantry":
                return [self._pantry(name, "need", base) for name in (c.items or [title])]
            case "care":
                data = {**base["data"], "subject": c.subject or "other"}
                if c.subject != "other" and (c.times or c.every_days):
                    data |= {"times": c.times, "every_days": c.every_days}
                    due, due_time = (
                        (c.date, c.times[0] if c.times else None) if c.date else schedule.next_care(data, now)
                    )
                    if not c.date and c.every_days and not c.times:
                        due = today  # first dose / watering is today
                else:
                    due, due_time = c.date or today, c.time or (c.times[0] if c.times else None)
                return [self.store.add({**base, "due": due, "due_time": due_time, "data": data})]
        return []

    def _occasion(self, c: Command, base: dict[str, Any], today: dt.date) -> Entry:
        person = c.person or c.title or "Someone"
        existing = next((e for e in self.store.list("occasion") if (e.person or "").lower() == person.lower()), None)
        if c.gift_idea and existing:
            ideas = [*existing.data.get("gift_ideas", []), c.gift_idea][-20:]
            return self.store.update(existing.id, {"data": {**existing.data, "gift_ideas": ideas}})  # type: ignore[return-value]
        data: dict[str, Any] = {
            **base["data"],
            "category": c.category or "birthday",
            "gift_ideas": [c.gift_idea] if c.gift_idea else [],
        }
        due = None
        if c.date:
            data |= {"month": c.date.month, "day": c.date.day}
            due = schedule.next_yearly(c.date.month, c.date.day, today)
        title = c.title or f"{person}'s {data['category']}"
        if existing and c.date:
            return self.store.update(existing.id, {"due": due, "title": title, "data": {**existing.data, **data,
                                     "gift_ideas": existing.data.get("gift_ideas", [])}})  # type: ignore[return-value]  # fmt: skip
        return self.store.add({**base, "title": title, "person": person, "due": due, "data": data})

    def _pantry(self, name: str, state: str, base: dict[str, Any]) -> Entry:
        existing = self.store.find_one(name, "pantry")
        if existing and existing.title.lower() == name.lower():
            return self.store.update(existing.id, {"data": {**existing.data, "state": state}})  # type: ignore[return-value]
        return self.store.add({**base, "kind": "pantry", "title": name, "photo_id": None, "data": {"state": state}})

    def _find(self, c: Command) -> list[Entry]:
        if c.kind == "parking":
            spots = self.store.list("parking")
            return sorted(spots, key=lambda e: e.created_at, reverse=True)[:1]
        query = c.query or c.title or ""
        kind = c.kind if c.kind in KINDS and c.kind != "parking" else None
        return self.store.search(query, kind) if query else []

    def _done(self, c: Command, now: dt.datetime) -> list[Entry]:
        names = c.items if c.kind == "pantry" and c.items else [c.title or c.query or ""]
        out: list[Entry] = []
        for name in filter(None, names):
            target = self.store.find_one(name, c.kind)
            if target is None and c.kind == "pantry":  # bought something that wasn't on the list
                target = self._pantry(name, "have", {"kind": "pantry", "data": {}})
                out.append(target)
                continue
            if target:
                out.append(self.store.update(target.id, schedule.on_done(target, now)))  # type: ignore[arg-type]
        return out

    # ── respond ────────────────────────────────────────────────────────────
    async def _respond(self, state: KeeperState) -> KeeperState:
        start = time.perf_counter()
        if state["command"].action == "chat":
            reply = await self._chat(state)
            return {"reply": reply, "trace": _trace(state, "respond", start, "answered as an assistant")}
        reply = compose_reply(state["command"], state.get("entries", []))
        return {"reply": reply, "trace": _trace(state, "respond", start, "confirmation composed")}

    async def _chat(self, state: KeeperState) -> str:
        """A spoken-style answer for anything that isn't a save/find chore, grounded in today's agenda."""
        now = state["now"]
        items = schedule.agenda(self.store.list(), now)[:8]
        agenda = "; ".join(i.label for i in items) or "nothing due"
        prefs = state.get("prefs") or {}
        name = (prefs.get("name") or "").strip()
        system = ASSISTANT_SYSTEM.format(
            now=now.strftime("%Y-%m-%d %H:%M"), weekday=now.strftime("%A"), agenda=agenda,
            tone=TONES.get(prefs.get("tone", ""), TONES["warm"]),
            length=LENGTHS.get(prefs.get("length", ""), LENGTHS["short"]),
            name=f" The user's name is {name}; use it now and then, not in every reply." if name else "",
        )  # fmt: skip
        try:
            text = await asyncio.wait_for(
                for_task(self._get_llm(), "keeper.chat").complete(
                    system, [{"role": "user", "content": _with_history(state)}]
                ),
                self._timeout,
            )
            text = re.sub(r"[*_#`]+", "", str(text)).strip()
            if text:
                return text[:700]
        except Exception as exc:  # noqa: BLE001 - offline: still answer something useful
            logger.info("Tijori chat fell back: %s", type(exc).__name__)
        if re.search(r"\btime\b", state["text"], re.I):
            return f"It's {now.strftime('%H:%M')} on {now.strftime('%A, %d %B')}."
        return "I can't answer that right now, but I can remember things, remind you, and tell you what's due."


def _with_history(state: KeeperState) -> str:
    """The message, with the last few turns so follow-ups ("remind me about that tomorrow") make sense."""
    turns = [t for t in state.get("history") or [] if t.get("text")][-6:]
    if not turns:
        return state["text"]
    lines = [f"{'User' if t.get('role') == 'user' else 'Tijori'}: {str(t['text'])[:300]}" for t in turns]
    return "Earlier in this conversation:\n" + "\n".join(lines) + f"\n\nNow the user says: {state['text']}"


_CURRENCY = {"INR": "₹", "RS": "₹", "RS.": "₹", "USD": "$", "EUR": "€", "GBP": "£"}


_URGENT = re.compile(r"(urgent(ly)?|important|asap|don'?t forget|must not forget|critical)", re.I)


def _plausible(c: Command) -> bool:
    """Reject LLM output that cannot be acted on (e.g. add without a kind)."""
    if c.action in ("add", "list") and not c.kind:
        return False
    if c.action == "add" and c.kind == "pantry" and not (c.items or c.title):
        return False
    return not (c.action == "find" and not (c.query or c.title or c.kind == "parking"))


def _manual_url(title: str) -> str:
    from urllib.parse import quote_plus

    return f"https://duckduckgo.com/?q={quote_plus(title + ' user manual pdf')}"


def _fmt_date(d: dt.date | None) -> str:
    return d.strftime("%a %d %b %Y") if d else "no date yet"


HELP = (
    'Tell me things like: "passport, top drawer" · "lent my drill to Raj" · "we\'re out of milk" · '
    '"car insurance expires 12/03/2027" · "Netflix ₹649 monthly on the 2nd" · "Mom\'s birthday 14 March" · '
    '"take vitamin D at 9am daily" · "AC filter every 3 months" · "I parked at B2, pillar 14". '
    'Then ask "where is my passport?" or "what\'s due?"'
)


def compose_reply(c: Command, entries: list[Entry]) -> str:  # noqa: C901 - one line per chore
    if c.action == "help":
        return HELP
    if c.action == "brief":
        return "Here's your brief."
    if c.action == "find":
        if not entries:
            what = c.query or c.title or "that"
            return f"I don't have anything saved for \"{what}\" yet. Tell me where it is and I'll remember."
        e = entries[0]
        if e.kind == "parking":
            return f"Your {e.title.lower()} is at {e.place or 'the pinned location'}" + (
                " (map pin saved)." if e.lat else "."
            )
        if e.kind == "stash":
            return f"{e.title} {_where(e.place)}."
        return f"Found {len(entries)} match{'es' if len(entries) != 1 else ''}. Best: {e.title}."
    if c.action == "list":
        if c.kind == "pantry":
            return (
                f"Shopping list: {', '.join(e.title for e in entries)}." if entries else "Your shopping list is empty."
            )
        return f"{len(entries)} active {c.kind} entr{'y' if len(entries) == 1 else 'ies'}."
    if not entries:
        return (
            "I couldn't find a matching entry to update."
            if c.action == "done"
            else "I couldn't save that, try rephrasing."
        )
    e = entries[0]
    if c.action == "done":
        match e.kind:
            case "loan":
                return f"Marked {e.title} as returned."
            case "pantry":
                return f"Ticked off: {', '.join(x.title for x in entries)}."
            case "bill":
                return f"{e.title} paid." + (f" Next due {_fmt_date(e.due)}." if e.status == "active" else "")
            case "appliance":
                return f"{e.title} serviced. Next service {_fmt_date(e.due)}."
            case "care":
                return (
                    f"Done. Next: {_fmt_date(e.due)}{' at ' + e.due_time if e.due_time else ''}."
                    if e.status == "active"
                    else "Done."
                )
            case _:
                return f"Marked {e.title} as done."
    match e.kind:
        case "stash":
            moved = " (updated from where it was before)" if e.data.get("moves") else ""
            return f"Got it: {e.title} {_where(e.place)}{moved}."
        case "parking":
            return f"Parking saved: {e.place or 'map pin only'}" + (" with a map pin." if e.lat else ".")
        case "loan":
            if e.data.get("direction") == "borrowed":
                return f"Noted: you borrowed {e.title} from {e.person}. I'll remind you to return it by {_fmt_date(e.due)}."
            return f"Noted: {e.person} has your {e.title.lower()}. I'll nudge you on {_fmt_date(e.due)}."
        case "expiry":
            return f"{e.title} tracked: expires {_fmt_date(e.due)}. Reminders 30 and 7 days before." if e.due else (
                f"{e.title} saved, but I couldn't read the expiry date. Add it so I can remind you.")  # fmt: skip
        case "bill":
            amount = e.data.get("amount")
            money = f" {e.data.get('currency') or ''}{amount:g}" if isinstance(amount, int | float) else ""
            rec = e.data.get("recurring")
            return f"{e.title}{money} saved{', ' + rec if rec and rec != 'none' else ''}; due {_fmt_date(e.due)}."
        case "occasion":
            gift = f" Gift idea saved: {c.gift_idea}." if c.gift_idea else ""
            if c.gift_idea and not c.date:
                return f"Gift idea saved for {e.person}: {c.gift_idea}."
            if e.due:
                return f"{e.title}: {_fmt_date(e.due)}. I'll remind you a week before.{gift}"
            return f"{e.title}: {_fmt_date(e.due)}. I'll remind you a week before." if e.due else f"{e.title} saved."
        case "appliance":
            return f"{e.title}: service every {e.data.get('every_months')} months, next on {_fmt_date(e.due)}."
        case "pantry":
            return f"Added to the shopping list: {', '.join(x.title for x in entries)}."
        case "care":
            sub = e.data.get("subject")
            if sub == "other":
                return f"Reminder set: {e.title}, {_fmt_date(e.due)}{' at ' + e.due_time if e.due_time else ''}."
            sched = ", ".join(e.data.get("times") or []) or (
                f"every {e.data.get('every_days')} day(s)" if e.data.get("every_days") else ""
            )
            return (
                f"{e.title} scheduled ({sched}). Next: {_fmt_date(e.due)}{' at ' + e.due_time if e.due_time else ''}."
            )
    return "Saved."


def _where(place: str | None) -> str:
    """'in the top drawer' → 'is in the top drawer'; 'top drawer' → 'is in: top drawer'."""
    if not place:
        return "is saved (no place given)"
    first = place.split(" ", 1)[0].lower()
    preps = ("in", "on", "under", "inside", "behind", "at", "beside", "near", "next", "above", "below", "with")
    return f"is {place}" if first in preps else f"→ {place}"
