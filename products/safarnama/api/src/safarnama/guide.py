"""Safarnaama's travel guide: what a good local guide tells you once your days are planned.

For each destination: where to stay (areas, and what a room usually costs a night at budget, mid-range and premium
level), food to try (dishes, and the popular places or streets they're known at), things to do (adventure, culture,
nature, local life) with what they usually cost, getting around and its fares, getting there from where you start,
and what each planned stop usually costs to enter. One model call per trip, stored on the trip.

What is and isn't known, kept apart and labelled:
  * every amount is a typical range the model knows for that season (an ESTIMATE, in the traveller's currency), never
    a live price, and never a claim about availability;
  * every named place is checked on the map near the destination: a food place that can't be found loses its name
    (the dish stays), a thing to do that can't be found keeps no map pin.

`estimate()` turns the guide and the plan into what the trip will likely cost, by stay level, against the budget.
Pure functions here are unit-tested in tests/test_guide.py; the model call and map checks live in GuideMixin.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import math
import re
from typing import Annotated, Any

from fastapi import HTTPException
from pydantic import BeforeValidator, Field

from appcore.ai import Lenient, ask_json
from safarnama import stops, travel

logger = logging.getLogger(__name__)

TIERS = ("budget", "mid", "premium")
_DIRECTIONS = re.compile(
    r"\s*(?:,|;|\(|\s[-–]\s|\s(?:near|behind|opposite|off|next to|beside|inside|on the)\s).*$", re.I
)


def place_name(where: str) -> str:
    """The place itself from a guide's description: "Mango Tree Cooking Studio, near Saheliyon-ki-Bari" →
    "Mango Tree Cooking Studio" (directions and areas would make the map search miss it)."""
    return _DIRECTIONS.sub("", where or "").strip() or (where or "").strip()


THING_TYPES = ("adventure", "culture", "nature", "local")


def _one_of(allowed: tuple[str, ...], default: str, aliases: dict[str, str] | None = None) -> BeforeValidator:
    """A label the model may word its own way ("Adventure", "sightseeing", "per person"): mapped onto the allowed ones,
    or the default, so one odd label never throws away a whole guide."""

    def pick(v: Any) -> str:
        text = str(v or "").strip().lower()
        for a in allowed:
            if a in text:
                return a
        for k, a in (aliases or {}).items():
            if k in text:
                return a
        return default

    return BeforeValidator(pick)


TierLabel = Annotated[
    str,
    _one_of(
        TIERS, "mid", {"cheap": "budget", "luxury": "premium", "high": "premium", "medium": "mid", "comfort": "mid"}
    ),
]
ThingType = Annotated[
    str,
    _one_of(
        THING_TYPES,
        "local",
        {
            "sight": "culture",
            "heritage": "culture",
            "history": "culture",
            "museum": "culture",
            "temple": "culture",
            "trek": "adventure",
            "sport": "adventure",
            "outdoor": "nature",
            "food": "local",
            "shop": "local",
        },
    ),
]
PerCost = Annotated[
    str,
    _one_of(
        ("person", "group", "free"),
        "person",
        {"no fee": "free", "family": "group", "vehicle": "group", "boat": "group", "car": "group"},
    ),
]
PerRide = Annotated[str, _one_of(("person", "trip", "day"), "trip", {"ride": "trip", "hour": "trip", "km": "trip"})]


class Range(Lenient):
    min: float = Field(0, ge=0)
    max: float = Field(0, ge=0)


class StayTier(Lenient):
    tier: TierLabel = "mid"
    kind: str = Field("", max_length=60)  # "guest house or homestay", "3-star hotel"…
    per_night: Range = Field(default_factory=Range)  # one room, two people


class StayArea(Lenient):
    area: str = Field(max_length=80)
    why: str = Field("", max_length=200)
    tiers: list[StayTier] = Field(default_factory=list, max_length=3)


class Food(Lenient):
    dish: str = Field(max_length=80)
    what: str = Field("", max_length=200)
    where: str = Field("", max_length=100)  # a real place, street or market it's known at; empty when unsure
    popular: bool = False  # a famous, busy spot (vs a local favourite)
    per_person: Range = Field(default_factory=Range)


class Thing(Lenient):
    name: str = Field(max_length=100)
    type: ThingType = "local"
    what: str = Field("", max_length=220)
    where: str = Field("", max_length=100)
    minutes: int = Field(120, ge=15, le=720)
    cost: Range = Field(default_factory=Range)
    per: PerCost = "person"
    best_time: str = Field("", max_length=80)
    tip: str = Field("", max_length=160)


class Ride(Lenient):
    mode: str = Field(max_length=60)
    what: str = Field("", max_length=160)
    fare: Range = Field(default_factory=Range)
    per: PerRide = "trip"
    hours: float | None = Field(None, ge=0, le=72)  # getting there only


class Daily(Lenient):
    food_per_person: Range = Field(default_factory=Range)  # three meals and snacks, at the stay level chosen
    local_transport: Range = Field(default_factory=Range)  # the whole group, a day


class DestGuide(Lenient):
    destination: str = Field(max_length=80)
    stay: list[StayArea] = Field(default_factory=list, max_length=3)
    food: list[Food] = Field(default_factory=list, max_length=8)
    things: list[Thing] = Field(default_factory=list, max_length=10)
    around: list[Ride] = Field(default_factory=list, max_length=5)
    daily: Daily = Field(default_factory=Daily)
    tips: list[str] = Field(default_factory=list, max_length=5)


class StopCost(Lenient):
    id: str = Field(max_length=40)
    cost: Range = Field(default_factory=Range)
    per: PerCost = "person"


class Guide(Lenient):
    destinations: list[DestGuide] = Field(default_factory=list, max_length=5)
    getting_there: list[Ride] = Field(default_factory=list, max_length=4)
    stop_costs: list[StopCost] = Field(default_factory=list, max_length=60)


GUIDE_SYSTEM = """You are a seasoned local travel guide who knows real places and what things really cost there.
For the trip given, write the practical guide a traveller needs, as JSON only:
{"destinations": [{"destination": str,
   "stay": [{"area": "neighbourhood or part of town to stay in", "why": str,
             "tiers": [{"tier": "budget"|"mid"|"premium", "kind": "e.g. guest house or homestay / 3-star hotel / resort",
                        "per_night": {"min": n, "max": n}}]}],
   "food": [{"dish": str, "what": str, "where": "the NAME of a real, well-known eatery, street or market for it (no
             directions), or \\"\\"",
             "popular": bool, "per_person": {"min": n, "max": n}}],
   "things": [{"name": str, "type": "adventure"|"culture"|"nature"|"local", "what": str,
               "where": "the NAME of the real place it happens (no directions)", "minutes": int,
               "cost": {"min": n, "max": n},
               "per": "person"|"group"|"free", "best_time": str, "tip": str}],
   "around": [{"mode": "e.g. auto-rickshaw, local bus, taxi for the day, scooter rental", "what": str,
               "fare": {"min": n, "max": n}, "per": "person"|"trip"|"day"}],
   "daily": {"food_per_person": {"min": n, "max": n}, "local_transport": {"min": n, "max": n}},
   "tips": [str]}],
 "getting_there": [{"mode": "flight"|"train"|"bus"|"car", "what": str, "fare": {"min": n, "max": n},
                    "per": "person", "hours": n}],
 "stop_costs": [{"id": str, "cost": {"min": n, "max": n}, "per": "person"|"group"|"free"}]}
Rules:
- All amounts are typical ranges in the CURRENCY given, for the travel MONTH given; realistic, not optimistic. Room
  prices are for one room for two, a night. Never claim availability, ratings, opening hours or exact prices.
- Stay: 1-2 areas per destination; for each, the tiers that really exist there (budget, mid, premium).
- Food: 5-6 per destination, a mix of popular spots and local favourites; only name places that really exist and are
  known for that food, otherwise leave "where" empty.
- Things: 7-9 per destination mixing adventures, culture, nature and local life; real places. Prefer things that are
  NOT already planned stops (the traveller sees those in the plan). Never suggest anything that exploits animals
  (elephant or camel rides for show, animal performances, wildlife selfies), or anything unsafe or illegal.
- Around: 2-4 ways to get around with fares. Daily: food_per_person is everything one person eats and drinks in a whole
  day (three meals at sit-down places, snacks, tea or coffee) at a mid level; local_transport is the whole group's local
  rides for a day.
- Getting there: only when STARTING FROM is given; 1-3 sensible ways with fares a person and hours. Else [].
- Stop costs: for EVERY planned stop id listed, its usual entry or activity fee ("free" when there is none; meals at a
  restaurant cost the meal, per person).
- Tips: 2-4 practical local tips (cash, permits, timing, etiquette)."""


def _range(r: dict[str, Any] | None) -> tuple[float, float]:
    r = r or {}
    lo, hi = float(r.get("min") or 0), float(r.get("max") or 0)
    return (min(lo, hi), max(lo, hi)) if hi else (lo, lo)


def tier_prices(dest: dict[str, Any]) -> dict[str, tuple[float, float]]:
    """A room a night at each stay level for a destination (the widest range across its areas)."""
    out: dict[str, tuple[float, float]] = {}
    for area in dest.get("stay") or []:
        for t in area.get("tiers") or []:
            lo, hi = _range(t.get("per_night"))
            if hi <= 0:
                continue
            cur = out.get(t["tier"])
            out[t["tier"]] = (min(cur[0], lo), max(cur[1], hi)) if cur else (lo, hi)
    return out


def _times(per: str, people: int) -> int:
    return 0 if per == "free" else people if per == "person" else 1


def estimate(trip: dict[str, Any], guide: dict[str, Any], tier: str | None = None) -> dict[str, Any]:
    """What the trip will likely cost (low and high), at a stay level, against the budget.

    Stay: rooms for two × nights × that level's room price, per destination's nights. Food and local transport: per
    day. Things to do: the planned stops' usual fees. Getting there: the cheapest sensible way, there and back.
    Without a level, the best one the budget covers is chosen ("budget" if none fits)."""
    people = max(1, int((trip.get("party") or {}).get("travellers") or 1))
    rooms = math.ceil(people / 2)
    days = trip.get("days") or []
    budget = (trip.get("budget") or {}).get("total")
    dests = trip.get("destinations") or [trip.get("city") or {}]
    by_dest = {str(d.get("name", "")).lower(): guide_for(guide, str(d.get("name", "")), i) for i, d in enumerate(dests)}

    def stay_for(level: str) -> tuple[float, float]:
        lo = hi = 0.0
        for i, d in enumerate(dests):
            nights = (d.get("end_day", len(days)) - d.get("start_day", 1)) + (0 if i == len(dests) - 1 else 1)
            prices = tier_prices(by_dest.get(str(d.get("name", "")).lower(), {}))
            p = prices.get(level) or prices.get("mid") or next(iter(prices.values()), (0.0, 0.0))
            lo, hi = lo + p[0] * rooms * nights, hi + p[1] * rooms * nights
        return lo, hi

    food = [0.0, 0.0]
    local = [0.0, 0.0]
    for d in days:
        g = by_dest.get(_dest_name(trip, d).lower()) or next(iter(by_dest.values()), {})
        f, t = (
            _range((g.get("daily") or {}).get("food_per_person")),
            _range((g.get("daily") or {}).get("local_transport")),
        )
        food = [food[0] + f[0] * people, food[1] + f[1] * people]
        local = [local[0] + t[0], local[1] + t[1]]
    costs = {c["id"]: c for c in guide.get("stop_costs") or []}
    things = [0.0, 0.0]
    for d in days:
        for a in d.get("activities") or []:
            c = costs.get(a.get("id"))
            if c and a.get("kind") != "food":  # meals are counted in food
                lo, hi = _range(c.get("cost"))
                n = _times(c.get("per", "person"), people)
                things = [things[0] + lo * n, things[1] + hi * n]
    ways = [w for w in guide.get("getting_there") or [] if _range(w.get("fare"))[1] > 0]
    there = (0.0, 0.0)
    if ways:
        w = min(ways, key=lambda x: _range(x.get("fare"))[0])
        lo, hi = _range(w.get("fare"))
        there = (lo * people * 2, hi * people * 2)

    def total(level: str) -> tuple[float, float]:
        s = stay_for(level)
        return (s[0] + food[0] + local[0] + things[0] + there[0], s[1] + food[1] + local[1] + things[1] + there[1])

    levels = [t for t in TIERS if any(t in tier_prices(g) for g in by_dest.values())] or ["mid"]
    if tier not in levels:
        # The most comfortable level the budget surely covers; if none, the one most likely to fit; else the cheapest.
        fits = [t for t in levels if budget is None or total(t)[1] <= budget]
        near = [t for t in levels if budget is not None and total(t)[0] <= budget]
        tier = (
            (fits[-1:] or near[:1] or levels[:1])[0]
            if budget is not None
            else ("mid" if "mid" in levels else levels[0])
        )
    lo, hi = total(tier)
    status = None
    if budget is not None:
        status = "fits" if hi <= budget else "tight" if lo <= budget else "over"
    r0 = lambda x: round(x / 10) * 10  # noqa: E731
    return {
        "tier": tier,
        "levels": {t: [r0(v) for v in total(t)] for t in levels},
        "parts": {
            "stay": [r0(v) for v in stay_for(tier)],
            "food": [r0(v) for v in food],
            "local": [r0(v) for v in local],
            "things": [r0(v) for v in things],
            "getting_there": [r0(v) for v in there],
        },  # fmt: skip
        "total": [r0(lo), r0(hi)],
        "budget": budget,
        "status": status,
        "people": people,
        "rooms": rooms,
        "included_getting_there": bool(ways),
    }


def guide_for(guide: dict[str, Any], name: str, index: int) -> dict[str, Any]:
    """The guide's part for a destination: same name, else a name that contains it ("Manali, Himachal Pradesh"),
    else the one in the same position."""
    gs = guide.get("destinations") or []
    low = name.lower().strip()
    for g in gs:
        if str(g.get("destination", "")).lower().strip() == low:
            return g
    for g in gs:
        if low and low in str(g.get("destination", "")).lower():
            return g
    return gs[index] if index < len(gs) else (gs[0] if gs else {})


def _dest_name(trip: dict[str, Any], day: dict[str, Any]) -> str:
    for d in trip.get("destinations") or []:
        if d.get("id") == day.get("destination") or (
            not day.get("destination") and d.get("start_day", 1) <= day.get("day", 1) <= d.get("end_day", 99)
        ):
            return str(d.get("name", ""))
    return str((trip.get("city") or {}).get("name", ""))


def guide_prompt(trip: dict[str, Any], origin: str | None, currency: str, today: dt.date) -> str:
    dests = trip.get("destinations") or [trip.get("city") or {}]
    month = next((d.get("date") for d in trip.get("days") or [] if d.get("date")), None)
    when = dt.date.fromisoformat(month).strftime("%B %Y") if month else today.strftime("%B %Y")
    people = (trip.get("party") or {}).get("travellers") or 2
    lines = [
        f"DESTINATIONS: {'; '.join(f'{d.get("name")}, {d.get("country") or ""}' for d in dests)}",
        f"MONTH: {when}   CURRENCY: {currency}   TRAVELLERS: {people} ({(trip.get('party') or {}).get('type') or 'n/a'})",
        f"STARTING FROM: {origin or '(not given)'}",
        f"INTERESTS: {', '.join((trip.get('request') or {}).get('interests') or []) or 'general'}",
        "PLANNED STOPS (id: name):",
    ]
    for d in trip.get("days") or []:
        for a in d.get("activities") or []:
            if not a.get("placeless"):
                lines.append(f"{a['id']}: {a['name']} (day {d['day']})")
    return "\n".join(lines)


class GuideMixin:
    """Mixed into TripService: expects `db`, `tools`, `get_llm`, `_save_trip`."""

    async def guide(self, trip: dict[str, Any], origin: str | None = None, refresh: bool = False) -> dict[str, Any]:
        """The trip's guide: made once (or again when asked, e.g. with a starting point), then kept on the trip."""
        origin = (origin or "").strip()[:80] or None
        have = trip.get("guide")
        if have and not refresh and (origin is None or origin == have.get("origin")):
            return have
        currency = ((trip.get("budget") or {}).get("currency") or "INR").upper()
        raw = await ask_json(
            self.get_llm, GUIDE_SYSTEM, guide_prompt(trip, origin, currency, dt.date.today()), Guide,  # type: ignore[attr-defined]
            limit_s=90, task="tripweaver.guide",
        )  # fmt: skip
        data = raw.model_dump(mode="json")
        planned = {a["id"] for d in trip.get("days") or [] for a in d.get("activities") or []}
        data["stop_costs"] = [c for c in data["stop_costs"] if c["id"] in planned]
        await self._check_places(trip, data)
        data.update({"origin": origin, "currency": currency, "generated_at": dt.datetime.now(dt.UTC).isoformat(),
                     "estimates": True})  # fmt: skip
        self._save_trip(trip, {"guide": data}, bump=False)  # type: ignore[attr-defined]
        return data

    async def _check_places(self, trip: dict[str, Any], data: dict[str, Any]) -> None:
        """Pin every named place on the map near its destination. Unfound eateries lose their name; unfound things
        to do keep no pin."""
        dests = {str(d.get("name", "")).lower(): d for d in trip.get("destinations") or [trip.get("city") or {}]}
        jobs = []
        for g in data["destinations"]:
            d = dests.get(g["destination"].lower()) or next(iter(dests.values()), {})
            if d.get("lat") is None:
                continue
            near, town = (d["lat"], d["lng"]), d.get("name", "")
            for item in g["food"]:
                if item["where"]:
                    item["where"] = place_name(item["where"])
                    jobs.append((item, stops.place_queries(item["where"], None, town)[:3], near, True))
            for item in g["things"]:
                queries = stops.place_queries(place_name(item["where"]) or item["name"], None, town)[:3]
                queries += [q for q in stops.place_queries(item["name"], None, town)[:2] if q not in queries]
                jobs.append((item, queries, near, False))

        sem = asyncio.Semaphore(4)

        async def one(item: dict[str, Any], queries: list[str], near: tuple[float, float], business: bool) -> None:
            hit = None
            async with sem:
                for query in queries:
                    try:
                        hit = await self.tools.geocode_place(query, near)  # type: ignore[attr-defined]
                    except Exception:  # noqa: BLE001 - a map lookup that fails just means no pin
                        hit = None
                    if hit and hit.get("lat") is not None:
                        break
            if hit and hit.get("lat") is not None:
                item.update({"lat": hit["lat"], "lng": hit["lng"]})
            elif business:
                item["where"] = ""  # never name an eatery the map doesn't know
            item.setdefault("lat", None)
            item.setdefault("lng", None)

        await asyncio.gather(*(one(*j) for j in jobs))

    async def add_from_guide(self, trip: dict[str, Any], kind: str, dest: int, index: int, day: int) -> dict[str, Any]:
        """Put a thing to do (or a food place) from the guide into a day, after its last stop, keeping its usual cost."""
        g = trip.get("guide")
        try:
            item = g["destinations"][dest]["things" if kind == "thing" else "food"][index]  # type: ignore[index]
        except (TypeError, IndexError, KeyError):
            raise HTTPException(404, "That suggestion isn't in this trip's guide.") from None
        if item.get("lat") is None:
            raise HTTPException(422, "That place isn't on the map, so it can't be added to a day.")
        for x in trip["days"]:  # the same place under another name ("Galtaji" / "Galtaji Temple") is already planned
            for a in x["activities"]:
                if (
                    a.get("lat") is not None
                    and travel.km_between((a["lat"], a["lng"]), (item["lat"], item["lng"])) < 0.15
                ):
                    raise HTTPException(409, f"That's already in your plan on day {x['day']} ({a['name']}).")
        d = self._day(trip, day)  # type: ignore[attr-defined]
        ends = [travel.to_min(a.get("time", "09:00")) + int(a.get("duration_min", 60)) for a in d["activities"]]
        start = min(max([9 * 60, *ends]) + 15, 20 * 60)
        start -= start % 15
        food = kind == "food"
        stop = {
            "name": item["where"] if food else item["name"], "lat": item["lat"], "lng": item["lng"],
            "kind": "food" if food else "outdoor", "time": f"{start // 60:02d}:{start % 60:02d}",
            "duration_min": 60 if food else int(item.get("minutes") or 90),
            "note": (f"Try the {item['dish']}. " if food else "") + (item.get("what") or "")[:240], "added": "guide",
        }  # fmt: skip
        before = {a["id"] for a in d["activities"]}
        updated = await self.add_stop(trip, day, stop)  # type: ignore[attr-defined]
        new = next(a for x in updated["days"] if x["day"] == day for a in x["activities"] if a["id"] not in before)
        cost = {"id": new["id"], "cost": item.get("per_person") if food else item.get("cost"),
                "per": "person" if food else item.get("per", "person")}  # fmt: skip
        return self._save_trip(updated, {"guide": {**g, "stop_costs": [*g.get("stop_costs", []), cost]}}, bump=False)  # type: ignore[attr-defined,misc]


def estimates(trip: dict[str, Any]) -> dict[str, Any] | None:
    """The trip's likely cost at each stay level, and the level the budget points to."""
    g = trip.get("guide")
    if not g:
        return None
    best = estimate(trip, g)
    return {"chosen": best["tier"], "levels": {t: estimate(trip, g, t) for t in best["levels"]}}
