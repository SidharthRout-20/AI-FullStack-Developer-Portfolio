"""TripWeaver travel ecosystem: pure rules + end-to-end API journeys (fake providers, scripted model, no network)."""

from __future__ import annotations

import datetime as dt
import json
import re

import httpx
import pytest
from fastapi.testclient import TestClient

from safarnama import logic as trip_logic
from safarnama.main import create_app
from tests.conftest import PLAN, REPLAN, TRIP_REQ, FakeTools, parse_sse

LEGS_REQ = {**TRIP_REQ, "days": 4, "legs": [{"destination": "Lisbon", "country": "Portugal", "days": 2},
                                            {"destination": "Porto", "country": "Portugal", "days": 2}]}  # fmt: skip
PLAN4 = {**PLAN, "days": [*PLAN["days"],
         {"day": 3, "theme": "Ribeira", "activities": [{"time": "10:00", "name": "Livraria Lello", "kind": "indoor"}]},
         {"day": 4, "theme": "Douro", "activities": [{"time": "10:00", "name": "Ponte Luís I", "kind": "outdoor"}]}]}  # fmt: skip
SPECIALITIES = {"items": [{"name": "Azulejo tiles", "kind": "craft", "why": "Lisbon's painted tiles.",
                           "search_terms": ["azulejo"]}]}  # fmt: skip
IDEAS = {"ideas": [{"destination": "Seville", "why": "Tiles, food markets and viewpoints, like Lisbon."}]}

TAGS = {
    "food": [{"name": "Tasca do Chico", "amenity": "restaurant", "cuisine": "portuguese", "reservation": "recommended",
              "opening_hours": "Mo-Su 12:00-23:00", "website": "https://tasca.example", "phone": "+351 21 000 0000"},
             {"name": "Green Bowl", "amenity": "restaurant", "cuisine": "vegan", "diet:vegan": "only"},
             {"name": "Bifana Stand", "amenity": "fast_food", "website": "javascript:alert(1)"}],
    "shopping": [{"name": "Azulejo Atelier", "shop": "craft", "website": "https://azulejo.example"},
                 {"name": "Mercado da Ribeira", "amenity": "marketplace"}, {"name": "Conserveira", "shop": "deli"}],
    "indoor": [{"name": "Museu do Azulejo", "tourism": "museum", "opening_hours": "Tu-Su 10:00-18:00"},
               {"name": "Cinema Ideal", "amenity": "cinema"}],
    "airports": [{"name": "Humberto Delgado Airport", "aeroway": "aerodrome", "iata": "LIS"}],
    "transport": [{"name": "Rossio", "railway": "station"}],
    "sights": [{"name": "Miradouro da Graça", "tourism": "viewpoint", "fee": "no"}],
}  # fmt: skip


class Tools(FakeTools):
    def __init__(self):
        self.discover_calls = 0

    async def geocode_city(self, name, country):
        if name.lower().startswith("porto"):
            return {"name": "Porto", "country": "Portugal", "lat": 41.15, "lng": -8.61, "timezone": "Europe/Lisbon"}
        return await super().geocode_city(name, country)

    async def discover(self, lat, lng, group, radius=None):
        self.discover_calls += 1
        rows = TAGS.get(group, TAGS["sights"])
        return [trip_logic.place_from(t, lat + 0.001 * (i + 1), lng, (lat, lng), f"node/{group}{i}")
                for i, t in enumerate(rows)]  # fmt: skip

    async def forecast_detail(self, lat, lng, tz):
        daily = await self.forecast(lat, lng, tz)
        hourly = {"2030-05-01": [[h, 90 if 13 <= h <= 17 else 10] for h in range(24)]}
        return {"daily": daily, "hourly": hourly,
                "current": {"temp": 17, "feels": 16, "precipitation": 0, "code": 3, "wind": 12,
                            "observed_at": "2030-05-01T09:00"}}  # fmt: skip

    async def fx(self, base, quote):
        return {"rate": 0.9, "date": "2030-04-30", "from": base, "to": quote, "source": "Frankfurter reference rates"} \
            if base == "USD" else None  # fmt: skip


class LLM:
    """Scripted model for the TripWeaver prompts (recognised by their system prompt)."""

    def __init__(self, trip_req=TRIP_REQ, plan=PLAN):
        self.trip_req, self.plan, self.prompts = trip_req, plan, []

    async def complete(self, system, messages, *, short=False):
        prompt = messages[-1]["content"]
        self.prompts.append((system or "")[:60])
        s = (system or "").lower()
        if "extract a trip request" in s:
            return json.dumps(self.trip_req)
        if "travel planner" in s:
            return json.dumps(self.plan)
        if "revise an existing itinerary" in s:
            return json.dumps(REPLAN)
        if "distinctive to buy" in s:
            return json.dumps(SPECIALITIES)
        if "future trips" in s:
            return json.dumps(IDEAS)
        if "travel companion" in s:
            stop = re.search(r"'id': '([0-9a-f]{12})', 'time': '(\d\d:\d\d)'", prompt)
            return json.dumps({"reply": "Rain is likely from 13:00, so see the viewpoint first, then lunch nearby.",
                               "suggestions": [
                                   {"action": "add_stop", "place_ref": "P1", "day": 1, "time": "12:30", "why": "close"},
                                   {"action": "add_stop", "place_ref": "P99", "day": 1, "why": "invented place"},
                                   {"action": "move_earlier", "activity_id": stop[1] if stop else None, "time": "08:00",
                                    "why": "beat the rain"},
                                   {"action": "open_link", "place_ref": "P1", "why": "book a table"},
                                   {"action": "book_now", "place_ref": "P1", "why": "not an allowed action"}]})  # fmt: skip
        return "{}"

    async def stream(self, system, messages):
        yield await self.complete(system, messages)


def client_for(settings, llm=None):
    llm = llm or LLM()
    app = create_app(settings, llm_factory=lambda _: llm)
    return app, llm


@pytest.fixture
def env(settings):
    app, llm = client_for(settings)
    with TestClient(app) as c:
        app.state.trips.tools = Tools()
        yield c, app


def owner(c):
    return {"X-Trip-Owner": c.post("/api/trips/owner").json()["token"]}


def plan_trip(c, h, prompt="2 days in Lisbon from May 1 2030, love food"):
    events = parse_sse(c.post("/api/trips/plan", json={"prompt": prompt}, headers=h).text)
    assert events[-1][0] == "done", events[-1]
    return events[-1][1]["trip"]


def manual(c, h, **kw):
    body = {"destinations": [{"name": "Lisbon", "days": 2}, {"name": "Porto", "days": 2}], "start_date": "2030-05-01",
            "party": "family", "travellers": 4, "budget": 1000, "currency": "EUR", "interests": ["food"], **kw}  # fmt: skip
    r = c.post("/api/trips", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


# ── pure rules ──────────────────────────────────────────────────────────────
def test_budget_summary_keeps_estimates_apart_and_never_guesses_conversions():
    budget = {"total": 1000, "currency": "EUR", "categories": {"food": 300}}
    ex = [
        {"id": "a", "amount": 100, "currency": "EUR", "category": "food", "kind": "actual", "paid_by": "Ann",
         "split_between": ["Ann", "Ben"], "day": 1},
        {"id": "b", "amount": 50, "currency": "USD", "category": "transport", "kind": "actual", "paid_by": "Ben",
         "fx": {"rate": 0.9, "from": "USD", "to": "EUR", "date": "2030-04-30"}, "split_between": ["Ann", "Ben"]},
        {"id": "c", "amount": 200, "currency": "EUR", "category": "lodging", "kind": "estimate"},
        {"id": "d", "amount": 30, "currency": "GBP", "category": "food", "kind": "actual"},
    ]  # fmt: skip
    s = trip_logic.budget_summary(budget, ex)
    assert s["actual_total"] == 145 and s["estimated_total"] == 200
    assert s["remaining"] == 855 and s["remaining_after_estimates"] == 655 and s["unconverted"] == ["d"]
    assert s["by_category"]["food"] == {"budget": 300, "actual": 100, "estimated": 0}
    assert s["balances"] == {"Ann": 27.5, "Ben": -27.5}
    assert s["settlements"] == [{"from": "Ben", "to": "Ann", "amount": 27.5}]


def test_weather_windows_and_alerts():
    hourly = [[h, 90 if 13 <= h <= 17 else 10] for h in range(24)]
    assert trip_logic.driest_window(hourly) == {"from": "08:00", "to": "11:00", "rain": 10}
    assert trip_logic.rain_spells(hourly) == [{"from": "13:00", "to": "18:00", "max": 90}]
    alerts = trip_logic.weather_alerts({"weather": {"rain": 85, "tmax": 37, "tmin": 22, "wind_max": 60}})
    assert {a["type"] for a in alerts} == {"heavy_rain", "heat", "wind"}


def test_labels_are_evidence_backed_and_never_invent_popularity():
    day = {"date": "2030-05-06", "weather": {"rain": 70, "tmax": 20}}  # a Monday
    museum = {"id": "m", "name": "Museu", "kind": "indoor", "time": "16:30", "duration_min": 90,
              "opening_hours": "Mo-Su 10:00-17:30", "reservation": "required", "votes": {"a": 1, "b": 1}}  # fmt: skip
    labels = {x["id"]: x for x in trip_logic.stop_labels(museum, day)}
    assert set(labels) == {"time_sensitive", "reservation_recommended", "traveller_favourite"}
    assert labels["time_sensitive"]["source"] == "OpenStreetMap" and "17:30" in labels["time_sensitive"]["evidence"]
    park = {"id": "p", "name": "Park", "kind": "outdoor", "time": "10:00", "priority": "must", "tags": ["hidden_gem"]}
    ids = {x["id"]: x["source"] for x in trip_logic.stop_labels(park, day)}
    assert ids == {"must_visit": "you", "hidden_gem": "you", "weather_dependent": "Open-Meteo forecast"}
    bare = {"id": "x", "name": "X", "kind": "indoor", "time": "10:00"}
    assert trip_logic.stop_labels(bare, day) == []  # no data → no "local favourite"/"hidden gem" guesses


def test_schedule_validation():
    day = {"date": "2030-05-06", "route": {"legs": [{"to": "b", "minutes": 30}]}, "activities": [
        {"id": "a", "name": "A", "time": "09:00", "duration_min": 120, "lat": 1, "lng": 1},
        {"id": "b", "name": "B", "time": "11:00", "duration_min": 60, "lat": 1, "lng": 1,
         "opening_hours": "Mo-Su 12:00-18:00"},
        {"id": "c", "name": "C", "time": "23:00", "duration_min": 60, "lat": None, "lng": None, "kind": "indoor"}]}  # fmt: skip
    kinds = {(i["type"], i["activity_id"]) for i in trip_logic.validate_day(day)}
    assert {("overlap", "b"), ("closed", "b"), ("late", "c"), ("unlocated", "c")} <= kinds


def test_handoff_links_only_from_provider_data():
    p = trip_logic.place_from({"name": "X", "amenity": "restaurant", "website": "javascript:alert(1)",
                               "website:menu": "https://x.example/menu"}, 1.0, 2.0, (1.0, 2.0), "node/1")  # fmt: skip
    kinds = [link["kind"] for link in p["links"]]
    assert kinds == ["menu", "map"] and p["website"] is None


def test_suggestions_are_validated_against_real_candidates():
    trip = {"days": [{"day": 1, "activities": [{"id": "s1", "name": "Castle", "time": "14:00", "lat": 1, "lng": 1}]}]}
    place = trip_logic.place_from({"name": "Tasca", "amenity": "restaurant", "website": "https://t.example"},
                                  1.001, 1.0, (1, 1), "node/1")  # fmt: skip
    raw = [{"action": "add_stop", "place_ref": "P1", "day": 1, "time": "12:30"},
           {"action": "add_stop", "place_ref": "P7"}, {"action": "move_earlier", "activity_id": "s1", "time": "15:00"},
           {"action": "move_earlier", "activity_id": "s1", "time": "09:00"}, {"action": "pay", "place_ref": "P1"},
           {"action": "open_link", "place_ref": "P1"}]  # fmt: skip
    out = trip_logic.validate_suggestions(raw, {"P1": place}, trip, trip["days"][0]["activities"][0])
    assert [s["action"] for s in out] == ["add_stop", "move_earlier", "open_link"]
    assert out[0]["route"]["estimate"] is True and out[1]["time"] == "09:00" and out[2]["external"] is True
    assert all(s["confirm"] for s in out)


def test_phase_and_packing_list():
    trip = {"days": [{"date": "2030-05-01", "weather": {"rain": 80, "tmax": 31, "tmin": 9},
                      "activities": [{"kind": "outdoor"}]}], "party": {"type": "family"}}  # fmt: skip
    assert trip_logic.phase(trip, dt.date(2030, 4, 1)) == "upcoming"
    assert trip_logic.phase(trip, dt.date(2030, 5, 1)) == "active"
    assert trip_logic.phase({**trip, "status": "archived"}, dt.date(2030, 5, 1)) == "archived"
    items = [i["text"] for i in trip_logic.packing_list(trip)]
    assert "Umbrella or rain jacket" in items and "Sunscreen and hat" in items and "Warm layer" in items
    assert any("kids" in i.lower() for i in items)


# ── API journeys ────────────────────────────────────────────────────────────
def test_ownership_roles_and_legacy_trips(env):
    c, app = env
    assert c.post("/api/trips/plan", json={"prompt": "2 days in Lisbon please"}).status_code == 401
    alice, bob = owner(c), owner(c)
    trip = plan_trip(c, alice)
    assert "owner" not in trip and trip["share_key"] and trip["role"] == "owner"
    tid = trip["id"]
    assert c.get(f"/api/trips/{tid}", headers=bob).status_code == 404  # invisible to other owners
    assert c.get(f"/api/trips/{tid}").status_code == 404
    assert [t["id"] for t in c.get("/api/trips", headers=alice).json()] == [tid]
    assert c.get("/api/trips", headers=bob).json() == []

    member = {"X-Trip-Share": trip["share_key"]}
    view = c.get(f"/api/trips/{tid}", headers=member).json()
    assert view["role"] == "member" and "share_key" not in view and "companion" not in view
    act = view["days"][1]["activities"][0]["id"]
    assert c.post(f"/api/trips/{tid}/votes", json={"activity_id": act, "voter": "Sam", "value": 1},
                  headers=member).status_code == 200  # fmt: skip
    assert c.post(f"/api/trips/{tid}/replan", json={"event": "rain on day 1"}, headers=member).status_code == 403
    assert c.get(f"/api/trips/{tid}/bookings", headers=member).status_code == 403
    assert c.get(f"/api/trips/{tid}/documents", headers=member).status_code == 403
    assert c.delete(f"/api/trips/{tid}", headers=member).status_code == 403
    rotated = c.post(f"/api/trips/{tid}/share/rotate", headers=alice).json()
    assert c.get(f"/api/trips/{tid}", headers=member).status_code == 404  # old link revoked
    assert c.get(f"/api/trips/{tid}", headers={"X-Trip-Share": rotated["share_key"]}).status_code == 200

    legacy = app.state.trips.db.put("trips", {k: v for k, v in trip.items() if k not in ("id", "role", "phase")}
                                          | {"owner": None, "title": "Old trip"})  # fmt: skip
    assert c.get(f"/api/trips/{legacy['id']}").json()["role"] == "legacy"  # still viewable by link
    r = c.post(f"/api/trips/{legacy['id']}/replan", json={"event": "rain on day 1"}, headers=bob)
    assert r.status_code == 403 and "copy" in r.json()["detail"]
    copy = c.post(f"/api/trips/{legacy['id']}/copy", headers=bob).json()
    assert copy["role"] == "owner" and copy["title"] == "Old trip (copy)"
    assert c.get(f"/api/trips/{legacy['id']}").status_code == 200  # the historical record is kept


def test_manual_multi_destination_trip_and_settings(env):
    c, _ = env
    h = owner(c)
    trip = manual(c, h, title="Portugal with the kids")
    assert [d["name"] for d in trip["destinations"]] == ["Lisbon", "Porto"]
    assert [d["date"] for d in trip["days"]] == ["2030-05-01", "2030-05-02", "2030-05-03", "2030-05-04"]
    lisbon, porto = trip["destinations"]
    assert [d["destination"] for d in trip["days"]] == [lisbon["id"], lisbon["id"], porto["id"], porto["id"]]
    assert trip["days"][0]["weather"]["rain"] == 80 and trip["weather_updated_at"]
    assert trip["party"] == {"type": "family", "travellers": 4} and trip["budget"]["total"] == 1000
    assert trip["phase"] == "upcoming"
    tid = trip["id"]
    more = c.post(f"/api/trips/{tid}/destinations", json={"name": "Lisbon", "days": 1}, headers=h).json()
    assert len(more["days"]) == 5 and more["days"][4]["date"] == "2030-05-05"
    upd = c.patch(f"/api/trips/{tid}", json={"budget": 1500, "currency": "EUR", "status": "archived"}, headers=h).json()
    assert upd["budget"]["total"] == 1500 and upd["phase"] == "archived"
    assert c.post("/api/trips", json={"destinations": [{"name": "Lisbon", "days": 10}, {"name": "Porto", "days": 5}]},
                  headers=h).status_code == 422  # fmt: skip


def test_ai_plan_with_two_destinations(settings):
    app, _ = client_for(settings, LLM(trip_req=LEGS_REQ, plan=PLAN4))
    with TestClient(app) as c:
        app.state.trips.tools = Tools()
        trip = plan_trip(c, owner(c), "4 days: Lisbon then Porto from May 1 2030")
    assert [d["name"] for d in trip["destinations"]] == ["Lisbon", "Porto"]
    porto = trip["destinations"][1]
    assert [d["destination"] == porto["id"] for d in trip["days"]] == [False, False, True, True]
    lello = trip["days"][2]["activities"][0]
    assert abs(lello["lat"] - 41.16) < 0.02  # geocoded near Porto, not Lisbon


def test_itinerary_editing_labels_pins_and_section_regeneration(env):
    c, _ = env
    h = owner(c)
    trip = plan_trip(c, h)
    tid = trip["id"]
    castle = trip["days"][0]["activities"][0]
    assert "weather_dependent" in {x["id"] for x in castle["labels"]}  # outdoor + 80% rain
    t = c.patch(f"/api/trips/{tid}/activities/{castle['id']}", json={"priority": "must", "pinned": True,
                "tags": ["hidden_gem"], "time": "08:30"}, headers=h).json()  # fmt: skip
    c1 = next(a for a in t["days"][0]["activities"] if a["id"] == castle["id"])
    assert c1["time"] == "08:30" and {"must_visit", "hidden_gem"} <= {x["id"] for x in c1["labels"]}
    assert (
        c.patch(f"/api/trips/{tid}/activities/{castle['id']}", json={"tags": ["popular"]}, headers=h).status_code == 422
    )

    t = c.post(f"/api/trips/{tid}/days/2/stops", json={"name": "Torre de Belém", "time": "15:00"}, headers=h).json()
    tower = next(a for a in t["days"][1]["activities"] if a["name"] == "Torre de Belém")
    assert tower["lat"] is not None and tower["added"] == "manual"
    t = c.post(f"/api/trips/{tid}/activities/{tower['id']}/move", json={"day": 1, "index": 0}, headers=h).json()
    assert tower["id"] in [a["id"] for a in t["days"][0]["activities"]]
    t = c.delete(f"/api/trips/{tid}/activities/{tower['id']}", headers=h).json()
    assert tower["id"] not in [a["id"] for d in t["days"] for a in d["activities"]]

    day2_before = t["days"][1]["activities"]
    assert c.post(f"/api/trips/{tid}/replan", json={"event": "Heavy rain", "days": [2]}, headers=h).status_code == 422
    out = c.post(f"/api/trips/{tid}/replan", json={"event": "Heavy rain on day 1", "days": [1]}, headers=h).json()
    names = [a["name"] for a in out["trip"]["days"][0]["activities"]]
    assert "Gulbenkian Museum" in names and "Castelo de São Jorge" in names  # pinned stop survives the re-plan
    assert [a["id"] for a in out["trip"]["days"][1]["activities"]] == [a["id"] for a in day2_before]


def test_discovery_food_shopping_saved_places_and_add_to_itinerary(env):
    c, _ = env
    h = owner(c)
    trip = plan_trip(c, h)
    tid, stop = trip["id"], trip["days"][0]["activities"][0]
    food = c.get(f"/api/trips/{tid}/discover", params={"group": "food", "activity_id": stop["id"]}, headers=h).json()
    assert food["source"].startswith("OpenStreetMap") and "Ratings" in food["note"]
    tasca = next(p for p in food["places"] if p["name"] == "Tasca do Chico")
    assert {link["kind"] for link in tasca["links"]} >= {"website", "phone", "map"}
    bifana = next(p for p in food["places"] if p["name"] == "Bifana Stand")
    assert all(link["kind"] == "map" for link in bifana["links"])  # unsafe URL from the data is not offered
    vegan = c.get(f"/api/trips/{tid}/discover", params={"group": "food", "activity_id": stop["id"], "vegan": True},
                  headers=h).json()  # fmt: skip
    assert [p["name"] for p in vegan["places"]] == ["Green Bowl"]
    shops = c.get(f"/api/trips/{tid}/discover", params={"group": "shopping"}, headers=h).json()
    assert {"Azulejo Atelier", "Mercado da Ribeira"} <= {p["name"] for p in shops["places"]}
    assert c.get(f"/api/trips/{tid}/discover", params={"group": "teleport"}, headers=h).status_code == 422

    body = {k: tasca[k] for k in ("name", "group", "category", "lat", "lng", "cuisine", "website", "osm_id",
                                  "reservation", "opening_hours")}  # fmt: skip
    saved = c.post(f"/api/trips/{tid}/places", json=body, headers=h)
    assert saved.status_code == 201 and saved.json()["links"]
    assert c.post(f"/api/trips/{tid}/places", json=body, headers=h).json()["id"] == saved.json()["id"]  # no duplicates
    assert len(c.get(f"/api/trips/{tid}/places", headers=h).json()) == 1
    again = c.get(f"/api/trips/{tid}/discover", params={"group": "food", "activity_id": stop["id"]}, headers=h).json()
    assert next(p for p in again["places"] if p["name"] == "Tasca do Chico")["saved"] is True

    stop_in = {**{k: tasca[k] for k in ("name", "lat", "lng", "website", "reservation", "opening_hours")},
               "kind": "food", "time": "12:30", "distance_m": tasca["distance_m"], "near": stop["name"],
               "added": "discovery", "osm_id": tasca["osm_id"]}  # fmt: skip
    t = c.post(f"/api/trips/{tid}/days/1/stops", json=stop_in, headers=h).json()
    added = next(
        a for a in t["days"][0]["activities"] if a["name"] == "Tasca do Chico" and a.get("added") == "discovery"
    )
    assert {"near_route", "reservation_recommended"} <= {x["id"] for x in added["labels"]}


def test_weather_freshness_current_conditions_and_indoor_alternatives(env):
    c, _ = env
    h = owner(c)
    trip = plan_trip(c, h)
    tid, castle = trip["id"], trip["days"][0]["activities"][0]
    wx = c.post(f"/api/trips/{tid}/weather-check", headers=h).json()
    t = wx["trip"]
    assert wx["alerts"][0]["day"] == 1 and t["weather_updated_at"]
    now = next(iter(t["weather_now"].values()))
    assert now["temp"] == 17 and now["fetched_at"] and now["observed_at"] == "2030-05-01T09:00"
    assert t["days"][0]["best_window"] == {"from": "08:00", "to": "11:00", "rain": 10}
    assert t["days"][0]["rain_spells"][0]["from"] == "13:00"
    alt = c.get(f"/api/trips/{tid}/activities/{castle['id']}/alternatives", headers=h).json()
    assert [p["name"] for p in alt["places"]] == ["Museu do Azulejo", "Cinema Ideal"] and alt[
        "source"
    ] == "OpenStreetMap"


def test_bookings_are_records_not_transactions(env):
    c, _ = env
    h = owner(c)
    trip = plan_trip(c, h)
    tid, act = trip["id"], trip["days"][0]["activities"][0]
    b = {"type": "train", "title": "Lisbon → Sintra", "provider": "CP", "reference": "AB12", "start": "2030-05-01T08:10",
         "day": 1, "activity_id": act["id"], "cost": 9.5, "currency": "EUR", "add_expense": True,
         "cancellation": "Refundable until departure"}  # fmt: skip
    r = c.post(f"/api/trips/{tid}/bookings", json=b, headers=h)
    assert r.status_code == 201 and r.json()["recorded_by"] == "you"
    exp = c.get(f"/api/trips/{tid}/expenses", headers=h).json()
    assert exp[0]["category"] == "transport" and exp[0]["kind"] == "actual" and exp[0]["booking_id"] == r.json()["id"]
    assert c.post(f"/api/trips/{tid}/bookings", json={**b, "activity_id": "nope"}, headers=h).status_code == 404
    assert c.post(f"/api/trips/{tid}/bookings", json={**b, "url": "javascript:x"}, headers=h).status_code == 422
    upd = c.patch(f"/api/trips/{tid}/bookings/{r.json()['id']}", json={"status": "cancelled"}, headers=h).json()
    assert upd["status"] == "cancelled"
    assert c.delete(f"/api/trips/{tid}/bookings/{r.json()['id']}", headers=h).status_code == 204


def test_expenses_budget_currency_and_group_split(env):
    c, _ = env
    h = owner(c)
    trip = manual(c, h)
    tid = trip["id"]
    member = {"X-Trip-Share": trip["share_key"]}
    c.post(f"/api/trips/{tid}/expenses", json={"amount": 100, "currency": "EUR", "category": "food", "paid_by": "Ann",
                                              "split_between": ["Ann", "Ben"], "day": 1}, headers=h)  # fmt: skip
    usd = c.post(f"/api/trips/{tid}/expenses", json={"amount": 50, "currency": "USD", "category": "transport",
                                                    "paid_by": "Ben", "split_between": ["Ann", "Ben"]}, headers=member)  # fmt: skip
    assert usd.status_code == 201 and usd.json()["fx"]["rate"] == 0.9 and usd.json()["added_by"] == "member"
    c.post(f"/api/trips/{tid}/expenses", json={"amount": 200, "currency": "EUR", "category": "lodging",
                                              "kind": "estimate"}, headers=h)  # fmt: skip
    gbp = c.post(f"/api/trips/{tid}/expenses", json={"amount": 30, "currency": "GBP"}, headers=h).json()
    assert gbp["fx"] is None  # no reference rate available → not converted, not guessed
    manual_rate = c.post(f"/api/trips/{tid}/expenses", json={"amount": 10, "currency": "GBP", "rate": 1.2}, headers=h)
    assert manual_rate.json()["fx"]["source"] == "entered by you"
    s = c.get(f"/api/trips/{tid}/budget", headers=member).json()
    assert s["actual_total"] == 157 and s["estimated_total"] == 200 and s["remaining"] == 843
    assert s["remaining_after_estimates"] == 643 and s["unconverted"] == [gbp["id"]]
    assert s["settlements"] == [{"from": "Ben", "to": "Ann", "amount": 27.5}]
    assert c.post(f"/api/trips/{tid}/expenses", json={"amount": -5, "currency": "EUR"}, headers=h).status_code == 422
    assert c.delete(f"/api/trips/{tid}/expenses/{gbp['id']}", headers=member).status_code == 403
    assert c.get(f"/api/trips/{tid}/fx", params={"base": "USD", "quote": "EUR"}, headers=h).json()["rate"] == 0.9
    assert c.get(f"/api/trips/{tid}/fx", params={"base": "GBP", "quote": "EUR"}, headers=h).status_code == 502


def test_documents_files_and_checklists_are_private(env):
    c, _ = env
    h = owner(c)
    trip = manual(c, h)
    tid = trip["id"]
    doc = c.post(f"/api/trips/{tid}/documents", json={"kind": "insurance", "title": "Policy", "body": "No. 123"},
                 headers=h).json()  # fmt: skip
    up = c.post(f"/api/trips/{tid}/documents/{doc['id']}/file?name=policy.pdf", content=b"%PDF-1.4 test",
                headers={**h, "Content-Type": "application/pdf"})  # fmt: skip
    assert up.status_code == 200 and up.json()["file"]["size"] == 13
    got = c.get(f"/api/trips/{tid}/documents/{doc['id']}/file", headers=h)
    assert got.content == b"%PDF-1.4 test" and "attachment" in got.headers["content-disposition"]
    assert c.post(f"/api/trips/{tid}/documents/{doc['id']}/file", content=b"x" * 1_000_001,
                  headers={**h, "Content-Type": "application/pdf"}).status_code == 413  # fmt: skip
    assert c.post(f"/api/trips/{tid}/documents/{doc['id']}/file", content=b"MZ",
                  headers={**h, "Content-Type": "application/x-msdownload"}).status_code == 415  # fmt: skip
    other = owner(c)
    assert c.get(f"/api/trips/{tid}/documents/{doc['id']}/file", headers=other).status_code == 404
    assert c.get(f"/api/trips/{tid}/documents", headers={"X-Trip-Share": trip["share_key"]}).status_code == 403

    t = c.post(f"/api/trips/{tid}/checklists/packing", headers=h).json()
    packing = t["checklists"][0]
    assert packing["kind"] == "packing" and "Umbrella or rain jacket" in [i["text"] for i in packing["items"]]
    packing["items"][0]["done"] = True
    t = c.put(f"/api/trips/{tid}/checklists", json={"checklists": [packing]}, headers=h).json()
    assert t["checklists"][0]["items"][0]["done"] is True
    assert c.delete(f"/api/trips/{tid}", headers=h).status_code == 204
    assert c.get(f"/api/trips/{tid}/documents/{doc['id']}/file", headers=h).status_code == 404


def test_companion_uses_trip_context_and_only_real_confirmable_actions(env):
    c, app = env
    h = owner(c)
    trip = plan_trip(c, h)
    tid = trip["id"]
    c.post(f"/api/trips/{tid}/weather-check", headers=h)
    r = c.post(f"/api/trips/{tid}/companion", json={"message": "What should we do nearby before the rain?",
               "local_time": "2030-05-01T07:30", "lat": 38.73, "lng": -9.13}, headers=h)  # fmt: skip
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["ai_generated"] and out["context"]["near"] == "your location" and out["context"]["now"]["day"] == 1
    actions = [s["action"] for s in out["suggestions"]]
    assert actions == ["add_stop", "move_earlier", "open_link"]  # invented place and unknown action dropped
    add = out["suggestions"][0]
    assert add["place"]["source"] == "OpenStreetMap" and add["route"]["estimate"] and add["confirm"]
    assert out["suggestions"][2]["external"] is True and out["suggestions"][2]["link"]["url"].startswith("https://")
    assert c.get(f"/api/trips/{tid}/bookings", headers=h).json() == []  # nothing was booked or ordered
    full = c.get(f"/api/trips/{tid}", headers=h).json()
    assert [m["role"] for m in full["companion"]] == ["user", "assistant"]
    assert "companion" not in c.get(f"/api/trips/{tid}", headers={"X-Trip-Share": full["share_key"]}).json()


def test_specialities_receipts_transport_summary_and_ideas(env):
    c, app = env
    h = owner(c)
    trip = plan_trip(c, h)
    tid = trip["id"]
    sp = c.post(f"/api/trips/{tid}/specialities", headers=h).json()
    assert sp["ai_generated"] and sp["items"][0]["shops"] == ["Azulejo Atelier"]
    assert c.post(f"/api/trips/{tid}/specialities", headers=h).json()["generated_at"] == sp["generated_at"]  # cached

    svc = app.state.trips

    async def reader(req):
        class R:
            text = '{"merchant": "Tasca do Chico", "amount": 42.5, "currency": "EUR", "date": "2030-05-01", "category": "food"}'
            model = "qwen/qwen3.8-27b"

        assert req.task == "tripweaver.receipt" and req.images
        return R()

    svc.receipt_reader = reader
    scan = c.post(
        f"/api/trips/{tid}/expenses/scan", content=b"\xff\xd8\xff fake", headers={**h, "Content-Type": "image/jpeg"}
    )
    assert scan.json()["draft"]["amount"] == 42.5 and scan.json()["ai_generated"]
    assert c.get(f"/api/trips/{tid}/expenses", headers=h).json() == []  # a draft, not saved
    assert (
        c.post(f"/api/trips/{tid}/expenses/scan", content=b"x", headers={**h, "Content-Type": "text/plain"}).status_code
        == 415
    )

    tr = c.get(f"/api/trips/{tid}/transport", headers=h).json()
    assert tr["airports"][0]["iata"] == "LIS" and tr["airports"][0]["transfer"]["drive_min"] == 25
    s = c.get(f"/api/trips/{tid}/summary", headers=h).json()
    assert s["days"] == 2 and s["stops"] >= 2 and s["destinations"] == ["Lisbon"]
    ideas = c.post(f"/api/trips/{tid}/next-ideas", headers=h).json()
    assert ideas["ai_generated"] and ideas["ideas"][0]["destination"] == "Seville"


def test_provider_failure_is_reported_not_faked(env):
    c, app = env
    h = owner(c)
    trip = plan_trip(c, h)

    class Down(Tools):
        async def discover(self, lat, lng, group, radius=None):
            raise httpx.ConnectError("overpass down")

    app.state.trips.tools = Down()
    r = c.get(f"/api/trips/{trip['id']}/discover", params={"group": "food"}, headers=h)
    assert r.status_code == 502 and "busy" in r.json()["detail"]


def test_passenger_airports_exclude_military_and_private_fields():
    o = (38.7, -9.1)
    places = [
        trip_logic.place_from({"name": "Base Aérea 6", "aeroway": "aerodrome", "iata": "XXX", "military": "airfield"}, 38.70, -9.0, o, "a"),
        trip_logic.place_from({"name": "Private strip", "aeroway": "aerodrome", "iata": "YYY", "aerodrome:type": "private"}, 38.71, -9.1, o, "b"),
        trip_logic.place_from({"name": "Regional", "aeroway": "aerodrome", "iata": "RRR", "aerodrome:type": "regional"}, 38.72, -9.1, o, "c"),
        trip_logic.place_from({"name": "Lisbon Airport", "aeroway": "aerodrome", "iata": "LIS", "aerodrome:type": "international"}, 38.77, -9.13, o, "d"),
    ]  # fmt: skip
    assert [p["name"] for p in trip_logic.passenger_airports(places)] == ["Lisbon Airport", "Regional"]


def test_no_forecast_time_when_no_forecast_covers_the_dates(env):
    c, _ = env
    trip = manual(c, owner(c), start_date="2031-01-01")  # the fake provider only forecasts May 2030
    assert all(d["weather"] is None for d in trip["days"]) and trip["weather_updated_at"] is None


def test_companion_reply_hides_internal_place_refs():
    cands = {"P1": {"name": "Café Lisboa"}, "P12": {"name": "Museu"}}
    assert (
        trip_logic.strip_refs("Try Café Lisboa (P1), then P12 if it rains.", cands)
        == "Try Café Lisboa, then Museu if it rains."
    )


def test_trip_currency_follows_the_destination_country():
    assert trip_logic.currency_for("India") == "INR"
    assert trip_logic.currency_for(" japan ") == "JPY"
    assert trip_logic.currency_for("Portugal") == "EUR"
    assert trip_logic.currency_for("Atlantis") == "EUR"  # unknown → the fallback, never a guess
    assert trip_logic.currency_for(None, fallback="USD") == "USD"


def test_quick_planner_choices_win_over_the_model(env):
    c, _ = env
    h = owner(c)
    prompt = "2 days in Lisbon, Portugal, from 2030-05-01 to 2030-05-02, for a family with kids (4 travellers)."
    events = parse_sse(
        c.post("/api/trips/plan", json={"prompt": prompt, "party": "family", "travellers": 4}, headers=h).text
    )
    trip = events[-1][1]["trip"]
    assert trip["party"] == {"type": "family", "travellers": 4}
    assert trip["budget"]["currency"] == "EUR"  # Lisbon → Portugal → euro
    bad = c.post("/api/trips/plan", json={"prompt": prompt, "party": "everyone"}, headers=h)
    assert bad.status_code == 422


def test_manual_trip_without_a_currency_uses_the_local_one(env):
    c, _ = env
    h = owner(c)
    r = c.post("/api/trips", json={"destinations": [{"name": "Lisbon", "days": 2}]}, headers=h)
    assert r.status_code == 201, r.text
    assert r.json()["budget"]["currency"] == "EUR"


def test_a_bookings_cost_follows_the_booking(env):
    c, _ = env
    h = owner(c)
    trip = manual(c, h)
    t = f"/api/trips/{trip['id']}"
    spent = lambda: c.get(f"{t}/budget", headers=h).json()["actual_total"]  # noqa: E731
    estimated = lambda: c.get(f"{t}/budget", headers=h).json()["estimated_total"]  # noqa: E731
    b = c.post(
        f"{t}/bookings",
        json={"type": "hotel", "title": "Haveli", "cost": 300, "add_expense": True, "status": "planned"},
        headers=h,
    ).json()
    assert (spent(), estimated()) == (0, 300)
    c.patch(f"{t}/bookings/{b['id']}", json={"status": "booked"}, headers=h)
    assert (spent(), estimated()) == (300, 0)
    c.patch(f"{t}/bookings/{b['id']}", json={"status": "cancelled"}, headers=h)
    assert (spent(), estimated()) == (0, 0)
    b2 = c.post(
        f"{t}/bookings", json={"type": "flight", "title": "LIS-OPO", "cost": 80, "add_expense": True}, headers=h
    ).json()
    c.post(f"{t}/expenses", json={"amount": 20, "currency": "EUR", "category": "food"}, headers=h)
    assert spent() == 100
    assert c.delete(f"{t}/bookings/{b2['id']}", headers=h).status_code == 204
    assert spent() == 20  # the traveller's own expense stays


def test_generated_titles_follow_added_destinations():
    assert trip_logic.retitle("3 days in Jaipur", ["Jaipur"], ["Jaipur", "Pushkar"], 4) == "4 days in Jaipur → Pushkar"
    assert (
        trip_logic.retitle("Lisbon → Porto", ["Lisbon", "Porto"], ["Lisbon", "Porto", "Braga"], 6)
        == "Lisbon → Porto → Braga"
    )
    assert trip_logic.retitle("Our honeymoon", ["Goa"], ["Goa", "Gokarna"], 6) == "Our honeymoon"
    assert trip_logic.retitle("3 days in Rajasthan", ["Jaipur"], ["Jaipur", "Pushkar"], 4) == "3 days in Rajasthan"


def _tools_with(handler):
    from safarnama.service import Tools

    tools = Tools()
    tools._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return tools


NOMINATIM_ROW = [{"lat": "26.9239", "lon": "75.8267", "display_name": "Hawa Mahal, Jaipur, India"}]


@pytest.mark.parametrize(
    "photon",
    [
        httpx.Response(429, text="Too many requests"),  # throttled (shared hosting IPs)
        httpx.Response(200, text="<html>busy</html>"),  # an error page instead of JSON
        httpx.Response(503, json={"message": "unavailable"}),
    ],
)
def test_stops_fall_back_to_nominatim_when_photon_refuses(photon):
    import asyncio

    calls = {"photon": 0, "nominatim": 0}

    def handler(req):
        host = req.url.host
        calls["photon" if "photon" in host else "nominatim"] += 1
        return photon if "photon" in host else httpx.Response(200, json=NOMINATIM_ROW)

    tools = _tools_with(handler)
    near = (26.92, 75.79)
    first = asyncio.run(tools.geocode_place("Hawa Mahal, Jaipur", near))
    second = asyncio.run(tools.geocode_place("City Palace, Jaipur", near))
    assert first and first["label"] == "Hawa Mahal"
    assert second is not None
    assert calls["photon"] == 1  # skipped for a while after refusing once
    assert calls["nominatim"] == 2


def test_a_failed_lookup_is_not_cached():
    import asyncio

    state = {"down": True}

    def handler(req):
        if "photon" in req.url.host or state["down"]:
            return httpx.Response(429, text="slow down")
        return httpx.Response(200, json=NOMINATIM_ROW)

    tools = _tools_with(handler)
    near = (26.92, 75.79)
    assert asyncio.run(tools.geocode_place("Hawa Mahal, Jaipur", near)) is None  # both refused: unknown, not "absent"
    state["down"] = False
    assert asyncio.run(tools.geocode_place("Hawa Mahal, Jaipur", near)) is not None  # retried, found
