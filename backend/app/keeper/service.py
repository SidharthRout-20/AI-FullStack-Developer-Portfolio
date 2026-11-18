"""Keeper application service: store, routing agent, photo reading, the daily brief and timed reminders."""

from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import json
import logging
import secrets
from collections.abc import Callable
from typing import Any

import httpx

from app.config import Settings
from app.keeper import notify, reminders, schedule
from app.keeper.agent import KeeperAgent
from app.keeper.models import AgendaItem, Entry, ScanResult
from app.keeper.reminders import Alert, ReminderSettings
from app.keeper.store import KeeperStore
from app.keeper.vision import SCAN_PROMPT, VisionLLM, build_vision
from appcore.llm import for_task
from appcore.llm.chat import ChatLLM
from appcore.llm.structured import extract_json

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
        self.store = KeeperStore(settings.data_dir / "keeper", settings.db_url)
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
        found = self.store.photo(photo_id)
        if found is None:
            raise FileNotFoundError(photo_id)
        blob, mime = found
        prompt = SCAN_PROMPT.format(today=today.isoformat(), hint=hint)
        reply = await asyncio.wait_for(self.vision.read(blob, mime, prompt), self.settings.llm_timeout_s)
        try:
            return ScanResult.model_validate(extract_json(reply))
        except ValueError:
            return ScanResult(kind="stash", title="Photo", caption=reply[:300] or None)

    async def _caption(self, photo_id: str) -> str | None:
        """Best-effort one-line caption so photos are searchable by what's in them."""
        try:
            found = self.store.photo(photo_id)
            if not found:
                return None
            prompt = "Describe the main object(s) and the place in this photo in one short sentence (max 20 words)."
            text = await asyncio.wait_for(self.vision.read(found[0], found[1], prompt), 20)
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
                for_task(self._get_llm(), "keeper.brief").complete(BRIEF_SYSTEM, [{"role": "user", "content": prompt}]),
                25,
            )
            text = " ".join(text.split())
            if 20 < len(text) < 900:
                return {"text": text, "source": "llm", "agenda": items}
        except Exception as exc:  # noqa: BLE001
            logger.info("Brief fell back to template: %s", type(exc).__name__)
        return {"text": fallback, "source": "template", "agenda": items}

    # ── Reminder settings & action links ──────────────────────────────────
    def reminder_settings(self) -> ReminderSettings:
        raw = self.store.get_meta("reminders")
        base = {"brief_hour": self.settings.keeper_brief_hour}
        try:
            return ReminderSettings.model_validate({**base, **(json.loads(raw) if raw else {})})
        except ValueError:
            return ReminderSettings.model_validate(base)

    def save_reminder_settings(self, s: ReminderSettings) -> ReminderSettings:
        self.store.set_meta("reminders", s.model_dump_json())
        return s

    @property
    def _secret(self) -> bytes:
        """Signs one-tap action links. Stable across instances when a server secret is configured."""
        for candidate in (self.settings.cron_secret, self.settings.keeper_access_key, self.settings.database_url):
            if candidate and candidate.get_secret_value():
                return hashlib.sha256(b"keeper-actions|" + candidate.get_secret_value().encode()).digest()
        if not hasattr(self, "_ephemeral_secret"):
            self._ephemeral_secret = secrets.token_bytes(32)
        return self._ephemeral_secret

    def action_url(self, base_url: str, entry_id: str, key: str, action: str) -> str:
        token = notify.sign(self._secret, entry_id, key)
        return f"{base_url.rstrip('/')}/api/keeper/act?a={action}&t={token}"

    def offset(self) -> int:
        return int(self.store.get_meta("tz_offset") or 0)

    # ── acknowledging alerts ──────────────────────────────────────────────
    def ack(self, entry_id: str, key: str) -> Entry | None:
        e = self.store.get(entry_id)
        if e is None:
            return None
        return self.store.update(entry_id, {"data": reminders.remember(e.data, "acked", [key])})

    def snooze(self, entry_id: str, minutes: int, key: str | None = None) -> Entry | None:
        e = self.store.get(entry_id)
        if e is None:
            return None
        until = (dt.datetime.now(dt.UTC) + dt.timedelta(minutes=minutes)).replace(tzinfo=None)
        data = {**e.data, "snooze_until": until.isoformat(timespec="minutes")}
        if key:
            data = reminders.remember(data, "acked", [key])
        return self.store.update(entry_id, {"data": data})

    def complete(self, entry_id: str) -> Entry | None:
        e = self.store.get(entry_id)
        if e is None:
            return None
        changes = schedule.on_done(e, schedule.local_now(self.offset()))
        changes["data"] = {k: v for k, v in changes.get("data", e.data).items() if k != "snooze_until"}
        return self.store.update(entry_id, changes)

    def act(self, token: str, action: str) -> Entry | None:
        """Apply a one-tap action from a notification link. None when the link is invalid or expired."""
        found = notify.verify(self._secret, token)
        if found is None or action not in notify.ACTIONS:
            return None
        entry_id, key = found
        if action == "done":
            return self.complete(entry_id)
        if action == "snooze":
            return self.snooze(entry_id, 10, key)
        return self.ack(entry_id, key)

    def due_alerts(self) -> list[Alert]:
        now = dt.datetime.now(dt.UTC).replace(tzinfo=None)
        return reminders.due_now(self.store.list(), now, self.offset())

    # ── phone delivery ────────────────────────────────────────────────────
    @property
    def phone_ready(self) -> bool:
        s = self.reminder_settings()
        return bool(s.ntfy_topic or (s.telegram and self.telegram_ready))

    async def _deliver(
        self, title: str, text: str, s: ReminderSettings, *, urgent: bool = False,
        links: list[tuple[str, str]] | None = None,
    ) -> list[str]:  # fmt: skip
        """Send to every configured free channel; returns the channels that accepted it."""
        sent: list[str] = []
        async with httpx.AsyncClient(timeout=15) as client:
            if s.ntfy_topic:
                actions = [
                    {"action": "http", "label": label, "url": url, "method": "POST", "clear": True}
                    for label, url in links or []
                ]
                try:
                    await notify.send_ntfy(
                        client, s.ntfy_server, s.ntfy_topic, title, text, urgent=urgent, actions=actions
                    )
                    sent.append("ntfy")
                except httpx.HTTPError as exc:
                    logger.warning("ntfy delivery failed: %s", type(exc).__name__)
            if s.telegram and self.telegram_ready:
                # Telegram link buttons must be https (they open the link in a browser).
                buttons = [(label, url) for label, url in links or [] if url.startswith("https://")]
                try:
                    await notify.send_telegram(
                        client,
                        self.settings.telegram_bot_token.get_secret_value(),  # type: ignore[union-attr]
                        str(self.settings.telegram_chat_id),
                        f"{title}\n\n{text}",
                        buttons,
                    )
                    sent.append("telegram")
                except httpx.HTTPError as exc:
                    logger.warning("Telegram delivery failed: %s", type(exc).__name__)
        return sent

    async def push_alert(self, a: Alert, base_url: str, s: ReminderSettings) -> list[str]:
        links = [
            ("Done", self.action_url(base_url, a.entry.id, a.key, "done")),
            ("Snooze 10 min", self.action_url(base_url, a.entry.id, a.key, "snooze")),
        ]
        text = " · ".join(filter(None, [a.entry.due_time, a.entry.note, a.entry.place])) or "Keeper reminder"
        title = f"{'⚠ ' if a.urgent else ''}{a.label}"
        return await self._deliver(title, text, s, urgent=a.urgent, links=links)

    async def send_telegram(self, text: str) -> None:
        """Daily brief to Telegram (the manual "send now" button)."""
        async with httpx.AsyncClient(timeout=15) as client:
            await notify.send_telegram(
                client,
                self.settings.telegram_bot_token.get_secret_value(),  # type: ignore[union-attr]
                str(self.settings.telegram_chat_id),
                f"Keeper · daily brief\n\n{text}",
            )

    async def test_channels(self, s: ReminderSettings) -> list[str]:
        return await self._deliver("Keeper test", "Reminders will arrive here.", s)

    # ── the scheduler tick (every minute: cron on serverless hosts, a loop elsewhere) ─
    async def tick(self, base_url: str) -> dict[str, Any]:
        s = self.reminder_settings()
        offset = self.offset()
        now_utc = dt.datetime.now(dt.UTC).replace(tzinfo=None)
        send, skip = reminders.to_push(self.store.list(), now_utc, offset, s)
        sent = 0
        for a in send:
            channels = await self.push_alert(a, base_url, s)
            if channels or not self.phone_ready:  # no channel configured: don't retry the same alert forever
                skip.setdefault(a.entry.id, []).append(a.key)
            sent += bool(channels)
        for entry_id, keys in skip.items():
            if e := self.store.get(entry_id):
                self.store.update(entry_id, {"data": reminders.remember(e.data, "notified", keys)})

        brief = "skipped"
        local = schedule.local_now(offset)
        today = local.date().isoformat()
        brief_due = s.brief_push and local.hour >= s.brief_hour and self.store.get_meta("brief_sent") != today
        if brief_due and self.phone_ready:
            b = await self.brief(local)
            if await self._deliver("Keeper · your day", b["text"], s):
                self.store.set_meta("brief_sent", today)
                brief = "sent"
        return {"alerts_sent": sent, "alerts_due": len(send), "brief": brief}

    async def scheduler_loop(self, base_url: str) -> None:
        """Always-on hosts (Docker, local): run the tick every minute. Serverless hosts call /tick from a cron."""
        while True:
            try:
                await self.tick(base_url)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("Keeper tick failed")
            await asyncio.sleep(60)
