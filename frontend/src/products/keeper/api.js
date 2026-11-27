/** Typed client for /api/keeper. Sends the local timezone offset and the optional access key. */
import { identityHeaders } from '@appcore/web/identity'
import { API_BASE as BASE } from '../../lib/apiBase'

const KEY_STORAGE = 'keeper-access-key'

export class KeyRequiredError extends Error {
  constructor() {
    super('This Keeper is protected. Enter its access key.')
  }
}

export function getAccessKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? ''
  } catch {
    return ''
  }
}

export function setAccessKey(key) {
  try {
    localStorage.setItem(KEY_STORAGE, key)
  } catch {
    /* ignore */
  }
}

async function call(path, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  headers.set('X-TZ-Offset', String(new Date().getTimezoneOffset()))
  if (init.body) headers.set('Content-Type', 'application/json')
  const key = getAccessKey()
  if (key) headers.set('X-Keeper-Key', key)
  // Whose Tara this is: the site owner's browser, the signed-in account, or this browser.
  for (const [k, v] of Object.entries(await identityHeaders())) headers.set(k, v)
  if (getOwnerKey()) headers.set('X-Tara-Owner-Key', getOwnerKey())

  const res = await fetch(`${BASE}/api/keeper${path}`, { ...init, headers })
  if (res.status === 401) {
    const detail = await res.clone().json().then((b) => b.detail).catch(() => '')
    if (/access key/i.test(String(detail))) throw new KeyRequiredError()
  }
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b) => (typeof b.detail === 'string' ? b.detail : null))
      .catch(() => null)
    const err = new Error(detail ?? (res.status === 429 ? 'Too many requests, please wait a moment.' : `Request failed (${res.status})`))
    err.status = res.status
    throw err
  }
  return (res.status === 204 ? undefined : await res.json())
}

const post = (path, body) =>
  call(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export const keeperApi = {
  status: () => call('/status'),
  /** A spoken or typed request. Servers older than the conversation memory reject `history` and `prefs`: ask again without them. */
  command: async (text, extra = {}) => {
    try {
      return await post('/command', { text, ...extra })
    } catch (e) {
      if (e?.status !== 422 || !(extra.history || extra.prefs || extra.persona)) throw e
      const { history: _h, prefs: _p, persona: _r, ...rest } = extra
      return post('/command', { text, ...rest })
    }
  },
  entries: (kind) => call(`/entries${kind ? `?kind=${kind}` : ''}`),
  create: (entry) => post('/entries', entry),
  update: (id, patch) => call(`/entries/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  done: (id) => post(`/entries/${id}/done`),
  used: (id) => post(`/entries/${id}/used`),
  remove: (id) => call(`/entries/${id}`, { method: 'DELETE' }),
  agenda: () => call('/agenda'),
  brief: () => call('/brief'),
  sendBrief: () => post('/brief/telegram'),
  uploadPhoto: (dataUrl) => post('/photos', { image: dataUrl }),
  transcribe: (audio, mime) => post('/transcribe', { audio, mime }),
  glance: ({ city, lat, lng } = {}) => {
    const q = new URLSearchParams()
    if (city) q.set('city', city)
    if (lat != null && lng != null) {
      q.set('lat', String(lat))
      q.set('lng', String(lng))
    }
    return call(`/glance?${q}`)
  },
  scan: (photo_id, hint = 'auto') => post('/scan', { photo_id, hint }),
  dueAlerts: () => call('/reminders/due'),
  ack: (id, key) => post(`/entries/${id}/ack`, { key }),
  snooze: (id, minutes, key) => post(`/entries/${id}/snooze`, { minutes, key }),
  reminderSettings: () => call('/reminders/settings'),
  saveReminderSettings: (s) => {
    const body = { ...s }
    delete body.telegram_configured // read-only fields reported by the server
    delete body.cron_configured
    delete body.last_tick
    return call('/reminders/settings', { method: 'PUT', body: JSON.stringify(body) })
  },
  testReminder: () => post('/reminders/test'),
  /** Just signed in: move what this browser saved into the account (so it follows you to every device). */
  claim: () => post('/claim'),
  /** Photos go through fetch (not <img src>) so the access-key header is sent; returns an object URL. */
  photoUrl: async (id) => {
    const key = getAccessKey()
    const owner = getOwnerKey()
    const headers = { ...(await identityHeaders()), ...(key ? { 'X-Keeper-Key': key } : {}), ...(owner ? { 'X-Tara-Owner-Key': owner } : {}) }
    const res = await fetch(`${BASE}/api/keeper/photos/${id}`, { headers })
    if (!res.ok) throw new Error('Photo unavailable')
    return URL.createObjectURL(await res.blob())
  },
}

// ── Code proposals (owner only): plan a change, then open it as a pull request ─────────────────────────────
const OWNER_KEY = 'tara-owner-key'
export const getOwnerKey = () => {
  try {
    return localStorage.getItem(OWNER_KEY) ?? ''
  } catch {
    return ''
  }
}
export const setOwnerKey = (k) => {
  try {
    if (k) localStorage.setItem(OWNER_KEY, k)
    else localStorage.removeItem(OWNER_KEY)
  } catch {
    /* private mode: ask again next time */
  }
}
async function edits(path, body) {
  const res = await fetch(`${BASE}/api/tara/edits${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Accept: 'application/json', 'X-Tara-Owner-Key': getOwnerKey(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}
export const editsApi = {
  status: () => edits('/status'),
  plan: (request) => edits('/plan', { request }),
  propose: (plan) => edits('/propose', plan),
}

