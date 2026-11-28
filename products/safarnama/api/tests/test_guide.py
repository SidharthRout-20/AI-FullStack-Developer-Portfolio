"""The travel guide: stays, food, things to do and their usual costs, checked on the map, and what the trip will
likely cost against the budget. The model is always scripted (no live calls)."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from safarnama import guide as trip_guide
from safarnama.main import create_app
from tests.conftest import FakeTools

GUIDE = {
    "destinations": [{
        "destination": "Lisbon",
        "stay": [{"area": "Alfama", "why": "Old town, walkable", "tiers": [
            {"tier": "budget", "kind": "guest house", "per_night": {"min": 4000, "max": 6000}},
            {"tier": "mid", "kind": "3-star hotel", "per_night": {"min": 9000, "max": 14000}},
            {"tier": "premium", "kind": "boutique hotel", "per_night": {"min": 20000, "max": 30000}}]}],
        "food": [{"dish": "Pastel de nata", "what": "Custard tart", "where": "Pastéis de Belém", "popular": True,
                  "per_person": {"min": 150, "max": 300}},
                 {"dish": "Bifana", "what": "Pork sandwich", "where": "Nowhere Tasca", "per_person": {"min": 300, "max": 500}}],
        "things": [{"name": "Tram 28 ride", "type": "local", "what": "Through the old town", "where": "Martim Moniz",
                    "minutes": 60, "cost": {"min": 300, "max": 350}, "per": "person"},
                   {"name": "Nowhere fado night", "type": "culture", "where": "Nowhere Hall", "cost": {"min": 2500, "max": 4000}}],
        "around": [{"mode": "Metro", "fare": {"min": 150, "max": 200}, "per": "person"}],
        "daily": {"food_per_person": {"min": 2000, "max": 3500}, "local_transport": {"min": 600, "max": 1200}},
        "tips": ["Carry coins for trams"],
    }],
    "getting_there": [{"mode": "flight", "what": "Via a Gulf hub", "fare": {"min": 45000, "max": 70000}, "per": "person", "hours": 14}],
    "stop_costs": [{"id": "not-a-stop", "cost": {"min": 1, "max": 2}}],
}  # fmt: skip
REQ = {
    "destination": "Lisbon",
    "country": "Portugal",
    "start_date": "2030-05-01",
    "days": 2,
    "interests": [],
    "pace": "balanced",
}
PLAN = {"title": "Lisbon", "summary": "", "tips": [], "days": [
    {"day": 1, "theme": "Old town", "activities": [{"time": "09:00", "name": "Castelo de São Jorge", "kind": "outdoor", "duration_min": 120}]},
    {"day": 2, "theme": "Belém", "activities": [{"time": "10:00", "name": "Jerónimos Monastery", "kind": "indoor"}]}]}  # fmt: skip


class LLM:
    def __init__(self):
        self.guide_calls = 0

    async def complete(self, system, messages, *, short=False):
        if "travel guide" in system:
            self.guide_calls += 1
            return json.dumps(GUIDE)
        if "Extract a trip request" in system:
            return json.dumps(REQ)
        if "travel planner" in system:
            return json.dumps(PLAN)
        return "{}"

    async def stream(self, system, messages):
        yield await self.complete(system, messages)


class Tools(FakeTools):
    async def geocode_place(self, query, near):
        if "Nowhere" in query:
            return None
        spread = 0.001 * (len(query) % 50)  # different places land in different spots (the real map does too)
        return {"lat": near[0] + spread, "lng": near[1] + spread, "label": query}


@pytest.fixture
def env(settings):
    llm = LLM()
    app = create_app(settings, llm_factory=lambda _: llm, tools=Tools())
    with TestClient(app) as c:
        yield c, llm


def owner(c):
    return {"X-Trip-Owner": c.post("/api/trips/owner").json()["token"]}


def test_the_guide_names_only_places_the_map_knows_and_is_made_once(env):
    c, llm = env
    h = owner(c)
    trip = c.post("/api/trips", json={"destinations": [{"name": "Lisbon", "days": 3}], "start_date": "2030-05-01",
                                      "travellers": 2, "budget": 90000, "currency": "INR"}, headers=h).json()  # fmt: skip
    t = f"/api/trips/{trip['id']}"
    assert c.get(f"{t}/guide", headers=h).status_code == 404
    r = c.post(f"{t}/guide", json={"origin": "Mumbai"}, headers=h)
    assert r.status_code == 200, r.text
    g = r.json()["guide"]
    food = {f["dish"]: f for f in g["destinations"][0]["food"]}
    assert food["Pastel de nata"]["where"] == "Pastéis de Belém" and food["Pastel de nata"]["lat"] is not None
    assert food["Bifana"]["where"] == ""  # an eatery the map doesn't know is never named
    things = {x["name"]: x for x in g["destinations"][0]["things"]}
    assert things["Nowhere fado night"]["lat"] is None and things["Tram 28 ride"]["lat"] is not None
    assert g["stop_costs"] == [] and g["origin"] == "Mumbai" and g["estimates"] is True and g["currency"] == "INR"
    est = r.json()["estimate"]
    assert set(est["levels"]) == {"budget", "mid", "premium"} and est["chosen"] in est["levels"]
    assert c.get(f"{t}/guide", headers=h).json()["guide"]["origin"] == "Mumbai"
    c.post(f"{t}/guide", json={}, headers=h)
    assert llm.guide_calls == 1  # kept on the trip, not made again


def test_a_thing_from_the_guide_goes_into_a_day_with_its_usual_cost(env):
    c, _ = env
    h = owner(c)
    trip = c.post("/api/trips", json={"destinations": [{"name": "Lisbon", "days": 2}], "start_date": "2030-05-01",
                                      "travellers": 2, "currency": "INR"}, headers=h).json()  # fmt: skip
    t = f"/api/trips/{trip['id']}"
    c.post(f"{t}/guide", json={}, headers=h)
    r = c.post(f"{t}/guide/add", json={"kind": "thing", "index": 0, "day": 1}, headers=h)
    assert r.status_code == 200, r.text
    stop = next(a for a in r.json()["trip"]["days"][0]["activities"] if a["name"] == "Tram 28 ride")
    assert stop["added"] == "guide" and stop["duration_min"] == 60
    assert {"id": stop["id"], "cost": {"min": 300, "max": 350}, "per": "person"} in r.json()["guide"]["stop_costs"]
    assert r.json()["estimate"]["levels"]["mid"]["parts"]["things"] == [600, 700]  # two people
    r = c.post(f"{t}/guide/add", json={"kind": "food", "index": 0, "day": 2}, headers=h)
    assert any(
        a["name"] == "Pastéis de Belém" and a["kind"] == "food" for a in r.json()["trip"]["days"][1]["activities"]
    )
    assert c.post(f"{t}/guide/add", json={"kind": "thing", "index": 0, "day": 2}, headers=h).status_code == 409  # twice
    assert (
        c.post(f"{t}/guide/add", json={"kind": "thing", "index": 1, "day": 1}, headers=h).status_code == 422
    )  # no pin
    assert c.post(f"{t}/guide/add", json={"kind": "thing", "index": 9, "day": 1}, headers=h).status_code == 404


def test_the_estimate_adds_up_and_picks_the_stay_level_the_budget_covers():
    trip = {
        "party": {"travellers": 3}, "budget": {"total": 150000},
        "destinations": [{"name": "Lisbon", "start_day": 1, "end_day": 3}],
        "days": [{"day": d, "activities": [{"id": f"s{d}", "kind": "outdoor"}, {"id": f"m{d}", "kind": "food"}]} for d in (1, 2, 3)],
    }  # fmt: skip
    g = {**GUIDE, "stop_costs": [{"id": "s1", "cost": {"min": 500, "max": 800}, "per": "person"},
                                 {"id": "m1", "cost": {"min": 900, "max": 900}, "per": "person"},
                                 {"id": "s2", "cost": {"min": 0, "max": 0}, "per": "free"},
                                 {"id": "s3", "cost": {"min": 2000, "max": 2000}, "per": "group"}]}  # fmt: skip
    mid = trip_guide.estimate(trip, g, "mid")
    # 3 people → 2 rooms; 3 days → 2 nights; mid rooms 9,000-14,000
    assert mid["parts"]["stay"] == [36000, 56000] and mid["rooms"] == 2
    assert mid["parts"]["food"] == [18000, 31500]  # 3 days × 3 people × 2,000-3,500
    assert mid["parts"]["local"] == [1800, 3600]
    assert mid["parts"]["things"] == [3500, 4400]  # 3 × 500-800 + a group ticket; the meal is in food
    assert mid["parts"]["getting_there"] == [270000, 420000]  # 3 people, there and back
    assert mid["status"] == "over"
    no_flight = {**g, "getting_there": []}
    best = trip_guide.estimate(trip, no_flight)
    assert best["tier"] == "mid" and best["status"] == "fits"  # premium would go over 150,000
    assert trip_guide.estimate(trip, no_flight, "premium")["status"] == "tight"
    assert trip_guide.estimate({**trip, "budget": {}}, no_flight)["status"] is None
    tight = trip_guide.estimate({**trip, "budget": {"total": 60000}}, no_flight)
    assert tight["tier"] == "budget"  # nothing surely fits: the level most likely to fit, not the priciest
    named = {**no_flight, "destinations": [{**no_flight["destinations"][0], "destination": "Lisbon, Portugal"}]}
    assert trip_guide.estimate(trip, named, "mid")["parts"]["stay"] == [36000, 56000]  # matched by name, not left out


def test_a_place_is_looked_up_by_its_own_name_not_its_directions():
    assert trip_guide.place_name("Mango Tree Cooking Studio, near Saheliyon-ki-Bari") == "Mango Tree Cooking Studio"
    assert trip_guide.place_name("Natraj Dining Hall near Bapu Bazaar") == "Natraj Dining Hall"
    assert trip_guide.place_name("Lake Pichola jetty - City Palace side") == "Lake Pichola jetty"
    assert trip_guide.place_name("Johnson's Cafe") == "Johnson's Cafe"
    assert trip_guide.place_name("") == ""


def test_one_odd_label_never_throws_away_the_guide():
    g = trip_guide.Guide.model_validate({"destinations": [{"destination": "Udaipur",
        "stay": [{"area": "Old City", "tiers": [{"tier": "Luxury", "per_night": {"min": 9000, "max": 15000}}]}],
        "things": [{"name": "Lake cruise", "type": "Boat ride / sightseeing", "per": "per boat"},
                   {"name": "Ropeway", "type": "Adventure!", "per": "Per person"}, {"name": "Temple", "type": "heritage", "per": "No fee"}],
        "around": [{"mode": "Auto", "per": "per ride"}]}]})  # fmt: skip
    d = g.destinations[0]
    assert d.stay[0].tiers[0].tier == "premium"
    assert [(t.type, t.per) for t in d.things] == [("culture", "group"), ("adventure", "person"), ("culture", "free")]
    assert d.around[0].per == "trip"
