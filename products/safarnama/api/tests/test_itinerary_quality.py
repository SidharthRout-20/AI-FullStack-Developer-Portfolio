"""Itinerary quality: what the planner shows should be right and calm, not a list of errors.

Stops that aren't places (hotel meals, rest, "Drive to…") are never "not on the map"; real places get several
lookups; a fresh plan is re-timed around real travel instead of reporting clashes; the model is told each weekday.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from safarnama import logic as trip_logic
from safarnama import stops, travel
from safarnama.main import create_app
from tests.conftest import TRIP_REQ, FakeTools, parse_sse


def test_stops_that_are_part_of_the_day_not_places():
    for name in ("Breakfast at Hotel", "Return & Rest at Hotel", "Drive to Eravikulam National Park",
                 "Lunch at Hotel or Park Café", "Dinner at Hotel’s In‑House Restaurant", "Check-in at your stay",
                 "Farewell dinner at the homestay", "Pack and check out"):  # fmt: skip
        assert stops.placeless(name), name
    for name in ("Tata Tea Museum (Munnar Tea Museum)", "Lunch at Saravana Bhavan", "Kannan Devan Tea Estate Walk",
                 "Mattupetty Dam & Echo Point", "Farewell Dinner at Rapsy Restaurant", "Munnar Market"):  # fmt: skip
        assert not stops.placeless(name), name
    assert stops.is_rest("Return & Rest at Hotel") and not stops.is_rest("Breakfast at Hotel")


def test_lookup_variants_for_names_a_map_search_wouldnt_understand():
    assert stops.place_queries("Tata Tea Museum (Munnar Tea Museum)", "", "Munnar") == [
        "Tata Tea Museum, Munnar",
        "Munnar Tea Museum, Munnar",
    ]
    assert stops.place_queries("Stroll through Munnar Market", "", "Munnar") == ["Munnar Market, Munnar"]
    assert stops.place_queries("Mattupetty Dam & Echo Point", "Mattupetty Dam, Munnar", "Munnar") == [
        "Mattupetty Dam, Munnar",
        "Mattupetty Dam & Echo Point, Munnar",
    ]
    assert stops.place_queries("Farewell Dinner at Rapsy Restaurant", None, "Munnar") == ["Rapsy Restaurant, Munnar"]


def test_schedule_checks_and_pace_ignore_non_places_and_rest():
    day = {"date": "2030-05-01", "activities": [
        {"id": "a", "name": "Breakfast at Hotel", "time": "09:00", "duration_min": 60, "kind": "food", "lat": None},
        {"id": "b", "name": "Return & Rest at Hotel", "time": "10:00", "duration_min": 300, "kind": "indoor", "lat": None},
        {"id": "c", "name": "Some Museum", "time": "15:00", "duration_min": 120, "kind": "indoor", "lat": None},
    ], "route": {"legs": [], "walk_min": 0, "drive_min": 0}}  # fmt: skip
    issues = trip_logic.validate_day(day)
    assert [x["activity_id"] for x in issues if x["type"] == "unlocated"] == ["c"]  # only the real place
    assert not any(x["type"] == "pace" for x in travel.insights(day, None, "relaxed"))  # 5 h rest isn't "busy"


class PlannerLLM:
    """A plan with clashing times, a hotel breakfast, a drive "stop" and a place known by its bracketed alias."""

    def __init__(self):
        self.prompts: list[str] = []

    async def complete(self, system, messages, *, short=False):
        self.prompts.append(messages[-1]["content"])
        if "extract a trip request" in (system or "").lower():
            return json.dumps(TRIP_REQ)
        return json.dumps({"title": "Lisbon", "summary": "", "tips": [], "days": [
            {"day": 1, "theme": "Old town", "activities": [
                {"time": "08:30", "name": "Breakfast at your stay", "kind": "food", "duration_min": 45},
                {"time": "09:00", "name": "Castelo de São Jorge", "place_query": "Castelo de São Jorge Lisbon",
                 "kind": "outdoor", "duration_min": 120},
                {"time": "10:00", "name": "Drive to Belém", "kind": "outdoor", "duration_min": 20},
                {"time": "10:15", "name": "Stroll through Mercado da Ribeira (Time Out Market)", "kind": "food",
                 "duration_min": 60}]},
            {"day": 2, "theme": "Belém", "activities": [
                {"time": "10:00", "name": "Jerónimos Monastery", "place_query": "Jerónimos Monastery", "kind": "indoor"}]},
        ]})  # fmt: skip

    async def stream(self, system, messages):
        yield await self.complete(system, messages)


class AliasOnlyTools(FakeTools):
    """The map only knows the market by its other name."""

    async def geocode_place(self, query, near):
        if "Mercado" in query:
            return None
        return await super().geocode_place(query, near)


def test_a_fresh_plan_is_retimed_around_travel_and_knows_the_weekdays(settings):
    llm = PlannerLLM()
    app = create_app(settings, llm_factory=lambda _: llm, tools=AliasOnlyTools())
    with TestClient(app) as c:
        h = {"X-Trip-Owner": c.post("/api/trips/owner").json()["token"]}
        events = parse_sse(
            c.post("/api/trips/plan", json={"prompt": "2 days in Lisbon from May 1 2030"}, headers=h).text
        )
    trip = events[-1][1]["trip"]
    day = trip["days"][0]
    acts = {a["name"]: a for a in day["activities"]}

    assert "Day 1 = 2030-05-01 (Wednesday)" in llm.prompts[-1]  # weekdays, so "closed on Mondays" can be respected
    assert acts["Breakfast at your stay"]["lat"] is None and acts["Drive to Belém"]["lat"] is None  # not looked up
    assert acts["Stroll through Mercado da Ribeira (Time Out Market)"]["lat"] is not None  # found by its alias
    assert day.get("retimed") is True
    assert not [x for x in day["issues"] if x["type"] in ("overlap", "unlocated")]  # nothing to "fix"
    times = [travel.to_min(a["time"]) for a in day["activities"]]
    assert times == sorted(times)


def test_plan_schema_accepts_the_shapes_models_drift_into():
    from safarnama.service import Plan, Replan, TripRequest, clock

    assert [clock(v) for v in ("9:00 AM", "9am", "09:00-10:30", "14h30", "12 pm", "noon", None)] == [
        "09:00", "09:00", "09:00", "14:30", "12:00", "09:00", "09:00",
    ]  # fmt: skip
    plan = Plan.model_validate(
        {
            "plan": {
                "trip_title": "Munnar",
                "itinerary": [
                    {
                        "day": "Day 1",
                        "stops": [{"place": "Tea Museum", "time": "9:30 AM", "duration": "90", "notes": "x"}],
                    },
                    {"activities": []},  # empty day: dropped
                    {"activities": [{"place_query": "Top Station, Munnar", "time": "7"}, "stray text"]},
                ],
            }
        }
    )
    assert plan.title == "Munnar" and plan.summary == ""
    assert [(d.day, [(a.name, a.time, a.duration_min) for a in d.activities]) for d in plan.days] == [
        (1, [("Tea Museum", "09:30", 90)]),
        (2, [("Top Station", "07:00", 90)]),
    ]
    assert Plan.model_validate([{"day": 1, "activities": [{"name": "A"}]}]).days[0].activities[0].name == "A"
    assert Replan.model_validate({"days": [{"day": 2, "activities": [{"name": "B"}]}]}).changed_days[0].day == 2

    req = TripRequest.model_validate(
        {"destination": None, "days": 14, "start_date": "next weekend", "travellers": 2, "interests": "food, tea",
         "legs": [{"destination": "Munnar", "days": 3}, {"country": "IN"}]}
    )  # fmt: skip
    assert (req.destination, req.days, req.start_date, req.travellers, req.interests, len(req.legs)) == (
        "Munnar", 10, None, "2", ["food", "tea"], 1,
    )  # fmt: skip


def test_a_plan_cut_off_after_some_days_asks_only_for_the_missing_days(settings):
    import json

    from fastapi.testclient import TestClient

    from safarnama.main import create_app
    from tests.conftest import PLAN, TRIP_REQ, FakeTools, parse_sse

    first = dict(PLAN, days=PLAN["days"][:1])
    cut = json.dumps(first)[:-2] + ', {"day": 2, "theme": "unfini'  # day 2 cut off mid-way
    prompts: list[str] = []

    class LLM:
        async def complete(self, system, messages, *, short=False):
            if "Extract a trip request" in system:
                return json.dumps(TRIP_REQ)
            prompts.append(messages[-1]["content"])
            return cut if len(prompts) == 1 else json.dumps(dict(PLAN, days=PLAN["days"][1:]))

    with TestClient(create_app(settings, llm_factory=lambda _: LLM(), tools=FakeTools())) as c:
        c.headers["X-Trip-Owner"] = c.post("/api/trips/owner").json()["token"]
        events = parse_sse(c.post("/api/trips/plan", json={"prompt": "2 days in Lisbon from May 1 2030"}).text)
    assert events[-1][0] == "done", events[-1]
    trip = events[-1][1]["trip"]
    assert [(d["day"], d["theme"]) for d in trip["days"]] == [(1, "Old town"), (2, "Belém")]
    assert len(prompts) == 2 and "Now plan ONLY days 2" in prompts[1]
