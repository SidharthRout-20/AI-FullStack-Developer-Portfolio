/**
 * Optional sign-in (Google or an emailed link) through Neon Auth. Signed in, trips belong to the account and show on
 * every device; signed out, Safarnaama works as before with this browser's owner token.
 *
 * The Neon client is loaded only when it's needed (someone signs in, is signed in, or is coming back from a sign-in),
 * so visitors who never sign in don't download it.
 */
import { NEON_AUTH_URL } from './config'

const HINT = 'safarnaama-signed-in' // "this browser has signed in": load the client on start-up
const VERIFIER = 'neon_auth_session_verifier' // on the URL right after Google sends the traveller back
const listeners = new Set()
let neon = null
let state = { user: null, ready: false }

const safe = (fn, fallback = null) => {
  try {
    return fn()
  } catch {
    return fallback
  }
}
const hinted = () => safe(() => localStorage.getItem(HINT) === '1', false)
const returning = () => safe(() => new URLSearchParams(location.search).has(VERIFIER), false)

function set(next) {
  state = { ...state, ...next }
  safe(() => (state.user ? localStorage.setItem(HINT, '1') : localStorage.removeItem(HINT)))
  for (const fn of listeners) fn(state)
}

async function client() {
  neon ??= import('@neon/auth').then(({ createInternalNeonAuth }) =>
    createInternalNeonAuth(NEON_AUTH_URL, { fetchOptions: { credentials: 'include' } }),
  )
  return neon
}

/** Who is signed in ({ user: { name, email, image } | null, ready }). */
export const accountState = () => state
export function onAccount(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Check the session once at start-up (only if this browser has signed in before, or is coming back from it). */
export async function loadAccount() {
  if (!NEON_AUTH_URL || (!hinted() && !returning())) return set({ ready: true })
  try {
    const { adapter } = await client()
    const { data } = await adapter.getSession()
    set({ user: data?.user ? pick(data.user) : null, ready: true })
  } catch {
    set({ ready: true }) // auth server unreachable: keep the hint and carry on as this browser
  }
}

const pick = (u) => ({ name: u.name || '', email: u.email || '', image: u.image || '' })

/** The short-lived token the API checks, or null when signed out. */
export async function accountToken() {
  if (!state.user) return null
  try {
    const { getJWTToken } = await client()
    return (await getJWTToken()) || null
  } catch {
    return null
  }
}

const back = () => location.href.split('#')[0]

export async function signInWithGoogle() {
  const { adapter } = await client()
  const res = await adapter.signIn.social({ provider: 'google', callbackURL: back() })
  if (res?.error) throw new Error(res.error.message || 'Google sign-in failed.')
}

export async function sendSignInLink(email) {
  const { adapter } = await client()
  const res = await adapter.signIn.magicLink({ email, callbackURL: back() })
  if (res?.error) throw new Error(res.error.message || "Couldn't send the sign-in link.")
}

export async function signOut() {
  try {
    const { adapter } = await client()
    await adapter.signOut()
  } finally {
    set({ user: null })
  }
}
