"""MeetingMind: recordings (or pasted transcripts) → decisions, owners, action items, and a searchable archive.

* Transcription: Groq's hosted Whisper (`whisper-large-v3-turbo`, free tier) with segment timestamps.
* Analysis: one structured LLM call (summary, decisions, action items, risks, topics), validated by Pydantic.
* Archive Q&A: transcript windows are embedded locally (FastEmbed, same model as DocuMind) and searched by cosine
  similarity; answers cite `[n]` → meeting + timestamp.
"""

from __future__ import annotations

import asyncio
import io
import logging
import re
from typing import Annotated, Any, Literal

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.config import Settings
from appcore.ai import Lenient, ask_json, ask_text, clip, llm_failure
from appcore.docstore import DocStore
from appcore.guardrails import normalize
from appcore.llm.chat import LLMNotConfiguredError
from appcore.security import limiter, rate_limit_value

logger = logging.getLogger(__name__)
MAX_AUDIO_MB = 24  # Groq's per-file limit is 25 MB
WINDOW_CHARS = 700


class Decision(Lenient):
    text: str = Field(max_length=400)
    owner: str | None = Field(None, max_length=80)


class ActionItem(Lenient):
    text: str = Field(max_length=400)
    owner: str | None = Field(None, max_length=80)
    due: str | None = Field(None, max_length=40)


class Analysis(Lenient):
    title: str = Field(max_length=120)
    summary: str = Field(max_length=2000)
    decisions: list[Decision] = Field(default_factory=list, max_length=20)
    action_items: list[ActionItem] = Field(default_factory=list, max_length=30)
    risks: list[str] = Field(default_factory=list, max_length=10)
    topics: list[str] = Field(default_factory=list, max_length=12)
    sentiment: Literal["positive", "neutral", "tense"] = "neutral"

    @field_validator("sentiment", mode="before")
    @classmethod
    def _sentiment(cls, v: Any) -> Any:
        return v if v in ("positive", "neutral", "tense") else "neutral"

    @field_validator("risks", "topics", mode="before")
    @classmethod
    def _strings(cls, v: Any) -> Any:
        return [x if isinstance(x, str) else str(x.get("text", x)) for x in (v or [])]


ANALYSE_SYSTEM = """You analyse meeting transcripts. Extract only what is actually said; never invent owners or dates.
Reply with ONE JSON object:
{"title": str (short, specific), "summary": str (4-6 sentences),
 "decisions": [{"text": str, "owner": str|null}],
 "action_items": [{"text": str (starts with a verb), "owner": str|null, "due": str|null (as said, e.g. "Friday")}],
 "risks": [str], "topics": [str], "sentiment": "positive"|"neutral"|"tense"}"""

ASK_SYSTEM = """Answer the question using ONLY the numbered meeting excerpts. Cite every claim with [n].
If the excerpts don't contain the answer, say so plainly. Keep it under 150 words."""


def windows(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group consecutive segments into ~700-char windows that keep their start time (for citations)."""
    out: list[dict[str, Any]] = []
    buf: list[str] = []
    start = 0.0
    for seg in segments:
        if not buf:
            start = float(seg.get("start", 0))
        buf.append(seg["text"].strip())
        if sum(len(b) for b in buf) >= WINDOW_CHARS:
            out.append({"start": start, "text": " ".join(buf)})
            buf = []
    if buf:
        out.append({"start": start, "text": " ".join(buf)})
    return out


def text_to_segments(transcript: str) -> list[dict[str, Any]]:
    """Pasted transcripts: one segment per line; '[mm:ss]' or 'hh:mm:ss' prefixes become timestamps."""
    segs: list[dict[str, Any]] = []
    stamp = re.compile(r"^\[?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]?\s*")
    for i, line in enumerate(ln for ln in transcript.splitlines() if ln.strip()):
        m = stamp.match(line)
        t = (int(m[1] or 0) * 3600 + int(m[2]) * 60 + int(m[3])) if m else float(i * 15)
        segs.append({"start": float(t), "end": float(t), "text": stamp.sub("", line).strip()})
    return segs


class MeetingService:
    def __init__(self, store: DocStore, get_llm, embedder, settings: Settings) -> None:  # noqa: ANN001
        self.db = store
        self.get_llm = get_llm
        self.embedder = embedder
        self.settings = settings
        self.transcriber = None  # injectable for tests

    async def transcribe(self, audio: bytes, filename: str) -> list[dict[str, Any]]:
        if self.transcriber is not None:
            return await self.transcriber(audio, filename)
        key = self.settings.groq_api_key.get_secret_value() if self.settings.groq_api_key else ""
        if not key:
            raise LLMNotConfiguredError(
                "Transcription uses Groq Whisper: set GROQ_API_KEY, or paste a transcript instead."
            )
        from appcore.llm import LLMRequest, get_router

        # Routed to a free-tier Whisper model (audio endpoint); WHISPER_MODEL is the preferred one.
        routed = await get_router(self.settings).transcribe(
            LLMRequest(
                task="meetingmind.transcribe",
                audio=(filename, io.BytesIO(audio).read()),
                prefer_model=self.settings.whisper_model,
                timeout_s=180,
                response_params={"response_format": "verbose_json", "temperature": 0.0},
            )
        )
        res = routed.raw
        raw = getattr(res, "segments", None) or []
        segs = [
            {"start": float(_get(s, "start")), "end": float(_get(s, "end")), "text": str(_get(s, "text")).strip()}
            for s in raw
        ]
        return segs or [{"start": 0.0, "end": 0.0, "text": str(getattr(res, "text", "")).strip()}]

    async def create(self, segments: list[dict[str, Any]], title: str | None, source: str) -> dict[str, Any]:
        segments = [s for s in segments if s["text"]]
        if not segments:
            raise HTTPException(422, "The recording/transcript is empty.")
        transcript = "\n".join(f"[{_fmt(s['start'])}] {s['text']}" for s in segments)
        analysis = await ask_json(
            self.get_llm, ANALYSE_SYSTEM, clip(transcript, 24000), Analysis, limit_s=120, task="meetingmind.analyse"
        )
        wins = windows(segments)
        vectors = await asyncio.to_thread(self.embedder.embed_documents, [w["text"] for w in wins])
        for w, v in zip(wins, vectors, strict=True):
            w["vec"] = [round(float(x), 5) for x in v]
        meeting = self.db.put(
            "meetings",
            {
                "title": title or analysis.title,
                "source": source,
                "duration": max((s.get("end") or s["start"]) for s in segments),
                "segments": segments,
                "windows": wins,
                **analysis.model_dump(exclude={"title"}),
            },
        )
        for item in analysis.action_items:
            self.db.put("tasks", {**item.model_dump(), "status": "todo", "meeting_id": meeting["id"],
                                  "meeting_title": meeting["title"]}, parent=meeting["id"])  # fmt: skip
        return meeting

    async def ask(self, question: str) -> dict[str, Any]:
        pool: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for m in self.db.list("meetings"):
            pool += [(m, w) for w in m.get("windows", [])]
        if not pool:
            return {"answer": "No meetings in the archive yet.", "sources": []}
        q = np.asarray(await asyncio.to_thread(self.embedder.embed_query, question), dtype=np.float32)
        mat = np.asarray([w["vec"] for _, w in pool], dtype=np.float32)
        sims = (mat @ q) / (np.linalg.norm(mat, axis=1) * (np.linalg.norm(q) or 1) + 1e-9)
        top = np.argsort(-sims)[:6]
        sources = [
            {"n": i + 1, "meeting_id": pool[j][0]["id"], "meeting_title": pool[j][0]["title"],
             "start": pool[j][1]["start"], "text": pool[j][1]["text"], "score": round(float(sims[j]), 3)}
            for i, j in enumerate(top)
        ]  # fmt: skip
        context = "\n\n".join(f"[{s['n']}] ({s['meeting_title']} @ {_fmt(s['start'])}) {s['text']}" for s in sources)
        answer = await ask_text(
            self.get_llm, ASK_SYSTEM, f"EXCERPTS:\n{context}\n\nQUESTION: {question}", task="meetingmind.ask"
        )
        return {"answer": answer.strip(), "sources": sources}


def _get(obj: Any, key: str) -> Any:
    return obj.get(key) if isinstance(obj, dict) else getattr(obj, key)


def _fmt(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60:02d}:{s % 60:02d}"


def public(m: dict[str, Any], full: bool = False) -> dict[str, Any]:
    """Strip embedding vectors from API responses."""
    out = {k: v for k, v in m.items() if k not in ("windows", "segments")}
    if full:
        out["segments"] = m.get("segments", [])
    return out


# ── API ───────────────────────────────────────────────────────────────────
def get_meetings(request: Request) -> MeetingService:
    return request.app.state.suite.meetings


Meetings = Annotated[MeetingService, Depends(get_meetings)]
router = APIRouter(prefix="/api/meetings", tags=["meetingmind"])


class TranscriptIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(None, max_length=120)
    transcript: str = Field(min_length=40, max_length=60000)


class AskIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=3, max_length=500)


class TaskPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["todo", "doing", "done"] | None = None
    owner: str | None = Field(None, max_length=80)
    text: str | None = Field(None, min_length=1, max_length=400)
    due: str | None = Field(None, max_length=40)


AUDIO_TYPES = ("audio/", "video/webm", "video/mp4", "application/octet-stream")


@router.post("", status_code=201)
@limiter.limit(rate_limit_value)
async def from_transcript(request: Request, body: TranscriptIn, svc: Meetings) -> dict[str, Any]:
    try:
        return public(await svc.create(text_to_segments(normalize(body.transcript)), body.title, "transcript"))
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, llm_failure(exc)) from None


@router.post("/audio", status_code=201)
@limiter.limit("6/minute")
async def from_audio(
    request: Request, svc: Meetings, title: Annotated[str | None, Query(max_length=120)] = None
) -> dict[str, Any]:
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if not ctype.startswith(AUDIO_TYPES):
        raise HTTPException(415, "Send the recording as raw audio (audio/webm, audio/mpeg, audio/wav, audio/mp4…).")
    if int(request.headers.get("content-length") or 0) > MAX_AUDIO_MB * 1024 * 1024:
        raise HTTPException(413, f"Recordings up to {MAX_AUDIO_MB} MB are supported.")
    audio = await request.body()
    if len(audio) > MAX_AUDIO_MB * 1024 * 1024:
        raise HTTPException(413, f"Recordings up to {MAX_AUDIO_MB} MB are supported.")
    if len(audio) < 1000:
        raise HTTPException(422, "The recording is empty or too short.")
    ext = {"audio/webm": "webm", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
           "audio/mp4": "m4a", "video/mp4": "mp4", "audio/ogg": "ogg"}.get(ctype, "webm")  # fmt: skip
    try:
        segments = await svc.transcribe(audio, f"recording.{ext}")
        return public(await svc.create(segments, title, "audio"))
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, llm_failure(exc)) from None


@router.get("")
def list_meetings(svc: Meetings) -> list[dict[str, Any]]:
    return [public(m) for m in svc.db.list("meetings", limit=100)]


@router.get("/tasks")
def list_tasks(svc: Meetings) -> list[dict[str, Any]]:
    return svc.db.list("tasks", limit=500)


@router.patch("/tasks/{task_id}")
def patch_task(task_id: str, body: TaskPatch, svc: Meetings) -> dict[str, Any]:
    doc = svc.db.patch("tasks", task_id[:40], body.model_dump(exclude_unset=True))
    if doc is None:
        raise HTTPException(404, "Task not found.")
    return doc


@router.post("/ask")
@limiter.limit(rate_limit_value)
async def ask(request: Request, body: AskIn, svc: Meetings) -> dict[str, Any]:
    try:
        return await svc.ask(normalize(body.question))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, llm_failure(exc)) from None


@router.get("/{meeting_id}")
def get_meeting(meeting_id: str, svc: Meetings) -> dict[str, Any]:
    m = svc.db.get("meetings", meeting_id[:40])
    if m is None:
        raise HTTPException(404, "Meeting not found.")
    return public(m, full=True)


@router.delete("/{meeting_id}", status_code=204)
def delete_meeting(meeting_id: str, svc: Meetings) -> None:
    if not svc.db.delete("meetings", meeting_id[:40]):
        raise HTTPException(404, "Meeting not found.")
    for t in svc.db.list("tasks", parent=meeting_id[:40]):
        svc.db.delete("tasks", t["id"])
