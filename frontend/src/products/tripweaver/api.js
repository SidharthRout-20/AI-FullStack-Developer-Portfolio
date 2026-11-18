/**
 * Client for /api/trips. There are no user accounts in this portfolio, so (like EFI) the server issues this browser
 * an unguessable owner token, kept in localStorage and sent as X-Trip-Owner. Trips shared with you are opened with
 * their share key (from the share link), sent as X-Trip-Share. The server only ever stores a hash of the owner token.
 */
import { API_BASE as BASE } from '../../lib/apiBase'
import { createSSEParser } from '../../lib/sse'
import { ApiError, sessionError } from '../shared/http'

const KEY = 'tripweaver-owner-token'
const SHARE = 'tripweaver-share-'
let pending = null

const safe = (fn, fallback = null) => {
  try {
    return fn()
  } catch {
    return fallback
  }
}

export const shareKeyFor = (tripId) => safe(() => sessionStorage.getItem(SHARE + tripId)) ?? ''
export function rememberShareKey(tripId, key) {
  if (key) safe(() => sessionStorage.setItem(SHARE + tripId, key))
}

async function ownerToken() {
  const have = safe(() => localStorage.getItem(KEY)) ?? ''
  if (have) return have
  pending ??= fetch(`${BASE}/api/trips/owner`, { method: 'POST', headers: { Accept: 'application/json' } })
    .then(async (res) => {
      if (!res.ok) throw new ApiError(sessionError('Safarnama', res.status, BASE), res.status)
      const { token } = await res.json()
      safe(() => localStorage.setItem(KEY, token))
      return token
    })
    .finally(() => {
      pending = null
    })
  return pending
}

async function headers(tripId, extra = {}) {
  const h = { Accept: 'application/json', 'X-Trip-Owner': await ownerToken(), ...extra }
  const share = tripId ? shareKeyFor(tripId) : ''
  if (share) h['X-Trip-Share'] = share
  return h
}

/** True when a 422 response is only about unknown fields (a server older than this client). */
export async function rejectsExtras(res) {
  const body = await res.clone().json().catch(() => null)
  const d = body?.detail
  return Array.isArray(d) && d.length > 0 && d.every((x) => x?.type === 'extra_forbidden')
}

async function failure(res) {
  const body = await res.json().catch(() => null)
  const d = body?.detail
  if (typeof d === 'string') return new ApiError(d, res.status)
  if (Array.isArray(d)) return new ApiError(d[0]?.msg ? `Invalid input: ${d[0].msg}` : 'Invalid input', res.status)
  return new ApiError(res.status === 429 ? 'Too many requests, please wait a moment.' : `Request failed (${res.status})`, res.status)
}

async function call(method, path, body, tripId) {
  const isRaw = body instanceof Blob
  const res = await fetch(`${BASE}/api/trips${path}`, {
    method,
    headers: await headers(tripId, body !== undefined && !isRaw ? { 'Content-Type': 'application/json' } : isRaw ? { 'Content-Type': body.type } : {}),
    body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
  })
  if (!res.ok) throw await failure(res)
  return res.status === 204 ? undefined : res.json()
}

const qs = (params) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** Trip-scoped API: every call carries the owner token and (if any) this trip's share key. */
export function tripApi(id) {
  const t = (method, path = '', body) => call(method, `/${id}${path}`, body, id)
  return {
    get: () => t('GET'),
    update: (body) => t('PATCH', '', body),
    remove: () => t('DELETE'),
    copy: () => t('POST', '/copy'),
    rotateShare: () => t('POST', '/share/rotate'),
    addDestination: (body) => t('POST', '/destinations', body),
    replan: (event, days) => t('POST', '/replan', { event, ...(days?.length ? { days } : {}) }),
    weather: () => t('POST', '/weather-check'),
    vote: (body) => t('POST', '/votes', body),
    optimise: (day) => t('POST', `/days/${day}/optimise`),
    addStop: (day, stop) => t('POST', `/days/${day}/stops`, stop),
    editActivity: (aid, changes) => t('PATCH', `/activities/${aid}`, changes),
    deleteActivity: (aid) => t('DELETE', `/activities/${aid}`),
    moveActivity: (aid, day, index) => t('POST', `/activities/${aid}/move`, { day, index }),
    alternatives: (aid) => t('GET', `/activities/${aid}/alternatives`),
    meals: () => t('POST', '/meals'),
    nearby: (params) => t('GET', `/nearby${qs(params)}`),
    discover: (params) => t('GET', `/discover${qs(params)}`),
    transport: (destination) => t('GET', `/transport${qs({ destination })}`),
    specialities: (destination) => t('POST', `/specialities${qs({ destination })}`),
    places: () => t('GET', '/places'),
    savePlace: (place) => t('POST', '/places', place),
    deletePlace: (pid) => t('DELETE', `/places/${pid}`),
    bookings: () => t('GET', '/bookings'),
    addBooking: (b) => t('POST', '/bookings', b),
    updateBooking: (bid, b) => t('PATCH', `/bookings/${bid}`, b),
    deleteBooking: (bid) => t('DELETE', `/bookings/${bid}`),
    expenses: () => t('GET', '/expenses'),
    addExpense: (e) => t('POST', '/expenses', e),
    deleteExpense: (eid) => t('DELETE', `/expenses/${eid}`),
    budget: () => t('GET', '/budget'),
    fx: (base, quote) => t('GET', `/fx${qs({ base, quote })}`),
    scanReceipt: (blob) => t('POST', '/expenses/scan', blob),
    documents: () => t('GET', '/documents'),
    addDocument: (d) => t('POST', '/documents', d),
    deleteDocument: (did) => t('DELETE', `/documents/${did}`),
    uploadFile: (did, file) => call('POST', `/${id}/documents/${did}/file${qs({ name: file.name })}`, file, id),
    downloadFile: async (did) => {
      const res = await fetch(`${BASE}/api/trips/${id}/documents/${did}/file`, { headers: await headers(id) })
      if (!res.ok) throw await failure(res)
      return res.blob()
    },
    setChecklists: (checklists) => t('PUT', '/checklists', { checklists }),
    packing: () => t('POST', '/checklists/packing'),
    companion: (body) => t('POST', '/companion', body),
    summary: () => t('GET', '/summary'),
    nextIdeas: () => t('POST', '/next-ideas'),
    liveUrl: (shareKey) => `${BASE}/api/trips/${id}/live${qs({ share: shareKey || shareKeyFor(id) })}`,
  }
}

export const trips = {
  list: () => call('GET', ''),
  create: (body) => call('POST', '', body),
  /** Plan with the AI planner: streams step events, then done/error. */
  async plan(prompt, choices, onEvent) {
    const send = async (body) =>
      fetch(`${BASE}/api/trips/plan`, {
        method: 'POST',
        headers: await headers(null, { 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
        body: JSON.stringify(body),
      })
    // Choices the traveller made explicitly (party, travellers): newer servers keep them over what the model reads.
    const extra = Object.fromEntries(Object.entries(choices ?? {}).filter(([, v]) => v != null))
    let res = await send({ prompt, ...extra })
    // An older server rejects fields it doesn't know (422 extra_forbidden). The prompt already says everything,
    // so plan from the prompt alone rather than failing.
    if (res.status === 422 && Object.keys(extra).length && (await rejectsExtras(res))) res = await send({ prompt })
    if (!res.ok || !res.body) throw await failure(res)
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    const feed = createSSEParser(onEvent)
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      feed(value)
    }
  },
}
