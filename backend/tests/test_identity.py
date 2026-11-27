"""Each person's Tara is theirs: browsers, signed-in accounts and the site owner never see each other's things."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.identity import browser
from app.main import create_app

A = {"X-Visitor": "browser-a-000000000001"}
B = {"X-Visitor": "browser-b-000000000002"}
OWNER = {"X-Tara-Owner-Key": "owner-key"}


class _Accounts:
    """Neon Auth stand-in: the JWT "good-<id>" verifies as user <id>."""

    def user_id(self, token: str) -> str:
        from appcore.accounts import SignInError

        if not token.startswith("good-"):
            raise SignInError("bad")
        return token[5:]


@pytest.fixture
def app_client(settings, service_factory):
    s = settings.model_copy(update={"tara_owner_key": SecretStr("owner-key")})
    app = create_app(s, service_factory=service_factory)
    with TestClient(app) as c:
        c.app.state.accounts = _Accounts()
        yield c


def _save(c, headers, text):
    return c.post("/api/keeper/entries", json={"kind": "stash", "title": text, "place": "drawer"}, headers=headers)


def titles(c, headers):
    return sorted(e["title"] for e in c.get("/api/keeper/entries", headers=headers).json())


def test_no_identity_no_access(app_client):
    c = app_client
    c.headers.pop("X-Visitor", None)
    assert c.get("/api/keeper/entries").status_code == 401


def test_two_browsers_never_see_each_others_things(app_client):
    c = app_client
    a = _save(c, A, "Passport").json()
    _save(c, B, "Car keys")
    assert titles(c, A) == ["Passport"] and titles(c, B) == ["Car keys"]
    # B can't read, change or delete A's entry even with its id.
    assert c.patch(f"/api/keeper/entries/{a['id']}", json={"place": "stolen"}, headers=B).status_code == 404
    assert c.delete(f"/api/keeper/entries/{a['id']}", headers=B).status_code == 404
    assert titles(c, A) == ["Passport"]
    # Tara's answers come from the caller's things only.
    r = c.post("/api/keeper/command", json={"text": "where are my car keys?"}, headers=A).json()
    assert "drawer" not in r["reply"].lower()


def test_the_owner_keeps_their_data_and_phone_settings(app_client):
    c = app_client
    _save(c, OWNER, "Owner's passport")
    assert titles(c, OWNER) == ["Owner's passport"] and titles(c, A) == []
    body = {"ntfy_topic": "owner-topic-123", "quiet_enabled": False, "brief_push": False}
    assert c.put("/api/keeper/reminders/settings", json=body, headers=OWNER).status_code == 200
    assert c.put("/api/keeper/reminders/settings", json=body, headers=A).status_code == 403  # not the owner's phone
    assert c.post("/api/keeper/reminders/test", headers=A).status_code == 403


def test_signing_in_follows_you_and_can_claim_this_browsers_things(app_client):
    c = app_client
    _save(c, A, "Umbrella")
    user = {"Authorization": "Bearer good-sid", **A}
    assert titles(c, user) == []  # signed in: the account's own (empty) space
    assert c.post("/api/keeper/claim", headers=user).json() == {"moved": 1}
    assert titles(c, user) == ["Umbrella"] and titles(c, A) == []
    other_device = {"Authorization": "Bearer good-sid", "X-Visitor": "another-device-00000001"}
    assert titles(c, other_device) == ["Umbrella"]  # the same account on another device
    assert c.get("/api/keeper/entries", headers={"Authorization": "Bearer forged"}).status_code == 401
    assert c.post("/api/keeper/claim", headers=A).status_code == 401  # claiming needs a signed-in account


def test_visitor_tokens_are_never_stored_raw():
    assert browser("short") is None and browser("x" * 20).startswith("b:") and "x" * 20 not in browser("x" * 20)


def test_codelens_lists_and_deletes_only_your_own_repos(app_client):
    c = app_client
    store = c.app.state.suite.code.db
    mine = store.put("repos", {"owner": "o", "name": "a", "files": [], "edges": [], "languages": {}, "chunks": 0,
                               "tenants": [__import__("app.identity").identity.browser(A["X-Visitor"])]})  # fmt: skip
    legacy = store.put("repos", {"owner": "o", "name": "old", "files": [], "edges": [], "languages": {}, "chunks": 0})
    assert [r["name"] for r in c.get("/api/code/repos", headers=A).json()] == ["a"]
    assert c.get("/api/code/repos", headers=B).json() == []
    assert [r["name"] for r in c.get("/api/code/repos", headers=OWNER).json()] == ["old"]  # made before identities
    assert c.get(f"/api/code/repos/{mine['id']}", headers=B).status_code == 200  # a share link opens for anyone
    assert c.delete(f"/api/code/repos/{mine['id']}", headers=B).status_code == 404  # but only its owner can delete it
    assert c.delete(f"/api/code/repos/{legacy['id']}", headers=A).status_code == 404
    assert c.delete(f"/api/code/repos/{mine['id']}", headers=A).status_code == 204


def test_labs_apps_are_paused_until_they_have_per_person_data(app_client):
    assert app_client.get("/api/flows").status_code == 503


def test_signing_in_brings_this_browsers_repos_along(app_client):
    c = app_client
    store = c.app.state.suite.code.db
    from app.identity import browser as b

    store.put("repos", {"owner": "o", "name": "mine", "files": [], "edges": [], "languages": {}, "chunks": 0,
                        "tenants": [b(A["X-Visitor"])]})  # fmt: skip
    user = {"Authorization": "Bearer good-sid", **A}
    assert c.post("/api/code/claim", headers=user).json() == {"moved": 1}
    assert [r["name"] for r in c.get("/api/code/repos", headers={"Authorization": "Bearer good-sid"}).json()] == [
        "mine"
    ]
    assert c.post("/api/code/claim", headers=A).status_code == 401
