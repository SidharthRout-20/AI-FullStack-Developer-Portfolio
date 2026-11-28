"""Live hotel prices (LiteAPI by Nuitee): what is asked for, what is shown, and how a stay is handed to the booking
site. LiteAPI is always mocked (httpx MockTransport): no live calls in tests."""

from __future__ import annotations

import base64
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from safarnama import liteapi
from safarnama.main import create_app
from tests.conftest import FakeTools, ScriptedLLM

RATES = {
    "sandbox": True,
    "data": [
        {"hotelId": "lp1", "roomTypes": [
            {"offerId": "o1", "offerRetailRate": {"amount": 9800.0, "currency": "INR"},
             "rates": [{"name": "Deluxe Room", "boardName": "Breakfast Included", "cancellationPolicies": {"refundableTag": "RFN"}}]},
            {"offerId": "o2", "offerRetailRate": {"amount": 7400.0, "currency": "INR"},
             "suggestedSellingPrice": {"amount": 7900.0, "currency": "INR", "source": "booking.com"},
             "rates": [{"name": "Standard Room", "boardName": "Room Only", "cancellationPolicies": {"refundableTag": "NRFN"}}]}]},
        {"hotelId": "lp2", "roomTypes": [
            {"offerId": "o3", "offerRetailRate": {"amount": 4200.0, "currency": "INR"},
             "rates": [{"name": "Dorm bed", "boardName": "Room Only", "cancellationPolicies": {"refundableTag": "RFN"}}]}]},
        {"hotelId": "lp3", "roomTypes": []},
    ],
    "hotels": [
        {"id": "lp1", "name": "Snow Valley Resort", "main_photo": "https://img.example/lp1.jpg", "thumbnail": "http://img.example/t.jpg",
         "address": "Log Huts Area", "stars": 4, "rating": 8.4, "review_count": 812, "latitude": 32.24, "longitude": 77.18},
        {"id": "lp2", "name": "Old Manali Hostel", "stars": 0, "rating": 9.1, "review_count": 95},
    ],
}  # fmt: skip


def test_rooms_hold_two_and_the_booking_link_carries_dates_and_guests():
    assert liteapi.rooms_for(3) == [{"adults": 2}, {"adults": 1}]
    assert liteapi.rooms_for(0) == [{"adults": 1}]
    url = liteapi.booking_link("https://trips.nuitee.link/", "lp1", "2026-12-14", "2026-12-17", [{"adults": 2}])
    assert url.startswith("https://trips.nuitee.link/hotels/lp1?checkin=2026-12-14&checkout=2026-12-17&occupancies=")
    occ = url.split("occupancies=")[1].replace("%3D", "=")
    assert json.loads(base64.b64decode(occ)) == [{"adults": 2}]
    assert liteapi.booking_link(None, "lp1", "2026-12-14", "2026-12-17", [{"adults": 2}]) is None


def test_each_hotel_shows_its_cheapest_offer_for_the_stay_cheapest_first():
    rooms = [{"adults": 2}]
    hotels = liteapi.parse_rates(RATES, nights=3, site=None, checkin="2026-12-14", checkout="2026-12-17", rooms=rooms)
    assert [h["id"] for h in hotels] == ["lp2", "lp1"]  # a hotel with no offer isn't shown
    lp1 = hotels[1]
    # never shown below the suggested selling price (showing less in public breaks Nuitee's rate rules)
    assert lp1["total"] == 7900.0 and lp1["per_night"] == pytest.approx(2633.33) and lp1["currency"] == "INR"
    assert lp1["board"] == "Room Only" and lp1["refundable"] is False and lp1["stars"] == 4 and lp1["rating"] == 8.4
    assert lp1["photo"] == "https://img.example/lp1.jpg"  # an http-only thumbnail is never used
    assert hotels[0]["refundable"] is True and hotels[0]["photo"] is None


def test_stay_window_and_where_the_days_happen():
    trip = {
        "destinations": [{"id": "a", "start_day": 1, "end_day": 2, "lat": 10, "lng": 20}, {"id": "b", "start_day": 3, "end_day": 4, "lat": 30, "lng": 40}],
        "days": [{"day": 1, "date": "2026-12-14", "destination": "a", "activities": [{"lat": 11, "lng": 21}, {"lat": 13, "lng": 23}]},
                 {"day": 2, "date": "2026-12-15", "destination": "a", "activities": []},
                 {"day": 3, "date": "2026-12-16", "destination": "b", "activities": []},
                 {"day": 4, "date": "2026-12-17", "destination": "b", "activities": []}],
    }  # fmt: skip
    assert liteapi.stay_window(trip, 0) == ("2026-12-14", "2026-12-16")  # moves on the morning after
    assert liteapi.stay_window(trip, 1) == ("2026-12-16", "2026-12-17")  # the last day is the day you leave
    assert liteapi.plan_centre(trip, 0) == (12, 22) and liteapi.plan_centre(trip, 1) == (30, 40)
    assert liteapi.nationality_for("INR") == "IN" and liteapi.nationality_for("EUR") == "IN"


def mock_client(calls, status=200, body=None):
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.headers.get("X-API-Key"), json.loads(request.content)))
        return httpx.Response(status, json=body if body is not None else RATES)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.anyio
async def test_one_search_asks_for_one_rate_per_hotel_and_is_cached():
    calls = []
    live = liteapi.LiteAPI("sand_key", "https://trips.nuitee.link", client=mock_client(calls))
    args = {"lat": 32.2432, "lng": 77.1892, "checkin": "2026-12-14", "checkout": "2026-12-17", "people": 3,
            "currency": "INR", "nationality": "IN"}  # fmt: skip
    first = await live.rates(**args)
    again = await live.rates(**args)
    assert len(calls) == 1 and again["cached"] is True  # the second look within 30 minutes costs no search
    key, body = calls[0]
    assert key == "sand_key"
    assert body["occupancies"] == [{"adults": 2}, {"adults": 1}] and body["maxRatesPerHotel"] == 1
    assert body["includeHotelData"] is True and body["guestNationality"] == "IN" and body["currency"] == "INR"
    assert "placeId" not in body  # the paid Places endpoint is never needed
    assert first["sandbox"] is True and first["rooms"] == 2 and first["nights"] == 3
    assert first["hotels"][0]["book_url"].startswith("https://trips.nuitee.link/hotels/lp2?")


@pytest.mark.anyio
async def test_refusals_and_busy_signals_read_plainly():
    for status, words in ((401, "key was refused"), (429, "busy"), (500, "error 500")):
        live = liteapi.LiteAPI("sand_key", client=mock_client([], status=status, body={"error": {}}))
        with pytest.raises(liteapi.LiveRatesError, match=words):
            await live.rates(
                lat=1, lng=2, checkin="2026-12-14", checkout="2026-12-15", people=2, currency="INR", nationality="IN"
            )


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def client(settings):
    app = create_app(settings, llm_factory=lambda _: ScriptedLLM(), tools=FakeTools())
    with TestClient(app) as c:
        yield c, app


def test_the_trip_page_gets_live_prices_for_its_own_dates(client):
    c, app = client
    h = {"X-Trip-Owner": c.post("/api/trips/owner").json()["token"]}
    trip = c.post("/api/trips", json={"destinations": [{"name": "Lisbon", "days": 3}], "start_date": "2030-05-01",
                                      "travellers": 2, "currency": "INR"}, headers=h).json()  # fmt: skip
    url = f"/api/trips/{trip['id']}/stays/live"
    assert c.get(url, headers=h).status_code == 503  # no key: off, and it says so
    calls = []
    app.state.trips.live = liteapi.LiteAPI("sand_key", "https://trips.nuitee.link", client=mock_client(calls))
    r = c.get(url, headers=h)
    assert r.status_code == 200, r.text
    got = r.json()
    assert (got["checkin"], got["checkout"]) == ("2030-05-01", "2030-05-03") and got["sandbox"] is True
    assert calls[0][1]["currency"] == "INR" and calls[0][1]["guestNationality"] == "IN"
    assert "sand_key" not in r.text  # the key never reaches the browser
    undated = c.post("/api/trips", json={"destinations": [{"name": "Lisbon", "days": 2}]}, headers=h).json()
    assert c.get(f"/api/trips/{undated['id']}/stays/live", headers=h).status_code == 422
