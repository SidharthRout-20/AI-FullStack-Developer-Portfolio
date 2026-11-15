"""EFI application service: intake → redaction → deterministic evidence → (on request) Groq analysis → report.

Creating an investigation never calls the model (it only parses), so the user can review the redacted evidence
before anything leaves the server. Analysis is a separate, explicit, bounded step.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import logging
import posixpath
import re
import time
import uuid
from typing import Any

from app.config import Settings
from app.efi import evidence as ev
from app.efi import parsers, reasoning
from app.efi.parsers import ArtifactError
from app.efi.redact import RedactionError, redact
from app.efi.store import EFIStore, iso, now
from app.rag.llm import LLMNotConfiguredError

logger = logging.getLogger(__name__)

STALE_ANALYSIS = dt.timedelta(minutes=5)  # an "analyzing" status older than this was interrupted → may be retried
PURGE_EVERY_S = 600
_CONTROL = re.compile(r"[\x01-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]")  # ESC (\x1b) is allowed: ANSI colours in CI logs


class NotFoundError(LookupError):
    pass


class LimitError(RuntimeError):
    """A configured EFI usage limit was reached (no model call was made)."""


class BusyError(RuntimeError):
    pass


class EFIService:
    def __init__(self, settings: Settings, caller: reasoning.Caller | None = None) -> None:
        self.settings = settings
        self.store = EFIStore(settings.data_dir, settings.db_url)
        self._caller = caller  # injectable for tests; default: the central Groq router (app/llm)
        self._last_purge = 0.0

    @property
    def caller(self) -> reasoning.Caller:
        if self._caller is None:
            self._caller = reasoning.router_caller(self.settings)  # central Groq LLM router
        return self._caller

    def limits(self) -> dict[str, Any]:
        s = self.settings
        return {
            "max_request_bytes": s.efi_max_request_bytes,
            "max_artifact_bytes": s.efi_max_artifact_bytes,
            "max_artifacts": s.efi_max_artifacts,
            "retention_days": s.efi_retention_days,
            "model": s.efi_model or s.groq_model,
            "provider": "groq",
            "daily_analyses_per_owner": s.efi_daily_analyses_per_owner,
            "extensions": sorted(set(parsers.TEXT_EXT)),
            "kinds": list(parsers.KINDS),
        }

    def maybe_purge(self) -> None:
        """On-access cleanup of expired raw artifacts (the cron tick also calls `store.purge_expired`)."""
        if time.monotonic() - self._last_purge < PURGE_EVERY_S:
            return
        self._last_purge = time.monotonic()
        try:
            if n := self.store.purge_expired():
                logger.info("EFI: purged %d expired raw artifacts", n)
        except Exception:  # noqa: BLE001 - cleanup must never break a request
            logger.exception("EFI artifact purge failed")

    # ── intake ────────────────────────────────────────────────────────────
    def _intake(self, raw: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        s = self.settings
        if not raw:
            raise ArtifactError(
                "Add at least one artifact (a log, stack trace, diff, JUnit report, manifest or config)."
            )
        if len(raw) > s.efi_max_artifacts:
            raise ArtifactError(f"At most {s.efi_max_artifacts} artifacts per investigation.")
        out, per_artifact, totals = [], [], {}
        for i, a in enumerate(raw, start=1):
            name = _safe_name(a.get("name") or f"artifact-{i}.txt")
            content = a.get("content") or ""
            low = name.lower()
            if low.endswith(parsers.ARCHIVE_EXT):
                raise ArtifactError(
                    f"{name}: archives aren't supported. Upload the log, diff or report files themselves."
                )
            if not parsers.allowed_name(name):
                raise ArtifactError(
                    f"{name}: unsupported file type. Supported: logs, .diff/.patch, JUnit .xml, manifests, config."
                )
            size = len(content.encode("utf-8"))
            if size > s.efi_max_artifact_bytes:
                raise ArtifactError(
                    f"{name} is {size // 1024} KB; the limit is {s.efi_max_artifact_bytes // 1024} KB per artifact."
                )
            if not content.strip():
                raise ArtifactError(f"{name} is empty.")
            if "\x00" in content or content[:20000].count("�") > 20:
                raise ArtifactError(f"{name} looks like a binary file. Only text artifacts are supported.")
            if len(_CONTROL.findall(content[:200_000])) > max(20, len(content[:200_000]) // 200):
                raise ArtifactError(f"{name} contains too many control characters to be a text artifact.")
            kind = a.get("kind") or parsers.detect_kind(name, content)
            if kind not in parsers.KINDS:
                raise ArtifactError(f"{name}: unknown artifact kind “{kind}”.")
            try:
                clean, counts = redact(content)
            except RedactionError as exc:
                raise ArtifactError(f"{name}: {exc} The artifact was not stored or processed.") from None
            for k, n in counts.items():
                totals[k] = totals.get(k, 0) + n
            per_artifact.append({"name": name, "redacted": sum(counts.values())})
            out.append(
                {
                    "id": f"A{i}",
                    "name": name,
                    "kind": kind,
                    "size": size,
                    "content": clean,
                    "sha256": hashlib.sha256(clean.encode("utf-8")).hexdigest(),
                }
            )
        return out, {"total": sum(totals.values()), "by_type": totals, "per_artifact": per_artifact}

    def create(self, owner: str, title: str | None, notes: str | None, raw: list[dict[str, Any]]) -> dict[str, Any]:
        artifacts, redaction = self._intake(raw)
        note_text = None
        if notes and notes.strip():
            try:
                note_text, counts = redact(notes.strip())
            except RedactionError as exc:
                raise ArtifactError(f"Notes: {exc}") from None
            redaction["total"] += sum(counts.values())
            for k, n in counts.items():
                redaction["by_type"][k] = redaction["by_type"].get(k, 0) + n
        built = ev.build(artifacts, note_text, self.settings.efi_max_evidence)
        data = {
            "artifacts": [{k: a[k] for k in ("id", "name", "kind", "size", "sha256")} for a in artifacts],
            "redaction": redaction,
            "notes": note_text,
            **built,
            "report": None,
            "analysis": None,
            "feedback": None,
            "error": None,
        }
        title = (title or "").strip() or _default_title(built["evidence"], artifacts)
        inv = self.store.create(owner, title[:120], "ready", data, artifacts, self.settings.efi_retention_days)
        return self.get(owner, inv["id"])

    # ── reading ───────────────────────────────────────────────────────────
    def get(self, owner: str, inv_id: str) -> dict[str, Any]:
        inv = self.store.get(owner, inv_id)
        if inv is None:
            raise NotFoundError(inv_id)
        inv["raw_artifacts_available"] = [a["id"] for a in self.store.artifacts(owner, inv_id)]
        inv.pop("owner", None)  # the client never needs (or gets) the owner id
        return inv

    def list(self, owner: str) -> list[dict[str, Any]]:
        out = []
        for inv in self.store.list(owner):
            d = inv["data"]
            report = d.get("report") or {}
            out.append(
                {
                    "id": inv["id"],
                    "title": inv["title"],
                    "status": inv["status"],
                    "created_at": inv["created_at"],
                    "updated_at": inv["updated_at"],
                    "artifacts": len(d.get("artifacts", [])),
                    "evidence": len(d.get("evidence", [])),
                    "hypotheses": len(report.get("hypotheses") or []),
                    "top_hypothesis": (report.get("hypotheses") or [{}])[0].get("title"),
                    "confirmed": bool(d.get("feedback")),
                    "artifacts_expire_at": inv["artifacts_expire_at"],
                }
            )
        return out

    def delete(self, owner: str, inv_id: str) -> None:
        if not self.store.delete(owner, inv_id):
            raise NotFoundError(inv_id)

    def artifact_lines(self, owner: str, inv_id: str, artifact_id: str, line: int, radius: int) -> dict[str, Any]:
        self.get(owner, inv_id)  # ownership
        content = self.store.artifact_content(owner, inv_id, artifact_id)
        if content is None:
            raise NotFoundError(artifact_id)
        lines = parsers.clean_lines(content)
        start, end = max(1, line - radius), min(len(lines), line + radius)
        return {
            "artifact_id": artifact_id,
            "start": start,
            "end": end,
            "focus": line,
            "lines": [{"n": n, "text": lines[n - 1][:400]} for n in range(start, end + 1)],
        }

    # ── analysis ──────────────────────────────────────────────────────────
    def _check_limits(self, owner: str) -> None:
        s = self.settings
        since = now() - dt.timedelta(days=1)
        if s.efi_daily_analyses_global and self.store.analyses_since(since) >= s.efi_daily_analyses_global:
            raise LimitError(
                "The daily analysis limit for this deployment has been reached (it protects the free "
                "Groq quota). Please try again tomorrow."
            )
        if s.efi_daily_analyses_per_owner and self.store.analyses_since(since, owner) >= s.efi_daily_analyses_per_owner:
            raise LimitError(
                f"You've reached {s.efi_daily_analyses_per_owner} analyses in the last 24 hours. "
                "Please try again later."
            )

    async def analyse(self, owner: str, inv_id: str) -> dict[str, Any]:  # noqa: C901
        inv = self.get(owner, inv_id)
        data = inv["data"]
        if inv["status"] == "analyzing" and now() - dt.datetime.fromisoformat(inv["updated_at"]) < STALE_ANALYSIS:
            raise BusyError("This investigation is already being analysed.")
        evidence, correlations = data["evidence"], data["correlations"]

        if not ev.has_failure_signal(evidence):  # deterministic: nothing to reason about, no model call
            data["report"] = self._insufficient_report(
                data,
                "No failure signal (error lines, exceptions, failing tests "
                "or stack traces) was found in the submitted artifacts.",
            )
            data["analysis"], data["error"] = {"model": None, "calls": 0, "skipped": "no failure signal"}, None
            return self._save(owner, inv, "insufficient_evidence", data)

        self._check_limits(owner)
        previous = inv["status"] if inv["status"] != "analyzing" else "ready"
        inv = self.store.update(owner, inv_id, inv["version"], status="analyzing")
        selected, left_out = ev.select_context(evidence, correlations, self.settings.efi_max_context_chars)
        prompt = reasoning.build_prompt(selected, correlations, data["artifacts"], inv["title"])
        meta = reasoning.new_meta(self.settings)
        try:
            out = await reasoning.analyse(self.caller, self.settings, prompt, meta)
        except reasoning.EFIQuotaError as exc:
            self._fail(owner, inv, data, meta, previous, str(exc), "rate_limited")
            raise
        except (reasoning.EFIModelError, LLMNotConfiguredError) as exc:
            self._fail(owner, inv, data, meta, "failed", str(exc), "failed")
            raise
        except Exception:
            logger.exception("EFI analysis failed")
            self._fail(
                owner, inv, data, meta, "failed", "The analysis failed unexpectedly. Please try again.", "failed"
            )
            raise
        self.store.record_usage(owner, inv_id, meta, "ok")
        logger.info(
            "EFI analysis: model=%s calls=%s in=%s out=%s ms=%s",
            meta["model"],
            meta["calls"],
            meta["input_tokens"],
            meta["output_tokens"],
            meta["ms"],
        )

        sent = {e["id"] for e in selected}
        checked = reasoning.verify(out, evidence, correlations, data["artifacts"], sent)
        data["report"] = self._report(data, checked, meta, len(selected), left_out)
        data["analysis"], data["error"] = meta, None
        status = "insufficient_evidence" if checked["insufficient_evidence"] else "analyzed"
        return self._save(owner, inv, status, data)

    def _save(self, owner: str, inv: dict[str, Any], status: str, data: dict[str, Any]) -> dict[str, Any]:
        self.store.update(owner, inv["id"], inv["version"], status=status, data=data)
        return self.get(owner, inv["id"])

    def _fail(
        self,
        owner: str,
        inv: dict[str, Any],
        data: dict[str, Any],
        meta: dict[str, Any],
        status: str,
        message: str,
        usage_status: str,
    ) -> None:
        if meta["calls"]:
            self.store.record_usage(owner, inv["id"], meta, usage_status)
        data["error"] = {"message": message, "at": iso(now()), "kind": usage_status}
        data["analysis"] = meta
        try:
            self.store.update(owner, inv["id"], inv["version"], status=status, data=data)
        except Exception:  # noqa: BLE001 - the original error is what the user needs to see
            logger.exception("EFI: could not record the analysis failure")

    def _base_report(self, data: dict[str, Any]) -> dict[str, Any]:
        evidence = data["evidence"]
        failures = [e["id"] for e in evidence if e["kind"] in ev.FAILURE_KINDS]
        first = next(
            (t["evidence_id"] for t in data["timeline"] if t["first_failure"]), failures[0] if failures else None
        )
        commands = [e for e in evidence if e["kind"] == "command"]
        if first:
            f = next(e for e in evidence if e["id"] == first)
            commands = [
                c
                for c in commands
                if c["artifact_index"] == f["artifact_index"] and (c["line"] or 0) <= (f["line"] or 0)
            ]
        limitations = []
        if data["redaction"]["total"]:
            limitations.append(
                f"{data['redaction']['total']} secret value(s) were redacted before storage and analysis."
            )
        if data["stats"]["truncated"]:
            limitations.append(
                f"{data['stats']['truncated']} lower-priority evidence item(s) were dropped to stay within limits."
            )
        limitations.append(
            f"Raw artifacts are deleted after {self.settings.efi_retention_days} days; the report keeps "
            "short evidence snippets until you delete the investigation."
        )
        return {
            "generated_at": iso(now()),
            "symptoms": failures[:15],
            "first_failure": first,
            "observed_commands": [c["id"] for c in commands[-5:]],
            "limitations": limitations,
        }

    def _insufficient_report(self, data: dict[str, Any], reason: str) -> dict[str, Any]:
        kinds = {a["kind"] for a in data["artifacts"]}
        missing = []
        if "log" not in kinds and "stacktrace" not in kinds:
            missing.append("The CI / build / deploy log of the failing step (or the full stack trace).")
        if "junit" not in kinds:
            missing.append("A JUnit XML test report, if tests failed.")
        if "diff" not in kinds:
            missing.append("The git diff of the change made before the failure.")
        return {
            **self._base_report(data),
            "model": None,
            "summary": "",
            "insufficient_evidence": True,
            "insufficient_reason": reason,
            "hypotheses": [],
            "rejected_hypotheses": [],
            "reproduction_steps": [],
            "affected_files": [],
            "missing_artifacts": missing,
            "validation_checklist": [],
            "context": {"sent": 0, "left_out": len(data["evidence"])},
        }

    def _report(
        self, data: dict[str, Any], checked: dict[str, Any], meta: dict[str, Any], sent: int, left_out: int
    ) -> dict[str, Any]:
        base = self._base_report(data)
        if left_out:
            base["limitations"].append(
                f"{left_out} evidence item(s) didn't fit the model's context budget and were not analysed."
            )
        if checked["invalid_references_removed"]:
            base["limitations"].append(
                f"{checked['invalid_references_removed']} invalid evidence reference(s) from the model were removed."
            )
        if checked["rejected_hypotheses"]:
            base["limitations"].append(
                f"{len(checked['rejected_hypotheses'])} hypothesis(es) were rejected for citing no valid evidence."
            )
        base["limitations"].append(
            "The summary, hypotheses, remediation and suggested validation steps are model-generated "
            "and unverified until you confirm the root cause."
        )
        return {
            **base,
            **checked,
            "model": meta["model"],
            "validation_checklist": reasoning.checklist(data["evidence"], checked["hypotheses"]),
            "context": {"sent": sent, "left_out": left_out},
        }

    # ── feedback ──────────────────────────────────────────────────────────
    def feedback(
        self, owner: str, inv_id: str, outcome: str, hypothesis_id: str | None, note: str | None
    ) -> dict[str, Any]:
        inv = self.get(owner, inv_id)
        data = inv["data"]
        report = data.get("report") or {}
        if outcome == "confirmed":
            ids = {h["id"] for h in report.get("hypotheses") or []}
            if hypothesis_id not in ids:
                raise ArtifactError("Pick one of this report's hypotheses, or choose “none of these”.")
        clean_note = None
        if note and note.strip():
            try:
                clean_note, _ = redact(note.strip())
            except RedactionError as exc:
                raise ArtifactError(f"Note: {exc}") from None
        data["feedback"] = {
            "outcome": outcome,
            "hypothesis_id": hypothesis_id if outcome == "confirmed" else None,
            "note": clean_note,
            "at": iso(now()),
        }
        return self._save(owner, inv, inv["status"], data)


def _safe_name(name: str) -> str:
    name = posixpath.basename(str(name).replace("\\", "/")).strip()
    name = re.sub(r"[\x00-\x1f\x7f]", "", name)[:120]
    return name or f"artifact-{uuid.uuid4().hex[:6]}.txt"


def _default_title(evidence: list[dict[str, Any]], artifacts: list[dict[str, Any]]) -> str:
    first = next((e for e in evidence if e["kind"] in ev.FAILURE_KINDS), None)
    if first:
        return parsers.clip(first["content"].split("\n")[0], 100)
    return f"Investigation of {artifacts[0]['name']}" if artifacts else "Investigation"
