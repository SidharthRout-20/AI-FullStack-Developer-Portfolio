"""What a planned stop *is*: a real place to find on the map, or a moment of the day that isn't a place.

Models write stops like "Breakfast at Hotel", "Return & Rest at Hotel" or "Drive to Eravikulam National Park". Those
aren't places a map search can (or should) find, so they are never geocoded, never flagged as "not on the map", and
rest doesn't count as a busy day. Real places get several search variants, because model names carry extras that map
search doesn't understand ("Tata Tea Museum (Munnar Tea Museum)", "Stroll through Munnar Market").
"""

from __future__ import annotations

import re

_STAY_WORDS = r"(?:hotel|homestay|home ?stay|resort|guest ?house|stay|room|accommodation|villa|lodge|airbnb)"
# meals and breaks at wherever the traveller is staying ("Breakfast at Hotel"), not at a named one
_MEAL_AT_STAY = re.compile(
    rf"^(?:\w+\s+){{0,2}}(?:breakfast|brunch|lunch|dinner|tea|coffee|meal|supper)\b(.*)\b{_STAY_WORDS}\b", re.I
)
_STAY_RE = re.compile(rf"\b{_STAY_WORDS}\b", re.I)
_PLACELESS = re.compile(
    r"^(?:"
    # moving around, arriving, leaving, resting, packing
    r"(?:return|back|head back|go back|check[- ]?in|check[- ]?out|pack|packing|rest|relax|unwind|free time|"
    r"drive|travel|transfer|depart|departure|arrive|arrival|leave|journey|commute|freshen up)\b"
    # getting somewhere by taxi, cab, bus...: "Taxi to Patan", "Cable-car descent & taxi back to Kathmandu"
    r"|.*\b(?:taxi|cab|uber|ola|grab|rickshaw|tuk-?tuk|shuttle|bus|train|flight|ferry|transfer|drive)\s+"
    r"(?:to|back|from|ride to)\b"
    r"|(?:return|airport)\s+(?:taxi|cab|transfer)\b"
    r")",
    re.I,
)
# Typographic dashes and hyphens models like to use ("Cable‑car", "Lunch – Newa cuisine at ...").
_DASHES = str.maketrans({c: "-" for c in "\u2010\u2011\u2012\u2013\u2014\u2015\u2212"})
_MEAL_AT = re.compile(r"^(?:breakfast|brunch|lunch|dinner|supper|coffee|tea|drinks|snacks?)\b.*?\bat\s+", re.I)
_ACTIVITY_TAIL = re.compile(r"\s+(?:rafting|trek|trekking|hike|hiking|tour|walk|ride|boating|cruise|visit)$", re.I)


def _plain(name: str | None) -> str:
    return " ".join((name or "").translate(_DASHES).split())


def generic(name: str) -> bool:
    """An activity with no place in it ("Short hike to the summit & viewpoint", "Visit a local market"): place names
    are capitalised (or written in their own script), so a name with neither after its first word names no place."""
    words = re.sub(r"\s*\([^)]*\)", "", _plain(name)).split()[1:]
    return bool(words) and not _named(words)


_REST = re.compile(r"\b(rest|relax|unwind|free time|freshen up|pack|packing)\b", re.I)
_LEADING_VERB = re.compile(
    r"^(?:(?:farewell|welcome|sunset|sunrise|early|late|leisurely|quick)\s+)?"
    r"(?:visit(?: to)?|stroll (?:through|around|in|along)|walk (?:through|around|in|along|to)|explore|exploring|"
    r"tour of|guided tour of|trip to|hike (?:to|up)|boat ride (?:at|on)|boating (?:at|on)|sunset at|sunrise at|"
    r"photo stop at|shopping (?:at|in)|(?:cable-?car |boat |jeep |camel |toy train )?ride (?:to|at|on|up)|breakfast at|brunch at|lunch at|dinner at|coffee at|tea at)\s+",
    re.I,
)


def placeless(name: str) -> bool:
    """True for stops that are a part of the day rather than a place (hotel meals, rest, travel legs)."""
    plain = _plain(name)
    meal = _MEAL_AT_STAY.search(plain)
    if meal and not _named(_STAY_RE.sub("", meal.group(0)).split()[1:]):
        return True  # "Breakfast at Hotel" (but "Lunch at Sundarijal Guesthouse" is a place)
    return bool(_PLACELESS.search(plain)) or generic(plain)


def _named(words: list[str]) -> bool:
    return any(w[:1].isupper() or w[:1].isdigit() or not w.isascii() for w in words)


def is_rest(name: str) -> bool:
    """Rest, free time or packing: not 'busy' time when judging whether a day is too long."""
    return placeless(name) and bool(_REST.search(name or ""))


def place_queries(name: str, place_query: str | None, city: str) -> list[str]:
    """Map-search phrases for a stop, most specific first, without duplicates."""
    name = _plain(name)
    core = re.sub(r"\s*\([^)]*\)", "", name).strip()
    core = _MEAL_AT.sub("", core).strip() or core  # "Lunch - Newa cuisine at Bhojan Griha" → "Bhojan Griha"
    core = _LEADING_VERB.sub("", core).strip() or core
    first = re.split(r"\s+(?:&|and|-|/|\+)\s+", core)[0].strip()
    bare = _ACTIVITY_TAIL.sub("", first).strip()  # "Trishuli River Rafting" → "Trishuli River"
    alias = re.search(r"\(([^)]+)\)", name)
    alias_text = alias and re.sub(r"^(?:e\.g\.,?|i\.e\.,?|aka|or)\s+", "", alias.group(1).strip(), flags=re.I)
    out: list[str] = []
    for q in (_plain(place_query), f"{core}, {city}", f"{first}, {city}", f"{bare}, {city}",
              alias_text and f"{alias_text}, {city}"):  # fmt: skip
        q = (q or "").strip()
        if len(q) >= 4 and q.lower() not in (x.lower() for x in out):
            out.append(q)
    return out
