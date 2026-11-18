"""The portfolio backend's settings: appcore's shared settings plus the portfolio's own (RAG, Keeper, EFI…).

All configuration comes from environment variables (or a local `.env` file),
validated once at startup by pydantic-settings. Nothing secret is hard-coded.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import SettingsConfigDict

from appcore import security
from appcore.settings import CoreSettings

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent


class Settings(CoreSettings):
    model_config = SettingsConfigDict(
        env_file=(PROJECT_ROOT / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    # ── App ────────────────────────────────────────────────────────────────
    app_name: str = "DocuMind RAG"

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

    # ── Keeper (personal assistant) ────────────────────────────────────────
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
    max_question_chars: int = 1000
    # Conversation memory: the last 4 exchanges (user + assistant = 8 messages) per chat session.
    max_history_messages: int = 8
    # (rate_limit, admin_api_key and frame_ancestors live in appcore's CoreSettings.
    #  On Hugging Face Spaces set FRAME_ANCESTORS=https://huggingface.co)

    @property
    def vector_dir(self) -> Path:
        return self.data_dir / "vectors"

    @property
    def model_cache_dir(self) -> Path:
        return self.data_dir / "models"


@lru_cache
def get_settings() -> Settings:
    return Settings()


# appcore's rate limiter and admin check read the portfolio's settings (same behaviour as before the split).
security.use_settings(get_settings)
