"""Visits: counted without cookies or raw IPs, bots dropped, and summarised for the owner only."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.visits import advice, browser_of, device_of, os_of, section_of, source_of

CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1"


@pytest.fixture
def owned(settings, service_factory):
    s = settings.model_copy(update={"tara_owner_key": __import__("pydantic").SecretStr("owner-secret")})
    with TestClient(create_app(s, service_factory=service_factory)) as c:
        yield c


def _hit(c, ua=CHROME, ip="203.0.113.7", **body):
    return c.post("/api/visits/hit", content=json.dumps(body), headers={"User-Agent": ua, "Content-Type": "text/plain",
                                                                        "X-Forwarded-For": ip, "X-Vercel-IP-Country": "IN"})  # fmt: skip


def test_where_a_visit_comes_from():
    assert source_of("https://www.linkedin.com/feed/", "", "site.app") == "LinkedIn"
    assert source_of("", "linkedin", "") == "LinkedIn"  # the tag on the shared link wins
    assert source_of("https://lnkd.in/abc", "", "") == "LinkedIn"
    assert source_of("https://site.app/codelens", "", "site.app") == "Direct"  # moving around the site is not a source
    assert source_of("", "", "") == "Direct"
    assert source_of("https://news.ycombinator.com/item?id=1", "", "") == "news.ycombinator.com"
    assert (device_of(390), device_of(820), device_of(1440), device_of(0)) == ("Phone", "Tablet", "Desktop", "Unknown")
    assert (browser_of(CHROME), os_of(CHROME), browser_of(IPHONE), os_of(IPHONE)) == (
        "Chrome",
        "Windows",
        "Safari",
        "iOS",
    )
    assert [section_of(p) for p in ("/", "/keeper", "/keeper/x", "/keeperish", "/products/codelens", "/quality")] == [
        "Home", "Tara", "Tara", "Other", "Product pages", "Quality page"]  # fmt: skip


def test_visits_are_counted_and_summarised_for_the_owner_only(owned):
    assert _hit(owned, path="/?ref=x", ref="https://www.linkedin.com/", w=1440, sid="s1").status_code == 204
    assert _hit(owned, path="/keeper", ref="https://site.app/", site="site.app", w=1440, sid="s1").status_code == 204
    assert _hit(owned, ua=IPHONE, ip="198.51.100.2", path="/", tag="resume", w=390, sid="s2").status_code == 204
    assert _hit(owned, type="event", name="resume", path="/", sid="s2").status_code == 204
    assert _hit(owned, ua="Googlebot/2.1 (+http://www.google.com/bot.html)", path="/").status_code == 204  # dropped
    assert _hit(owned, type="event", name="anything").status_code == 422

    assert owned.get("/api/visits/summary").status_code == 403
    d = owned.get("/api/visits/summary", headers={"X-Tara-Owner-Key": "owner-secret"}).json()
    cur = d["current"]
    assert cur["views"] == 3 and cur["sessions"] == 2 and cur["visitors"] == 2 and cur["bounce_rate"] == 0.5
    assert cur["explored_rate"] == 0.5 and d["events"] == {"resume": 1} and d["visitor_hash"] is True
    top = d["top"]
    assert {s["name"] for s in top["sources"]} == {"LinkedIn", "Direct", "Résumé"}
    assert {x["name"] for x in top["devices"]} == {"Desktop", "Phone"} and top["countries"] == [
        {"name": "IN", "count": 3}
    ]
    assert [p["name"] for p in top["pages"]][:1] == ["/"] and d["daily"][-1]["views"] == 3
    assert d["advice"][0]["title"] == "Not enough visits to judge yet"  # 2 visits: no conclusions drawn
    # Nothing that identifies a person is stored: no IP, no user agent, no query string.
    raw = json.dumps(owned.app.state.visits.list("hits", limit=50))
    assert "203.0.113.7" not in raw and "Mozilla" not in raw and "ref=x" not in raw


def test_without_an_owner_key_the_summary_is_closed(client):
    assert client.get("/api/visits/summary", headers={"X-Tara-Owner-Key": "x"}).status_code == 503


def test_advice_rests_on_the_numbers():
    cur = {"sessions": 50, "views": 80, "bounce_rate": 0.7, "explored_rate": 0.2}
    top = {"sources": [{"name": "Direct", "count": 60}, {"name": "LinkedIn", "count": 20}],
           "devices": [{"name": "Phone", "count": 40}], "sections": [{"name": "Tara", "count": 30}, {"name": "Jasoos", "count": 5}]}  # fmt: skip
    titles = [a["title"] for a in advice(cur, top, {})]
    assert titles == ["Most visits have no known source", "Many visitors leave after one page", "Few visitors open a product",
                      "Phones are a big share", "Tara draws the most interest"]  # fmt: skip
