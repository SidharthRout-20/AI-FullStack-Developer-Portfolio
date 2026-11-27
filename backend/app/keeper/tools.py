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

import asyncio
import datetime as dt
import logging
import re
import xml.etree.ElementTree as ET
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import quote, quote_plus, urlencode
from zoneinfo import ZoneInfo

import httpx

from app.keeper.repo import RepoIndex

logger = logging.getLogger(__name__)

LOOKUPS = ("weather", "news", "wiki", "web", "currency", "time", "code", "portfolio")
ACTIONS = (
    "product",
    "open",
    "search",
    "play",
    "directions",
    "call",
    "message",
    "email",
    "timer",
    "calendar",
    "edit",
    "settings",
)
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
    # This portfolio's own products open in the same tab.
    "safarnaama": "/safarnaama", "safarnama": "/safarnaama", "codelens": "/codelens", "code lens": "/codelens",
    "tara": "/keeper", "jasoos": "/jasoos", "quality": "/quality", "quality page": "/quality", "evals": "/quality",
    "portfolio": "/", "home": "/", "home page": "/",
}  # fmt: skip

# The product inventory: what each of this site's products does. Tara hands a request to the product built for it
# before answering it herself (a trip goes to Safarnaama, which plans with real places, weather and routes; Tara would
# only be guessing). `route(args)` builds the link, with what the user asked already filled in where the product can
# take it.
PRODUCTS: dict[str, dict[str, Any]] = {
    "safarnaama": {
        "name": "Safarnaama",
        "does": "plans trips and itineraries: a day-by-day plan with real places, weather and routes, then bookings, "
        "budget and documents",
        "route": lambda a: "/safarnaama" + (f"?{urlencode({'to': a['place']})}" if a.get("place") else ""),
        "say": lambda a: (
            f"Safarnaama plans this properly, with real places, weather and routes. I've set {a['place']} as the "
            "destination: tap to open it and pick your dates."
            if a.get("place")
            else "Safarnaama plans this properly, with real places, weather and routes. Tap to open it and pick a place."
        ),
    },
    "codelens": {
        "name": "CodeLens",
        "does": "explains a GitHub repository or codebase: an onboarding pack, a week-one plan, and answers that cite "
        "files and lines",
        "route": lambda a: "/codelens",
        "say": lambda a: (
            "CodeLens is built for this: paste the GitHub repo and it maps the code and answers with the "
            "exact files and lines. Tap to open it."
        ),
    },
    "jasoos": {
        "name": "Jasoos",
        "does": "finds why a build, CI run or test failed: paste the log and get the failing step, the cause and a fix",
        "route": lambda a: "/jasoos",
        "say": lambda a: (
            "Jasoos is built for this: paste the failing log and it finds the step, the likely cause and a "
            "fix, quoting the lines it used. Tap to open it."
        ),
    },
    "quality": {
        "name": "the Quality page",
        "does": "shows how well each product works, measured: evaluation scores, latency and what they got wrong",
        "route": lambda a: "/quality",
        "say": lambda a: "The Quality page has the measured numbers for every product. Tap to open it.",
    },
}

_TRIP = re.compile(
    r"\b(itinerar(?:y|ies)|sightseeing|day ?trips?|road ?trips?|getaways?|vacation|holiday|travel(?:l?ing)? "
    r"(?:tips?|ideas?|plans?|suggestions?|guide)|trip (?:ideas?|tips?|plans?|to)|"
    r"plan (?:a|my|our|the)? ?(?:trip|visit|tour|holiday|weekend|day out|outing)|weekend (?:plans?|trip|outing)|"
    r"(?:places|things|spots) (?:to (?:visit|see|do|go)|nearby|near me|around (?:me|here))|"
    r"(?:nearby|tourist|local) (?:places|spots|attractions|getaways?|trips?|sights)|"
    r"where (?:should|can|could) (?:i|we) (?:go|travel|visit)|hill stations?|tourist|tour of|"
    r"(?:visit|explore|exploring) (?:nearby|around)|what (?:can|should|could) (?:i|we) (?:do|see) (?:in|around|near|at))\b",
    re.I,
)
_NEARBY = re.compile(r"\b(?:nearby|near me|around me|around here|near here|close by|local)\b", re.I)
_TRIP_PLACE = re.compile(
    r"(?:\b(?:in|around|near|at|visit(?:ing)?|explore|exploring)|\b(?:trip|travel(?:l?ing)?|go(?:ing)?|fly(?:ing)?|getaway|"
    r"drive|driving|holiday|vacation|weekend|visit)\s+to|\btour\s+of|\b(?:getaways?|trips?|drives?|escapes?)\s+from)\s+([A-Za-z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,2})",
    re.I,
)
_NOT_PLACES = {"a", "an", "the", "my", "our", "me", "us", "it", "this", "that", "next", "nearby", "weekend", "today",
               "places", "place", "things", "spots", "list", "somewhere", "anywhere", "i", "we", "can", "good", "some",
               "tomorrow", "march", "april", "may", "june", "july", "august", "december", "january", "february",
               "september", "october", "november", "one", "two", "three", "days", "day", "week", "family", "kids", "for",
               "with", "and", "on", "by"}  # fmt: skip
_CODE = re.compile(
    r"github\.com/[\w.-]+/[\w.-]+|\b(?:understand|explain|onboard(?: me)? (?:onto|to)|walk me through)\b.{0,30}\b(?:repo|repository|codebase|code base)\b",
    re.I,
)
_BUILD = re.compile(
    r"\b(?:build|ci|pipeline|deploy(?:ment)?|workflow|github actions|test suite|unit tests|tests)\b.{0,25}"
    r"\b(?:fail(?:ed|ing|s)?|broke(?:n)?|is red|errors?)\b|\b(?:stack ?trace|traceback|error log|build log)\b",
    re.I,
)
_NAMED = re.compile(r"\b(safarnaa?ma|code ?lens|jasoos|quality page)\b", re.I)
_NAMES = {"safarnama": "safarnaama", "safarnaama": "safarnaama", "codelens": "codelens", "code lens": "codelens",
          "jasoos": "jasoos", "quality page": "quality"}  # fmt: skip


def place_in(text: str) -> str | None:
    """The place a trip request is about ("nearby places in Bangalore" → "Bangalore"), if it names one."""
    found = None
    for m in _TRIP_PLACE.finditer(text or ""):  # the last one wins: "an itinerary for places in Bangalore"
        words = [w.strip(".,!?'") for w in m.group(1).split()]
        cut = next(
            (
                k
                for k, w in enumerate(words)
                if k and w.lower() in ("from", "for", "with", "and", "on", "by", "this", "next")
            ),
            None,
        )
        words = words[:cut]  # "Coorg from Bengaluru" → "Coorg"
        while words and words[-1].lower() in _NOT_PLACES:
            words.pop()
        while words and words[0].lower() in ("near", "around", "in", "at", "to"):  # "visit near Mysore"
            words.pop(0)
        if words and words[0].lower() not in _NOT_PLACES:
            found = " ".join(words).title()
    return found


def rule_product(
    text: str, history: list[dict[str, str]] | None = None, home: str = ""
) -> tuple[str, dict[str, Any]] | None:
    """A request one of the site's products is built for, recognised without a model.

    Also: naming a product about an earlier request ("why didn't you use Safarnaama for this?", "do it in
    Safarnaama") hands that earlier request to it. "Nearby" means the user's home city when they have set one.
    """
    t = text or ""
    earlier = [str(h.get("text") or "") for h in (history or []) if h.get("role") == "user"][::-1]

    def trip_place(*texts: str) -> str | None:
        for x in texts:
            if p := place_in(x):
                return p
        return home.strip().title() or None if any(_NEARBY.search(x) for x in texts) else None

    if named := _NAMED.search(t):
        product = _NAMES[re.sub(r"\s+", " ", named.group(1).lower())]
        trips = [e for e in earlier if _TRIP.search(e)]
        place = trip_place(t, *trips) if product == "safarnaama" else None
        return "product", {"product": product, "named": True, **({"place": place} if place else {})}
    if _TRIP.search(t):
        return "product", {"product": "safarnaama", **({"place": p} if (p := trip_place(t)) else {})}
    if _CODE.search(t):
        return "product", {"product": "codelens"}
    if _BUILD.search(t):
        return "product", {"product": "jasoos"}
    return None


_YES = re.compile(
    r"^\s*(?:yes|yeah|yep|yup|ya|sure|ok(?:ay)?|please|go ahead|go for it|do it|let'?s do it|sounds good|absolutely|"
    r"of course|why not|alright|great)\b.{0,40}$|"
    r"^\s*(?:(?:i|we) (?:want|need|would like|'?d like)(?: you)?(?: to)? (?:one|it|that|do it|do that|plan it|plan one|make it|make one|"
    r"have it|have one)|(?:can|could|would|will) you (?:do|plan|make) (?:it|that|one)|please (?:do|plan) (?:it|that|one)?|"
    r"do that|plan it|make it so)\b.{0,30}$",
    re.I,
)


def accepted_offer(
    text: str, history: list[dict[str, str]] | None, home: str = ""
) -> tuple[str, dict[str, Any]] | None:
    """A short "yes" / "I want you to do it" right after Tara mentioned one of the products: open that product for
    the earlier request."""
    if not _YES.search(text or "") or not history:
        return None
    last = next((str(h.get("text") or "") for h in reversed(history) if h.get("role") == "assistant"), "")
    if not (named := list(_NAMED.finditer(last))):
        return None
    hit = rule_product(named[-1].group(1), history, home)
    return (hit[0], {**{k: v for k, v in hit[1].items() if k != "named"}, "accepted": True}) if hit else None


def products_menu() -> str:
    """The inventory as the router sees it."""
    return "\n".join(f'        "{k}": {p["does"]}' for k, p in PRODUCTS.items())


Fetch = Callable[[str, dict[str, Any]], Awaitable[httpx.Response]]
# Searches the portfolio's indexed documents (résumé, project notes): query -> [{"source", "text"}].
Knowledge = Callable[[str], Awaitable[list[dict[str, Any]]]]


class ToolError(Exception):
    """A look-up that couldn't be done: the message is safe to say out loud."""


def _clean(v: Any, n: int = 200) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()[:n]


def _digits(v: Any) -> str:
    """A phone number for a tel:/sms: link (digits and a leading +), or ''."""
    s = re.sub(r"[^\d+]", "", str(v or ""))
    return s if 6 <= len(s.lstrip("+")) <= 15 else ""


class ToolBox:
    def __init__(self, fetch: Fetch | None = None, repo: RepoIndex | None = None,
                 knowledge: Knowledge | None = None) -> None:  # fmt: skip
        self._fetch = fetch  # injectable for tests: async (url, params) -> httpx.Response
        self.repo = repo  # this portfolio's source code, read-only
        self.knowledge = knowledge  # set by the app once the document index exists

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

    async def code(self, args: dict[str, Any]) -> dict[str, Any]:
        """Where something lives in this portfolio's own code, with the code itself for the answer."""
        q = _clean(args.get("query"), 200)
        if not q:
            raise ToolError("What part of the code should I look at?")
        if self.repo is None:
            raise ToolError("The source code isn't available on this server.")
        hits = await asyncio.to_thread(self.repo.search, q)
        if not hits:
            raise ToolError(f"I couldn't find anything about {q} in this portfolio's code.")
        card = {
            "type": "code", "query": q, "source": "This portfolio's source code",
            "hits": [{"path": h["path"], "start": h["start"], "end": h["end"], "symbol": h.get("symbol"),
                      "preview": "\n".join(ln for ln in h["text"].splitlines() if ln.strip())[:600]} for h in hits],
        }  # fmt: skip
        facts = "\n\n".join(
            f"FILE {h['path']} lines {h['start']}-{h['end']}"
            + (f" ({h['symbol']})" if h.get("symbol") else "")
            + ":\n"
            + h["text"][:1500]
            for h in hits
        )
        return {"card": card, "facts": facts}

    async def portfolio(self, args: dict[str, Any]) -> dict[str, Any]:
        """Answers about Sidharth and this site's products, from the documents behind the "Ask Tara" panel."""
        q = _clean(args.get("query"), 200)
        if not q:
            raise ToolError("What would you like to know about the portfolio?")
        if self.knowledge is None:
            raise ToolError("The portfolio's documents aren't loaded on this server yet.")
        hits = [h for h in await self.knowledge(q) if (h.get("text") or "").strip()][:4]
        if not hits:
            raise ToolError("The portfolio's documents don't cover that.")
        sources = list(dict.fromkeys(str(h.get("source") or "document") for h in hits))
        card = {"type": "sources", "query": q, "items": sources, "source": "Sidharth's résumé and project notes"}
        facts = "\n\n".join(f"FROM {h.get('source')}: {str(h['text'])[:1200]}" for h in hits)
        return {"card": card, "facts": facts}

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
        if tool == "product":  # hand the request to the site's own product built for it
            key = str(a.get("product") or "").lower().strip()
            key = _NAMES.get(key, key)
            if key not in PRODUCTS:
                return None, "Which product should I open?"
            p, args = PRODUCTS[key], {k: v for k, v in a.items() if v}
            place = str(args.get("place") or "").strip()
            if place and all(
                w.lower().strip(".,") in _NOT_PLACES | {"near", "around", "here", "local", "home", "city"}
                for w in place.split()
            ):
                args.pop("place")  # "nearby", "near me", "around here": not a destination
            url = p["route"](args)
            label = (
                f"Plan {args['place']} in Safarnaama"
                if key == "safarnaama" and args.get("place")
                else f"Open {p['name']}"
            )
            cta = "Plan it" if key == "safarnaama" else "Open"
            lead = (
                "On it. "
                if args.get("accepted")
                else f"You're right, this is {p['name']}'s job. "
                if args.get("named")
                else ""
            )
            return {"type": "open", "url": url, "label": label, "product": key, "cta": cta, "confirm": True}, lead + p[
                "say"
            ](args)
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
        if tool == "settings":  # how Tara talks and behaves for this user: applied on their device, no owner needed
            setting = str(a.get("setting") or "open").lower().strip()
            value = str(a.get("value") or "").strip()[:60]
            if setting not in SETTINGS:
                setting = "open"
            said = SETTINGS[setting](value.lower()) if setting != "name" else (
                f"Nice to meet you, {value}. I'll call you that." if value else "What should I call you?")  # fmt: skip
            return (
                {
                    "type": "settings",
                    "setting": setting,
                    "value": value,
                    "label": "Voice & personality",
                    "confirm": True,
                },
                said,
            )
        if tool == "edit":  # a change to this site's code: planned and proposed as a pull request, owner only
            req = str(a.get("request") or "").strip()
            if len(req) < 8:
                return None, "What should I change in the code?"
            return (
                {"type": "edit", "request": req[:2000], "label": "Propose a code change", "confirm": True},
                "I can propose that as a pull request. Only the owner can go ahead, and it's reviewed before merging.",
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


# What Tara says after changing one of the user's own settings (the device applies the change).
def _onoff(v: str) -> bool:
    return not re.search(r"\b(off|no|stop|disable|don'?t|never|mute|quiet)\b", v)


SETTINGS: dict[str, Callable[[str], str]] = {
    "voice": lambda v: "Here's my new voice. How does this sound?",
    "speed": lambda v: "Okay, I'll speak a little slower." if "slow" in v else "Okay, I'll speak a little faster.",
    "pitch": lambda v: "Okay, a lower voice." if re.search(r"low|deep", v) else "Okay, a higher voice.",
    "tone": lambda v: f"Got it, I'll be more {v or 'warm'}.",
    "length": lambda v: (
        "Sure, short answers from now on."
        if re.search(r"short|brief|concise", v)
        else "Sure, I'll give you more detail."
    ),
    "language": lambda v: f"Okay, switching to {v or 'that language'}.",
    "wake": lambda v: "Hey Tara is on." if _onoff(v) else "Okay, I won't listen for Hey Tara.",
    "speak": lambda v: "I'll read my answers aloud." if _onoff(v) else "Okay, I'll answer quietly, on screen only.",
    "sounds": lambda v: "Chimes are on." if _onoff(v) else "Chimes off.",
    "keep": lambda v: "I'll keep listening after each answer." if _onoff(v) else "Okay, one question at a time.",
    "city": lambda v: f"Got it, {v.title()} is your home city now." if v else "Which city?",
    "open": lambda v: "Here are my voice and personality settings.",
    "name": lambda v: "",
}

_SETTING_RULES: list[tuple[re.Pattern[str], str, Callable[[re.Match[str]], str]]] = [
    (
        re.compile(
            r"\b(?:change|switch|new|different|another)\b.*\bvoice\b|\bvoice\b.*\b(?:female|male|woman|man)\b", re.I
        ),
        "voice",
        lambda m: (
            "female"
            if re.search(r"female|woman|girl", m.string, re.I)
            else "male"
            if re.search(r"\bmale\b|\bman\b", m.string, re.I)
            else "different"
        ),
    ),
    (
        re.compile(r"\b(?:speak|talk)\b.*\b(faster|slower|quicker|slowly|quickly)\b", re.I),
        "speed",
        lambda m: m.group(1),
    ),
    (re.compile(r"\bcall me ([A-Z][\w'-]{1,30})", re.I), "name", lambda m: m.group(1)),
]


def rule_settings(text: str) -> tuple[str, dict[str, Any]] | None:
    for pattern, setting, value in _SETTING_RULES:
        if m := pattern.search(text or ""):
            return "settings", {"setting": setting, "value": value(m)}
    return None


def rule_tool(text: str) -> tuple[str, dict[str, Any]] | None:
    """The common tool requests, recognised without a model (used when the model router is unavailable)."""
    if hit := rule_settings(text):
        return hit
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
