"""Sign-in with Neon Auth: tokens are checked against the project's public keys, and a browser's trips move into the
account. Keys and tokens are made here; Neon is never called."""

from __future__ import annotations

import base64
import json
import time

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey

from appcore.accounts import Accounts, SignInError, accounts_from
from safarnama.main import create_app
from tests.conftest import FakeTools, ScriptedLLM, parse_sse

BASE = "https://ep-test.neonauth.us-east-1.aws.neon.tech/neondb/auth"
KEY = SigningKey.generate()
OTHER = SigningKey.generate()


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def jwks(url: str) -> dict:
    assert url == f"{BASE}/.well-known/jwks.json"
    return {"keys": [{"kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "kid": "k1", "x": b64(bytes(KEY.verify_key))}]}


def token(sub: str = "user-1", *, key: SigningKey = KEY, kid: str = "k1", exp: float | None = None, **claims) -> str:
    head = b64(json.dumps({"alg": "EdDSA", "kid": kid, "typ": "JWT"}).encode())
    body = {"sub": sub, "iss": "https://ep-test.neonauth.us-east-1.aws.neon.tech", "exp": exp or time.time() + 900}
    body = b64(json.dumps({**body, **claims}).encode())
    sig = key.sign(f"{head}.{body}".encode()).signature
    return f"{head}.{body}.{b64(sig)}"


def test_tokens_are_checked_against_the_projects_keys():
    a = Accounts(BASE, fetch=jwks)
    assert a.user_id(token()) == "user-1"
    for bad in (
        token(key=OTHER),  # signed by someone else
        token(exp=time.time() - 3600),  # expired
        token(iss="https://evil.example"),  # another issuer
        token(kid="unknown"),
        "not.a.token",
        token()[:-4] + "AAAA",  # tampered signature
    ):
        with pytest.raises(SignInError):
            a.user_id(bad)
    assert accounts_from("") is None and accounts_from("  ") is None
    with pytest.raises(ValueError):
        Accounts("http://insecure.example/auth")


@pytest.fixture
def client(settings):
    app = create_app(settings, llm_factory=lambda _: ScriptedLLM(), tools=FakeTools())
    app.state.accounts = Accounts(BASE, fetch=jwks)
    with TestClient(app) as c:
        yield c


def test_signing_in_moves_this_browsers_trips_into_the_account(client):
    c = client
    assert c.get("/api/trips/account").json() == {"enabled": True, "signed_in": False}
    browser = {"X-Trip-Owner": c.post("/api/trips/owner").json()["token"]}
    events = parse_sse(
        c.post("/api/trips/plan", headers=browser, json={"prompt": "2 days in Lisbon from May 1 2030"}).text
    )
    trip_id = events[-1][1]["trip"]["id"]

    signed_in = {**browser, "Authorization": f"Bearer {token()}"}
    assert c.get("/api/trips/account", headers=signed_in).json() == {"enabled": True, "signed_in": True}
    assert c.get("/api/trips", headers=signed_in).json() == []  # not claimed yet…
    assert c.get(f"/api/trips/{trip_id}", headers=signed_in).json()["role"] == "owner"  # …but still editable here

    assert c.post("/api/trips/claim", headers=signed_in).json() == {"moved": 1}
    assert c.post("/api/trips/claim", headers=signed_in).json() == {"moved": 0}  # idempotent

    other_device = {"Authorization": f"Bearer {token()}", "X-Trip-Owner": c.post("/api/trips/owner").json()["token"]}
    assert [t["id"] for t in c.get("/api/trips", headers=other_device).json()] == [trip_id]
    assert c.get(f"/api/trips/{trip_id}", headers=other_device).json()["role"] == "owner"

    someone_else = {"Authorization": f"Bearer {token('user-2')}"}
    assert c.get(f"/api/trips/{trip_id}", headers=someone_else).status_code == 404
    assert c.get(f"/api/trips/{trip_id}", headers=browser).status_code == 404  # signed out: it's the account's now

    expired = c.get("/api/trips", headers={"Authorization": f"Bearer {token(exp=time.time() - 3600)}"})
    assert expired.status_code == 401 and "Sign in again" in expired.json()["detail"]
    assert c.post("/api/trips/claim", headers=browser).status_code == 401


def test_sign_in_is_off_without_neon_auth(app_client):
    assert app_client.get("/api/trips/account").json() == {"enabled": False, "signed_in": False}
    # A bearer token is ignored when sign-in is off, so nothing changes for browsers.
    assert app_client.get("/api/trips", headers={"Authorization": "Bearer whatever"}).json() == []
