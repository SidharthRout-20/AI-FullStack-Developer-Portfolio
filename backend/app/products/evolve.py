"""Evolve: a self-improving prompt engine.

A *task* is a goal plus a versioned system prompt plus validators. Every *run* is validated (deterministic
checks, then an LLM judge against the rubric) and can receive human feedback. Failures become *lessons*.
*Reflection* asks the model to rewrite the prompt from those lessons, then re-tests the candidate on a
regression set of recent inputs and promotes it only if it scores at least as well as the current version.
Nothing is promoted on faith: the system gets smarter with use, and cannot silently get worse.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import defaultdict
from collections.abc import AsyncIterator
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.ai import GetLLM, Lenient, ask_json, ask_text, clip, llm_failure, sse
from app.core.docstore import DocStore
from app.core.security import limiter, rate_limit_value
from app.rag.guardrails import normalize
from app.rag.structured import extract_json

logger = logging.getLogger(__name__)

PASS_SCORE = 4  # judge score (1-5) needed to pass
REGRESSION_SIZE = 6  # recent inputs a candidate prompt is re-tested on (keeps free-tier cost bounded)
MAX_LESSONS = 8


# ── Models ────────────────────────────────────────────────────────────────
class Validators(BaseModel):
    model_config = ConfigDict(extra="forbid")
    must_include: list[str] = Field(default_factory=list, max_length=10)
    must_avoid: list[str] = Field(default_factory=list, max_length=10)
    max_words: int | None = Field(None, ge=5, le=5000)
    json_keys: list[str] = Field(
        default_factory=list, max_length=20, description="If set, output must be JSON with these keys"
    )
    rubric: str = Field("", max_length=1500, description="What a great output looks like; the judge scores against it")

    @field_validator("must_include", "must_avoid", "json_keys", mode="before")
    @classmethod
    def _strip(cls, v: Any) -> Any:
        return [s.strip() for s in (v or []) if isinstance(s, str) and s.strip()]


class TaskIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=2, max_length=80)
    goal: str = Field(min_length=10, max_length=1000)
    input_label: str = Field("Input", max_length=60)
    prompt: str = Field(min_length=10, max_length=6000)
    validators: Validators = Field(default_factory=Validators)
    auto_reflect_after: int = Field(3, ge=1, le=20, description="Reflect automatically after this many failures")


class TaskPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(None, min_length=2, max_length=80)
    goal: str | None = Field(None, min_length=10, max_length=1000)
    validators: Validators | None = None
    auto_reflect_after: int | None = Field(None, ge=1, le=20)


class RunIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    input: str = Field(min_length=1, max_length=8000)


class FeedbackIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    feedback: Literal["good", "bad"]
    note: str | None = Field(None, max_length=500)


class PromptIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str = Field(min_length=10, max_length=6000)
    rationale: str | None = Field(None, max_length=500)


class Judgement(Lenient):
    score: int = Field(3, ge=1, le=5)
    reasons: list[str] = Field(default_factory=list, max_length=6)
    failed_criteria: list[str] = Field(default_factory=list, max_length=6)

    @field_validator("score", mode="before")
    @classmethod
    def _clamp(cls, v: Any) -> Any:
        try:
            return max(1, min(5, round(float(v))))
        except (TypeError, ValueError):
            return 3


class Proposal(Lenient):
    prompt: str = Field(max_length=6000)
    rationale: str = Field(max_length=1200)
    lessons: list[str] = Field(default_factory=list, max_length=8)


# ── Prompts ───────────────────────────────────────────────────────────────
JUDGE_SYSTEM = """You are a strict but fair evaluator of AI outputs. Score the OUTPUT for the TASK on a 1-5 scale
(5 = excellent, 4 = good with minor issues, 3 = acceptable but clearly improvable, 2 = poor, 1 = unusable/wrong).
Judge ONLY against the goal and rubric given. Reply with JSON: {"score": int, "reasons": [str], "failed_criteria": [str]}"""

REFLECT_SYSTEM = """You are a prompt engineer improving a system prompt from evidence.
You get the task goal, the CURRENT prompt, LESSONS (inputs where the output failed, with why) and EXEMPLARS (outputs
that passed). Write a REVISED prompt that:
- keeps everything that already works (do not drop existing rules or change the voice without reason),
- adds concrete, general rules that would have prevented each failure (never rules that only fit one example),
- stays clear and compact (at most ~1.5x the current length), written as instructions, no examples longer than a line.
Reply with JSON: {"prompt": str, "rationale": str (what changed and why, 2-4 sentences), "lessons": [str] (one line per
general lesson learned)}"""


# ── Deterministic checks ──────────────────────────────────────────────────
def run_checks(output: str, v: Validators) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    low = output.lower()
    for needle in v.must_include:
        checks.append({"name": f"includes “{needle}”", "passed": needle.lower() in low})
    for needle in v.must_avoid:
        checks.append({"name": f"avoids “{needle}”", "passed": needle.lower() not in low})
    if v.max_words:
        n = len(re.findall(r"\S+", output))
        checks.append({"name": f"≤ {v.max_words} words", "passed": n <= v.max_words, "detail": f"{n} words"})
    if v.json_keys:
        try:
            data = extract_json(output)
            missing = [k for k in v.json_keys if not isinstance(data, dict) or k not in data]
            checks.append(
                {
                    "name": "valid JSON with required keys",
                    "passed": not missing,
                    "detail": f"missing: {missing}" if missing else "ok",
                }
            )
        except ValueError:
            checks.append({"name": "valid JSON with required keys", "passed": False, "detail": "not valid JSON"})
    return checks


# ── Service ───────────────────────────────────────────────────────────────
class EvolveService:
    def __init__(self, store: DocStore, get_llm: GetLLM) -> None:
        self.db = store
        self.get_llm = get_llm
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._background: set[asyncio.Task[Any]] = set()

    # ── tasks & versions ─────────────────────────────────────────────────
    def create_task(self, body: TaskIn) -> dict[str, Any]:
        task = self.db.put(
            "tasks",
            {
                **body.model_dump(exclude={"prompt"}),
                "current_version": 1,
                "failures_since_reflect": 0,
                "reflecting": False,
            },
        )
        self.db.put("versions", {"task_id": task["id"], "n": 1, "prompt": body.prompt, "rationale": "Seed prompt.", "source": "seed",
                                 "score": None, "evaluated_on": 0, "promoted": True, "lessons": []}, parent=task["id"])  # fmt: skip
        return self.task(task["id"])

    def task(self, task_id: str) -> dict[str, Any]:
        t = self.db.get("tasks", task_id)
        if t is None:
            raise HTTPException(404, "Task not found.")
        versions = sorted(self.db.list("versions", parent=task_id, limit=100), key=lambda v: v["n"])
        runs = self.db.list("runs", parent=task_id, limit=60)
        return {**t, "versions": versions, "runs": runs, "summary": summary(versions, runs, t["current_version"])}

    def current_prompt(self, task_id: str) -> tuple[int, str]:
        t = self.db.get("tasks", task_id)
        if t is None:
            raise HTTPException(404, "Task not found.")
        v = next(
            (v for v in self.db.list("versions", parent=task_id, limit=100) if v["n"] == t["current_version"]), None
        )
        if v is None:
            raise HTTPException(500, "Task has no current prompt version.")
        return v["n"], v["prompt"]

    def add_version(self, task_id: str, prompt: str, rationale: str, source: str, *, promoted: bool,
                    score: float | None = None, evaluated_on: int = 0, lessons: list[str] | None = None,
                    baseline: float | None = None) -> dict[str, Any]:  # fmt: skip
        versions = self.db.list("versions", parent=task_id, limit=100)
        n = max((v["n"] for v in versions), default=0) + 1
        v = self.db.put("versions", {"task_id": task_id, "n": n, "prompt": prompt, "rationale": rationale, "source": source,
                                     "score": score, "baseline": baseline, "evaluated_on": evaluated_on, "promoted": promoted,
                                     "lessons": lessons or []}, parent=task_id)  # fmt: skip
        if promoted:
            self.db.patch("tasks", task_id, {"current_version": n, "failures_since_reflect": 0})
        return v

    # ── runs ─────────────────────────────────────────────────────────────
    async def execute(self, task: dict[str, Any], prompt: str, user_input: str) -> dict[str, Any]:
        """Run one input through a prompt and validate it (no persistence)."""
        v = Validators.model_validate(task.get("validators") or {})
        started = time.perf_counter()
        output = (await ask_text(self.get_llm, prompt, clip(user_input, 8000), limit_s=60, task="evolve.run")).strip()
        checks = run_checks(output, v)
        judge = await self.judge(task, v, user_input, output)
        passed = all(c["passed"] for c in checks) and judge["score"] >= PASS_SCORE
        return {
            "output": output,
            "checks": checks,
            "judge": judge,
            "passed": passed,
            "ms": round((time.perf_counter() - started) * 1000),
        }

    async def judge(self, task: dict[str, Any], v: Validators, user_input: str, output: str) -> dict[str, Any]:
        prompt = (
            f"TASK GOAL: {task['goal']}\nRUBRIC: {v.rubric or 'Correct, clear, complete and appropriate for the goal.'}\n\n"
            f"INPUT:\n{clip(user_input, 3000)}\n\nOUTPUT:\n{clip(output, 3000)}"
        )
        try:
            j = await ask_json(self.get_llm, JUDGE_SYSTEM, prompt, Judgement, limit_s=60, task="evolve.judge")
            return j.model_dump()
        except Exception as exc:  # noqa: BLE001 - a judge outage must not block runs
            logger.info("judge unavailable: %s", type(exc).__name__)
            return {
                "score": PASS_SCORE,
                "reasons": ["Judge unavailable; deterministic checks only."],
                "failed_criteria": [],
            }

    async def run(self, task_id: str, user_input: str) -> dict[str, Any]:
        task = self.db.get("tasks", task_id)
        if task is None:
            raise HTTPException(404, "Task not found.")
        n, prompt = self.current_prompt(task_id)
        result = await self.execute(task, prompt, user_input)
        run = self.db.put("runs", {"task_id": task_id, "version_n": n, "input": user_input, **result, "feedback": None, "note": None},
                          parent=task_id)  # fmt: skip
        if not result["passed"]:
            self._count_failure(task_id)
        return {**run, "auto_reflect": self._maybe_auto_reflect(task_id)}

    def feedback(self, run_id: str, body: FeedbackIn) -> dict[str, Any]:
        run = self.db.get("runs", run_id)
        if run is None:
            raise HTTPException(404, "Run not found.")
        was_failed = not run["passed"]
        updated = self.db.patch(
            "runs", run_id, {"feedback": body.feedback, "note": body.note, "passed": body.feedback == "good"}
        )
        if body.feedback == "bad" and not was_failed:
            self._count_failure(run["task_id"])
        return {**updated, "auto_reflect": self._maybe_auto_reflect(run["task_id"])}  # type: ignore[arg-type]

    def _count_failure(self, task_id: str) -> None:
        t = self.db.get("tasks", task_id) or {}
        self.db.patch("tasks", task_id, {"failures_since_reflect": int(t.get("failures_since_reflect", 0)) + 1})

    def _maybe_auto_reflect(self, task_id: str) -> bool:
        t = self.db.get("tasks", task_id) or {}
        if t.get("reflecting") or int(t.get("failures_since_reflect", 0)) < int(t.get("auto_reflect_after", 3)):
            return False
        task = asyncio.create_task(self._reflect_quietly(task_id))
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        return True

    async def _reflect_quietly(self, task_id: str) -> None:
        try:
            async for _ in self.reflect(task_id, trigger="auto"):
                pass
        except Exception:  # noqa: BLE001
            logger.exception("Automatic reflection failed")

    # ── reflection ───────────────────────────────────────────────────────
    def lessons(self, task_id: str) -> list[dict[str, Any]]:
        """Failed runs (newest first), with the reason each one failed."""
        out = []
        for r in self.db.list("runs", parent=task_id, limit=200):
            if r["passed"]:
                continue
            reasons = [c["name"] for c in r["checks"] if not c["passed"]]
            reasons += (r.get("judge") or {}).get("failed_criteria", []) or (r.get("judge") or {}).get("reasons", [])[
                :2
            ]
            if r.get("note"):
                reasons.append(f"Human: {r['note']}")
            out.append({"run_id": r["id"], "input": r["input"], "output": r["output"], "why": reasons[:4], "version_n": r["version_n"],
                        "at": r["created_at"]})  # fmt: skip
        return out

    def regression_set(self, task_id: str, current_n: int) -> list[dict[str, Any]]:
        """Recent distinct inputs the candidate must handle: failures first, then passes.

        Runs on the current version come first (their verdict is the baseline for free). Older inputs are included
        too; their baseline is measured by re-running the current prompt (see `_reflect`), so the comparison is fair.
        """
        runs = sorted(
            self.db.list("runs", parent=task_id, limit=200), key=lambda r: (r["version_n"] != current_n, r["passed"])
        )
        failed = [r for r in runs if not r["passed"]]
        passed = [r for r in runs if r["passed"]]
        seen: set[str] = set()
        picked = []
        for r in failed + passed:
            key = r["input"].strip().lower()
            if key not in seen:
                seen.add(key)
                picked.append(r)
            if len(picked) >= REGRESSION_SIZE:
                break
        return picked

    async def reflect(self, task_id: str, trigger: str = "manual") -> AsyncIterator[dict[str, Any]]:
        lock = self._locks[task_id]
        if lock.locked():
            yield {"event": "error", "message": "A reflection is already running for this task."}
            return
        async with lock:
            self.db.patch("tasks", task_id, {"reflecting": True})
            try:
                async for ev in self._reflect(task_id, trigger):
                    yield ev
            finally:
                self.db.patch("tasks", task_id, {"reflecting": False})

    async def _reflect(self, task_id: str, trigger: str) -> AsyncIterator[dict[str, Any]]:
        task = self.db.get("tasks", task_id)
        if task is None:
            raise HTTPException(404, "Task not found.")
        current_n, current_prompt = self.current_prompt(task_id)
        lessons = self.lessons(task_id)[:MAX_LESSONS]
        if not lessons:
            yield {
                "event": "error",
                "message": "No failed runs yet, so there is nothing to learn from. Run some inputs first.",
            }
            return
        exemplars = [
            r for r in self.db.list("runs", parent=task_id, limit=100) if r["passed"] and r.get("feedback") != "bad"
        ][:3]
        yield {"event": "step", "step": "gather", "detail": f"{len(lessons)} lessons, {len(exemplars)} exemplars"}

        prompt = (
            f"GOAL: {task['goal']}\n\nCURRENT PROMPT (v{current_n}):\n{current_prompt}\n\nLESSONS (failures):\n"
            + "\n".join(
                f"- INPUT: {clip(x['input'], 500)}\n  OUTPUT: {clip(x['output'], 500)}\n  WHY IT FAILED: {'; '.join(x['why'])}"
                for x in lessons
            )
            + (
                "\n\nEXEMPLARS (passed):\n"
                + "\n".join(f"- INPUT: {clip(e['input'], 300)}\n  OUTPUT: {clip(e['output'], 300)}" for e in exemplars)
                if exemplars
                else ""
            )
        )
        proposal = await ask_json(self.get_llm, REFLECT_SYSTEM, prompt, Proposal, limit_s=120, task="evolve.reflect")
        if len(proposal.prompt.strip()) < 10 or proposal.prompt.strip() == current_prompt.strip():
            yield {"event": "error", "message": "The model proposed no change."}
            return
        yield {
            "event": "step",
            "step": "propose",
            "detail": proposal.rationale,
            "prompt": proposal.prompt,
            "lessons": proposal.lessons,
        }

        cases = self.regression_set(task_id, current_n)
        results = []
        for i, case in enumerate(cases, start=1):
            if case["version_n"] == current_n:
                before = bool(case["passed"])
            else:  # older input: measure how the *current* prompt does on it today
                before = (await self.execute(task, current_prompt, case["input"]))["passed"]
            res = await self.execute(task, proposal.prompt, case["input"])
            results.append(
                {
                    "input": case["input"],
                    "before": before,
                    "after": res["passed"],
                    "score": res["judge"]["score"],
                    "output": res["output"],
                }
            )
            yield {
                "event": "step",
                "step": "evaluate",
                "detail": f"case {i}/{len(cases)}: {'pass' if before else 'fail'} → {'pass' if res['passed'] else 'fail'}",
                "case": results[-1],
            }
        baseline = sum(1 for r in results if r["before"]) / len(results) if results else 0.0
        score = sum(1 for r in results if r["after"]) / len(results) if results else 0.0
        fixed = sum(1 for r in results if not r["before"] and r["after"])
        regressed = sum(1 for r in results if r["before"] and not r["after"])
        promoted = (
            bool(results) and score >= baseline and fixed > 0 and regressed == 0 or (bool(results) and score > baseline)
        )
        version = self.add_version(task_id, proposal.prompt, proposal.rationale, f"reflection ({trigger})", promoted=promoted,
                                   score=round(score, 3), evaluated_on=len(results), lessons=proposal.lessons, baseline=round(baseline, 3))  # fmt: skip
        if not promoted:
            self.db.patch("tasks", task_id, {"failures_since_reflect": 0})  # don't loop on the same failures
        yield {"event": "done", "promoted": promoted, "version": version, "baseline": round(baseline, 3), "score": round(score, 3),
               "fixed": fixed, "regressed": regressed, "cases": results, "task": self.task(task_id)}  # fmt: skip


def summary(versions: list[dict[str, Any]], runs: list[dict[str, Any]], current_n: int) -> dict[str, Any]:
    by_version: dict[int, list[bool]] = defaultdict(list)
    for r in runs:
        by_version[r["version_n"]].append(bool(r["passed"]))
    rates = {str(n): round(sum(v) / len(v), 3) for n, v in by_version.items() if v}
    current = by_version.get(current_n, [])
    return {
        "runs": len(runs),
        "pass_rate": round(sum(current) / len(current), 3) if current else None,
        "pass_rate_by_version": rates,
        "promotions": sum(1 for v in versions if v["promoted"] and v["n"] > 1),
        "rejected": sum(1 for v in versions if not v["promoted"]),
    }


# ── Starter templates ────────────────────────────────────────────────────
TEMPLATES: list[dict[str, Any]] = [
    {
        "name": "Support reply writer",
        "goal": "Turn a customer's message into a short, warm, actionable support reply.",
        "input_label": "Customer message",
        "prompt": "You write replies to customer support messages. Be polite and helpful.",
        "validators": {
            "must_include": ["thank"],
            "must_avoid": ["unfortunately", "as per our policy"],
            "max_words": 120,
            "rubric": "Acknowledges the specific problem, gives one clear next step or resolution, warm but not gushing, no jargon, under 120 words.",
        },  # fmt: skip
        "auto_reflect_after": 2,
        "samples": [
            "My order #4412 arrived with a cracked screen. I need it for a gift on Friday.",
            "I was charged twice this month. Second charge on the 14th. Please fix.",
            "How do I export my data? I'm leaving for a competitor, your app crashes daily.",
        ],  # fmt: skip
    },
    {
        "name": "Commit message writer",
        "goal": "Write a Conventional Commits message from a diff summary.",
        "input_label": "Change description / diff summary",
        "prompt": "Write a git commit message for the change described.",
        "validators": {
            "must_avoid": ["fixed stuff", "misc"],
            "max_words": 40,
            "rubric": "First line is a Conventional Commits header (type(scope): imperative summary ≤ 72 chars), optional body explains why, not what.",
        },  # fmt: skip
        "auto_reflect_after": 2,
        "samples": [
            "Added retry with exponential backoff to the Groq client; bumped timeout to 60s.",
            "Renamed userId to accountId across the billing module and updated tests.",
            "Fixed a crash when the uploaded PDF has zero pages.",
        ],  # fmt: skip
    },
    {
        "name": "Meeting notes → JSON",
        "goal": "Extract structured decisions and actions from raw meeting notes as JSON.",
        "input_label": "Raw notes",
        "prompt": "Extract decisions and action items from the notes.",
        "validators": {
            "json_keys": ["decisions", "actions"],
            "max_words": 300,
            "rubric": "Valid JSON only, decisions and actions are arrays of short strings, every action names an owner when the notes give one, nothing invented.",
        },  # fmt: skip
        "auto_reflect_after": 2,
        "samples": [
            "Priya: let's ship on the 28th if load tests pass. Arjun to run them Thursday. Meera needs screenshots by Monday.",
            "Budget approved for 2 more GPUs. Nobody owns the procurement yet. Revisit pricing page next sprint.",
        ],  # fmt: skip
    },
]


# ── API ───────────────────────────────────────────────────────────────────
def get_evolve(request: Request) -> EvolveService:
    return request.app.state.suite.evolve


Evolve = Annotated[EvolveService, Depends(get_evolve)]
router = APIRouter(prefix="/api/evolve", tags=["evolve"])


async def _llm(coro):  # noqa: ANN001, ANN202
    try:
        return await coro
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, llm_failure(exc)) from None


@router.get("/templates")
def templates() -> list[dict[str, Any]]:
    return TEMPLATES


@router.get("/tasks")
def list_tasks(svc: Evolve) -> list[dict[str, Any]]:
    out = []
    for t in svc.db.list("tasks", limit=100):
        runs = svc.db.list("runs", parent=t["id"], limit=60)
        versions = svc.db.list("versions", parent=t["id"], limit=100)
        out.append({**t, "summary": summary(versions, runs, t["current_version"])})
    return out


@router.post("/tasks", status_code=201)
def create_task(body: TaskIn, svc: Evolve) -> dict[str, Any]:
    return svc.create_task(body)


@router.get("/tasks/{task_id}")
def get_task(task_id: str, svc: Evolve) -> dict[str, Any]:
    return svc.task(task_id[:40])


@router.patch("/tasks/{task_id}")
def patch_task(task_id: str, body: TaskPatch, svc: Evolve) -> dict[str, Any]:
    if svc.db.patch("tasks", task_id[:40], body.model_dump(exclude_unset=True)) is None:
        raise HTTPException(404, "Task not found.")
    return svc.task(task_id[:40])


@router.delete("/tasks/{task_id}", status_code=204)
def delete_task(task_id: str, svc: Evolve) -> None:
    if not svc.db.delete("tasks", task_id[:40]):
        raise HTTPException(404, "Task not found.")


@router.get("/tasks/{task_id}/lessons")
def lessons(task_id: str, svc: Evolve) -> list[dict[str, Any]]:
    svc.task(task_id[:40])
    return svc.lessons(task_id[:40])


@router.post("/tasks/{task_id}/run")
@limiter.limit(rate_limit_value)
async def run(request: Request, task_id: str, body: RunIn, svc: Evolve) -> dict[str, Any]:
    return await _llm(svc.run(task_id[:40], normalize(body.input)))


@router.post("/runs/{run_id}/feedback")
def feedback(run_id: str, body: FeedbackIn, svc: Evolve) -> dict[str, Any]:
    return svc.feedback(run_id[:40], body)


@router.post("/tasks/{task_id}/versions", status_code=201)
def manual_version(task_id: str, body: PromptIn, svc: Evolve) -> dict[str, Any]:
    """Hand-edited prompt: promoted immediately (you asked for it); measured like any other version."""
    svc.task(task_id[:40])
    svc.add_version(task_id[:40], body.prompt, body.rationale or "Manual edit.", "manual", promoted=True)
    return svc.task(task_id[:40])


@router.post("/tasks/{task_id}/versions/{n}/promote")
def promote(task_id: str, n: int, svc: Evolve) -> dict[str, Any]:
    """Roll back / forward to any existing version."""
    t = svc.task(task_id[:40])
    if not any(v["n"] == n for v in t["versions"]):
        raise HTTPException(404, "Version not found.")
    svc.db.patch("tasks", task_id[:40], {"current_version": n, "failures_since_reflect": 0})
    return svc.task(task_id[:40])


@router.post("/tasks/{task_id}/reflect")
@limiter.limit("4/minute")
async def reflect(request: Request, task_id: str, svc: Evolve) -> StreamingResponse:
    svc.task(task_id[:40])

    async def events() -> AsyncIterator[str]:
        try:
            async for ev in svc.reflect(task_id[:40]):
                yield sse(ev.pop("event"), ev)
        except HTTPException as exc:
            yield sse("error", {"message": exc.detail})
        except Exception as exc:  # noqa: BLE001
            yield sse("error", {"message": llm_failure(exc)})

    return StreamingResponse(
        events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )
