"""Keeper domain models: what the assistant remembers and the commands it understands."""

from __future__ import annotations

import datetime as dt
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Kind = Literal["stash", "parking", "loan", "expiry", "bill", "occasion", "appliance", "pantry", "care"]
KINDS: tuple[str, ...] = Kind.__args__  # type: ignore[attr-defined]

Action = Literal["add", "find", "done", "list", "brief", "help", "assist", "chat"]
Recurrence = Literal["none", "weekly", "monthly", "yearly"]

_TIME = r"^([01]\d|2[0-3]):[0-5]\d$"


def _clean(v: Any) -> Any:
    if isinstance(v, str):
        v = " ".join(v.split()).strip(" .,;:")
        return v or None
    return v


class Entry(BaseModel):
    """One remembered thing. Kind-specific fields live in `data`."""

    id: str
    kind: Kind
    title: str
    place: str | None = None
    person: str | None = None
    note: str | None = None
    photo_id: str | None = None
    lat: float | None = None
    lng: float | None = None
    due: dt.date | None = None
    due_time: str | None = None
    status: Literal["active", "done"] = "active"
    data: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    updated_at: str


class EntryIn(BaseModel):
    """Create / edit payload (manual forms and confirmed photo drafts)."""

    model_config = ConfigDict(extra="forbid")

    kind: Kind
    title: str = Field(min_length=1, max_length=120)
    place: str | None = Field(None, max_length=200)
    person: str | None = Field(None, max_length=80)
    note: str | None = Field(None, max_length=1000)
    photo_id: str | None = Field(None, pattern=r"^[0-9a-f]{32}$")
    lat: float | None = Field(None, ge=-90, le=90)
    lng: float | None = Field(None, ge=-180, le=180)
    due: dt.date | None = None
    due_time: str | None = Field(None, pattern=_TIME)
    data: dict[str, Any] = Field(default_factory=dict)

    @field_validator("title", "place", "person", "note", mode="before")
    @classmethod
    def _text(cls, v: Any) -> Any:
        return _clean(v)

    @field_validator("data")
    @classmethod
    def _small(cls, v: dict[str, Any]) -> dict[str, Any]:
        if len(str(v)) > 4000:
            raise ValueError("data is too large")
        return v


class EntryPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(None, min_length=1, max_length=120)
    place: str | None = Field(None, max_length=200)
    person: str | None = Field(None, max_length=80)
    note: str | None = Field(None, max_length=1000)
    due: dt.date | None = None
    due_time: str | None = Field(None, pattern=_TIME)
    data: dict[str, Any] | None = None


class Command(BaseModel):
    """What the routing agent extracts from one natural-language message."""

    model_config = ConfigDict(extra="ignore")

    action: Action
    kind: Kind | None = None
    title: str | None = Field(None, max_length=120)
    place: str | None = Field(None, max_length=200)
    person: str | None = Field(None, max_length=80)
    direction: Literal["lent", "borrowed"] | None = None
    date: dt.date | None = None
    time: str | None = Field(None, pattern=_TIME)
    amount: float | None = Field(None, ge=0)
    currency: str | None = Field(None, max_length=8)
    recurring: Recurrence | None = None
    subscription: bool | None = None
    every_days: int | None = Field(None, ge=1, le=366)
    every_months: int | None = Field(None, ge=1, le=60)
    times: list[str] = Field(default_factory=list, max_length=6)
    subject: Literal["medicine", "plant", "pet", "other"] | None = None
    category: str | None = Field(None, max_length=40)
    items: list[str] = Field(default_factory=list, max_length=30)
    gift_idea: str | None = Field(None, max_length=120)
    query: str | None = Field(None, max_length=200)
    note: str | None = Field(None, max_length=500)
    tool: str | None = Field(None, max_length=20)  # for action "assist": see app.keeper.tools
    # How the user seems to feel, from their words: replies adapt to it (never shown as a diagnosis).
    emotion: Literal["neutral", "happy", "excited", "grateful", "stressed", "anxious", "sad", "angry",
                     "frustrated", "tired", "confused", "lonely", "crisis"] | None = None  # fmt: skip
    args: dict[str, Any] = Field(default_factory=dict)

    @field_validator("emotion", mode="before")
    @classmethod
    def _emotion(cls, v: Any) -> Any:
        ok = {"neutral", "happy", "excited", "grateful", "stressed", "anxious", "sad", "angry", "frustrated", "tired",
              "confused", "lonely", "crisis"}  # fmt: skip
        v = str(v or "").strip().lower()
        return v if v in ok else None

    @field_validator("args", mode="before")
    @classmethod
    def _args(cls, v: Any) -> Any:
        return v if isinstance(v, dict) else {}

    @field_validator("title", "place", "person", "category", "gift_idea", "query", "note", "currency", mode="before")
    @classmethod
    def _text(cls, v: Any) -> Any:
        return _clean(v)

    @field_validator("kind", "direction", "recurring", "subject", "date", "time", mode="before")
    @classmethod
    def _empty_to_none(cls, v: Any) -> Any:
        return None if v in ("", "null", "none_given") else v

    @field_validator("times", "items", mode="before")
    @classmethod
    def _list(cls, v: Any) -> Any:
        if v is None:
            return []
        if isinstance(v, str):
            v = [v]
        return [s for s in (_clean(x) for x in v) if s]


class ScanResult(BaseModel):
    """What the vision model read from a photo; the UI shows it as an editable draft."""

    model_config = ConfigDict(extra="ignore")

    kind: Kind = "stash"
    title: str = Field("Photo", max_length=120)
    caption: str | None = Field(None, max_length=300)
    date: dt.date | None = None
    category: str | None = Field(None, max_length=40)
    model: str | None = Field(None, max_length=80)
    amount: float | None = Field(None, ge=0)
    items: list[str] = Field(default_factory=list, max_length=40)

    @field_validator("kind", mode="before")
    @classmethod
    def _kind(cls, v: Any) -> Any:
        return v if v in KINDS else "stash"

    @field_validator("date", mode="before")
    @classmethod
    def _date(cls, v: Any) -> Any:
        return None if v in ("", "null", None) else v

    @field_validator("items", mode="before")
    @classmethod
    def _items(cls, v: Any) -> Any:
        return [s for s in (_clean(x) for x in (v or [])) if isinstance(s, str) and s][:40]


class AgendaItem(BaseModel):
    bucket: Literal["overdue", "today", "soon", "nudge"]
    label: str
    entry: Entry
