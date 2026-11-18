"""Safarnaama: plan, book and keep every journey in one place (FastAPI service).

Importing the package registers Safarnaama's LLM tasks with appcore's router. The HTTP API is `safarnama.api.router`;
`safarnama.main.create_app` runs it as a standalone service.
"""

from safarnama import tasks as _tasks  # noqa: F401  (registers the LLM tasks)
