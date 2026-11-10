from __future__ import annotations

import logging
import sys


def configure_logging(level: str = "INFO") -> None:
    if hasattr(sys.stdout, "reconfigure"):  # Windows consoles default to cp1252
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(
        level=level.upper(),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        stream=sys.stdout,
        force=True,
    )
    # Third-party libraries are chatty at INFO.
    for noisy in ("httpx", "chromadb", "urllib3", "fastembed"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
