"""What Tara can look up and do, beyond remembering things.

Two kinds of tools:

* **Look-ups** run on the server against free, keyless sources and return a card for the screen plus plain facts
  the assistant turns into a spoken answer: weather (Open-Meteo), news headlines (Google News RSS), facts and quick
  answers (DuckDuckGo Instant Answers, whose summaries come from Wikipedia and others), exchange rates (Frankfurter) and the time anywhere (Open-Meteo
  geocoding + the IANA time-zone database).
* **Actions** are things only the user's device can do (open an app or site, play music, start directions, call,
  message, email, a timer, add to the calendar). The server returns the action; the browser carries it out, and
  anything that contacts a person (call, message, email) is only prepared for the user to confirm.

Every source failure becomes an honest, short message: nothing is ever made up.
"""

from __future__ import annotations

import datetime as dt
import logging
import re
import xml.etree.ElementTree as ET
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import quote, quote_plus, urlencode
from zoneinfo import ZoneInfo

import httpx

logger = logging.getLogger(__name__)

LOOKUPS = ("weather", "news", "wiki", "web", "currency", "time")
ACTIONS = ("open", "search", "play", "directions", "call", "message", "email", "timer", "calendar")
TOOLS = LOOKUPS + ACTIONS
UA = {"User-Agent": "TaraAssistant/1.0 (personal-assistant demo)"}

WMO = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
    66: "freezing rain", 67: "heavy freezing rain", 71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "rain showers", 81: "heavy showers", 82: "violent showers", 85: "snow showers", 86: "heavy snow showers",
    95: "thunderstorms", 96: "thunderstorms with hail", 99: "severe thunderstorms with hail",
}  # fmt: skip

SITES = {
    "youtube": "https://www.youtube.com", "gmail": "https://mail.google.com", "mail": "https://mail.google.com",
    "google maps": "https://maps.google.com", "maps": "https://maps.google.com", "calendar": "https://calendar.google.com",
    "google calendar": "https://calendar.google.com", "drive": "https://drive.google.com", "google drive": "https://drive.google.com",
    "docs": "https://docs.google.com", "sheets": "https://sheets.google.com", "whatsapp": "https://web.whatsapp.com",
    "spotify": "https://open.spotify.com", "netflix": "https://www.netflix.com", "amazon": "https://www.amazon.in",
    "flipkart": "https://www.flipkart.com", "linkedin": "https://www.linkedin.com", "github": "https://github.com",
    "instagram": "https://www.instagram.com", "facebook": "https://www.facebook.com", "twitter": "https://x.com",
    "x": "https://x.com", "reddit": "https://www.reddit.com", "chatgpt": "https://chatgpt.com", "news": "https://news.google.com",
    "outlook": "https://outlook.live.com", "teams": "https://teams.microsoft.com", "zoom": "https://zoom.us",
    "swiggy": "https://www.swiggy.com", "zomato": "https://www.zomato.com", "uber": "https://m.uber.com", "ola": "https://book.olacabs.com",
    "irctc": "https://www.irctc.co.in", "makemytrip": "https://www.makemytrip.com", "wikipedia": "https://www.wikipedia.org",
    "safarnaama": "/safarnaama", "codelens": "/codelens",
}  # fmt: skip

Fetch = Callable[[str, dict[str, Any]], Awaitable[httpx.Response]]


class ToolError(Exception):
    """A look-up that couldn't be done: the message is safe to say out loud."""


def _clean(v: Any, n: int = 200) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()[:n]


def _digits(v: Any) -> str:
    """A phone number for a tel:/sms: link (digits and a leading +), or ''."""
    s = re.sub(r"[^\d+]", "", str(v or ""))
    return s if 6 <= len(s.lstrip("+")) <= 15 else ""


class ToolBox:
    def __init__(self, fetch: Fetch | None = None) -> None:
        self._fetch = fetch  # injectable for tests: async (url, params) -> httpx.Response

    async def _get(self, url: str, params: dict[str, Any] | None = None) -> httpx.Response:
        if self._fetch is not None:
            return await self._fetch(url, params or {})
        async with httpx.AsyncClient(timeout=8, headers=UA, follow_redirects=True) as c:
            r = await c.get(url, params=params)
            r.raise_for_status()
            return r

    # ── look-ups ───────────────────────────────────────────────────────────
    async def _place(self, name: str) -> dict[str, Any]:
        r = await self._get("https://geocoding-api.open-meteo.com/v1/search", {"name": name, "count": 1})
        hits = r.json().get("results") or []
        if not hits:
            raise ToolError(f"I couldn't find a place called {name}.")
        h = hits[0]
        label = ", ".join(x for x in (h.get("name"), h.get("admin1"), h.get("country")) if x)
        return {"lat": h["latitude"], "lng": h["longitude"], "name": label, "tz": h.get("timezone") or "UTC"}

    async def weather(self, args: dict[str, Any], lat: float | None, lng: float | None, home: str) -> dict[str, Any]:
        place = _clean(args.get("place"), 80) or home
        if place:
            loc = await self._place(place)
        elif lat is not None and lng is not None:
            loc = {"lat": lat, "lng": lng, "name": "your location"}
        else:
            raise ToolError("Which city? Tell me, or set your home city in Tara's settings, or allow location.")
        r = await self._get(
            "https://api.open-meteo.com/v1/forecast",
            {
                "latitude": loc["lat"], "longitude": loc["lng"], "timezone": "auto", "forecast_days": 7,
                "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
                "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
            },
        )  # fmt: skip
        d = r.json()
        cur, daily = d.get("current") or {}, d.get("daily") or {}
        days = [
            {"date": daily["time"][i], "code": daily["weather_code"][i], "text": WMO.get(daily["weather_code"][i], "mixed"),
             "max": round(daily["temperature_2m_max"][i]), "min": round(daily["temperature_2m_min"][i]),
             "rain": daily["precipitation_probability_max"][i]}
            for i in range(len(daily.get("time") or []))
        ]  # fmt: skip
        card = {
            "type": "weather", "place": loc["name"], "temp": round(cur.get("temperature_2m", 0)),
            "feels": round(cur.get("apparent_temperature", 0)), "humidity": cur.get("relative_humidity_2m"),
            "wind": round(cur.get("wind_speed_10m", 0)), "code": cur.get("weather_code"),
            "text": WMO.get(cur.get("weather_code"), "mixed"), "days": days, "source": "Open-Meteo",
        }  # fmt: skip
        today = days[0] if days else {}
        tomorrow = days[1] if len(days) > 1 else {}
        facts = (
            f"Weather for {loc['name']} now: {card['temp']}°C, feels like {card['feels']}°C, {card['text']}, "
            f"humidity {card['humidity']}%, wind {card['wind']} km/h. Today: {today.get('min')}–{today.get('max')}°C, "
            f"{today.get('text')}, rain chance {today.get('rain')}%. Tomorrow: {tomorrow.get('min')}–{tomorrow.get('max')}°C, "
            f"{tomorrow.get('text')}, rain chance {tomorrow.get('rain')}%."
        )
        return {"card": card, "facts": facts}

    async def news(self, args: dict[str, Any], lang: str) -> dict[str, Any]:
        topic = _clean(args.get("topic") or args.get("query"), 80)
        region = (lang.split("-")[1] if "-" in lang else "IN").upper()
        hl = f"en-{region}"
        url = "https://news.google.com/rss/search" if topic else "https://news.google.com/rss"
        params = {"hl": hl, "gl": region, "ceid": f"{region}:en"} | ({"q": topic} if topic else {})
        r = await self._get(url, params)
        try:
            # Fixed host (Google News); Python 3.12 expat refuses entity-expansion attacks.
            root = ET.fromstring(r.text)  # noqa: S314
        except ET.ParseError as exc:
            raise ToolError("The news service sent something I couldn't read.") from exc
        items = []
        for it in root.iter("item"):
            title = _clean(it.findtext("title"), 220)
            source = _clean(it.findtext("source"), 60)
            if source and title.endswith(f" - {source}"):
                title = title[: -len(source) - 3]
            link = (it.findtext("link") or "").strip()
            if title and link.startswith("https://"):
                items.append(
                    {"title": title, "source": source, "link": link, "published": _clean(it.findtext("pubDate"), 40)}
                )
            if len(items) == 6:
                break
        if not items:
            raise ToolError(f"I couldn't find recent news{' about ' + topic if topic else ''}.")
        card = {"type": "news", "topic": topic, "items": items, "source": "Google News"}
        facts = (
            "Top headlines"
            + (f" about {topic}" if topic else "")
            + ": "
            + " | ".join(f"{i['title']} ({i['source']})" for i in items[:5])
        )
        return {"card": card, "facts": facts}

    async def wiki(self, args: dict[str, Any]) -> dict[str, Any]:
        """Who or what something is: DuckDuckGo Instant Answers (its summaries come from Wikipedia and others)."""
        q = _clean(args.get("query") or args.get("topic"), 120)
        if not q:
            raise ToolError("What should I look up?")
        return await self.web({"query": q})

    async def web(self, args: dict[str, Any]) -> dict[str, Any]:
        """A quick factual answer with its source, or, when there isn't one, the web search itself (never a guess)."""
        q = _clean(args.get("query"), 160)
        if not q:
            raise ToolError("What should I search for?")
        r = await self._get("https://api.duckduckgo.com/", {"q": q, "format": "json", "no_html": 1, "skip_disambig": 1})
        d = r.json()
        answer = _clean(d.get("Answer") or d.get("AbstractText") or d.get("Definition"), 900)
        search = {
            "type": "open",
            "url": f"https://www.google.com/search?q={quote_plus(q)}",
            "label": f"Search the web for {q}",
        }
        if not answer:
            return {"card": None, "facts": "", "action": search}
        image = str(d.get("Image") or "")
        card = {
            "type": "fact", "title": _clean(d.get("Heading"), 120) or q, "summary": answer,
            "link": d.get("AbstractURL") or d.get("DefinitionURL") or None,
            "image": ("https://duckduckgo.com" + image) if image.startswith("/") else (image or None),
            "source": _clean(d.get("AbstractSource") or d.get("DefinitionSource"), 40) or "DuckDuckGo",
        }  # fmt: skip
        return {"card": card, "facts": f"{card['title']} (source: {card['source']}): {answer}", "action": None}

    async def currency(self, args: dict[str, Any]) -> dict[str, Any]:
        base = _clean(args.get("from"), 3).upper() or "USD"
        to = _clean(args.get("to"), 3).upper() or "INR"
        try:
            amount = float(args.get("amount") or 1)
        except (TypeError, ValueError):
            amount = 1.0
        if not (re.fullmatch(r"[A-Z]{3}", base) and re.fullmatch(r"[A-Z]{3}", to)):
            raise ToolError("Which currencies? For example, dollars to rupees.")
        r = await self._get("https://api.frankfurter.dev/v1/latest", {"amount": amount, "from": base, "to": to})
        d = r.json()
        value = (d.get("rates") or {}).get(to)
        if value is None:
            raise ToolError(f"I don't have a rate for {base} to {to}.")
        card = {"type": "currency", "amount": amount, "from": base, "to": to, "value": value, "date": d.get("date"),
                "source": "Frankfurter (reference rates, not live quotes)"}  # fmt: skip
        return {"card": card, "facts": f"{amount:g} {base} = {value:,.2f} {to} (reference rate of {d.get('date')})."}

    async def time_in(self, args: dict[str, Any], now: dt.datetime) -> dict[str, Any]:
        place = _clean(args.get("place"), 80)
        if not place:
            return {
                "card": None,
                "facts": f"It is {now.strftime('%H:%M')} on {now.strftime('%A, %d %B %Y')} for the user.",
            }
        loc = await self._place(place)
        there = dt.datetime.now(ZoneInfo(loc["tz"]))
        card = {
            "type": "time",
            "place": loc["name"],
            "time": there.strftime("%H:%M"),
            "date": there.strftime("%A, %d %B"),
            "tz": loc["tz"],
        }
        return {"card": card, "facts": f"In {loc['name']} it is {card['time']} on {card['date']} ({loc['tz']})."}

    # ── actions the device carries out ─────────────────────────────────────
    @staticmethod
    def action(tool: str, args: dict[str, Any], now: dt.datetime) -> tuple[dict[str, Any] | None, str]:
        """(action for the browser, what Tara says). No action when something essential is missing."""
        a = {k: _clean(v, 300) if isinstance(v, str) else v for k, v in args.items()}
        if tool == "open":
            name = str(a.get("target") or a.get("app") or a.get("site") or "").strip()  # as the user said it
            target = name.lower()
            url = SITES.get(target) or SITES.get(target.removesuffix(".com"))
            if not url and re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+(/\S*)?", target):
                url = f"https://{target}"
            if not url:
                url = f"https://www.google.com/search?q={quote_plus(target)}" if target else ""
            return (
                ({"type": "open", "url": url, "label": f"Open {name or 'it'}"}, f"Opening {name or 'it'}.")
                if url
                else (None, "What should I open?")
            )
        if tool == "search":
            q = a.get("query") or ""
            return (
                (
                    {
                        "type": "open",
                        "url": f"https://www.google.com/search?q={quote_plus(q)}",
                        "label": f"Search for {q}",
                    },
                    f"Here's a search for {q}.",
                )
                if q
                else (None, "What should I search for?")
            )
        if tool == "play":
            q = a.get("query") or a.get("song") or "music"
            service = str(a.get("service") or "youtube").lower()
            url = (f"https://open.spotify.com/search/{quote(q)}" if "spotify" in service
                   else f"https://www.youtube.com/results?search_query={quote_plus(q)}")  # fmt: skip
            return {
                "type": "open",
                "url": url,
                "label": f"Play {q}",
            }, f"Playing {q} on {'Spotify' if 'spotify' in service else 'YouTube'}."
        if tool == "directions":
            dest = a.get("destination") or a.get("place") or ""
            mode = {"walk": "walking", "walking": "walking", "transit": "transit", "bus": "transit", "train": "transit",
                    "bike": "bicycling", "cycle": "bicycling"}.get(str(a.get("mode") or "").lower(), "driving")  # fmt: skip
            if not dest:
                return None, "Where to?"
            url = "https://www.google.com/maps/dir/?" + urlencode({"api": 1, "destination": dest, "travelmode": mode})
            return {
                "type": "open",
                "url": url,
                "label": f"Directions to {dest}",
            }, f"Here are {mode} directions to {dest}."
        if tool == "call":
            number = _digits(a.get("number"))
            who = a.get("contact") or number
            if not number:
                return (
                    None,
                    f"What's {who or 'the'} number? I can't see your contacts, so tell me the number and I'll dial it.",
                )
            return {
                "type": "call",
                "url": f"tel:{number}",
                "label": f"Call {who}",
                "confirm": True,
            }, f"Ready to call {who}. Tap call to dial."
        if tool == "message":
            number, text = _digits(a.get("number")), a.get("text") or ""
            who = a.get("contact") or number
            app = str(a.get("app") or "").lower()
            if "whatsapp" in app:
                url = (
                    f"https://wa.me/{number.lstrip('+')}?text={quote(text)}"
                    if number
                    else f"https://wa.me/?text={quote(text)}"
                )
            elif number:
                url = f"sms:{number}?&body={quote(text)}"
            else:
                return None, f"What's {who or 'their'} number? I can't see your contacts."
            return ({"type": "message", "url": url, "label": f"Message {who or 'on WhatsApp'}", "text": text, "confirm": True},
                    f"Your message to {who or 'WhatsApp'} is ready. Check it and tap send.")  # fmt: skip
        if tool == "email":
            to, subject, body = a.get("to") or "", a.get("subject") or "", a.get("body") or ""
            url = f"mailto:{quote(to, safe='@,.')}?" + urlencode({"subject": subject, "body": body}, quote_via=quote)
            return {
                "type": "email",
                "url": url,
                "label": f"Email {to or 'draft'}",
                "confirm": True,
            }, "Your email draft is ready. Check it and send."
        if tool == "timer":
            try:
                seconds = int(
                    float(a.get("seconds") or 0) + float(a.get("minutes") or 0) * 60 + float(a.get("hours") or 0) * 3600
                )
            except (TypeError, ValueError):
                seconds = 0
            if not 1 <= seconds <= 24 * 3600:
                return None, "For how long?"
            label = a.get("label") or "Timer"
            mins, secs = divmod(seconds, 60)
            spoken = (f"{mins} minute{'s' if mins != 1 else ''}" if mins else "") + (f" {secs} seconds" if secs else "")
            return {"type": "timer", "seconds": seconds, "label": label}, f"Timer set for {spoken.strip()}."
        if tool == "calendar":
            title = a.get("title") or "Event"
            try:
                day = dt.date.fromisoformat(str(a.get("date"))) if a.get("date") else now.date()
            except ValueError:
                day = now.date()
            t = str(a.get("time") or "")
            if re.fullmatch(r"\d{1,2}:\d{2}", t):
                start = dt.datetime.combine(day, dt.time(*map(int, t.split(":"))))
                mins = int(a.get("minutes") or 60)
                dates = f"{start:%Y%m%dT%H%M%S}/{start + dt.timedelta(minutes=mins):%Y%m%dT%H%M%S}"
            else:
                dates = f"{day:%Y%m%d}/{day + dt.timedelta(days=1):%Y%m%d}"
            url = "https://calendar.google.com/calendar/render?" + urlencode(
                {"action": "TEMPLATE", "text": title, "dates": dates}
            )
            return {
                "type": "open",
                "url": url,
                "label": f"Add “{title}” to Google Calendar",
            }, f"Here's {title} ready to add to your calendar."
        return None, "I can't do that one yet."


_PLACE = r"(?:in|at|for)\s+([A-Za-z][A-Za-z .'-]{1,40}?)"
_RULES: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(
            r"\b(weather|forecast|temperature|rain(?:ing)?|humid(?:ity)?)\b(?:.*?\b"
            + _PLACE
            + r")?\s*(?:today|tomorrow|now|this week)?[?.!]*$",
            re.I,
        ),
        "weather",
    ),
    (re.compile(r"\b(?:news|headlines)\b(?:\s+(?:about|on)\s+(.+?))?[?.!]*$", re.I), "news"),
    (re.compile(r"\btime\s+(?:is it\s+)?(?:now\s+)?" + _PLACE + r"[?.!]*$", re.I), "time"),
    (re.compile(r"\b(?:timer|countdown)\b.*?(\d+)\s*(second|sec|minute|min|hour|hr)s?\b", re.I), "timer"),
    (re.compile(r"^\s*(?:open|launch|go to)\s+(.+?)[?.!]*$", re.I), "open"),
    (re.compile(r"^\s*play\s+(.+?)[?.!]*$", re.I), "play"),
]


def rule_tool(text: str) -> tuple[str, dict[str, Any]] | None:
    """The common tool requests, recognised without a model (used when the model router is unavailable)."""
    for pattern, tool in _RULES:
        m = pattern.search(text or "")
        if not m:
            continue
        g = [x for x in m.groups() if x]
        if tool == "weather":
            return tool, {"place": g[-1].strip() if len(g) > 1 else None}
        if tool == "news":
            return tool, {"topic": g[0].strip() if g else None}
        if tool == "time":
            return tool, {"place": g[0].strip()}
        if tool == "timer":
            n, unit = int(m.group(1)), m.group(2).lower()
            return tool, {
                "seconds": n * (3600 if unit.startswith("h") else 60 if unit.startswith("m") else 1),
                "label": "Timer",
            }
        if tool == "open":
            return tool, {"target": g[0].strip()}
        if tool == "play":
            return tool, {"query": g[0].strip()}
    return None
