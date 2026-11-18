"""Safarnama as a standalone FastAPI service.

Run locally (from products/safarnama/api):   uvicorn safarnama.main:create_app --factory --reload --port 8100

The same router is also mounted by the portfolio backend; both use the "tripweaver" store, so trips are shared.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from appcore import security
from appcore.docstore import DocStore
from appcore.errors import ErrorsAsJSON
from appcore.llm.chat import ChatLLM, build_llm
from appcore.logs import configure_logging
from appcore.security import SecurityHeadersMiddleware, limiter
from appcore.settings import database_hint
from safarnama import api
from safarnama.service import Tools, TripService
from safarnama.settings import SafarnamaSettings, get_settings


def create_app(
    settings: SafarnamaSettings | None = None,
    llm_factory: Callable[[SafarnamaSettings], ChatLLM] = build_llm,
    tools: Tools | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    security.use_settings(lambda: settings)

    llm: dict[str, ChatLLM] = {}

    def get_llm() -> ChatLLM:  # built on first use, so the service starts without an API key
        if "llm" not in llm:
            llm["llm"] = llm_factory(settings)
        return llm["llm"]

    app = FastAPI(title="Safarnama API", version="1.0.0", docs_url=None if settings.is_production else "/docs")
    store = DocStore(settings.data_dir / "tripweaver.sqlite3", settings.db_url)
    app.state.settings = settings
    app.state.trips = TripService(store, get_llm, tools)

    app.add_middleware(ErrorsAsJSON)  # inside CORS: even a crash answers with CORS headers
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_origin_regex=settings.cors_origin_regex or None,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "X-Trip-Owner", "X-Trip-Share", "X-TZ-Offset"],
        max_age=600,
    )
    app.add_middleware(SecurityHeadersMiddleware, settings=settings)
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(api.router)

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        src = settings.db_source
        return {
            "status": "ok",
            "service": "safarnama",
            "storage": settings.storage,
            "storage_source": src and src[0],
            "storage_hint": None if src else database_hint(os.environ),
        }

    return app
