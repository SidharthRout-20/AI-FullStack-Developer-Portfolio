import { API_BASE as BASE } from '../../lib/apiBase'
import { createSSEParser } from '../../lib/sse'

/** FastAPI errors carry a safe `detail` (string, or {message, errors[]} for validation problems). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors: string[] = [],
  ) {
    super(message)
  }
}

async function failure(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { detail?: unknown } | null
  const d = body?.detail
  if (typeof d === 'string') return new ApiError(d, res.status)
  if (d && typeof d === 'object' && 'message' in d) {
    const o = d as { message: string; errors?: string[] }
    return new ApiError(o.message, res.status, o.errors ?? [])
  }
  if (Array.isArray(d)) {
    const first = d[0] as { msg?: string; loc?: unknown[] } | undefined
    return new ApiError(first?.msg ? `Invalid input: ${first.msg}` : 'Invalid input', res.status)
  }
  return new ApiError(res.status === 429 ? 'Too many requests, please wait a moment.' : `Request failed (${res.status})`, res.status)
}

export async function http<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const isRaw = body instanceof Blob
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Accept: 'application/json', ...(body !== undefined && !isRaw ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
  })
  if (!res.ok) throw await failure(res)
  return (res.status === 204 ? undefined : await res.json()) as T
}

export const get = <T>(path: string) => http<T>('GET', path)
export const post = <T>(path: string, body?: unknown) => http<T>('POST', path, body)
export const put = <T>(path: string, body?: unknown) => http<T>('PUT', path, body)
export const patch = <T>(path: string, body?: unknown) => http<T>('PATCH', path, body)
export const del = (path: string) => http<void>('DELETE', path)

export type SSEEvent = { event: string } & Record<string, unknown>

/** POST and read a Server-Sent Events response (EventSource can't POST a JSON body). */
export async function streamPost(path: string, body: unknown, onEvent: (ev: SSEEvent) => void, signal?: AbortSignal) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) throw await failure(res)
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  const feed = createSSEParser<SSEEvent>(onEvent)
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    feed(value)
  }
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong')

export function download(filename: string, text: string, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  a.click()
  URL.revokeObjectURL(url)
}
