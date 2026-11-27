/**
 * One sign-in for every product (Google, or a link sent by email), in each product's header and Tara's sidebar.
 *
 * Optional: everything works without it, privately for this browser. Signed in, your Tara items, CodeLens repos,
 * Jasoos investigations and Safarnaama trips follow your account to every device. On signing in, what this browser
 * already made moves into the account (claimAll), wherever you signed in from.
 */
import { LogOut, Mail, UserRound } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { accountState, loadAccount, onAccount, sendSignInLink, signInWithGoogle, signOut } from '@appcore/web/account'
import { identityHeaders } from '@appcore/web/identity'
import { API_BASE } from '../lib/apiBase'

let serverOn = null // is sign-in turned on at the API? asked once per page

/** The account state, kept in step with every other product on the page. */
export function useAccount() {
  const [s, setS] = useState(accountState)
  useEffect(() => {
    const off = onAccount((next) => setS({ ...next }))
    void loadAccount()
    return off
  }, [])
  return s
}

/** Move this browser's things into the account that just signed in (each product; safe to repeat). */
export async function claimAll() {
  const headers = { Accept: 'application/json', ...(await identityHeaders()) }
  const paths = ['/api/keeper/claim', '/api/code/claim', '/api/trips/claim']
  const results = await Promise.allSettled(paths.map((p) => fetch(`${API_BASE}${p}`, { method: 'POST', headers }).then((r) => (r.ok ? r.json() : { moved: 0 }))))
  const moved = results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value?.moved ?? 0 : 0), 0)
  window.dispatchEvent(new CustomEvent('account-claimed', { detail: { moved } }))
  return moved
}

// Claim once per sign-in, whichever component sees it first.
let claimedFor = null
onAccount((s) => {
  const email = s.user?.email
  if (email && claimedFor !== email) {
    claimedFor = email
    void claimAll()
  }
  if (!s.user) claimedFor = null
})

function useServerOn() {
  const [on, setOn] = useState(serverOn)
  useEffect(() => {
    if (serverOn !== null) return
    fetch(`${API_BASE}/api/trips/account`, { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((a) => setOn((serverOn = !!a.enabled)))
      .catch(() => setOn((serverOn = false)))
  }, [])
  return on
}

export function AccountButton({ className = '' }) {
  const { user, ready } = useAccount()
  const enabled = useServerOn()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const box = useRef(null)

  useEffect(() => {
    if (!open) return
    const close = (e) => {
      if (e.key === 'Escape' || (e.type === 'pointerdown' && box.current && !box.current.contains(e.target))) setOpen(false)
    }
    window.addEventListener('keydown', close)
    window.addEventListener('pointerdown', close)
    return () => {
      window.removeEventListener('keydown', close)
      window.removeEventListener('pointerdown', close)
    }
  }, [open])

  if (!enabled || !ready) return null
  const run = async (fn) => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
    } catch (e) {
      setMsg(e.message || 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={box} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={user ? `Signed in as ${user.name || user.email}` : 'Sign in'}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 px-2.5 text-[12.5px] font-medium text-ink-200 hover:border-white/20 hover:text-white"
      >
        {user?.image ? <img src={user.image} alt="" referrerPolicy="no-referrer" className="size-5 rounded-full" /> : <UserRound className="size-4" />}
        <span className="hidden sm:inline">{user ? (user.name || user.email).split(' ')[0] : 'Sign in'}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Account"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="glass absolute right-0 z-50 mt-2 w-[min(320px,calc(100vw-24px))] rounded-2xl border border-white/10 p-4 text-left text-[12.5px] text-ink-300 shadow-2xl"
          >
            {user ? (
              <>
                <p className="text-ink-200">Signed in as <span className="font-semibold text-white">{user.name || user.email}</span></p>
                <p className="mt-1">Your Tara, CodeLens repos, Jasoos investigations and trips follow you to every device.</p>
                <button type="button" disabled={busy} onClick={() => void run(signOut)} className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-ink-200 hover:text-white">
                  <LogOut className="size-3.5" /> Sign out
                </button>
              </>
            ) : sent ? (
              <p className="text-ink-200">
                <Mail className="mr-1 inline size-4" /> Check {email} for a sign-in link. It works once and expires soon.{' '}
                <button type="button" className="text-ink-400 underline hover:text-white" onClick={() => setSent(false)}>Use another email</button>
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-ink-200">Optional: everything works without it, for this browser only.</p>
                <button type="button" disabled={busy} onClick={() => void run(signInWithGoogle)} className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-4 py-2 text-[13.5px] font-semibold text-[#1f1f1f] hover:bg-white/90">
                  <GoogleMark /> Continue with Google
                </button>
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { await sendSignInLink(email.trim()); setSent(true) }) }}>
                  <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" aria-label="Email"
                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white outline-none focus:border-cyan-400/50" />
                  <button type="submit" disabled={busy || !email.includes('@')} className="shrink-0 rounded-xl border border-white/10 px-3 py-2 text-ink-200 hover:text-white disabled:opacity-50">Email link</button>
                </form>
                <p className="text-[11.5px] text-ink-500">What you made on this browser moves into the account. Only an account ID is kept with it.</p>
              </div>
            )}
            {msg && <p className="mt-2 text-rose-300">{msg}</p>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7Z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1 .7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9h-4v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.7V6.6h-4a12 12 0 0 0 0 10.9l4-3.1Z" />
      <path fill="#EA4335" d="M12 4.8c1.7 0 3.3.6 4.5 1.8l3.4-3.4A12 12 0 0 0 1.4 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8Z" />
    </svg>
  )
}
