"""Product endpoints beyond chat: Document Briefs and the Match Analyzer."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.api.routes import get_rag
from app.rag.briefs import UnknownDocumentError
from app.rag.matcher import run_match
from app.rag.service import RAGService
from appcore.guardrails import normalize
from appcore.llm.chat import user_facing_error
from appcore.llm.structured import StructuredOutputError
from appcore.security import limiter, rate_limit_value

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")
Rag = Annotated[RAGService, Depends(get_rag)]


class MatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=40, max_length=8000)

    @field_validator("text")
    @classmethod
    def _clean(cls, v: str) -> str:
        return normalize(v)


def _sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _llm_failure(exc: Exception) -> str:
    if isinstance(exc, StructuredOutputError):
        return "The model's response couldn't be parsed. Please try again."
    if isinstance(exc, TimeoutError):
        return "The model took too long to respond (the free tier may be busy). Please try again."
    message = user_facing_error(exc)
    if message is None:
        logger.exception("product request failed")
    return message or "Something went wrong while talking to the model."


@router.get("/briefs")
@limiter.limit(rate_limit_value)
async def brief(
    request: Request,
    rag: Rag,
    source: Annotated[str, Query(min_length=1, max_length=300)],
    refresh: bool = False,
) -> dict[str, Any]:
    try:
        return await rag.briefs.get(source, refresh=refresh)
    except UnknownDocumentError:
        raise HTTPException(404, "Unknown document") from None
    except Exception as exc:
        raise HTTPException(503, _llm_failure(exc)) from None


@router.post("/match/stream")
@limiter.limit(rate_limit_value)
async def match_stream(request: Request, body: MatchRequest, rag: Rag) -> StreamingResponse:
    async def events() -> AsyncIterator[str]:
        try:
            async for ev in run_match(body.text, rag.retriever, rag.get_llm, rag.settings):
                name = ev.pop("event")
                yield _sse(name, ev)
        except Exception as exc:  # never leak internals
            yield _sse("error", {"message": _llm_failure(exc)})

    return StreamingResponse(
        events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )
