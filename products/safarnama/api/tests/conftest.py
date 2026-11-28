"""Shared fixtures for Safarnaama's tests: an isolated app (temp SQLite), scripted model replies and fake providers.

Tests never call a model or a map/weather service: fast, deterministic and free.
"""

from __future__ import annotations

import os

os.environ["ENVIRONMENT"] = "test"  # disables rate limiting; must precede app imports

import json

import pytest
from fastapi.testclient import TestClient

from safarnama.main import create_app
from safarnama.settings import SafarnamaSettings

BLANK_LINE = chr(10) * 2  # SSE events are separated by a blank line


def parse_sse(body: str) -> list[tuple[str, dict]]:
    events = []
    for block in body.strip().split(BLANK_LINE):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        events.append((lines["event"], json.loads(lines["data"])))
    return events


@pytest.fixture
def settings(tmp_path) -> SafarnamaSettings:
    return SafarnamaSettings(_env_file=None, environment="test", data_dir=tmp_path / "data", database_url=None)


TRIP_REQ = {
    "destination": "Lisbon",
    "country": "Portugal",
    "start_date": "2030-05-01",
    "days": 2,
    "interests": ["food"],
    "pace": "balanced",
}
PLAN = {"title": "Lisbon long weekend", "summary": "Hills and pastries.", "tips": ["Wear good shoes"],
        "days": [{"day": 1, "theme": "Old town", "activities": [{"time": "09:00", "name": "Castelo de São Jorge", "place_query": "Castelo de São Jorge Lisbon", "kind": "outdoor", "duration_min": 120}]},
                 {"day": 2, "theme": "Belém", "activities": [{"time": "10:00", "name": "Jerónimos Monastery", "place_query": "Jerónimos Monastery", "kind": "indoor"}]}]}  # fmt: skip
REPLAN = {"explanation": "Swapped the castle for a museum because of rain.",
          "changed_days": [{"day": 1, "theme": "Museums", "activities": [{"time": "10:00", "name": "Gulbenkian Museum", "place_query": "Gulbenkian Lisbon", "kind": "indoor"}]}]}  # fmt: skip


class FakeTools:
    async def geocode_city(self, name, country, region=None):
        return {"name": "Lisbon", "country": "Portugal", "lat": 38.72, "lng": -9.14, "timezone": "Europe/Lisbon"}

    async def geocode_place(self, query, near):
        return {"lat": near[0] + 0.01, "lng": near[1] + 0.01, "label": query}

    async def forecast(self, lat, lng, tz):
        return {
            "2030-05-01": {"code": 61, "tmax": 18, "tmin": 12, "rain": 80, "uv": 3, "feels_max": 17},
            "2030-05-02": {"code": 1, "tmax": 36, "tmin": 24, "rain": 5, "uv": 9, "feels_max": 38},
        }

    async def air_quality(self, lat, lng):
        return {"2030-05-02": 160.0}

    async def route(self, stops):
        return [{"duration_s": 1500, "distance_m": 9000} for _ in stops[1:]]

    async def best_order(self, stops):
        return [0, *range(len(stops) - 1, 0, -1)]  # keep the start, visit the rest in reverse

    async def nearby(self, lat, lng, group, radius=900):
        if group == "food":
            return [
                {"name": "Tasca do Chico", "group": "food", "category": "restaurant", "lat": lat + 0.001, "lng": lng,
                 "distance_m": 120, "cuisine": "portuguese", "veg": False, "opening_hours": "Mo-Su 12:00-23:00"},
                {"name": "Green Bowl", "group": "food", "category": "restaurant", "lat": lat, "lng": lng + 0.002,
                 "distance_m": 300, "cuisine": "vegan", "veg": True, "opening_hours": "Mo-Fr 08:00-11:00"},
            ]  # fmt: skip
        return [{"name": "Miradouro da Graça", "group": "sights", "category": "viewpoint", "lat": lat, "lng": lng,
                 "distance_m": 200, "cuisine": None, "veg": False, "opening_hours": "24/7"}]  # fmt: skip


class ScriptedLLM:
    """Answers Safarnaama's prompts by recognising their system prompt."""

    RULES = [("Extract a trip request", TRIP_REQ), ("travel planner", PLAN), ("revise an existing itinerary", REPLAN)]

    async def complete(self, system, messages, *, short=False):
        for needle, reply in self.RULES:
            if system and needle.lower() in system.lower():
                return json.dumps(reply)
        return "{}"

    async def stream(self, system, messages):
        yield await self.complete(system, messages)


@pytest.fixture
def app_client(settings):
    llm = ScriptedLLM()
    app = create_app(settings, llm_factory=lambda _: llm, tools=FakeTools())
    with TestClient(app) as c:
        yield c
