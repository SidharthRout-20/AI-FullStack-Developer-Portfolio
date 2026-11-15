"""Secret redaction for EFI artifacts.

Runs on every artifact (and the user's notes) BEFORE anything is stored or sent to the model. Two kinds of rules:

* **Token rules**: credentials with a recognisable shape (AWS key ids, GitHub / GitLab / Slack / Stripe / Google /
  Groq / OpenAI / Anthropic / npm tokens, JWTs, PEM private keys) are replaced wherever they appear.
* **Context rules**: values next to a secret-looking name (`password=…`, `API_KEY: …`, `Authorization: Bearer …`,
  `postgres://user:pass@host`) have only the value replaced, so the log stays readable.

After redaction the token rules are run again; if anything still matches, the artifact is rejected
(`RedactionError`) instead of being processed. Raw secrets are never logged.
"""

from __future__ import annotations

import re
from collections import Counter

MASK = "[REDACTED:{}]"

_TOKEN_RULES: list[tuple[str, re.Pattern[str]]] = [
    (
        "private_key",
        re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\Z)", re.S),
    ),
    ("aws_access_key_id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b")),
    ("gitlab_token", re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}\b")),
    ("slack_token", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}\b")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("stripe_key", re.compile(r"\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b")),
    ("groq_api_key", re.compile(r"\bgsk_[A-Za-z0-9]{20,}\b")),
    ("anthropic_api_key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b")),
    ("openai_api_key", re.compile(r"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b")),
    ("npm_token", re.compile(r"\bnpm_[A-Za-z0-9]{36}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
]

# `scheme://user:password@host` → keep everything except the password.
_URL_CREDENTIALS = re.compile(r"(\b[a-zA-Z][a-zA-Z0-9+.-]{1,20}://[^\s:/@'\"]+:)([^\s@/'\"]+)(@)")
_AUTH_HEADER = re.compile(r"(?i)(\bauthorization\s*[:=]\s*[\"']?(?:bearer|basic|token)\s+)([A-Za-z0-9._~+/=-]{8,})")
# A secret-looking name, then `=` / `:` (also JSON `"name": "value"`), then the value. "max_tokens" doesn't match
# because a letter may not follow the keyword.
_SENSITIVE_NAME = (
    r"[A-Za-z0-9_.-]*?(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|"
    r"client[_-]?secret|token|credentials?|database[_-]?url|dsn|connection[_-]?string|signing[_-]?key)(?![A-Za-z])"
    r"[A-Za-z0-9_.-]*"
)
_KEY_VALUE = re.compile(
    rf"(?i)(?P<name>\b{_SENSITIVE_NAME})(?P<sep>[\"']?\s*[:=]\s*)(?P<quote>[\"']?)(?P<value>[^\s\"',;}}]{{4,}})"
)
_PLACEHOLDERS = re.compile(
    r"^(?:\*+|x+|null|none|true|false|undefined|redacted|changeme|<[^>]*>|\$\{.*|\$\(.*|\[REDACTED.*)$", re.I
)


class RedactionError(ValueError):
    """The artifact still looks like it contains a credential after redaction; it is not processed."""


def redact(text: str) -> tuple[str, dict[str, int]]:
    """Return (redacted text, {secret type: count}). Raises RedactionError if a secret survives."""
    counts: Counter[str] = Counter()

    for name, pattern in _TOKEN_RULES:

        def _token(_m: re.Match[str], name: str = name) -> str:
            counts[name] += 1
            return MASK.format(name)

        text = pattern.sub(_token, text)

    def _url(m: re.Match[str]) -> str:
        if m[2].startswith("[REDACTED"):
            return m[0]
        counts["url_password"] += 1
        return f"{m[1]}{MASK.format('password')}{m[3]}"

    text = _URL_CREDENTIALS.sub(_url, text)

    def _header(m: re.Match[str]) -> str:
        counts["authorization_header"] += 1
        return f"{m[1]}{MASK.format('credential')}"

    text = _AUTH_HEADER.sub(_header, text)

    def _kv(m: re.Match[str]) -> str:
        value = m["value"]
        if _PLACEHOLDERS.match(value) or "[REDACTED:" in value:  # already handled (e.g. a URL's password)
            return m[0]
        counts["named_secret"] += 1
        return f"{m['name']}{m['sep']}{m['quote']}{MASK.format('secret')}"

    text = _KEY_VALUE.sub(_kv, text)

    for name, pattern in _TOKEN_RULES:  # verification pass
        if pattern.search(text):
            raise RedactionError(f"Could not safely redact a {name.replace('_', ' ')}.")
    if "PRIVATE KEY-----" in text and "[REDACTED:private_key]" not in text:
        raise RedactionError("Could not safely redact a private key block.")
    return text, dict(counts)
