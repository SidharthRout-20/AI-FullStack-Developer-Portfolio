"""Who is calling: one identity for every product, so each person's data is theirs alone.

In order of precedence:

1. **The site owner**: a valid owner key (`X-Tara-Owner-Key`). Their Tara data is the one tied to the phone reminders
   (and every entry made before identities existed).
2. **A signed-in account**: Google (or an emailed link) through Neon Auth, sent as `Authorization: Bearer <JWT>` and
   verified against Neon's public keys (`appcore.accounts`). The same data on every device.
3. **A browser**: a random token the browser makes once and sends as `X-Visitor`. Anonymous, private to that browser.

Only hashes are used as ids; tokens, JWTs and user ids are never stored. Nothing in a request body can choose who
you are.
"""

from __future__ import annotations

import hashlib
import re
import secrets
from typing import Annotated

from fastapi import Header, HTTPException, Request

from appcore.accounts import SignInError

VISITOR = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
OWNER = "owner"


def _hash(kind: bytes, value: str) -> str:
    return hashlib.sha256(kind + b"|" + value.encode()).hexdigest()[:40]


def account(request: Request, authorization: str | None) -> str | None:
    """The signed-in account's id ("u:…"), None when not signed in; 401 for a token that doesn't verify."""
    accounts = getattr(request.app.state, "accounts", None)
    if not accounts or not authorization or not authorization.lower().startswith("bearer "):
        return None
    try:
        return "u:" + _hash(b"site-user", accounts.user_id(authorization[7:].strip()))
    except SignInError:
        raise HTTPException(401, "Your sign-in has expired. Sign in again.") from None


def is_owner(request: Request, key: str | None) -> bool:
    settings = getattr(getattr(request.app.state, "keeper", None), "settings", None)
    want = settings.tara_owner_key.get_secret_value() if settings and getattr(settings, "tara_owner_key", None) else ""
    return bool(want and key and secrets.compare_digest(key, want))


def browser(token: str | None) -> str | None:
    return "b:" + _hash(b"site-visitor", token) if token and VISITOR.match(token) else None


def tenant(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    x_visitor: Annotated[str | None, Header()] = None,
    x_tara_owner_key: Annotated[str | None, Header()] = None,
) -> str:
    """Whose data this request reads and writes."""
    if is_owner(request, x_tara_owner_key):
        return OWNER
    if who := account(request, authorization) or browser(x_visitor):
        return who
    raise HTTPException(401, "Missing visitor identity: reload the page.")
