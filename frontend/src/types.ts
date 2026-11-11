// Shared types — mirror the backend's Pydantic schemas and SSE event payloads.

export type Role = 'user' | 'assistant'
/** answered = grounded in documents · general = general knowledge · blocked = guardrails */
export type Route = 'answered' | 'general' | 'blocked'

export interface Source {
  id: number
  source: string
  page: number
  similarity: number
  snippet: string
}

export interface ChatMessage {
  id: string
  role: Role
  content: string
  status: 'streaming' | 'done' | 'error'
  sources?: Source[]
  route?: Route | null
  error?: string
  /** Snapshot of the pipeline run that produced this answer (assistant messages only). */
  run?: WorkflowRun
}

export interface GraphNodeInfo {
  id: string
  label: string
  description: string
}

export interface GraphEdgeInfo {
  source: string
  target: string
  conditional: boolean
}

export interface GraphTopology {
  nodes: GraphNodeInfo[]
  edges: GraphEdgeInfo[]
}

export interface Health {
  status: 'ok'
  chunks_indexed: number
  llm_provider: string
  llm_model: string
  llm_ready: boolean
  index_version: number
  last_ingest: { at: string; added: string[]; updated: string[]; removed: string[]; failed?: string[]; chunks_written: number } | null
}

export interface DocumentInfo {
  source: string
  chunks: number
  pages: number
}

// ── Server-Sent Events (discriminated union on `event`) ────────────────────
export type NodeStatus = 'idle' | 'active' | 'done' | 'skipped' | 'error'

export type StreamEvent =
  | { event: 'node'; node: string; status: 'start' | 'end' | 'error'; ms?: number; detail?: Record<string, unknown> }
  | { event: 'sources'; sources: Source[] }
  | { event: 'token'; text: string }
  | { event: 'done'; route: Route | null; answer: string; search_query?: string }
  | { event: 'error'; message: string }

export interface NodeRun {
  status: NodeStatus
  /** Server-measured duration. */
  ms?: number
  detail?: Record<string, unknown>
  /** Client-observed offsets from the start of the run (ms) — used for the latency waterfall. */
  startedAt?: number
  endedAt?: number
}

export interface WorkflowRun {
  nodes: Record<string, NodeRun>
  path: string[] // visited node ids in order, incl. __start__/__end__
  running: boolean
  question?: string
  /** performance.now() when the run started (client clock). */
  t0?: number
  /** Client-observed time to first streamed token (ms from start). */
  firstTokenAt?: number
  totalMs?: number
}

// ── Typed views over node `detail` payloads (see backend graph.py) ─────────
export interface RetrievalCandidate {
  rank: number
  source: string
  page: number
  similarity: number
  rrf: number
  dense_rank: number | null
  sparse_rank: number | null
  preview: string
}

export interface GradeDetail {
  decision: 'grounded' | 'general'
  kept: number
  dropped: number
  best: number
  threshold: number
  margin: number
  cutoff: number
  kept_ranks: number[]
  confidence: 'high' | 'medium' | 'low'
}

export interface GenerationDetail {
  chars?: number
  words?: number
  ttft_ms?: number
  chars_per_s?: number | null
  degraded?: boolean
}

// ── Products: Document Briefs ──────────────────────────────────────────────
export interface BriefTopic {
  label: string
  items: string[]
}

export interface DocumentBrief {
  source: string
  pages: number
  chunks: number
  generated_ms: number
  cached: boolean
  brief: {
    title: string
    summary: string
    highlights: string[]
    topics: BriefTopic[]
    suggested_questions: string[]
  }
}

// ── Products: Match Analyzer ───────────────────────────────────────────────
export type MatchStatus = 'met' | 'partial' | 'missing'
export type MatchStage = 'extract' | 'retrieve' | 'assess' | 'score'

export interface MatchRequirement {
  id: number
  text: string
  priority: 'must' | 'nice'
  status: MatchStatus
  rationale: string
  evidence: { source: string; page: number; similarity: number; snippet: string }[]
}

export interface MatchResult {
  title: string
  score: number
  verdict: string
  counts: Record<MatchStatus, number>
  requirements: MatchRequirement[]
  total_ms: number
}

export type MatchEvent =
  | { event: 'stage'; stage: MatchStage; status: 'start' | 'end'; ms?: number; count?: number; title?: string }
  | ({ event: 'result' } & MatchResult)
  | { event: 'error'; message: string }

// ── Chat sessions (history) ────────────────────────────────────────────────
export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}
