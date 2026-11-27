/**
 * HTTP helpers shared by every app: safe error messages from FastAPI responses, JSON calls and SSE streams.
 * `createClient(base)` binds the helpers to one backend (each app has its own API address).
 */
import { createSSEParser } from './sse'

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

/** The best error to show for a failed response. */
export async function failure(res) {
  const body = await res.json().catch(() => null)
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

/** Why a product couldn't start its session. 404/405 mean the backend predates this product (an older deployment). */
export function sessionError(product, status, base) {
  if (status === 404 || status === 405) {
    let host = base
    try {
      host = new URL(base).host
    } catch {
      /* relative base: keep as is */
    }
    return `The backend (${host}) doesn't have ${product} yet: it's running an older deployment. Deploy the latest backend, then try again.`
  }
  if (status === 503) return `The backend is starting or unavailable (${status}). Please try again in a minute.`
  return `${product}: couldn't start a session (${status}).`
}

/** JSON + SSE helpers bound to one backend base URL. `options.headers()` (sync or async) adds headers to every call. */
export function createClient(base, options = {}) {
  const extra = async () => (options.headers ? await options.headers() : {})
  async function http(method, path, body, headers = {}) {
    const isRaw = body instanceof Blob
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined && !isRaw ? { 'Content-Type': 'application/json' } : {}), ...(await extra()), ...headers },
      body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
    })
    if (!res.ok) throw await failure(res)
    return res.status === 204 ? undefined : await res.json()
  }

  /** POST and read a Server-Sent Events response (EventSource can't POST a JSON body). */
  async function streamPost(path, body, onEvent, signal) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(await extra()) },
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

  return {
    http,
    get: (path) => http('GET', path),
    post: (path, body) => http('POST', path, body),
    put: (path, body) => http('PUT', path, body),
    patch: (path, body) => http('PATCH', path, body),
    del: (path) => http('DELETE', path),
    streamPost,
  }
}

export const errorText = (e) => (e instanceof Error ? e.message : 'Something went wrong')

export function download(filename, text, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  a.click()
  URL.revokeObjectURL(url)
}
