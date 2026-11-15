"""Reading photos: labels, warranty cards, receipts, documents.

Same strategy as the text LLMs: one tiny protocol, one implementation per provider, picked by config.
Groq serves an open-weight vision model on its free tier; Claude reads images natively.
"""

from __future__ import annotations

import base64
import logging
from typing import Protocol

from app.config import Settings
from app.rag.llm import LLMNotConfiguredError

logger = logging.getLogger(__name__)


class VisionLLM(Protocol):
    async def read(self, image: bytes, mime: str, prompt: str) -> str: ...


class GroqVision:
    """Photos are read by whichever free-tier Groq model the central router verifies as vision-capable
    (today qwen/qwen3.8-27b, a preview model). A text-only model can never be selected for an image."""

    def __init__(self, settings: Settings, task: str = "keeper.photo") -> None:
        from app.llm import get_router

        if settings.groq_api_key is None or not settings.groq_api_key.get_secret_value():
            raise LLMNotConfiguredError("Reading photos needs GROQ_API_KEY (free at https://console.groq.com/keys).")
        self._router = get_router(settings)
        self._task = task

    async def read(self, image: bytes, mime: str, prompt: str) -> str:
        from app.llm import LLMRequest

        res = await self._router.execute_request(
            LLMRequest(
                task=self._task,
                messages=[{"role": "user", "content": prompt}],
                images=[(mime, image)],
                max_output_tokens=1024,
                temperature=0.1,
            )
        )
        return res.text


class ClaudeVision:
    def __init__(self, settings: Settings) -> None:
        import anthropic

        key = settings.anthropic_api_key.get_secret_value() if settings.anthropic_api_key else None
        self._client = anthropic.AsyncAnthropic(api_key=key, timeout=settings.llm_timeout_s, max_retries=2)
        self._model = settings.claude_model

    async def read(self, image: bytes, mime: str, prompt: str) -> str:
        msg = await self._client.messages.create(
            model=self._model,
            max_tokens=4096,
            output_config={"effort": "low"},
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {"type": "base64", "media_type": mime, "data": base64.b64encode(image).decode()},
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
        )
        return "".join(b.text for b in msg.content if b.type == "text")


def build_vision(settings: Settings) -> VisionLLM:
    if settings.llm_provider == "anthropic":
        return ClaudeVision(settings)
    if settings.llm_provider == "groq":
        return GroqVision(settings)
    raise LLMNotConfiguredError("Reading photos needs LLM_PROVIDER=groq or anthropic (Ollama is text-only here).")


SCAN_PROMPT = """You are helping a personal assistant file a photo the user just took.
Today is {today}. The user hinted this photo is: {hint}.

Decide what it is and reply with ONE JSON object only:
{{
  "kind": "expiry" | "appliance" | "pantry" | "bill" | "stash",
  "title": "short name, e.g. 'Passport', 'LG washing machine', 'Groceries receipt'",
  "caption": "one sentence describing what is visible (used for search later)",
  "date": "YYYY-MM-DD or null (expiry / warranty end / bill due date)",
  "category": "id | insurance | vehicle | warranty | card | other (expiry only, else null)",
  "model": "appliance model number from the label, or null",
  "amount": number or null (bills/receipts total),
  "items": ["item names bought, receipts only"]
}}
Rules: kind=expiry for IDs, cards, policies, warranty cards; appliance for rating plates / product labels;
pantry for grocery receipts or food items; bill for invoices/bills; otherwise stash (an object being put away).
Never invent a date or model that is not visible; use null."""
