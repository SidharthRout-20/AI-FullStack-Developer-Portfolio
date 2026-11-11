"""Request/response contracts. Strict validation is a security control:
unknown fields are rejected and every string has a hard length cap."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.rag.guardrails import normalize


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ChatMessage(_Strict):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)

    @field_validator("content")
    @classmethod
    def _clean(cls, v: str) -> str:
        return normalize(v)


class ChatRequest(_Strict):
    question: str = Field(min_length=1, max_length=1000)
    history: list[ChatMessage] = Field(default_factory=list, max_length=20)

    @field_validator("question")
    @classmethod
    def _clean_question(cls, v: str) -> str:
        v = normalize(v)
        if not v:
            raise ValueError("question must not be blank")
        return v


class Source(BaseModel):
    id: int
    source: str
    page: int
    similarity: float
    snippet: str


class TraceStep(BaseModel):
    node: str
    ms: float


class ChatResponse(BaseModel):
    answer: str
    route: str | None
    sources: list[Source]
    trace: list[TraceStep]


class DocumentInfo(BaseModel):
    source: str
    chunks: int
    pages: int


class HealthResponse(BaseModel):
    status: Literal["ok"]
    chunks_indexed: int
    llm_provider: str
    llm_model: str
    llm_ready: bool
    index_version: int = 1
    last_ingest: dict | None = None


class GraphNode(BaseModel):
    id: str
    label: str
    description: str


class GraphEdge(BaseModel):
    source: str
    target: str
    conditional: bool


class GraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


class IngestResponse(BaseModel):
    added: list[str]
    updated: list[str]
    removed: list[str]
    failed: list[str] = []
    unchanged: int
    chunks_written: int
