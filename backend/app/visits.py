"""Visits: who comes to the site, from where, and what they look at, so the owner can see what grows its reach.

Privacy first, and nothing that needs a cookie banner:

* No cookies and no raw IP addresses. A visitor is a salted hash of (day, IP, browser) that changes every day, so
  visitors can be counted per day but never followed across days. Without a configured secret no hash is stored at
  all (visitors are then counted by session).
* The browser sends only the page path (no query string apart from the campaign tag), the referring site's host, the
  screen-width class and a random id that lives as long as the tab. Do Not Track / Global Privacy Control, the
  owner's own visits and local development are never sent.
* Bots and crawlers are dropped here.

The summary is for the site's owner only (the same owner key as Tara's code proposals). Every number in it is counted
from stored visits; the advice it gives is computed from those numbers and says how much data it rests on.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import secrets
from collections import Counter
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Header, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from appcore.docstore import DocStore
from appcore.security import limiter

router = APIRouter(prefix="/api/visits", tags=["visits"])

BOTS = re.compile(r"bot|crawl|spider|slurp|preview|headless|lighthouse|pingdom|uptime|curl|wget|python|monitor", re.I)
# Where a visitor came from, by the referring host (or the ?ref= / utm_source tag on the link they followed).
SOURCES = [
    (re.compile(r"linkedin|lnkd\.in"), "LinkedIn"), (re.compile(r"github"), "GitHub"),
    (re.compile(r"(^|\.)google\.|googleusercontent"), "Google"), (re.compile(r"bing\.|duckduckgo|yahoo|ecosia"), "Other search"),
    (re.compile(r"(^|\.)(t\.co|twitter\.com|x\.com)$"), "X"), (re.compile(r"reddit"), "Reddit"),
    (re.compile(r"naukri|indeed|wellfound|instahyre|glassdoor"), "Job boards"),
    (re.compile(r"mail\.|outlook|gmail"), "Email"), (re.compile(r"whatsapp|wa\.me|telegram|t\.me"), "Messaging"),
    (re.compile(r"chatgpt|openai|perplexity|claude\.ai|gemini"), "AI assistants"),
]  # fmt: skip
TAGS = {"linkedin": "LinkedIn", "github": "GitHub", "resume": "Résumé", "cv": "Résumé", "email": "Email",
        "x": "X", "twitter": "X", "naukri": "Job boards", "whatsapp": "Messaging", "qr": "QR code"}  # fmt: skip
# What a path is about (the products and pages worth comparing).
SECTIONS = [
    ("/keeper", "Tara"),
    ("/safarnaama", "Safarnaama"),
    ("/codelens", "CodeLens"),
    ("/jasoos", "Jasoos"),
    ("/quality", "Quality page"),
    ("/products/", "Product pages"),
    ("/documind", "Labs"),
    ("/careerpilot", "Labs"),
    ("/flowforge", "Labs"),
    ("/evolve", "Labs"),
    ("/meetingmind", "Labs"),
]
EVENTS = {"resume", "contact", "email", "tara_ask", "outbound", "try"}
MAX_DAYS = 90


class HitIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    type: str = Field("view", pattern=r"^(view|event)$")
    path: str = Field("/", max_length=200)
    ref: str = Field("", max_length=300)  # the referring page (only its host is kept)
    tag: str = Field("", max_length=40)  # ?ref= or utm_source on the link the visitor followed
    w: int = Field(0, ge=0, le=20000)  # viewport width: phone, tablet or desktop
    sid: str = Field("", max_length=40)  # a random id for this tab, never stored across visits
    name: str = Field("", max_length=40)  # event name
    site: str = Field("", max_length=120)  # the site's own host (so internal navigation is not a "source")


def _store(request: Request) -> DocStore:
    st = request.app.state
    if getattr(st, "visits", None) is None:
        s = st.keeper.settings
        st.visits = DocStore(s.data_dir / "visits.sqlite3", s.db_url)
    return st.visits


def _secret(request: Request) -> str | None:
    s = request.app.state.keeper.settings
    for v in (getattr(s, "tara_owner_key", None), getattr(s, "cron_secret", None)):
        if v is not None and v.get_secret_value():
            return v.get_secret_value()
    return None


def _host(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").removeprefix("www.").lower()
    except ValueError:
        return ""


def source_of(ref: str, tag: str, site: str) -> str:
    """Where the visit came from: the link's tag wins, then the referring site; nothing at all is "Direct"."""
    t = re.sub(r"[^a-z0-9_-]", "", (tag or "").lower())[:30]
    if t:
        return TAGS.get(t, t.capitalize())
    host = _host(ref)
    if (
        not host
        or host == (site or "").removeprefix("www.").lower()
        or host.endswith(".vercel.app")
        and "portfolio-p" in host
    ):
        return "Direct"
    return next((name for pattern, name in SOURCES if pattern.search(host)), host)


def device_of(width: int) -> str:
    return "Phone" if 0 < width < 640 else "Tablet" if 640 <= width < 1024 else "Desktop" if width else "Unknown"


def browser_of(ua: str) -> str:
    return ("Edge" if "Edg/" in ua else "Opera" if "OPR/" in ua else "Samsung Internet" if "SamsungBrowser" in ua
            else "Chrome" if "Chrome/" in ua or "CriOS" in ua else "Firefox" if "Firefox/" in ua or "FxiOS" in ua
            else "Safari" if "Safari/" in ua else "Other")  # fmt: skip


def os_of(ua: str) -> str:
    return ("Android" if "Android" in ua else "iOS" if re.search(r"iPhone|iPad|iPod", ua) else "Windows" if "Windows" in ua
            else "macOS" if "Mac OS X" in ua else "Linux" if "Linux" in ua else "Other")  # fmt: skip


def section_of(path: str) -> str:
    if path in ("/", ""):
        return "Home"
    for prefix, name in SECTIONS:
        if path.startswith(prefix) if prefix.endswith("/") else path == prefix or path.startswith(prefix + "/"):
            return name
    return "Other"


def _clean_path(path: str) -> str:
    p = "/" + (path or "/").split("?")[0].split("#")[0].lstrip("/")
    return re.sub(r"[^\w\-/.]", "", p)[:120] or "/"


@router.post("/hit", status_code=204)
@limiter.limit("120/minute")
async def hit(request: Request) -> Response:
    """One page view or event. The body is sent as text/plain (navigator.sendBeacon), so it is parsed here."""
    ua = request.headers.get("user-agent", "")
    if not ua or BOTS.search(ua):
        return Response(status_code=204)
    try:
        body = HitIn.model_validate(json.loads((await request.body())[:2000] or b"{}"))
    except (ValueError, ValidationError):
        raise HTTPException(422, "Not a visit.") from None
    if body.type == "event" and body.name not in EVENTS:
        raise HTTPException(422, "Unknown event.")
    now = dt.datetime.now(dt.UTC)
    day = now.date().isoformat()
    secret = _secret(request)
    ip = (
        (request.headers.get("x-forwarded-for") or (request.client.host if request.client else ""))
        .split(",")[0]
        .strip()
    )
    visitor = hashlib.sha256(f"{secret}|{day}|{ip}|{ua}".encode()).hexdigest()[:16] if secret else None
    path = _clean_path(body.path)
    doc = {
        "t": body.type,
        "ts": now.isoformat(timespec="seconds"),
        "path": path,
        "section": section_of(path),
        "source": source_of(body.ref, body.tag, body.site),
        "device": device_of(body.w),
        "browser": browser_of(ua),
        "os": os_of(ua),
        "country": re.sub(r"[^A-Z]", "", request.headers.get("x-vercel-ip-country", "").upper())[:2] or None,
        "sid": re.sub(r"[^\w-]", "", body.sid)[:40] or None,
        "v": visitor,
    }
    if body.type == "event":
        doc["name"] = body.name
    _store(request).put("hits", doc, parent=day)
    return Response(status_code=204)


def _owner(request: Request, key: str | None) -> None:
    s = request.app.state.keeper.settings
    want = s.tara_owner_key.get_secret_value() if getattr(s, "tara_owner_key", None) else ""
    if not want:
        raise HTTPException(503, "Set TARA_OWNER_KEY on the server to see visits.")
    if not key or not secrets.compare_digest(key, want):
        raise HTTPException(403, "Visits are for the site's owner. Enter the owner key.")


def _days(store: DocStore, start: dt.date, n: int) -> list[tuple[str, list[dict[str, Any]]]]:
    out = []
    for i in range(n):
        day = (start + dt.timedelta(days=i)).isoformat()
        out.append((day, store.list("hits", parent=day, limit=20000)))
    return out


def _period(days: list[tuple[str, list[dict[str, Any]]]]) -> dict[str, Any]:
    views = [h for _, hs in days for h in hs if h.get("t") == "view"]
    events = [h for _, hs in days for h in hs if h.get("t") == "event"]
    sessions: dict[str, list[dict[str, Any]]] = {}
    for h in views:
        sessions.setdefault(h.get("sid") or h["id"], []).append(h)
    # Visitors: daily-unique hashes summed over the days (a visitor is never linked across days, by design).
    visitors = sum(len({h["v"] for h in hs if h.get("t") == "view" and h.get("v")} or
                       {h.get("sid") for h in hs if h.get("t") == "view"}) for _, hs in days)  # fmt: skip
    one_page = sum(1 for s in sessions.values() if len(s) == 1)
    explored = sum(1 for s in sessions.values() if any(h["section"] not in ("Home", "Other") for h in s))
    return {
        "views": len(views),
        "visitors": visitors,
        "sessions": len(sessions),
        "pages_per_session": round(len(views) / len(sessions), 2) if sessions else None,
        "bounce_rate": round(one_page / len(sessions), 3) if sessions else None,
        "explored_rate": round(explored / len(sessions), 3) if sessions else None,
        "_views": views,
        "_events": events,
        "_sessions": sessions,
    }


def _top(items: list[str], k: int = 8) -> list[dict[str, Any]]:
    return [{"name": n, "count": c} for n, c in Counter(i for i in items if i).most_common(k)]


def advice(cur: dict[str, Any], top: dict[str, list[dict[str, Any]]], events: dict[str, int]) -> list[dict[str, str]]:
    """What to do next, from this period's numbers only. Each line names the number it rests on."""
    n = cur["sessions"]
    if n < 20:
        return [{"title": "Not enough visits to judge yet",
                 "text": f"{n} visit{'s' if n != 1 else ''} so far. Share the site with the tagged links below (LinkedIn, résumé, "
                         "GitHub) so the next visits also tell you which channel works."}]  # fmt: skip
    out: list[dict[str, str]] = []
    share = {s["name"]: s["count"] / max(1, cur["views"]) for s in top["sources"]}
    if share.get("Direct", 0) > 0.5:
        out.append({"title": "Most visits have no known source",
                    "text": f"{share['Direct']:.0%} arrive direct. Use the tagged links below on every channel so you can see which one brings people."})  # fmt: skip
    if (cur["bounce_rate"] or 0) > 0.6:
        out.append({"title": "Many visitors leave after one page",
                    "text": f"{cur['bounce_rate']:.0%} of visits see a single page. Put one product's 'Try it' at the top of the home page, above the fold."})  # fmt: skip
    if (cur["explored_rate"] or 1) < 0.3:
        out.append({"title": "Few visitors open a product",
                    "text": f"Only {cur['explored_rate']:.0%} of visits open a product. Link straight to a product (e.g. /keeper) in outreach, not just the home page."})  # fmt: skip
    phones = next((d["count"] for d in top["devices"] if d["name"] == "Phone"), 0) / max(1, cur["views"])
    if phones > 0.4:
        out.append({"title": "Phones are a big share",
                    "text": f"{phones:.0%} of page views are on phones: check every change on a phone first."})  # fmt: skip
    products = [p for p in top["sections"] if p["name"] in ("Tara", "Safarnaama", "CodeLens", "Jasoos")]
    if len(products) >= 2 and products[0]["count"] >= 2 * products[-1]["count"]:
        out.append({"title": f"{products[0]['name']} draws the most interest",
                    "text": f"{products[0]['count']} views against {products[-1]['count']} for {products[-1]['name']}. "
                            f"Lead with {products[0]['name']} in posts and on your résumé."})  # fmt: skip
    if events.get("resume", 0) == 0 and events.get("contact", 0) == 0:
        out.append({"title": "No résumé downloads or messages yet",
                    "text": f"Across {n} visits nobody opened the résumé or sent a message. Make both visible next to the products."})  # fmt: skip
    best = next((s for s in top["sources"] if s["name"] != "Direct"), None)
    if best:
        out.append({"title": f"{best['name']} is your best channel",
                    "text": f"{best['count']} page views came from {best['name']}. Post there again, linking a specific product."})  # fmt: skip
    return out[:5]


@router.get("/summary")
def summary(request: Request, days: int = 30, x_tara_owner_key: str | None = Header(None)) -> dict[str, Any]:
    """The owner's view: this period against the one before, by day, page, product, source, device and country."""
    _owner(request, x_tara_owner_key)
    days = max(1, min(days, MAX_DAYS // 2))
    store = _store(request)
    today = dt.datetime.now(dt.UTC).date()
    cur_days = _days(store, today - dt.timedelta(days=days - 1), days)
    prev_days = _days(store, today - dt.timedelta(days=2 * days - 1), days)
    cur, prev = _period(cur_days), _period(prev_days)
    views, events = cur.pop("_views"), cur.pop("_events")
    cur.pop("_sessions")
    for k in ("_views", "_events", "_sessions"):
        prev.pop(k)
    top = {
        "pages": _top([h["path"] for h in views]),
        "sections": _top([h["section"] for h in views], 12),
        "sources": _top([h["source"] for h in views]),
        "devices": _top([h["device"] for h in views]),
        "browsers": _top([h["browser"] for h in views]),
        "os": _top([h["os"] for h in views]),
        "countries": _top([h.get("country") or "" for h in views]),
    }
    counted = dict(Counter(h.get("name") for h in events))
    daily = [{"day": d, "views": sum(1 for h in hs if h.get("t") == "view"),
              "visitors": len({h.get("v") or h.get("sid") for h in hs if h.get("t") == "view"})} for d, hs in cur_days]  # fmt: skip
    return {"days": days, "current": cur, "previous": prev, "daily": daily, "top": top, "events": counted,
            "advice": advice(cur, top, counted), "visitor_hash": _secret(request) is not None}  # fmt: skip
