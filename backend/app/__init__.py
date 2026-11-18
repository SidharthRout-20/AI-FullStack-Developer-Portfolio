"""Backend package.

On Vercel the deployment bundle is read-only and /tmp is the only writable directory. Vercel may start
the app through the repo-root `index.py` or directly from `app/main.py` (when the project's Root
Directory is `backend/`), so the serverless defaults live here: this module runs before any other
`app.*` module and before Hugging Face / fastembed are imported (they read their cache paths on import).
Explicit environment variables still win.
"""

from __future__ import annotations

import os

if os.environ.get("VERCEL"):
    for _key, _value in {
        "DATA_DIR": "/tmp/portfolio-data",  # noqa: S108 - SQLite stores, vector index, model cache
        "HF_HOME": "/tmp/hf-home",  # noqa: S108 - Hugging Face cache + xet logs (default is under ~)
        "XDG_CACHE_HOME": "/tmp/cache",  # noqa: S108
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "WATCH_DOCUMENTS": "false",  # no background tasks between serverless invocations
        "BACKGROUND_JOBS": "false",  # reminders & scheduled flows run from the /api/cron/tick endpoint
        "SERVE_FRONTEND": "false",  # the frontend is its own Vercel project
        "ENVIRONMENT": "production",
    }.items():
        os.environ.setdefault(_key, _value)

# Register the portfolio's LLM tasks with appcore's router (after the environment defaults above).
from app import llm_tasks as _llm_tasks  # noqa: E402, F401
