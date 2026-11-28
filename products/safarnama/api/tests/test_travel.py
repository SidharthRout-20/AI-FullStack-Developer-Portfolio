"""TripWeaver travel rules: routes, rush hour, re-timing, wellbeing insights, opening hours, meal slots."""

from __future__ import annotations

import datetime as dt

from safarnama import travel


def act(i: int, time: str, kind: str = "outdoor", lat: float | None = 38.70, lng: float = -9.14, dur: int = 60):
    return {"id": f"a{i}", "name": f"Stop {i}", "time": time, "kind": kind, "duration_min": dur,
            "lat": None if lat is None else lat + i * 0.02, "lng": lng}  # fmt: skip


def test_route_walks_short_hops_drives_long_ones_and_flags_rush_hour():
    near = [act(0, "09:00"), {**act(1, "10:30"), "lat": 38.7005, "lng": -9.1405}]
    leg = travel.build_route(near, None)["legs"][0]
    assert leg["mode"] == "walk" and not leg["peak"]
    far = [act(0, "07:30", dur=60), act(1, "09:30")]  # leaves 08:30, in the morning rush
    route = travel.build_route(far, [{"duration_s": 1800, "distance_m": 6000}])
    leg = route["legs"][0]
    assert leg["mode"] == "drive" and leg["minutes"] == 30 and leg["peak"] and leg["peak_minutes"] == 42
    assert route["drive_min"] == 30


def test_retime_follows_travel_and_never_moves_meals_earlier():
    acts = [act(0, "09:00", dur=90), act(1, "11:00", dur=60), act(2, "13:00", kind="food", dur=60)]
    route = {
        "legs": [{"to": "a1", "minutes": 12, "peak_minutes": None}, {"to": "a2", "minutes": 8, "peak_minutes": None}]
    }
    out = travel.retime(acts, route)
    assert [a["time"] for a in out] == ["09:00", "10:45", "13:00"]  # 09:00+90+12 → 10:45 (5-min steps); lunch kept


def test_reorder_moves_sights_but_keeps_meals_in_place():
    acts = [act(0, "09:00"), act(1, "10:00"), act(2, "12:30", kind="food"), act(3, "14:00")]
    out = travel.reorder(acts, [0, 2, 1])
    assert [a["id"] for a in out] == ["a0", "a3", "a2", "a1"]
    assert travel.reorder(acts, [0, 0, 1]) == acts  # invalid order → unchanged


def test_insights_cover_heat_uv_air_traffic_meals_and_access():
    day = {
        "activities": [act(0, "12:00"), act(1, "15:00")],
        "weather": {"tmax": 36, "feels_max": 39, "uv": 10, "aqi": 170, "rain": 10},
        "route": {"legs": [{"from_name": "A", "to_name": "B", "depart": "17:30", "minutes": 25, "peak": True,
                            "peak_minutes": 35, "mode": "drive", "km": 8}], "drive_min": 25, "walk_min": 0},
    }  # fmt: skip
    kinds = {i["type"]: i for i in travel.insights(day, "with two kids", "balanced")}
    assert {"heat", "uv", "air", "traffic", "hydration", "meal", "access"} <= set(kinds)
    assert "Stop 0" in kinds["heat"]["text"] and kinds["air"]["level"] == "warn"


def test_opening_hours_common_patterns():
    tue_noon = dt.datetime(2030, 5, 7, 12, 0)  # a Tuesday
    assert travel.is_open("24/7", tue_noon) is True
    assert travel.is_open("Mo-Fr 09:00-17:00; Sa 10:00-14:00", tue_noon) is True
    assert travel.is_open("Mo-Fr 09:00-11:00,18:00-23:00", tue_noon) is False
    assert travel.is_open("Mo-Su 18:00-02:00", dt.datetime(2030, 5, 7, 1, 0)) is True  # past midnight
    assert travel.is_open("Tu off; We-Su 12:00-22:00", tue_noon) is False
    assert travel.is_open("sunrise-sunset", tue_noon) is None  # unknown pattern → unknown, not closed


def test_a_lunch_the_planner_already_gave_is_never_doubled():
    acts = [{"time": "09:00", "name": "Amber Fort", "kind": "outdoor", "duration_min": 150},
            {"time": "11:30", "name": "Lunch at Laxmi Misthan Bhandar", "kind": "food", "duration_min": 60},
            {"time": "13:00", "name": "City Palace", "kind": "indoor", "duration_min": 120},
            {"time": "18:45", "name": "Chokhi Dhani", "kind": "food", "duration_min": 120}]  # fmt: skip
    assert travel.meal_gaps(acts) == []


def test_meal_gaps_and_picking_a_nearby_restaurant():
    acts = [act(0, "09:00", dur=120), act(1, "11:30", dur=90), act(2, "15:00", dur=120), act(3, "18:00", dur=90)]
    gaps = travel.meal_gaps(acts)
    assert gaps == [("lunch", "13:00"), ("dinner", "19:30")]
    assert travel.anchor_for(acts, "13:00")["id"] == "a1"
    places = [
        {"name": "Snack", "group": "food", "category": "fast food", "distance_m": 50, "opening_hours": None},
        {"name": "Bistro", "group": "food", "category": "restaurant", "distance_m": 200, "cuisine": "french",
         "opening_hours": "Mo-Su 12:00-15:00"},
        {"name": "Closed", "group": "food", "category": "restaurant", "distance_m": 10, "opening_hours": "Mo-Su 18:00-22:00"},
    ]  # fmt: skip
    when = dt.datetime(2030, 5, 7, 13, 0)
    assert travel.pick_meal(places, when, prefer_veg=False)["name"] == "Bistro"
    assert [p["name"] for p in travel.filter_places(places, open_at=when)] == ["Snack", "Bistro"]
