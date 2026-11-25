"""Signed-in users, from Neon Auth (managed Better Auth).

The browser signs in with Neon Auth (Google or an emailed link) and sends the short-lived JWT it gets from it as
`Authorization: Bearer <jwt>`. This checks that token against the public keys Neon publishes for the project
(`<NEON_AUTH_BASE_URL>/.well-known/jwks.json`, Ed25519) and returns the user's ID (`sub`). No secrets are needed, and
nothing about the user beyond that ID is kept.

Off when NEON_AUTH_BASE_URL is unset: the apps then work exactly as before, with per-browser owner tokens.
"""

from __future__ import annotations

import base64
import json
import logging
import threading
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

import httpx
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

logger = logging.getLogger(__name__)

KEYS_TTL_S = 3600.0  # Neon rotates keys rarely; an unknown key ID refreshes sooner (see _key)
REFETCH_MIN_S = 60.0  # at most one refresh a minute for unknown key IDs, so bad tokens can't hammer Neon
LEEWAY_S = 30  # clock skew allowed on exp / nbf / iat


class SignInError(Exception):
    """The token was present but isn't a valid, current Neon Auth token for this project."""


def _b64(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


class Accounts:
    def __init__(self, base_url: str, fetch: Callable[[str], dict[str, Any]] | None = None) -> None:
        self.base_url = base_url.strip().rstrip("/")
        parts = urlsplit(self.base_url)
        if parts.scheme != "https" or not parts.netloc:
            raise ValueError("NEON_AUTH_BASE_URL must be an https URL")
        self.origin = f"{parts.scheme}://{parts.netloc}"
        self.jwks_url = f"{self.base_url}/.well-known/jwks.json"
        self._fetch = fetch or self._http_get
        self._keys: dict[str, VerifyKey] = {}
        self._fetched_at = 0.0
        self._lock = threading.Lock()

    @staticmethod
    def _http_get(url: str) -> dict[str, Any]:
        r = httpx.get(url, timeout=10.0, headers={"Accept": "application/json"})
        r.raise_for_status()
        return r.json()

    def _refresh(self) -> None:
        keys: dict[str, VerifyKey] = {}
        for k in self._fetch(self.jwks_url).get("keys", []):
            if k.get("kty") == "OKP" and k.get("crv") == "Ed25519" and k.get("kid") and k.get("x"):
                keys[str(k["kid"])] = VerifyKey(_b64(str(k["x"])))
        self._keys, self._fetched_at = keys, time.monotonic()

    def _key(self, kid: str) -> VerifyKey | None:
        with self._lock:
            age = time.monotonic() - self._fetched_at
            if not self._keys or age > KEYS_TTL_S or (kid not in self._keys and age > REFETCH_MIN_S):
                try:
                    self._refresh()
                except Exception as exc:  # Neon unreachable: keep the keys we had
                    logger.warning("Couldn't fetch the Neon Auth signing keys: %s", type(exc).__name__)
            return self._keys.get(kid)

    def user_id(self, token: str, now: float | None = None) -> str:
        """The signed-in user's ID, or SignInError. Never logs the token."""
        try:
            head_b64, body_b64, sig_b64 = token.split(".")
            head = json.loads(_b64(head_b64))
            body = json.loads(_b64(body_b64))
            sig = _b64(sig_b64)
        except Exception as exc:
            raise SignInError("Malformed sign-in token.") from exc
        if head.get("alg") != "EdDSA" or not isinstance(head.get("kid"), str):
            raise SignInError("Unexpected sign-in token type.")
        key = self._key(head["kid"])
        if key is None:
            raise SignInError("Unknown sign-in key.")
        try:
            key.verify(f"{head_b64}.{body_b64}".encode(), sig)
        except BadSignatureError as exc:
            raise SignInError("Invalid sign-in token.") from exc
        now = time.time() if now is None else now
        if not isinstance(body.get("exp"), int | float) or body["exp"] < now - LEEWAY_S:
            raise SignInError("Your sign-in has expired.")
        if isinstance(body.get("nbf"), int | float) and body["nbf"] > now + LEEWAY_S:
            raise SignInError("Sign-in token not valid yet.")
        # The signature already ties the token to this project's keys; the issuer must also be this auth host.
        iss = body.get("iss")
        if iss is not None and urlsplit(str(iss)).netloc != urlsplit(self.origin).netloc:
            raise SignInError("Sign-in token from another issuer.")
        sub = body.get("sub")
        if not isinstance(sub, str) or not sub or len(sub) > 200:
            raise SignInError("Sign-in token without a user.")
        return sub


def accounts_from(base_url: str | None) -> Accounts | None:
    """The verifier for NEON_AUTH_BASE_URL, or None (sign-in off) when it's unset."""
    return Accounts(base_url) if base_url and base_url.strip() else None
