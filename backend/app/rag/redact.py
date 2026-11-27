"""Client confidentiality: the names of clients served through an employer never reach the site.

The résumé names them; the site must not. Redacting the text as it is indexed means retrieval, chat answers, Tara's
portfolio answers, citations and document briefs only ever see the neutral description. Employers (Deloitte, Wipro)
are not clients and stay.

Changing this list changes REDACTION_VERSION, which makes the next ingest re-index every document (see ingestion.py).
"""

from __future__ import annotations

import hashlib
import re

# name pattern → what the site says instead. "HP" is matched case-sensitively (as a word), the rest in any case.
CLIENTS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bHewlett[- ]Packard\b", re.I), "a global technology client"),
    (re.compile(r"\bHP\b"), "a global technology client"),
    (re.compile(r"\bTelef[oó]nica\b", re.I), "a European telecom client"),
    (re.compile(r"\bHSBC\b", re.I), "a global bank"),
    (re.compile(r"\bUSAA\b", re.I), "a US financial-services client"),
]

REDACTION_VERSION = hashlib.sha256(repr([(p.pattern, r) for p, r in CLIENTS]).encode()).hexdigest()[:8]


def redact_clients(text: str) -> str:
    for pattern, neutral in CLIENTS:
        text = pattern.sub(neutral, text)
    return text
