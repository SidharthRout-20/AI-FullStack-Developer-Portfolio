"""Tara proposes code changes to this portfolio, as pull requests a human approves. Owner only.

The flow, end to end:
1. **Plan** (here, on the backend). Tara finds the code a request is about (the same read-only index it answers code
   questions from) and asks the model for the change. A small, clear change comes back as exact find-and-replace
   edits, checked here and shown to the owner as a diff. Anything bigger is handed to Claude Code instead.
2. **Propose** (GitHub Actions, `.github/workflows/tara-edit.yml`). On the owner's go-ahead, the backend only starts
   that workflow: it applies the small edits (re-checked against the latest code) or runs Claude Code on the owner's
   subscription for a larger change, then commits to the single `tara/proposals` branch as the Tara bot and opens the
   pull request. One proposal is open at a time.
3. **Check**. CI runs on the pull request, and `.github/workflows/tara-review.yml` has Claude Code review it against
   the request and the repository's structure.
4. **Decide**. The owner approves and merges on GitHub (branch protection). Nothing here can merge.

The backend never holds a Claude credential or write access to the code: its GitHub token can only start workflows
and read pull requests. Secrets, workflows, deployment and dependency files are off limits in both paths.
"""

from __future__ import annotations

import asyncio
import difflib
import hashlib
import hmac
import json
import re
import secrets
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field, field_validator

from app.keeper.repo import RepoIndex

BRANCH = "tara/proposals"
WORKFLOW = "tara-edit.yml"
MAX_FILES = 4
MAX_CHANGED_LINES = 200
# Never edited by Tara, in either path (the workflow enforces the same list on the final diff).
PROTECTED = re.compile(
    r"(^|/)(\.github/|\.env|\.vercel|vercel\.json$|index\.py$|Dockerfile$|docker-compose|requirements[^/]*\.txt$|"
    r"package(-lock)?\.json$|pyproject\.toml$|.*\.lock$)|(^|/)(appcore/(accounts|security|settings)\.py)$|"
    r"(^|/)backend/app/(config|keeper/edits|api/edits|api/cron)\.py$"
)

PLAN_SYSTEM = """You change the source code of a portfolio web app (FastAPI backend in backend/app, React frontend in
frontend/src, shared packages in packages/, products in products/). The owner asked for a change. You are shown the
most relevant pieces of code, each with its file path.

Decide the size:
- "small": a clear change confined to the code shown, at most 4 files and about 200 changed lines, where you can
  write exact edits. Each edit replaces one exact, unique snippet ("find", copied character for character from the code
  shown, including indentation, long enough to be unique) with new text ("replace"). Keep the existing style.
- "large": anything else (needs code not shown, new files across areas, refactors, unclear scope).
Never touch secrets, environment files, CI workflows, deployment config or dependency files.

Reply with ONE JSON object: {"size": "small"|"large", "summary": one sentence describing the change,
"edits": [{"path": "...", "find": "...", "replace": "..."}] (only for small), "reason": why (for large)}"""


class Edit(BaseModel):
    path: str = Field(max_length=200)
    find: str = Field(min_length=1, max_length=6000)
    replace: str = Field(max_length=8000)

    @field_validator("path")
    @classmethod
    def _path(cls, v: str) -> str:
        v = v.strip().removeprefix("./")  # only a "./" prefix: a leading dot (.github, .env) must stay
        if ".." in v.split("/") or v.startswith("/") or "\\" in v:
            raise ValueError("bad path")
        return v


class Plan(BaseModel):
    size: Literal["small", "large"]
    summary: str = Field("", max_length=300)
    edits: list[Edit] = Field(default_factory=list, max_length=8)
    reason: str | None = Field(None, max_length=400)


class EditError(Exception):
    """Something the owner should be told plainly (nothing was changed)."""


def check_edits(root: Path, edits: list[Edit]) -> list[dict[str, Any]]:
    """Apply edits to copies of the files and return per-file diffs; raise EditError if anything is off."""
    if not edits:
        raise EditError("The plan had no edits.")
    files: dict[str, str] = {}
    for e in edits:
        if PROTECTED.search(e.path):
            raise EditError(f"{e.path} is off limits for Tara (secrets, CI, deployment or dependencies).")
        if e.path not in files:
            p = root / e.path
            if not p.is_file():
                raise EditError(f"{e.path} doesn't exist.")
            files[e.path] = p.read_text(encoding="utf-8")
    if len(files) > MAX_FILES:
        raise EditError(f"That touches {len(files)} files; small changes stay within {MAX_FILES}.")
    new = dict(files)
    for e in edits:
        n = new[e.path].count(e.find)
        if n != 1:
            raise EditError(
                f"An edit to {e.path} doesn't match the code exactly once ({n} matches), so it wasn't used."
            )
        new[e.path] = new[e.path].replace(e.find, e.replace, 1)
    out, changed = [], 0
    for path, before in files.items():
        diff = list(
            difflib.unified_diff(before.splitlines(), new[path].splitlines(), f"a/{path}", f"b/{path}", lineterm="")
        )
        changed += sum(1 for ln in diff if ln[:1] in "+-" and not ln.startswith(("+++", "---")))
        out.append({"path": path, "diff": "\n".join(diff)})
    if changed > MAX_CHANGED_LINES:
        raise EditError(f"That's {changed} changed lines; small changes stay under {MAX_CHANGED_LINES}.")
    return out


GitHub = Callable[[str, str, dict[str, Any] | None], Awaitable[httpx.Response]]


class Edits:
    """Owner-only planning and proposing. Disabled (503) until TARA_OWNER_KEY and the GitHub settings are set."""

    def __init__(
        self, settings: Any, repo: RepoIndex, get_llm: Callable[[], Any], github: GitHub | None = None
    ) -> None:
        self.settings = settings
        self.repo = repo
        self._get_llm = get_llm
        self._github = github

    # ── access ──────────────────────────────────────────────────────────
    @property
    def ready(self) -> bool:
        return bool(
            _secret(self.settings.tara_owner_key)
            and _secret(self.settings.tara_github_token)
            and self.settings.tara_repo
        )

    def is_owner(self, key: str | None) -> bool:
        want = _secret(self.settings.tara_owner_key)
        return bool(want and key and secrets.compare_digest(key, want))

    # ── plan ────────────────────────────────────────────────────────────
    async def plan(self, request: str) -> dict[str, Any]:
        from appcore.llm import for_task
        from appcore.llm.structured import complete_json

        hits = await asyncio.to_thread(self.repo.search, request, 5, 2)
        context = "\n\n".join(f"FILE {h['path']} (lines {h['start']}-{h['end']}):\n{h['text'][:2500]}" for h in hits)
        try:
            plan = await asyncio.wait_for(
                complete_json(for_task(self._get_llm(), "tara.edit"), PLAN_SYSTEM,
                              f"REQUEST: {request}\n\nRELEVANT CODE:\n{context or '(nothing matched)'}", Plan),
                60,
            )  # fmt: skip
        except Exception:  # noqa: BLE001 - no model, or no usable plan: Claude Code can still take it
            plan = Plan(size="large", summary=request[:300], reason="I couldn't plan it here, so Claude Code will.")
        out: dict[str, Any] = {"request": request, "size": plan.size, "summary": plan.summary,
                               "files": [h["path"] for h in hits], "edits": []}  # fmt: skip
        if plan.size == "small":
            try:
                out["diffs"] = check_edits(self.repo.root, plan.edits)
                out["edits"] = [e.model_dump() for e in plan.edits]
            except EditError as exc:  # a plan that doesn't apply cleanly goes to Claude Code rather than guessed at
                out |= {"size": "large", "reason": f"{exc} Claude Code will make this change instead."}
        else:
            out["reason"] = plan.reason or "This needs more than a small, exact edit."
        out["issued"] = int(time.time())
        out["token"] = self._sign(out)  # the go-ahead comes back with this plan, unchanged (serverless: no session)
        return out

    # ── propose ─────────────────────────────────────────────────────────
    async def propose(self, plan: dict[str, Any]) -> dict[str, Any]:
        """Start the workflow for a plan this backend issued (signed) in the last 30 minutes, re-checked first."""
        token = str(plan.get("token") or "")
        if not token or not hmac.compare_digest(token, self._sign(plan)):
            raise EditError("That plan wasn't made here or was changed. Ask again and I'll plan it afresh.")
        if time.time() - int(plan.get("issued") or 0) > 1800:
            raise EditError("That plan has expired. Ask again and I'll plan it afresh.")
        if plan["size"] == "small":
            check_edits(self.repo.root, [Edit(**e) for e in plan["edits"]])
        if open_pr := await self.open_proposal():
            raise EditError(
                f"A proposal is already open (#{open_pr['number']}). Merge or close it first: one at a time."
            )
        inputs = {
            "request": plan["request"][:2000],
            "mode": plan["size"],
            "edits": json.dumps(plan.get("edits") or [])[:60000],
        }
        r = await self._gh("POST", f"/repos/{self.settings.tara_repo}/actions/workflows/{WORKFLOW}/dispatches",
                           {"ref": "main", "inputs": inputs})  # fmt: skip
        if r.status_code not in (200, 204):
            raise EditError(
                f"GitHub didn't start the workflow ({r.status_code}). Check TARA_GITHUB_TOKEN's Actions access."
            )
        return {"started": True, "mode": plan["size"], "branch": BRANCH,
                "runs": f"https://github.com/{self.settings.tara_repo}/actions/workflows/{WORKFLOW}"}  # fmt: skip

    async def open_proposal(self) -> dict[str, Any] | None:
        owner = self.settings.tara_repo.split("/")[0]
        r = await self._gh("GET", f"/repos/{self.settings.tara_repo}/pulls?state=open&head={owner}:{BRANCH}", None)
        if r.status_code != 200:
            raise EditError(f"Couldn't read pull requests from GitHub ({r.status_code}).")
        prs = r.json()
        if not prs:
            return None
        pr = prs[0]
        return {"number": pr["number"], "url": pr["html_url"], "title": pr["title"], "draft": pr.get("draft", False)}

    # ── helpers ─────────────────────────────────────────────────────────
    async def _gh(self, method: str, path: str, body: dict[str, Any] | None) -> httpx.Response:
        if self._github is not None:
            return await self._github(method, path, body)
        headers = {"Authorization": f"Bearer {_secret(self.settings.tara_github_token)}",
                   "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                   "User-Agent": "TaraAssistant/1.0"}  # fmt: skip
        async with httpx.AsyncClient(base_url="https://api.github.com", timeout=15, headers=headers) as c:
            return await c.request(method, path, json=body)

    def _sign(self, plan: dict[str, Any]) -> str:
        body = json.dumps({k: plan.get(k) for k in ("request", "size", "edits", "issued")}, sort_keys=True)
        key = ("tara-edit:" + _secret(self.settings.tara_owner_key)).encode()
        return hmac.new(key, body.encode(), hashlib.sha256).hexdigest()


def _secret(v: Any) -> str:
    return v.get_secret_value() if v is not None and hasattr(v, "get_secret_value") else (v or "")
