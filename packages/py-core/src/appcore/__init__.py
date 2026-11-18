"""appcore: the shared platform under the portfolio's products.

Database layer (SQLite locally, Postgres/Neon in production), JSON document store, the central Groq LLM router and
model clients, structured output, input guardrails, HTTP security headers and rate limiting, and settings.
Products build on it and register their own LLM tasks (`appcore.llm.classify.register_tasks`).
"""
