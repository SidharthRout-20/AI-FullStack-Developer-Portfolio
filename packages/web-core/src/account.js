/**
 * One sign-in for every product (Google or an emailed link) through Neon Auth. Signed in, your things belong to your
 * account and follow you to every device; signed out, each product still works, privately, for this browser
 * (see identity.js).
 *
 * The Neon client is loaded only when it's needed (someone signs in, is signed in, or is coming back from a sign-in),
 * so visitors who never sign in don't download it. One module, one state: signing in from any product updates all.
 */

/** Neon Auth project (not a secret: the backend checks sign-ins against the public keys it publishes). */
const DEPLOYED_AUTH = 'https://ep-flat-unit-bb9fi63x.neonauth.c-15.us-east-1.aws.neon.tech/neondb/auth'
export const NEON_AUTH_URL = (import.meta.env?.VITE_NEON_AUTH_URL || DEPLOYED_AUTH).replace(/\/$/, '')

const HINT = 'site-signed-in' // "this browser has signed in": check the session on start-up
const OLD_HINT = 'safarnaama-signed-in' // the same, from before sign-in covered every product
const VERIFIER = 'neon_auth_session_verifier' // on the URL right after Google sends the user back
const listeners = new Set()
let neon = null
let loading = null
let state = { user: null, ready: false }

const safe = (fn, fallback = null) => {
  try {
    return fn()
  } catch {
    return fallback
  }
}
const hinted = () => safe(() => localStorage.getItem(HINT) === '1' || localStorage.getItem(OLD_HINT) === '1', false)
const returning = () => safe(() => new URLSearchParams(location.search).has(VERIFIER), false)

function set(next) {
  const was = state.user
  state = { ...state, ...next }
  safe(() => {
    if (state.user) localStorage.setItem(HINT, '1')
    else {
      localStorage.removeItem(HINT)
      localStorage.removeItem(OLD_HINT)
    }
  })
  for (const fn of listeners) fn(state, was)
}

async function client() {
  neon ??= import('@neon/auth').then(({ createInternalNeonAuth }) =>
    createInternalNeonAuth(NEON_AUTH_URL, { fetchOptions: { credentials: 'include' } }),
  )
  return neon
}

/** Who is signed in ({ user: { name, email, image } | null, ready }). */
export const accountState = () => state
/** Called with (state, previousUser) whenever sign-in changes. Returns an unsubscribe function. */
export function onAccount(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Check the session once (only if this browser has signed in before, or is coming back from it). Safe to call often. */
export function loadAccount() {
  loading ??= (async () => {
    if (!NEON_AUTH_URL || (!hinted() && !returning())) return set({ ready: true })
    try {
      const { adapter } = await client()
      const { data } = await adapter.getSession()
      set({ user: data?.user ? pick(data.user) : null, ready: true })
    } catch {
      set({ ready: true }) // auth server unreachable: keep the hint and carry on as this browser
    }
  })()
  return loading
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

/** For tests: forget the cached session check. */
export function _resetForTests() {
  loading = null
  state = { user: null, ready: false }
}
