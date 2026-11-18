"""Briefs, Match Analyzer and structured-output tests (scripted fake LLM: offline, deterministic)."""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.rag.matcher import score
from app.rag.service import RAGService
from appcore.llm.structured import StructuredOutputError, complete_json, extract_json
from tests.conftest import FakeEmbedder
from tests.test_api import parse_sse

BRIEF = {
    "title": "Engineer resume",
    "summary": "A senior engineer.",
    "highlights": ["Python", "FastAPI"],
    "topics": [{"label": "Skills", "items": ["Python", "React"]}],
    "suggested_questions": ["What are the skills?"],
}
EXTRACT = {
    "title": "AI Engineer",
    "requirements": [
        {"text": "Python and FastAPI", "priority": "must"},
        {"text": "Kubernetes operators", "priority": "nice to have"},
    ],
}
ASSESS = {
    "verdict": "Strong backend fit.",
    "assessments": [
        {"id": 1, "status": "met", "rationale": "Lists Python and FastAPI.", "evidence": [1, 9]},
        {"id": 2, "status": "MISSING", "rationale": "No Kubernetes."},
    ],
}


class ScriptedLLM:
    """Implements the ChatLLM protocol; answers by recognising which prompt it was sent."""

    def __init__(self, replies: dict[str, str] | None = None) -> None:
        self.calls = 0
        self.replies = replies or {
            "brief of the document": json.dumps(BRIEF),
            "Extract the distinct": "Sure! ```json\n" + json.dumps(EXTRACT) + "\n```",
            "For each requirement": json.dumps(ASSESS),
        }

    async def complete(self, system, messages, *, short=False):
        self.calls += 1
        prompt = messages[0]["content"]
        return next((r for k, r in self.replies.items() if k in prompt), "The candidate knows Python [1].")

    async def stream(self, system, messages):
        yield "The candidate knows Python [1]."


@pytest.fixture
def scripted():
    return ScriptedLLM()


@pytest.fixture
def pclient(settings, scripted):
    app = create_app(
        settings, service_factory=lambda s: RAGService(s, llm_factory=lambda _: scripted, embedder=FakeEmbedder())
    )
    with TestClient(app) as c:
        yield c


# ── structured outputs ────────────────────────────────────────────────────
def test_extract_json_tolerates_fences_and_prose():
    assert extract_json('Here you go:\n```json\n{"a": 1}\n```\nThanks') == {"a": 1}
    assert extract_json('prefix {"a": {"b": 2}} suffix') == {"a": {"b": 2}}
    with pytest.raises(ValueError):
        extract_json("no json here")


def test_complete_json_retries_then_fails_cleanly():
    from app.rag.briefs import Brief

    llm = ScriptedLLM({"": "not json"})
    with pytest.raises(StructuredOutputError):
        asyncio.run(complete_json(llm, "sys", "prompt", Brief, retries=1))
    assert llm.calls == 2  # one retry with the validation error fed back


# ── briefs ────────────────────────────────────────────────────────────────
def test_brief_generated_then_cached(pclient, scripted):
    r = pclient.get("/api/briefs", params={"source": "resume.md"})
    assert r.status_code == 200
    body = r.json()
    assert body["cached"] is False and body["brief"]["topics"][0]["label"] == "Skills"
    assert body["chunks"] > 0

    calls = scripted.calls
    again = pclient.get("/api/briefs", params={"source": "resume.md"}).json()
    assert again["cached"] is True and scripted.calls == calls  # served from disk, no LLM call


def test_brief_only_for_indexed_documents(pclient):
    assert pclient.get("/api/briefs", params={"source": "../../etc/passwd"}).status_code == 404
    assert pclient.get("/api/briefs", params={"source": "nope.pdf"}).status_code == 404


# ── match analyzer ────────────────────────────────────────────────────────
def test_match_stream_stages_and_report(pclient):
    jd = "We need a senior AI engineer with Python and FastAPI. Kubernetes operators are nice to have."
    events = parse_sse(pclient.post("/api/match/stream", json={"text": jd}).text)

    stages = [(d["stage"], d["status"]) for e, d in events if e == "stage"]
    assert stages == [(s, x) for s in ("extract", "retrieve", "assess", "score") for x in ("start", "end")]

    result = events[-1][1]
    assert events[-1][0] == "result" and result["title"] == "AI Engineer"
    first, second = result["requirements"]
    assert first["status"] == "met" and first["evidence"]  # out-of-range evidence id 9 ignored
    assert second == {**second, "status": "missing", "priority": "nice", "evidence": []}
    assert result["counts"] == {"met": 1, "partial": 0, "missing": 1}
    assert result["score"] == 67  # must(2)*1 / (2+1)


def test_match_validation(pclient):
    assert pclient.post("/api/match/stream", json={"text": "too short"}).status_code == 422
    assert pclient.post("/api/match/stream", json={"text": "x" * 8001}).status_code == 422


def test_score_weights_must_over_nice():
    items = [{"priority": "must", "status": "partial"}, {"priority": "nice", "status": "met"}]
    assert score(items) == round(100 * (2 * 0.5 + 1) / 3)
    assert score([]) == 0


# ── conversation memory ───────────────────────────────────────────────────
def test_history_capped_to_last_four_exchanges(settings):
    assert settings.max_history_messages == 8


def test_cut_off_json_is_retried_asking_for_a_shorter_complete_reply():
    from pydantic import BaseModel

    from appcore.llm.structured import looks_truncated

    class Out(BaseModel):
        title: str
        items: list[str]

    seen: list[list[dict]] = []

    class LLM:
        async def complete(self, system, messages, *, short=False):
            seen.append(list(messages))
            return '{"title": "Tr' if len(seen) == 1 else '{"title": "Trip", "items": ["a"]}'

    out = asyncio.run(complete_json(LLM(), "sys", "prompt", Out, retries=1))
    assert out.items == ["a"]
    retry = seen[1]
    assert retry[-2] == {"role": "assistant", "content": "[reply cut off]"}  # the broken half isn't echoed back
    assert "cut off" in retry[-1]["content"] and "shorter" in retry[-1]["content"]

    assert looks_truncated('{"a": [1, 2') and looks_truncated('```json\n{"a": "unfinished')
    assert not looks_truncated('{"a": "brace } and \\" quote", "b": [1]}')
    assert not looks_truncated("no json at all")


def test_cut_off_json_keeps_its_complete_part_without_asking_again():
    from pydantic import BaseModel

    from appcore.llm.structured import salvage_json

    class Out(BaseModel):
        title: str
        items: list[str]

    calls: list[int] = []

    class LLM:
        async def complete(self, system, messages, *, short=False):
            calls.append(1)
            return '```json\n{"title": "Trip", "items": ["a", "b", "unfinish'

    out = asyncio.run(complete_json(LLM(), "sys", "prompt", Out, retries=1))
    assert out.items == ["a", "b"] and len(calls) == 1  # the cut-off item is dropped, no second call

    assert salvage_json('{"days": [{"day": 1, "stops": ["x"]}, {"day": 2, "stops": ["y", "z') == {
        "days": [{"day": 1, "stops": ["x"]}, {"day": 2, "stops": ["y"]}]
    }
    assert salvage_json('{"a": "brace } in a string", "b": [1, 2') == {"a": "brace } in a string", "b": [1]}
    assert salvage_json('{"a": 1}') is None  # nothing was cut off
    assert salvage_json('{"tit') is None  # nothing complete to keep


def test_extract_json_tolerates_arrays_and_trailing_commas():
    assert extract_json('Here you go: [{"day": 1}, {"day": 2},]') == [{"day": 1}, {"day": 2}]
    assert extract_json('{"a": [1, 2,], "b": {"c": 3,},}') == {"a": [1, 2], "b": {"c": 3}}
    assert extract_json('{"a": 1} and then {"b": 2}') == {"a": 1}


def test_lenient_schemas_coerce_common_model_quirks():
    from pydantic import Field

    from appcore.ai import Lenient

    class Out(Lenient):
        _aliases = {"notes": "note"}
        name: str = Field(max_length=5)
        note: str = ""
        who: str | None = None
        tags: list[str] = Field(default_factory=list, max_length=2)

    out = Out.model_validate({"name": "abcdefgh", "notes": "hi", "who": 2, "tags": "x, y, z"})
    assert (out.name, out.note, out.who, out.tags) == ("abcde", "hi", "2", ["x", "y"])
    assert Out.model_validate({"name": "a", "note": None}).note == ""  # null → the default
