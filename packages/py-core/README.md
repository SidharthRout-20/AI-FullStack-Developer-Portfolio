# appcore (Python)

The shared platform the portfolio's products are built on. Products depend on it; it depends on no product.

| Module | What it gives you |
| --- | --- |
| `appcore.settings` | `CoreSettings`: environment, CORS, database URL discovery (any Neon/Vercel variable name), LLM and security settings. Apps subclass it. |
| `appcore.db` | One SQL layer for SQLite (local) and Postgres (Neon): each store is a Postgres schema, tables are created on start, idle connections are checked and replaced. |
| `appcore.docstore` | A JSON document store on top of it (collections, parent/child documents, small blobs). |
| `appcore.llm` | The central Groq router (task classification, model discovery, quota, fallback) and model clients (Groq, Claude, Ollama). Products declare tasks with `register_tasks`. |
| `appcore.llm.structured` | JSON → Pydantic with one repair retry. |
| `appcore.ai` | Product helpers: `ask_json`, `ask_text`, safe error text, SSE framing, lenient output schemas. |
| `appcore.guardrails` | Cheap prompt-injection heuristics and input normalisation. |
| `appcore.security` | Security headers middleware, rate limiter, admin-key check (`use_settings` points them at the app's settings). |
| `appcore.errors` | `ErrorsAsJSON`: unexpected errors become JSON 500s that still carry CORS headers. |
| `appcore.logs`, `appcore.tls` | Logging setup; the OS certificate store for outbound TLS. |

Use it from an app:

```python
from appcore.settings import CoreSettings
from appcore.llm.classify import Complexity, TaskProfile, register_tasks


class MySettings(CoreSettings):
    app_name: str = "My product"


register_tasks({"myproduct.summarise": TaskProfile(Complexity.STANDARD, "summarisation", "json")}, {"myproduct": 3})
```

Install in place: `pip install -e packages/py-core`. It is tested through the apps that use it (`backend/tests`,
`products/*/api/tests`); `ruff check` and `ruff format --check` run here in CI.
