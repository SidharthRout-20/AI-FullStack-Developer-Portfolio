import type { DocumentBrief, DocumentInfo, GraphTopology, Health, MatchEvent, StreamEvent } from '../types'
import { createSSEParser } from './sse'

// Empty string → same origin (Vite proxy in dev, FastAPI static hosting in prod).
// Set VITE_API_BASE_URL only when the frontend is hosted separately (e.g. Vercel).
const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal, headers: { Accept: 'application/json' } })
  if (!res.ok) {
    // FastAPI errors carry a safe, user-facing `detail` message.
    const detail = await res
      .json()
      .then((b: { detail?: unknown }) => (typeof b.detail === 'string' ? b.detail : null))
      .catch(() => null)
    throw new Error(detail ?? (res.status === 429 ? 'Too many requests, please wait a moment.' : `Request failed (${res.status})`))
  }
  return (await res.json()) as T
}

export const api = {
  health: (signal?: AbortSignal) => getJSON<Health>('/api/health', signal),
  graph: (signal?: AbortSignal) => getJSON<GraphTopology>('/api/graph', signal),
  documents: (signal?: AbortSignal) => getJSON<DocumentInfo[]>('/api/documents', signal),
  brief: (source: string, refresh = false, signal?: AbortSignal) =>
    getJSON<DocumentBrief>(`/api/briefs?${new URLSearchParams({ source, refresh: String(refresh) })}`, signal),
}

/** Stream the Match Analyzer (stage progress, then a result or error event). */
export async function streamMatch(text: string, signal: AbortSignal, onEvent: (ev: MatchEvent) => void) {
  const res = await fetch(`${BASE}/api/match/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text }),
    signal,
  })
  if (!res.ok || !res.body) {
    if (res.status === 422) throw new Error('Paste between 40 and 8,000 characters of requirements.')
    if (res.status === 429) throw new Error('Too many requests, please wait a moment.')
    throw new Error(`Request failed (${res.status})`)
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  const feed = createSSEParser<MatchEvent>(onEvent)
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    feed(value)
  }
}

export interface StreamChatArgs {
  question: string
  history: { role: 'user' | 'assistant'; content: string }[]
  signal: AbortSignal
  onEvent: (ev: StreamEvent) => void
}

export async function streamChat({ question, history, signal, onEvent }: StreamChatArgs) {
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ question, history }),
    signal,
  })

  if (!res.ok || !res.body) {
    if (res.status === 429) throw new Error('You are sending messages too quickly. Please wait a moment.')
    if (res.status === 422) throw new Error('That message could not be processed (too long or invalid).')
    throw new Error(`Request failed (${res.status})`)
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  const feed = createSSEParser(onEvent)
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    feed(value)
  }
}
