"""Free-tier quota tracking from Groq's rate-limit headers.

Groq documents (console.groq.com/docs/rate-limits):
  x-ratelimit-limit-requests / -remaining-requests / -reset-requests  → requests per DAY (RPD)
  x-ratelimit-limit-tokens   / -remaining-tokens   / -reset-tokens    → tokens per MINUTE (TPM)
  retry-after (seconds)                                              → only on HTTP 429
Limits are per organisation and per model, so state is kept per model. Nothing is claimed as "remaining" unless the
provider reported it; without headers the state is "unknown" and the router proceeds conservatively.

Capacity reservation: lower-priority work may not spend the last fraction of a model's daily requests, so EFI
investigations (priority 1) and TripWeaver's user-facing workflows (priority 2) aren't starved by background jobs.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

_DURATION = re.compile(r"(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$")


def parse_duration(value: str | None) -> float | None:
    """Groq reset values look like "2m59.56s", "7.66s", "1h0m0s" or "300ms". Plain numbers are seconds."""
    if not value:
        return None
    v = value.strip()
    try:
        return max(0.0, float(v))
    except ValueError:
        pass
    m = _DURATION.match(v)
    if not m or not any(m.groups()):
        return None
    h, mi, s, ms = (float(x) if x else 0.0 for x in m.groups())
    return h * 3600 + mi * 60 + s + ms / 1000


def _int(v: str | None) -> int | None:
    try:
        return int(float(v)) if v not in (None, "") else None
    except ValueError:
        return None


@dataclass
class ModelQuota:
    limit_requests: int | None = None  # RPD
    remaining_requests: int | None = None
    requests_reset_at: float | None = None  # monotonic
    limit_tokens: int | None = None  # TPM
    remaining_tokens: int | None = None
    tokens_reset_at: float | None = None
    cooldown_until: float | None = None  # after a 429
    rate_limited: int = 0
    updated_at: float | None = None
    source: str = "unknown"  # "headers" once Groq has reported real values


class QuotaTracker:
    def __init__(self, reserve: Mapping[int, float], clock: Callable[[], float] = time.monotonic) -> None:
        self.reserve = dict(reserve)  # priority → fraction of RPD that must stay free for higher priorities
        self.clock = clock
        self.models: dict[str, ModelQuota] = {}

    def _q(self, model: str) -> ModelQuota:
        return self.models.setdefault(model, ModelQuota())

    def update(self, model: str, headers: Mapping[str, str] | None) -> None:
        if not headers:
            return
        h = {k.lower(): v for k, v in headers.items()}
        if not any(k.startswith("x-ratelimit-") for k in h):
            return
        q, now = self._q(model), self.clock()
        for attr, key in (("limit_requests", "limit-requests"), ("remaining_requests", "remaining-requests"),
                          ("limit_tokens", "limit-tokens"), ("remaining_tokens", "remaining-tokens")):  # fmt: skip
            if (val := _int(h.get(f"x-ratelimit-{key}"))) is not None:
                setattr(q, attr, val)
        if (r := parse_duration(h.get("x-ratelimit-reset-requests"))) is not None:
            q.requests_reset_at = now + r
        if (r := parse_duration(h.get("x-ratelimit-reset-tokens"))) is not None:
            q.tokens_reset_at = now + r
        q.updated_at, q.source = now, "headers"

    def rate_limited(self, model: str, retry_after: float | None, headers: Mapping[str, str] | None) -> float:
        """Record a 429; returns the cool-down applied (Retry-After when given, else a conservative 30 s)."""
        self.update(model, headers)
        q = self._q(model)
        wait = retry_after if retry_after is not None and retry_after >= 0 else 30.0
        q.cooldown_until = self.clock() + wait
        q.rate_limited += 1
        return wait

    def _refresh(self, q: ModelQuota, now: float) -> None:
        if q.tokens_reset_at is not None and now >= q.tokens_reset_at:
            q.remaining_tokens, q.tokens_reset_at = q.limit_tokens, None
        if q.requests_reset_at is not None and now >= q.requests_reset_at:
            q.remaining_requests, q.requests_reset_at = q.limit_requests, None
        if q.cooldown_until is not None and now >= q.cooldown_until:
            q.cooldown_until = None

    def can_serve(self, model: str, est_tokens: int, priority: int) -> tuple[bool, str, float | None]:
        """(ok, reason, seconds until it could serve). Unknown quota is allowed (and reported as unknown)."""
        q, now = self._q(model), self.clock()
        self._refresh(q, now)
        if q.cooldown_until is not None:
            return False, "rate-limited by Groq (cooling down per Retry-After)", q.cooldown_until - now
        if q.remaining_requests is not None and q.limit_requests:
            floor = q.limit_requests * self.reserve.get(priority, 0.0)
            if q.remaining_requests <= 0:
                return False, "daily request quota exhausted", _left(q.requests_reset_at, now)
            if q.remaining_requests - 1 < floor:
                return (
                    False,
                    f"remaining daily requests reserved for priority < {priority}",
                    _left(q.requests_reset_at, now),
                )
        if q.remaining_tokens is not None and q.tokens_reset_at is not None and est_tokens > q.remaining_tokens:
            return False, "tokens-per-minute budget too low for this request", _left(q.tokens_reset_at, now)
        return True, "quota ok" if q.source == "headers" else "quota unknown (no headers yet)", None

    def headroom(self, model: str) -> float | None:
        q = self.models.get(model)
        if not q or q.remaining_requests is None or not q.limit_requests:
            return None
        return max(0.0, min(1.0, q.remaining_requests / q.limit_requests))

    def snapshot(self) -> dict[str, dict[str, Any]]:
        now = self.clock()
        out = {}
        for m, q in self.models.items():
            self._refresh(q, now)
            out[m] = {
                "source": q.source,
                "requests_per_day": {"limit": q.limit_requests, "remaining": q.remaining_requests,
                                     "resets_in_s": _left(q.requests_reset_at, now)},
                "tokens_per_minute": {"limit": q.limit_tokens, "remaining": q.remaining_tokens,
                                      "resets_in_s": _left(q.tokens_reset_at, now)},
                "cooldown_s": _left(q.cooldown_until, now),
                "rate_limited_count": q.rate_limited,
            }  # fmt: skip
        return out


def _left(at: float | None, now: float) -> float | None:
    return None if at is None else round(max(0.0, at - now), 1)
