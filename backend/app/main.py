"""FastAPI application factory.

Run locally:   uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.api.cron import router as cron_router
from app.api.edits import router as edits_router
from app.api.efi import router as efi_router
from app.api.keeper import actions_router
from app.api.keeper import router as keeper_router
from app.api.llm import router as llm_router
from app.api.products import router as products_router
from app.api.routes import router
from app.config import Settings, get_settings
from app.control import Control, ProductGate, SwitchableLLM, set_active
from app.control import router as control_router
from app.efi.service import EFIService
from app.evals import router as evals_router
from app.keeper.edits import Edits
from app.keeper.service import KeeperService
from app.products import careerpilot, codelens, contact, evolve, flowforge, meetingmind
from app.products.suite import Suite
from app.rag.service import RAGService
from app.rag.watcher import DocumentWatcher
from app.visits import router as visits_router
from appcore.accounts import accounts_from
from appcore.errors import ErrorsAsJSON
from appcore.logs import configure_logging
from appcore.security import SecurityHeadersMiddleware, limiter
from appcore.tls import use_system_certificates
from safarnama import api as trip_api
from safarnama.liteapi import LiteAPI

logger = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None,
    service_factory: Callable[[Settings], RAGService] = RAGService,
    keeper_factory: Callable[[Settings, RAGService], KeeperService] | None = None,
    efi_factory: Callable[[Settings], EFIService] = EFIService,
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    use_system_certificates()  # must run before any HTTPS client is created

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Model loading & indexing are blocking → run in a worker thread.
        rag = await asyncio.to_thread(service_factory, settings)
        # The control room picks the model per call (free tier, or a paid provider within its budget).
        control = app.state.control = Control(settings)
        set_active(control)
        build = rag._llm_factory
        rag._llm_factory = lambda s: SwitchableLLM(build(s), control, s)
        if settings.auto_ingest:
            report = await asyncio.to_thread(rag.ingest)
            logger.info(
                "Ingest: added=%s updated=%s removed=%s unchanged=%d",
                report.added,
                report.updated,
                report.removed,
                len(report.unchanged),
            )
        app.state.rag = rag
        app.state.watcher = DocumentWatcher(rag)
        watch_task = (
            asyncio.create_task(app.state.watcher.run(settings.watch_interval_s)) if settings.watch_documents else None
        )
        # Keeper shares the (lazily created) LLM client with DocuMind.
        keeper = (keeper_factory or (lambda s, r: KeeperService(s, r.get_llm)))(settings, rag)
        app.state.keeper = keeper
        if (tools := getattr(getattr(keeper, "agent", None), "tools", None)) is not None:
            tools.knowledge = _knowledge(rag)  # Tara answers questions about the portfolio from the same documents
            if tools.repo is not None:  # code proposals plan against the same read-only index
                app.state.edits = Edits(settings, tools.repo, rag.get_llm)
        jobs = settings.background_jobs
        reminder_task = asyncio.create_task(keeper.scheduler_loop(settings.public_url)) if jobs else None
        app.state.suite = Suite(settings, rag, keeper)
        app.state.trips = app.state.suite.trips  # Safarnaama's API reads its service from here
        app.state.trips.live = LiteAPI.from_settings(settings)  # live hotel prices, when LITEAPI_KEY is set
        app.state.efi = efi_factory(settings)
        scheduler = asyncio.create_task(app.state.suite.flows.scheduler()) if jobs else None
        logger.info("Ready - %d chunks indexed, LLM provider=%s", rag.store.count(), settings.llm_provider)
        yield
        if scheduler:
            scheduler.cancel()
        if watch_task:
            watch_task.cancel()
        if reminder_task:
            reminder_task.cancel()

    app = FastAPI(
        title=settings.app_name,
        version="1.0.0",
        lifespan=lifespan,
        # Interactive API docs only outside production (smaller attack surface).
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else "/openapi.json",
    )
    app.state.accounts = accounts_from(settings.neon_auth_base_url)  # Safarnaama sign-in; None = off

    # Middleware order: last added = outermost.
    # Inside CORS (added before it), so even an unexpected crash answers with CORS headers and the browser shows a
    # real 500 instead of a misleading "blocked by CORS policy".
    app.add_middleware(ErrorsAsJSON)
    # A product the owner paused in the control room answers 503 (inside CORS, so the browser sees the message).
    app.add_middleware(ProductGate)
    # Smaller JSON over slow connections (live event streams are left uncompressed so they arrive as they happen).
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_origin_regex=settings.cors_origin_regex or None,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=[
            "Content-Type",
            "X-Admin-Key",
            "X-Keeper-Key",
            "X-TZ-Offset",
            "X-EFI-Owner",
            "X-Trip-Owner",
            "X-Trip-Share",
            "X-Tara-Owner-Key",
            "X-Visitor",
            "Authorization",
        ],
        allow_credentials=False,
        max_age=600,
    )
    app.add_middleware(SecurityHeadersMiddleware, settings=settings)

    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    @app.exception_handler(Exception)
    async def unhandled(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error", exc_info=exc)
        return JSONResponse({"detail": "Internal server error"}, status_code=500)

    app.include_router(router)
    app.include_router(products_router)
    app.include_router(keeper_router)
    app.include_router(actions_router)
    app.include_router(cron_router)
    app.include_router(efi_router)
    app.include_router(llm_router)
    app.include_router(evals_router)
    app.include_router(visits_router)
    app.include_router(control_router)
    app.include_router(edits_router)
    for product in (careerpilot, meetingmind, codelens, flowforge, trip_api, evolve, contact):
        app.include_router(product.router)
    app.include_router(flowforge.hooks)

    if settings.serve_frontend and (settings.frontend_dist / "index.html").is_file():
        _mount_spa(app, settings.frontend_dist)

    return app


def _mount_spa(app: FastAPI, dist: Path) -> None:
    """Serve the built React app, with client-side-routing fallback to index.html."""
    dist = dist.resolve()
    if (dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(404, "Not Found")
        candidate = (dist / full_path).resolve()
        if full_path and candidate.is_file() and candidate.is_relative_to(dist):  # no path traversal
            return FileResponse(candidate)
        return FileResponse(dist / "index.html")


app = create_app()


def _knowledge(rag: RAGService) -> Callable[[str], Awaitable[list[dict[str, Any]]]]:
    """Search the portfolio's indexed documents (the résumé and project notes) for Tara's "portfolio" tool."""

    async def search(query: str) -> list[dict[str, Any]]:
        hits = await asyncio.to_thread(rag.retriever.search, query, 4, 20)
        return [{"source": h.chunk.source, "text": h.chunk.text} for h in hits]

    return search
