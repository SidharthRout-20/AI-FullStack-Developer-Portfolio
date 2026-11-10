"""HTTP-level security controls.

* `SecurityHeadersMiddleware` – pure ASGI middleware (streaming-safe, unlike
  BaseHTTPMiddleware) that adds CSP, nosniff, framing, referrer & HSTS headers.
* `require_admin` – constant-time API-key check for admin endpoints. If no key
  is configured the endpoints answer 404, i.e. they effectively don't exist.
* `limiter` – per-client-IP rate limiting (slowapi) to protect the free LLM quota.
"""

from __future__ import annotations

import secrets

from fastapi import Header, HTTPException, status
from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.config import Settings, get_settings

limiter = Limiter(key_func=get_remote_address, enabled=get_settings().environment != "test")


def rate_limit_value() -> str:
    return get_settings().rate_limit


API_CSP = "default-src 'none'; frame-ancestors 'none'"


def spa_csp(frame_ancestors: str) -> str:
    return "; ".join(
        [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",  # React Flow positions nodes via inline styles
            # blob: → Keeper photo previews; OpenStreetMap → TripWeaver map tiles
            "img-src 'self' data: blob: https://tile.openstreetmap.org",
            "font-src 'self' data:",
            "connect-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            f"frame-ancestors {frame_ancestors}",
        ]
    )


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings
        self._spa_csp = spa_csp(settings.frame_ancestors)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path: str = scope["path"]

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                extra = {
                    b"x-content-type-options": b"nosniff",
                    b"referrer-policy": b"strict-origin-when-cross-origin",
                    # Keeper needs the camera (photos), microphone (voice capture) and location (parking pin).
                    b"permissions-policy": b"camera=(self), microphone=(self), geolocation=(self)",
                    b"cross-origin-opener-policy": b"same-origin",
                }
                if path.startswith("/api"):
                    extra[b"content-security-policy"] = API_CSP.encode()
                    extra[b"cache-control"] = b"no-store"
                elif not path.startswith(("/docs", "/redoc", "/openapi.json")):
                    extra[b"content-security-policy"] = self._spa_csp.encode()
                if self.settings.frame_ancestors == "'none'":
                    extra[b"x-frame-options"] = b"DENY"
                if self.settings.is_production:
                    extra[b"strict-transport-security"] = b"max-age=31536000; includeSubDomains"
                existing = {k.lower() for k, _ in headers}
                headers.extend((k, v) for k, v in extra.items() if k not in existing)
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_with_headers)


def require_admin(x_admin_key: str | None = Header(default=None)) -> None:
    configured = get_settings().admin_api_key
    if configured is None or not configured.get_secret_value():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not Found")
    if not x_admin_key or not secrets.compare_digest(x_admin_key, configured.get_secret_value()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid admin key")
