# DocuMind Roadmap: from chatbot to document intelligence studio

**Goal:** make DocuMind a product people *work in*, not a chat box with a nice graph. Each phase adds a
non-chat surface built on the same foundation (LangGraph pipeline, hybrid retrieval, SSE telemetry, Run
Inspector), so every feature reuses code instead of bolting on.

Effort assumes one developer: **S** ≈ 1–2 days, **M** ≈ 3–5 days, **L** ≈ 1–2 weeks.

---

## At a glance

| # | Feature | Turns DocuMind into… | Effort | Signal it sends |
|---|---|---|---|---|
| 1 | Source viewer with highlighted citations | a research tool you can verify | M | Trust & UX craft |
| 2 | Feedback + Insights dashboard | a product with analytics | M | Product thinking, data modelling |
| 3 | Evaluation harness (golden set + CI gate) | an engineered ML system | M | ML rigor (the #1 senior-AI signal) |
| 4 | Knowledge-base manager (secure upload, live ingestion graph) | a self-serve platform | L | Full-stack depth, async jobs, security |
| 5 | ✅ **Shipped:** Match Analyzer (JD / RFP vs documents) | a task-specific AI app | M | Structured outputs, domain value |
| 6 | ✅ **Shipped:** Library with Document Briefs (timeline still open) | a document intelligence tool | M | Extraction pipelines |
| 7 | Agent mode with tools + dynamic graph | an agentic system | L | Tool use, planning, multi-step agents |
| 8 | Reranker + self-correcting RAG loop | a state-of-the-art RAG pipeline | M | Retrieval expertise |
| 9 | Observability, auth & multi-tenant workspaces | an enterprise SaaS | L | Production engineering |

**Recommended order:** 1 → 3 → 2 → 5 → 4 → 6 → 8 → 7 → 9. Do verification and quality first, because they make
every later demo credible. Then the features that are most visibly "not a chatbot".

---

## Phase 1: Trust & quality (make every answer verifiable and measurable)

### 1. Source viewer with highlighted citations · M
- **What:** clicking a citation chip opens a side drawer showing the actual PDF page (PDF.js), scrolled to and
  highlighted at the cited passage. There's also a "Documents" tab to browse the knowledge base.
- **How:** store character offsets per chunk at ingestion (pypdf text positions, or `pymupdf` for bounding boxes);
  expose `GET /api/documents/{id}/pages/{n}` streaming the file safely (allow-listed IDs, no paths from the
  client); `react-pdf` with a text-layer highlight.
- **Why it matters:** "show me where it says that" is the first question enterprise users ask about AI. It turns
  citations from decoration into verification.

### 2. Feedback loop + Insights dashboard · M
- **What:** 👍/👎 plus an optional comment on each answer, stored with its run snapshot. A new **Insights** view:
  questions per day, the grounded / general / blocked mix, p50/p95 latency and time to first token, average
  retrieval confidence, most-asked topics, and **"knowledge gaps"** (frequent questions that routed to general
  knowledge, meaning content you should add).
- **How:** SQLite (free, local) via SQLModel; `POST /api/feedback`; aggregate endpoints; charts with Recharts.
  The Run Inspector already produces every metric needed.
- **Why it matters:** shows you think about the product after launch: measuring, learning, closing gaps.

### 3. Evaluation harness · M
- **What:** a versioned golden set (questions → expected facts, plus questions that *should* route to general).
  Metrics: retrieval hit-rate@k and MRR, faithfulness, answer relevance, and routing accuracy. An **Evals** page
  compares runs ("chunk size 800 → 600: hit-rate +6 %, latency −40 ms").
- **How:** a pytest-style runner plus LLM-as-judge for faithfulness; results stored as JSON in CI artifacts and
  surfaced in the UI. Fails CI if quality drops below a threshold.
- **Why it matters:** the clearest senior-AI signal there is: "I don't tune prompts by vibes; I have evals."

---

## Phase 2: Beyond chat (task-specific workflows)

### 4. Knowledge-base manager with a live ingestion graph · L
- **What:** an admin area to upload, replace and delete documents. Ingestion runs as a background job and is
  visualized with the **same Pipeline Studio**: *validate → parse → chunk → embed → index* nodes animate with
  progress, chunk counts and timings.
- **How:** an authenticated `POST /api/admin/documents` (size and MIME checks with `python-magic`, filename
  sanitising, antivirus hook optional); a job queue (`arq` or FastAPI background tasks + SQLite job table);
  progress over SSE; the ingestion pipeline as a second LangGraph.
- **Why it matters:** shows async job design, secure file handling, and reuse of your visualization framework
  for a second workflow.

### 5. Job-Fit Analyzer · M · ✅ shipped as the Match Analyzer
- **What:** paste a job description and get a structured report: overall match score, requirement-by-requirement
  table (✅ evidenced / ⚠️ partial / ❌ missing, each with a citation into the resume), suggested resume bullet
  rewrites, and likely interview questions.
- **How:** a dedicated LangGraph: *extract requirements → retrieve evidence per requirement (parallel fan-out) →
  grade → synthesize*. Uses **structured outputs** (Pydantic schema) and renders as a report page, not a chat.
- **Why it matters:** a concrete, demo-able use case for recruiters looking at *your* portfolio, and it shows
  map-reduce agent patterns.

### 6. Document Briefs · M · ✅ shipped in the Library (timeline view still to do)
- **What:** for each document, an auto-generated brief page: executive summary, key entities (skills,
  companies, dates, technologies), a timeline (e.g. a career timeline from a resume), and "questions this
  document can answer" (which also seed the chat suggestions).
- **How:** run at ingestion time; structured extraction with schemas; cache results in SQLite; a timeline
  component in React.
- **Why it matters:** shows the AI working *for* the user proactively, not only when asked.

---

## Phase 3: Advanced AI

### 7. Agent mode with tools and a dynamic graph · L
- **What:** a "Research" mode where the model plans and calls tools: `search_kb`, `read_page`, `compare_docs`,
  `summarize_section`, `calculator`, optionally `web_search` (clearly labelled). The Pipeline Studio renders the
  **plan and tool calls as nodes appearing in real time**: a dynamic graph instead of a fixed one.
- **How:** a LangGraph ReAct / plan-and-execute agent; stream `tool_call` / `tool_result` events over the
  existing SSE protocol; cap steps and tokens per run; human-in-the-loop approval for expensive tools.
- **Why it matters:** "agentic" is the headline skill for AI engineering roles. Showing the agent's reasoning as
  a live graph is a strong differentiator.

### 8. Reranker + self-correcting RAG · M
- **What:** a cross-encoder **rerank** node (FastEmbed ships ONNX rerankers, free and CPU-only) after hybrid
  retrieval, and a **reflect** node that checks the draft answer against the evidence and, if unsupported,
  rewrites the query and retries once (corrective / self-RAG).
- **How:** two new graph nodes plus a conditional loop edge. The UI picks them up automatically from
  `/api/graph`. Measure the gain with the eval harness (#3).
- **Why it matters:** demonstrates current retrieval research turned into measurable improvements.

---

## Phase 4: Enterprise readiness

### 9. Observability, auth & workspaces · L
- **Observability:** OpenTelemetry spans per graph node (the `traced` wrapper is already the hook point),
  exported to self-hosted **Langfuse** or Grafana Tempo (both free); structured JSON logs with request IDs.
- **Auth:** OIDC sign-in (Auth0 free tier, Keycloak, or GitHub OAuth); role-based access (viewer / editor /
  admin) that gates the admin endpoints.
- **Workspaces:** multiple isolated knowledge bases (one vector index per workspace) with a switcher in the
  top bar. Persistent conversations via LangGraph checkpointers.
- **Scale:** Redis-backed rate limiting and semantic answer cache; Postgres + pgvector option; a worker process
  for ingestion.
- **Why it matters:** proves you can take an AI prototype to a multi-user, observable, secure product.

---

## Quick wins (≤ 1 day each, any time)

- **Export a run** as a JSON "trace" or a shareable Markdown report (question, answer, sources, metrics).
- **Light theme** toggle (design tokens are already centralised in `index.css`).
- **Command palette** (Ctrl+K): switch views, re-run a question, open documents, clear the chat.
- **Suggested follow-ups** after each answer (cheap LLM call, `effort: low`).
- **Streaming markdown polish:** typewriter smoothing and code-block copy buttons.
- **Answer language:** auto-detect and reply in the user's language.

---

## Product suite: next steps

* **CareerPilot:** PDF/DOCX resume export; job-board URL import.
* **MeetingMind:** speaker diarisation (pyannote) and calendar import.
* **CodeLens:** private repos via a GitHub App; incremental re-index on push.
* **FlowForge:** loops/map nodes; versioned flows with diff view; per-flow secrets.
* **TripWeaver:** see the travel-ecosystem roadmap below.

## Keeper: next steps

* **Web Push** (VAPID) so reminders arrive when the app is closed, not only while it's open or installed.
* **Two-way Telegram bot:** capture by messaging the bot ("lent my drill to Raj"), using the same router.
* **Shared household:** a family space where Pantry, Occasions and Bills are visible to several people.
* **Semantic stash search:** reuse DocuMind's FastEmbed embeddings for "where's the thing I charge my phone with?"
* **Receipt line items to pantry quantities**, and spending summaries from Bills.

## How to present this in an interview

1. **Start with the problem:** "Chatbots over documents are easy to demo and hard to trust."
2. **Show trust:** cite → open the source viewer → highlighted passage.
3. **Show understanding:** open the Run Inspector and explain why a chunk won (vector #3, BM25 #1, fused score)
   and why another question was routed to general knowledge.
4. **Show engineering:** the evals page and CI gate, plus the latency waterfall and TTFT.
5. **Show breadth:** the Job-Fit Analyzer report and the live ingestion graph.
6. **Close with production thinking:** security model, observability, and how it scales.

---

## TripWeaver: travel ecosystem

**Status: In development.** Implemented end to end, covered by automated tests (`tests/test_tripweaver_ecosystem.py`,
`test_suite.py`, `logic.test.js`) and checked in a browser locally. Not live yet: the deployed backend has no Postgres
(trips would not persist there), identity is per browser (no accounts), and the provider-dependent parts below need
commercial integrations.

**Positioning.** *TripWeaver: your complete travel ecosystem.* The **itinerary is the organising object**: food,
shopping, experiences, weather, routes, bookings and expenses attach to a trip, a day, a stop, the traveller's location
(with permission), local time and budget. Recommendations come only from real provider data; nothing is ordered,
booked or paid by TripWeaver.

### Modules

| Module | Status | What exists (code) | Still missing |
| --- | --- | --- | --- |
| A. Trip planning & management | Available | AI planner with several cities (`TripService.plan`, `TripRequest.legs`); manual trips (`create_manual`), add destinations, settings, archive, phases; owner token + share-link members (`trip_api.access`) | Real accounts and invitations |
| B. Itinerary engine | Available | Day parts, routes, optimise, edit/move/pin/delete, re-plan selected days keeping pins, `validate_day`, evidence-backed `stop_labels` | — |
| C. Local discovery | Available | 10 OSM categories (`trip_logic.SELECTORS`, `Tools.discover`), anchors (destination, stop, location), filters, saved places, add to day | Ratings, prices, comparisons (no free data) |
| D. Food discovery & ordering | Partial | Food discovery, meal slotting, venue menu/booking/phone hand-offs (`handoff_links`) | Ordering, delivery, table booking: commercial provider needed |
| E. Shopping & souvenirs | Partial | OSM shops, crafts, markets; AI specialities matched to shops (`match_specialities`) | Stock, prices |
| F. Experiences & activities | Partial | OSM venues (museums, theatres, zoos, parks, nature) with venue-site hand-offs | Tours, events, tickets: provider needed |
| G. Weather & travel intelligence | Available | Per-destination daily, current and hourly forecast (`forecast_detail`), driest window, rain spells, derived alerts, indoor alternatives, fetch time | Official severe-weather warnings |
| H. Maps, navigation & transport | Partial | Map with itinerary and discovery pins, OSRM driving times, walking estimates, stations, airports with transfer times (`passenger_airports`) | Public-transport timetables, routed cycling |
| I. Booking & reservation management | Available | Booking records linked to days/stops, costs into the budget, status, cancellation terms, hand-offs | Direct booking APIs |
| J. Budget & expenses | Available | `budget_summary` (actual vs estimate, categories, days), Frankfurter rates or your own, `settle_up`, receipt drafts via the vision route | — |
| K. Travel companion | Available | `companion` with real context and candidates, `validate_suggestions`, confirm-only actions | Proactive disruption alerts |
| L. Documents & preparedness | Available | Owner-only documents with ≤1 MB files (existing DB blobs), checklists, `packing_list` | — |
| M. Post-trip | Available | `trip_summary`, archive, history, AI next-trip ideas | — |

### Provider dependencies and limits (checked 2026-11-14; verify before any commercial use)

| Need | Provider | Cost | Terms and limits |
| --- | --- | --- | --- |
| Weather, air quality, geocoding | Open-Meteo | Free | Non-commercial only; < 10,000 calls/day, 5,000/hour, 600/minute; CC BY 4.0 attribution |
| Places | Overpass API (+ Nominatim / Photon fallback and geocoding) | Free | Overpass: < 10,000 queries/day, commercial use should self-host; Nominatim: max 1 request/second, results must be cached, no autocomplete |
| Routing | OSRM demo server | Free | Reasonable non-commercial use, max 1 request/second, no uptime guarantee |
| Map tiles | tile.openstreetmap.org | Free | Attribution required; heavy use may be blocked |
| Currency | Frankfurter | Free | No key, no quotas (rate-limited against abuse); blended reference rates, commercial use allowed |
| Ordering, bookings, tickets, tours, transit | Not integrated | — | Partner/affiliate programmes or city GTFS feeds; deferred |

The commercial-use restrictions on Open-Meteo, Overpass and the OSRM demo server are the main blocker for any paid
launch. Results are cached in memory (and exchange rates in the database) to keep request counts low.

### Staged roadmap

1. **Core travel foundation:** done, except real accounts.
2. **Contextual discovery:** done.
3. **Travel operations:** done, except public-transport timetables.
4. **Travel commerce:** provider hand-offs only; real integrations need partners with understood terms. No own payments.
5. **Intelligent travel companion:** context-aware, confirm-only companion done; proactive disruption alerts next.

TripWeaver becomes *Live* only after Postgres is connected to the production backend, the deployed app is verified
end to end, and the remaining blockers above are accepted or resolved.
