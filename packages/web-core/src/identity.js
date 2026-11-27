/**
 * Who this browser is, for every product's API: a random id made once and kept in this browser (`X-Visitor`), plus
 * the signed-in account's token when there is one (`Authorization: Bearer …`). The backend keeps each person's data
 * apart with these (backend/app/identity.py): never another visitor's reminders, repos or investigations.
 */
import { accountToken } from './account'

const KEY = 'site-visitor'

function random() {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

let memo = null
/** This browser's id (created on first use; kept for the session only if storage is blocked). */
export function visitorId() {
  if (memo) return memo
  try {
    memo = localStorage.getItem(KEY)
    if (!memo || !/^[A-Za-z0-9_-]{16,128}$/.test(memo)) {
      memo = random()
      localStorage.setItem(KEY, memo)
    }
  } catch {
    memo ??= random()
  }
  return memo
}

/** The site owner's key, if this is the owner's browser (unlocked once in Insights, the control room or Tara). */
function ownerKey() {
  try {
    return localStorage.getItem('tara-owner-key') || ''
  } catch {
    return ''
  }
}

/** Headers that say who is calling: always the browser id, the account token when signed in, and the owner's key on
 * the owner's own browser (so the owner sees their own data in every product). */
export async function identityHeaders() {
  const token = await accountToken()
  const owner = ownerKey()
  return { 'X-Visitor': visitorId(), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(owner ? { 'X-Tara-Owner-Key': owner } : {}) }
}
