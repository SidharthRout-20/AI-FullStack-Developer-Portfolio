"""LLM router diagnostics (admin only: requires ADMIN_API_KEY and the X-Admin-Key header).

* GET  /api/llm/router                 → catalogue, eligibility, quota state, recent routing decisions (metadata only)
* GET  /api/llm/router/decisions/{id}  → one decision: why that model was chosen, fallbacks, usage
* POST /api/llm/router/preview         → dry run: which model a described request would get now (no model call)
* POST /api/llm/router/discover        → refresh the model catalogue from GET /openai/v1/models (free, no tokens)

Disabled entirely (401) when no admin key is configured. Never returns prompts, outputs or secrets.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from appcore.llm import TASKS, LLMRequest, get_router
from appcore.security import require_admin

router = APIRouter(prefix="/api/llm", tags=["llm-router"], dependencies=[Depends(require_admin)])


def _router(request: Request):  # noqa: ANN202
    return get_router(request.app.state.rag.settings)


@router.get("/router")
def diagnostics(request: Request, limit: int = 50) -> dict[str, Any]:
    return {**_router(request).diagnostics(min(max(limit, 1), 200)), "tasks": sorted(TASKS)}


@router.get("/router/decisions/{decision_id}")
def decision(request: Request, decision_id: str) -> dict[str, Any]:
    d = _router(request).get_routing_decision(decision_id[:32])
    if d is None:
        raise HTTPException(404, "Decision not found (only the most recent 200 are kept per instance).")
    return d


class PreviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task: str = Field(min_length=3, max_length=80)
    input_chars: int = Field(500, ge=0, le=2_000_000)
    images: int = Field(0, ge=0, le=10)
    audio_mb: float = Field(0, ge=0, le=200)
    structured: Literal["none", "json", "schema", "strict"] | None = None
    tools: int = Field(0, ge=0, le=64)
    parallel_tools: bool = False
    max_output_tokens: int | None = Field(None, ge=1, le=131_072)
    message: str = Field("", max_length=4000, description="optional wording, used only for the complexity signals")


@router.post("/router/preview")
def preview(request: Request, body: PreviewIn) -> dict[str, Any]:
    text = body.message or "x" * body.input_chars
    req = LLMRequest(
        task=body.task,
        messages=[{"role": "user", "content": text}],
        images=[("image/png", b"")] * body.images,
        audio=("audio.webm", b"\0" * int(body.audio_mb * 1_048_576)) if body.audio_mb else None,
        structured=body.structured,
        schema={"type": "object"} if body.structured in ("schema", "strict") else None,
        tools=[{"type": "function", "function": {"name": f"t{i}"}} for i in range(body.tools)] or None,
        parallel_tools=body.parallel_tools,
        max_output_tokens=body.max_output_tokens,
    )
    return _router(request).select_model(req).as_dict()


@router.post("/router/discover")
async def discover(request: Request) -> dict[str, Any]:
    r = _router(request)
    ok = await r.discover_models(force=True)
    return {"ok": ok, "error": r.catalog.discovery_error, "at": r.catalog.discovered_iso}
