"""Safarnaama's HTTP API end to end: plan → map → weather → re-plan → vote, and what a trip records."""

from __future__ import annotations

from tests.conftest import FakeTools, parse_sse


def test_trip_plan_replan_vote_weather(app_client):
    c = app_client
    c.headers["X-Trip-Owner"] = c.post("/api/trips/owner").json()["token"]
    events = parse_sse(c.post("/api/trips/plan", json={"prompt": "2 days in Lisbon from May 1 2030, love food"}).text)
    steps = [d["step"] for e, d in events if e == "step"]
    assert (
        steps == ["understand", "geocode", "weather", "plan", "map", "meals", "wellbeing"] and events[-1][0] == "done"
    )
    trip = events[-1][1]["trip"]
    act = trip["days"][0]["activities"][0]
    assert act["lat"] and trip["days"][0]["weather"]["rain"] == 80 and trip["days"][0]["date"] == "2030-05-01"

    day2 = trip["days"][1]
    assert day2["route"]["legs"] and day2["weather"]["aqi"] == 160.0
    kinds = {i["type"] for i in day2["insights"]}
    assert {"heat", "uv", "air", "hydration"} <= kinds  # 38°C feels-like, UV 9, AQI 160
    assert any(
        a.get("added") == "meal" and a["name"] == "Tasca do Chico" for d in trip["days"] for a in d["activities"]
    )

    first = trip["days"][0]["activities"][0]
    near = c.get(
        f"/api/trips/{trip['id']}/nearby", params={"activity_id": first["id"], "group": "food", "veg": True}
    ).json()
    assert [p["name"] for p in near["places"]] == ["Green Bowl"]
    sights = c.get(f"/api/trips/{trip['id']}/nearby", params={"activity_id": first["id"], "group": "sights"}).json()
    stop = sights["places"][0]
    added = c.post(f"/api/trips/{trip['id']}/days/1/stops",
                   json={"name": stop["name"], "lat": stop["lat"], "lng": stop["lng"], "time": "16:00"}).json()  # fmt: skip
    assert any(a["name"] == "Miradouro da Graça" for a in added["days"][0]["activities"])
    opt = c.post(f"/api/trips/{trip['id']}/days/1/optimise").json()
    assert opt["trip"]["version"] > added["version"] and "travel_after" in opt
    trip = opt["trip"]

    wx = c.post(f"/api/trips/{trip['id']}/weather-check").json()
    assert wx["alerts"][0]["day"] == 1 and "Castelo de São Jorge" in wx["alerts"][0]["outdoor"]
    out = c.post(f"/api/trips/{trip['id']}/replan", json={"event": "Heavy rain on day 1"}).json()
    assert out["days_changed"] == [1] and out["trip"]["version"] == trip["version"] + 1
    assert (
        out["trip"]["days"][0]["activities"][0]["name"] == "Gulbenkian Museum"
        and out["trip"]["days"][1]["changed"] is False
    )

    new_act = out["trip"]["days"][1]["activities"][0]["id"]
    voted = c.post(f"/api/trips/{trip['id']}/votes", json={"activity_id": new_act, "voter": "Sam", "value": 1}).json()
    assert voted["days"][1]["activities"][0]["votes"] == {"Sam": 1}
    assert (
        c.post(f"/api/trips/{trip['id']}/votes", json={"activity_id": "nope", "voter": "Sam", "value": 1}).status_code
        == 404
    )


def test_trip_records_destination_days_places_and_forecast_time(app_client):
    """What TripWeaver stores today: destination, dated day-wise itinerary, located places, forecast fetch time."""
    c = app_client
    c.headers["X-Trip-Owner"] = c.post("/api/trips/owner").json()["token"]
    events = parse_sse(c.post("/api/trips/plan", json={"prompt": "2 days in Lisbon from May 1 2030, love food"}).text)
    trip = events[-1][1]["trip"]
    assert trip["city"]["name"] == "Lisbon" and trip["request"]["days"] == 2
    assert [d["day"] for d in trip["days"]] == [1, 2] and [d["date"] for d in trip["days"]] == [
        "2030-05-01",
        "2030-05-02",
    ]
    assert all(a.get("lat") is not None and a.get("time") for d in trip["days"] for a in d["activities"])
    planned_at = trip["weather_updated_at"]
    assert planned_at and planned_at.endswith("+00:00")  # forecast time is recorded, never implied to be live
    assert trip["id"] in [t["id"] for t in c.get("/api/trips").json()]  # trip history
    wx = c.post(f"/api/trips/{trip['id']}/weather-check").json()
    assert wx["trip"]["weather_updated_at"] >= planned_at


def test_trip_without_forecast_records_no_forecast_time(app_client):
    class NoWeather(FakeTools):
        async def forecast(self, lat, lng, tz):
            raise RuntimeError("weather provider down")

    c = app_client
    c.app.state.trips.tools = NoWeather()
    c.headers["X-Trip-Owner"] = c.post("/api/trips/owner").json()["token"]
    events = parse_sse(c.post("/api/trips/plan", json={"prompt": "2 days in Lisbon from May 1 2030, love food"}).text)
    trip = events[-1][1]["trip"]
    assert trip["weather_updated_at"] is None
    assert not any("rain" in (d["weather"] or {}) for d in trip["days"])  # air quality may exist; no forecast
