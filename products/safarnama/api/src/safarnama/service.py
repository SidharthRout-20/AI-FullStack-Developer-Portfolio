"""TripWeaver: an agent that plans trips with real tools and re-plans when things change.

Tools (all free, no API keys):
  * geocoding: Open-Meteo geocoding (cities) and Photon / OpenStreetMap (places, biased to the destination)
  * weather:   Open-Meteo daily forecast (≈16 days ahead) with UV and feels-like temperature, plus air quality
  * routing:   OSRM (leg times, best visiting order); rush-hour advice uses typical traffic patterns
  * nearby:    Overpass / OpenStreetMap attractions and food (cuisine, vegetarian, opening hours)
The agent: understand the request → geocode destination → fetch the forecast → LLM drafts a day-by-day plan that
must respect the weather → every activity is geocoded onto the map. Re-planning rewrites only the affected days.
Group mode: votes are shared live to every open browser through Server-Sent Events.

The wider travel ecosystem (ownership, discovery, bookings, budget, documents, companion) lives in
`trip_ecosystem.py` (service) and `trip_api.py` (HTTP); pure rules are in `trip_logic.py` and `travel.py`.
Model calls go through the central Groq LLM router with declared tasks (no model IDs here).
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import re
import time
from collections import defaultdict
from collections.abc import AsyncIterator, Callable
from typing import Any, ClassVar, Literal

import httpx
from fastapi import HTTPException
from pydantic import Field, field_validator, model_validator

from appcore.ai import Lenient, ask_json
from appcore.docstore import DocStore, new_id
from safarnama import logic as trip_logic
from safarnama import stops, travel
from safarnama.ecosystem import TripEcosystem
from safarnama.logic import destination_of

logger = logging.getLogger(__name__)
UA = {"User-Agent": "TripWeaver-portfolio/1.0"}
RAINY = 60  # % precipitation probability that counts as a wet day
# One server, short timeout: when it is at capacity the Nominatim fallback answers in ~2 s instead of waiting
# on mirrors that are usually just as busy.
OVERPASS = ("https://overpass-api.de/api/interpreter",)


class Leg(Lenient):
    destination: str = Field(max_length=120)
    country: str | None = Field(None, max_length=60)
    days: int = Field(1, ge=1, le=10)

    @field_validator("days", mode="before")
    @classmethod
    def _days(cls, v: Any) -> Any:
        try:
            return max(1, min(10, int(v)))
        except (TypeError, ValueError):
            return 1


class TripRequest(Lenient):
    destination: str = Field(max_length=120)
    country: str | None = Field(None, max_length=60)
    start_date: dt.date | None = None
    days: int = Field(3, ge=1, le=10)
    interests: list[str] = Field(default_factory=list, max_length=10)
    pace: Literal["relaxed", "balanced", "packed"] = "balanced"
    travellers: str | None = Field(None, max_length=80)
    party: Literal["solo", "couple", "family", "friends", "group"] | None = None
    legs: list[Leg] = Field(default_factory=list, max_length=4)

    @field_validator("party", mode="before")
    @classmethod
    def _party(cls, v: Any) -> Any:
        return v if v in ("solo", "couple", "family", "friends", "group") else None

    @field_validator("pace", mode="before")
    @classmethod
    def _pace(cls, v: Any) -> Any:
        return v if v in ("relaxed", "balanced", "packed") else "balanced"

    @field_validator("start_date", mode="before")
    @classmethod
    def _date(cls, v: Any) -> Any:
        if isinstance(v, dt.date):
            return v
        if not isinstance(v, str) or v.strip() in ("", "null"):
            return None
        try:
            return dt.date.fromisoformat(v.strip()[:10])
        except ValueError:
            return None  # "next weekend" etc.: plan without a date rather than fail

    @field_validator("days", mode="before")
    @classmethod
    def _days(cls, v: Any) -> Any:
        try:
            return max(1, min(10, int(v)))
        except (TypeError, ValueError):
            return 3

    @model_validator(mode="before")
    @classmethod
    def _shape(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        legs = [x for x in out.get("legs") or [] if isinstance(x, dict) and x.get("destination")]
        out["legs"] = legs
        if not out.get("destination") and legs:
            out["destination"] = legs[0]["destination"]
        return out

    def stops(self) -> list[Leg]:
        """Destinations with their number of days (10 days in total at most)."""
        legs = (
            self.legs
            if len(self.legs) >= 2
            else [Leg(destination=self.destination, country=self.country, days=self.days)]
        )
        out, left = [], 10
        for leg in legs:
            if left <= 0:
                break
            out.append(leg.model_copy(update={"days": min(leg.days, left)}))
            left -= out[-1].days
        return out


_CLOCK = re.compile(r"(\d{1,2})(?:\s*[:.h]\s*(\d{2}))?\s*([ap])?\.?\s*m?\b", re.I)


def clock(v: Any, default: str = "09:00") -> str:
    """ "9:00 AM", "9am", "09:00-10:30", "14h30" → "HH:MM" (24 h); anything else → default."""
    m = _CLOCK.search(str(v or ""))
    if not m:
        return default
    h, mins, ampm = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").lower()
    if ampm == "p" and h < 12:
        h += 12
    elif ampm == "a" and h == 12:
        h = 0
    return f"{h:02d}:{mins:02d}" if h < 24 and mins < 60 else default


class Activity(Lenient):
    _aliases: ClassVar[dict[str, str]] = {
        "place": "name", "title": "name", "activity": "name", "location": "place_query", "query": "place_query",
        "duration": "duration_min", "minutes": "duration_min", "notes": "note", "description": "note",
        "start": "time", "start_time": "time", "type": "kind",
    }  # fmt: skip
    time: str = Field("09:00", max_length=5)
    name: str = Field(max_length=120)
    place_query: str = Field("", max_length=160, description="searchable place name")
    kind: Literal["outdoor", "indoor", "food", "transit"] = "outdoor"
    duration_min: int = Field(90, ge=10, le=600)
    note: str = Field("", max_length=300)

    @field_validator("kind", mode="before")
    @classmethod
    def _kind(cls, v: Any) -> Any:
        return v if v in ("outdoor", "indoor", "food", "transit") else "outdoor"

    @field_validator("time", mode="before")
    @classmethod
    def _time(cls, v: Any) -> Any:
        return clock(v)

    @model_validator(mode="before")
    @classmethod
    def _named(cls, data: Any) -> Any:
        if isinstance(data, dict) and not data.get("name") and data.get("place_query"):
            data = {**data, "name": str(data["place_query"]).split(",")[0]}
        return data

    @field_validator("duration_min", mode="before")
    @classmethod
    def _dur(cls, v: Any) -> Any:
        try:
            return max(10, min(600, int(v)))
        except (TypeError, ValueError):
            return 90


_STOP_NAMES = ("name", "place_query", "place", "title", "activity")


class Day(Lenient):
    _aliases: ClassVar[dict[str, str]] = {
        "stops": "activities", "schedule": "activities", "items": "activities", "plan": "activities",
        "title": "theme", "day_number": "day",
    }  # fmt: skip
    day: int = 0  # 0 = not given: numbered by position
    theme: str = Field("", max_length=120)
    activities: list[Activity] = Field(default_factory=list, max_length=8)

    @field_validator("day", mode="before")
    @classmethod
    def _day(cls, v: Any) -> Any:
        m = re.search(r"\d+", str(v if v is not None else ""))
        return int(m.group()) if m else 0

    @field_validator("activities", mode="before")
    @classmethod
    def _stops(cls, v: Any) -> Any:
        # Drop entries that aren't stops at all (a stray string, one without a name) rather than the whole plan.
        if not isinstance(v, list):
            return v
        return [a for a in v if isinstance(a, dict) and any(a.get(k) for k in _STOP_NAMES)]


def _days_of(data: Any, key: str) -> Any:
    """Accept the shapes models drift into: a bare list of days, {"plan": {...}}, {"itinerary": [...]}."""
    if isinstance(data, list):
        return {key: data}
    if not isinstance(data, dict) or key in data:
        return data
    for wrapper in ("plan", "trip", "result", "data"):
        if isinstance(data.get(wrapper), dict):
            rest = {k: v for k, v in data.items() if k != wrapper}
            return _days_of({**data[wrapper], **rest}, key)
    for alias in ("days", "itinerary", "changed_days", "day_plans"):
        if isinstance(data.get(alias), list):
            return {**data, key: data[alias]}
    return data


def _numbered(days: list[Day]) -> list[Day]:
    """Days with stops, in order; days the model didn't number are numbered by position."""
    kept = [d for d in days if d.activities]
    return [d if d.day else d.model_copy(update={"day": i + 1}) for i, d in enumerate(kept)]


class Plan(Lenient):
    _aliases: ClassVar[dict[str, str]] = {
        "name": "title", "trip_title": "title", "overview": "summary", "description": "summary",
        "travel_tips": "tips",
    }  # fmt: skip
    title: str = Field("", max_length=120)
    summary: str = Field("", max_length=800)
    days: list[Day] = Field(min_length=1, max_length=10)
    tips: list[str] = Field(default_factory=list, max_length=6)

    @model_validator(mode="before")
    @classmethod
    def _unwrap(cls, data: Any) -> Any:
        return _days_of(data, "days")

    @field_validator("days", mode="after")
    @classmethod
    def _real_days(cls, v: list[Day]) -> list[Day]:
        days = _numbered(v)
        if not days:
            raise ValueError("no day has any stops")
        return days


class Replan(Lenient):
    _aliases: ClassVar[dict[str, str]] = {"summary": "explanation", "reason": "explanation"}
    changed_days: list[Day] = Field(min_length=1, max_length=10)
    explanation: str = Field("", max_length=600)

    @model_validator(mode="before")
    @classmethod
    def _unwrap(cls, data: Any) -> Any:
        return _days_of(data, "changed_days")

    @field_validator("changed_days", mode="after")
    @classmethod
    def _real_days(cls, v: list[Day]) -> list[Day]:
        days = [d for d in v if d.activities and d.day]
        if not days:
            raise ValueError("no re-planned day with a day number and stops")
        return days


UNDERSTAND_SYSTEM = """Extract a trip request as JSON: {"destination": str (city/region), "country": str|null,
"start_date": "YYYY-MM-DD"|null (resolve relative dates from today), "days": int (1-10, default 3),
"interests": [str], "pace": "relaxed"|"balanced"|"packed", "travellers": str|null,
"party": "solo"|"couple"|"family"|"friends"|"group"|null,
"legs": [{"destination": str, "country": str|null, "days": int}] (ONLY when several cities are requested, in order;
otherwise [])}. Today is {today}."""

PLAN_SYSTEM = """You are an expert local travel planner. Plan a realistic day-by-day itinerary using REAL, existing,
well-known places in the destination (exact names that a map search will find). Group nearby places on the same day,
include meals, and respect opening-hours common sense. When a day's rain probability is >= 60%, prefer indoor
activities that day. On multi-destination trips each day happens in the destination given for it.
Rules:
- Each date's weekday is given: never schedule a place on a day it is usually closed (many museums close on
  Mondays) and say opening days in the note when they matter.
- Travel between stops is calculated for you: do NOT add separate "Drive to…", "Transfer" or "Return to hotel"
  stops. For a sight far out of town, mention the realistic drive time in its note and group far sights that lie
  on the same road on the same day.
- Leave enough time between stops for real travel; never overlap times.
- Meals and breaks at the traveller's own accommodation are fine, written as "Breakfast at your stay".
- "name" is the place itself, exactly as a map knows it (no brackets, no "Stroll through…"); put the activity in
  the note. "place_query" is that name plus the town.
- Follow dietary and access requests strictly (vegetarian means no meat suggestions at all).
- For famous sights with long queues or limited entry, suggest arriving at opening time.
- Never repeat a place on two days.
- Don't invent arrival or departure times, flights or airport stops: plan the days at the destination.
- An excursion far out of town (an hour or more each way, e.g. river rafting, a distant viewpoint) needs most of a
  day: don't squeeze it into an afternoon after city sights.
- Keep it compact: at most 6 stops a day and notes under 140 characters.
Reply with ONE JSON object:
{"title": str, "summary": str, "tips": [str],
 "days": [{"day": 1, "theme": str, "activities": [{"time": "HH:MM", "name": str, "place_query": str
   (place name + city, for map search), "kind": "outdoor"|"indoor"|"food"|"transit", "duration_min": int, "note": str}]}]}"""

REPLAN_SYSTEM = """You revise an existing itinerary after something changed. Change ONLY the days that must change
(and only days listed in ALLOWED DAYS when given), keep good parts and every PINNED stop, keep real place names (with
place_query for map search). Reply with ONE JSON object:
{"explanation": str (what you changed and why, 1-3 sentences),
 "changed_days": [{"day": int, "theme": str, "activities": [ ...same activity shape... ]}]}"""


# ── Tools ────────────────────────────────────────────────────────────────
def _near(hit: dict[str, Any], near: tuple[float, float]) -> dict[str, Any] | None:
    """Reject matches > ~100 km from the destination (same-name places elsewhere)."""
    return hit if abs(hit["lat"] - near[0]) <= 1.0 and abs(hit["lng"] - near[1]) <= 1.0 else None


class ProviderBusy(Exception):
    """A provider answered but couldn't serve the request (rate limit, error page, malformed body)."""


class Tools:
    """External calls in one place (swappable with fakes in tests)."""

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self._sem = asyncio.Semaphore(4)
        self._nominatim_lock = asyncio.Lock()  # OSM policy: max 1 request/second
        self._photon_down_until = 0.0
        self._overpass_down_until = 0.0
        self._cache: dict[tuple[str, float, float], dict[str, Any] | None] = {}

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=15, headers=UA)
        return self._client

    async def geocode_city(self, name: str, country: str | None) -> dict[str, Any] | None:
        r = await self.client.get("https://geocoding-api.open-meteo.com/v1/search", params={"name": name, "count": 5})
        results = r.json().get("results") or []
        if country:
            results = sorted(results, key=lambda x: country.lower() not in str(x.get("country", "")).lower())
        if not results:
            return None
        x = results[0]
        return {
            "name": x["name"],
            "country": x.get("country"),
            "lat": x["latitude"],
            "lng": x["longitude"],
            "timezone": x.get("timezone"),
        }

    async def geocode_place(self, query: str, near: tuple[float, float]) -> dict[str, Any] | None:
        """Photon first (fast, typo-tolerant); if it misses, fails or throttles us (shared hosting IPs often are),
        OpenStreetMap Nominatim (1 request/second). Only real answers are cached, never a failed lookup."""
        key = (query.lower(), round(near[0], 2), round(near[1], 2))
        if key in self._cache:
            return self._cache[key]
        hit: dict[str, Any] | None = None
        answered = False
        if time.monotonic() >= self._photon_down_until:
            try:
                hit = await self._photon(query, near)
                answered = True
            except (httpx.HTTPError, ProviderBusy) as e:
                logger.info("Photon unavailable (%s); using Nominatim for 10 minutes", e.__class__.__name__)
                self._photon_down_until = time.monotonic() + 600
        if hit is None:
            try:
                hit = await self._nominatim(query, near)
                answered = True
            except (httpx.HTTPError, ProviderBusy) as e:
                logger.info("Nominatim unavailable (%s)", e.__class__.__name__)
        if answered:
            self._cache[key] = hit
        return hit

    async def _photon(self, query: str, near: tuple[float, float]) -> dict[str, Any] | None:
        async with self._sem:
            r = await self.client.get(
                "https://photon.komoot.io/api/",
                params={"q": query, "lat": near[0], "lon": near[1], "limit": 1, "lang": "en"},
                timeout=httpx.Timeout(8, connect=4),
            )
        if r.status_code != 200:
            raise ProviderBusy(f"HTTP {r.status_code}")
        try:
            feats = r.json().get("features") or []
        except ValueError as e:
            raise ProviderBusy("not JSON") from e
        if not feats:
            return None
        lng, lat = feats[0]["geometry"]["coordinates"]
        props = feats[0].get("properties", {})
        label = ", ".join(filter(None, [props.get("name"), props.get("street"), props.get("city")]))
        return _near({"lat": lat, "lng": lng, "label": label}, near)

    async def _nominatim(self, query: str, near: tuple[float, float]) -> dict[str, Any] | None:
        box = f"{near[1] - 0.5},{near[0] + 0.5},{near[1] + 0.5},{near[0] - 0.5}"  # left,top,right,bottom
        async with self._nominatim_lock:
            started = time.monotonic()
            try:
                r = await self.client.get(
                    "https://nominatim.openstreetmap.org/search",
                    params={"q": query, "format": "jsonv2", "limit": 1, "viewbox": box, "bounded": 1},
                    timeout=httpx.Timeout(10, connect=5),
                )
                if r.status_code != 200:
                    raise ProviderBusy(f"HTTP {r.status_code}")
                try:
                    rows = r.json()
                except ValueError as e:
                    raise ProviderBusy("not JSON") from e
            finally:
                await asyncio.sleep(max(0.0, 1.05 - (time.monotonic() - started)))
        if not rows:
            return None
        row = rows[0]
        label = row.get("display_name", "").split(",")[0]
        return _near({"lat": float(row["lat"]), "lng": float(row["lon"]), "label": label}, near)

    async def forecast(self, lat: float, lng: float, tz: str | None) -> dict[str, dict[str, Any]]:
        r = await self.client.get(
            "https://api.open-meteo.com/v1/forecast",
            params={"latitude": lat, "longitude": lng, "timezone": tz or "auto", "forecast_days": 16,
                    "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,"
                             "uv_index_max,apparent_temperature_max"},
        )  # fmt: skip
        d = r.json().get("daily") or {}
        n = len(d.get("time", []))
        col = lambda k: d.get(k) or [None] * n  # noqa: E731
        return {
            day: {"code": code, "tmax": tmax, "tmin": tmin, "rain": rain, "uv": uv, "feels_max": feels}
            for day, code, tmax, tmin, rain, uv, feels in zip(
                d.get("time", []), col("weather_code"), col("temperature_2m_max"), col("temperature_2m_min"),
                col("precipitation_probability_max"), col("uv_index_max"), col("apparent_temperature_max"), strict=False,
            )
        }  # fmt: skip

    async def air_quality(self, lat: float, lng: float) -> dict[str, float]:
        """Daily max US AQI for the next ~5 days (Open-Meteo air quality)."""
        r = await self.client.get(
            "https://air-quality-api.open-meteo.com/v1/air-quality",
            params={"latitude": lat, "longitude": lng, "hourly": "us_aqi", "timezone": "auto", "forecast_days": 5},
        )
        h = r.json().get("hourly") or {}
        out: dict[str, float] = {}
        for t, v in zip(h.get("time", []), h.get("us_aqi", []), strict=False):
            if v is not None:
                out[t[:10]] = max(out.get(t[:10], 0), float(v))
        return out

    async def route(self, stops: list[tuple[float, float]]) -> list[dict[str, float]]:
        """Driving legs between consecutive stops (OSRM): [{duration_s, distance_m}]."""
        coords = ";".join(f"{lng:.5f},{lat:.5f}" for lat, lng in stops)
        async with self._sem:
            r = await self.client.get(f"https://router.project-osrm.org/route/v1/driving/{coords}",
                                      params={"overview": "false", "steps": "false"})  # fmt: skip
        body = r.json()
        if body.get("code") != "Ok":
            return []
        return [{"duration_s": leg["duration"], "distance_m": leg["distance"]} for leg in body["routes"][0]["legs"]]

    async def best_order(self, stops: list[tuple[float, float]]) -> list[int]:
        """Fastest visiting order that starts at the first stop (OSRM trip service): stop indices in order."""
        coords = ";".join(f"{lng:.5f},{lat:.5f}" for lat, lng in stops)
        async with self._sem:
            r = await self.client.get(f"https://router.project-osrm.org/trip/v1/driving/{coords}",
                                      params={"source": "first", "roundtrip": "false", "destination": "any",
                                              "overview": "false"})  # fmt: skip
        body = r.json()
        if body.get("code") != "Ok":
            return list(range(len(stops)))
        visit = [w["waypoint_index"] for w in body["waypoints"]]  # input i is visited at position visit[i]
        return sorted(range(len(stops)), key=lambda i: visit[i])

    async def nearby(self, lat: float, lng: float, group: str, radius: int = 900) -> list[dict[str, Any]]:
        """Named attractions ("sights") or eateries ("food") around a point, from OpenStreetMap (Overpass)."""
        key = ("nearby:" + group, round(lat, 3), round(lng, 3))
        if key in self._cache:
            return self._cache[key]  # type: ignore[return-value]
        around = f"(around:{radius},{lat:.5f},{lng:.5f})"
        if group == "food":
            body = f'nwr{around}["amenity"~"^(restaurant|cafe|fast_food|food_court|ice_cream)$"]["name"];'
        else:
            body = (f'nwr{around}["tourism"~"^(attraction|museum|viewpoint|gallery|artwork|zoo|aquarium|theme_park)$"]["name"];'
                    f'nwr{around}["historic"]["name"];nwr{around}["leisure"~"^(park|garden|nature_reserve)$"]["name"];')  # fmt: skip
        query = f"[out:json][timeout:15];({body});out center tags 80;"
        try:
            raw = await self._overpass(query)
        except httpx.HTTPError:
            raw = await self._nominatim_area(lat, lng, group, radius)  # Overpass busy: OSM search as a fallback
        places: dict[str, dict[str, Any]] = {}
        for tags, plat, plng, *_ in raw:
            if not tags.get("name") or plat is None:
                continue
            grp, category = travel.describe_place(tags)
            if grp != group:
                continue
            diet = (tags.get("diet:vegetarian") or "") + (tags.get("diet:vegan") or "")
            places.setdefault(tags["name"].lower(), {
                "name": tags["name"], "group": grp, "category": category, "lat": plat, "lng": plng,
                "distance_m": round(travel.km_between((lat, lng), (plat, plng)) * 1000),
                "cuisine": (tags.get("cuisine") or "").replace(";", ", ").replace("_", " ") or None,
                "veg": diet.startswith(("yes", "only")) or "only" in diet,
                "opening_hours": tags.get("opening_hours"),
                "website": tags.get("website") or tags.get("contact:website"),
                "wheelchair": tags.get("wheelchair"),
            })  # fmt: skip
        out = sorted(places.values(), key=lambda p: p["distance_m"])[:40]
        self._cache[key] = out  # type: ignore[assignment]
        return out

    async def discover(self, lat: float, lng: float, group: str, radius: int | None = None) -> list[dict[str, Any]]:
        """Named OpenStreetMap features of one discovery group around a point (Overpass; Nominatim as fallback)."""
        radius = radius or trip_logic.DEFAULT_RADIUS.get(group, 1200)
        key = (f"discover:{group}:{radius}", round(lat, 3), round(lng, 3))
        if key in self._cache:
            return self._cache[key]  # type: ignore[return-value]
        around = f"(around:{radius},{lat:.5f},{lng:.5f})"
        body = "".join(f'nwr{around}{sel}["name"];' for sel in trip_logic.SELECTORS[group])
        try:
            raw = await self._overpass(f"[out:json][timeout:20];({body});out center tags 150;")
        except httpx.HTTPError:
            raw = await self._nominatim_area(lat, lng, group, radius)
        places: dict[str, dict[str, Any]] = {}
        for tags, plat, plng, oid in raw:
            if not tags.get("name") or plat is None:
                continue
            p = trip_logic.place_from(tags, plat, plng, (lat, lng), oid)
            if trip_logic.matches(p, group):
                places.setdefault(p["name"].lower(), p)
        out = sorted(places.values(), key=lambda p: p["distance_m"])[:60]
        self._cache[key] = out  # type: ignore[assignment]
        return out

    async def forecast_detail(self, lat: float, lng: float, tz: str | None) -> dict[str, Any]:
        """Daily forecast + current conditions + hourly rain probability in one Open-Meteo call."""
        r = await self.client.get(
            "https://api.open-meteo.com/v1/forecast",
            params={"latitude": lat, "longitude": lng, "timezone": tz or "auto", "forecast_days": 16,
                    "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,"
                             "uv_index_max,apparent_temperature_max,wind_gusts_10m_max",
                    "current": "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
                    "hourly": "precipitation_probability"},
        )  # fmt: skip
        body = r.json()
        d = body.get("daily") or {}
        n = len(d.get("time", []))
        col = lambda k: d.get(k) or [None] * n  # noqa: E731
        daily = {
            day: {"code": code, "tmax": tmax, "tmin": tmin, "rain": rain, "uv": uv, "feels_max": feels, "wind_max": gust}
            for day, code, tmax, tmin, rain, uv, feels, gust in zip(
                d.get("time", []), col("weather_code"), col("temperature_2m_max"), col("temperature_2m_min"),
                col("precipitation_probability_max"), col("uv_index_max"), col("apparent_temperature_max"),
                col("wind_gusts_10m_max"), strict=False,
            )
        }  # fmt: skip
        hourly: dict[str, list[list[float]]] = defaultdict(list)
        h = body.get("hourly") or {}
        for t, prob in zip(h.get("time", []), h.get("precipitation_probability", []), strict=False):
            if prob is not None:
                hourly[t[:10]].append([int(t[11:13]), prob])
        c = body.get("current") or {}
        current = {
            "temp": c.get("temperature_2m"), "feels": c.get("apparent_temperature"),
            "precipitation": c.get("precipitation"), "code": c.get("weather_code"), "wind": c.get("wind_speed_10m"),
            "observed_at": c.get("time"),
        } if c else None  # fmt: skip
        return {"daily": daily, "hourly": dict(hourly), "current": current}

    async def fx(self, base: str, quote: str) -> dict[str, Any] | None:
        """Reference exchange rate (Frankfurter, no key; rates update a few times a day, they are not live quotes)."""
        key = ("fx", base, quote)
        if key in self._cache and self._cache[key] and self._cache[key].get("_at", 0) > time.monotonic() - 3600:  # type: ignore[union-attr]
            return self._cache[key]  # type: ignore[return-value]
        r = await self.client.get("https://api.frankfurter.dev/v1/latest", params={"base": base, "symbols": quote})
        if r.status_code != 200:
            return None
        body = r.json()
        rate = (body.get("rates") or {}).get(quote)
        if rate is None:
            return None
        out = {"rate": float(rate), "date": body.get("date"), "from": base, "to": quote,
               "source": "Frankfurter reference rates", "_at": time.monotonic()}  # fmt: skip
        self._cache[key] = out  # type: ignore[assignment]
        return out

    async def _overpass(self, query: str) -> list[tuple[dict[str, str], float | None, float | None, str | None]]:
        if time.monotonic() < self._overpass_down_until:
            raise httpx.HTTPError("Overpass recently unavailable")
        for server in OVERPASS:  # public servers are often at capacity: fall through to the next mirror
            try:
                async with self._sem:
                    r = await self.client.post(server, data={"data": query}, timeout=httpx.Timeout(7, connect=4))
                if r.status_code == 200:
                    return [
                        (el.get("tags") or {}, el.get("lat") or (el.get("center") or {}).get("lat"),
                         el.get("lon") or (el.get("center") or {}).get("lon"), f"{el.get('type')}/{el.get('id')}")
                        for el in r.json().get("elements", [])
                    ]  # fmt: skip
            except (httpx.HTTPError, ValueError):
                continue
        self._overpass_down_until = time.monotonic() + 600  # skip it for 10 minutes; use the fallback meanwhile
        logger.info("Overpass unavailable; using Nominatim for nearby places for 10 minutes")
        raise httpx.HTTPError("All Overpass servers are busy")

    async def _nominatim_area(
        self, lat: float, lng: float, group: str, radius: int
    ) -> list[tuple[dict[str, str], float | None, float | None, str | None]]:
        """OpenStreetMap search inside a box around the point (1 request/second, per the usage policy)."""
        d = radius / 111_000
        box = f"{lng - d * 1.3},{lat + d},{lng + d * 1.3},{lat - d}"
        words = trip_logic.NOMINATIM_WORDS.get(group, ("museum", "attraction", "viewpoint", "park"))
        out: list[tuple[dict[str, str], float | None, float | None, str | None]] = []
        for word in words:
            async with self._nominatim_lock:
                started = time.monotonic()
                try:
                    r = await self.client.get(
                        "https://nominatim.openstreetmap.org/search",
                        params={
                            "q": word,
                            "format": "jsonv2",
                            "limit": 30,
                            "viewbox": box,
                            "bounded": 1,
                            "extratags": 1,
                        },
                        timeout=httpx.Timeout(10, connect=5),
                    )
                    rows = r.json() if r.status_code == 200 else []
                except (httpx.HTTPError, ValueError):
                    rows = []
                finally:
                    await asyncio.sleep(max(0.0, 1.05 - (time.monotonic() - started)))
            for row in rows:
                if not row.get("name"):
                    continue  # unnamed match: its address (often a street) must never pass as a place name
                tags = {k: str(v) for k, v in (row.get("extratags") or {}).items()}
                tags.setdefault(row.get("category", ""), row.get("type", "yes"))
                tags["name"] = row["name"]
                oid = f"{row.get('osm_type')}/{row.get('osm_id')}" if row.get("osm_id") else None
                out.append((tags, float(row["lat"]), float(row["lon"]), oid))
        return out


# ── Live updates for group mode ──────────────────────────────────────────
class Hub:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue[dict[str, Any]]]] = defaultdict(set)

    def publish(self, trip_id: str, event: dict[str, Any]) -> None:
        for q in list(self._subs.get(trip_id, ())):
            q.put_nowait(event)

    async def subscribe(
        self, trip_id: str, load: Callable[[], dict[str, Any] | None] | None = None
    ) -> AsyncIterator[dict[str, Any]]:
        """Live events for one trip. On serverless hosts a change may happen on another instance, so the
        stored trip is also re-read every few seconds and pushed when its version/updated_at moved."""
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
        self._subs[trip_id].add(q)
        seen = (load() or {}).get("updated_at") if load else None
        idle = 0.0
        try:
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), 4)
                    if ev.get("event") == "trip":
                        seen = ev["trip"].get("updated_at")
                    yield ev
                except TimeoutError:
                    idle += 4
                    current = load() if load else None
                    if current and current.get("updated_at") != seen:
                        seen = current.get("updated_at")
                        yield {"event": "trip", "trip": current}
                    elif idle >= 20:
                        idle = 0
                        yield {"event": "ping"}
        finally:
            self._subs[trip_id].discard(q)


def _now_iso() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds")


def day_dates(start: dt.date | None, n: int) -> list[str | None]:
    return [(start + dt.timedelta(days=i)).isoformat() if start else None for i in range(n)]


class TripService(TripEcosystem):
    def __init__(self, store: DocStore, get_llm: Callable[[], Any], tools: Tools | None = None) -> None:
        self.db = store
        self.get_llm = get_llm
        self.tools = tools or Tools()
        self.hub = Hub()

    async def plan(
        self,
        prompt: str,
        today: dt.date,
        owner: str | None = None,
        *,
        party: str | None = None,
        travellers: int | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        def step(name: str, detail: str) -> dict[str, Any]:
            return {"event": "step", "step": name, "detail": detail}

        req = await ask_json(
            self.get_llm,
            UNDERSTAND_SYSTEM.replace("{today}", today.isoformat()),
            prompt,
            TripRequest,
            task="tripweaver.understand",
        )
        if req.start_date and req.start_date < today:
            req = req.model_copy(update={"start_date": today})
        if party:
            req = req.model_copy(update={"party": party})
        yield step(
            "understand",
            f"{req.days} days in {req.destination} · {req.pace}"
            + (f" · from {req.start_date}" if req.start_date else ""),
        )

        legs = req.stops()
        req = req.model_copy(update={"days": sum(leg.days for leg in legs)})
        destinations: list[dict[str, Any]] = []
        first_day = 1
        for leg in legs:
            place = await self.tools.geocode_city(leg.destination, leg.country)
            if place is None:
                raise HTTPException(422, f"Couldn't find “{leg.destination}” on the map.")
            destinations.append({**place, "id": new_id(), "start_day": first_day, "end_day": first_day + leg.days - 1})
            first_day += leg.days
        city = destinations[0]
        yield step("geocode", "; ".join(f"{d['name']}, {d.get('country') or ''} ({d['lat']:.3f}, {d['lng']:.3f})"
                                         for d in destinations))  # fmt: skip

        dates = day_dates(req.start_date, req.days)
        dest_for_day = {n: d for d in destinations for n in range(d["start_day"], d["end_day"] + 1)}
        weather_at: str | None = None  # when the forecast was fetched: the UI shows it, never "live"
        forecasts: dict[str, dict[str, dict[str, Any]]] = {}
        for d in destinations:
            try:
                forecasts[d["id"]] = await self.tools.forecast(d["lat"], d["lng"], d.get("timezone"))
                weather_at = weather_at or (_now_iso() if forecasts[d["id"]] else None)
            except Exception:  # noqa: BLE001 - plan without weather rather than fail
                logger.info("forecast unavailable")
        wx = [forecasts.get(dest_for_day[i + 1]["id"], {}).get(d) if d else None for i, d in enumerate(dates)]
        known = [
            f"Day {i + 1} ({d}, {dest_for_day[i + 1]['name']}): rain {w['rain']}%, {w['tmin']}–{w['tmax']}°C"
            for i, (d, w) in enumerate(zip(dates, wx, strict=True))
            if w
        ]
        yield step(
            "weather",
            "; ".join(known[:4]) + ("…" if len(known) > 4 else "")
            if known
            else "No forecast for these dates (too far ahead or no date given)",
        )

        route_text = "; ".join(
            f"Days {d['start_day']}-{d['end_day']}: {d['name']}, {d.get('country')}" for d in destinations
        )
        plan_prompt = (
            f"Destination: {route_text}\nDays: {req.days}\nStart: {req.start_date or 'flexible'}\n"
            f"Interests: {', '.join(req.interests) or 'general sightseeing'}\nPace: {req.pace}\nTravellers: {req.travellers or 'n/a'}\n"
            f"Weather: {'; '.join(known) or 'unknown'}\n"
            f"Dates: {'; '.join(f'Day {i + 1} = {d} ({dt.date.fromisoformat(d).strftime("%A")})' for i, d in enumerate(dates) if d) or 'flexible'}\n\n"
            f"Original request: {prompt}"
        )
        plan = await self._full_plan(plan_prompt, req.days)
        if not plan.title.strip():
            plan = plan.model_copy(update={"title": f"{req.days} days in {city['name']}"[:120]})
        yield step("plan", f"{sum(len(d.activities) for d in plan.days)} activities across {len(plan.days)} days")

        near = {n: ((d["lat"], d["lng"]), d["name"]) for n, d in dest_for_day.items()}
        days = await self._locate(plan.days[: req.days], (city["lat"], city["lng"]), city["name"], near)
        found = sum(1 for d in days for a in d["activities"] if a.get("lat") is not None)
        total = sum(len(d["activities"]) for d in days)
        yield step("map", f"{found}/{total} places located on the map")

        for i, d in enumerate(days):
            d["date"] = dates[i] if i < len(dates) else None
            d["weather"] = wx[i] if i < len(wx) else None
            d["destination"] = dest_for_day.get(d["day"], city)["id"]
        draft = {"request": req.model_dump(mode="json"), "city": city, "destinations": destinations, "days": days}
        meals = await self._add_meals(draft)
        yield step("meals", f"{meals} meal stop{'s' if meals != 1 else ''} added near your route" if meals
                   else "Meals already planned (or no restaurant data nearby)")  # fmt: skip
        await self._enrich(draft, retime=True)
        warn = sum(1 for d in days for x in d.get("insights", []) if x["level"] == "warn")
        drive = sum((d.get("route") or {}).get("drive_min", 0) for d in days)
        yield step("wellbeing", f"Routes timed ({drive} min driving in total) · {warn} heads-up"
                   f"{'s' if warn != 1 else ''} on traffic, heat, air or pace")  # fmt: skip
        if not known:
            weather_at = None  # a forecast was fetched but none of it covers these dates
        trip = self.db.put(
            "trips",
            {"request": req.model_dump(mode="json"), "prompt": prompt, "title": plan.title, "summary": plan.summary,
             "tips": plan.tips, "city": city, "destinations": destinations, "days": days, "version": 1, "history": [],
             "weather_updated_at": weather_at, **self.new_trip_fields(owner, req, country=city.get("country"), travellers=travellers)},
        )  # fmt: skip
        yield {"event": "done", "trip": trip}

    async def _locate(
        self,
        days: list[Day],
        near: tuple[float, float],
        city: str,
        by_day: dict[int, tuple[tuple[float, float], str]] | None = None,
    ) -> list[dict[str, Any]]:
        async def one(a: Activity, near: tuple[float, float], city: str) -> dict[str, Any]:
            hit = None
            if a.kind == "transit":  # "walk to X" legs: X has its own stop
                return {**a.model_dump(), "id": new_id(), "votes": {}, "lat": None, "lng": None, "label": None}
            if stops.placeless(a.name):  # "Breakfast at your stay", "Drive to…": part of the day, not a place
                return {**a.model_dump(), "id": new_id(), "votes": {}, "lat": None, "lng": None, "label": None,
                        "placeless": True}  # fmt: skip
            for query in stops.place_queries(a.name, a.place_query, city):
                try:
                    hit = await self.tools.geocode_place(query, near)
                except Exception:  # noqa: BLE001
                    logger.info("geocode failed for one stop")
                if hit is not None:
                    break
            return {**a.model_dump(), "id": new_id(), "votes": {}, **(hit or {"lat": None, "lng": None, "label": None})}

        out = []
        for d in days:
            where, name = (by_day or {}).get(d.day, (near, city))
            acts = await asyncio.gather(*(one(a, where, name) for a in d.activities))
            out.append({"day": d.day, "theme": d.theme, "activities": list(acts)})
        return out

    async def _full_plan(self, plan_prompt: str, days: int) -> Plan:
        """The planner's itinerary for every day. A long reply cut off by the output budget keeps its complete days;
        the missing days are then asked for on their own (smaller replies that fit), so long trips still plan."""
        plan = await ask_json(self.get_llm, PLAN_SYSTEM, plan_prompt, Plan, limit_s=120, task="tripweaver.plan")
        got = sorted({d.day for d in plan.days if 1 <= d.day <= days})
        for _ in range(3):
            missing = [n for n in range(1, days + 1) if n not in got]
            if not missing:
                break
            done = "; ".join(f"Day {d.day}: " + ", ".join(a.name for a in d.activities) for d in plan.days)
            more = await ask_json(
                self.get_llm,
                PLAN_SYSTEM,
                f"{plan_prompt}\n\nAlready planned (do not repeat these places): {done}\n"
                f"Now plan ONLY days {', '.join(map(str, missing))}, numbered as such, in the same JSON shape.",
                Plan,
                limit_s=120,
                task="tripweaver.plan",
            )
            new = [d for d in more.days if d.day in missing] or [
                d.model_copy(update={"day": n}) for n, d in zip(missing, more.days, strict=False)
            ]  # numbered from 1 again: take them in order
            plan = plan.model_copy(update={"days": sorted([*plan.days, *new], key=lambda d: d.day)})
            got = sorted({d.day for d in plan.days if 1 <= d.day <= days})
        by_day = {d.day: d for d in plan.days if 1 <= d.day <= days}
        if not by_day:
            # Day numbers outside the trip: keep the order the model gave.
            return plan.model_copy(
                update={"days": [d.model_copy(update={"day": i + 1}) for i, d in enumerate(plan.days[:days])]}
            )
        return plan.model_copy(update={"days": [by_day[n] for n in sorted(by_day)]})

    async def replan(self, trip: dict[str, Any], event: str, only_days: list[int] | None = None) -> dict[str, Any]:
        compact = [
            {"day": d["day"], "date": d.get("date"), "weather": d.get("weather"), "theme": d["theme"],
             "activities": [{k: a[k] for k in ("time", "name", "place_query", "kind", "duration_min", "note")} for a in d["activities"]]}
            for d in trip["days"]
        ]  # fmt: skip
        pinned = [f"day {d['day']}: {a['name']}" for d in trip["days"] for a in d["activities"] if a.get("pinned")]
        allowed = sorted(set(only_days or [])) or None
        prompt = (
            f"Trip: {trip['title']} in {trip['city']['name']}\nCurrent itinerary JSON:\n{compact}\n\n"
            + (f"ALLOWED DAYS: {allowed}\n" if allowed else "")
            + (f"PINNED (keep): {'; '.join(pinned)}\n" if pinned else "")
            + f"WHAT CHANGED: {event}"
        )
        result = await ask_json(self.get_llm, REPLAN_SYSTEM, prompt, Replan, limit_s=120, task="tripweaver.replan")
        city = trip["city"]
        existing = {d["day"] for d in trip["days"]}
        changed = [d for d in result.changed_days if d.day in existing and (allowed is None or d.day in allowed)]
        if not changed:
            raise HTTPException(422, "The re-plan didn't change any of the selected days. Try describing the change.")
        near = {d["day"]: ((dest := destination_of(trip, d))["lat"], dest["lng"]) for d in trip["days"]}
        names = {d["day"]: destination_of(trip, d)["name"] for d in trip["days"]}
        located = {
            d["day"]: d
            for d in await self._locate(
                changed, (city["lat"], city["lng"]), city["name"], {n: (near[n], names[n]) for n in near}
            )
        }
        for d in trip["days"]:  # pinned stops survive a re-plan even if the model dropped them
            if d["day"] in located:
                kept = {a["name"].strip().lower() for a in located[d["day"]]["activities"]}
                for a in d["activities"]:
                    if a.get("pinned") and a["name"].strip().lower() not in kept:
                        located[d["day"]]["activities"] = self._insert(located[d["day"]]["activities"], a)
        old_votes = {a["name"].strip().lower(): a.get("votes") or {} for d in trip["days"] for a in d["activities"]}
        for d in located.values():
            for a in d["activities"]:
                a.setdefault("votes", {})
                a["votes"] = dict(old_votes.get(a["name"].strip().lower(), a["votes"]))  # kept stops keep their votes
        days = []
        for d in trip["days"]:
            if d["day"] in located:
                new = located[d["day"]]
                days.append(
                    {**d, "theme": new["theme"] or d["theme"], "activities": new["activities"], "changed": True}
                )
            else:
                days.append({**d, "changed": False})
        await self._enrich({**trip, "days": days}, retime=True)
        history = [*trip.get("history", []), {"version": trip.get("version", 1), "event": event, "explanation": result.explanation,
                                              "days_changed": sorted(located), "at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds")}][-10:]  # fmt: skip
        updated = self.db.patch(
            "trips", trip["id"], {"days": days, "version": trip.get("version", 1) + 1, "history": history}
        )
        self.hub.publish(trip["id"], {"event": "trip", "trip": updated})
        return {"trip": updated, "explanation": result.explanation, "days_changed": sorted(located)}

    async def weather_check(self, trip: dict[str, Any]) -> dict[str, Any]:
        """Refresh each destination's forecast (plus current conditions and hourly rain where available)."""
        dests = trip.get("destinations") or [{**trip["city"], "id": None}]
        detail: dict[Any, dict[str, Any]] = {}
        for dest in dests:
            try:
                detail[dest["id"]] = await self.tools.forecast_detail(dest["lat"], dest["lng"], dest.get("timezone"))
            except (AttributeError, httpx.HTTPError, ValueError):
                detail[dest["id"]] = {"daily": await self.tools.forecast(dest["lat"], dest["lng"], dest.get("timezone")),
                                      "hourly": {}, "current": None}  # fmt: skip
        fetched = _now_iso()
        alerts, days = [], []
        for d in trip["days"]:
            dest = destination_of(trip, d)
            info = detail.get(dest.get("id")) or next(iter(detail.values()))
            w = info["daily"].get(d.get("date") or "", d.get("weather"))
            hourly = info["hourly"].get(d.get("date") or "")
            outdoor = [a["name"] for a in d["activities"] if a["kind"] == "outdoor"]
            if w and (w.get("rain") or 0) >= RAINY and outdoor:
                alerts.append({"day": d["day"], "rain": w["rain"], "outdoor": outdoor})
            extra = {"hourly_rain": hourly, "best_window": trip_logic.driest_window(hourly),
                     "rain_spells": trip_logic.rain_spells(hourly)} if hourly else {}  # fmt: skip
            days.append({**d, "weather": w, **extra})
        now = {str(k): {**v["current"], "fetched_at": fetched} for k, v in detail.items() if v.get("current")}
        enriched = {**trip, "days": days}
        await self._enrich(enriched)
        updated = self.db.patch("trips", trip["id"], {"days": days, "weather_updated_at": fetched, "weather_now": now})
        self.hub.publish(trip["id"], {"event": "trip", "trip": updated})
        return {"trip": updated, "alerts": alerts}

    # ── routes, wellbeing, nearby places and meals ────────────────────────
    async def _enrich(self, trip: dict[str, Any], *, retime: bool = False) -> None:
        """Fill each day's route (leg times, rush-hour flags), air quality and insights in place. Best effort.

        `retime` (fresh plans and re-plans only): if the model's times leave too little room for real travel, the day
        is re-timed in order (meals keep their slot) instead of showing clashes. Times set by hand are never moved.
        """
        req = trip.get("request") or {}
        aqi_by: dict[Any, dict[str, float]] = {}
        for dest in {destination_of(trip, d).get("id"): destination_of(trip, d) for d in trip["days"]}.values():
            try:
                aqi_by[dest.get("id")] = await self.tools.air_quality(dest["lat"], dest["lng"])
            except Exception:  # noqa: BLE001 - optional data
                logger.info("air quality unavailable")

        async def one(d: dict[str, Any]) -> None:
            aqi = aqi_by.get(destination_of(trip, d).get("id"), {})
            stops = travel.located(d["activities"])
            legs = None
            if len(stops) >= 2:
                try:
                    legs = await self.tools.route([(a["lat"], a["lng"]) for a in stops])
                except Exception:  # noqa: BLE001 - fall back to straight-line estimates
                    logger.info("routing unavailable")
            d["route"] = travel.build_route(d["activities"], legs)
            if retime and any(x["type"] == "overlap" for x in trip_logic.validate_day(d)):
                d["activities"] = travel.retime(d["activities"], d["route"])
                d["route"] = travel.build_route(d["activities"], legs)
                d["retimed"] = True
            if d.get("date") in aqi:
                d["weather"] = {**(d.get("weather") or {}), "aqi": aqi[d["date"]]}
            d["insights"] = travel.insights(d, req.get("travellers"), req.get("pace", "balanced"))
            for a in d["activities"]:
                a["labels"] = trip_logic.stop_labels(a, d)
            d["issues"] = trip_logic.validate_day(d)
            d["alerts"] = trip_logic.weather_alerts(d)

        await asyncio.gather(*(one(d) for d in trip["days"]))

    async def _places(self, lat: float, lng: float, group: str) -> list[dict[str, Any]]:
        try:
            return await self.tools.nearby(lat, lng, group)
        except Exception:  # noqa: BLE001
            logger.info("nearby search unavailable")
            return []

    async def _add_meals(self, trip: dict[str, Any]) -> int:
        """Slot lunch/dinner near where the travellers will be, when a day has none. Returns meals added."""
        prefer_veg = any(w in " ".join((trip.get("request") or {}).get("interests") or []).lower()
                         for w in ("vegetarian", "vegan", "veg"))  # fmt: skip
        added = 0
        for d in trip["days"]:
            for label, hhmm in travel.meal_gaps(d["activities"]):
                anchor = travel.anchor_for(d["activities"], hhmm)
                if anchor is None:
                    continue
                when = dt.datetime.combine(
                    dt.date.fromisoformat(d["date"]) if d.get("date") else dt.date.today(),
                    dt.time(*map(int, hhmm.split(":"))),
                )
                pick = travel.pick_meal(await self._places(anchor["lat"], anchor["lng"], "food"), when, prefer_veg)
                if pick is None:
                    continue
                note = " · ".join(filter(None, [f"{label.title()} near {anchor['name']}", pick.get("cuisine"),
                                                f"{pick['distance_m']} m away", "vegetarian-friendly" if pick.get("veg") else None]))  # fmt: skip
                d["activities"] = self._insert(d["activities"], {
                    "time": hhmm, "name": pick["name"], "place_query": pick["name"], "kind": "food",
                    "duration_min": 60 if label == "lunch" else 75, "note": note, "id": new_id(), "votes": {},
                    "lat": pick["lat"], "lng": pick["lng"], "label": pick["name"], "added": "meal",
                })  # fmt: skip
                added += 1
        return added

    @staticmethod
    def _insert(acts: list[dict[str, Any]], act: dict[str, Any]) -> list[dict[str, Any]]:
        out = [*acts, act]
        out.sort(key=lambda a: travel.to_min(a.get("time", "09:00")))
        return out

    def _save(self, trip: dict[str, Any], days: list[dict[str, Any]]) -> dict[str, Any]:
        updated = self.db.patch("trips", trip["id"], {"days": days, "version": trip.get("version", 1) + 1})
        self.hub.publish(trip["id"], {"event": "trip", "trip": updated})
        return updated  # type: ignore[return-value]

    def _day(self, trip: dict[str, Any], day: int) -> dict[str, Any]:
        for d in trip["days"]:
            if d["day"] == day:
                return d
        raise HTTPException(404, "Day not found.")

    async def optimise_day(self, trip: dict[str, Any], day: int) -> dict[str, Any]:
        """Reorder a day's sights for the least travel (meals keep their slots), then re-time and re-check it."""
        d = self._day(trip, day)
        movable = [a for a in d["activities"] if a.get("kind") != "food" and a.get("lat") is not None]
        before = (d.get("route") or {}).get("drive_min", 0) + (d.get("route") or {}).get("walk_min", 0)
        if len(movable) >= 3:
            order = await self.tools.best_order([(a["lat"], a["lng"]) for a in movable])
            d["activities"] = travel.reorder(d["activities"], order)
        await self._enrich({**trip, "days": [d]})
        d["activities"] = travel.retime(d["activities"], d["route"])
        await self._enrich({**trip, "days": [d]})
        after = d["route"].get("drive_min", 0) + d["route"].get("walk_min", 0)
        return {"trip": self._save(trip, trip["days"]), "travel_before": before, "travel_after": after}

    async def nearby(
        self, trip: dict[str, Any], activity_id: str, group: str, cuisine: str | None, veg: bool, open_now: bool
    ) -> dict[str, Any]:
        for d in trip["days"]:
            for a in d["activities"]:
                if a["id"] == activity_id:
                    if a.get("lat") is None:
                        raise HTTPException(422, "This stop isn't on the map, so there's nothing to search around.")
                    places = await self._places(a["lat"], a["lng"], group)
                    when = None
                    if open_now and d.get("date"):
                        end = travel.to_min(a.get("time", "09:00")) + int(a.get("duration_min", 60))
                        when = dt.datetime.combine(
                            dt.date.fromisoformat(d["date"]), dt.time(*divmod(min(end, 1435), 60))
                        )
                    # "Breakfast at Pastelaria Versailles" already covers the café "Pastelaria Versailles".
                    planned = " | ".join(
                        f"{x['name']} {x.get('label') or ''}".lower() for day in trip["days"] for x in day["activities"]
                    )
                    out = [{**p, "planned": p["name"].lower() in planned}
                           for p in travel.filter_places(places, cuisine=cuisine, veg=veg, open_at=when)]  # fmt: skip
                    return {"day": d["day"], "around": a["name"], "places": out[:25]}
        raise HTTPException(404, "Activity not found.")

    async def add_stop(self, trip: dict[str, Any], day: int, stop: dict[str, Any]) -> dict[str, Any]:
        d = self._day(trip, day)
        d["activities"] = self._insert(d["activities"], {"added": "nearby", **stop, "id": new_id(), "votes": {},
                                                          "label": stop["name"], "place_query": stop["name"]})  # fmt: skip
        await self._enrich({**trip, "days": [d]})
        return self._save(trip, trip["days"])

    async def add_meals(self, trip: dict[str, Any]) -> dict[str, Any]:
        added = await self._add_meals(trip)
        await self._enrich(trip)
        return {"trip": self._save(trip, trip["days"]), "added": added}

    def vote(self, trip: dict[str, Any], activity_id: str, voter: str, value: int) -> dict[str, Any]:
        days = trip["days"]
        for d in days:
            for a in d["activities"]:
                if a["id"] == activity_id:
                    votes = dict(a.get("votes") or {})
                    if value == 0:
                        votes.pop(voter, None)
                    else:
                        votes[voter] = value
                    a["votes"] = votes
                    a["labels"] = trip_logic.stop_labels(a, d)
                    updated = self.db.patch("trips", trip["id"], {"days": days})
                    self.hub.publish(trip["id"], {"event": "vote", "activity_id": activity_id, "votes": votes})
                    return updated  # type: ignore[return-value]
        raise HTTPException(404, "Activity not found.")
