/** Typed client for /api/keeper. Sends the local timezone offset and the optional access key. */
import { API_BASE as BASE } from '../../lib/apiBase'

export type Kind = 'stash' | 'parking' | 'loan' | 'expiry' | 'bill' | 'occasion' | 'appliance' | 'pantry' | 'care'

export interface Entry {
  id: string
  kind: Kind
  title: string
  place: string | null
  person: string | null
  note: string | null
  photo_id: string | null
  lat: number | null
  lng: number | null
  due: string | null
  due_time: string | null
  status: 'active' | 'done'
  data: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface AgendaItem {
  bucket: 'overdue' | 'today' | 'soon' | 'nudge'
  label: string
  entry: Entry
}

export interface TraceStep {
  node: string
  ms: number
  detail: string
}

export interface CommandResult {
  reply: string
  action: 'add' | 'find' | 'done' | 'list' | 'brief' | 'help'
  kind: Kind | null
  routed_by: 'llm' | 'rules'
  entries: Entry[]
  trace: TraceStep[]
  brief?: Brief | null
}

export interface Brief {
  text: string
  source: 'llm' | 'template'
  agenda: AgendaItem[]
}

export interface ScanResult {
  kind: Kind
  title: string
  caption: string | null
  date: string | null
  category: string | null
  model: string | null
  amount: number | null
  items: string[]
}

export interface KeeperStatus {
  llm_provider: string
  vision: boolean
  telegram: boolean
  protected: boolean
  counts: Partial<Record<Kind, number>>
}

/** A reminder whose time has come (the open app chimes and reads it aloud). */
export interface DueAlert {
  key: string
  entry_id: string
  title: string
  label: string
  at: string
  urgent: boolean
  quiet: boolean
}

export interface ReminderSettings {
  ntfy_topic: string | null
  ntfy_server: string
  telegram: boolean
  quiet_enabled: boolean
  quiet_start: string
  quiet_end: string
  escalate_min: number
  brief_push: boolean
  brief_hour: number
  /** read-only, from the server */
  telegram_configured?: boolean
  cron_configured?: boolean
}

export type EntryInput = Partial<Omit<Entry, 'id' | 'status' | 'created_at' | 'updated_at'>> & { kind: Kind; title: string }

const KEY_STORAGE = 'keeper-access-key'

export class KeyRequiredError extends Error {
  constructor() {
    super('This Keeper is protected. Enter its access key.')
  }
}

export function getAccessKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? ''
  } catch {
    return ''
  }
}

export function setAccessKey(key: string) {
  try {
    localStorage.setItem(KEY_STORAGE, key)
  } catch {
    /* ignore */
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
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
      .then((b: { detail?: unknown }) => (typeof b.detail === 'string' ? b.detail : null))
      .catch(() => null)
    throw new Error(detail ?? (res.status === 429 ? 'Too many requests, please wait a moment.' : `Request failed (${res.status})`))
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export const keeperApi = {
  status: () => call<KeeperStatus>('/status'),
  command: (text: string, extra: { photo_id?: string; lat?: number; lng?: number } = {}) =>
    post<CommandResult>('/command', { text, ...extra }),
  entries: (kind?: Kind) => call<Entry[]>(`/entries${kind ? `?kind=${kind}` : ''}`),
  create: (entry: EntryInput) => post<Entry>('/entries', entry),
  update: (id: string, patch: Partial<EntryInput>) => call<Entry>(`/entries/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  done: (id: string) => post<Entry>(`/entries/${id}/done`),
  used: (id: string) => post<Entry>(`/entries/${id}/used`),
  remove: (id: string) => call<void>(`/entries/${id}`, { method: 'DELETE' }),
  agenda: () => call<AgendaItem[]>('/agenda'),
  brief: () => call<Brief>('/brief'),
  sendBrief: () => post<{ status: string }>('/brief/telegram'),
  uploadPhoto: (dataUrl: string) => post<{ photo_id: string }>('/photos', { image: dataUrl }),
  scan: (photo_id: string, hint = 'auto') => post<ScanResult>('/scan', { photo_id, hint }),
  dueAlerts: () => call<DueAlert[]>('/reminders/due'),
  ack: (id: string, key: string) => post<Entry>(`/entries/${id}/ack`, { key }),
  snooze: (id: string, minutes: number, key?: string) => post<Entry>(`/entries/${id}/snooze`, { minutes, key }),
  reminderSettings: () => call<ReminderSettings>('/reminders/settings'),
  saveReminderSettings: (s: ReminderSettings) => {
    const body: Partial<ReminderSettings> = { ...s }
    delete body.telegram_configured // read-only fields reported by the server
    delete body.cron_configured
    return call<ReminderSettings>('/reminders/settings', { method: 'PUT', body: JSON.stringify(body) })
  },
  testReminder: () => post<{ sent: string[] }>('/reminders/test'),
  /** Photos go through fetch (not <img src>) so the access-key header is sent; returns an object URL. */
  photoUrl: async (id: string) => {
    const key = getAccessKey()
    const res = await fetch(`${BASE}/api/keeper/photos/${id}`, { headers: key ? { 'X-Keeper-Key': key } : {} })
    if (!res.ok) throw new Error('Photo unavailable')
    return URL.createObjectURL(await res.blob())
  },
}
