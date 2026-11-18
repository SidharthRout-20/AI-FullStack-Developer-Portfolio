"""TripWeaver HTTP API (/api/trips).

Identity (same convention as EFI, no accounts in this portfolio): `POST /api/trips/owner` issues an unguessable owner
token that the browser keeps and sends as `X-Trip-Owner`; the server stores only `sha256(token)`. Roles per trip:

* owner  – the token that created it: everything (documents, bookings, budget, companion, delete).
* member – anyone holding the trip's share key (`X-Trip-Share` header, or `?share=` for the live stream):
           view the itinerary, vote, see and add shared expenses, see saved places.
* legacy – trips created before ownership existed: viewable by link and votable as before, never editable;
           "Save a copy" makes an owned copy. Historical records are never deleted.

Unknown or unauthorised trips answer 404 (not 403), so trip IDs can't be probed.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import re
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated, Any, Literal

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from appcore.ai import llm_failure, sse
from appcore.guardrails import normalize
from appcore.security import limiter, rate_limit_value
from safarnama import logic as trip_logic
from safarnama.service import TripService

router = APIRouter(prefix="/api/trips", tags=["tripweaver"])
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{24,128}$")
HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"
CUR = r"^[A-Za-z]{3}$"
Role = Literal["owner", "member", "legacy"]


def get_trips(request: Request) -> TripService:
    """The app's TripService (the portfolio and the standalone Safarnama app both set `app.state.trips`)."""
    return request.app.state.trips


Trips = Annotated[TripService, Depends(get_trips)]


@dataclass
class Who:
    owner: str | None
    share: str | None


def owner_hash(token: str) -> str:
    return hashlib.sha256(b"trip-owner|" + token.encode()).hexdigest()


def who(
    x_trip_owner: Annotated[str | None, Header()] = None,
    x_trip_share: Annotated[str | None, Header()] = None,
    share: Annotated[str | None, Query(max_length=64)] = None,
) -> Who:
    token = x_trip_owner if x_trip_owner and _TOKEN.match(x_trip_owner) else None
    return Who(owner_hash(token) if token else None, (x_trip_share or share or None))


Caller = Annotated[Who, Depends(who)]


def need_owner_token(w: Who) -> str:
    if not w.owner:
        raise HTTPException(401, "Missing or invalid TripWeaver owner token (X-Trip-Owner).")
    return w.owner


def access(
    svc: TripService, trip_id: str, w: Who, need: Literal["view", "member", "owner"]
) -> tuple[dict[str, Any], Role]:
    trip = svc.db.get("trips", trip_id[:40])
    if trip is None:
        raise HTTPException(404, "Trip not found.")
    role: Role
    if trip.get("owner"):
        if w.owner and secrets.compare_digest(trip["owner"], w.owner):
            role = "owner"
        elif w.share and trip.get("share_key") and secrets.compare_digest(str(trip["share_key"]), w.share):
            role = "member"
        else:
            raise HTTPException(404, "Trip not found.")
    else:
        role = "legacy"
    if need == "owner" and role != "owner":
        raise HTTPException(
            403,
            "This trip was created before trip ownership existed: save a copy to edit it."
            if role == "legacy"
            else "Only the trip's owner can do this.",
        )
    return trip, role


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


# ── request bodies ─────────────────────────────────────────────────────────
class In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PlanIn(In):
    prompt: str = Field(min_length=10, max_length=1000)
    # Choices the traveller made explicitly (the quick planner): they win over what the model reads from the prompt.
    party: Literal["solo", "couple", "family", "friends", "group"] | None = None
    travellers: int | None = Field(None, ge=1, le=50)


class DestinationIn(In):
    name: str = Field(min_length=2, max_length=120)
    country: str | None = Field(None, max_length=60)
    days: int = Field(1, ge=1, le=14)


Party = Literal["solo", "couple", "family", "friends", "group"]


class ManualIn(In):
    title: str | None = Field(None, max_length=120)
    destinations: list[DestinationIn] = Field(min_length=1, max_length=5)
    start_date: dt.date | None = None
    party: Party | None = None
    travellers: int | None = Field(None, ge=1, le=50)
    travellers_note: str | None = Field(None, max_length=80)
    budget: float | None = Field(None, ge=0, le=10_000_000)
    currency: str | None = Field(None, pattern=CUR)  # default: the first destination's local currency
    interests: list[str] = Field(default_factory=list, max_length=10)
    pace: Literal["relaxed", "balanced", "packed"] = "balanced"
    notes: str | None = Field(None, max_length=800)

    @field_validator("destinations")
    @classmethod
    def _total(cls, v: list[DestinationIn]) -> list[DestinationIn]:
        if sum(d.days for d in v) > 14:
            raise ValueError("at most 14 days in total")
        return v


class SettingsIn(In):
    title: str | None = Field(None, min_length=1, max_length=120)
    summary: str | None = Field(None, max_length=800)
    status: Literal["planning", "archived"] | None = None
    party: Party | None = None
    travellers: int | None = Field(None, ge=1, le=50)
    budget: float | None = Field(None, ge=0, le=10_000_000)
    currency: str | None = Field(None, pattern=CUR)
    budget_categories: dict[Literal[trip_logic.EXPENSE_CATEGORIES], float] | None = None  # type: ignore[valid-type]
    interests: list[str] | None = Field(None, max_length=10)
    pace: Literal["relaxed", "balanced", "packed"] | None = None


class ReplanIn(In):
    event: str = Field(min_length=5, max_length=500)
    days: list[int] | None = Field(None, max_length=14)


class StopIn(In):
    name: str = Field(min_length=1, max_length=120)
    lat: float | None = Field(None, ge=-90, le=90)
    lng: float | None = Field(None, ge=-180, le=180)
    kind: Literal["outdoor", "indoor", "food"] = "outdoor"
    time: str = Field("12:00", pattern=HHMM)
    duration_min: int = Field(60, ge=10, le=600)
    note: str = Field("", max_length=300)
    # provider fields carried over from discovery (OpenStreetMap), so labels and hand-offs keep working
    opening_hours: str | None = Field(None, max_length=200)
    website: str | None = Field(None, max_length=300)
    menu: str | None = Field(None, max_length=300)
    reservation_url: str | None = Field(None, max_length=300)
    reservation: str | None = Field(None, max_length=20)
    phone: str | None = Field(None, max_length=60)
    distance_m: int | None = Field(None, ge=0, le=100_000)
    near: str | None = Field(None, max_length=120)
    osm_id: str | None = Field(None, max_length=40)
    added: Literal["nearby", "discovery", "companion", "saved", "manual"] | None = None


class ActivityPatch(In):
    name: str | None = Field(None, min_length=1, max_length=120)
    time: str | None = Field(None, pattern=HHMM)
    duration_min: int | None = Field(None, ge=10, le=600)
    note: str | None = Field(None, max_length=300)
    kind: Literal["outdoor", "indoor", "food", "transit"] | None = None
    priority: Literal["must", "normal", "optional"] | None = None
    pinned: bool | None = None
    tags: list[Literal["local_favourite", "hidden_gem"]] | None = Field(None, max_length=2)


class MoveIn(In):
    day: int = Field(ge=1, le=14)
    index: int = Field(ge=0, le=40)


class VoteIn(In):
    activity_id: str = Field(max_length=40)
    voter: str = Field(min_length=1, max_length=40)
    value: Literal[-1, 0, 1]


class PlaceIn(In):
    name: str = Field(min_length=1, max_length=160)
    group: str = Field("sights", max_length=20)
    category: str | None = Field(None, max_length=60)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    cuisine: str | None = Field(None, max_length=120)
    veg: bool = False
    vegan: bool = False
    opening_hours: str | None = Field(None, max_length=200)
    website: str | None = Field(None, max_length=300)
    menu: str | None = Field(None, max_length=300)
    reservation_url: str | None = Field(None, max_length=300)
    reservation: str | None = Field(None, max_length=20)
    phone: str | None = Field(None, max_length=60)
    osm_id: str | None = Field(None, max_length=40)
    note: str = Field("", max_length=300)
    destination: str | None = Field(None, max_length=40)


BookingType = Literal["flight", "hotel", "train", "bus", "car", "restaurant", "activity", "tour", "ticket", "other"]
_EXPENSE_FOR = {"flight": "transport", "train": "transport", "bus": "transport", "car": "transport",
                "hotel": "lodging", "restaurant": "food", "activity": "activities", "tour": "activities",
                "ticket": "activities"}  # fmt: skip


class BookingIn(In):
    type: BookingType
    title: str = Field(min_length=1, max_length=160)
    provider: str | None = Field(None, max_length=120)
    reference: str | None = Field(None, max_length=80)
    start: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$")
    end: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$")
    day: int | None = Field(None, ge=1, le=14)
    activity_id: str | None = Field(None, max_length=40)
    location: str | None = Field(None, max_length=200)
    cost: float | None = Field(None, ge=0, le=10_000_000)
    currency: str | None = Field(None, pattern=CUR)
    cancellation: str | None = Field(None, max_length=500)
    url: str | None = Field(None, max_length=400, pattern=r"^https?://")
    status: Literal["planned", "booked", "cancelled"] = "booked"
    notes: str | None = Field(None, max_length=1000)
    add_expense: bool = False


class BookingPatch(In):
    title: str | None = Field(None, min_length=1, max_length=160)
    provider: str | None = Field(None, max_length=120)
    reference: str | None = Field(None, max_length=80)
    start: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$")
    end: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$")
    day: int | None = Field(None, ge=1, le=14)
    cancellation: str | None = Field(None, max_length=500)
    status: Literal["planned", "booked", "cancelled"] | None = None
    notes: str | None = Field(None, max_length=1000)


class ExpenseIn(In):
    amount: float = Field(gt=0, le=10_000_000)
    currency: str = Field(pattern=CUR)
    category: Literal["lodging", "food", "transport", "activities", "shopping", "other"] = "other"
    kind: Literal["estimate", "actual"] = "actual"
    date: dt.date | None = None
    day: int | None = Field(None, ge=1, le=14)
    paid_by: str | None = Field(None, max_length=40)
    split_between: list[str] = Field(default_factory=list, max_length=20)
    note: str = Field("", max_length=300)
    rate: float | None = Field(None, gt=0, le=1_000_000, description="your own exchange rate to the trip currency")
    booking_id: str | None = Field(None, max_length=40)


class DocumentIn(In):
    kind: Literal["confirmation", "ticket", "insurance", "accommodation", "emergency_contact", "id", "note", "other"]
    title: str = Field(min_length=1, max_length=160)
    body: str = Field("", max_length=5000)
    booking_id: str | None = Field(None, max_length=40)


class ChecklistItem(In):
    id: str = Field(min_length=1, max_length=40)
    text: str = Field(min_length=1, max_length=200)
    done: bool = False
    why: str | None = Field(None, max_length=200)


class Checklist(In):
    id: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=80)
    kind: str | None = Field(None, max_length=20)
    items: list[ChecklistItem] = Field(default_factory=list, max_length=150)
    generated_at: str | None = Field(None, max_length=40)
    source: str | None = Field(None, max_length=120)


class ChecklistsIn(In):
    checklists: list[Checklist] = Field(max_length=20)


class CompanionIn(In):
    message: str = Field(min_length=2, max_length=800)
    local_time: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")
    lat: float | None = Field(None, ge=-90, le=90)
    lng: float | None = Field(None, ge=-180, le=180)


# ── identity & trips ───────────────────────────────────────────────────────
@router.post("/owner", status_code=201)
@limiter.limit("10/minute")
def issue_owner(request: Request) -> dict[str, str]:
    return {"token": secrets.token_urlsafe(32)}


@router.post("/plan")
@limiter.limit("6/minute")
async def plan(request: Request, body: PlanIn, svc: Trips, w: Caller) -> StreamingResponse:
    owner = need_owner_token(w)
    today = dt.date.today()

    async def events() -> AsyncIterator[dict[str, Any]]:
        async for ev in svc.plan(normalize(body.prompt), today, owner, party=body.party, travellers=body.travellers):
            if ev.get("event") == "done":
                ev = {**ev, "trip": svc.view(ev["trip"], "owner")}  # never the owner hash
            yield ev

    return _stream(events)


@router.post("", status_code=201)
@limiter.limit(rate_limit_value)
async def create_trip(request: Request, body: ManualIn, svc: Trips, w: Caller) -> dict[str, Any]:
    owner = need_owner_token(w)
    trip = await _guard(svc.create_manual(owner, body.model_dump(mode="python")))
    return svc.view(trip, "owner")


@router.get("")
def list_trips(svc: Trips, w: Caller) -> list[dict[str, Any]]:
    return svc.my_trips(w.owner) if w.owner else []


@router.get("/{trip_id}")
def get_trip(trip_id: str, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, role = access(svc, trip_id, w, "view")
    return svc.view(trip, role)


@router.patch("/{trip_id}")
def update_trip(trip_id: str, body: SettingsIn, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    return svc.view(svc.update_settings(trip, body.model_dump(exclude_unset=True)), "owner")


@router.delete("/{trip_id}", status_code=204)
def delete_trip(trip_id: str, svc: Trips, w: Caller) -> None:
    trip, _ = access(svc, trip_id, w, "owner")
    for collection in ("places", "bookings", "expenses", "documents"):
        for doc in svc.children(trip, collection):
            svc.db.delete_blob(f"tripdoc:{doc['id']}")
    svc.db.delete("trips", trip["id"])  # child documents go with it (docstore parent cascade)


@router.post("/{trip_id}/copy", status_code=201)
def copy_trip(trip_id: str, svc: Trips, w: Caller) -> dict[str, Any]:
    owner = need_owner_token(w)
    trip, _ = access(svc, trip_id, w, "view")
    return svc.view(svc.copy(trip, owner), "owner")


@router.post("/{trip_id}/share/rotate")
def rotate_share(trip_id: str, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    return svc.view(svc.rotate_share(trip), "owner")


@router.get("/{trip_id}/live")
async def live(trip_id: str, svc: Trips, w: Caller) -> StreamingResponse:
    trip, role = access(svc, trip_id, w, "view")

    async def events() -> AsyncIterator[str]:
        async for ev in svc.hub.subscribe(trip["id"], lambda: svc.db.get("trips", trip["id"])):
            if ev.get("event") == "trip" and ev.get("trip"):
                ev = {**ev, "trip": svc.view(ev["trip"], role)}
            yield sse(ev.pop("event"), ev)

    return StreamingResponse(
        events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


# ── itinerary ──────────────────────────────────────────────────────────────
@router.post("/{trip_id}/destinations")
@limiter.limit(rate_limit_value)
async def add_destination(request: Request, trip_id: str, body: DestinationIn, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    return svc.view(await _guard(svc.add_destination(trip, body.name, body.country, body.days)), "owner")


@router.post("/{trip_id}/replan")
@limiter.limit(rate_limit_value)
async def replan(request: Request, trip_id: str, body: ReplanIn, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    out = await _guard(svc.replan(trip, normalize(body.event), body.days))
    return {**out, "trip": svc.view(out["trip"], "owner")}


@router.post("/{trip_id}/weather-check")
@limiter.limit(rate_limit_value)
async def weather_check(request: Request, trip_id: str, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    out = await _guard(svc.weather_check(trip))
    return {**out, "trip": svc.view(out["trip"], "owner")}


@router.post("/{trip_id}/votes")
@limiter.limit("60/minute")
def vote(request: Request, trip_id: str, body: VoteIn, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, role = access(svc, trip_id, w, "member")
    return svc.view(svc.vote(trip, body.activity_id, body.voter.strip(), body.value), role)


@router.post("/{trip_id}/days/{day}/optimise")
@limiter.limit(rate_limit_value)
async def optimise_day(request: Request, trip_id: str, day: int, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    out = await _guard(svc.optimise_day(trip, day))
    return {**out, "trip": svc.view(out["trip"], "owner")}


@router.post("/{trip_id}/days/{day}/stops")
@limiter.limit(rate_limit_value)
async def add_stop(request: Request, trip_id: str, day: int, body: StopIn, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    return svc.view(await _guard(svc.add_place_stop(trip, day, body.model_dump())), "owner")


@router.patch("/{trip_id}/activities/{activity_id}")
async def edit_activity(trip_id: str, activity_id: str, body: ActivityPatch, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    return svc.view(
        await _guard(svc.edit_activity(trip, activity_id[:40], body.model_dump(exclude_unset=True))), "owner"
    )


@router.delete("/{trip_id}/activities/{activity_id}")
async def delete_activity(trip_id: str, activity_id: str, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    return svc.view(await _guard(svc.delete_activity(trip, activity_id[:40])), "owner")


@router.post("/{trip_id}/activities/{activity_id}/move")
async def move_activity(trip_id: str, activity_id: str, body: MoveIn, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    return svc.view(await _guard(svc.move_activity(trip, activity_id[:40], body.day, body.index)), "owner")


@router.get("/{trip_id}/activities/{activity_id}/alternatives")
@limiter.limit("30/minute")
async def alternatives(request: Request, trip_id: str, activity_id: str, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    return await _guard(svc.alternatives(trip, activity_id[:40]))


@router.post("/{trip_id}/meals")
@limiter.limit(rate_limit_value)
async def add_meals(request: Request, trip_id: str, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    out = await _guard(svc.add_meals(trip))
    return {**out, "trip": svc.view(out["trip"], "owner")}


# ── discovery & saved places ───────────────────────────────────────────────
@router.get("/{trip_id}/nearby")
@limiter.limit("30/minute")
async def nearby(
    request: Request,
    trip_id: str,
    activity_id: str,
    svc: Trips,
    w: Caller,
    group: Literal["food", "sights"] = "food",
    cuisine: str | None = None,
    veg: bool = False,
    open_now: bool = False,
) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "member")
    return await _guard(svc.nearby(trip, activity_id[:40], group, (cuisine or "")[:40] or None, veg, open_now))


@router.get("/{trip_id}/discover")
@limiter.limit("30/minute")
async def discover(
    request: Request,
    trip_id: str,
    svc: Trips,
    w: Caller,
    group: Annotated[str, Query(pattern="^(" + "|".join(trip_logic.GROUPS) + ")$")] = "food",
    activity_id: Annotated[str | None, Query(max_length=40)] = None,
    destination: Annotated[str | None, Query(max_length=40)] = None,
    lat: Annotated[float | None, Query(ge=-90, le=90)] = None,
    lng: Annotated[float | None, Query(ge=-180, le=180)] = None,
    radius: Annotated[int | None, Query(ge=200, le=60_000)] = None,
    cuisine: Annotated[str | None, Query(max_length=40)] = None,
    veg: bool = False,
    vegan: bool = False,
    street_food: bool = False,
    free: bool = False,
    open_now: bool = False,
) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "member")
    return await _guard(svc.discover(
        trip, group, activity_id=activity_id, destination=destination, lat=lat, lng=lng, radius=radius,
        cuisine=cuisine, veg=veg, vegan=vegan, street_food=street_food, free=free, open_now=open_now,
    ))  # fmt: skip


@router.get("/{trip_id}/transport")
@limiter.limit("20/minute")
async def transport(
    request: Request, trip_id: str, svc: Trips, w: Caller, destination: str | None = None
) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "member")
    return await _guard(svc.transport(trip, (destination or "")[:40] or None))


@router.post("/{trip_id}/specialities")
@limiter.limit("6/minute")
async def specialities(
    request: Request, trip_id: str, svc: Trips, w: Caller, destination: str | None = None
) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    return await _guard(svc.specialities(trip, (destination or "")[:40] or None))


@router.get("/{trip_id}/places")
def list_places(trip_id: str, svc: Trips, w: Caller) -> list[dict[str, Any]]:
    trip, _ = access(svc, trip_id, w, "member")
    return svc.children(trip, "places")


@router.post("/{trip_id}/places", status_code=201)
def save_place(trip_id: str, body: PlaceIn, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, role = access(svc, trip_id, w, "member")
    if role == "legacy":
        raise HTTPException(403, "Save a copy of this trip to keep places.")
    place = body.model_dump()
    place["links"] = trip_logic.handoff_links(place)
    return svc.save_place(trip, place, role)


@router.delete("/{trip_id}/places/{place_id}", status_code=204)
def delete_place(trip_id: str, place_id: str, svc: Trips, w: Caller) -> None:
    trip, _ = access(svc, trip_id, w, "owner")
    svc.delete_child(trip, "places", place_id)


# ── bookings ───────────────────────────────────────────────────────────────
@router.get("/{trip_id}/bookings")
def list_bookings(trip_id: str, svc: Trips, w: Caller) -> list[dict[str, Any]]:
    trip, _ = access(svc, trip_id, w, "owner")
    return sorted(svc.children(trip, "bookings"), key=lambda b: (b.get("start") or "9999", b["created_at"]))


@router.post("/{trip_id}/bookings", status_code=201)
async def add_booking(trip_id: str, body: BookingIn, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    data = body.model_dump(exclude={"add_expense"})
    if data.get("activity_id"):
        svc._find(trip, data["activity_id"])  # must be a real stop on this trip
    data["recorded_by"] = "you"  # TripWeaver never makes bookings; this is the traveller's own record
    booking = svc.add_child(trip, "bookings", data)
    if body.add_expense and body.cost:
        currency = body.currency or (trip.get("budget") or {}).get("currency") or "EUR"
        await _guard(svc.add_expense(trip, {
            "amount": body.cost, "currency": currency, "category": _EXPENSE_FOR.get(body.type, "other"),
            "kind": "actual" if body.status == "booked" else "estimate", "day": body.day, "note": body.title,
            "booking_id": booking["id"], "split_between": [],
        }, "owner"))  # fmt: skip
    return booking


@router.patch("/{trip_id}/bookings/{booking_id}")
def update_booking(trip_id: str, booking_id: str, body: BookingPatch, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    booking = svc.update_child(trip, "bookings", booking_id, body.model_dump(exclude_unset=True))
    svc.sync_booking_expense(trip, booking)
    return booking


@router.delete("/{trip_id}/bookings/{booking_id}", status_code=204)
def delete_booking(trip_id: str, booking_id: str, svc: Trips, w: Caller) -> None:
    trip, _ = access(svc, trip_id, w, "owner")
    svc.delete_child(trip, "bookings", booking_id)
    svc.sync_booking_expense(trip, {"id": booking_id, "status": "deleted"})


# ── budget & expenses ──────────────────────────────────────────────────────
@router.get("/{trip_id}/expenses")
def list_expenses(trip_id: str, svc: Trips, w: Caller) -> list[dict[str, Any]]:
    trip, _ = access(svc, trip_id, w, "member")
    return svc.children(trip, "expenses")


@router.post("/{trip_id}/expenses", status_code=201)
@limiter.limit("60/minute")
async def add_expense(request: Request, trip_id: str, body: ExpenseIn, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, role = access(svc, trip_id, w, "member")
    if role == "legacy":
        raise HTTPException(403, "Save a copy of this trip to track expenses.")
    return await _guard(svc.add_expense(trip, body.model_dump(mode="json"), role))


@router.delete("/{trip_id}/expenses/{expense_id}", status_code=204)
def delete_expense(trip_id: str, expense_id: str, svc: Trips, w: Caller) -> None:
    trip, _ = access(svc, trip_id, w, "owner")
    svc.delete_child(trip, "expenses", expense_id)


@router.get("/{trip_id}/budget")
def budget(trip_id: str, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "member")
    return svc.budget(trip)


@router.get("/{trip_id}/fx")
@limiter.limit("30/minute")
async def fx(
    request: Request,
    trip_id: str,
    svc: Trips,
    w: Caller,
    base: Annotated[str, Query(pattern=CUR)],
    quote: Annotated[str, Query(pattern=CUR)],
) -> dict[str, Any]:
    access(svc, trip_id, w, "member")
    rate = await svc.rate(base, quote)
    if rate is None:
        raise HTTPException(502, "No current reference rate is available for this pair. Enter your own rate instead.")
    return rate


@router.post("/{trip_id}/expenses/scan")
@limiter.limit("6/minute")
async def scan_receipt(request: Request, trip_id: str, svc: Trips, w: Caller) -> dict[str, Any]:
    access(svc, trip_id, w, "owner")
    mime = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if mime not in ("image/jpeg", "image/png", "image/webp"):
        raise HTTPException(415, "Upload a JPEG, PNG or WebP photo of the receipt.")
    data = await request.body()
    if not data or len(data) > 4_000_000:
        raise HTTPException(413, "Receipt photos can be at most 4 MB (the app downsizes them first).")
    return await _guard(svc.scan_receipt(data, mime))


# ── documents & checklists ─────────────────────────────────────────────────
@router.get("/{trip_id}/documents")
def list_documents(trip_id: str, svc: Trips, w: Caller) -> list[dict[str, Any]]:
    trip, _ = access(svc, trip_id, w, "owner")
    return svc.children(trip, "documents")


@router.post("/{trip_id}/documents", status_code=201)
def add_document(trip_id: str, body: DocumentIn, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    return svc.add_child(trip, "documents", body.model_dump())


@router.patch("/{trip_id}/documents/{doc_id}")
def update_document(trip_id: str, doc_id: str, body: DocumentIn, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    return svc.update_child(trip, "documents", doc_id, body.model_dump())


@router.delete("/{trip_id}/documents/{doc_id}", status_code=204)
def delete_document(trip_id: str, doc_id: str, svc: Trips, w: Caller) -> None:
    trip, _ = access(svc, trip_id, w, "owner")
    svc.delete_child(trip, "documents", doc_id)


_FILE_TYPES = ("application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain")


@router.post("/{trip_id}/documents/{doc_id}/file")
@limiter.limit("20/minute")
async def upload_file(
    request: Request,
    trip_id: str,
    doc_id: str,
    svc: Trips,
    w: Caller,
    name: Annotated[str, Query(max_length=120)] = "file",
) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    mime = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if mime not in _FILE_TYPES:
        raise HTTPException(415, "Attach a PDF, image or text file.")
    return svc.put_file(trip, doc_id, re.sub(r"[^\w .-]", "_", name), mime, await request.body())


@router.get("/{trip_id}/documents/{doc_id}/file")
def download_file(trip_id: str, doc_id: str, svc: Trips, w: Caller) -> Response:
    trip, _ = access(svc, trip_id, w, "owner")
    meta, data = svc.get_file(trip, doc_id)
    return Response(data, media_type=meta["mime"], headers={
        "Content-Disposition": f'attachment; filename="{meta["name"]}"', "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    })  # fmt: skip


@router.put("/{trip_id}/checklists")
def put_checklists(trip_id: str, body: ChecklistsIn, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    return svc.view(svc.set_checklists(trip, [c.model_dump() for c in body.checklists]), "owner")


@router.post("/{trip_id}/checklists/packing")
def packing(trip_id: str, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    return svc.view(svc.packing_checklist(trip), "owner")


# ── companion & post-trip ──────────────────────────────────────────────────
@router.post("/{trip_id}/companion")
@limiter.limit("10/minute")
async def companion(request: Request, trip_id: str, body: CompanionIn, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    local = dt.datetime.fromisoformat(body.local_time) if body.local_time else dt.datetime.now()
    location = {"lat": body.lat, "lng": body.lng} if body.lat is not None and body.lng is not None else None
    return await _guard(svc.companion(trip, normalize(body.message), local, location))


@router.get("/{trip_id}/summary")
def summary(trip_id: str, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    return svc.summary(trip)


@router.post("/{trip_id}/next-ideas")
@limiter.limit("6/minute")
async def next_ideas(request: Request, trip_id: str, svc: Trips, w: Caller) -> dict[str, Any]:
    trip, _ = access(svc, trip_id, w, "owner")
    return await _guard(svc.next_ideas(trip))
