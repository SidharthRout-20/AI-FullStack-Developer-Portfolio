"""Centralised, typed application settings.

All configuration comes from environment variables (or a local `.env` file),
validated once at startup by pydantic-settings. Nothing secret is hard-coded.
"""

from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

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
        if self.database_url and self.database_url.get_secret_value().strip():
            return self.database_url.get_secret_value().strip()
        return discover_database_url(os.environ)

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


_DB_VAR = re.compile(r"^(?:\w+_)?(?:DATABASE_URL|POSTGRES_URL)$")


def discover_database_url(env: dict[str, str] | os._Environ[str]) -> str | None:
    """Find a Postgres URL however the hosting integration named it.

    The Vercel Neon integration lets you pick a prefix (STORAGE_URL, PORTFOLIO_DB_DATABASE_URL, …) and also sets
    unpooled / non-SSL variants. Prefer a pooled URL; fall back to building one from PGHOST/PGUSER/… .
    """
    candidates = sorted(
        (k for k, v in env.items() if v and v.startswith(("postgres://", "postgresql://")) and _DB_VAR.match(k)
         or (k.endswith(("_URL", "_DATABASE_URL")) and v and v.startswith(("postgres://", "postgresql://")))),
        key=lambda k: ("UNPOOLED" in k or "NON_POOLING" in k or "NO_SSL" in k, k != "DATABASE_URL", k),
    )  # fmt: skip
    if candidates:
        return env[candidates[0]]
    host, user, password, db = (env.get(k) for k in ("PGHOST", "PGUSER", "PGPASSWORD", "PGDATABASE"))
    if host and user and password and db:
        return f"postgresql://{user}:{password}@{host}/{db}?sslmode=require"
    return None


@lru_cache
def get_settings() -> Settings:
    return Settings()
