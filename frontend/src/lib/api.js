import { API_BASE as BASE } from './apiBase'
import { createSSEParser } from './sse'

async function getJSON(path, signal) {
  const res = await fetch(`${BASE}${path}`, { signal, headers: { Accept: 'application/json' } })
  if (!res.ok) {
    // FastAPI errors carry a safe, user-facing `detail` message.
    const detail = await res
      .json()
      .then((b) => (typeof b.detail === 'string' ? b.detail : null))
      .catch(() => null)
    throw new Error(detail ?? (res.status === 429 ? 'Too many requests, please wait a moment.' : `Request failed (${res.status})`))
  }
  return (await res.json())
}

export const api = {
  health: (signal) => getJSON('/api/health', signal),
  graph: (signal) => getJSON('/api/graph', signal),
  documents: (signal) => getJSON('/api/documents', signal),
  brief: (source, refresh = false, signal) =>
    getJSON(`/api/briefs?${new URLSearchParams({ source, refresh: String(refresh) })}`, signal),
}

/** Stream the Match Analyzer (stage progress, then a result or error event). */
export async function streamMatch(text, signal, onEvent) {
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
  const feed = createSSEParser(onEvent)
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    feed(value)
  }
}

export async function streamChat({ question, history, signal, onEvent }) {
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
