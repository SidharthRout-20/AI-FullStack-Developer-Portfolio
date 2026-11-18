"""TripWeaver travel logic: routes and timing, traffic and wellbeing insights, nearby places and meal slots.

Pure functions (no I/O), so every rule is unit-tested directly. Data comes from free services fetched by
`tripweaver.Tools`: OSRM (routing), Overpass / OpenStreetMap (nearby places), Open-Meteo (weather, UV,
air quality). Traffic advice is based on typical rush hours, not live traffic (which needs a paid API).
"""

from __future__ import annotations

import datetime as dt
import math
import re
from typing import Any

WALK_KMH = 4.5
WALK_MAX_KM = 1.2  # shorter legs are walked
PEAK_WINDOWS = (("08:00", "10:00"), ("17:00", "20:00"))
PEAK_FACTOR = 1.4  # typical rush-hour slowdown on city roads
LUNCH = ("12:00", "14:30")
DINNER = ("19:00", "21:30")
_TRAVELLER_NEEDS = re.compile(
    r"\b(kid|kids|child|children|toddler|baby|elderly|senior|parents|grand|wheelchair|pregnan)", re.I
)


# ── geometry & time helpers ────────────────────────────────────────────────
def km_between(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lng1, lat2, lng2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def to_min(hhmm: str) -> int:
    try:
        h, m = hhmm.split(":")
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return 9 * 60


def to_hhmm(minutes: int) -> str:
    minutes = max(0, min(minutes, 23 * 60 + 55))
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def in_window(hhmm: str, window: tuple[str, str]) -> bool:
    return to_min(window[0]) <= to_min(hhmm) < to_min(window[1])


def located(acts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [a for a in acts if a.get("lat") is not None and a.get("lng") is not None]


# ── routes ─────────────────────────────────────────────────────────────────
def build_route(acts: list[dict[str, Any]], drive_legs: list[dict[str, float]] | None) -> dict[str, Any]:
    """Legs between consecutive located stops: walk short hops, drive the rest; flag rush-hour departures."""
    stops = located(acts)
    legs: list[dict[str, Any]] = []
    for i, (a, b) in enumerate(zip(stops, stops[1:], strict=False)):
        straight = km_between((a["lat"], a["lng"]), (b["lat"], b["lng"]))
        osrm = (drive_legs or [])[i] if drive_legs and i < len(drive_legs) else None
        km = osrm["distance_m"] / 1000 if osrm else straight * 1.3
        walk = km <= WALK_MAX_KM
        minutes = round(km / WALK_KMH * 60) if walk else round((osrm["duration_s"] / 60) if osrm else km / 25 * 60)
        depart = to_hhmm(to_min(a.get("time", "09:00")) + int(a.get("duration_min", 60)))
        peak = not walk and minutes >= 10 and any(in_window(depart, w) for w in PEAK_WINDOWS)
        legs.append({
            "from": a["id"], "to": b["id"], "from_name": a["name"], "to_name": b["name"], "km": round(km, 1),
            "minutes": max(1, minutes), "mode": "walk" if walk else "drive", "depart": depart, "peak": peak,
            "peak_minutes": round(minutes * PEAK_FACTOR) if peak else None,
        })  # fmt: skip
    return {
        "legs": legs,
        "walk_min": sum(leg["minutes"] for leg in legs if leg["mode"] == "walk"),
        "drive_min": sum(leg["minutes"] for leg in legs if leg["mode"] == "drive"),
    }


def retime(acts: list[dict[str, Any]], route: dict[str, Any]) -> list[dict[str, Any]]:
    """Re-time a day after reordering: each stop starts when the previous one ends plus travel (meals never earlier)."""
    if not acts:
        return acts
    travel = {leg["to"]: leg["peak_minutes"] or leg["minutes"] for leg in route.get("legs", [])}
    out, clock = [], to_min(acts[0].get("time", "09:00"))
    for i, a in enumerate(acts):
        if i:
            clock += travel.get(a["id"], 10)
            clock = math.ceil(clock / 5) * 5
            if a.get("kind") == "food":
                clock = max(clock, to_min(a.get("time", "12:30")))
        out.append({**a, "time": to_hhmm(clock)})
        clock += int(a.get("duration_min", 60))
    return out


def reorder(acts: list[dict[str, Any]], order: list[int]) -> list[dict[str, Any]]:
    """Apply an optimised visiting order to the movable stops; meals and unlocated stops keep their slots."""
    movable = [i for i, a in enumerate(acts) if a.get("kind") != "food" and a.get("lat") is not None]
    if len(order) != len(movable) or sorted(order) != list(range(len(movable))):
        return acts
    out = list(acts)
    for slot, src in zip(movable, order, strict=True):
        out[slot] = acts[movable[src]]
    return out


# ── insights ───────────────────────────────────────────────────────────────
def insights(day: dict[str, Any], travellers: str | None, pace: str) -> list[dict[str, str]]:
    """Traffic, rest, heat, UV, air, hydration, meals, pace and accessibility advice for one day."""
    out: list[dict[str, str]] = []
    acts = day.get("activities", [])
    route = day.get("route") or {}
    w = day.get("weather") or {}

    def add(kind: str, level: str, text: str) -> None:
        out.append({"type": kind, "level": level, "text": text})

    for leg in route.get("legs", []):
        if leg.get("peak"):
            add("traffic", "warn", f"Leaving {leg['from_name']} at {leg['depart']} hits rush hour: allow "
                f"~{leg['peak_minutes']} min instead of {leg['minutes']}, or leave before 08:00 / after 10:00 "
                f"(evenings: after 20:00).")  # fmt: skip
        if leg["mode"] == "drive" and leg["minutes"] >= 120:
            add(
                "rest",
                "warn",
                f"{leg['minutes'] // 60} h+ drive to {leg['to_name']}: stop for 15 minutes every 2 hours.",
            )
    if route.get("drive_min", 0) >= 180:
        add("rest", "warn", f"About {route['drive_min'] // 60} h of driving today: keep the evening light.")

    feels = w.get("feels_max") if w.get("feels_max") is not None else w.get("tmax")
    if feels is not None and feels >= 35:
        hot = [
            a["name"]
            for a in acts
            if a.get("kind") == "outdoor" and in_window(a.get("time", "09:00"), ("11:00", "16:00"))
        ]
        add("heat", "warn", f"Feels like {round(feels)}°C. " + (
            f"Move {', '.join(hot[:3])} before 11:00 or after 16:00." if hot else "Keep outdoor time to mornings and evenings."))  # fmt: skip
    if (w.get("tmax") or 0) >= 30 or (feels or 0) >= 32:
        add("hydration", "info", "Hot day: carry water and plan a cool indoor break mid-afternoon.")
    if (w.get("uv") or 0) >= 8:
        add("uv", "warn", f"UV index {round(w['uv'])}: sunscreen, hats and shade between 11:00 and 15:00.")
    aqi = w.get("aqi")
    if aqi is not None and aqi >= 150:
        add(
            "air",
            "warn",
            f"Air quality is unhealthy (US AQI {round(aqi)}): limit strenuous outdoor time; a mask helps.",
        )
    elif aqi is not None and aqi >= 100:
        add("air", "info", f"Air quality is poor for sensitive groups (US AQI {round(aqi)}).")
    if (w.get("rain") or 0) >= 60 and any(a.get("kind") == "outdoor" for a in acts):
        add("rain", "warn", f"{w['rain']}% chance of rain: keep an indoor backup handy.")

    if acts and not any(a.get("kind") == "food" and in_window(a.get("time", ""), LUNCH) for a in acts):
        add("meal", "info", "No lunch stop planned: use “Add meal stops” to slot one in near where you'll be.")
    from safarnama.stops import is_rest  # local import: stops is a leaf module, travel is imported by it indirectly

    busy = (
        sum(int(a.get("duration_min", 60)) for a in acts if not is_rest(a.get("name", "")))
        + route.get("walk_min", 0)
        + route.get("drive_min", 0)
    )
    if busy >= (480 if pace == "relaxed" else 600):
        add("pace", "warn", f"A long day (~{busy // 60} h of activities and travel): add a rest break.")
    if travellers and _TRAVELLER_NEEDS.search(travellers):
        long_walks = [leg for leg in route.get("legs", []) if leg["mode"] == "walk" and leg["km"] >= 0.8]
        add("access", "info", "Travelling with kids, seniors or limited mobility: check step-free access and seating."
            + (f" {len(long_walks)} walk(s) of 800 m+ today; consider a cab." if long_walks else ""))  # fmt: skip
    return out


# ── opening hours (common OpenStreetMap patterns; unknown → None) ──────────
_DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]


def _day_set(spec: str) -> set[int] | None:
    days: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            if a not in _DAYS or b not in _DAYS:
                return None
            i, j = _DAYS.index(a), _DAYS.index(b)
            days |= set(range(i, j + 1)) if i <= j else set(range(i, 7)) | set(range(0, j + 1))
        elif part in _DAYS:
            days.add(_DAYS.index(part))
        else:
            return None
    return days


def is_open(opening_hours: str | None, when: dt.datetime) -> bool | None:
    """True/False for common patterns ("Mo-Fr 09:00-17:00; Sa 10:00-14:00", "24/7", "… off"); None if unknown."""
    if not opening_hours:
        return None
    oh = opening_hours.strip()
    if oh == "24/7":
        return True
    t = when.hour * 60 + when.minute
    verdict: bool | None = None
    for rule in (r.strip() for r in oh.split(";") if r.strip()):
        m = re.match(r"^(?:([A-Za-z,\- ]+?)\s+)?((?:\d{1,2}:\d{2}-\d{1,2}:\d{2}\+?,?\s*)+|off|closed)$", rule)
        if not m:
            if re.match(r"^PH\b", rule):
                continue
            return None
        days = _day_set(m[1].replace(" ", "")) if m[1] else set(range(7))
        if days is None:
            return None
        if when.weekday() not in days:
            continue
        if m[2] in ("off", "closed"):
            verdict = False
            continue
        verdict = False
        for span in re.findall(r"(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})", m[2]):
            start, end = int(span[0]) * 60 + int(span[1]), int(span[2]) * 60 + int(span[3])
            if (start <= t < end) if end > start else (t >= start or t < end):  # spans past midnight
                verdict = True
    return verdict


# ── nearby places ──────────────────────────────────────────────────────────
def describe_place(tags: dict[str, str]) -> tuple[str, str]:
    """(group, category) for an OpenStreetMap feature: group is "food" or "sights"."""
    if tags.get("amenity") in ("restaurant", "cafe", "fast_food", "food_court", "ice_cream", "bar", "pub"):
        return "food", tags["amenity"].replace("_", " ")
    for key in ("tourism", "historic", "leisure"):
        if key in tags:
            return "sights", tags[key].replace("_", " ") if tags[key] != "yes" else key
    return "sights", "place"


def filter_places(
    places: list[dict[str, Any]], *, cuisine: str | None = None, veg: bool = False, open_at: dt.datetime | None = None
) -> list[dict[str, Any]]:
    out = []
    for p in places:
        if cuisine and cuisine.lower() not in (p.get("cuisine") or "").lower():
            continue
        if veg and not p.get("veg"):
            continue
        if open_at is not None:
            state = is_open(p.get("opening_hours"), open_at)
            if state is False:
                continue
            p = {**p, "open": state}
        out.append(p)
    return out


def pick_meal(places: list[dict[str, Any]], when: dt.datetime, prefer_veg: bool) -> dict[str, Any] | None:
    """Best nearby restaurant for a meal slot: open (or unknown), closest, veg-friendly if wanted, sit-down first."""

    def score(p: dict[str, Any]) -> float:
        s = p.get("distance_m", 9999) / 100
        s += {"restaurant": 0, "food court": 2, "cafe": 3, "fast food": 4}.get(p.get("category", ""), 5)
        s += 0 if is_open(p.get("opening_hours"), when) else 3
        s -= 4 if prefer_veg and p.get("veg") else 0
        s -= 1 if p.get("cuisine") else 0
        return s

    candidates = [p for p in places if p.get("group") == "food" and is_open(p.get("opening_hours"), when) is not False]
    return min(candidates, key=score, default=None)


def meal_gaps(acts: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """Meal slots ("lunch"/"dinner", "HH:MM") the day is missing, timed after the stop in progress."""
    gaps = []
    for label, window in (("lunch", LUNCH), ("dinner", DINNER)):
        if any(a.get("kind") == "food" and in_window(a.get("time", ""), window) for a in acts):
            continue
        ends = [to_min(a.get("time", "09:00")) + int(a.get("duration_min", 60)) for a in acts]
        inside = [e for e in ends if to_min(window[0]) <= e <= to_min(window[1]) - 45]
        start = min(inside) if inside else to_min(window[0]) + 30
        if label == "dinner" and acts and max(ends) < to_min(window[0]) - 120:
            continue  # the day ends well before dinner
        gaps.append((label, to_hhmm(math.ceil(start / 5) * 5)))
    return gaps


def anchor_for(acts: list[dict[str, Any]], hhmm: str) -> dict[str, Any] | None:
    """The located stop the traveller is at (or just left) at a given time."""
    from safarnama.stops import placeless

    places = [a for a in located(acts) if not a.get("placeless") and not placeless(a.get("name", ""))]
    before = [a for a in places if to_min(a.get("time", "09:00")) <= to_min(hhmm)]
    return before[-1] if before else (places or [None])[0]
