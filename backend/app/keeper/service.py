"""Keeper application service: wires the store, the routing agent, photo reading and the daily brief."""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
from collections.abc import Callable
from typing import Any

import httpx

from app.config import Settings
from app.keeper import schedule
from app.keeper.agent import KeeperAgent
from app.keeper.models import AgendaItem, Entry, ScanResult
from app.keeper.store import KeeperStore
from app.keeper.vision import SCAN_PROMPT, VisionLLM, build_vision
from app.rag.llm import ChatLLM
from app.rag.structured import extract_json

logger = logging.getLogger(__name__)

BRIEF_SYSTEM = """You write a warm, compact morning brief for a personal assistant app.
Use ONLY the facts given. 2-4 short sentences, plain text, no lists, no markdown, no greetings longer than 3 words.
Lead with anything overdue, then today, then what's coming up. Mention the shopping list count if not empty."""


class KeeperService:
    def __init__(
        self,
        settings: Settings,
        get_llm: Callable[[], ChatLLM],
        vision_factory: Callable[[Settings], VisionLLM] = build_vision,
    ) -> None:
        self.settings = settings
        self.store = KeeperStore(settings.data_dir / "keeper")
        if pruned := self.store.prune_photos():
            logger.info("Removed %d unreferenced Keeper photos", pruned)
        self._get_llm = get_llm
        self._vision_factory = vision_factory
        self._vision: VisionLLM | None = None
        self.agent = KeeperAgent(
            self.store, get_llm, caption=self._caption, llm_timeout_s=settings.keeper_llm_timeout_s
        )

    # ── capabilities ──────────────────────────────────────────────────────
    @property
    def vision(self) -> VisionLLM:
        if self._vision is None:
            self._vision = self._vision_factory(self.settings)
        return self._vision

    @property
    def vision_ready(self) -> bool:
        try:
            self.vision  # noqa: B018
            return True
        except Exception:  # noqa: BLE001
            return False

    @property
    def telegram_ready(self) -> bool:
        return bool(self.settings.telegram_bot_token and self.settings.telegram_chat_id)

    # ── photos ────────────────────────────────────────────────────────────
    async def scan(self, photo_id: str, hint: str, today: dt.date) -> ScanResult:
        found = self.store.photo_path(photo_id)
        if found is None:
            raise FileNotFoundError(photo_id)
        path, mime = found
        prompt = SCAN_PROMPT.format(today=today.isoformat(), hint=hint)
        reply = await asyncio.wait_for(self.vision.read(path.read_bytes(), mime, prompt), self.settings.llm_timeout_s)
        try:
            return ScanResult.model_validate(extract_json(reply))
        except ValueError:
            return ScanResult(kind="stash", title="Photo", caption=reply[:300] or None)

    async def _caption(self, photo_id: str) -> str | None:
        """Best-effort one-line caption so photos are searchable by what's in them."""
        try:
            found = self.store.photo_path(photo_id)
            if not found:
                return None
            prompt = "Describe the main object(s) and the place in this photo in one short sentence (max 20 words)."
            text = await asyncio.wait_for(self.vision.read(found[0].read_bytes(), found[1], prompt), 20)
            return " ".join(text.split())[:300] or None
        except Exception as exc:  # noqa: BLE001 - captions are optional
            logger.info("Photo caption skipped: %s", type(exc).__name__)
            return None

    # ── agenda & brief ────────────────────────────────────────────────────
    def agenda(self, now: dt.datetime) -> list[AgendaItem]:
        return schedule.agenda(self.store.list(), now)

    def _facts(self, now: dt.datetime) -> tuple[list[AgendaItem], list[str], Entry | None]:
        items = self.agenda(now)
        shopping = [e.title for e in self.store.list("pantry") if e.data.get("state") == "need"]
        parking = max(self.store.list("parking"), key=lambda e: e.created_at, default=None)
        return items, shopping, parking

    async def brief(self, now: dt.datetime) -> dict[str, Any]:
        items, shopping, parking = self._facts(now)
        fallback = schedule.template_brief(items, shopping, parking)
        if not items and not shopping:
            return {
                "text": "All clear: nothing due and the shopping list is empty.",
                "source": "template",
                "agenda": [],
            }
        facts = "\n".join(f"- [{i.bucket}] {i.label}" for i in items[:12]) or "- nothing due"
        prompt = (
            f"Today is {now:%A %d %B}, {now:%H:%M}.\nAgenda:\n{facts}\n"
            f"Shopping list ({len(shopping)}): {', '.join(shopping[:10]) or 'empty'}\n"
            f"Parked: {parking.place if parking else 'n/a'}"
        )
        try:
            text = await asyncio.wait_for(
                self._get_llm().complete(BRIEF_SYSTEM, [{"role": "user", "content": prompt}]), 25
            )
            text = " ".join(text.split())
            if 20 < len(text) < 900:
                return {"text": text, "source": "llm", "agenda": items}
        except Exception as exc:  # noqa: BLE001
            logger.info("Brief fell back to template: %s", type(exc).__name__)
        return {"text": fallback, "source": "template", "agenda": items}

    # ── Telegram delivery (optional) ──────────────────────────────────────
    async def send_telegram(self, text: str) -> None:
        token = self.settings.telegram_bot_token.get_secret_value() if self.settings.telegram_bot_token else ""
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": self.settings.telegram_chat_id, "text": f"Keeper · daily brief\n\n{text}"},
            )
            r.raise_for_status()

    async def brief_loop(self) -> None:
        """Send the brief once a day at `keeper_brief_hour` (user's local time, last offset seen)."""
        while True:
            try:
                offset = int(self.store.get_meta("tz_offset") or 0)
                now = schedule.local_now(offset)
                today = now.date().isoformat()
                if now.hour >= self.settings.keeper_brief_hour and self.store.get_meta("brief_sent") != today:
                    brief = await self.brief(now)
                    await self.send_telegram(brief["text"])
                    self.store.set_meta("brief_sent", today)
                    logger.info("Daily brief sent to Telegram")
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("Daily brief delivery failed; retrying in 15 minutes")
                await asyncio.sleep(900)
            await asyncio.sleep(60)
