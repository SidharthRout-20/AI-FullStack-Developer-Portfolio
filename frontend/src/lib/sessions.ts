import type { ChatMessage, ChatSession } from '../types'

/**
 * Chat history, stored only in this browser (localStorage). It is a per-viewer convenience:
 * nothing is sent to or stored on the server, which keeps the backend stateless and private.
 */
const KEY = 'documind.sessions.v1'
export const MAX_SESSIONS = 30
const MAX_MESSAGES = 80

export function loadSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as ChatSession[]).filter((s) => s && Array.isArray(s.messages)) : []
  } catch {
    return [] // private mode, blocked storage, corrupt data → start empty
  }
}

export function saveSessions(sessions: ChatSession[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sessions))
  } catch {
    /* quota exceeded or storage unavailable — history is best-effort */
  }
}

export function sessionTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user')?.content.trim() ?? 'New chat'
  return first.length > 60 ? `${first.slice(0, 57)}…` : first
}

/** Insert or update a session (most recent first), keeping only finished messages. */
export function upsertSession(
  sessions: ChatSession[],
  id: string,
  messages: ChatMessage[],
  now: number,
): ChatSession[] {
  const finished = messages.filter((m) => m.status !== 'streaming').slice(-MAX_MESSAGES)
  if (!finished.length) return sessions
  const existing = sessions.find((s) => s.id === id)
  const session: ChatSession = {
    id,
    title: sessionTitle(finished),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messages: finished,
  }
  return [session, ...sessions.filter((s) => s.id !== id)].slice(0, MAX_SESSIONS)
}

export function deleteSession(sessions: ChatSession[], id: string): ChatSession[] {
  return sessions.filter((s) => s.id !== id)
}

/** Bucket label for grouping the history list. */
export function dayBucket(ts: number, now: number): 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older' {
  const day = 86_400_000
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  if (ts >= startOfToday) return 'Today'
  if (ts >= startOfToday - day) return 'Yesterday'
  if (ts >= startOfToday - 7 * day) return 'Previous 7 days'
  return 'Older'
}
