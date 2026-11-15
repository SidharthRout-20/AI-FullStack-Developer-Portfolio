"""TripWeaver's travel ecosystem around the itinerary (mixed into `TripService`).

Records live in the TripWeaver document store (SQLite locally, the shared Neon Postgres schema in production):
the trip document holds destinations, days, budget, checklists and companion history; saved places, bookings,
expenses and travel documents are child documents with `parent = trip id`, so deleting a trip removes them too.
No new tables or migrations. Ownership is enforced by the API layer (`trip_api.py`) before any method here runs.

Provider data is labelled with its source and fetch time; model output is labelled AI-generated; nothing is ever
ordered, booked or paid by TripWeaver: external actions are hand-off links to the provider's own site.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import secrets
from typing import TYPE_CHECKING, Any, Literal

import httpx
from fastapi import HTTPException
from pydantic import Field

from app.core.ai import Lenient, ask_json, clip
from app.core.docstore import new_id, now_iso
from app.products import travel, trip_logic
from app.products.trip_logic import destination_of

if TYPE_CHECKING:
    from app.core.docstore import DocStore

logger = logging.getLogger(__name__)
OWNER_ONLY = ("share_key", "companion", "checklists", "owner")
MAX_FILE_BYTES = 1_000_000  # travel documents: small PDFs / photos, stored in the existing database (no paid storage)
MAX_CHILDREN = 300  # per collection per trip


# ── model output schemas (validated, AI-labelled by the caller) ─────────────
class Speciality(Lenient):
    name: str = Field(max_length=80)
    kind: Literal["craft", "food", "clothing", "art", "other"] = "other"
    why: str = Field("", max_length=240)
    search_terms: list[str] = Field(default_factory=list, max_length=5)


class Specialities(Lenient):
    items: list[Speciality] = Field(default_factory=list, max_length=8)


class Suggestion(Lenient):
    action: str = Field(max_length=20)
    place_ref: str | None = Field(None, max_length=8)
    activity_id: str | None = Field(None, max_length=40)
    day: int | None = None
    time: str | None = Field(None, max_length=5)
    why: str = Field("", max_length=300)


class CompanionReply(Lenient):
    reply: str = Field(max_length=1500)
    suggestions: list[Suggestion] = Field(default_factory=list, max_length=6)


class Idea(Lenient):
    destination: str = Field(max_length=80)
    why: str = Field(max_length=300)


class Ideas(Lenient):
    ideas: list[Idea] = Field(default_factory=list, max_length=5)


class ReceiptDraft(Lenient):
    merchant: str | None = Field(None, max_length=120)
    amount: float | None = None
    currency: str | None = Field(None, max_length=3)
    date: str | None = Field(None, max_length=10)
    category: Literal["lodging", "food", "transport", "activities", "shopping", "other"] = "other"


SPECIALITIES_SYSTEM = """You know what is genuinely distinctive to buy in a destination: crafts, regional products,
traditional clothing, local food products. List only things truly associated with this specific place (no generic
souvenirs). Never state prices, shops, stock or availability. Reply with JSON:
{"items": [{"name": str, "kind": "craft"|"food"|"clothing"|"art"|"other", "why": str (1 sentence),
"search_terms": [short words a shop name or category might contain]}]}"""

COMPANION_SYSTEM = """You are TripWeaver's travel companion. You help a traveller during their trip using ONLY the
context given: their itinerary, time, weather (with its fetch time), budget, bookings and the CANDIDATE PLACES list
(real places from OpenStreetMap, each with a ref like "P3"). Rules:
- Never invent places, ratings, prices, opening hours, availability or bookings. Recommend places only by their ref.
- Weather facts come only from the context; say how old the forecast is if it is older than 6 hours.
- You never book, order, pay or message anyone. You may suggest actions; the traveller confirms them.
- Keep the reply practical and short (<= 120 words), specific to this trip.
Actions you may suggest: "add_stop" (place_ref, day, time HH:MM), "save_place" (place_ref),
"move_earlier" (activity_id, time HH:MM earlier than now planned), "open_link" (place_ref; booking/menu site).
Use place names (not refs) in the reply text. Reply with ONE JSON object: {"reply": str, "suggestions": [{"action": str, "place_ref": str|null,
"activity_id": str|null, "day": int|null, "time": "HH:MM"|null, "why": str}]}"""

IDEAS_SYSTEM = """Suggest future trips for a traveller based on what they enjoyed on a past trip. Suggest real
destinations; no prices or dates. Reply with JSON: {"ideas": [{"destination": str, "why": str (1 sentence)}]}"""

RECEIPT_PROMPT = """Read this receipt photo. Reply with ONE JSON object only:
{"merchant": str|null, "amount": number|null (the total paid), "currency": "ISO 4217 code"|null,
"date": "YYYY-MM-DD"|null, "category": "lodging"|"food"|"transport"|"activities"|"shopping"|"other"}
Use null for anything not clearly visible. Never guess an amount."""


def _ts() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds")


class TripEcosystem:
    """Mixin: expects `db`, `tools`, `get_llm`, `hub`, `_enrich`, `_insert`, `_day`, `_locate` from TripService."""

    db: DocStore
    tools: Any
    get_llm: Any
    hub: Any

    # ── trip records & access helpers ────────────────────────────────────────
    @staticmethod
    def new_trip_fields(owner: str | None, req: Any = None) -> dict[str, Any]:
        party = getattr(req, "party", None) if req is not None else None
        return {
            "owner": owner, "share_key": secrets.token_urlsafe(18), "status": "planning",
            "party": {"type": party, "travellers": None}, "budget": {"total": None, "currency": "EUR", "categories": {}},
            "checklists": [], "companion": [], "weather_now": {},
        }  # fmt: skip

    @staticmethod
    def view(trip: dict[str, Any], role: str) -> dict[str, Any]:
        """What a role may see: owners everything (but never the owner hash), members/legacy viewers the plan."""
        out = {k: v for k, v in trip.items() if k != "owner"}
        if role != "owner":
            for k in OWNER_ONLY:
                out.pop(k, None)
        out["role"] = role
        out["phase"] = trip_logic.phase(trip, dt.date.today())
        if "destinations" not in out and trip.get("city"):
            out["destinations"] = [{**trip["city"], "id": None, "start_day": 1, "end_day": len(trip.get("days", []))}]
        return out

    def my_trips(self, owner: str) -> list[dict[str, Any]]:
        today = dt.date.today()
        out = []
        for t in self.db.list("trips", limit=500):
            if t.get("owner") != owner:
                continue
            start, end = trip_logic.trip_dates(t)
            out.append({
                **{k: t.get(k) for k in ("id", "title", "summary", "city", "request", "version", "updated_at", "status")},
                "destinations": [d["name"] for d in t.get("destinations") or [t["city"]]],
                "start": start.isoformat() if start else None, "end": end.isoformat() if end else None,
                "days": len(t.get("days", [])), "phase": trip_logic.phase(t, today),
            })  # fmt: skip
        return out

    def _save_trip(self, trip: dict[str, Any], changes: dict[str, Any], bump: bool = True) -> dict[str, Any]:
        if bump:
            changes = {**changes, "version": trip.get("version", 1) + 1}
        updated = self.db.patch("trips", trip["id"], changes)
        self.hub.publish(trip["id"], {"event": "trip", "trip": updated})
        return updated  # type: ignore[return-value]

    async def _geocode_destinations(self, items: list[dict[str, Any]], first_day: int = 1) -> list[dict[str, Any]]:
        out = []
        for it in items:
            place = await self.tools.geocode_city(it["name"], it.get("country"))
            if place is None:
                raise HTTPException(422, f"Couldn't find “{it['name']}” on the map.")
            n = int(it.get("days", 1))
            out.append({**place, "id": new_id(), "start_day": first_day, "end_day": first_day + n - 1})
            first_day += n
        return out

    async def _forecasts(self, dests: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], str | None]:
        out: dict[str, dict[str, Any]] = {}
        for d in dests:
            try:
                out[d["id"]] = await self.tools.forecast(d["lat"], d["lng"], d.get("timezone"))
            except Exception:  # noqa: BLE001 - trips work without weather
                logger.info("forecast unavailable for %s", d["name"])
        return out, (_ts() if any(out.values()) else None)

    async def create_manual(self, owner: str, body: dict[str, Any]) -> dict[str, Any]:
        """A trip the traveller builds themselves: destinations and dates now, stops later (or via the planner)."""
        dests = await self._geocode_destinations(body["destinations"])
        start: dt.date | None = body.get("start_date")
        total = dests[-1]["end_day"]
        dates = [(start + dt.timedelta(days=i)).isoformat() if start else None for i in range(total)]
        forecasts, fetched = await self._forecasts(dests)
        days = []
        for i in range(total):
            dest = next(d for d in dests if d["start_day"] <= i + 1 <= d["end_day"])
            days.append({"day": i + 1, "theme": f"{dest['name']}", "date": dates[i], "destination": dest["id"],
                         "weather": (forecasts.get(dest["id"]) or {}).get(dates[i] or ""), "activities": []})  # fmt: skip
        request = {
            "destination": dests[0]["name"], "country": dests[0].get("country"),
            "start_date": start.isoformat() if start else None, "days": total, "interests": body.get("interests", []),
            "pace": body.get("pace", "balanced"), "travellers": body.get("travellers_note"), "party": body.get("party"),
        }  # fmt: skip
        trip = {
            "request": request, "prompt": None, "title": body.get("title") or " → ".join(d["name"] for d in dests),
            "summary": body.get("notes") or "", "tips": [], "city": dests[0], "destinations": dests, "days": days,
            "version": 1, "history": [], "weather_updated_at": fetched, **self.new_trip_fields(owner),
        }  # fmt: skip
        if not any(d["weather"] for d in days):
            trip["weather_updated_at"] = None  # fetched, but nothing covers these dates: don't imply a forecast
        trip["party"] = {"type": body.get("party"), "travellers": body.get("travellers")}
        trip["budget"] = {"total": body.get("budget"), "currency": body.get("currency", "EUR"), "categories": {}}
        await self._enrich(trip)  # type: ignore[attr-defined]
        return self.db.put("trips", trip)

    def update_settings(self, trip: dict[str, Any], changes: dict[str, Any]) -> dict[str, Any]:
        patch: dict[str, Any] = {}
        for key in ("title", "summary", "status"):
            if key in changes:
                patch[key] = changes[key]
        if "party" in changes or "travellers" in changes:
            party = dict(trip.get("party") or {})
            if "party" in changes:
                party["type"] = changes["party"]
            if "travellers" in changes:
                party["travellers"] = changes["travellers"]
            patch["party"] = party
        if any(k in changes for k in ("budget", "currency", "budget_categories")):
            b = dict(trip.get("budget") or {"currency": "EUR", "categories": {}})
            if "budget" in changes:
                b["total"] = changes["budget"]
            if "currency" in changes:
                b["currency"] = changes["currency"]
            if "budget_categories" in changes:
                b["categories"] = changes["budget_categories"]
            patch["budget"] = b
        if any(k in changes for k in ("interests", "pace")):
            req = dict(trip.get("request") or {})
            req.update({k: changes[k] for k in ("interests", "pace") if k in changes})
            patch["request"] = req
        return self._save_trip(trip, patch)

    async def add_destination(self, trip: dict[str, Any], name: str, country: str | None, n: int) -> dict[str, Any]:
        days = trip["days"]
        if len(days) + n > 14:
            raise HTTPException(422, "A trip can have at most 14 days.")
        dests = list(
            trip.get("destinations") or [{**trip["city"], "id": new_id(), "start_day": 1, "end_day": len(days)}]
        )
        if not trip.get("destinations"):
            for d in days:
                d["destination"] = dests[0]["id"]
        [dest] = await self._geocode_destinations([{"name": name, "country": country, "days": n}], len(days) + 1)
        last = next((d["date"] for d in reversed(days) if d.get("date")), None)
        forecasts, fetched = await self._forecasts([dest])
        for i in range(n):
            date = (dt.date.fromisoformat(last) + dt.timedelta(days=i + 1)).isoformat() if last else None
            days.append({"day": len(days) + 1, "theme": dest["name"], "date": date, "destination": dest["id"],
                         "weather": (forecasts.get(dest["id"]) or {}).get(date or ""), "activities": []})  # fmt: skip
        dests.append(dest)
        await self._enrich({**trip, "destinations": dests, "days": days})  # type: ignore[attr-defined]
        req = {**(trip.get("request") or {}), "days": len(days)}
        changes = {"days": days, "destinations": dests, "request": req}
        if fetched and not trip.get("weather_updated_at") and any(d.get("weather") for d in days):
            changes["weather_updated_at"] = fetched
        return self._save_trip(trip, changes)

    def copy(self, trip: dict[str, Any], owner: str) -> dict[str, Any]:
        body = {k: v for k, v in trip.items() if k not in ("id", "created_at", "updated_at", "owner", "share_key")}
        body.update(self.new_trip_fields(owner))
        body.update(title=f"{trip.get('title', 'Trip')} (copy)", version=1, history=[])
        for k in ("party", "budget"):
            if trip.get(k):
                body[k] = trip[k]
        return self.db.put("trips", body)

    def rotate_share(self, trip: dict[str, Any]) -> dict[str, Any]:
        return self._save_trip(trip, {"share_key": secrets.token_urlsafe(18)}, bump=False)

    # ── itinerary editing ────────────────────────────────────────────────────
    def _find(self, trip: dict[str, Any], activity_id: str) -> tuple[dict[str, Any], int, dict[str, Any]]:
        for d in trip["days"]:
            for i, a in enumerate(d["activities"]):
                if a["id"] == activity_id:
                    return d, i, a
        raise HTTPException(404, "Activity not found.")

    async def _refresh_days(self, trip: dict[str, Any], days: list[dict[str, Any]]) -> None:
        await self._enrich({**trip, "days": days})  # type: ignore[attr-defined]

    async def edit_activity(self, trip: dict[str, Any], activity_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        d, _, a = self._find(trip, activity_id)
        for key in ("name", "time", "duration_min", "note", "priority", "pinned", "tags", "kind"):
            if key in changes:
                a[key] = changes[key]
        if "time" in changes:
            d["activities"].sort(key=lambda x: travel.to_min(x.get("time", "09:00")))
        await self._refresh_days(trip, [d])
        return self._save_trip(trip, {"days": trip["days"]})

    async def delete_activity(self, trip: dict[str, Any], activity_id: str) -> dict[str, Any]:
        d, i, _ = self._find(trip, activity_id)
        d["activities"].pop(i)
        await self._refresh_days(trip, [d])
        return self._save_trip(trip, {"days": trip["days"]})

    async def move_activity(self, trip: dict[str, Any], activity_id: str, day: int, index: int) -> dict[str, Any]:
        src, i, a = self._find(trip, activity_id)
        dst = self._day(trip, day)  # type: ignore[attr-defined]
        src["activities"].pop(i)
        index = max(0, min(index, len(dst["activities"])))
        dst["activities"].insert(index, a)
        # keep the day chronological: the moved stop takes the slot after its new predecessor
        if index > 0:
            prev = dst["activities"][index - 1]
            a["time"] = travel.to_hhmm(
                travel.to_min(prev.get("time", "09:00")) + int(prev.get("duration_min", 60)) + 15
            )
        elif len(dst["activities"]) > 1:
            nxt = dst["activities"][1]
            a["time"] = travel.to_hhmm(
                max(6 * 60, travel.to_min(nxt.get("time", "09:00")) - int(a.get("duration_min", 60)) - 15)
            )
        dst["activities"].sort(key=lambda x: travel.to_min(x.get("time", "09:00")))
        await self._refresh_days(trip, [src] if src is dst else [src, dst])
        return self._save_trip(trip, {"days": trip["days"]})

    async def add_place_stop(self, trip: dict[str, Any], day: int, stop: dict[str, Any]) -> dict[str, Any]:
        """Add a stop by name (geocoded near the day's destination) or with coordinates from discovery."""
        d = self._day(trip, day)  # type: ignore[attr-defined]
        if stop.get("lat") is None:
            dest = destination_of(trip, d)
            hit = await self.tools.geocode_place(f"{stop['name']}, {dest['name']}", (dest["lat"], dest["lng"]))
            if hit is None:
                raise HTTPException(422, f"Couldn't find “{stop['name']}” near {dest['name']}. Add it from Explore.")
            stop = {**stop, "lat": hit["lat"], "lng": hit["lng"], "label": hit.get("label")}
        act = {"added": stop.pop("added", None) or "manual", **{k: v for k, v in stop.items() if v is not None},
               "id": new_id(), "votes": {}, "place_query": stop["name"]}  # fmt: skip
        act.setdefault("label", stop["name"])
        d["activities"] = self._insert(d["activities"], act)  # type: ignore[attr-defined]
        await self._refresh_days(trip, [d])
        return self._save_trip(trip, {"days": trip["days"]})

    async def alternatives(self, trip: dict[str, Any], activity_id: str) -> dict[str, Any]:
        """Indoor alternatives around a weather-dependent stop (real OpenStreetMap places)."""
        d, _, a = self._find(trip, activity_id)
        if a.get("lat") is None:
            raise HTTPException(422, "This stop isn't on the map, so there's nothing to search around.")
        places = await self._discover_raw(a["lat"], a["lng"], "indoor", 2000)
        planned = self._planned_names(trip)
        out = [{**p, "planned": p["name"].lower() in planned} for p in places if p.get("indoor")][:12]
        return {"day": d["day"], "around": a["name"], "weather": d.get("weather"), "places": out,
                "source": "OpenStreetMap"}  # fmt: skip

    @staticmethod
    def _planned_names(trip: dict[str, Any]) -> str:
        return " | ".join(f"{x['name']} {x.get('label') or ''}".lower() for d in trip["days"] for x in d["activities"])

    # ── discovery ────────────────────────────────────────────────────────────
    async def _discover_raw(self, lat: float, lng: float, group: str, radius: int | None) -> list[dict[str, Any]]:
        try:
            return await self.tools.discover(lat, lng, group, radius)
        except httpx.HTTPError:
            raise HTTPException(502, "OpenStreetMap search is busy right now. Please try again shortly.") from None

    def _anchor(
        self,
        trip: dict[str, Any],
        activity_id: str | None,
        destination: str | None,
        lat: float | None,
        lng: float | None,
    ) -> tuple[float, float, str, dict[str, Any] | None, dict[str, Any] | None]:
        if lat is not None and lng is not None:
            return lat, lng, "your location", None, None
        if activity_id:
            d, _, a = self._find(trip, activity_id)
            if a.get("lat") is None:
                raise HTTPException(422, "This stop isn't on the map, so there's nothing to search around.")
            return a["lat"], a["lng"], a["name"], d, a
        dests = trip.get("destinations") or [trip["city"]]
        dest = next((x for x in dests if x.get("id") == destination), dests[0])
        return dest["lat"], dest["lng"], f"{dest['name']} centre", None, None

    async def discover(self, trip: dict[str, Any], group: str, **q: Any) -> dict[str, Any]:
        lat, lng, around, day, act = self._anchor(
            trip, q.get("activity_id"), q.get("destination"), q.get("lat"), q.get("lng")
        )
        places = await self._discover_raw(lat, lng, group, q.get("radius"))
        when = None
        if q.get("open_now"):
            if act is not None and day is not None and day.get("date"):
                end = travel.to_min(act.get("time", "09:00")) + int(act.get("duration_min", 60))
                when = dt.datetime.combine(dt.date.fromisoformat(day["date"]), dt.time(*divmod(min(end, 1435), 60)))
            else:
                when = q.get("local_now") or dt.datetime.now()
        filtered = trip_logic.filter_discovery(
            places, cuisine=q.get("cuisine"), veg=q.get("veg", False), vegan=q.get("vegan", False),
            street_food=q.get("street_food", False), free_only=q.get("free", False), max_m=q.get("max_m"), open_at=when,
        )  # fmt: skip
        planned = self._planned_names(trip)
        saved = {p.get("osm_id") or p["name"].lower() for p in self.db.list("places", parent=trip["id"])}
        out = [{**p, "planned": p["name"].lower() in planned, "saved": (p.get("osm_id") or p["name"].lower()) in saved}
               for p in filtered][:40]  # fmt: skip
        return {"group": group, "around": around, "center": {"lat": lat, "lng": lng}, "places": out,
                "source": "OpenStreetMap contributors (via Overpass)", "fetched_at": _ts(),
                "note": "Ratings, prices and live availability aren't available from free map data."}  # fmt: skip

    async def transport(self, trip: dict[str, Any], destination: str | None) -> dict[str, Any]:
        lat, lng, around, _, _ = self._anchor(trip, None, destination, None, None)
        airports, stations = await asyncio.gather(
            self._discover_raw(lat, lng, "airports", None), self._discover_raw(lat, lng, "transport", None)
        )
        out = []
        for ap in trip_logic.passenger_airports(airports)[:3]:
            transfer = None
            try:
                legs = await self.tools.route([(ap["lat"], ap["lng"]), (lat, lng)])
                if legs:
                    transfer = {"drive_min": round(legs[0]["duration_s"] / 60), "km": round(legs[0]["distance_m"] / 1000, 1),
                                "source": "OSRM (typical driving time, no live traffic)"}  # fmt: skip
            except Exception:  # noqa: BLE001 - straight-line fallback below
                logger.info("airport routing unavailable")
            if transfer is None:
                km = travel.km_between((ap["lat"], ap["lng"]), (lat, lng)) * 1.3
                transfer = {
                    "drive_min": round(km / 40 * 60),
                    "km": round(km, 1),
                    "source": "estimate (straight line × 1.3)",
                }
            out.append({**ap, "transfer": transfer})
        return {"around": around, "airports": out, "stations": stations[:12], "source": "OpenStreetMap",
                "note": "Public-transport timetables and live departures need a city transit feed (not integrated)."}  # fmt: skip

    async def specialities(self, trip: dict[str, Any], destination: str | None) -> dict[str, Any]:
        """AI-suggested local specialities (clearly labelled), linked to real nearby shops by keyword."""
        lat, lng, _, _, _ = self._anchor(trip, None, destination, None, None)
        dests = trip.get("destinations") or [trip["city"]]
        dest = next((x for x in dests if x.get("id") == destination), dests[0])
        cached = (trip.get("specialities") or {}).get(str(dest.get("id")))
        if cached is None:
            res = await ask_json(self.get_llm, SPECIALITIES_SYSTEM, f"Destination: {dest['name']}, {dest.get('country')}",
                                 Specialities, limit_s=60, task="tripweaver.specialities")  # fmt: skip
            cached = {"items": [i.model_dump() for i in res.items], "generated_at": _ts()}
            self._save_trip(
                trip, {"specialities": {**(trip.get("specialities") or {}), str(dest.get("id")): cached}}, bump=False
            )
        shops = await self._discover_raw(lat, lng, "shopping", 2500)
        return {"destination": dest["name"], "ai_generated": True, "generated_at": cached["generated_at"],
                "items": trip_logic.match_specialities(cached["items"], shops), "shops": shops[:30],
                "note": "Specialities are AI suggestions; verify locally. Shops come from OpenStreetMap; "
                        "stock and prices are not known."}  # fmt: skip

    # ── child records (places, bookings, expenses, documents) ───────────────
    def children(self, trip: dict[str, Any], collection: str) -> list[dict[str, Any]]:
        return self.db.list(collection, parent=trip["id"], limit=MAX_CHILDREN)

    def child(self, trip: dict[str, Any], collection: str, child_id: str) -> dict[str, Any]:
        doc = self.db.get(collection, child_id[:40])
        if doc is None or self.db.parent_of(collection, child_id[:40]) != trip["id"]:
            raise HTTPException(404, "Not found.")
        return doc

    def add_child(self, trip: dict[str, Any], collection: str, data: dict[str, Any]) -> dict[str, Any]:
        if len(self.children(trip, collection)) >= MAX_CHILDREN:
            raise HTTPException(422, f"This trip already has {MAX_CHILDREN} {collection}.")
        doc = self.db.put(collection, data, parent=trip["id"])
        self.hub.publish(trip["id"], {"event": collection, "id": doc["id"]})
        return doc

    def update_child(
        self, trip: dict[str, Any], collection: str, child_id: str, changes: dict[str, Any]
    ) -> dict[str, Any]:
        current = self.child(trip, collection, child_id)
        return self.db.put(collection, {**current, **changes}, id=current["id"], parent=trip["id"])

    def delete_child(self, trip: dict[str, Any], collection: str, child_id: str) -> None:
        self.child(trip, collection, child_id)
        self.db.delete(collection, child_id[:40])
        self.db.delete_blob(f"tripdoc:{child_id[:40]}")

    def save_place(self, trip: dict[str, Any], place: dict[str, Any], by: str) -> dict[str, Any]:
        key = place.get("osm_id") or place["name"].lower()
        for p in self.children(trip, "places"):
            if (p.get("osm_id") or p["name"].lower()) == key:
                return p
        return self.add_child(trip, "places", {**place, "saved_by": by, "saved_at": _ts()})

    # ── money ────────────────────────────────────────────────────────────────
    async def rate(self, base: str, quote: str) -> dict[str, Any] | None:
        base, quote = base.upper(), quote.upper()
        if base == quote:
            return {
                "rate": 1.0,
                "from": base,
                "to": quote,
                "date": dt.date.today().isoformat(),
                "source": "same currency",
            }
        cache_id = f"{base}-{quote}-{dt.date.today().isoformat()}"
        if (hit := self.db.get("fx", cache_id)) is not None:
            return {k: hit[k] for k in ("rate", "from", "to", "date", "source")}
        try:
            fx = await self.tools.fx(base, quote)
        except (httpx.HTTPError, ValueError, KeyError):
            fx = None
        if fx:
            fx = {k: fx[k] for k in ("rate", "from", "to", "date", "source")}
            self.db.put("fx", fx, id=cache_id)
        return fx

    async def add_expense(self, trip: dict[str, Any], body: dict[str, Any], by: str) -> dict[str, Any]:
        trip_cur = ((trip.get("budget") or {}).get("currency") or "EUR").upper()
        cur = body["currency"].upper()
        fx = None
        if cur != trip_cur:
            if body.get("rate"):
                fx = {"rate": body["rate"], "from": cur, "to": trip_cur, "date": dt.date.today().isoformat(),
                      "source": "entered by you"}  # fmt: skip
            else:
                fx = await self.rate(cur, trip_cur)
        data = {k: v for k, v in body.items() if k != "rate"}
        data.update(currency=cur, fx=fx, added_by=by, added_at=_ts())
        return self.add_child(trip, "expenses", data)

    def budget(self, trip: dict[str, Any]) -> dict[str, Any]:
        expenses = self.children(trip, "expenses")
        out = trip_logic.budget_summary(trip.get("budget"), expenses)
        out["rates"] = sorted({f"1 {e['fx']['from']} = {e['fx']['rate']} {e['fx']['to']} ({e['fx']['source']}, {e['fx']['date']})"
                               for e in expenses if e.get("fx") and e["fx"].get("source") != "same currency"})  # fmt: skip
        return out

    async def scan_receipt(self, image: bytes, mime: str) -> dict[str, Any]:
        """A draft expense read by a vision-capable model via the router. Never saved without the user."""
        from app.llm import LLMRequest, RoutedLLM
        from app.rag.structured import extract_json

        reader = getattr(self, "receipt_reader", None)  # injectable for tests
        if reader is None:
            llm = self.get_llm()
            if not isinstance(llm, RoutedLLM):
                raise HTTPException(503, "Reading receipts needs the Groq provider (a vision-capable model).")
            reader = llm.router.execute_request
        res = await reader(LLMRequest(task="tripweaver.receipt", images=[(mime, image)],
                                                      messages=[{"role": "user", "content": RECEIPT_PROMPT}],
                                                      max_output_tokens=512, temperature=0.0))  # fmt: skip
        try:
            draft = ReceiptDraft.model_validate(extract_json(res.text))
        except (ValueError, TypeError) as exc:
            raise HTTPException(422, "Couldn't read that receipt. Enter the expense by hand.") from exc
        return {"draft": draft.model_dump(), "ai_generated": True, "model": res.model,
                "note": "Read by AI from your photo: check every field before saving."}  # fmt: skip

    # ── documents & checklists ───────────────────────────────────────────────
    def put_file(self, trip: dict[str, Any], doc_id: str, name: str, mime: str, data: bytes) -> dict[str, Any]:
        doc = self.child(trip, "documents", doc_id)
        if len(data) > MAX_FILE_BYTES:
            raise HTTPException(413, f"Files can be at most {MAX_FILE_BYTES // 1000} KB.")
        self.db.put_blob(f"tripdoc:{doc['id']}", data)
        return self.update_child(
            trip, "documents", doc["id"], {"file": {"name": name[:120], "mime": mime, "size": len(data)}}
        )

    def get_file(self, trip: dict[str, Any], doc_id: str) -> tuple[dict[str, Any], bytes]:
        doc = self.child(trip, "documents", doc_id)
        data = self.db.get_blob(f"tripdoc:{doc['id']}")
        if data is None or not doc.get("file"):
            raise HTTPException(404, "No file attached.")
        return doc["file"], data

    def set_checklists(self, trip: dict[str, Any], checklists: list[dict[str, Any]]) -> dict[str, Any]:
        return self._save_trip(trip, {"checklists": checklists}, bump=False)

    def packing_checklist(self, trip: dict[str, Any]) -> dict[str, Any]:
        items = [
            {"id": new_id(), "text": i["text"], "why": i["why"], "done": False} for i in trip_logic.packing_list(trip)
        ]
        lists = [c for c in trip.get("checklists") or [] if c.get("kind") != "packing"]
        lists.insert(0, {"id": new_id(), "title": "Packing list", "kind": "packing", "items": items,
                         "generated_at": _ts(), "source": "your trip's forecast, length and party"})  # fmt: skip
        return self.set_checklists(trip, lists)

    # ── travel companion ─────────────────────────────────────────────────────
    async def companion(
        self, trip: dict[str, Any], message: str, local: dt.datetime, location: dict[str, float] | None
    ) -> dict[str, Any]:
        """Context-aware help built from the real trip state; suggestions are validated and never auto-executed."""
        state = trip_logic.now_in_trip(trip, local)
        day = next((d for d in trip["days"] if d["day"] == state.get("day")), None)
        acts = {a["id"]: a for d in trip["days"] for a in d["activities"]}
        anchor = acts.get(state.get("next") or "") or acts.get(state.get("current") or "")
        if location:
            anchor = {"id": None, "name": "your location", "lat": location["lat"], "lng": location["lng"]}
        if anchor is None or anchor.get("lat") is None:
            dest = destination_of(trip, day) if day else (trip.get("destinations") or [trip["city"]])[0]
            anchor = {"id": None, "name": f"{dest['name']} centre", "lat": dest["lat"], "lng": dest["lng"]}

        groups = ("food", "indoor", "shopping")
        found = await asyncio.gather(*(self.tools.discover(anchor["lat"], anchor["lng"], g, 1500) for g in groups),
                                     return_exceptions=True)  # fmt: skip
        cands: dict[str, dict[str, Any]] = {}
        listing = []
        for places in found:
            if isinstance(places, BaseException):
                continue
            for p in places[:7]:
                ref = f"P{len(cands) + 1}"
                cands[ref] = p
                listing.append(trip_logic.compact_place(len(cands), p))
        budget = trip_logic.budget_summary(trip.get("budget"), self.children(trip, "expenses"))
        bookings = [{k: b.get(k) for k in ("type", "title", "start", "day")} for b in self.children(trip, "bookings")][
            :10
        ]
        fetched = trip.get("weather_updated_at")
        age_h = None
        if fetched:
            age_h = round((dt.datetime.now(dt.UTC) - dt.datetime.fromisoformat(fetched)).total_seconds() / 3600, 1)
        context = {
            "trip": trip.get("title"), "destinations": [d["name"] for d in trip.get("destinations") or [trip["city"]]],
            "now": state, "near": anchor["name"], "location_shared": bool(location),
            "today": None if day is None else {
                "day": day["day"], "date": day.get("date"), "weather": day.get("weather"),
                "rain_spells": day.get("rain_spells"), "driest_window": day.get("best_window"),
                "stops": [{"id": a["id"], "time": a["time"], "name": a["name"], "kind": a["kind"],
                           "pinned": bool(a.get("pinned"))} for a in day["activities"]],
            },
            "forecast_age_hours": age_h, "budget": {k: budget[k] for k in ("currency", "remaining", "actual_total")},
            "bookings": bookings, "preferences": (trip.get("request") or {}).get("interests"),
        }  # fmt: skip
        history = [f"{m['role']}: {m['text'][:300]}" for m in (trip.get("companion") or [])[-6:]]
        prompt = (f"CONTEXT:\n{clip(str(context), 6000)}\n\nCANDIDATE PLACES:\n{listing}\n\n"
                  + (f"RECENT CONVERSATION:\n{chr(10).join(history)}\n\n" if history else "")
                  + f"TRAVELLER: {message}")  # fmt: skip
        out = await ask_json(
            self.get_llm, COMPANION_SYSTEM, prompt, CompanionReply, limit_s=90, task="tripweaver.companion"
        )
        suggestions = trip_logic.validate_suggestions([s.model_dump() for s in out.suggestions], cands, trip, anchor)
        out.reply = trip_logic.strip_refs(out.reply, cands)  # internal refs ("P3") are for the model only
        entry = {"role": "assistant", "text": out.reply, "at": _ts(), "suggestions": suggestions, "ai_generated": True}
        history_out = [*(trip.get("companion") or []), {"role": "user", "text": message, "at": _ts()}, entry][-20:]
        self._save_trip(trip, {"companion": history_out}, bump=False)
        return {"reply": out.reply, "suggestions": suggestions, "context": {"now": state, "near": anchor["name"],
                "forecast_age_hours": age_h, "candidates": len(cands)}, "ai_generated": True}  # fmt: skip

    # ── post-trip ────────────────────────────────────────────────────────────
    def summary(self, trip: dict[str, Any]) -> dict[str, Any]:
        return trip_logic.trip_summary(trip, self.children(trip, "expenses"), self.children(trip, "places"))

    async def next_ideas(self, trip: dict[str, Any]) -> dict[str, Any]:
        s = self.summary(trip)
        prompt = (f"Past trip: {s['destinations']}; favourites: {s['favourites']}; stop types: {s['by_kind']}; "
                  f"interests: {(trip.get('request') or {}).get('interests')}")  # fmt: skip
        res = await ask_json(self.get_llm, IDEAS_SYSTEM, prompt, Ideas, limit_s=60, task="tripweaver.next_ideas")
        return {"ideas": [i.model_dump() for i in res.ideas], "ai_generated": True, "generated_at": now_iso()}
