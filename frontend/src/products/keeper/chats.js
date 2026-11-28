/**
 * Tara's conversations: the one you're in, and recent ones to go back to. Kept only in this browser (never sent to
 * the server beyond the last few turns of the conversation you're having), one list per signed-in account, so two
 * people sharing a browser with different sign-ins don't see each other's chats. Capped in size; each can be deleted.
 *
 * A tiny external store (useSyncExternalStore): the sidebar's list and the assistant's thread stay in step.
 */
import { useSyncExternalStore } from 'react'

const PREFIX = 'tara-chats'
export const MAX_CHATS = 25
const MAX_TURNS = 40
const MAX_TEXT = 2000

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `c${Date.now()}${Math.random().toString(36).slice(2, 8)}`)

let who = 'browser'
let state = { current: newId(), list: read(who) }
const subs = new Set()
const emit = () => subs.forEach((f) => f())

function read(owner) {
  try {
    const raw = JSON.parse(localStorage.getItem(`${PREFIX}:${owner}`) ?? '[]')
    return Array.isArray(raw) ? raw.filter((c) => c && typeof c.id === 'string' && Array.isArray(c.turns)) : []
  } catch {
    return []
  }
}

function write() {
  try {
    localStorage.setItem(`${PREFIX}:${who}`, JSON.stringify(state.list))
  } catch {
    /* storage full or blocked: the chat still works, it just isn't kept */
  }
}

/** Only what's needed to show a turn again (no undo handles, no saved-entry payloads). */
export function slim(turn) {
  const t = { id: turn.id, role: turn.role, text: String(turn.text ?? '').slice(0, MAX_TEXT) }
  for (const k of ['card', 'action', 'persona', 'error', 'kind']) if (turn[k]) t[k] = turn[k]
  return t
}

/** A chat's title: the first thing the user asked, trimmed to a line. */
export function titleOf(turns) {
  const first = turns.find((t) => t.role === 'user')?.text ?? 'New conversation'
  const line = first.replace(/\s+/g, ' ').trim()
  return line.length > 48 ? `${line.slice(0, 47)}…` : line
}

function subscribe(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}
const snapshot = () => state

/** { current, list } — list is newest first: [{ id, title, at, turns }]. */
export function useChats() {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** A short, stable label for an account (so the email itself isn't written into storage keys). */
export function ownerFor(email) {
  if (!email) return 'browser'
  let h = 0x811c9dc5
  for (const ch of email.trim().toLowerCase()) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0
  return `u${h.toString(36)}`
}

/** Whose chats these are (see ownerFor). Switching shows that person's list. */
export function setChatOwner(owner) {
  const next = owner || 'browser'
  if (next === who) return
  who = next
  state = { current: newId(), list: read(who) }
  emit()
}

export function newChat() {
  state = { ...state, current: newId() }
  emit()
}

export function openChat(id) {
  if (!state.list.some((c) => c.id === id)) return
  state = { ...state, current: id }
  emit()
}

export const turnsOf = (id) => state.list.find((c) => c.id === id)?.turns ?? []

/** Keep a conversation (called as it grows). Empty conversations are never listed. */
export function saveChat(id, turns) {
  if (!turns.length) return
  const kept = turns.slice(-MAX_TURNS).map(slim)
  const chat = { id, title: titleOf(kept), at: Date.now(), turns: kept }
  state = { ...state, list: [chat, ...state.list.filter((c) => c.id !== id)].slice(0, MAX_CHATS) }
  write()
  emit()
}

export function removeChat(id) {
  state = { current: state.current === id ? newId() : state.current, list: state.list.filter((c) => c.id !== id) }
  write()
  emit()
}

/** For tests. */
export function _reset(owner = 'browser') {
  who = owner
  state = { current: newId(), list: read(who) }
  emit()
}
