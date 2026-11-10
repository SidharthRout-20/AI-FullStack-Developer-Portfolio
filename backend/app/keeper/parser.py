"""Rule-based understanding: the offline fallback for the LLM router.

Keeper must keep working with no LLM (no key, quota exhausted, provider down), so the common
phrasings of every chore are handled here with plain regular expressions and a small date parser.
The LLM handles everything fuzzier; tests run against this module, so they are deterministic.
"""

from __future__ import annotations

import calendar
import datetime as dt
import re

from app.keeper.models import Command
from app.keeper.schedule import add_months

MONTHS = (
    {m.lower(): i for i, m in enumerate(calendar.month_name) if m}
    | {m.lower(): i for i, m in enumerate(calendar.month_abbr) if m}
    | {"sept": 9}
)
WEEKDAYS = {d.lower(): i for i, d in enumerate(calendar.day_name)}
_MONTH = "|".join(sorted(MONTHS, key=len, reverse=True))
_ORD = r"(?:st|nd|rd|th)?"

_ISO = re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b")
_DMY = re.compile(r"\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b")  # day first (en-IN / en-GB)
_D_MON = re.compile(rf"\b(\d{{1,2}}){_ORD}\s+(?:of\s+)?({_MONTH})\.?,?(?:\s+(\d{{4}}))?\b", re.I)
_MON_D = re.compile(rf"\b({_MONTH})\.?\s+(\d{{1,2}}){_ORD},?(?:\s+(\d{{4}}))?\b", re.I)
_MON_Y = re.compile(rf"\b({_MONTH})\.?\s+(\d{{4}})\b", re.I)
_IN_N = re.compile(r"\bin\s+(\d{1,3}|a|an|one|two|three)\s+(day|week|month|year)s?\b", re.I)
_DAY_ONLY = re.compile(rf"\b(?:on|by|before)\s+(?:the\s+)?(\d{{1,2}}){_ORD}\b(?!\s*(?:{_MONTH}|[:/.]|am|pm))", re.I)
_WEEKDAY = re.compile(r"\b(?:on\s+|next\s+|this\s+)?(" + "|".join(WEEKDAYS) + r")\b", re.I)
_TIME = re.compile(r"\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b", re.I)
_EVERY = re.compile(r"\bevery\s+(\d{1,3}|other)?\s*(day|week|month|year)s?\b", re.I)
_MONEY = re.compile(
    r"(₹|rs\.?|inr|\$|usd|€|eur|£)\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(rs|inr|rupees|dollars|usd|eur)\b",
    re.I,
)
_WORDNUM = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "other": 2}
_CURRENCY = {"₹": "₹", "rs": "₹", "rs.": "₹", "inr": "₹", "rupees": "₹", "$": "$", "usd": "$", "dollars": "$",
             "€": "€", "eur": "€", "£": "£"}  # fmt: skip


def _year(y: str | None) -> int | None:
    if not y:
        return None
    n = int(y)
    return n + 2000 if n < 100 else n


def _safe(y: int, m: int, d: int) -> dt.date | None:
    try:
        return dt.date(y, m, d)
    except ValueError:
        return None


def _future(m: int, d: int, today: dt.date) -> dt.date | None:
    """A date with no year means its next occurrence."""
    for y in (today.year, today.year + 1):
        if (c := _safe(y, m, d)) and c >= today:
            return c
    return None


def parse_date(text: str, today: dt.date) -> dt.date | None:
    t = text.lower()
    if m := _ISO.search(t):
        return _safe(int(m[1]), int(m[2]), int(m[3]))
    if m := _DMY.search(t):
        return _safe(_year(m[3]) or today.year, int(m[2]), int(m[1]))
    if m := _D_MON.search(t):
        y = _year(m[3])
        return _safe(y, MONTHS[m[2].lower()], int(m[1])) if y else _future(MONTHS[m[2].lower()], int(m[1]), today)
    if m := _MON_D.search(t):
        y = _year(m[3])
        return _safe(y, MONTHS[m[1].lower()], int(m[2])) if y else _future(MONTHS[m[1].lower()], int(m[2]), today)
    if m := _MON_Y.search(t):  # "March 2027" → end of that month (typical for expiries)
        y, mo = int(m[2]), MONTHS[m[1].lower()]
        return dt.date(y, mo, calendar.monthrange(y, mo)[1])
    if "day after tomorrow" in t:
        return today + dt.timedelta(days=2)
    if re.search(r"\btomorrow\b", t):
        return today + dt.timedelta(days=1)
    if re.search(r"\btoday\b|\btonight\b", t):
        return today
    if m := _IN_N.search(t):
        n = _WORDNUM.get(m[1].lower()) or int(m[1])
        unit = m[2].lower()
        if unit == "day":
            return today + dt.timedelta(days=n)
        if unit == "week":
            return today + dt.timedelta(weeks=n)
        return add_months(today, n * (12 if unit == "year" else 1))
    if re.search(r"\bnext week\b", t):
        return today + dt.timedelta(days=7)
    if re.search(r"\bnext month\b", t):
        return add_months(today, 1)
    if re.search(r"\bnext year\b", t):
        return add_months(today, 12)
    if m := _DAY_ONLY.search(t):  # "due on the 15th" → next 15th
        day = int(m[1])
        for k in range(0, 3):
            base = add_months(today.replace(day=1), k)
            if (c := _safe(base.year, base.month, day)) and c >= today:
                return c
    if m := _WEEKDAY.search(t):
        ahead = (WEEKDAYS[m[1].lower()] - today.weekday()) % 7 or 7
        return today + dt.timedelta(days=ahead)
    return None


def parse_times(text: str) -> list[str]:
    out: list[str] = []
    for m in _TIME.finditer(text):
        if m[3]:  # 12-hour clock
            h = int(m[1]) % 12 + (12 if m[3].lower() == "pm" else 0)
            out.append(f"{h:02d}:{int(m[2] or 0):02d}")
        else:
            out.append(f"{int(m[4]):02d}:{m[5]}")
    if not out:
        if re.search(r"\bmorning\b", text, re.I):
            out.append("08:00")
        if re.search(r"\b(night|bedtime)\b", text, re.I):
            out.append("21:00")
    return sorted(set(out))


def parse_every(text: str) -> tuple[int | None, int | None]:
    """→ (every_days, every_months)"""
    t = text.lower()
    if m := _EVERY.search(t):
        n = _WORDNUM.get(m[1] or "", None) or (int(m[1]) if m[1] and m[1].isdigit() else 1)
        unit = m[2]
        if unit == "day":
            return n, None
        if unit == "week":
            return 7 * n, None
        return None, n * (12 if unit == "year" else 1)
    if re.search(r"\b(daily|every ?day|each day)\b", t):
        return 1, None
    if re.search(r"\bweekly\b", t):
        return 7, None
    if re.search(r"\bmonthly\b", t):
        return None, 1
    if re.search(r"\b(yearly|annual(ly)?)\b", t):
        return None, 12
    return None, None


def parse_money(text: str) -> tuple[float | None, str | None]:
    if m := _MONEY.search(text):
        num = m[2] or m[3]
        cur = (m[1] or m[4] or "").lower()
        return float(num.replace(",", "")), _CURRENCY.get(cur)
    return None, None


# ── Text clean-up helpers ─────────────────────────────────────────────────
_LEAD = re.compile(
    r"^(?:(?:hey |ok )?keeper[,:]?\s+)?(?:please\s+)?(?:remember(?: that)?\s+|note(?: that)?\s+|remind me that\s+)?",
    re.I,
)
_FILLER = re.compile(r"^(?:my|the|our|a|an|some|i)\s+", re.I)
_DATE_TAIL = re.compile(
    rf"\s*(?:\b(?:on|by|before|until|till|due|from|at)\b\s*)?(?:\d{{4}}-\d{{1,2}}-\d{{1,2}}|\d{{1,2}}[/.-]\d{{1,2}}[/.-]\d{{2,4}}|"
    rf"\d{{1,2}}{_ORD}\s+(?:of\s+)?(?:{_MONTH})\.?,?(?:\s+\d{{4}})?|(?:{_MONTH})\.?\s+\d{{1,2}}{_ORD},?(?:\s+\d{{4}})?|"
    rf"(?:{_MONTH})\.?\s+\d{{4}}|tomorrow|today|tonight|(?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|"
    rf"next (?:week|month|year)|in \d+ (?:day|week|month|year)s?|\d{{1,2}}(?::\d{{2}})?\s*(?:am|pm)).*$",
    re.I,
)


def _title(s: str) -> str:
    s = _FILLER.sub("", s.strip(" .,!?:;-"))
    s = _FILLER.sub("", s)
    return (s[:1].upper() + s[1:])[:120] if s else ""


def _items(s: str) -> list[str]:
    s = re.sub(r"\b(?:to|on|in)\s+(?:the\s+|my\s+)?(?:shopping\s+|grocery\s+)?list\b.*$", "", s, flags=re.I)
    parts = re.split(r",|\band\b|&|\+", s)
    return [t for p in parts if (t := _title(p))][:30]


VEHICLES = r"car|bike|scooter|scooty|motorbike|cycle|bicycle|truck|van"
PILLS = r"medicine|medication|tablet|pill|capsule|vitamin|dose|syrup|insulin|meds|supplement|\d+\s?(?:mg|ml|mcg|iu)"
_BARE_NUMBER = re.compile(
    r"(?<![\d/.:-])(\d{2,3}(?:,\d{3})+|\d{3,6})(?:\.\d+)?(?![\d/.:-]|\s*(?:st|nd|rd|th|am|pm|mg|days?|months?)\b)"
)


def rule_parse(text: str, today: dt.date) -> Command:  # noqa: C901 - a flat list of rules reads best
    raw = _LEAD.sub("", text.strip()).strip()
    t = raw.lower().rstrip("?.! ")

    if m := re.match(r"^remind me to\s+(.+)$", t):  # one-off reminder
        what = _DATE_TAIL.sub("", m[1]) or m[1]
        return Command(action="add", kind="care", subject="other", title=_title(re.sub(r"\s+(?:on|at|by)$", "", what)),
                       date=parse_date(m[1], today) or today, times=parse_times(m[1])[:1])  # fmt: skip

    if re.match(r"^(help|what can you do|how do(es)? (this|it|you) work)\b", t):
        return Command(action="help")
    if re.search(r"\b(brief|agenda|what'?s (due|up|on|pending)|my day|today'?s plan|anything due)\b", t):
        return Command(action="brief")
    if re.search(r"\b(shopping list|what do (i|we) need|grocery list|groceries)\b", t) and not re.search(
        r"\b(add|need to buy|out of)\b", t
    ):
        return Command(action="list", kind="pantry")

    # Parking
    if re.search(rf"\bwhere('?s| is| did i park| have i parked)\b.*\b({VEHICLES})\b|\bwhere did i park\b", t):
        return Command(action="find", kind="parking")
    if m := re.search(
        rf"\b(?:i\s+)?(?:parked|park)\b(?:\s+(?:my|the)\s+({VEHICLES}))?\s*(?:(?:at|on|in|near|by|outside|behind)\s+(.+))?$",
        t,
    ):
        return Command(action="add", kind="parking", title=_title(m[1] or "car"), place=m[2] and raw[-len(m[2]) :])

    # Lend & borrow
    if m := re.search(r"^(\w+)\s+(?:returned|gave back)\s+(?:my\s+|the\s+)?(.+?)$", t):
        return Command(action="done", kind="loan", title=_title(m[2]), person=m[1].title())
    if m := re.search(r"\bgot\s+(?:my\s+|the\s+)?(.+?)\s+back(?:\s+from\s+(\w+))?$", t):
        return Command(action="done", kind="loan", title=_title(m[1]), person=m[2] and m[2].title())
    if m := re.search(r"\breturned\s+(?:the\s+|my\s+|his\s+|her\s+)?(.+?)\s+to\s+(\w+)", t):
        return Command(action="done", kind="loan", title=_title(m[1]), person=m[2].title())
    if m := re.search(r"\b(?:lent|lend|loaned|gave)\s+(?:my\s+|the\s+|our\s+)?(.+?)\s+to\s+([a-z][\w-]*)(.*)$", t):
        return Command(action="add", kind="loan", direction="lent", title=_title(m[1]), person=m[2].title(),
                       date=parse_date(m[3], today))  # fmt: skip
    if m := re.search(r"\bborrowed\s+(?:a\s+|the\s+|his\s+|her\s+|their\s+)?(.+?)\s+from\s+([a-z][\w-]*)(.*)$", t):
        return Command(action="add", kind="loan", direction="borrowed", title=_title(m[1]), person=m[2].title(),
                       date=parse_date(m[3], today))  # fmt: skip

    # Pantry & shopping
    if m := re.search(r"^(?:i\s+|we\s+)?(?:just\s+)?(?:bought|purchased|picked up)\s+(.+)$", t):
        return Command(action="done", kind="pantry", items=_items(m[1]), title=_title(m[1]))
    if m := re.search(
        r"\b(?:ran out of|run out of|out of|running (?:low|out) on|low on|need to buy|need|buy|get)\s+(?:some\s+|more\s+)?(.+)$|^add\s+(.+?)\s+to\s+(?:the\s+|my\s+)?(?:shopping|grocery)",
        t,
    ):
        return Command(action="add", kind="pantry", items=_items(m[1] or m[2]))

    # Occasions & gifts
    if m := re.search(r"\bgift idea(?:s)? for\s+([a-z][\w-]*)\s*[:,\-–]?\s*(.+)$", t):
        return Command(action="add", kind="occasion", person=m[1].title(), gift_idea=_title(m[2]))
    if m := re.search(r"^(?:it'?s\s+)?(.+?)(?:'s|s')?\s+(birthday|bday|anniversary)\b(.*)$", t):
        who = _title(m[1])
        label = "Birthday" if m[2] in ("birthday", "bday") else "Anniversary"
        return Command(action="add", kind="occasion", person=who, title=f"{who}'s {label.lower()}" if who else label,
                       date=parse_date(m[3], today), category=label.lower())  # fmt: skip

    # Expiry radar
    if m := re.search(
        r"^(.+?)\s+(?:expires?|expiry(?: date)?(?: is)?|is valid (?:till|until|thru)|valid (?:till|until|thru)|warranty (?:ends|expires)|renewal(?: is)?(?: due)?|needs renewal)\b(.*)$",
        t,
    ):
        return Command(action="add", kind="expiry", title=_title(re.sub(r"\b(is|has)$", "", m[1]).strip()),
                       date=parse_date(m[2], today), category=_expiry_category(m[1]))  # fmt: skip

    # Appliance care
    if re.search(
        r"\b(service|serviced|servicing|filter|maintenance|purifier|geyser|air ?conditioner|\bac\b|chimney|ro\b|washing machine|inverter|car)\b",
        t,
    ) and re.search(r"\b(service|serviced|servicing|clean|cleaning|cleaned|replace|replaced|maintenance|change)\b", t):
        appliance = _title(
            re.split(
                r"\b(?:needs|need|is|was|got|every|service|serviced|servicing|filter (?:clean|change|replace)|cleaned|cleaning|clean|maintenance|due)\b",
                raw,
                maxsplit=1,
                flags=re.I,
            )[0]
        )
        if re.search(r"\b(serviced|cleaned|replaced|got .* serviced|was serviced)\b", t):
            return Command(action="done", kind="appliance", title=appliance or "Appliance")
        days, months = parse_every(t)
        return Command(action="add", kind="appliance", title=appliance or "Appliance",
                       every_months=months or (max(1, round(days / 30)) if days else None), date=parse_date(t, today))  # fmt: skip

    # Bills & subscriptions (also pasted bank / biller SMS)
    if re.search(
        r"\b(bill|subscription|subscribed|rent|emi|premium|recharge|renews?|debited|payment due|is due|due)\b", t
    ) or _MONEY.search(t):
        amount, currency = parse_money(raw)
        days, months = parse_every(t)
        recurring = "monthly" if months == 1 or re.search(r"\b(monthly|per month|/mo|a month|every month|rent|emi)\b", t) else (
            "yearly" if months == 12 or re.search(r"\b(yearly|annual|per year)\b", t) else ("weekly" if days == 7 else None))  # fmt: skip
        if amount is None and (bare := _BARE_NUMBER.search(t)):
            amount = float(bare[1].replace(",", ""))
        if named := re.search(r"\bfor\s+(?:your\s+)?(.+?\b(?:bill|subscription|recharge|premium|emi))\b", raw, re.I):
            title = _title(named[1])
        else:
            split = r"\b(?:bill|subscription|rent|emi|premium|recharge|of|for|is|due|renews|at|on|rs\.?|inr)\b|[₹$€£\d]"
            name = re.split(split, raw, maxsplit=1, flags=re.I)[0]
            kw = re.search(r"\b(bill|rent|emi|premium|recharge)\b", t)
            title = _title(f"{name} {kw[1] if kw and kw[1] not in name.lower() else ''}".strip()) or "Bill"
        subscription = bool(
            re.search(
                r"\b(subscription|subscribed|netflix|spotify|prime|hotstar|youtube premium|gym|icloud|chatgpt)\b", t
            )
        )
        return Command(action="add", kind="bill", title=title, amount=amount, currency=currency,
                       recurring=recurring or ("monthly" if subscription else "none"), subscription=subscription,
                       date=parse_date(t, today))  # fmt: skip

    # Care: medicines, plants, pets (needs a schedule to count as one)
    days, _ = parse_every(t)
    times = parse_times(t)
    if (days or times or "refill" in t) and re.search(
        rf"\b(take|{PILLS}|water|watering|feed|walk|vet|deworm|groom|plant)\b", t
    ):
        subject = (
            "medicine"
            if re.search(rf"\b(take|{PILLS})\b", t)
            else "plant"
            if re.search(r"\b(water|watering|plant|fertili[sz]e)\b", t)
            else "pet"
        )
        name = re.sub(
            rf"\b(take|takes|give|water|feed|walk|the|my|our|{PILLS.replace('|vitamin', '')})\b", " ", raw, flags=re.I
        )
        name = re.split(
            r"\b(?:every|daily|at|in the|before|after|twice|once|each|on)\b|\d", name, maxsplit=1, flags=re.I
        )[0]
        return Command(action="add", kind="care", subject=subject, title=_title(name) or subject.title(),
                       times=times, every_days=days if not times else None)  # fmt: skip

    # Finding things
    if m := re.match(
        r"^(?:where(?:'s| is| are| did i (?:put|leave|keep|store)| have i (?:put|kept))|find|have i seen|do i have|where)\s+(?:my\s+|the\s+|our\s+)?(.+)$",
        t,
    ):
        return Command(action="find", query=m[1])
    if m := re.match(r"^(?:show|list)\s+(?:me\s+)?(?:my\s+|all\s+)?(\w+)", t):
        kind = _KIND_WORDS.get(m[1])
        if kind:
            return Command(action="list", kind=kind)  # type: ignore[arg-type]

    # Stash: "<item>, <place>" or "<item> is in/on/under <place>"
    if (
        (m := re.match(r"^([^,:\-–]{2,60}?)\s*[,:\-–]\s*(.{2,})$", raw))
        and len(m[1].split()) <= 5
        and not re.search(r"(in|on|under|inside|behind|at)", m[1], re.I)
    ):
        return Command(action="add", kind="stash", title=_title(m[1]), place=m[2].strip())
    if m := re.match(
        r"^(?:i\s+)?(?:(?:have\s+)?(?:put|kept|keep|placed|left|stored|hid|hidden|moved|put away)\s+)?(?:my\s+|the\s+|our\s+)?(.+?)\s+(?:is\s+|are\s+)?(?:now\s+)?(in|on|under|inside|behind|at|beside|next to|near|above|below|into|in the)\s+(.+)$",
        raw,
        re.I,
    ):
        return Command(action="add", kind="stash", title=_title(m[1]), place=f"{m[2]} {m[3]}".strip())
    if m := re.match(r"^(.{2,60}?)\s*[,:\-–]\s*(.{2,})$", raw):
        return Command(action="add", kind="stash", title=_title(m[1]), place=m[2].strip())

    return Command(action="find", query=t) if 0 < len(t) <= 60 else Command(action="help")


_KIND_WORDS = {
    "stash": "stash", "things": "stash", "items": "stash", "loans": "loan", "loan": "loan", "borrowed": "loan",
    "expiries": "expiry", "expiry": "expiry", "documents": "expiry", "bills": "bill", "subscriptions": "bill",
    "birthdays": "occasion", "occasions": "occasion", "appliances": "appliance", "pantry": "pantry",
    "medicines": "care", "plants": "care", "pets": "care", "care": "care",
}  # fmt: skip


def _expiry_category(s: str) -> str:
    s = s.lower()
    for cat, pattern in (
        ("id", r"passport|licen[cs]e|aadhaar|pan|visa|id\b|identity"),
        ("insurance", r"insurance|policy"),
        ("vehicle", r"puc|registration|rc\b|fitness|pollution"),
        ("warranty", r"warranty|guarantee"),
        ("card", r"card"),
    ):
        if re.search(pattern, s):
            return cat
    return "other"
