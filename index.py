"""Vercel entry point: exposes the FastAPI app that lives in backend/app.

Named `index.py` (not `app.py`) so it can't shadow the `app` package it imports.
Serverless functions only have a writable /tmp and don't keep running between requests, so on Vercel
the data dir and every library cache move to /tmp and the background document watcher is off
(documents are indexed at startup).
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

if os.environ.get("VERCEL"):  # /tmp is the only writable directory on Vercel
    os.environ.setdefault("DATA_DIR", "/tmp/portfolio-data")  # noqa: S108
    os.environ.setdefault("WATCH_DOCUMENTS", "false")
    os.environ.setdefault("SERVE_FRONTEND", "false")
    os.environ.setdefault("ENVIRONMENT", "production")
    # The home directory is read-only on Vercel. Hugging Face (used by fastembed to download the
    # embedding model) writes its cache and xet logs under HF_HOME (~/.cache/huggingface by default);
    # if that isn't writable the download fails, startup raises, and every request crashes.
    os.environ.setdefault("HF_HOME", "/tmp/hf-home")  # noqa: S108
    os.environ.setdefault("XDG_CACHE_HOME", "/tmp/cache")  # noqa: S108
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

logger = logging.getLogger("startup")
RETRY_AFTER_S = 60.0


def _describe(exc: BaseException) -> str:
    """A short, safe description of a startup failure (never echoes setting values, which may be secrets)."""
    errors = getattr(exc, "errors", None)
    if callable(errors):  # pydantic ValidationError: name the bad settings, not their values
        try:
            fields = [f"{'.'.join(str(p) for p in e['loc']).upper()}: {e['msg']}" for e in errors()]
        except Exception:  # pragma: no cover - not a pydantic error after all
            fields = []
        if fields:
            return "Invalid environment variable(s): " + "; ".join(fields)
    return f"{type(exc).__name__}: {str(exc)[:300]}"


class _GuardedApp:
    """Runs the app's startup exactly once, whether or not the platform sends ASGI lifespan events.

    If the import or startup fails, every request gets a 503 JSON response naming the cause (the full
    traceback goes to the function logs) instead of the function crashing with FUNCTION_INVOCATION_FAILED.
    A failed startup is retried after RETRY_AFTER_S, so a transient problem (e.g. a network blip while
    downloading the model) recovers without a redeploy.
    """

    def __init__(self) -> None:
        self.app: Any = None
        self._stack: AsyncExitStack | None = None
        self._error: str | None = None
        self._failed_at = 0.0
        self._lock: asyncio.Lock | None = None

    async def _start(self) -> None:
        if self._stack is not None or (self._error and time.monotonic() - self._failed_at < RETRY_AFTER_S):
            return
        self._lock = self._lock or asyncio.Lock()
        async with self._lock:
            if self._stack is not None:
                return
            stack = AsyncExitStack()
            try:
                if self.app is None:
                    from app.main import app

                    self.app = app
                await stack.enter_async_context(self.app.router.lifespan_context(self.app))
            except Exception as exc:
                logging.basicConfig(level=logging.INFO)
                logger.exception("Backend startup failed")
                self._error, self._failed_at = _describe(exc), time.monotonic()
                await stack.aclose()
                return
            self._stack, self._error = stack, None

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await self._start()
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    if self._stack is not None:
                        await self._stack.aclose()
                    await send({"type": "lifespan.shutdown.complete"})
                    return

        await self._start()
        if self._stack is None:
            await self._unavailable(scope, send)
            return
        await self.app(scope, receive, send)

    async def _unavailable(self, scope: dict[str, Any], send: Any) -> None:
        if scope["type"] != "http":  # websockets: just refuse
            await send({"type": "websocket.close", "code": 1011})
            return
        import json

        body = json.dumps({"status": "error", "detail": "Backend failed to start", "cause": self._error}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 503,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"cache-control", b"no-store"),
                    (b"retry-after", str(int(RETRY_AFTER_S)).encode()),
                    # Let the browser show this error to the frontend instead of a misleading CORS failure.
                    (b"access-control-allow-origin", b"*"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


app = _GuardedApp()

__all__ = ["app"]
