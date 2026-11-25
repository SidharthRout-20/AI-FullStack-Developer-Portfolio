"""Keeper API: capture in natural language, manage entries, photos, agenda and the daily brief."""

from __future__ import annotations

import asyncio
import base64
import binascii
import datetime as dt
import html
import secrets
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from app.keeper import reminders, schedule
from app.keeper.models import KINDS, AgendaItem, Entry, EntryIn, EntryPatch, ScanResult
from app.keeper.reminders import ReminderSettings
from app.keeper.service import KeeperService
from appcore.guardrails import normalize
from appcore.llm.chat import user_facing_error
from appcore.security import limiter, rate_limit_value


def get_keeper(request: Request) -> KeeperService:
    return request.app.state.keeper


def require_keeper_key(request: Request, x_keeper_key: Annotated[str | None, Header()] = None) -> None:
    """Optional shared secret (constant-time compare). Unset → open, for local use."""
    key = get_keeper(request).settings.keeper_access_key
    if key is None or not key.get_secret_value():
        return
    if not x_keeper_key or not secrets.compare_digest(x_keeper_key, key.get_secret_value()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Keeper access key required.")


def local_now(request: Request, x_tz_offset: Annotated[int | None, Header()] = None) -> dt.datetime:
    """The browser sends `Date#getTimezoneOffset()`; remembered for the background daily brief."""
    offset = max(-840, min(840, x_tz_offset or 0))
    if x_tz_offset is not None:
        store = get_keeper(request).store
        if store.get_meta("tz_offset") != str(offset):
            store.set_meta("tz_offset", str(offset))
    return schedule.local_now(offset)


router = APIRouter(prefix="/api/keeper", dependencies=[Depends(require_keeper_key)], tags=["keeper"])
Keeper = Annotated[KeeperService, Depends(get_keeper)]
Now = Annotated[dt.datetime, Depends(local_now)]


class Turn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    text: str = Field(max_length=700)


class AssistantPrefs(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field("", max_length=40)
    tone: Literal["warm", "professional", "cheerful"] = "warm"
    length: Literal["short", "detailed"] = "short"


class CommandIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=600)
    history: list[Turn] = Field(default_factory=list, max_length=8)  # recent turns, for follow-ups
    prefs: AssistantPrefs | None = None  # how the user has set Tijori up (kept on their device)
    photo_id: str | None = Field(None, pattern=r"^[0-9a-f]{32}$")
    lat: float | None = Field(None, ge=-90, le=90)
    lng: float | None = Field(None, ge=-180, le=180)


class TraceStep(BaseModel):
    node: str
    ms: int
    detail: str


class CommandOut(BaseModel):
    reply: str
    action: str
    kind: str | None
    routed_by: Literal["llm", "rules"]
    entries: list[Entry]
    trace: list[TraceStep]
    brief: dict[str, Any] | None = None


class PhotoIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    image: str = Field(min_length=32, max_length=3_000_000, description="data: URL or raw base64")


class ScanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    photo_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    hint: Literal["auto", "expiry", "appliance", "pantry", "bill", "stash"] = "auto"


class StatusOut(BaseModel):
    llm_provider: str
    vision: bool
    telegram: bool
    protected: bool
    counts: dict[str, int]


class BriefOut(BaseModel):
    text: str
    source: Literal["llm", "template"]
    agenda: list[AgendaItem]


@router.get("/status", response_model=StatusOut)
async def keeper_status(keeper: Keeper) -> dict[str, Any]:
    key = keeper.settings.keeper_access_key
    return {
        "llm_provider": keeper.settings.llm_provider,
        "vision": await asyncio.to_thread(lambda: keeper.vision_ready),
        "telegram": keeper.telegram_ready,
        "protected": bool(key and key.get_secret_value()),
        "counts": keeper.store.counts(),
    }


@router.post("/command", response_model=CommandOut)
@limiter.limit(rate_limit_value)
async def command(request: Request, body: CommandIn, keeper: Keeper, now: Now) -> dict[str, Any]:
    if body.photo_id and keeper.store.photo(body.photo_id) is None:
        raise HTTPException(404, "Photo not found.")
    history = [t.model_dump() for t in body.history]
    prefs = body.prefs.model_dump() if body.prefs else None
    state = await keeper.agent.run(normalize(body.text), now, body.photo_id, body.lat, body.lng, history, prefs)
    cmd = state["command"]
    out: dict[str, Any] = {
        "reply": state["reply"],
        "action": cmd.action,
        "kind": cmd.kind,
        "routed_by": state["routed_by"],
        "entries": state.get("entries", []),
        "trace": state["trace"],
    }
    if cmd.action == "brief":
        brief = await keeper.brief(now)
        out["brief"] = brief
        out["reply"] = brief["text"]
    return out


@router.get("/entries", response_model=list[Entry])
def list_entries(keeper: Keeper, kind: Annotated[str | None, Query(max_length=20)] = None,
                 include_done: bool = False) -> list[Entry]:  # fmt: skip
    if kind and kind not in KINDS:
        raise HTTPException(422, f"kind must be one of {', '.join(KINDS)}")
    return keeper.store.list(kind, include_done=include_done)


@router.post("/entries", response_model=Entry, status_code=201)
def create_entry(body: EntryIn, keeper: Keeper, now: Now) -> Entry:
    data = dict(body.data)
    if body.kind == "occasion" and body.due:  # store month/day so it repeats yearly
        data |= {"month": body.due.month, "day": body.due.day}
        body = body.model_copy(
            update={"due": schedule.next_yearly(body.due.month, body.due.day, now.date()), "data": data}
        )
    if body.kind == "pantry":
        body = body.model_copy(update={"data": {"state": "need", **data}})
    return keeper.store.add(body)


def _entry_or_404(keeper: KeeperService, entry_id: str) -> Entry:
    if len(entry_id) > 40 or (entry := keeper.store.get(entry_id)) is None:
        raise HTTPException(404, "Entry not found.")
    return entry


@router.patch("/entries/{entry_id}", response_model=Entry)
def patch_entry(entry_id: str, body: EntryPatch, keeper: Keeper) -> Entry:
    entry = _entry_or_404(keeper, entry_id)
    changes = body.model_dump(exclude_unset=True)
    if "data" in changes and changes["data"] is not None:
        changes["data"] = {**entry.data, **changes["data"]}
    return keeper.store.update(entry_id, changes)  # type: ignore[return-value]


@router.post("/entries/{entry_id}/done", response_model=Entry)
def complete_entry(entry_id: str, keeper: Keeper, now: Now) -> Entry:
    _entry_or_404(keeper, entry_id)
    return keeper.complete(entry_id)  # type: ignore[return-value]


@router.post("/entries/{entry_id}/used", response_model=Entry)
def mark_used(entry_id: str, keeper: Keeper, now: Now) -> Entry:
    """Subscriptions: 'I used this today' resets the unused-subscription nudge."""
    entry = _entry_or_404(keeper, entry_id)
    return keeper.store.update(entry_id, {"data": {**entry.data, "last_used": now.date().isoformat()}})  # type: ignore[return-value]


@router.delete("/entries/{entry_id}", status_code=204)
def delete_entry(entry_id: str, keeper: Keeper) -> None:
    _entry_or_404(keeper, entry_id)
    keeper.store.delete(entry_id)


@router.get("/agenda", response_model=list[AgendaItem])
def get_agenda(keeper: Keeper, now: Now) -> list[AgendaItem]:
    return keeper.agenda(now)


@router.get("/brief", response_model=BriefOut)
@limiter.limit(rate_limit_value)
async def get_brief(request: Request, keeper: Keeper, now: Now) -> dict[str, Any]:
    return await keeper.brief(now)


@router.post("/brief/telegram", status_code=202)
@limiter.limit("5/minute")
async def send_brief(request: Request, keeper: Keeper, now: Now) -> dict[str, str]:
    if not keeper.telegram_ready:
        raise HTTPException(404, "Telegram delivery is not configured.")
    brief = await keeper.brief(now)
    try:
        await keeper.send_telegram(brief["text"])
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, "Telegram rejected the message. Check the bot token and chat id.") from exc
    return {"status": "sent"}


# ── Photos ────────────────────────────────────────────────────────────────
class AudioIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    audio: str = Field(max_length=4_000_000)  # base64 (≈3 MB of audio: a spoken command, not a recording)
    mime: str = Field("audio/webm", pattern=r"^audio/[\w.+-]+(;.*)?$")


AUDIO_EXT = {"webm": "webm", "ogg": "ogg", "mp4": "m4a", "mpeg": "mp3", "wav": "wav", "x-m4a": "m4a", "aac": "m4a"}


@router.post("/transcribe")
@limiter.limit("20/minute")
async def transcribe(request: Request, body: AudioIn, keeper: Keeper) -> dict[str, str]:
    """Speech to text for browsers without built-in voice recognition (Groq Whisper). Audio is not stored."""
    raw = body.audio.split(",", 1)[1] if body.audio.startswith("data:") else body.audio
    try:
        blob = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(422, "Audio must be base64 encoded.") from exc
    if not blob:
        raise HTTPException(422, "No audio received.")
    ext = AUDIO_EXT.get(body.mime.split(";")[0].split("/")[1], "webm")
    try:
        text = await keeper.transcribe(blob, f"command.{ext}")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, user_facing_error(exc)) from None
    return {"text": text.strip()[:600]}


@router.post("/photos", status_code=201)
@limiter.limit(rate_limit_value)
def upload_photo(request: Request, body: PhotoIn, keeper: Keeper) -> dict[str, str]:
    raw = body.image.split(",", 1)[1] if body.image.startswith("data:") else body.image
    try:
        blob = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(422, "Image must be base64 encoded.") from exc
    if len(blob) > keeper.settings.keeper_photo_max_kb * 1024:
        raise HTTPException(413, f"Photo is larger than {keeper.settings.keeper_photo_max_kb} KB.")
    try:
        return {"photo_id": keeper.store.save_photo(blob)}
    except ValueError as exc:  # not a JPEG / PNG / WebP (checked by magic bytes, not the file name)
        raise HTTPException(415, str(exc)) from exc


@router.get("/photos/{photo_id}")
def get_photo(photo_id: str, keeper: Keeper) -> Response:
    found = keeper.store.photo(photo_id)
    if found is None:
        raise HTTPException(404, "Photo not found.")
    return Response(found[0], media_type=found[1], headers={"Cache-Control": "private, max-age=86400"})


@router.post("/scan", response_model=ScanResult)
@limiter.limit(rate_limit_value)
async def scan_photo(request: Request, body: ScanIn, keeper: Keeper, now: Now) -> ScanResult:
    try:
        return await keeper.scan(body.photo_id, body.hint, now.date())
    except FileNotFoundError as exc:
        raise HTTPException(404, "Photo not found.") from exc
    except Exception as exc:  # noqa: BLE001
        message = user_facing_error(exc) or "Couldn't read the photo right now. You can still fill the details in."
        raise HTTPException(503, message) from exc


# ── Reminders ─────────────────────────────────────────────────────────────
class AlertOut(BaseModel):
    key: str
    entry_id: str
    title: str
    label: str
    at: dt.datetime
    urgent: bool
    quiet: bool


class AckIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(min_length=1, max_length=120)


class SnoozeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    minutes: int = Field(10, ge=1, le=1440)
    key: str | None = Field(None, max_length=120)


class ReminderSettingsOut(ReminderSettings):
    telegram_configured: bool
    cron_configured: bool


def _settings_out(keeper: KeeperService) -> dict[str, Any]:
    secret = keeper.settings.cron_secret
    return {
        **keeper.reminder_settings().model_dump(),
        "telegram_configured": keeper.telegram_ready,
        "cron_configured": bool(secret and secret.get_secret_value()) or keeper.settings.background_jobs,
    }


@router.get("/reminders/settings", response_model=ReminderSettingsOut)
def get_reminder_settings(keeper: Keeper) -> dict[str, Any]:
    return _settings_out(keeper)


@router.put("/reminders/settings", response_model=ReminderSettingsOut)
def put_reminder_settings(body: ReminderSettings, keeper: Keeper) -> dict[str, Any]:
    keeper.save_reminder_settings(body)
    return _settings_out(keeper)


@router.post("/reminders/test")
@limiter.limit("5/minute")
async def test_reminder(request: Request, keeper: Keeper) -> dict[str, list[str]]:
    sent = await keeper.test_channels(keeper.reminder_settings())
    if not sent:
        raise HTTPException(422, "No phone channel accepted the test. Set an ntfy topic (or configure Telegram).")
    return {"sent": sent}


@router.get("/reminders/due", response_model=list[AlertOut])
def due_reminders(keeper: Keeper, now: Now) -> list[dict[str, Any]]:
    """Alerts due right now (the open app chimes / reads them aloud)."""
    quiet = reminders.in_quiet_hours(now, keeper.reminder_settings())
    return [
        {
            "key": a.key,
            "entry_id": a.entry.id,
            "title": a.entry.title,
            "label": a.label,
            "at": a.at.replace(tzinfo=dt.UTC),  # explicit UTC so browsers show the right local time
            "urgent": a.urgent,
            "quiet": quiet,
        }  # fmt: skip
        for a in keeper.due_alerts()
    ]


@router.post("/entries/{entry_id}/ack", response_model=Entry)
def ack_reminder(entry_id: str, body: AckIn, keeper: Keeper) -> Entry:
    _entry_or_404(keeper, entry_id)
    return keeper.ack(entry_id, body.key)  # type: ignore[return-value]


@router.post("/entries/{entry_id}/snooze", response_model=Entry)
def snooze_reminder(entry_id: str, body: SnoozeIn, keeper: Keeper) -> Entry:
    _entry_or_404(keeper, entry_id)
    return keeper.snooze(entry_id, body.minutes, body.key)  # type: ignore[return-value]


# One-tap actions from phone notifications: authorised by the signed token itself, not the Keeper access key.
actions_router = APIRouter(prefix="/api/keeper", tags=["keeper"])

_ACT_PAGE = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Keeper</title><body style="font:16px system-ui;display:grid;place-items:center;min-height:90vh;margin:0">
<p>{message}</p></body>"""


@actions_router.api_route("/act", methods=["GET", "POST"])
@limiter.limit("30/minute")
def act(
    request: Request,
    a: Annotated[Literal["done", "snooze", "ack"], Query()],
    t: Annotated[str, Query(min_length=10, max_length=400)],
) -> Response:
    entry = get_keeper(request).act(t, a)
    if entry is None:
        message, code = "This link has expired or is invalid.", 410
    else:
        message = {"done": f"Done: {entry.title}.", "snooze": f"Snoozed for 10 minutes: {entry.title}.",
                   "ack": f"Got it: {entry.title}."}[a]  # fmt: skip
        code = 200
    if request.method == "POST":  # ntfy action buttons
        return Response(f'{{"message": "{message}"}}', status_code=code, media_type="application/json")
    return Response(_ACT_PAGE.format(message=html.escape(message)), status_code=code, media_type="text/html")
