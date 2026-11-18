"""Errors that reach the browser as what they are."""

from __future__ import annotations

import logging
from typing import Any

from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)


class ErrorsAsJSON:
    """Turn an unhandled exception into a JSON 500 inside the middleware stack (FastAPI's own Exception handler runs
    outside CORS, so its responses carry no Access-Control headers). Errors after the response started are re-raised."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def tracked(message: Any) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, tracked)
        except Exception:
            if started:
                raise
            logger.exception("Unhandled error")
            await JSONResponse({"detail": "Internal server error"}, status_code=500)(scope, receive, send)
