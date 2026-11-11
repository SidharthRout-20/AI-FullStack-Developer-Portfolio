"""TripWeaver: an agent that plans trips with real tools and re-plans when things change.

Tools (all free, no API keys):
  * geocoding: Open-Meteo geocoding (cities) and Photon / OpenStreetMap (places, biased to the destination)
  * weather:   Open-Meteo daily forecast (≈16 days ahead) with UV and feels-like temperature, plus air quality
  * routing:   OSRM (leg times, best visiting order); rush-hour advice uses typical traffic patterns
  * nearby:    Overpass / OpenStreetMap attractions and food (cuisine, vegetarian, opening hours)
The agent: understand the request → geocode destination → fetch the forecast → LLM drafts a day-by-day plan that
must respect the weather → every activity is geocoded onto the map. Re-planning rewrites only the affected days.
Group mode: votes are shared live to every open browser through Server-Sent Events.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import time
from collections import defaultdict
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Annotated, Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.ai import Lenient, ask_json, llm_failure, sse
from app.core.docstore import DocStore, new_id
from app.core.security import limiter, rate_limit_value
from app.products import travel
from app.rag.guardrails import normalize

logger = logging.getLogger(__name__)
UA = {"User-Agent": "TripWeaver-portfolio/1.0"}
RAINY = 60  # % precipitation probability that counts as a wet day
# One server, short timeout: when it is at capacity the Nominatim fallback answers in ~2 s instead of waiting
# on mirrors that are usually just as busy.
OVERPASS = ("https://overpass-api.de/api/interpreter",)


class TripRequest(Lenient):
    destination: str = Field(max_length=120)
    country: str | None = Field(None, max_length=60)
    start_date: dt.date | None = None
    days: int = Field(3, ge=1, le=10)
    interests: list[str] = Field(default_factory=list, max_length=10)
    pace: Literal["relaxed", "balanced", "packed"] = "balanced"
    travellers: str | None = Field(None, max_length=80)

    @field_validator("pace", mode="before")
    @classmethod
    def _pace(cls, v: Any) -> Any:
        return v if v in ("relaxed", "balanced", "packed") else "balanced"

    @field_validator("start_date", mode="before")
    @classmethod
    def _date(cls, v: Any) -> Any:
        return None if v in ("", "null") else v


class Activity(Lenient):
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

    @field_validator("duration_min", mode="before")
    @classmethod
    def _dur(cls, v: Any) -> Any:
        try:
            return max(10, min(600, int(v)))
        except (TypeError, ValueError):
            return 90


class Day(Lenient):
    day: int
    theme: str = Field("", max_length=120)
    activities: list[Activity] = Field(min_length=1, max_length=8)


class Plan(Lenient):
    title: str = Field(max_length=120)
    summary: str = Field(max_length=800)
    days: list[Day] = Field(min_length=1, max_length=10)
    tips: list[str] = Field(default_factory=list, max_length=6)


class Replan(Lenient):
    changed_days: list[Day] = Field(min_length=1, max_length=10)
    explanation: str = Field(max_length=600)


UNDERSTAND_SYSTEM = """Extract a trip request as JSON: {"destination": str (city/region), "country": str|null,
"start_date": "YYYY-MM-DD"|null (resolve relative dates from today), "days": int (1-10, default 3),
"interests": [str], "pace": "relaxed"|"balanced"|"packed", "travellers": str|null}. Today is {today}."""

PLAN_SYSTEM = """You are an expert local travel planner. Plan a realistic day-by-day itinerary using REAL, existing,
well-known places in the destination (exact names that a map search will find). Group nearby places on the same day,
include meals, and respect opening-hours common sense. When a day's rain probability is >= 60%, prefer indoor
activities that day. Reply with ONE JSON object:
{"title": str, "summary": str, "tips": [str],
 "days": [{"day": 1, "theme": str, "activities": [{"time": "HH:MM", "name": str, "place_query": str
   (place name + city, for map search), "kind": "outdoor"|"indoor"|"food"|"transit", "duration_min": int, "note": str}]}]}"""

REPLAN_SYSTEM = """You revise an existing itinerary after something changed. Change ONLY the days that must change,
keep good parts, keep real place names (with place_query for map search). Reply with ONE JSON object:
{"explanation": str (what you changed and why, 1-3 sentences),
 "changed_days": [{"day": int, "theme": str, "activities": [ ...same activity shape... ]}]}"""


# ── Tools ────────────────────────────────────────────────────────────────
def _near(hit: dict[str, Any], near: tuple[float, float]) -> dict[str, Any] | None:
    """Reject matches > ~100 km from the destination (same-name places elsewhere)."""
    return hit if abs(hit["lat"] - near[0]) <= 1.0 and abs(hit["lng"] - near[1]) <= 1.0 else None


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
        """Photon first (fast, typo-tolerant); if it's unreachable, OpenStreetMap Nominatim (rate-limited)."""
        key = (query.lower(), round(near[0], 2), round(near[1], 2))
        if key in self._cache:
            return self._cache[key]
        hit: dict[str, Any] | None = None
        if time.monotonic() >= self._photon_down_until:
            try:
                hit = await self._photon(query, near)
            except httpx.TransportError:
                logger.info("Photon unreachable; using Nominatim for 10 minutes")
                self._photon_down_until = time.monotonic() + 600
        if hit is None:
            hit = await self._nominatim(query, near)
        self._cache[key] = hit
        return hit

    async def _photon(self, query: str, near: tuple[float, float]) -> dict[str, Any] | None:
        async with self._sem:
            r = await self.client.get(
                "https://photon.komoot.io/api/",
                params={"q": query, "lat": near[0], "lon": near[1], "limit": 1, "lang": "en"},
                timeout=httpx.Timeout(8, connect=4),
            )
        feats = r.json().get("features") or []
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
                rows = r.json() if r.status_code == 200 else []
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
        for tags, plat, plng in raw:
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

    async def _overpass(self, query: str) -> list[tuple[dict[str, str], float | None, float | None]]:
        if time.monotonic() < self._overpass_down_until:
            raise httpx.HTTPError("Overpass recently unavailable")
        for server in OVERPASS:  # public servers are often at capacity: fall through to the next mirror
            try:
                async with self._sem:
                    r = await self.client.post(server, data={"data": query}, timeout=httpx.Timeout(7, connect=4))
                if r.status_code == 200:
                    return [
                        (el.get("tags") or {}, el.get("lat") or (el.get("center") or {}).get("lat"),
                         el.get("lon") or (el.get("center") or {}).get("lon"))
                        for el in r.json().get("elements", [])
                    ]  # fmt: skip
            except (httpx.HTTPError, ValueError):
                continue
        self._overpass_down_until = time.monotonic() + 600  # skip it for 10 minutes; use the fallback meanwhile
        logger.info("Overpass unavailable; using Nominatim for nearby places for 10 minutes")
        raise httpx.HTTPError("All Overpass servers are busy")

    async def _nominatim_area(
        self, lat: float, lng: float, group: str, radius: int
    ) -> list[tuple[dict[str, str], float | None, float | None]]:
        """OpenStreetMap search inside a box around the point (1 request/second, per the usage policy)."""
        d = radius / 111_000
        box = f"{lng - d * 1.3},{lat + d},{lng + d * 1.3},{lat - d}"
        words = ["restaurant", "cafe"] if group == "food" else ["museum", "attraction", "viewpoint", "park"]
        out: list[tuple[dict[str, str], float | None, float | None]] = []
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
                tags = {k: str(v) for k, v in (row.get("extratags") or {}).items()}
                tags.setdefault(row.get("category", ""), row.get("type", "yes"))
                tags["name"] = row.get("name") or row.get("display_name", "").split(",")[0]
                out.append((tags, float(row["lat"]), float(row["lon"])))
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


def day_dates(start: dt.date | None, n: int) -> list[str | None]:
    return [(start + dt.timedelta(days=i)).isoformat() if start else None for i in range(n)]


class TripService:
    def __init__(self, store: DocStore, get_llm: Callable[[], Any], tools: Tools | None = None) -> None:
        self.db = store
        self.get_llm = get_llm
        self.tools = tools or Tools()
        self.hub = Hub()

    async def plan(self, prompt: str, today: dt.date) -> AsyncIterator[dict[str, Any]]:
        def step(name: str, detail: str) -> dict[str, Any]:
            return {"event": "step", "step": name, "detail": detail}

        req = await ask_json(self.get_llm, UNDERSTAND_SYSTEM.replace("{today}", today.isoformat()), prompt, TripRequest)
        if req.start_date and req.start_date < today:
            req = req.model_copy(update={"start_date": today})
        yield step(
            "understand",
            f"{req.days} days in {req.destination} · {req.pace}"
            + (f" · from {req.start_date}" if req.start_date else ""),
        )

        city = await self.tools.geocode_city(req.destination, req.country)
        if city is None:
            raise HTTPException(422, f"Couldn't find “{req.destination}” on the map.")
        yield step("geocode", f"{city['name']}, {city.get('country') or ''} ({city['lat']:.3f}, {city['lng']:.3f})")

        weather: dict[str, dict[str, Any]] = {}
        try:
            weather = await self.tools.forecast(city["lat"], city["lng"], city.get("timezone"))
        except Exception:  # noqa: BLE001 - plan without weather rather than fail
            logger.info("forecast unavailable")
        dates = day_dates(req.start_date, req.days)
        wx = [weather.get(d) if d else None for d in dates]
        known = [
            f"Day {i + 1} ({d}): rain {w['rain']}%, {w['tmin']}–{w['tmax']}°C"
            for i, (d, w) in enumerate(zip(dates, wx, strict=True))
            if w
        ]
        yield step(
            "weather",
            "; ".join(known[:4]) + ("…" if len(known) > 4 else "")
            if known
            else "No forecast for these dates (too far ahead or no date given)",
        )

        plan_prompt = (
            f"Destination: {city['name']}, {city.get('country')}\nDays: {req.days}\nStart: {req.start_date or 'flexible'}\n"
            f"Interests: {', '.join(req.interests) or 'general sightseeing'}\nPace: {req.pace}\nTravellers: {req.travellers or 'n/a'}\n"
            f"Weather: {'; '.join(known) or 'unknown'}\n\nOriginal request: {prompt}"
        )
        plan = await ask_json(self.get_llm, PLAN_SYSTEM, plan_prompt, Plan, limit_s=120)
        yield step("plan", f"{sum(len(d.activities) for d in plan.days)} activities across {len(plan.days)} days")

        days = await self._locate(plan.days, (city["lat"], city["lng"]), city["name"])
        found = sum(1 for d in days for a in d["activities"] if a.get("lat") is not None)
        total = sum(len(d["activities"]) for d in days)
        yield step("map", f"{found}/{total} places located on the map")

        for i, d in enumerate(days):
            d["date"] = dates[i] if i < len(dates) else None
            d["weather"] = wx[i] if i < len(wx) else None
        draft = {"request": req.model_dump(mode="json"), "city": city, "days": days}
        meals = await self._add_meals(draft)
        yield step("meals", f"{meals} meal stop{'s' if meals != 1 else ''} added near your route" if meals
                   else "Meals already planned (or no restaurant data nearby)")  # fmt: skip
        await self._enrich(draft)
        warn = sum(1 for d in days for x in d.get("insights", []) if x["level"] == "warn")
        drive = sum((d.get("route") or {}).get("drive_min", 0) for d in days)
        yield step("wellbeing", f"Routes timed ({drive} min driving in total) · {warn} heads-up"
                   f"{'s' if warn != 1 else ''} on traffic, heat, air or pace")  # fmt: skip
        trip = self.db.put(
            "trips",
            {"request": req.model_dump(mode="json"), "prompt": prompt, "title": plan.title, "summary": plan.summary,
             "tips": plan.tips, "city": city, "days": days, "version": 1, "history": []},
        )  # fmt: skip
        yield {"event": "done", "trip": trip}

    async def _locate(self, days: list[Day], near: tuple[float, float], city: str) -> list[dict[str, Any]]:
        async def one(a: Activity) -> dict[str, Any]:
            hit = None
            if a.kind == "transit":  # "walk to X" legs: X has its own stop
                return {**a.model_dump(), "id": new_id(), "votes": {}, "lat": None, "lng": None, "label": None}
            try:
                hit = await self.tools.geocode_place(a.place_query or f"{a.name}, {city}", near)
                if hit is None and a.place_query:
                    hit = await self.tools.geocode_place(f"{a.name}, {city}", near)
            except Exception:  # noqa: BLE001
                logger.info("geocode failed for %s", a.name)
            return {**a.model_dump(), "id": new_id(), "votes": {}, **(hit or {"lat": None, "lng": None, "label": None})}

        out = []
        for d in days:
            acts = await asyncio.gather(*(one(a) for a in d.activities))
            out.append({"day": d.day, "theme": d.theme, "activities": list(acts)})
        return out

    async def replan(self, trip: dict[str, Any], event: str) -> dict[str, Any]:
        compact = [
            {"day": d["day"], "date": d.get("date"), "weather": d.get("weather"), "theme": d["theme"],
             "activities": [{k: a[k] for k in ("time", "name", "place_query", "kind", "duration_min", "note")} for a in d["activities"]]}
            for d in trip["days"]
        ]  # fmt: skip
        prompt = f"Trip: {trip['title']} in {trip['city']['name']}\nCurrent itinerary JSON:\n{compact}\n\nWHAT CHANGED: {event}"
        result = await ask_json(self.get_llm, REPLAN_SYSTEM, prompt, Replan, limit_s=120)
        city = trip["city"]
        located = {
            d["day"]: d for d in await self._locate(result.changed_days, (city["lat"], city["lng"]), city["name"])
        }
        old_votes = {a["name"].strip().lower(): a.get("votes") or {} for d in trip["days"] for a in d["activities"]}
        for d in located.values():
            for a in d["activities"]:
                a["votes"] = dict(old_votes.get(a["name"].strip().lower(), {}))  # kept activities keep their votes
        days = []
        for d in trip["days"]:
            if d["day"] in located:
                new = located[d["day"]]
                days.append(
                    {**d, "theme": new["theme"] or d["theme"], "activities": new["activities"], "changed": True}
                )
            else:
                days.append({**d, "changed": False})
        await self._enrich({**trip, "days": days})
        history = [*trip.get("history", []), {"version": trip.get("version", 1), "event": event, "explanation": result.explanation,
                                              "days_changed": sorted(located), "at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds")}][-10:]  # fmt: skip
        updated = self.db.patch(
            "trips", trip["id"], {"days": days, "version": trip.get("version", 1) + 1, "history": history}
        )
        self.hub.publish(trip["id"], {"event": "trip", "trip": updated})
        return {"trip": updated, "explanation": result.explanation, "days_changed": sorted(located)}

    async def weather_check(self, trip: dict[str, Any]) -> dict[str, Any]:
        city = trip["city"]
        weather = await self.tools.forecast(city["lat"], city["lng"], city.get("timezone"))
        alerts = []
        days = []
        for d in trip["days"]:
            w = weather.get(d.get("date") or "", d.get("weather"))
            outdoor = [a["name"] for a in d["activities"] if a["kind"] == "outdoor"]
            if w and (w.get("rain") or 0) >= RAINY and outdoor:
                alerts.append({"day": d["day"], "rain": w["rain"], "outdoor": outdoor})
            days.append({**d, "weather": w})
        updated = self.db.patch("trips", trip["id"], {"days": days})
        self.hub.publish(trip["id"], {"event": "trip", "trip": updated})
        return {"trip": updated, "alerts": alerts}

    # ── routes, wellbeing, nearby places and meals ────────────────────────
    async def _enrich(self, trip: dict[str, Any]) -> None:
        """Fill each day's route (leg times, rush-hour flags), air quality and insights in place. Best effort."""
        city = trip["city"]
        req = trip.get("request") or {}
        aqi: dict[str, float] = {}
        try:
            aqi = await self.tools.air_quality(city["lat"], city["lng"])
        except Exception:  # noqa: BLE001 - optional data
            logger.info("air quality unavailable")

        async def one(d: dict[str, Any]) -> None:
            stops = travel.located(d["activities"])
            legs = None
            if len(stops) >= 2:
                try:
                    legs = await self.tools.route([(a["lat"], a["lng"]) for a in stops])
                except Exception:  # noqa: BLE001 - fall back to straight-line estimates
                    logger.info("routing unavailable")
            d["route"] = travel.build_route(d["activities"], legs)
            if d.get("date") in aqi:
                d["weather"] = {**(d.get("weather") or {}), "aqi": aqi[d["date"]]}
            d["insights"] = travel.insights(d, req.get("travellers"), req.get("pace", "balanced"))

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
        d["activities"] = self._insert(d["activities"], {**stop, "id": new_id(), "votes": {}, "label": stop["name"],
                                                          "place_query": stop["name"], "added": "nearby"})  # fmt: skip
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
                    updated = self.db.patch("trips", trip["id"], {"days": days})
                    self.hub.publish(trip["id"], {"event": "vote", "activity_id": activity_id, "votes": votes})
                    return updated  # type: ignore[return-value]
        raise HTTPException(404, "Activity not found.")


# ── API ───────────────────────────────────────────────────────────────────
def get_trips(request: Request) -> TripService:
    return request.app.state.suite.trips


Trips = Annotated[TripService, Depends(get_trips)]
router = APIRouter(prefix="/api/trips", tags=["tripweaver"])


class PlanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str = Field(min_length=10, max_length=1000)


class ReplanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event: str = Field(min_length=5, max_length=500)


class StopIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    kind: Literal["outdoor", "indoor", "food"] = "outdoor"
    time: str = Field("12:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    duration_min: int = Field(60, ge=10, le=600)
    note: str = Field("", max_length=300)


class VoteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    activity_id: str = Field(max_length=40)
    voter: str = Field(min_length=1, max_length=40)
    value: Literal[-1, 0, 1]


def _trip(svc: TripService, trip_id: str) -> dict[str, Any]:
    doc = svc.db.get("trips", trip_id[:40])
    if doc is None:
        raise HTTPException(404, "Trip not found.")
    return doc


def _stream(gen: Callable[[], AsyncIterator[dict[str, Any]]]) -> StreamingResponse:
    async def events() -> AsyncIterator[str]:
        try:
            async for ev in gen():
                yield sse(ev.pop("event"), ev)
        except HTTPException as exc:
            yield sse("error", {"message": exc.detail})
        except httpx.HTTPError:
            yield sse("error", {"message": "A map/weather service didn't respond. Please try again."})
        except Exception as exc:  # noqa: BLE001
            yield sse("error", {"message": llm_failure(exc)})

    return StreamingResponse(
        events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


async def _guard(coro: Awaitable[Any]) -> Any:
    try:
        return await coro
    except HTTPException:
        raise
    except httpx.HTTPError:
        raise HTTPException(502, "A map/weather service didn't respond. Please try again.") from None
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, llm_failure(exc)) from None


@router.post("/plan")
@limiter.limit("6/minute")
async def plan(request: Request, body: PlanIn, svc: Trips) -> StreamingResponse:
    today = dt.date.today()
    return _stream(lambda: svc.plan(normalize(body.prompt), today))


@router.get("")
def list_trips(svc: Trips) -> list[dict[str, Any]]:
    return [
        {k: t.get(k) for k in ("id", "title", "summary", "city", "request", "version", "updated_at")}
        for t in svc.db.list("trips", limit=50)
    ]


@router.get("/{trip_id}")
def get_trip(trip_id: str, svc: Trips) -> dict[str, Any]:
    return _trip(svc, trip_id)


@router.delete("/{trip_id}", status_code=204)
def delete_trip(trip_id: str, svc: Trips) -> None:
    _trip(svc, trip_id)
    svc.db.delete("trips", trip_id[:40])


@router.post("/{trip_id}/replan")
@limiter.limit(rate_limit_value)
async def replan(request: Request, trip_id: str, body: ReplanIn, svc: Trips) -> dict[str, Any]:
    return await _guard(svc.replan(_trip(svc, trip_id), normalize(body.event)))


@router.post("/{trip_id}/weather-check")
@limiter.limit(rate_limit_value)
async def weather_check(request: Request, trip_id: str, svc: Trips) -> dict[str, Any]:
    return await _guard(svc.weather_check(_trip(svc, trip_id)))


@router.post("/{trip_id}/votes")
@limiter.limit("60/minute")
def vote(request: Request, trip_id: str, body: VoteIn, svc: Trips) -> dict[str, Any]:
    return svc.vote(_trip(svc, trip_id), body.activity_id, body.voter.strip(), body.value)


@router.get("/{trip_id}/live")
async def live(trip_id: str, svc: Trips) -> StreamingResponse:
    _trip(svc, trip_id)

    async def events() -> AsyncIterator[str]:
        async for ev in svc.hub.subscribe(trip_id[:40], lambda: svc.db.get("trips", trip_id[:40])):
            yield sse(ev.pop("event"), ev)

    return StreamingResponse(
        events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@router.post("/{trip_id}/days/{day}/optimise")
@limiter.limit(rate_limit_value)
async def optimise_day(request: Request, trip_id: str, day: int, svc: Trips) -> dict[str, Any]:
    return await _guard(svc.optimise_day(_trip(svc, trip_id), day))


@router.get("/{trip_id}/nearby")
@limiter.limit("30/minute")
async def nearby(
    request: Request,
    trip_id: str,
    activity_id: str,
    svc: Trips,
    group: Literal["food", "sights"] = "food",
    cuisine: str | None = None,
    veg: bool = False,
    open_now: bool = False,
) -> dict[str, Any]:
    return await _guard(
        svc.nearby(_trip(svc, trip_id), activity_id[:40], group, (cuisine or "")[:40] or None, veg, open_now)
    )


@router.post("/{trip_id}/days/{day}/stops")
@limiter.limit(rate_limit_value)
async def add_stop(request: Request, trip_id: str, day: int, body: StopIn, svc: Trips) -> dict[str, Any]:
    return await _guard(svc.add_stop(_trip(svc, trip_id), day, body.model_dump()))


@router.post("/{trip_id}/meals")
@limiter.limit(rate_limit_value)
async def add_meals(request: Request, trip_id: str, svc: Trips) -> dict[str, Any]:
    return await _guard(svc.add_meals(_trip(svc, trip_id)))
