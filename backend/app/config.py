"""Centralised, typed application settings.

All configuration comes from environment variables (or a local `.env` file),
validated once at startup by pydantic-settings. Nothing secret is hard-coded.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote

from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(PROJECT_ROOT / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    # ── App ────────────────────────────────────────────────────────────────
    app_name: str = "DocuMind RAG"
    environment: Literal["development", "production", "test"] = "development"
    log_level: str = "INFO"

    # Comma-separated list in the env var, e.g. "http://localhost:5173,https://me.dev"
    # NoDecode: read the raw string (not JSON) so the CSV validator below can split it.
    cors_origins: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["http://localhost:5173"])
    # The deployed frontend (a separate Vercel project) is always allowed, on top of CORS_ORIGINS, so the live
    # site keeps working whatever CORS_ORIGINS is set to. Set FRONTEND_URL="" to turn this off.
    frontend_url: str = "https://ai-full-stack-developer-portfolio-p.vercel.app"
    # Any Vercel domain of the frontend project (production alias, "-ruby" style aliases, preview deployments) and
    # a frontend on any localhost port. Safe: CORS here never allows credentials. Set CORS_ORIGIN_REGEX="" to turn off.
    cors_origin_regex: str = (
        r"https://ai-full-stack-developer-portfolio-p(-[a-z0-9-]+)?\.vercel\.app|http://(localhost|127\.0\.0\.1)(:\d+)?"
    )

    # Serve the built React app (frontend/dist) from FastAPI → single deployable unit.
    serve_frontend: bool = True
    frontend_dist: Path = PROJECT_ROOT / "frontend" / "dist"

    # ── Storage (all local, file-based) ────────────────────────────────────
    documents_dir: Path = PROJECT_ROOT / "documents"
    data_dir: Path = BACKEND_DIR / "data"
    # Shared Postgres (e.g. Neon via the Vercel integration). Required on serverless hosts, where data_dir is a
    # per-instance /tmp that is wiped on cold starts. Unset → local SQLite files in data_dir.
    database_url: SecretStr | None = Field(None, validation_alias=AliasChoices("DATABASE_URL", "POSTGRES_URL"))
    # Shared secret for scheduled calls (reminders, daily brief): "Authorization: Bearer <CRON_SECRET>".
    cron_secret: SecretStr | None = None
    # Background loops (reminders, scheduled flows). Off on serverless hosts, which use the cron endpoint instead.
    background_jobs: bool = True
    # This backend's public URL, used for one-tap links in notifications sent by the background loop.
    public_url: str = "http://localhost:8000"
    collection_name: str = "documents"
    auto_ingest: bool = True  # index documents at startup if anything changed
    watch_documents: bool = True  # re-index automatically when files in documents_dir change
    watch_interval_s: float = 3.0
    max_file_mb: int = 20

    # ── Chunking / retrieval ───────────────────────────────────────────────
    embedding_model: str = "BAAI/bge-small-en-v1.5"
    chunk_size: int = 800
    chunk_overlap: int = 120
    top_k: int = 5
    candidate_k: int = 12  # per retriever, before rank fusion
    # Relevance grading (tuned for bge-small on short documents; re-tune per corpus):
    # the best chunk must reach `relevance_threshold`, then we keep every chunk
    # whose similarity is within `relevance_margin` of the best one.
    relevance_threshold: float = 0.50
    relevance_margin: float = 0.12

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
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2"
    llm_temperature: float = 0.1  # Groq/Ollama only (Claude Opus 5.5 doesn't take sampling params)
    llm_max_tokens: int = 4096  # Groq/Ollama only (reasoning models spend part of this thinking)
    llm_timeout_s: float = 60.0
    # ── Central Groq LLM router (app/llm). groq_model above stays the safe default for undeclared tasks. ──
    llm_router_allow_preview: bool = True  # preview models (qwen vision, safeguard) may be selected for their role
    llm_router_discovery_ttl_s: int = Field(21_600, ge=60)  # re-check GET /openai/v1/models every 6 h
    llm_router_max_attempts: int = Field(4, ge=1, le=8)  # model calls per request, fallbacks included
    llm_router_max_retries: int = Field(1, ge=0, le=3)  # same-model retries on 5xx / connection errors
    llm_router_backoff_s: float = Field(0.5, ge=0, le=5)  # exponential: 0.5 s, 1 s, 2 s … (capped at 8 s)
    llm_router_max_wait_s: float = Field(3.0, ge=0, le=20)  # wait in-request for a short Retry-After, else fall back
    # Share of a model's remaining daily requests kept free for higher priorities (1 = EFI, 2 = TripWeaver,
    # 3 = other products and Labs, 4 = background jobs).
    llm_router_reserve_p2: float = Field(0.02, ge=0, le=0.5)
    llm_router_reserve_p3: float = Field(0.05, ge=0, le=0.5)
    llm_router_reserve_p4: float = Field(0.15, ge=0, le=0.8)

    # ── Keeper (personal assistant) ────────────────────────────────────────
    # Vision model for reading photos (labels, warranty cards, receipts).
    groq_vision_model: str = "qwen/qwen3.8-27b"  # multimodal; see console.groq.com/docs/models
    keeper_llm_timeout_s: float = 25.0
    # MeetingMind transcription (Groq hosted Whisper, free tier)
    whisper_model: str = "whisper-large-v3-turbo"
    keeper_photo_max_kb: int = 2048  # the browser downsizes photos before upload
    # Optional shared secret. Set it when Keeper is reachable from the internet: the UI asks for it once.
    keeper_access_key: SecretStr | None = None
    # Optional daily brief delivery to Telegram (create a bot with @BotFather).
    telegram_bot_token: SecretStr | None = None
    telegram_chat_id: str | None = None
    keeper_brief_hour: int = Field(8, ge=0, le=23)

    # ── EFI (Engineering Failure Investigator) ─────────────────────────────
    # Always runs on Groq (free tier); there is deliberately no fallback to another (paid) provider.
    efi_model: str | None = None  # None → groq_model (openai/gpt-oss-120b)
    efi_max_request_bytes: int = Field(2_500_000, ge=10_000, le=4_000_000)  # stays under Vercel's body limit
    efi_max_artifact_bytes: int = Field(1_000_000, ge=1_000, le=4_000_000)
    efi_max_artifacts: int = Field(12, ge=1, le=50)
    efi_max_evidence: int = Field(300, ge=20, le=2000)
    efi_max_context_chars: int = Field(16_000, ge=2_000, le=200_000)  # evidence sent per model call (~4k tokens)
    efi_max_output_tokens: int = Field(3072, ge=256, le=16_000)  # includes gpt-oss reasoning tokens
    efi_max_model_calls: int = Field(2, ge=1, le=5)  # per analysis: 1 call + 1 repair retry for invalid JSON
    efi_max_retries: int = Field(2, ge=0, le=5)  # SDK retries with exponential backoff (429 / 5xx)
    efi_reasoning_effort: Literal["low", "medium", "high"] = "low"
    efi_llm_timeout_s: float = Field(90.0, ge=10, le=280)  # whole analysis, retries included
    efi_retention_days: int = Field(14, ge=1, le=365)  # raw (redacted) artifacts; reports stay until deleted
    efi_daily_analyses_per_owner: int = Field(20, ge=0, le=10_000)
    efi_daily_analyses_global: int = Field(200, ge=0, le=100_000)

    # ── Security ───────────────────────────────────────────────────────────
    rate_limit: str = "20/minute"
    max_question_chars: int = 1000
    # Conversation memory: the last 4 exchanges (user + assistant = 8 messages) per chat session.
    max_history_messages: int = 8
    # Admin endpoints are disabled entirely unless a key is configured.
    admin_api_key: SecretStr | None = None
    # CSP frame-ancestors. "'none'" forbids embedding (clickjacking protection).
    # On Hugging Face Spaces set to: https://huggingface.co
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
        if self.database_url and (url := _pg_url(self.database_url.get_secret_value())):
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
    def vector_dir(self) -> Path:
        return self.data_dir / "vectors"

    @property
    def model_cache_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def active_model(self) -> str:
        return {"anthropic": self.claude_model, "groq": self.groq_model, "ollama": self.ollama_model}[self.llm_provider]

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


_PG_URL = re.compile(r"postgres(?:ql)?://[^\s'\"]+")
_DB_HINT = re.compile(r"PG|POSTGRES|DATABASE|NEON|STORAGE|DB", re.I)


def _pg_url(value: str | None) -> str | None:
    """Pull a Postgres URL out of a value that may be quoted or pasted as a `psql '...'` command."""
    m = _PG_URL.search(value or "")
    return m.group(0) if m else None


def find_database_url(env: Mapping[str, str]) -> tuple[str, str] | None:
    """(env var name, URL) of the Postgres database, however the hosting integration named it.

    The Vercel Neon integration lets you pick a prefix (STORAGE_URL, PORTFOLIO_DB_DATABASE_URL, ...) and also sets
    unpooled / non-SSL variants. Prefer DATABASE_URL, then pooled URLs; fall back to building one from PGHOST/... .
    """
    found = {k: u for k, v in env.items() if (u := _pg_url(v))}

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


@lru_cache
def get_settings() -> Settings:
    return Settings()
