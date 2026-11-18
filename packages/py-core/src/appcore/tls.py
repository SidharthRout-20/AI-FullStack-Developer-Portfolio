"""Outbound TLS: verify certificates against the operating-system trust store.

Python normally uses its own CA bundle (certifi). On machines behind corporate proxies or antivirus
"HTTPS inspection", the inspecting CA is trusted by the OS but not by certifi, so calls to LLM APIs
fail with CERTIFICATE_VERIFY_FAILED. `truststore` makes Python's `ssl` use the OS store instead:
verification stays ON (we never disable it), it just trusts what the OS trusts.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)
_done = False


def use_system_certificates() -> None:
    global _done
    if _done:
        return
    try:
        import truststore

        truststore.inject_into_ssl()
        _done = True
    except Exception as exc:  # pragma: no cover - optional hardening, never fatal
        logger.warning("Could not enable OS certificate store (%s); using certifi", type(exc).__name__)
