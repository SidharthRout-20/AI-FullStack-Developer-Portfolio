"""Failure paths a browser would otherwise misreport: crashes must still carry CORS headers, and a database connection
closed by the server while idle (Neon suspends idle databases) must be replaced instead of failing a request."""

from __future__ import annotations

import time

import psycopg
from fastapi.testclient import TestClient

from app.main import create_app
from appcore import db


def test_an_unexpected_crash_still_answers_with_cors_headers(settings, service_factory):
    app = create_app(settings, service_factory=service_factory)

    @app.get("/api/__boom")
    def boom() -> None:
        raise RuntimeError("something broke")

    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.get("/api/__boom", headers={"Origin": "http://localhost:5173"})
    assert r.status_code == 500
    assert r.json() == {"detail": "Internal server error"}  # no internals leaked
    assert r.headers["access-control-allow-origin"] == "http://localhost:5173"


class FakeConn:
    def __init__(self) -> None:
        self.closed = False
        self.broken = False
        self.dead = False  # the server closed it, but the client hasn't noticed yet

    def execute(self, sql: str):
        if self.dead:
            self.broken = True
            raise psycopg.OperationalError("server closed the connection unexpectedly")
        return self

    def fetchone(self):
        return {"?column?": 1}

    def close(self) -> None:
        self.closed = True


def test_a_connection_dropped_while_idle_is_replaced(monkeypatch):
    made: list[FakeConn] = []

    def connect(*_a, **_k):
        made.append(FakeConn())
        return made[-1]

    monkeypatch.setattr(psycopg, "connect", connect)
    url = "postgresql://example.invalid/test-idle"
    try:
        first = db._pg_connection(url)
        assert db._pg_connection(url) is first  # reused while fresh, no extra round trip
        first.dead = True
        db._pg_used[url] = time.monotonic() - db.PG_IDLE_CHECK_S - 1  # idle for longer than the check interval
        second = db._pg_connection(url)
        assert second is not first and len(made) == 2
        assert first.closed
    finally:
        db._drop_pg(url)
        db._pg_used.pop(url, None)
