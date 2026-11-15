"""HTTP endpoints. Thin by design: validate → delegate to RAGService → shape response."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import AsyncIterator
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from app.api.schemas import (
    ChatRequest,
    ChatResponse,
    DocumentInfo,
    GraphResponse,
    HealthResponse,
    IngestResponse,
)
from app.config import database_hint
from app.core.db import check_postgres
from app.core.security import limiter, rate_limit_value, require_admin
from app.rag.llm import user_facing_error
from app.rag.service import RAGService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api")


def get_rag(request: Request) -> RAGService:
    return request.app.state.rag


Rag = Annotated[RAGService, Depends(get_rag)]


def _history(body: ChatRequest, rag: RAGService) -> list[dict[str, str]]:
    return [m.model_dump() for m in body.history[-rag.settings.max_history_messages :]]


def _sse(event: str, data: Any) -> str:
    """Server-Sent Events wire format."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.get("/health", response_model=HealthResponse)
async def health(rag: Rag) -> dict[str, Any]:
    return {
        "status": "ok",
        "chunks_indexed": rag.store.count(),
        "llm_provider": rag.settings.llm_provider,
        "llm_model": rag.settings.active_model,
        "llm_ready": rag.llm_ready,
        "index_version": rag.index_version,
        "last_ingest": rag.last_ingest,
        "storage": rag.settings.storage,
        "storage_source": (src := rag.settings.db_source) and src[0],
        "storage_hint": None if src else database_hint(os.environ),
        **(await _storage_check(rag.settings.db_url)),
    }


async def _storage_check(url: str | None) -> dict[str, Any]:
    """With Postgres configured, prove the database answers (not just that a URL is present)."""
    if not url:
        return {"storage_ok": None, "storage_error": None}
    ok, reason = await asyncio.to_thread(check_postgres, url)
    return {"storage_ok": ok, "storage_error": reason}


@router.get("/graph", response_model=GraphResponse)
async def graph(rag: Rag) -> dict[str, Any]:
    return rag.topology


@router.get("/documents", response_model=list[DocumentInfo])
async def documents(rag: Rag) -> list[dict[str, Any]]:
    return await asyncio.to_thread(rag.documents)


@router.post("/chat", response_model=ChatResponse)
@limiter.limit(rate_limit_value)
async def chat(request: Request, body: ChatRequest, rag: Rag) -> dict[str, Any]:
    return await rag.answer(body.question, _history(body, rag))


@router.post("/chat/stream")
@limiter.limit(rate_limit_value)
async def chat_stream(request: Request, body: ChatRequest, rag: Rag) -> StreamingResponse:
    history = _history(body, rag)

    async def event_source() -> AsyncIterator[str]:
        try:
            async for ev in rag.stream(body.question, history):
                name = ev.pop("event")
                yield _sse(name, ev)
        except Exception as exc:  # never leak internals to clients
            message = user_facing_error(exc)
            if message is None:
                logger.exception("chat stream failed")
            else:
                logger.warning("chat stream failed: %s", type(exc).__name__)
            yield _sse("error", {"message": message or "Something went wrong while generating the answer."})

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/admin/reindex", response_model=IngestResponse, dependencies=[Depends(require_admin)])
async def reindex(rag: Rag) -> dict[str, Any]:
    report = await asyncio.to_thread(rag.ingest)
    return {
        "added": report.added,
        "updated": report.updated,
        "removed": report.removed,
        "failed": report.failed,
        "unchanged": len(report.unchanged),
        "chunks_written": report.chunks_written,
    }
