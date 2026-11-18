"""Shared fixtures: an isolated app with a fake embedder + fake LLM.

Tests never download models or call external APIs → fast, deterministic, free in CI.
"""

from __future__ import annotations

import hashlib
import itertools
import os

os.environ["ENVIRONMENT"] = "test"  # disables rate limiting; must precede app imports

import numpy as np
import pytest
from fastapi.testclient import TestClient
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

from app.config import Settings
from app.main import create_app
from app.rag.retriever import tokenize
from app.rag.service import RAGService
from appcore.llm.chat import LangChainLLM

DIM = 256
FAKE_ANSWER = "The candidate knows Python and FastAPI [1]."


class FakeEmbedder:
    """Hashed bag-of-words vectors: similar wording → high cosine similarity."""

    def _vec(self, text: str) -> np.ndarray:
        v = np.zeros(DIM, dtype=np.float32)
        for tok in tokenize(text):
            v[int(hashlib.md5(tok.encode()).hexdigest(), 16) % DIM] += 1.0
        n = np.linalg.norm(v)
        return v / n if n else v

    def embed_documents(self, texts):
        return np.stack([self._vec(t) for t in texts]) if texts else np.zeros((0, DIM), np.float32)

    def embed_query(self, text):
        return self._vec(text)


def fake_llm_factory(_settings: Settings):
    return LangChainLLM(GenericFakeChatModel(messages=itertools.cycle([AIMessage(content=FAKE_ANSWER)])))


@pytest.fixture
def settings(tmp_path) -> Settings:
    docs = tmp_path / "documents"
    docs.mkdir()
    (docs / "resume.md").write_text(
        "# Skills\nPython, FastAPI, React, TypeScript, LangGraph, Docker.\n\n"
        "# Experience\nSenior engineer building retrieval augmented generation systems.\n",
        encoding="utf-8",
    )
    (docs / "notes.txt").write_text("Education: BTech in Computer Science.", encoding="utf-8")
    return Settings(
        _env_file=None,
        environment="test",
        documents_dir=docs,
        data_dir=tmp_path / "data",
        serve_frontend=False,
        relevance_threshold=0.2,
        relevance_margin=0.5,
        admin_api_key=None,
    )


@pytest.fixture
def service_factory():
    return lambda s: RAGService(s, llm_factory=fake_llm_factory, embedder=FakeEmbedder())


@pytest.fixture
def client(settings, service_factory):
    app = create_app(settings, service_factory=service_factory)
    with TestClient(app) as c:
        yield c
