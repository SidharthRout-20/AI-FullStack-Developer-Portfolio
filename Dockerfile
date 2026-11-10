# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# DocuMind — single-image deployment (React build served by FastAPI).
# Works on Hugging Face Spaces (Docker SDK), Render, Railway, Fly.io, or any VM.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build the React frontend ───────────────────────────────────────
FROM node:24-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Python runtime ─────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ENVIRONMENT=production \
    PORT=7860

# Run as an unprivileged user (uid 1000 is also what HF Spaces expects).
RUN useradd --create-home --uid 1000 appuser
WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install -r backend/requirements.txt

COPY --chown=appuser:appuser backend/app backend/app
COPY --chown=appuser:appuser documents documents
COPY --from=frontend --chown=appuser:appuser /build/dist frontend/dist
RUN mkdir -p backend/data && chown -R appuser:appuser backend/data

USER appuser
WORKDIR /app/backend

# Bake the embedding model + index into the image → fast, offline cold starts.
RUN python -c "from app.config import get_settings; from app.rag.service import RAGService; RAGService(get_settings()).ingest()"

EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"7860\")}/api/health', timeout=4)"

# --proxy-headers: trust X-Forwarded-For from the platform's load balancer so
# rate limiting sees real client IPs. Single worker keeps BM25 index & rate-limit
# counters consistent (scale out with replicas + Redis-backed limiter if needed).
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*' --workers 1"]
