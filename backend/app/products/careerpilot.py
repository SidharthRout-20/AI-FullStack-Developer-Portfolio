"""CareerPilot: tailored resume & cover letter, voice mock interview with adaptive follow-ups, application tracker.

The match score itself reuses DocuMind's Match Analyzer (`POST /api/match/stream`): one engine, two products.
"""

from __future__ import annotations

import datetime as dt
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.ai import Lenient, ask_json, clip, llm_failure
from app.core.docstore import DocStore
from app.core.security import limiter, rate_limit_value
from app.rag.guardrails import normalize
from app.rag.loaders import discover_files, load_file

Stage = Literal["saved", "applied", "interview", "offer", "rejected"]


# ── Models ────────────────────────────────────────────────────────────────
class JobIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    jd: str = Field(min_length=40, max_length=12000)
    company: str | None = Field(None, max_length=120)
    role: str | None = Field(None, max_length=120)

    @field_validator("jd")
    @classmethod
    def _norm(cls, v: str) -> str:
        return normalize(v)


class Bullet(Lenient):
    rewritten: str = Field(max_length=400)
    original: str | None = Field(None, max_length=400)
    why: str = Field("", max_length=300)


class Tailored(Lenient):
    headline: str = Field(max_length=200)
    summary: str = Field(max_length=1200)
    bullets: list[Bullet] = Field(max_length=10)
    keywords_matched: list[str] = Field(default_factory=list, max_length=30)
    keywords_missing: list[str] = Field(default_factory=list, max_length=30)
    cover_letter: str = Field(max_length=5000)


class Question(Lenient):
    id: int
    text: str = Field(max_length=500)
    kind: Literal["behavioral", "technical", "gap", "follow_up"] = "technical"
    focus: str = Field("", max_length=200)

    @field_validator("kind", mode="before")
    @classmethod
    def _kind(cls, v: Any) -> Any:
        return v if v in ("behavioral", "technical", "gap", "follow_up") else "technical"


class QuestionSet(Lenient):
    questions: list[Question] = Field(min_length=3, max_length=8)


class InterviewIn(JobIn):
    gaps: list[str] = Field(default_factory=list, max_length=10)


class AnswerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question_id: int
    answer: str = Field(min_length=1, max_length=4000)


class Assessment(Lenient):
    score: int = Field(ge=1, le=5)
    feedback: str = Field(max_length=800)
    strengths: list[str] = Field(default_factory=list, max_length=5)
    improve: list[str] = Field(default_factory=list, max_length=5)
    follow_up: str | None = Field(None, max_length=400)

    @field_validator("score", mode="before")
    @classmethod
    def _clamp(cls, v: Any) -> Any:
        try:
            return max(1, min(5, round(float(v))))
        except (TypeError, ValueError):
            return v


class ApplicationIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    company: str = Field(min_length=1, max_length=120)
    role: str = Field(min_length=1, max_length=120)
    stage: Stage = "saved"
    url: str | None = Field(None, max_length=500, pattern=r"^https?://")
    notes: str | None = Field(None, max_length=2000)
    next_action: str | None = Field(None, max_length=200)
    next_action_date: dt.date | None = None
    match_score: int | None = Field(None, ge=0, le=100)


class ApplicationPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    company: str | None = Field(None, min_length=1, max_length=120)
    role: str | None = Field(None, min_length=1, max_length=120)
    stage: Stage | None = None
    url: str | None = Field(None, max_length=500, pattern=r"^https?://")
    notes: str | None = Field(None, max_length=2000)
    next_action: str | None = Field(None, max_length=200)
    next_action_date: dt.date | None = None
    match_score: int | None = Field(None, ge=0, le=100)


# ── Prompts ───────────────────────────────────────────────────────────────
TAILOR_SYSTEM = """You are an expert technical recruiter and resume writer.
Rewrite the candidate's material for the target job. NEVER invent employers, titles, degrees, metrics or skills that
are not in the resume; you may rephrase, reorder and emphasise. Reply with ONE JSON object:
{"headline": str, "summary": str (3-4 sentences),
 "bullets": [{"original": str|null, "rewritten": str (start with a strong verb), "why": str}] (5-8 items),
 "keywords_matched": [str], "keywords_missing": [str] (JD keywords the resume lacks),
 "cover_letter": str (3 short paragraphs, plain text, no placeholders like [Company] if the name is known)}"""

QUESTIONS_SYSTEM = """You are a senior interviewer. Write a realistic interview for this job and candidate.
Reply with JSON: {"questions": [{"id": 1, "text": str, "kind": "behavioral"|"technical"|"gap", "focus": str}]}
Exactly 5 questions: 2 technical (role-specific), 2 behavioral (STAR-style), 1 probing the candidate's biggest gap."""

ASSESS_SYSTEM = """You are an interview coach. Score the candidate's answer 1-5 (5 = excellent: specific, structured,
quantified, relevant). Be fair and concise. If the score is 3 or lower, ask ONE probing follow-up question that
gives them a chance to improve (else follow_up = null).
Reply with JSON: {"score": int, "feedback": str, "strengths": [str], "improve": [str], "follow_up": str|null}"""


class CareerService:
    def __init__(self, store: DocStore, get_llm, documents_dir, max_file_mb: int) -> None:  # noqa: ANN001
        self.db = store
        self.get_llm = get_llm
        self._documents_dir = documents_dir
        self._max_mb = max_file_mb

    def resume(self) -> dict[str, Any]:
        """The user's saved resume text, else the first document in the knowledge base."""
        saved = self.db.get("profile", "resume")
        if saved and saved.get("text"):
            return {"text": saved["text"], "source": "saved"}
        best: tuple[int, int, str, str] | None = None  # (named like a resume?, length, text, source)
        for path in discover_files(self._documents_dir, self._max_mb):
            loaded = load_file(path, self._documents_dir)
            text = "\n".join(p.text for p in loaded.pages).strip()
            named = int(any(k in path.name.lower() for k in ("resume", "cv", "curriculum")))
            if text and (best is None or (named, len(text)) > best[:2]):
                best = (named, len(text), text, loaded.source)
        return {"text": best[2], "source": best[3]} if best else {"text": "", "source": None}

    async def tailor(self, job: JobIn) -> Tailored:
        resume = self.resume()["text"]
        if not resume:
            raise HTTPException(409, "Add your resume first (paste it in the Resume tab).")
        prompt = (
            f"TARGET ROLE: {job.role or 'n/a'} at {job.company or 'n/a'}\n\nJOB DESCRIPTION:\n{clip(job.jd, 8000)}\n\n"
            f"CANDIDATE RESUME:\n{clip(resume, 9000)}"
        )
        return await ask_json(self.get_llm, TAILOR_SYSTEM, prompt, Tailored, task="careerpilot.tailor")

    async def start_interview(self, body: InterviewIn) -> dict[str, Any]:
        resume = self.resume()["text"]
        prompt = (
            f"JOB DESCRIPTION:\n{clip(body.jd, 6000)}\n\nRESUME:\n{clip(resume, 6000)}\n\n"
            f"KNOWN GAPS: {', '.join(body.gaps) or 'unknown'}"
        )
        qs = await ask_json(self.get_llm, QUESTIONS_SYSTEM, prompt, QuestionSet, task="careerpilot.questions")
        questions = [q.model_copy(update={"id": i}) for i, q in enumerate(qs.questions[:6], start=1)]
        return self.db.put(
            "interviews",
            {
                "company": body.company,
                "role": body.role,
                "jd": clip(body.jd, 6000),
                "questions": [q.model_dump() for q in questions],
                "answers": [],
            },
        )

    async def answer(self, session_id: str, body: AnswerIn) -> dict[str, Any]:
        session = self.db.get("interviews", session_id)
        if session is None:
            raise HTTPException(404, "Interview not found.")
        question = next((q for q in session["questions"] if q["id"] == body.question_id), None)
        if question is None:
            raise HTTPException(404, "Question not found.")
        prompt = (
            f"ROLE: {session.get('role') or 'n/a'}\nJOB (excerpt):\n{session['jd'][:2500]}\n\n"
            f"QUESTION ({question['kind']}): {question['text']}\n\nCANDIDATE ANSWER:\n{body.answer}"
        )
        result = await ask_json(self.get_llm, ASSESS_SYSTEM, prompt, Assessment, task="careerpilot.assess")
        questions = list(session["questions"])
        follow: dict[str, Any] | None = None
        # Adaptive: weak answers get one follow-up (never a follow-up to a follow-up).
        if result.follow_up and result.score <= 3 and question["kind"] != "follow_up":
            follow = {"id": max(q["id"] for q in questions) + 1, "text": result.follow_up, "kind": "follow_up",
                      "focus": question.get("focus", ""), "parent": question["id"]}  # fmt: skip
            idx = questions.index(question)
            questions.insert(idx + 1, follow)
        answers = [a for a in session["answers"] if a["question_id"] != body.question_id]
        answers.append({"question_id": body.question_id, "answer": body.answer, **result.model_dump()})
        saved = self.db.patch("interviews", session_id, {"questions": questions, "answers": answers})
        return {"assessment": result.model_dump(), "follow_up": follow, "session": saved}


def summary(session: dict[str, Any]) -> dict[str, Any]:
    scores = [a["score"] for a in session.get("answers", [])]
    return {
        "answered": len(scores),
        "total": len(session.get("questions", [])),
        "average": round(sum(scores) / len(scores), 1) if scores else None,
    }


# ── API ───────────────────────────────────────────────────────────────────
def get_career(request: Request) -> CareerService:
    return request.app.state.suite.career


Career = Annotated[CareerService, Depends(get_career)]
router = APIRouter(prefix="/api/career", tags=["careerpilot"])


class ResumeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=50, max_length=20000)


@router.get("/resume")
def get_resume(career: Career) -> dict[str, Any]:
    return career.resume()


@router.put("/resume")
def put_resume(body: ResumeIn, career: Career) -> dict[str, Any]:
    career.db.put("profile", {"text": normalize(body.text)}, id="resume")
    return career.resume()


@router.delete("/resume", status_code=204)
def reset_resume(career: Career) -> None:
    career.db.delete("profile", "resume")


async def _llm(coro):  # noqa: ANN001, ANN202
    try:
        return await coro
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, llm_failure(exc)) from None


@router.post("/tailor", response_model=Tailored)
@limiter.limit(rate_limit_value)
async def tailor(request: Request, body: JobIn, career: Career) -> Tailored:
    return await _llm(career.tailor(body))


@router.post("/interviews", status_code=201)
@limiter.limit(rate_limit_value)
async def start_interview(request: Request, body: InterviewIn, career: Career) -> dict[str, Any]:
    session = await _llm(career.start_interview(body))
    return {**session, "summary": summary(session)}


@router.get("/interviews")
def list_interviews(career: Career) -> list[dict[str, Any]]:
    return [
        {"id": s["id"], "company": s.get("company"), "role": s.get("role"), "updated_at": s["updated_at"], **summary(s)}
        for s in career.db.list("interviews", limit=30)
    ]


@router.get("/interviews/{session_id}")
def get_interview(session_id: str, career: Career) -> dict[str, Any]:
    session = career.db.get("interviews", session_id[:40])
    if session is None:
        raise HTTPException(404, "Interview not found.")
    return {**session, "summary": summary(session)}


@router.post("/interviews/{session_id}/answers")
@limiter.limit(rate_limit_value)
async def answer(request: Request, session_id: str, body: AnswerIn, career: Career) -> dict[str, Any]:
    out = await _llm(career.answer(session_id[:40], body))
    out["summary"] = summary(out["session"])
    return out


@router.get("/applications")
def list_applications(career: Career) -> list[dict[str, Any]]:
    return career.db.list("applications")


@router.post("/applications", status_code=201)
def create_application(body: ApplicationIn, career: Career) -> dict[str, Any]:
    return career.db.put("applications", body.model_dump(mode="json"))


@router.patch("/applications/{app_id}")
def patch_application(app_id: str, body: ApplicationPatch, career: Career) -> dict[str, Any]:
    doc = career.db.patch("applications", app_id[:40], body.model_dump(mode="json", exclude_unset=True))
    if doc is None:
        raise HTTPException(404, "Application not found.")
    return doc


@router.delete("/applications/{app_id}", status_code=204)
def delete_application(app_id: str, career: Career) -> None:
    if not career.db.delete("applications", app_id[:40]):
        raise HTTPException(404, "Application not found.")


@router.delete("/interviews/{session_id}", status_code=204)
def delete_interview(session_id: str, career: Career) -> None:
    if not career.db.delete("interviews", session_id[:40]):
        raise HTTPException(404, "Interview not found.")
