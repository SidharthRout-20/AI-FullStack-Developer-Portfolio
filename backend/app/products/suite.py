"""Wires every product service to shared infrastructure (one LLM client, one local embedder, per-product stores)."""

from __future__ import annotations

from app.config import Settings
from app.core.docstore import DocStore
from app.keeper.schedule import local_now
from app.keeper.service import KeeperService
from app.products.careerpilot import CareerService
from app.products.codelens import CodeService
from app.products.evolve import EvolveService
from app.products.flowforge import FlowService
from app.products.meetingmind import MeetingService
from app.products.tripweaver import TripService
from app.rag.service import RAGService


class Suite:
    def __init__(self, settings: Settings, rag: RAGService, keeper: KeeperService) -> None:
        data = settings.data_dir

        async def keeper_command(text: str) -> str:  # FlowForge → Keeper integration
            offset = int(keeper.store.get_meta("tz_offset") or 0)
            state = await keeper.agent.run(text, local_now(offset))
            return state["reply"]

        self.career = CareerService(
            DocStore(data / "careerpilot.sqlite3"), rag.get_llm, settings.documents_dir, settings.max_file_mb
        )
        self.meetings = MeetingService(DocStore(data / "meetingmind.sqlite3"), rag.get_llm, rag.embedder, settings)
        self.code = CodeService(DocStore(data / "codelens.sqlite3"), rag.get_llm, rag.embedder, data / "codelens")
        self.flows = FlowService(DocStore(data / "flowforge.sqlite3"), rag.get_llm, keeper_command)
        self.trips = TripService(DocStore(data / "tripweaver.sqlite3"), rag.get_llm)
        self.evolve = EvolveService(DocStore(data / "evolve.sqlite3"), rag.get_llm)
        self.inbox = DocStore(data / "contact.sqlite3")  # portfolio contact form
        self.settings = settings
