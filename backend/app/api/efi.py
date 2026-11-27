"""EFI API: Engineering Failure Investigator.

Identity: this portfolio has no user accounts. Following the existing header-key convention (`X-Keeper-Key`,
`X-Admin-Key`), EFI issues each browser an unguessable owner token (`POST /api/efi/owner`) and the client sends it
as `X-EFI-Owner`. The server only ever uses `sha256(token)` as the owner id; it never accepts an owner or user id
from a request body, and every query filters on it, so one owner's investigations are invisible (404) to others.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.efi.parsers import ArtifactError
from app.efi.reasoning import EFIModelError, EFIQuotaError
from app.efi.service import BusyError, EFIService, LimitError, NotFoundError
from app.efi.store import ConflictError
from app.identity import account
from appcore.llm.chat import LLMNotConfiguredError
from appcore.security import limiter

router = APIRouter(prefix="/api/efi", tags=["efi"])
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
_ID = re.compile(r"^[0-9a-f]{32}$")


def get_efi(request: Request) -> EFIService:
    return request.app.state.efi


def owner_id(
    request: Request,
    x_efi_owner: Annotated[str | None, Header()] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> str:
    """Signed in: your account (the same investigations on every device). Otherwise this browser's owner token."""
    if who := account(request, authorization):
        get_efi(request).maybe_purge()
        return hashlib.sha256(b"efi-account|" + who.encode()).hexdigest()
    if not x_efi_owner or not _TOKEN.match(x_efi_owner):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing or invalid EFI owner token (X-EFI-Owner).")
    get_efi(request).maybe_purge()
    return hashlib.sha256(b"efi-owner|" + x_efi_owner.encode()).hexdigest()


EFI = Annotated[EFIService, Depends(get_efi)]
Owner = Annotated[str, Depends(owner_id)]


def _inv_id(inv_id: str) -> str:
    if not _ID.match(inv_id):
        raise HTTPException(404, "Investigation not found.")
    return inv_id


class ArtifactIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    kind: Literal["log", "stacktrace", "diff", "junit", "manifest", "config", "notes"] | None = None
    content: str


class CreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(None, max_length=120)
    notes: str | None = Field(None, max_length=4000)
    artifacts: list[ArtifactIn] = Field(min_length=1, max_length=50)


class FeedbackIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outcome: Literal["confirmed", "none_correct"]
    hypothesis_id: str | None = Field(None, pattern=r"^H[1-5]$")
    note: str | None = Field(None, max_length=1000)


@router.post("/owner", status_code=201)
@limiter.limit("10/minute")
def new_owner(request: Request) -> dict[str, str]:
    """A fresh, unguessable owner token for this browser (store it; it is the only key to the history)."""
    return {"token": secrets.token_urlsafe(32)}


@router.get("/limits")
def limits(svc: EFI) -> dict[str, Any]:
    return svc.limits()


@router.post("/investigations", status_code=201)
@limiter.limit("20/minute")
async def create(request: Request, svc: EFI, owner: Owner) -> dict[str, Any]:
    cap = svc.settings.efi_max_request_bytes
    if int(request.headers.get("content-length") or 0) > cap:
        raise HTTPException(413, f"The request is larger than {cap // 1000} KB. Upload fewer or smaller artifacts.")
    body = await request.body()
    if len(body) > cap:
        raise HTTPException(413, f"The request is larger than {cap // 1000} KB. Upload fewer or smaller artifacts.")
    try:
        payload = CreateIn.model_validate(json.loads(body or b"{}"))
    except (ValueError, ValidationError) as exc:
        first = exc.errors()[0] if isinstance(exc, ValidationError) and exc.errors() else None
        where = ".".join(str(p) for p in first["loc"]) if first else ""
        msg = (
            f"Invalid input{f' ({where})' if where else ''}: {first['msg']}"
            if first
            else "The request is not valid JSON."
        )
        raise HTTPException(422, msg) from None
    try:
        return svc.create(owner, payload.title, payload.notes, [a.model_dump() for a in payload.artifacts])
    except ArtifactError as exc:
        raise HTTPException(422, str(exc)) from None


@router.get("/investigations")
def list_investigations(svc: EFI, owner: Owner) -> list[dict[str, Any]]:
    return svc.list(owner)


@router.get("/investigations/{inv_id}")
def get_investigation(inv_id: str, svc: EFI, owner: Owner) -> dict[str, Any]:
    try:
        return svc.get(owner, _inv_id(inv_id))
    except NotFoundError:
        raise HTTPException(404, "Investigation not found.") from None


@router.delete("/investigations/{inv_id}", status_code=204)
def delete_investigation(inv_id: str, svc: EFI, owner: Owner) -> None:
    try:
        svc.delete(owner, _inv_id(inv_id))
    except NotFoundError:
        raise HTTPException(404, "Investigation not found.") from None


@router.post("/investigations/{inv_id}/analyze")
@limiter.limit("6/minute")
async def analyze(request: Request, inv_id: str, svc: EFI, owner: Owner) -> dict[str, Any]:
    try:
        return await svc.analyse(owner, _inv_id(inv_id))
    except NotFoundError:
        raise HTTPException(404, "Investigation not found.") from None
    except (BusyError, ConflictError):
        raise HTTPException(409, "This investigation is already being analysed. Refresh in a moment.") from None
    except (EFIQuotaError, LimitError) as exc:
        headers = {"Retry-After": str(int(exc.retry_after))} if getattr(exc, "retry_after", None) else None
        raise HTTPException(429, str(exc), headers=headers) from None
    except (EFIModelError, LLMNotConfiguredError) as exc:
        raise HTTPException(503, str(exc)) from None


@router.post("/investigations/{inv_id}/feedback")
def feedback(inv_id: str, body: FeedbackIn, svc: EFI, owner: Owner) -> dict[str, Any]:
    try:
        return svc.feedback(owner, _inv_id(inv_id), body.outcome, body.hypothesis_id, body.note)
    except NotFoundError:
        raise HTTPException(404, "Investigation not found.") from None
    except ConflictError:
        raise HTTPException(409, "The investigation changed meanwhile. Reload and try again.") from None
    except ArtifactError as exc:
        raise HTTPException(422, str(exc)) from None


@router.get("/investigations/{inv_id}/artifacts/{artifact_id}")
def artifact_context(
    inv_id: str,
    artifact_id: str,
    svc: EFI,
    owner: Owner,
    line: Annotated[int, Query(ge=1, le=10_000_000)] = 1,
    radius: Annotated[int, Query(ge=0, le=40)] = 12,
) -> dict[str, Any]:
    """Redacted lines around an evidence location, while the raw artifact is still retained."""
    try:
        svc.get(owner, _inv_id(inv_id))
    except NotFoundError:
        raise HTTPException(404, "Investigation not found.") from None
    if not re.fullmatch(r"A\d{1,2}", artifact_id):
        raise HTTPException(404, "Artifact not found.")
    try:
        return svc.artifact_lines(owner, inv_id, artifact_id, line, radius)
    except NotFoundError:
        raise HTTPException(
            410,
            "The raw artifact is no longer available (retention period ended or it was deleted). "
            "The report still contains the evidence snippet.",
        ) from None
