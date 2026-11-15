/**
 * Client for /api/efi. There are no user accounts in this portfolio, so the server issues this browser an
 * unguessable owner token, kept in localStorage and sent as X-EFI-Owner. History belongs to that token only.
 */
import { API_BASE as BASE } from '../../lib/apiBase'
import { ApiError, sessionError } from '../shared/http'

const KEY = 'efi-owner-token'
let pending = null

function stored() {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

async function ownerToken() {
  const have = stored()
  if (have) return have
  pending ??= fetch(`${BASE}/api/efi/owner`, { method: 'POST', headers: { Accept: 'application/json' } })
    .then(async (res) => {
      if (!res.ok) throw new ApiError(sessionError('EFI', res.status, BASE), res.status)
      const { token } = await res.json()
      try {
        localStorage.setItem(KEY, token)
      } catch {
        /* private mode: the token lives for this page only */
      }
      return token
    })
    .finally(() => {
      pending = null
    })
  return pending
}

async function call(method, path, body) {
  const token = await ownerToken()
  const res = await fetch(`${BASE}/api/efi${path}`, {
    method,
    headers: { Accept: 'application/json', 'X-EFI-Owner': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.detail
    const msg = typeof detail === 'string' ? detail : res.status === 429 ? 'Too many requests, please wait a moment.' : `Request failed (${res.status})`
    throw new ApiError(msg, res.status)
  }
  return res.status === 204 ? undefined : res.json()
}

export const efi = {
  limits: () => fetch(`${BASE}/api/efi/limits`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  list: () => call('GET', '/investigations'),
  get: (id) => call('GET', `/investigations/${id}`),
  create: (body) => call('POST', '/investigations', body),
  analyze: (id) => call('POST', `/investigations/${id}/analyze`),
  remove: (id) => call('DELETE', `/investigations/${id}`),
  feedback: (id, body) => call('POST', `/investigations/${id}/feedback`, body),
  context: (id, artifactId, line) => call('GET', `/investigations/${id}/artifacts/${artifactId}?line=${line}&radius=8`),
}
