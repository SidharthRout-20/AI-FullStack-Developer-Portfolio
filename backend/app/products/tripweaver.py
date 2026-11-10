"""TripWeaver: an agent that plans trips with real tools and re-plans when things change.

Tools (all free, no API keys):
  * geocoding: Open-Meteo geocoding (cities) and Photon / OpenStreetMap (places, biased to the destination)
  * weather:   Open-Meteo daily forecast (≈16 days ahead), precipitation probability drives indoor/outdoor swaps
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
from app.rag.guardrails import normalize

logger = logging.getLogger(__name__)
UA = {"User-Agent": "TripWeaver-portfolio/1.0"}
RAINY = 60  # % precipitation probability that counts as a wet day


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
                    "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"},
        )  # fmt: skip
        d = r.json().get("daily") or {}
        return {
            day: {"code": code, "tmax": tmax, "tmin": tmin, "rain": rain}
            for day, code, tmax, tmin, rain in zip(
                d.get("time", []), d.get("weather_code", []), d.get("temperature_2m_max", []),
                d.get("temperature_2m_min", []), d.get("precipitation_probability_max", []), strict=False,
            )
        }  # fmt: skip


# ── Live updates for group mode ──────────────────────────────────────────
class Hub:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue[dict[str, Any]]]] = defaultdict(set)

    def publish(self, trip_id: str, event: dict[str, Any]) -> None:
        for q in list(self._subs.get(trip_id, ())):
            q.put_nowait(event)

    async def subscribe(self, trip_id: str) -> AsyncIterator[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
        self._subs[trip_id].add(q)
        try:
            while True:
                try:
                    yield await asyncio.wait_for(q.get(), 20)
                except TimeoutError:
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
        async for ev in svc.hub.subscribe(trip_id[:40]):
            yield sse(ev.pop("event"), ev)

    return StreamingResponse(
        events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )
