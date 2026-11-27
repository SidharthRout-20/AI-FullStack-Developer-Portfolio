"""/api/tara/edits: the owner asks Tara to change the code; Tara plans it and proposes it as a pull request.

Owner only (X-Tara-Owner-Key). Off until TARA_OWNER_KEY, TARA_GITHUB_TOKEN and TARA_REPO are set on the backend.
See app/keeper/edits.py for the whole flow; nothing here can merge anything.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app.keeper.edits import EditError, Edits
from appcore.security import limiter

router = APIRouter(prefix="/api/tara/edits", tags=["tara"])
OwnerKey = Annotated[str | None, Header(alias="X-Tara-Owner-Key")]


class PlanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request: str = Field(min_length=8, max_length=2000)


class PlanBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    request: str = Field(max_length=2000)
    size: Literal["small", "large"]
    edits: list[dict[str, Any]] = Field(default_factory=list, max_length=8)
    issued: int
    token: str = Field(max_length=128)


def _edits(request: Request, key: str | None) -> Edits:
    edits: Edits | None = getattr(request.app.state, "edits", None)
    if edits is None or not edits.ready:
        raise HTTPException(
            503, "Code proposals are off on this server: set TARA_OWNER_KEY, TARA_GITHUB_TOKEN and TARA_REPO."
        )
    if not edits.is_owner(key):
        raise HTTPException(403, "Only the owner can ask Tara to change the code.")
    return edits


@router.get("/status")
async def status(request: Request, key: OwnerKey = None) -> dict[str, Any]:
    edits: Edits | None = getattr(request.app.state, "edits", None)
    enabled = bool(edits and edits.ready)
    if not enabled or not edits.is_owner(key):  # type: ignore[union-attr]
        return {"enabled": enabled, "owner": False, "open": None}
    try:
        return {"enabled": True, "owner": True, "open": await edits.open_proposal()}  # type: ignore[union-attr]
    except EditError as exc:
        return {"enabled": True, "owner": True, "open": None, "error": str(exc)}


@router.post("/plan")
@limiter.limit("20/day")
async def plan(request: Request, body: PlanIn, key: OwnerKey = None) -> dict[str, Any]:
    _proposals_on(request)
    return await _edits(request, key).plan(body.request.strip())


def _proposals_on(request: Request) -> None:
    from app.control import current

    if not current(request).tara.code_proposals:
        raise HTTPException(503, "Code proposals are turned off in the control room.")


@router.post("/propose")
@limiter.limit("10/day")
async def propose(request: Request, body: PlanBody, key: OwnerKey = None) -> dict[str, Any]:
    _proposals_on(request)
    try:
        return await _edits(request, key).propose(body.model_dump())
    except EditError as exc:
        raise HTTPException(409, str(exc)) from exc
