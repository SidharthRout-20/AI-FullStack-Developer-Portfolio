"""Safarnama's settings: appcore's shared settings (database, LLM, CORS, security) plus Safarnama's own.

Values come from environment variables or `products/safarnama/api/.env` (see `.env.example`).
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import SettingsConfigDict

from appcore.settings import CoreSettings

API_DIR = Path(__file__).resolve().parents[2]  # products/safarnama/api


class SafarnamaSettings(CoreSettings):
    model_config = SettingsConfigDict(
        env_file=(API_DIR / ".env",), env_file_encoding="utf-8", extra="ignore", populate_by_name=True
    )

    app_name: str = "Safarnama"
    # Local SQLite files when DATABASE_URL is unset. Trips live in the "tripweaver" store (its Postgres schema),
    # shared with the portfolio backend while both serve Safarnama.
    data_dir: Path = API_DIR / "data"
    # Any localhost port during development; the deployed frontend is added with FRONTEND_URL / CORS_ORIGINS.
    cors_origin_regex: str = r"http://(localhost|127\.0\.0\.1)(:\d+)?"


@lru_cache
def get_settings() -> SafarnamaSettings:
    return SafarnamaSettings()
