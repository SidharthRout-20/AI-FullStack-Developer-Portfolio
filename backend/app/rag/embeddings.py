"""Local, free embeddings via FastEmbed (ONNX Runtime — no PyTorch, no GPU, no API).

`bge-small-en-v1.5` is a 384-dim model (~130 MB) with strong retrieval quality.
FastEmbed returns L2-normalised vectors, so a dot product == cosine similarity.
"""

from __future__ import annotations

import threading
from collections.abc import Sequence

import numpy as np
from fastembed import TextEmbedding

from app.config import Settings


class Embedder:
    def __init__(self, settings: Settings) -> None:
        settings.model_cache_dir.mkdir(parents=True, exist_ok=True)
        self._model = TextEmbedding(
            model_name=settings.embedding_model,
            cache_dir=str(settings.model_cache_dir),
        )
        # ONNX sessions are thread-safe for inference, but we serialise to keep
        # memory flat on small free-tier containers.
        self._lock = threading.Lock()

    def embed_documents(self, texts: Sequence[str]) -> np.ndarray:
        with self._lock:
            return np.array(list(self._model.passage_embed(list(texts))), dtype=np.float32)

    def embed_query(self, text: str) -> np.ndarray:
        # query_embed adds the model-specific query instruction prefix for BGE.
        with self._lock:
            return np.array(next(iter(self._model.query_embed(text))), dtype=np.float32)
