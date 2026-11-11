"""Vercel entry point: exposes the FastAPI app that lives in backend/app.

Named `index.py` (not `app.py`) so it can't shadow the `app` package it imports.
Serverless functions only have a writable /tmp and don't keep running between requests, so on Vercel
the data dir moves to /tmp and the background document watcher is off (documents are indexed at startup).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

if os.environ.get("VERCEL"):
    os.environ.setdefault("DATA_DIR", "/tmp/portfolio-data")
    os.environ.setdefault("WATCH_DOCUMENTS", "false")
    os.environ.setdefault("SERVE_FRONTEND", "false")
    os.environ.setdefault("ENVIRONMENT", "production")

from app.main import app  # noqa: E402

__all__ = ["app"]
