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

from app.config import PROJECT_ROOT
from app.control import active
from app.keeper import personas, schedule
from app.keeper.models import KINDS, Command, Entry
from app.keeper.parser import rule_parse
from app.keeper.repo import RepoIndex
from app.keeper.store import KeeperStore
from app.keeper.tools import (
    ACTIONS,
    TOOLS,
    ToolBox,
    ToolError,
    accepted_offer,
    products_menu,
    rule_product,
    rule_settings,
    rule_tool,
)
from appcore.llm import for_task
from appcore.llm.chat import ChatLLM
from appcore.llm.structured import complete_json

logger = logging.getLogger(__name__)

ROUTER_SYSTEM = """You are the intent router of "Tara", a personal assistant that remembers everyday things.
Convert the user's message into ONE JSON object (no prose) with these keys (omit or null when unknown):

action: "add" | "find" | "done" | "list" | "brief" | "help" | "assist" | "chat"
        ("assist": look something up or do something on the device, with "tool" and "args" below;
         "chat": advice, explanations, maths, writing help, planning, small talk, thanks)
emotion: how the user seems to feel from their words: "neutral" | "happy" | "excited" | "grateful" | "stressed" |
        "anxious" | "sad" | "angry" | "frustrated" | "tired" | "confused" | "lonely" | "crisis"
        ("crisis" only for talk of self-harm, suicide or being in danger). Default "neutral".
persona: for "chat" and "assist", who should answer: the expert a person would ask for this, one of
{personas}
        Pick the specialist whenever the question is in their field ("say X in Spanish" → language, "plan 3 days in
        Goa" → travel, "a 20 minute workout" → fitness, "Postgres or MongoDB?" → architect); "assistant" only for
        everyday tasks no expert would own (timers, small talk, quick facts).
tool (only for assist) and args:
        "weather"    {"place": city or null for the user's own location}
        "news"       {"topic": topic or null for top headlines}
        "wiki"       {"query": person, place, thing or event to look up}
        "web"        {"query": a factual question that needs a current or specific answer}
        "currency"   {"amount": number, "from": "USD", "to": "INR"} (ISO codes)
        "time"       {"place": city} (the time somewhere else)
        "code"       {"query": what to find in this portfolio's own source code (how a feature works, where it is built)}
        "portfolio"  {"query": a question about Sidharth, who built this site: his work, skills, experience or its products}
        "settings"   {"setting": "voice"|"speed"|"pitch"|"tone"|"length"|"name"|"language"|"wake"|"speak"|"sounds"|
                      "keep"|"city"|"open", "value": e.g. "female", "faster", "lower", "professional", "short", "Sid",
                      "Hindi", "off", "Pune"} (the user's own preferences for how Tara talks and behaves)
        "product"    {"product": one of this site's products below, "place": the destination for a trip, if named}
        "edit"       {"request": the change the user wants made to THIS site's own code, in their words, complete}
        "open"       {"target": app or website name or domain, or a product on this site: Safarnaama, CodeLens, Tara,
                      Jasoos, Quality}
        "search"     {"query": what to search the web for}
        "play"       {"query": song, artist, playlist or video, "service": "youtube" | "spotify"}
        "directions" {"destination": place, "mode": "driving" | "walking" | "transit" | "bike"}
        "call"       {"contact": name, "number": digits if said}
        "message"    {"contact": name, "number": digits if said, "text": message, "app": "sms" | "whatsapp"}
        "email"      {"to": address if said, "subject": str, "body": str}
        "timer"      {"seconds": n, "minutes": n, "hours": n, "label": str}
        "calendar"   {"title": str, "date": "YYYY-MM-DD", "time": "HH:MM", "minutes": duration}
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

This site's products (PRODUCT FIRST: when a request is what one of these does, hand it over with assist + product,
never answer it yourself in chat):
{products}

Conventions:
- Itineraries, trip plans, places to visit or things to do somewhere, day trips, getaways → assist + product
  "safarnaama" with the place (never write an itinerary yourself: Safarnaama plans with real places and weather).
- A GitHub repo or codebase to understand → product "codelens". A failing build, CI run, tests or a stack trace →
  product "jasoos". How well the site's AI works, its evals or scores → product "quality".
- A short "yes / sure / ok / I want one" right after Tara offered something → do exactly what was offered.
- Questions like "where is X / where did I put X" → action "find", query "X". Statements of where something is
  ("passport is in the top drawer", "I parked on level 2, B14") → add (stash / parking). "find" is only for the
  user's OWN saved things: "who/what is <a public person, place or thing>" → assist + wiki.
- "where did I park" → find + kind parking.  "what's due / my day" → brief.  "shopping list" → list + pantry.
- "I lent X to Y" / "borrowed X from Y" → add + loan. "X returned the Y" / "got Y back" → done + loan.  "bought milk" → done + pantry.  "AC was serviced" → done + appliance.
- "remind me to X at/on T" → add + care (subject "other", title X, date/time) — a one-off reminder.
- Weather, news, "who/what is X", rates, live facts → assist with weather/news/wiki/web/currency/time.
- "open / launch / go to X" → open. "play X" → play. "navigate / directions / take me to X" → directions.
- "call X" → call. "text / message / WhatsApp X" → message. "email X" → email. "set a timer / countdown" → timer.
- Any message that says "calendar" ("add a dentist appointment on Friday to my calendar") → assist + calendar,
  even when it starts with "add"; but "remind me to X" stays add + care (Tara reminds them).
- Advice, explanations and maths ("how long to boil an egg", "what's 15% of 840") → chat.
- How this site, Tara, CodeLens, Safarnaama, Jasoos or the Quality page works in code, or where something is built
  ("how does the wake word work?", "where is the weather tool?") → assist + code. (Where the USER's things are stays find.)
- About Sidharth, his experience, skills, projects, or what this site's products do → assist + portfolio.
- Changing how Tara talks or behaves for the user ("change your voice", "speak slower", "call me Sid", "be more
  professional", "shorter answers", "talk in Hindi", "turn off Hey Tara", "stop reading answers aloud") → assist +
  settings. These are personal settings, never code changes.
- Asking to change, fix, add or remove something in this site's or Tara's code or UI ("make the CodeLens button
  bigger", "fix the typo on the home page", "add a dark mode toggle to Jasoos") → assist + edit.
- Use the earlier conversation (if given) to resolve "it", "that", "same time", "tomorrow too".
- Titles are short nouns ("Passport", "Drill", "Car insurance"), never full sentences.
Today is {today} ({weekday}); the user's local time is {time}."""


ASSISTANT_SYSTEM = """You are Tara, a {tone} personal assistant. For this question you answer as {persona}.
Your reply may be read aloud, so answer in {length} of plain speech (no markdown, lists, emojis or URLs), lead
with the answer, and be specific. {name} Use the user's saved items and today's agenda below when relevant; never invent their data, bookings,
messages or events, and never make up itineraries, schedules, prices or opening hours. If a LOOK-UP RESULT is given, answer from it only and name its source in a few words (e.g. "says Open-Meteo"; never "the lookup result"); when it is source
code, explain what it does in plain words and name the files and functions that matter instead of reading code out.
Tara can look up weather, news, facts, exchange rates and the time anywhere, and open apps, play music, give
directions, prepare calls, messages and emails, set timers and add calendar events: never say you have no internet or
no access; if something isn't covered, offer the closest of these instead.
{mood}
Now: {now} ({weekday}).
TODAY'S AGENDA: {agenda}"""


# How to respond to a feeling, in a sentence the assistant follows. Never named back as a diagnosis.
MOODS = {
    "stressed": "The user sounds stressed: be calm and brief, acknowledge it in a few words, then make things easier.",
    "anxious": "The user sounds anxious: be steady and reassuring, acknowledge it gently, give one clear next step.",
    "sad": "The user sounds low: be warm and gentle, acknowledge how they feel before anything else.",
    "lonely": "The user sounds lonely: be warm and present, show you're glad they talked to you.",
    "angry": "The user sounds angry: stay calm, don't argue, acknowledge the frustration and fix what you can.",
    "frustrated": "The user sounds frustrated: acknowledge it briefly and get straight to a solution.",
    "tired": "The user sounds tired: keep it short and take work off their plate.",
    "confused": "The user sounds confused: explain simply, one step at a time.",
    "happy": "The user sounds happy: match their energy a little.",
    "excited": "The user sounds excited: share the excitement briefly.",
    "grateful": "The user is thanking you: accept it warmly and briefly.",
}
# Said first when the user sounds low and Tara only saved or found something (no model call needed).
ACKS = {
    "stressed": "I've got this one for you.", "anxious": "Don't worry, it's taken care of.",
    "sad": "I'm here for you.", "angry": "Sorry about the trouble.", "frustrated": "Let's sort this out.",
    "tired": "Leave this one to me.", "lonely": "I'm right here.",
}  # fmt: skip
CRISIS = (
    "I'm really sorry you're feeling this way, and I'm glad you told me. You don't have to go through this alone. "
    "Please talk to someone right now: in India you can call Tele-MANAS on 14416, free and any time, or call 112 "
    "if you're in danger. If you can, reach out to someone you trust too. I'm here with you."
)

TONES = {"warm": "warm, capable", "professional": "concise, professional", "cheerful": "upbeat, cheerful"}
LENGTHS = {"short": "1-3 short sentences", "detailed": "up to 6 clear sentences"}
DEEP = "up to 8 clear sentences (say steps as first, then, finally)"  # experts get room to be useful


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
    card: dict[str, Any] | None  # what to show for a look-up (weather, news, a fact…)
    client_action: dict[str, Any] | None  # what the device should do (open, call, timer…)
    tool_facts: str
    tool_error: str
    persona_choice: str | None  # picked by the user for this question; None or "auto" → the router decides
    persona: str | None  # who answered (only for answers, not for saves and finds)
    router_error: str | None  # why the model router fell back to rules, if it did (e.g. a rate limit)
    router_retry_after: float | None  # how long the provider asked us to wait, when it was a rate limit
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
        tools: ToolBox | None = None,
    ) -> None:
        self.store = store
        self.tools = tools or ToolBox(repo=RepoIndex(PROJECT_ROOT))
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
                  prefs: dict[str, str] | None = None, persona: str | None = None) -> KeeperState:  # fmt: skip
        return await self.graph.ainvoke(
            {"text": text, "now": now, "photo_id": photo_id, "lat": lat, "lng": lng, "trace": [],
             "history": history or [], "prefs": prefs or {}, "persona_choice": personas.valid(persona)}
        )  # fmt: skip

    # ── understand ─────────────────────────────────────────────────────────
    async def _understand(self, state: KeeperState) -> KeeperState:
        start = time.perf_counter()
        now = state["now"]
        rules = rule_parse(state["text"], now.date())
        command, routed_by, router_error, retry_after = rules, "rules", None, None
        history = state.get("history") or []
        home = str((state.get("prefs") or {}).get("city") or "")
        handoff = active().tara.product_handoff  # the owner can turn "products first" off in the control room
        if handoff and (
            offer := accepted_offer(state["text"], history, home)
        ):  # "yes" to a product Tara just offered: open it
            command = Command(action="assist", tool=offer[0], args=offer[1])
            detail = f"assist · {offer[1]['product']} (accepted offer)"
            return {"command": command, "routed_by": "rules", "router_error": None, "router_retry_after": None,
                    "trace": _trace(state, "understand", start, detail)}  # fmt: skip
        product = rule_product(state["text"], history, home) if handoff else None
        # A tool request beats the "X is in Y" storage pattern: "weather in Pune" is a look-up, not where weather is kept.
        stash_guess = rules.action == "add" and rules.kind == "stash"
        if (hit := product or rule_tool(state["text"])) and (rules.action in ("help", "find", "chat") or stash_guess):
            command = Command(action="assist", tool=hit[0], args=hit[1])  # tools still work without the model
        try:
            # Plain replacement, not str.format: the prompt contains JSON braces.
            system = (
                ROUTER_SYSTEM.replace("{today}", now.date().isoformat())
                .replace("{weekday}", now.strftime("%A"))
                .replace("{time}", now.strftime("%H:%M"))
                .replace("{personas}", personas.router_menu())
                .replace("{products}", products_menu())
            )
            llm_cmd = await asyncio.wait_for(
                complete_json(for_task(self._get_llm(), "keeper.command"), system, _with_history(state), Command),
                self._timeout,
            )
            if _plausible(llm_cmd):
                command, routed_by = llm_cmd, "llm"
                # "Change your voice" is a personal setting, never a code change (which only the owner may ask for).
                if command.tool == "edit" and (hit := rule_settings(state["text"])):
                    command = command.model_copy(update={"tool": hit[0], "args": hit[1]})
                # Product first: a request a product is built for never gets a made-up answer in chat or a web search.
                # And if the model picked the travel planner persona to answer in chat, that is Safarnaama's job.
                if handoff and not product and command.action == "chat" and command.persona == "travel":
                    product = ("product", {"product": "safarnaama", **({"place": home.title()} if home else {})})
                if product and (
                    command.action == "chat" or command.tool in ("search", "web", "wiki", "product", "directions")
                ):
                    # The place read from the user's own words wins; the model's guess only fills a gap.
                    args = {
                        **{k: v for k, v in (command.args or {}).items() if v and command.tool == "product"},
                        **product[1],
                    }
                    command = command.model_copy(update={"action": "assist", "tool": "product", "args": args})
        except Exception as exc:  # noqa: BLE001 - any LLM failure → rules
            router_error = type(exc).__name__
            retry_after = getattr(exc, "retry_after", None)  # the provider's own "try again in" hint, if any
            logger.info("Keeper router fell back to rules: %s", router_error)
        detail = f"{command.action}{' · ' + command.kind if command.kind else ''} (via {'LLM' if routed_by == 'llm' else 'offline rules'})"
        return {"command": command, "routed_by": routed_by, "router_error": router_error, "router_retry_after": retry_after,
                "trace": _trace(state, "understand", start, detail)}  # fmt: skip

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
        elif cmd.action == "assist" and cmd.tool:
            out = await self._use_tool(cmd, state)
            return {**out, "entries": [], "trace": _trace(state, "act", start, f"used {cmd.tool}")}
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
    async def _use_tool(self, cmd: Command, state: KeeperState) -> dict[str, Any]:
        tool, args, now = cmd.tool or "", cmd.args or {}, state["now"]
        prefs = state.get("prefs") or {}
        tara = active().tara
        if tool == "edit" and not tara.code_proposals:
            return {"client_action": None, "tool_facts": "", "tool_error": "Code proposals are turned off on this site.",
                    "reply": "Code proposals are turned off on this site."}  # fmt: skip
        if tool not in ACTIONS and tool not in ("code", "portfolio") and not tara.lookups:
            return {
                "tool_error": "Look-ups (weather, news, facts, rates) are turned off on this site.",
                "tool_facts": "",
            }
        if tool in ACTIONS:
            action, said = ToolBox.action(tool, args, now)
            if action:
                action["auto"] = not action.get("confirm")  # asked for outright: the device may just do it
            return {"client_action": action, "tool_facts": "", "tool_error": "" if action else said, "reply": said}
        try:
            if tool == "weather":
                res = await self.tools.weather(args, state.get("lat"), state.get("lng"), prefs.get("city") or "")
            elif tool == "news":
                res = await self.tools.news(args, prefs.get("lang") or "en-IN")
            elif tool == "wiki":
                res = await self.tools.wiki(args)
            elif tool == "web":
                res = await self.tools.web(args)
            elif tool == "currency":
                res = await self.tools.currency(args)
            elif tool == "code":
                res = await self.tools.code(args)
            elif tool == "portfolio":
                res = await self.tools.portfolio(args)
            else:
                res = await self.tools.time_in(args, now)
        except ToolError as exc:
            return {"tool_error": str(exc), "tool_facts": ""}
        except Exception as exc:  # noqa: BLE001 - a source being down must not break the conversation
            logger.info("Tara tool %s failed: %s", tool, type(exc).__name__)
            return {
                "tool_error": f"I couldn't reach the {tool} service just now. Please try again in a moment.",
                "tool_facts": "",
            }
        return {
            "card": res.get("card"),
            "client_action": res.get("action"),
            # The source's own name goes with the facts, so the answer can say "says Open-Meteo", not "the lookup result".
            # (Code and portfolio look-ups already name their files.)
            "tool_facts": (
                f"(Source: {src}) "
                if (src := (res.get("card") or {}).get("source"))
                and res.get("facts")
                and not str(res.get("facts")).startswith(("FILE ", "FROM "))
                else ""
            )
            + res.get("facts", ""),
            "tool_error": "",
        }

    async def _respond(self, state: KeeperState) -> KeeperState:
        start = time.perf_counter()
        cmd = state["command"]
        if cmd.emotion == "crisis":  # safety first, whatever else was asked
            return {"reply": CRISIS, "trace": _trace(state, "respond", start, "safety response")}
        if cmd.action == "assist":
            if state.get("tool_error"):
                return {
                    "reply": state["tool_error"],
                    "trace": _trace(state, "respond", start, "explained what's missing"),
                }
            if cmd.tool in ACTIONS:
                return {
                    "reply": state.get("reply") or "Done.",
                    "trace": _trace(state, "respond", start, "action prepared"),
                }
            who = _persona_of(state)
            if not state.get("tool_facts"):  # nothing to quote: answer from general knowledge, search one tap away
                reply = await self._chat(state)
                return {"reply": reply, "persona": who,
                        "trace": _trace(state, "respond", start, "answered; offered a web search")}  # fmt: skip
            reply = await self._chat(state, facts=state["tool_facts"])
            return {"reply": reply, "persona": who,
                    "trace": _trace(state, "respond", start, f"answered from {cmd.tool} as {who}")}  # fmt: skip
        if cmd.action == "chat":
            who = _persona_of(state)
            reply = await self._chat(state)
            return {"reply": reply, "persona": who, "trace": _trace(state, "respond", start, f"answered as {who}")}
        reply = compose_reply(state["command"], state.get("entries", []))
        if ack := ACKS.get(state["command"].emotion or ""):
            reply = f"{ack} {reply}"
        return {"reply": reply, "trace": _trace(state, "respond", start, "confirmation composed")}

    async def _chat(self, state: KeeperState, facts: str = "") -> str:
        """A spoken-style answer for anything that isn't a save/find chore, grounded in today's agenda."""
        now = state["now"]
        items = schedule.agenda(self.store.list(), now)[:8]
        agenda = "; ".join(i.label for i in items) or "nothing due"
        prefs = state.get("prefs") or {}
        name = (prefs.get("name") or "").strip()
        use_name = name_allowed(name, state.get("history") or [])
        persona = personas.PERSONAS[_persona_of(state)]
        system = ASSISTANT_SYSTEM.format(
            now=now.strftime("%Y-%m-%d %H:%M"), weekday=now.strftime("%A"), agenda=agenda,
            tone=TONES.get(prefs.get("tone", ""), TONES["warm"]),
            persona=persona.brief,
            length=DEEP if persona.deep else LENGTHS.get(prefs.get("length", ""), LENGTHS["short"]),
            name=(f"The user's name is {name}; you may use it once in this reply." if use_name
                  else "Don't address the user by name in this reply."),
            mood=MOODS.get(getattr(state.get("command"), "emotion", None) or "", ""),
        )  # fmt: skip
        if facts:
            system += "\nLOOK-UP RESULT: " + facts
        try:
            text = await asyncio.wait_for(
                for_task(
                    self._get_llm(), "keeper.expert" if persona.deep or "FILE " in facts else "keeper.chat"
                ).complete(system, [{"role": "user", "content": _with_history(state)}]),
                self._timeout,
            )
            text = re.sub(r"[*_#`]+", "", str(text)).strip()
            if name and not use_name:
                text = drop_name(text, name)
            if text:
                return text[: 1400 if persona.deep else 700]
        except Exception as exc:  # noqa: BLE001 - offline: still answer something useful
            logger.info("Tara chat fell back: %s", type(exc).__name__)
        card = state.get("card") or {}
        if card.get("type") == "code":  # the model is down: say where the code is rather than read it out
            places = "; ".join(f"{h['path']}" + (f" ({h['symbol']})" if h.get("symbol") else "") for h in card["hits"])
            return f"Here's where that lives in the code: {places}."
        if facts:  # the model is down: the facts themselves are still a truthful answer
            return facts[:500]
        if re.search(r"\btime\b", state["text"], re.I):
            return f"It's {now.strftime('%H:%M')} on {now.strftime('%A, %d %B')}."
        return "I can't answer that right now, but I can remember things, remind you, and tell you what's due."


def _persona_of(state: KeeperState) -> str:
    """The user's pick for this question, else the router's, else the everyday assistant."""
    return (
        personas.valid(state.get("persona_choice"))
        or personas.valid(getattr(state.get("command"), "persona", None))
        or personas.DEFAULT
    )


def name_allowed(name: str, history: list[dict[str, str]]) -> bool:
    """Use the user's name in the first answer and then about one in four, never twice in a row.

    Left to the model, "use it now and then" turns into every reply, so the decision is made here.
    """
    if not name:
        return False
    replies = [str(t.get("text") or "") for t in history if t.get("role") == "assistant"]
    if not replies:
        return True
    recent = replies[-3:]
    return len(replies) % 4 == 0 and not any(re.search(rf"\b{re.escape(name)}\b", r, re.I) for r in recent)


def drop_name(text: str, name: str) -> str:
    """Take the user's name out where it's only a form of address ("Sure, Sid!" → "Sure!", "Sid, it's 9." → "It's 9.")."""
    n = re.escape(name)
    out = re.sub(rf",\s*{n}\b(?=\s*[.!?,;:]|\s*$)", "", text, flags=re.I)  # "..., Sid." / "Hi, Sid!"
    out = re.sub(
        rf"^\s*(?:(?:hi|hey|hello|okay|ok|sure|alright)\s+)?{n}\s*[,!.:]\s*", "", out, flags=re.I
    )  # "Sid, ..."
    out = re.sub(rf"^(hi|hey|hello)\s+{n}\b", r"\1", out, flags=re.I)
    out = out.strip()
    return (out[:1].upper() + out[1:]) if out else text


def _with_history(state: KeeperState) -> str:
    """The message, with the last few turns so follow-ups ("remind me about that tomorrow") make sense."""
    n = active().tara.history_turns
    turns = [t for t in state.get("history") or [] if t.get("text")][-n:] if n else []
    if not turns:
        return state["text"]
    lines = [f"{'User' if t.get('role') == 'user' else 'Tara'}: {str(t['text'])[:300]}" for t in turns]
    return "Earlier in this conversation:\n" + "\n".join(lines) + f"\n\nNow the user says: {state['text']}"


_CURRENCY = {"INR": "₹", "RS": "₹", "RS.": "₹", "USD": "$", "EUR": "€", "GBP": "£"}


_URGENT = re.compile(r"(urgent(ly)?|important|asap|don'?t forget|must not forget|critical)", re.I)


def _plausible(c: Command) -> bool:
    """Reject LLM output that cannot be acted on (e.g. add without a kind)."""
    if c.action in ("add", "list") and not c.kind:
        return False
    if c.action == "assist" and c.tool not in TOOLS:
        return False
    if c.tool == "product" and not (c.args or {}).get("product"):
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
