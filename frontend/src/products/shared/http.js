import { API_BASE as BASE } from '../../lib/apiBase'
import { createSSEParser } from '../../lib/sse'

/** FastAPI errors carry a safe `detail` (string, or {message, errors[]} for validation problems). */
export class ApiError extends Error {
  status
  errors

  constructor(message, status, errors = []) {
    super(message)
    this.status = status
    this.errors = errors
  }
}

async function failure(res) {
  const body = (await res.json().catch(() => null))
  const d = body?.detail
  if (typeof d === 'string') return new ApiError(d, res.status)
  if (d && typeof d === 'object' && 'message' in d) {
    const o = d
    return new ApiError(o.message, res.status, o.errors ?? [])
  }
  if (Array.isArray(d)) {
    const first = d[0]
    return new ApiError(first?.msg ? `Invalid input: ${first.msg}` : 'Invalid input', res.status)
  }
  return new ApiError(res.status === 429 ? 'Too many requests, please wait a moment.' : `Request failed (${res.status})`, res.status)
}

export async function http(method, path, body, headers = {}) {
  const isRaw = body instanceof Blob
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Accept: 'application/json', ...(body !== undefined && !isRaw ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
  })
  if (!res.ok) throw await failure(res)
  return (res.status === 204 ? undefined : await res.json())
}

export const get = (path) => http('GET', path)
export const post = (path, body) => http('POST', path, body)
export const put = (path, body) => http('PUT', path, body)
export const patch = (path, body) => http('PATCH', path, body)
export const del = (path) => http('DELETE', path)

/** POST and read a Server-Sent Events response (EventSource can't POST a JSON body). */
export async function streamPost(path, body, onEvent, signal) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) throw await failure(res)
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  const feed = createSSEParser(onEvent)
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    feed(value)
  }
}

export const errorText = (e) => (e instanceof Error ? e.message : 'Something went wrong')

export function download(filename, text, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  a.click()
  URL.revokeObjectURL(url)
}
