"""Live hotel prices from LiteAPI (Nuitee Connect), booked on Nuitee's whitelabel booking site.

Phase 1 of booking: Safarnaama shows real hotels with live prices for the trip's own dates and guests; the traveller
books on the whitelabel site (Nuitee takes the payment and makes the booking). Safarnaama never takes a payment or
claims a booking.

* One search per tap (never on page load), cached for 30 minutes, one rate per hotel: the core search is free within
  Nuitee's 5000:1 search-to-book ratio, and the paid "Places" and "price index" endpoints are never used.
* Prices are the offer total the traveller pays for the stay (`offerRetailRate`, all rooms, taxes and fees as LiteAPI
  returns them), in the trip's currency. A sandbox key returns test prices; responses say so (`sandbox`).
* The key stays on the server (`LITEAPI_KEY`) and is never logged; requests go to one fixed host.

Docs: https://docs.nuitee.com/reference/post_hotels-rates, https://docs.nuitee.com/docs/deeplinking-to-whitelabel
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import time
from typing import Any
from urllib.parse import urlencode

import httpx

BASE = "https://api.liteapi.travel/v3.0"
CACHE_S = 30 * 60
MAX_HOTELS = 24


class LiveRatesError(Exception):
    """LiteAPI couldn't answer (down, slow, refused the key); the message is safe to show."""


def rooms_for(people: int) -> list[dict[str, int]]:
    """Rooms for two, the last one with whoever is left: 3 people → [{adults: 2}, {adults: 1}]."""
    people = max(1, min(int(people or 1), 16))
    return [{"adults": min(2, people - i)} for i in range(0, people, 2)]


def _https(url: Any) -> str | None:
    return url if isinstance(url, str) and url.startswith("https://") else None


def booking_link(
    site: str | None, hotel_id: str, checkin: str, checkout: str, rooms: list[dict[str, int]]
) -> str | None:
    """The hotel on the whitelabel site with the dates and guests filled in (occupancies: base64 of the JSON list)."""
    if not site:
        return None
    occ = base64.b64encode(json.dumps(rooms, separators=(",", ":")).encode()).decode()
    query = urlencode({"checkin": checkin, "checkout": checkout, "occupancies": occ})
    return f"{site.rstrip('/')}/hotels/{hotel_id}?{query}"


def public_price(offer: dict[str, Any]) -> float:
    """The stay's price to show in public: the offer total, never below the hotel's suggested selling price (Nuitee
    treats showing less than that in public as a rate violation; the booking site then shows the final price)."""
    total = float(offer["offerRetailRate"]["amount"])
    floor = offer.get("suggestedSellingPrice") or {}
    if isinstance(floor, list):
        floor = floor[0] if floor else {}
    same = floor.get("currency") in (None, offer["offerRetailRate"].get("currency"))
    return max(total, float(floor.get("amount") or 0)) if same else total


def parse_rates(body: dict[str, Any], *, nights: int, site: str | None, checkin: str, checkout: str,
                rooms: list[dict[str, int]]) -> list[dict[str, Any]]:  # fmt: skip
    """Each hotel's cheapest offer for the stay, with the hotel's details, cheapest first."""
    details = {h.get("id"): h for h in body.get("hotels") or [] if isinstance(h, dict)}
    out = []
    for item in body.get("data") or []:
        hid = item.get("hotelId")
        offers = [r for r in item.get("roomTypes") or [] if (r.get("offerRetailRate") or {}).get("amount") is not None]
        if not hid or not offers:
            continue
        best = min(offers, key=lambda r: float(r["offerRetailRate"]["amount"]))
        rate = (best.get("rates") or [{}])[0]
        h = details.get(hid, {})
        total = public_price(best)
        out.append({
            "id": hid, "name": h.get("name") or "Hotel", "stars": h.get("stars"), "rating": h.get("rating"),
            "reviews": h.get("review_count"), "photo": _https(h.get("thumbnail")) or _https(h.get("main_photo")),
            "address": h.get("address"), "lat": h.get("latitude"), "lng": h.get("longitude"),
            "total": round(total, 2), "currency": best["offerRetailRate"].get("currency"),
            "per_night": round(total / max(1, nights), 2), "room": rate.get("name"), "board": rate.get("boardName"),
            "refundable": (rate.get("cancellationPolicies") or {}).get("refundableTag") == "RFN",
            "book_url": booking_link(site, hid, checkin, checkout, rooms),
        })  # fmt: skip
    out.sort(key=lambda x: x["total"])
    return out[:MAX_HOTELS]


class LiteAPI:
    def __init__(self, key: str, site: str | None = None, client: httpx.AsyncClient | None = None) -> None:
        self._key = key
        self.site = (site or "").strip() or None
        self.client = client or httpx.AsyncClient(timeout=20)
        self._cache: dict[tuple[Any, ...], tuple[float, dict[str, Any]]] = {}

    @classmethod
    def from_settings(cls, settings: Any) -> LiteAPI | None:
        key = getattr(settings, "liteapi_key", None)
        value = key.get_secret_value() if key is not None else ""
        return cls(value, getattr(settings, "liteapi_whitelabel_url", None)) if value else None

    @property
    def sandbox(self) -> bool:
        return self._key.startswith("sand_")

    async def rates(self, *, lat: float, lng: float, checkin: str, checkout: str, people: int, currency: str,
                    nationality: str, radius_m: int = 5000) -> dict[str, Any]:  # fmt: skip
        """Live prices around a point for the stay; cached for 30 minutes."""
        rooms = rooms_for(people)
        key = (round(lat, 3), round(lng, 3), checkin, checkout, json.dumps(rooms), currency, nationality, radius_m)
        hit = self._cache.get(key)
        if hit and hit[0] > time.monotonic():
            return {**hit[1], "cached": True}
        body = {
            "latitude": round(lat, 5), "longitude": round(lng, 5), "radius": radius_m, "checkin": checkin,
            "checkout": checkout, "occupancies": rooms, "currency": currency, "guestNationality": nationality,
            "maxRatesPerHotel": 1, "limit": 60, "includeHotelData": True, "timeout": 8,
        }  # fmt: skip
        try:
            r = await self.client.post(
                f"{BASE}/hotels/rates", json=body, headers={"X-API-Key": self._key, "Accept": "application/json"}
            )
        except httpx.HTTPError:
            raise LiveRatesError("Live hotel prices didn't answer in time. Please try again.") from None
        if r.status_code == 429:
            raise LiveRatesError("Live hotel prices are busy right now. Please try again in a minute.")
        if r.status_code in (401, 403):
            raise LiveRatesError("The live hotel prices key was refused. Check LITEAPI_KEY.")
        if r.status_code >= 400:
            raise LiveRatesError(f"Live hotel prices aren't available for this search (error {r.status_code}).")
        data = r.json()
        nights = _nights(checkin, checkout)
        out = {
            "hotels": parse_rates(data, nights=nights, site=self.site, checkin=checkin, checkout=checkout, rooms=rooms),
            "sandbox": bool(data.get("sandbox", self.sandbox)), "checkin": checkin, "checkout": checkout,
            "nights": nights, "rooms": len(rooms), "people": sum(x["adults"] for x in rooms), "currency": currency,
            "booking_site": self.site is not None, "source": "LiteAPI by Nuitee", "fetched_at": _now(),
        }  # fmt: skip
        self._cache[key] = (time.monotonic() + CACHE_S, out)
        return {**out, "cached": False}


def _nights(checkin: str, checkout: str) -> int:
    return max(1, (dt.date.fromisoformat(checkout) - dt.date.fromisoformat(checkin)).days)


def _now() -> str:
    return dt.datetime.now(dt.UTC).isoformat()


def nationality_for(currency: str | None) -> str:
    """The guest nationality LiteAPI prices for, from the traveller's own currency (rupees → India)."""
    return {"INR": "IN", "USD": "US", "GBP": "GB", "AED": "AE", "SGD": "SG", "AUD": "AU", "CAD": "CA", "JPY": "JP",
            "NZD": "NZ", "CHF": "CH", "NPR": "NP", "LKR": "LK", "BDT": "BD", "MYR": "MY", "THB": "TH",
            "IDR": "ID"}.get((currency or "").upper(), "IN")  # fmt: skip


def stay_window(trip: dict[str, Any], dest_index: int) -> tuple[str | None, str | None]:
    """Check-in and check-out for a destination (the last day of the trip is the day you leave), as booking.js."""
    dests = trip.get("destinations") or []
    if not dests or dest_index >= len(dests):
        return None, None
    d = dests[dest_index]
    end = dest_index == len(dests) - 1
    days = {x["day"]: x.get("date") for x in trip.get("days") or []}
    first, last = days.get(d.get("start_day", 1)), days.get(d.get("end_day", len(days)))
    nights = d.get("end_day", 1) - d.get("start_day", 1) + (0 if end else 1)
    if not first or not last or nights <= 0:
        return None, None
    if end:
        return first, last
    return first, (dt.date.fromisoformat(last) + dt.timedelta(days=1)).isoformat()


def plan_centre(trip: dict[str, Any], dest_index: int) -> tuple[float, float] | None:
    """The middle of a destination's mapped stops (where the days happen), or the destination itself."""
    dests = trip.get("destinations") or [trip.get("city") or {}]
    if dest_index >= len(dests):
        return None
    d = dests[dest_index]
    pts = [
        (a["lat"], a["lng"])
        for x in trip.get("days") or []
        if (x.get("destination") == d.get("id")) or (not x.get("destination") and d.get("start_day", 1) <= x["day"] <= d.get("end_day", 99))
        for a in x.get("activities") or []
        if a.get("lat") is not None
    ]  # fmt: skip
    if pts:
        return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
    return (d["lat"], d["lng"]) if d.get("lat") is not None else None
