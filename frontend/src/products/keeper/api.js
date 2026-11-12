/** Typed client for /api/keeper. Sends the local timezone offset and the optional access key. */
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

  const res = await fetch(`${BASE}/api/keeper${path}`, { ...init, headers })
  if (res.status === 401) throw new KeyRequiredError()
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b) => (typeof b.detail === 'string' ? b.detail : null))
      .catch(() => null)
    throw new Error(detail ?? (res.status === 429 ? 'Too many requests, please wait a moment.' : `Request failed (${res.status})`))
  }
  return (res.status === 204 ? undefined : await res.json())
}

const post = (path, body) =>
  call(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export const keeperApi = {
  status: () => call('/status'),
  command: (text, extra = {}) =>
    post('/command', { text, ...extra }),
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
  scan: (photo_id, hint = 'auto') => post('/scan', { photo_id, hint }),
  dueAlerts: () => call('/reminders/due'),
  ack: (id, key) => post(`/entries/${id}/ack`, { key }),
  snooze: (id, minutes, key) => post(`/entries/${id}/snooze`, { minutes, key }),
  reminderSettings: () => call('/reminders/settings'),
  saveReminderSettings: (s) => {
    const body = { ...s }
    delete body.telegram_configured // read-only fields reported by the server
    delete body.cron_configured
    return call('/reminders/settings', { method: 'PUT', body: JSON.stringify(body) })
  },
  testReminder: () => post('/reminders/test'),
  /** Photos go through fetch (not <img src>) so the access-key header is sent; returns an object URL. */
  photoUrl: async (id) => {
    const key = getAccessKey()
    const res = await fetch(`${BASE}/api/keeper/photos/${id}`, { headers: key ? { 'X-Keeper-Key': key } : {} })
    if (!res.ok) throw new Error('Photo unavailable')
    return URL.createObjectURL(await res.blob())
  },
}
