/**
 * Optional sign-in, at the top of "My trips": Google, or a link sent by email. Signing in moves the trips this browser
 * made into the account, so they show on every device. Hidden while the server hasn't got sign-in turned on.
 */
import { LogOut, Mail, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { inputClass } from '@appcore/web/ui'
import { accountState, loadAccount, onAccount, sendSignInLink, signInWithGoogle, signOut } from './account'
import { trips as tripsApi } from './api'

let started = false
let serverOn = null // the API's answer, asked once per page load

export function useAccount() {
  const [s, setS] = useState(accountState)
  useEffect(() => {
    const off = onAccount(setS)
    if (!started) {
      started = true
      void loadAccount()
    }
    return off
  }, [])
  return s
}

export function AccountBar({ onTrips }) {
  const { user, ready } = useAccount()
  const [enabled, setEnabled] = useState(serverOn)
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    if (serverOn !== null) return
    tripsApi.account().then((a) => setEnabled((serverOn = !!a.enabled))).catch(() => setEnabled(false))
  }, [])

  // Once signed in, bring this browser's trips into the account (safe to repeat: nothing left moves 0).
  const email0 = user?.email
  useEffect(() => {
    if (!email0 || !enabled) return
    tripsApi.claim().then(({ moved }) => {
      if (moved) setMsg(`Moved ${moved} trip${moved === 1 ? '' : 's'} from this browser into your account.`)
      onTrips?.()
    }).catch(() => onTrips?.())
  }, [email0, enabled, onTrips])

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

  if (user)
    return (
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-2 text-[12.5px] text-ink-400">
        {user.image ? <img src={user.image} alt="" referrerPolicy="no-referrer" className="size-6 rounded-full" /> : <UserRound className="size-4" />}
        <span>Signed in as <span className="text-ink-200">{user.name || user.email}</span>: your trips show on every device.</span>
        <button type="button" className="inline-flex items-center gap-1 hover:text-white" onClick={() => void run(async () => { await signOut(); onTrips?.() })}><LogOut className="size-3.5" /> Sign out</button>
        {msg && <span className="w-full text-center text-emerald-300">{msg}</span>}
      </div>
    )

  return (
    <div className="mx-auto max-w-md text-center text-[12.5px] text-ink-400">
      {!open ? (
        <p>
          <button type="button" className="font-medium text-ink-200 underline-offset-4 hover:text-white hover:underline" onClick={() => setOpen(true)}>Sign in</button>{' '}
          to keep your trips on every device. Optional: everything works without it.
        </p>
      ) : sent ? (
        <p className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3 text-ink-200">
          <Mail className="mr-1 inline size-4" /> Check {email} for a sign-in link. It works once and expires soon.{' '}
          <button type="button" className="text-ink-400 underline hover:text-white" onClick={() => setSent(false)}>Use another email</button>
        </p>
      ) : (
        <div className="space-y-2 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4">
          <button type="button" disabled={busy} onClick={() => void run(signInWithGoogle)} className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-4 py-2 text-[13.5px] font-semibold text-[#1f1f1f] hover:bg-white/90">
            <GoogleMark /> Continue with Google
          </button>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { await sendSignInLink(email.trim()); setSent(true) }) }}>
            <input type="email" required autoComplete="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" aria-label="Email" />
            <button type="submit" disabled={busy || !email.includes('@')} className="chip shrink-0">Email me a link</button>
          </form>
          <p className="text-[11.5px] text-ink-500">Your trips made on this browser move into the account. We only keep your account ID with them.</p>
          <button type="button" className="text-[11.5px] text-ink-500 hover:text-white" onClick={() => setOpen(false)}>Not now</button>
        </div>
      )}
      {msg && <p className="mt-2 text-rose-300">{msg}</p>}
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
