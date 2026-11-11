"""FastAPI application factory.

Run locally:   uvicorn app.main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.api.cron import router as cron_router
from app.api.keeper import actions_router
from app.api.keeper import router as keeper_router
from app.api.products import router as products_router
from app.api.routes import router
from app.config import Settings, get_settings
from app.core.logging import configure_logging
from app.core.security import SecurityHeadersMiddleware, limiter
from app.core.tls import use_system_certificates
from app.keeper.service import KeeperService
from app.products import careerpilot, codelens, contact, evolve, flowforge, meetingmind, tripweaver
from app.products.suite import Suite
from app.rag.service import RAGService
from app.rag.watcher import DocumentWatcher

logger = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None,
    service_factory: Callable[[Settings], RAGService] = RAGService,
    keeper_factory: Callable[[Settings, RAGService], KeeperService] | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    use_system_certificates()  # must run before any HTTPS client is created

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Model loading & indexing are blocking → run in a worker thread.
        rag = await asyncio.to_thread(service_factory, settings)
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
        jobs = settings.background_jobs
        reminder_task = asyncio.create_task(keeper.scheduler_loop(settings.public_url)) if jobs else None
        app.state.suite = Suite(settings, rag, keeper)
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

    # Middleware order: last added = outermost.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "X-Admin-Key", "X-Keeper-Key", "X-TZ-Offset"],
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
    for product in (careerpilot, meetingmind, codelens, flowforge, tripweaver, evolve, contact):
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
