"""Free phone delivery for Keeper: ntfy push notifications and Telegram, plus signed one-tap action links.

ntfy (https://ntfy.sh) needs no account: install the app, subscribe to a hard-to-guess topic, done.
Action links carry an HMAC-signed token, so "Done" / "Snooze" work from a phone without logging in,
and only for that one alert.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
from typing import Any

import httpx

ACTIONS = ("done", "snooze", "ack")
TOKEN_TTL_S = 3 * 24 * 3600


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sign(secret: bytes, entry_id: str, key: str, now: float | None = None) -> str:
    payload = f"{entry_id}|{key}|{int((now or time.time()) + TOKEN_TTL_S)}".encode()
    mac = hmac.new(secret, payload, hashlib.sha256).digest()[:18]
    return f"{_b64(payload)}.{_b64(mac)}"


def verify(secret: bytes, token: str, now: float | None = None) -> tuple[str, str] | None:
    """(entry_id, alert key) for a valid, unexpired token; otherwise None."""
    try:
        body, mac = token.split(".", 1)
        payload = _unb64(body)
        expected = hmac.new(secret, payload, hashlib.sha256).digest()[:18]
        if not hmac.compare_digest(expected, _unb64(mac)):
            return None
        entry_id, key, exp = payload.decode().split("|")
        if int(exp) < (now or time.time()):
            return None
        return entry_id, key
    except (ValueError, UnicodeDecodeError):
        return None


async def send_ntfy(
    client: httpx.AsyncClient, server: str, topic: str, title: str, message: str, *,
    urgent: bool = False, actions: list[dict[str, Any]] | None = None,
) -> None:  # fmt: skip
    r = await client.post(
        server.rstrip("/"),
        json={
            "topic": topic,
            "title": title,
            "message": message,
            "priority": 5 if urgent else 4,
            "tags": ["rotating_light" if urgent else "alarm_clock"],
            "actions": actions or [],
        },
    )
    r.raise_for_status()


async def send_telegram(
    client: httpx.AsyncClient, token: str, chat_id: str, text: str, buttons: list[tuple[str, str]] | None = None
) -> None:
    body: dict[str, Any] = {"chat_id": chat_id, "text": text}
    if buttons:
        body["reply_markup"] = {"inline_keyboard": [[{"text": label, "url": url} for label, url in buttons]]}
    r = await client.post(f"https://api.telegram.org/bot{token}/sendMessage", json=body)
    r.raise_for_status()
