"""Settings every app built on appcore shares: environment, CORS, database, LLM routing and security.

Each app subclasses `CoreSettings` with its own fields and defaults (the portfolio's `app.config.Settings`,
Safarnaama's `safarnama.settings.SafarnamaSettings`). All values come from environment variables or a `.env` file,
validated once at startup by pydantic-settings. Nothing secret is hard-coded.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote

from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class CoreSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file_encoding="utf-8", extra="ignore", populate_by_name=True)

    # ── App ────────────────────────────────────────────────────────────────
    environment: Literal["development", "production", "test"] = "development"
    log_level: str = "INFO"

    # Comma-separated list in the env var, e.g. "http://localhost:5173,https://me.dev"
    # NoDecode: read the raw string (not JSON) so the CSV validator below can split it.
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["http://localhost:5173"])
    # The app's deployed frontend, always allowed on top of CORS_ORIGINS. Empty = none.
    frontend_url: str = ""
    # Extra allowed origins as a regex (e.g. every preview deployment of the frontend). Empty = none.
    cors_origin_regex: str = ""

    # ── Storage ────────────────────────────────────────────────────────────
    data_dir: Path = Path("data")
    # Shared Postgres (e.g. Neon via the Vercel integration). Required on serverless hosts, where data_dir is a
    # per-instance /tmp that is wiped on cold starts. Unset → local SQLite files in data_dir.
    database_url: SecretStr | None = Field(None, validation_alias=AliasChoices("DATABASE_URL", "POSTGRES_URL"))

    # ── LLM ────────────────────────────────────────────────────────────────
    llm_provider: Literal["anthropic", "groq", "ollama"] = "groq"
    # Claude (official Anthropic SDK)
    anthropic_api_key: SecretStr | None = None
    claude_model: str = "claude-opus-5-5"
    # Thinking is always on for Claude Opus 5.5; effort sets its depth (and cost/latency).
    claude_effort: Literal["low", "medium", "high", "xhigh", "max"] = "medium"
    claude_max_tokens: int = 16000  # includes thinking tokens
    # Groq / Ollama
    groq_api_key: SecretStr | None = None
    groq_model: str = "openai/gpt-oss-120b"
    # Live hotel prices for Safarnaama (LiteAPI by Nuitee; the portfolio backend serves Safarnaama too). A sandbox key
    # starts with "sand_" and returns test prices. The whitelabel URL is the booking site the traveller books on.
    liteapi_key: SecretStr | None = None
    liteapi_whitelabel_url: str | None = None
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2"
    llm_temperature: float = 0.1  # Groq/Ollama only (Claude Opus 5.5 doesn't take sampling params)
    llm_max_tokens: int = 4096  # Groq/Ollama only (reasoning models spend part of this thinking)
    llm_timeout_s: float = 60.0
    # ── Central Groq LLM router (appcore.llm). groq_model above stays the safe default for undeclared tasks. ──
    llm_router_allow_preview: bool = True  # preview models (qwen vision, safeguard) may be selected for their role
    llm_router_discovery_ttl_s: int = Field(21_600, ge=60)  # re-check GET /openai/v1/models every 6 h
    llm_router_max_attempts: int = Field(4, ge=1, le=8)  # model calls per request, fallbacks included
    llm_router_max_retries: int = Field(1, ge=0, le=3)  # same-model retries on 5xx / connection errors
    llm_router_backoff_s: float = Field(0.5, ge=0, le=5)  # exponential: 0.5 s, 1 s, 2 s … (capped at 8 s)
    llm_router_max_wait_s: float = Field(3.0, ge=0, le=20)  # wait in-request for a short Retry-After, else fall back
    # Share of a model's remaining daily requests kept free for higher priorities (1 = most protected product,
    # 2 = next, 3 = other products and Labs, 4 = background jobs).
    llm_router_reserve_p2: float = Field(0.02, ge=0, le=0.5)
    llm_router_reserve_p3: float = Field(0.05, ge=0, le=0.5)
    llm_router_reserve_p4: float = Field(0.15, ge=0, le=0.8)
    # Vision model for reading photos (receipts, labels, warranty cards).
    groq_vision_model: str = "qwen/qwen3.8-27b"

    # ── Sign-in ────────────────────────────────────────────────────────────
    # Neon Auth (managed Better Auth) for this project, e.g. https://ep-….neonauth.<region>.aws.neon.tech/neondb/auth.
    # Not a secret: tokens are checked against the public keys it publishes. Empty = sign-in off (browser tokens only).
    neon_auth_base_url: str = ""

    # ── Security ───────────────────────────────────────────────────────────
    rate_limit: str = "20/minute"
    # Admin endpoints are disabled entirely unless a key is configured.
    admin_api_key: SecretStr | None = None
    # CSP frame-ancestors. "'none'" forbids embedding (clickjacking protection).
    frame_ancestors: str = "'none'"

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_csv(cls, v: object) -> object:
        if isinstance(v, str) and not v.strip().startswith("["):
            v = v.split(",")
        if isinstance(v, list):
            # Browsers send Origin without a trailing slash, so "https://site.app/" would never match.
            return [o.strip().strip("\"'").rstrip("/") for o in v if isinstance(o, str) and o.strip()]
        return v

    @property
    def db_url(self) -> str | None:
        return self.db_source[1] if self.db_source else None

    @property
    def db_source(self) -> tuple[str, str] | None:
        """(where the URL came from, URL), or None when no Postgres database is configured."""
        if self.database_url and (url := pg_url(self.database_url.get_secret_value())):
            return "DATABASE_URL", url
        return find_database_url(os.environ)

    @property
    def storage(self) -> str:
        """ "postgres" (shared, persistent) or "sqlite" (local files; NOT persistent on serverless hosts)."""
        return "postgres" if self.db_url else "sqlite"

    @property
    def allowed_origins(self) -> list[str]:
        """CORS allow-list: CORS_ORIGINS plus the deployed frontend, without duplicates."""
        extra = [self.frontend_url.strip().rstrip("/")] if self.frontend_url.strip() else []
        return list(dict.fromkeys([*self.cors_origins, *extra]))

    @property
    def active_model(self) -> str:
        return {"anthropic": self.claude_model, "groq": self.groq_model, "ollama": self.ollama_model}[self.llm_provider]

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


_PG_URL = re.compile(r"postgres(?:ql)?://[^\s'\"]+")
_DB_HINT = re.compile(r"PG|POSTGRES|DATABASE|NEON|STORAGE|DB", re.I)


def pg_url(value: str | None) -> str | None:
    """Pull a Postgres URL out of a value that may be quoted or pasted as a `psql '...'` command."""
    m = _PG_URL.search(value or "")
    return m.group(0) if m else None


def find_database_url(env: Mapping[str, str]) -> tuple[str, str] | None:
    """(env var name, URL) of the Postgres database, however the hosting integration named it.

    The Vercel Neon integration lets you pick a prefix (STORAGE_URL, PORTFOLIO_DB_DATABASE_URL, ...) and also sets
    unpooled / non-SSL variants. Prefer DATABASE_URL, then pooled URLs; fall back to building one from PGHOST/... .
    """
    found = {k: u for k, v in env.items() if (u := pg_url(v))}

    def rank(k: str) -> tuple[bool, bool, bool, str]:
        up = k.upper()
        return (
            any(t in up for t in ("UNPOOLED", "NON_POOLING", "NO_SSL", "PRISMA")),
            not up.endswith("URL"),
            up != "DATABASE_URL",
            k,
        )

    if found:
        name = min(found, key=rank)
        return name, found[name]
    for prefix in ("PG", "POSTGRES_"):
        host, user, password, db = (env.get(prefix + k) for k in ("HOST", "USER", "PASSWORD", "DATABASE"))
        if host and user and password and db:
            return f"{prefix}HOST/...", f"postgresql://{quote(user)}:{quote(password)}@{host}/{db}?sslmode=require"
    return None


def discover_database_url(env: Mapping[str, str]) -> str | None:
    hit = find_database_url(env)
    return hit[1] if hit else None


def database_hint(env: Mapping[str, str]) -> str:
    """Why storage fell back to SQLite: lists database-looking variable NAMES (never values)."""
    names = sorted(k for k in env if _DB_HINT.search(k) and not k.startswith(("VERCEL_", "HF_")))
    return (
        f"No Postgres connection string reached this deployment (VERCEL_ENV={env.get('VERCEL_ENV', 'local')}). "
        f"Database-like variables present: {', '.join(names) or 'none'}. Connect the Neon store to THIS project "
        "for this environment, or add DATABASE_URL, then redeploy."
    )
