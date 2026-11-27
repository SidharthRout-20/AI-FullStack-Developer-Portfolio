"""Central Groq LLM routing layer. Application code asks for a *task*, never a model ID:

    llm = routed_llm(settings, "tripweaver.plan")      # a ChatLLM (complete / stream), routed per call
    result = await get_router(settings).execute_request(LLMRequest(task="keeper.photo", images=[...], ...))

One router per process (per Settings object) so quota state, discovery and the decision log are shared.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from typing import TYPE_CHECKING, Any

from appcore.llm.classify import TASKS, Complexity, LLMRequest, classify_request
from appcore.llm.router import LLMRouter, NoCompatibleModelError, RouterError, RouterResult

if TYPE_CHECKING:
    from appcore.settings import CoreSettings as Settings

__all__ = [
    "TASKS", "Complexity", "LLMRequest", "LLMRouter", "NoCompatibleModelError", "RoutedLLM", "RouterError",
    "RouterResult", "classify_request", "for_task", "get_router", "routed_llm",
]  # fmt: skip

_ROUTERS: dict[int, tuple[Any, LLMRouter]] = {}


def get_router(settings: Settings) -> LLMRouter:
    entry = _ROUTERS.get(id(settings))
    if entry is None or entry[0] is not settings:  # id reuse after garbage collection
        entry = (settings, LLMRouter(settings))
        _ROUTERS[id(settings)] = entry
    return entry[1]


class RoutedLLM:
    """`ChatLLM` implementation backed by the router, bound to one task."""

    def __init__(self, router: LLMRouter, task: str) -> None:
        self.router, self.task = router, task
        self.last: RouterResult | None = None

    def for_task(self, task: str) -> RoutedLLM:
        return RoutedLLM(self.router, task)

    def _req(self, system: str | None, messages: Sequence[Any], short: bool) -> LLMRequest:
        return LLMRequest(
            task=self.task,
            system=system,
            messages=[{"role": m["role"], "content": m["content"]} for m in messages],
            complexity=Complexity.SIMPLE if short else None,
        )

    async def complete(self, system: str | None, messages: Sequence[Any], *, short: bool = False) -> str:
        self.last = await self.router.execute_request(self._req(system, messages, short))
        return self.last.text

    async def stream(self, system: str | None, messages: Sequence[Any]) -> AsyncIterator[str]:
        async for chunk in self.router.stream_request(self._req(system, messages, False)):
            yield chunk


def routed_llm(settings: Settings, task: str) -> RoutedLLM:
    router = get_router(settings)
    if not router.configured:
        _ = router.transport  # raises LLMNotConfiguredError with the setup hint
    return RoutedLLM(router, task)


def for_task(llm: Any, task: str) -> Any:
    """Re-bind an LLM that routes per task (the Groq router, the control room's switch) to a declared task; any other
    ChatLLM (tests, Ollama, Claude) is returned unchanged."""
    bind = getattr(llm, "for_task", None)
    return bind(task) if callable(bind) else llm
