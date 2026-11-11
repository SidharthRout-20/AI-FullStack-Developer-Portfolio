"""FlowForge: build AI automations on a canvas, run them live, deploy them as webhooks or schedules.

A flow is a DAG of typed nodes. Before any save the flow is *validated* (one trigger, no cycles, everything
reachable, required fields present, template references resolve). The runtime executes nodes in topological
order, streams `node_start` / `node_end` events (the canvas animates them), and skips the branch a condition
did not take. Nodes reference earlier outputs with `{{node_id}}` (or `{{input}}` for the trigger payload).
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import re
import secrets
import socket
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from app.core.ai import ask_text, clip, llm_failure, sse
from app.core.docstore import DocStore
from app.core.security import limiter, rate_limit_value
from app.rag.structured import extract_json

logger = logging.getLogger(__name__)

NodeType = Literal["trigger", "llm", "template", "http", "condition", "extract", "keeper", "output"]
REF = re.compile(r"\{\{\s*([\w-]+)(?:\.([\w-]+))?\s*\}\}")
MAX_NODES = 30
HTTP_MAX_BYTES = 200_000


class Node(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(pattern=r"^[\w-]{1,40}$")
    type: NodeType
    data: dict[str, Any] = Field(default_factory=dict)
    position: dict[str, float] = Field(default_factory=lambda: {"x": 0, "y": 0})


class Edge(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str | None = None
    source: str
    target: str
    sourceHandle: str | None = None  # "true" / "false" for condition nodes  # noqa: N815


class Trigger(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["manual", "webhook", "schedule"] = "manual"
    every_minutes: int | None = Field(None, ge=5, le=10080)


class FlowIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    description: str | None = Field(None, max_length=300)
    nodes: list[Node] = Field(min_length=1, max_length=MAX_NODES)
    edges: list[Edge] = Field(default_factory=list, max_length=60)
    trigger: Trigger = Field(default_factory=Trigger)


# ── Validation ───────────────────────────────────────────────────────────
REQUIRED = {"llm": ["prompt"], "template": ["text"], "http": ["url"], "condition": ["value", "op"], "extract": ["text", "fields"],
            "keeper": ["text"], "output": ["value"]}  # fmt: skip


def topo_order(nodes: list[Node], edges: list[Edge]) -> list[str] | None:
    """Kahn's algorithm; None if there is a cycle."""
    indeg = {n.id: 0 for n in nodes}
    for e in edges:
        indeg[e.target] += 1
    queue = [n.id for n in nodes if indeg[n.id] == 0]
    order: list[str] = []
    while queue:
        cur = queue.pop(0)
        order.append(cur)
        for e in edges:
            if e.source == cur:
                indeg[e.target] -= 1
                if indeg[e.target] == 0:
                    queue.append(e.target)
    return order if len(order) == len(nodes) else None


def validate(flow: FlowIn) -> list[str]:
    errors: list[str] = []
    ids = [n.id for n in flow.nodes]
    if len(set(ids)) != len(ids):
        errors.append("Node ids must be unique.")
    known = set(ids)
    triggers = [n for n in flow.nodes if n.type == "trigger"]
    if len(triggers) != 1:
        errors.append("A flow needs exactly one trigger node.")
    for e in flow.edges:
        if e.source not in known or e.target not in known:
            errors.append(f"Edge {e.source} → {e.target} points to a missing node.")
    if errors:
        return errors
    if any(e.target == triggers[0].id for e in flow.edges):
        errors.append("Nothing can connect into the trigger.")
    order = topo_order(flow.nodes, flow.edges)
    if order is None:
        errors.append("The flow has a cycle. Flows must be acyclic.")
        return errors
    reach = {triggers[0].id}
    for nid in order:
        if nid in reach:
            reach |= {e.target for e in flow.edges if e.source == nid}
    for n in flow.nodes:
        label = n.data.get("label") or n.id
        if n.id not in reach:
            errors.append(f"“{label}” isn't connected to the trigger.")
        for field in REQUIRED.get(n.type, []):
            if not str(n.data.get(field) or "").strip():
                errors.append(f"“{label}” needs a {field}.")
        for value in n.data.values():
            if isinstance(value, str):
                for ref, _ in REF.findall(value):
                    if ref != "input" and ref not in known:
                        errors.append(f"“{label}” references unknown node {{{{{ref}}}}}.")
        if n.type == "condition" and n.data.get("op") not in ("contains", "equals", "regex", "not_empty", "gt", "lt"):
            errors.append(f"“{label}” has an unknown condition operator.")
    if not any(n.type == "output" for n in flow.nodes):
        errors.append("Add an Output node so the flow returns something.")
    return errors


# ── SSRF-safe HTTP ───────────────────────────────────────────────────────
def _public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global or ip.is_multicast:
            return False
    return True


async def safe_http(method: str, url: str, body: str | None) -> str:
    """Only HTTPS to public addresses, no redirects, short timeout, capped response size."""
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        raise ValueError("Only plain https:// URLs are allowed.")
    if not await asyncio.to_thread(_public_host, parts.hostname):
        raise ValueError("That host resolves to a private or reserved address.")
    async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
        req = client.build_request(method, url, content=body.encode() if body else None,
                                   headers={"User-Agent": "FlowForge/1.0", **({"Content-Type": "application/json"} if body else {})})  # fmt: skip
        r = await client.send(req, stream=True)
        try:
            buf = bytearray()
            async for chunk in r.aiter_bytes():
                buf += chunk
                if len(buf) > HTTP_MAX_BYTES:
                    break
        finally:
            await r.aclose()
    text = buf[:HTTP_MAX_BYTES].decode("utf-8", errors="replace")
    if "html" in r.headers.get("content-type", ""):
        text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.S | re.I)
        text = re.sub(r"<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text)
    return f"HTTP {r.status_code}\n{text.strip()}"


# ── Runtime ──────────────────────────────────────────────────────────────
def render(template: str, values: dict[str, Any]) -> str:
    def sub(m: re.Match[str]) -> str:
        val = values.get(m[1], "")
        if m[2] and isinstance(val, dict):
            val = val.get(m[2], "")
        return val if isinstance(val, str) else json.dumps(val, ensure_ascii=False)

    return REF.sub(sub, template)


def check(op: str, value: str, arg: str) -> bool:
    match op:
        case "contains":
            return arg.lower() in value.lower()
        case "equals":
            return value.strip().lower() == arg.strip().lower()
        case "regex":
            try:
                return re.search(arg[:200], value[:20000]) is not None
            except re.error:
                return False
        case "not_empty":
            return bool(value.strip())
        case "gt" | "lt":
            try:
                a, b = float(value.strip()), float(arg)
            except ValueError:
                return False
            return a > b if op == "gt" else a < b
    return False


class FlowService:
    def __init__(self, store: DocStore, get_llm, keeper_command: Callable[[str], Awaitable[str]] | None) -> None:  # noqa: ANN001
        self.db = store
        self.get_llm = get_llm
        self.keeper_command = keeper_command
        self.http = safe_http  # injectable for tests

    async def run(self, flow: dict[str, Any], payload: Any, source: str) -> AsyncIterator[dict[str, Any]]:
        spec = FlowIn.model_validate(
            {k: flow[k] for k in ("name", "description", "nodes", "edges", "trigger") if k in flow}
        )
        nodes = {n.id: n for n in spec.nodes}
        order = topo_order(spec.nodes, spec.edges) or []
        values: dict[str, Any] = {}
        skipped: set[str] = set()
        trace: list[dict[str, Any]] = []
        started = time.perf_counter()
        output: Any = None
        status = "ok"
        yield {"event": "run_start", "order": order}
        for nid in order:
            node = nodes[nid]
            incoming = [e for e in spec.edges if e.target == nid]
            live = [e for e in incoming if e.source not in skipped and not _branch_blocked(e, values, nodes)]
            if node.type != "trigger" and not live:
                skipped.add(nid)
                yield {"event": "node_skip", "node": nid}
                continue
            yield {"event": "node_start", "node": nid}
            t = time.perf_counter()
            try:
                values[nid] = await asyncio.wait_for(self._exec(node, values, payload), 90)
                if node.type == "output":
                    output = values[nid]
                ms = round((time.perf_counter() - t) * 1000)
                trace.append({"node": nid, "ms": ms, "ok": True})
                yield {"event": "node_end", "node": nid, "ms": ms, "output": _preview(values[nid])}
            except Exception as exc:  # noqa: BLE001
                status = "error"
                message = str(exc) if isinstance(exc, ValueError) else llm_failure(exc)
                trace.append({"node": nid, "ok": False, "error": message})
                yield {"event": "node_error", "node": nid, "message": message}
                break
        total = round((time.perf_counter() - started) * 1000)
        run = self.db.put("runs", {"flow_id": flow["id"], "source": source, "status": status, "ms": total,
                                   "output": _preview(output, 4000), "trace": trace}, parent=flow["id"])  # fmt: skip
        self.db.patch("flows", flow["id"], {"last_run": {"status": status, "at": run["created_at"], "ms": total}})
        yield {"event": "done", "status": status, "output": output, "ms": total, "run_id": run["id"]}

    async def _exec(self, node: Node, values: dict[str, Any], payload: Any) -> Any:
        d = node.data
        match node.type:
            case "trigger":
                values["input"] = payload if payload not in (None, "") else d.get("sample", "")
                return values["input"]
            case "template":
                return render(d["text"], values)
            case "llm":
                system = (
                    d.get("system")
                    or "You are a concise, helpful assistant inside an automation. Reply with the result only."
                )
                return (await ask_text(self.get_llm, system, clip(render(d["prompt"], values), 12000))).strip()
            case "extract":
                fields = [f.strip() for f in str(d["fields"]).split(",") if f.strip()][:15]
                prompt = f"Extract these fields as a flat JSON object with exactly these keys: {fields}. Use null when absent.\n\nTEXT:\n{clip(render(d['text'], values), 10000)}"
                reply = await ask_text(self.get_llm, "You extract structured data. Reply with JSON only.", prompt)
                data = extract_json(reply)
                return {f: data.get(f) for f in fields}
            case "http":
                body = render(d["body"], values) if d.get("body") else None
                return await self.http(
                    d.get("method", "GET").upper() if d.get("method") in ("GET", "POST") else "GET",
                    render(d["url"], values),
                    body,
                )
            case "condition":
                return check(d["op"], render(str(d["value"]), values), render(str(d.get("arg", "")), values))
            case "keeper":
                if self.keeper_command is None:
                    raise ValueError("Keeper isn't available.")
                return await self.keeper_command(render(d["text"], values))
            case "output":
                return render(d["value"], values)
        raise ValueError(f"Unknown node type {node.type}")

    async def run_to_end(self, flow: dict[str, Any], payload: Any, source: str) -> dict[str, Any]:
        last: dict[str, Any] = {}
        async for ev in self.run(flow, payload, source):
            last = ev
        return last

    async def run_scheduled(self) -> int:
        """One pass: run every scheduled flow whose interval has elapsed. Returns how many ran."""
        ran = 0
        now = time.time()
        for f in self.db.list("flows"):
            trig = f.get("trigger") or {}
            if trig.get("type") != "schedule" or not trig.get("every_minutes") or not f.get("enabled", True):
                continue
            if now - float(f.get("last_scheduled", 0)) >= trig["every_minutes"] * 60:
                self.db.patch("flows", f["id"], {"last_scheduled": now})
                await self.run_to_end(self.db.get("flows", f["id"]) or f, None, "schedule")
                ran += 1
        return ran

    async def scheduler(self) -> None:
        """Always-on hosts: check scheduled flows every 30 s. Serverless hosts call run_scheduled from a cron."""
        while True:
            try:
                await self.run_scheduled()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("Scheduler tick failed")
            await asyncio.sleep(30)


def _branch_blocked(e: Edge, values: dict[str, Any], nodes: dict[str, Node]) -> bool:
    if nodes[e.source].type != "condition" or e.source not in values:
        return False
    return (e.sourceHandle or "true") != ("true" if values[e.source] else "false")


def _preview(value: Any, limit: int = 1200) -> Any:
    if isinstance(value, str):
        return value[:limit]
    text = json.dumps(value, ensure_ascii=False, default=str)
    return value if len(text) <= limit else text[:limit]


# ── Starter templates ────────────────────────────────────────────────────
def _n(id: str, type: str, x: float, y: float, **data: Any) -> dict[str, Any]:
    return {"id": id, "type": type, "position": {"x": x, "y": y}, "data": data}


TEMPLATES: list[dict[str, Any]] = [
    {
        "name": "Summarise a web page",
        "description": "Fetch a URL, summarise it in 3 bullets, and flag if it mentions pricing.",
        "trigger": {"type": "manual"},
        "nodes": [
            _n("trigger", "trigger", 0, 120, label="Start", sample="https://www.python.org/about/"),
            _n("fetch", "http", 260, 120, label="Fetch page", url="{{input}}", method="GET"),
            _n("summary", "llm", 520, 120, label="Summarise", prompt="Summarise this page in exactly 3 bullets:\n\n{{fetch}}"),
            _n("check", "condition", 780, 120, label="Mentions pricing?", value="{{fetch}}", op="contains", arg="price"),
            _n("out_yes", "output", 1040, 40, label="Output (pricing)", value="💰 Mentions pricing\n{{summary}}"),
            _n("out_no", "output", 1040, 200, label="Output", value="{{summary}}"),
        ],
        "edges": [
            {"source": "trigger", "target": "fetch"}, {"source": "fetch", "target": "summary"},
            {"source": "summary", "target": "check"},
            {"source": "check", "target": "out_yes", "sourceHandle": "true"},
            {"source": "check", "target": "out_no", "sourceHandle": "false"},
        ],
    },
    {
        "name": "Message triage → Keeper",
        "description": "Classify an incoming message; urgent ones become a Keeper reminder. Deploy it as a webhook.",
        "trigger": {"type": "webhook"},
        "nodes": [
            _n("trigger", "trigger", 0, 120, label="Webhook", sample="Hi! The electricity bill of ₹1,840 is due on the 15th."),
            _n("fields", "extract", 260, 120, label="Extract", text="{{input}}", fields="topic, urgency, due_date, amount"),
            _n("urgent", "condition", 520, 120, label="Has a due date?", value="{{fields.due_date}}", op="not_empty"),
            _n("remind", "keeper", 780, 40, label="Save to Keeper", text="{{input}}"),
            _n("out1", "output", 1040, 40, label="Output", value="Saved to Keeper: {{remind}}"),
            _n("out2", "output", 1040, 200, label="Output", value="No action needed ({{fields.topic}})."),
        ],
        "edges": [
            {"source": "trigger", "target": "fields"}, {"source": "fields", "target": "urgent"},
            {"source": "urgent", "target": "remind", "sourceHandle": "true"},
            {"source": "urgent", "target": "out2", "sourceHandle": "false"},
            {"source": "remind", "target": "out1"},
        ],
    },
]  # fmt: skip


# ── API ───────────────────────────────────────────────────────────────────
def get_flows(request: Request) -> FlowService:
    return request.app.state.suite.flows


Flows = Annotated[FlowService, Depends(get_flows)]
router = APIRouter(prefix="/api/flows", tags=["flowforge"])
hooks = APIRouter(prefix="/api/hooks", tags=["flowforge"])


def _flow(svc: FlowService, flow_id: str) -> dict[str, Any]:
    doc = svc.db.get("flows", flow_id[:40])
    if doc is None:
        raise HTTPException(404, "Flow not found.")
    return doc


def _save(svc: FlowService, body: FlowIn, flow_id: str | None = None) -> dict[str, Any]:
    errors = validate(body)
    if errors:
        raise HTTPException(422, {"message": "The flow has problems.", "errors": errors})
    existing = svc.db.get("flows", flow_id) if flow_id else None
    token = (existing or {}).get("hook_token") or secrets.token_urlsafe(18)
    return svc.db.put(
        "flows", {**(existing or {}), **body.model_dump(), "hook_token": token, "enabled": True}, id=flow_id
    )


@router.get("/templates")
def templates() -> list[dict[str, Any]]:
    return TEMPLATES


@router.post("/validate")
def validate_flow(body: FlowIn) -> dict[str, Any]:
    return {"errors": validate(body)}


@router.get("")
def list_flows(svc: Flows) -> list[dict[str, Any]]:
    return svc.db.list("flows", limit=100)


@router.post("", status_code=201)
def create_flow(body: FlowIn, svc: Flows) -> dict[str, Any]:
    return _save(svc, body)


@router.put("/{flow_id}")
def update_flow(flow_id: str, body: FlowIn, svc: Flows) -> dict[str, Any]:
    _flow(svc, flow_id)
    return _save(svc, body, flow_id[:40])


@router.get("/{flow_id}")
def get_flow(flow_id: str, svc: Flows) -> dict[str, Any]:
    return _flow(svc, flow_id)


@router.delete("/{flow_id}", status_code=204)
def delete_flow(flow_id: str, svc: Flows) -> None:
    _flow(svc, flow_id)
    svc.db.delete("flows", flow_id[:40])


@router.get("/{flow_id}/runs")
def list_runs(flow_id: str, svc: Flows) -> list[dict[str, Any]]:
    return svc.db.list("runs", parent=flow_id[:40], limit=20)


@router.post("/{flow_id}/run")
@limiter.limit(rate_limit_value)
async def run_flow(
    request: Request, flow_id: str, svc: Flows, payload: Annotated[Any, Body(embed=True)] = None
) -> StreamingResponse:
    flow = _flow(svc, flow_id)

    async def events() -> AsyncIterator[str]:
        try:
            async for ev in svc.run(flow, payload, "manual"):
                yield sse(ev.pop("event"), ev)
        except Exception as exc:  # noqa: BLE001
            yield sse("error", {"message": llm_failure(exc)})

    return StreamingResponse(
        events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@hooks.post("/{token}")
@limiter.limit("30/minute")
async def webhook(request: Request, token: str, svc: Flows) -> dict[str, Any]:
    """Deployed flow: POST any JSON (or text) here; the flow's output comes back."""
    flow = next(
        (f for f in svc.db.list("flows") if secrets.compare_digest(str(f.get("hook_token", "")), token[:64])), None
    )
    if flow is None or (flow.get("trigger") or {}).get("type") != "webhook":
        raise HTTPException(404, "Not found")
    raw = (await request.body())[:20000].decode("utf-8", errors="replace")
    try:
        payload: Any = json.loads(raw) if raw.strip().startswith(("{", "[")) else raw
    except ValueError:
        payload = raw
    if isinstance(payload, dict) and "text" in payload:
        payload = payload["text"]
    result = await svc.run_to_end(flow, payload if isinstance(payload, str) else json.dumps(payload), "webhook")
    return {"status": result.get("status"), "output": result.get("output"), "ms": result.get("ms")}
