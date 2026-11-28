"""Destinations resolve to the right place: never a city in another country, never a hamlet that shares the name."""

from __future__ import annotations

import asyncio

import httpx

from safarnama.service import Tools

# Open-Meteo's real answer for "Goa": Genoa first, and the Indian matches are villages (Goa is a state).
OPEN_METEO = {"results": [
    {"name": "Genoa", "country": "Italy", "feature_code": "PPLA", "population": 580097, "latitude": 44.4, "longitude": 8.9, "timezone": "Europe/Rome"},
    {"name": "Goa", "country": "Philippines", "feature_code": "PPLA3", "population": 20936, "latitude": 13.7, "longitude": 123.5},
    {"name": "Goa", "country": "India", "feature_code": "PPL", "population": None, "latitude": 26.1, "longitude": 73.0},
]}  # fmt: skip
NOMINATIM = [
    {"lat": "15.3004", "lon": "74.0855", "display_name": "Goa, India", "address": {"state": "Goa", "country": "India"}}
]


def _tools(open_meteo, nominatim):
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=open_meteo if "open-meteo" in req.url.host else nominatim)

    t = Tools()
    t._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return t


def test_goa_is_goa_india_not_genoa():
    hit = asyncio.run(_tools(OPEN_METEO, NOMINATIM).geocode_city("Goa", "India"))
    assert hit["country"] == "India" and hit["name"] == "Goa" and 14 < hit["lat"] < 16 and 73 < hit["lng"] < 75


def test_a_real_city_comes_straight_from_open_meteo_with_its_timezone():
    lisbon = {"results": [{"name": "Lisbon", "country": "Portugal", "feature_code": "PPLC", "population": 517802,
                           "latitude": 38.7, "longitude": -9.1, "timezone": "Europe/Lisbon"}]}  # fmt: skip
    hit = asyncio.run(_tools(lisbon, []).geocode_city("Lisbon", "Portugal"))
    assert hit == {"name": "Lisbon", "country": "Portugal", "lat": 38.7, "lng": -9.1, "timezone": "Europe/Lisbon"}


def test_never_a_place_in_another_country():
    hit = asyncio.run(_tools(OPEN_METEO, []).geocode_city("Goa", "India"))
    assert hit is None or hit["country"] == "India"


# Open-Meteo's real answer for "Manali": a Chennai suburb first (more people), the Himachal hill town second.
MANALI = {"results": [
    {"name": "Manali", "country": "India", "admin1": "Tamil Nadu", "feature_code": "PPL", "population": 35248, "latitude": 13.17, "longitude": 80.27},
    {"name": "Manali", "country": "India", "admin1": "Himachal Pradesh", "feature_code": "PPL", "population": 8096, "latitude": 32.26, "longitude": 77.17},
]}  # fmt: skip


def test_the_state_tells_namesakes_apart():
    hit = asyncio.run(_tools(MANALI, []).geocode_city("Manali", "India", region="Himachal Pradesh"))
    assert hit["lat"] == 32.26
    assert asyncio.run(_tools(MANALI, []).geocode_city("Manali", "India", region="Himachal"))["lat"] == 32.26
    assert asyncio.run(_tools(MANALI, []).geocode_city("Manali", "India"))["lat"] == 13.17  # no hint: the bigger town


def test_country_names_as_geocoders_spell_them():
    amsterdam = {"results": [
        {"name": "Amsterdam", "country": "The Netherlands", "feature_code": "PPLC", "population": 741636, "latitude": 52.37, "longitude": 4.89},
        {"name": "Amsterdam", "country": "United States", "feature_code": "PPL", "population": 18008, "latitude": 42.9, "longitude": -74.2},
    ]}  # fmt: skip
    hit = asyncio.run(_tools(amsterdam, []).geocode_city("Amsterdam", "Netherlands"))
    assert hit["lat"] == 52.37
    assert asyncio.run(_tools(amsterdam, []).geocode_city("Amsterdam", "USA"))["lat"] == 42.9


def test_near_duplicates_prefer_the_exact_spelling():
    twins = {"results": [
        {"name": "Mahābaleshwar", "country": "India", "admin1": "Maharashtra", "feature_code": "PPL", "population": 13598, "latitude": 17.56, "longitude": 73.4},
        {"name": "Mahabaleshwar", "country": "India", "admin1": "Maharashtra", "feature_code": "PPL", "population": 13393, "latitude": 17.92, "longitude": 73.66},
    ]}  # fmt: skip
    assert asyncio.run(_tools(twins, []).geocode_city("Mahabaleshwar", "India", region="Maharashtra"))["lat"] == 17.92
    assert asyncio.run(_tools(twins, []).geocode_city("Mahabaleshwar", "India"))["lat"] == 17.92
