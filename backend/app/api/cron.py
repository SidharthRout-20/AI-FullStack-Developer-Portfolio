"""Scheduled work for serverless hosts: one endpoint a free cron service calls every minute.

On Vercel nothing runs between requests, so reminders, the daily brief and scheduled flows are driven from
outside: point a cron (cron-job.org is free and supports every-minute jobs) at

    GET https://<backend>/api/cron/tick        with header  Authorization: Bearer <CRON_SECRET>

(`?key=<CRON_SECRET>` works too, for services that can't send headers). Disabled until CRON_SECRET is set.
"""

from __future__ import annotations

import logging
import secrets
from typing import Annotated, Any

from fastapi import APIRouter, Header, HTTPException, Query, Request, status

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/cron", tags=["cron"])


def _authorise(request: Request, authorization: str | None, key: str | None) -> None:
    secret = request.app.state.keeper.settings.cron_secret
    if secret is None or not secret.get_secret_value():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Scheduled jobs are disabled: set CRON_SECRET.")
    given = (authorization or "").removeprefix("Bearer ").strip() or (key or "")
    if not given or not secrets.compare_digest(given, secret.get_secret_value()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid cron secret.")


@router.api_route("/tick", methods=["GET", "POST"])
async def tick(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    key: Annotated[str | None, Query(max_length=200)] = None,
) -> dict[str, Any]:
    _authorise(request, authorization, key)
    base_url = str(request.base_url).replace("http://", "https://", 1) if request.url.hostname not in (
        "localhost", "127.0.0.1", "testserver"
    ) else str(request.base_url)  # fmt: skip
    out: dict[str, Any] = {}
    try:
        out["keeper"] = await request.app.state.keeper.tick(base_url)
    except Exception:  # noqa: BLE001 - one job failing must not stop the other
        logger.exception("Keeper tick failed")
        out["keeper"] = "error"
    try:
        out["flows_run"] = await request.app.state.suite.flows.run_scheduled()
    except Exception:  # noqa: BLE001
        logger.exception("Scheduled flows failed")
        out["flows_run"] = "error"
    try:
        out["efi_artifacts_purged"] = request.app.state.efi.store.purge_expired()
    except Exception:  # noqa: BLE001
        logger.exception("EFI artifact purge failed")
        out["efi_artifacts_purged"] = "error"
    return out
