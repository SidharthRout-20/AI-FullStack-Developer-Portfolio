"""Used by .github/workflows/tara-edit.yml. Two commands:

    python .github/scripts/tara_proposal.py apply   # apply the small edits in $EDITS (JSON) exactly, or fail
    python .github/scripts/tara_proposal.py guard   # the final diff: not empty, nothing off limits, small stays small

Standard library only. PROTECTED must match backend/app/keeper/edits.py (a backend test checks).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

PROTECTED = re.compile(
    r"(^|/)(\.github/|\.env|\.vercel|vercel\.json$|index\.py$|Dockerfile$|docker-compose|requirements[^/]*\.txt$|"
    r"package(-lock)?\.json$|pyproject\.toml$|.*\.lock$)|(^|/)(appcore/(accounts|security|settings)\.py)$|"
    r"(^|/)backend/app/(config|keeper/edits|api/edits|api/cron)\.py$"
)
MAX_FILES, MAX_CHANGED_LINES = 4, 200


def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)


def apply() -> None:
    edits = json.loads(os.environ.get("EDITS") or "[]")
    if not edits:
        fail("No edits were given.")
    for e in edits:
        path = str(e["path"])
        if ".." in path.split("/") or path.startswith("/") or PROTECTED.search(path):
            fail(f"{path} is off limits.")
        p = Path(path)
        if not p.is_file():
            fail(f"{path} doesn't exist on main.")
        text = p.read_text(encoding="utf-8")
        if text.count(e["find"]) != 1:
            fail(f"An edit to {path} no longer matches main exactly once; ask Tara to plan it again.")
        p.write_text(text.replace(e["find"], e["replace"], 1), encoding="utf-8")
        print(f"edited {path}")


def guard() -> None:
    subprocess.run(["git", "add", "-A"], check=True)
    names = subprocess.run(["git", "diff", "--cached", "--name-only"], check=True, capture_output=True, text=True)
    files = [f for f in names.stdout.splitlines() if f]
    if not files:
        fail("Nothing changed, so there is nothing to propose.")
    if bad := [f for f in files if PROTECTED.search(f)]:
        fail(f"Off-limits files changed: {', '.join(bad)}")
    if os.environ.get("MODE") == "small":
        stat = subprocess.run(["git", "diff", "--cached", "--numstat"], check=True, capture_output=True, text=True)
        lines = sum(int(a) + int(b) for a, b, _ in (ln.split("\t") for ln in stat.stdout.splitlines()) if a.isdigit())
        if len(files) > MAX_FILES or lines > MAX_CHANGED_LINES:
            fail(f"A small change grew to {len(files)} files / {lines} lines.")
    print("changed:", ", ".join(files))


if __name__ == "__main__":
    {"apply": apply, "guard": guard}[sys.argv[1]]()
