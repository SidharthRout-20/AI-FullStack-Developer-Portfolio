"""Portfolio contact form: validated, rate-limited, spam-trapped, stored locally, optionally pinged to Telegram.

Messages are read back only with the admin key (`GET /api/contact`, header `X-Admin-Key`).
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from appcore.docstore import DocStore
from appcore.guardrails import normalize
from appcore.security import limiter, require_admin

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/contact", tags=["portfolio"])


class ContactIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=2, max_length=80)
    email: str = Field(max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")
    message: str = Field(min_length=10, max_length=3000)
    website: str = Field("", max_length=200)  # honeypot: humans never see this field

    @field_validator("name", "message")
    @classmethod
    def _clean(cls, v: str) -> str:
        return normalize(v).strip()


def get_inbox(request: Request) -> DocStore:
    return request.app.state.suite.inbox


Inbox = Annotated[DocStore, Depends(get_inbox)]


@router.post("", status_code=202)
@limiter.limit("3/minute")
async def send(request: Request, body: ContactIn, inbox: Inbox) -> dict[str, str]:
    if body.website:  # bot filled the hidden field: pretend success, store nothing
        return {"status": "received"}
    inbox.put("messages", {"name": body.name, "email": body.email, "message": body.message})
    settings = request.app.state.suite.settings
    if settings.telegram_bot_token and settings.telegram_chat_id:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    f"https://api.telegram.org/bot{settings.telegram_bot_token.get_secret_value()}/sendMessage",
                    json={
                        "chat_id": settings.telegram_chat_id,
                        "text": f"Portfolio message from {body.name} <{body.email}>\n\n{body.message}",
                    },
                )
        except httpx.HTTPError:
            logger.warning("Contact notification to Telegram failed (message is still stored)")
    return {"status": "received"}


@router.get("", dependencies=[Depends(require_admin)])
def inbox_list(inbox: Inbox) -> list[dict[str, Any]]:
    return inbox.list("messages", limit=200)
