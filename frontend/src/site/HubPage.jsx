import { CircleCheck, LoaderCircle, Menu, Send, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { API_BASE } from '../lib/apiBase'
import { Link } from '@appcore/web/router'
import { useSkin } from '../theme/theme'
import { ThemeToggle } from '../theme/ThemeToggle'
import { PaletteButton } from './CommandPalette'
import { SITE } from './config'
import { MiniPortrait } from './Portrait'
import { track } from '../lib/visits'
import { ShowcaseHub, ShowcaseNav } from './ShowcaseHub'
import { SkillsChat } from './SkillsChat'

const SECTIONS = [
  { id: 'about', label: 'About' },
  { id: 'expertise', label: 'Expertise' },
  { id: 'experience', label: 'Experience' },
  { id: 'projects', label: 'Projects' },
  { id: 'contact', label: 'Contact' },
]

// ── Navigation ─────────────────────────────────────────────────────────────
function useActiveSection(enabled) {
  const [active, setActive] = useState('about')
  useEffect(() => {
    if (!enabled) return
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
        if (visible) setActive(visible.target.id)
      },
      { rootMargin: '-40% 0px -55% 0px', threshold: [0, 0.25, 0.5] },
    )
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id)
      if (el) io.observe(el)
    })
    return () => io.disconnect()
  }, [enabled])
  return active
}

/** Sticky navigation. On the portfolio it scroll-spies sections; on other pages links go back to `/#section`. */
export function SiteHeader({ home = false }) {
  return useSkin() === 'showcase' ? <ShowcaseNav home={home} /> : <PersonalHeader home={home} />
}

function PersonalHeader({ home }) {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const active = useActiveSection(home)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const href = (id) => (home ? `#${id}` : `/#${id}`)

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 transition-all duration-300 ${
        scrolled || open ? 'border-b border-white/[0.06] bg-ink-950/75 backdrop-blur-xl' : 'border-b border-transparent'
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-5">
        <Link to="/" className="flex items-center gap-2.5" onClick={() => home && window.scrollTo({ top: 0, behavior: 'smooth' })}>
          <MiniPortrait square className="size-9 text-[30px] shadow-lg shadow-indigo-950/40" />
          <span className="hidden text-[15px] font-semibold tracking-tight text-white sm:block">{SITE.owner}</span>
        </Link>

        <nav aria-label="Sections" className="ml-auto hidden md:block">
          <ul className="flex items-center gap-1 rounded-full border border-white/[0.06] bg-ink-900/40 p-1 backdrop-blur">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a
                  href={href(s.id)}
                  className={`relative block rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                    home && active === s.id ? 'text-white' : 'text-ink-400 hover:text-white'
                  }`}
                >
                  {home && active === s.id && (
                    <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-full bg-white/[0.08] ring-1 ring-white/10" transition={{ type: 'spring', stiffness: 400, damping: 34 }} />
                  )}
                  <span className="relative">{s.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <PaletteButton />
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            className="grid size-9 place-items-center rounded-full border border-white/10 text-ink-200 md:hidden"
          >
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {open && (
          <motion.nav
            aria-label="Sections"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden md:hidden"
          >
            <ul className="space-y-1 px-5 pb-5">
              {SECTIONS.map((s, i) => (
                <motion.li key={s.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}>
                  <a href={href(s.id)} onClick={() => setOpen(false)} className="block rounded-xl px-3 py-2.5 text-[15px] text-ink-100 hover:bg-white/[0.05]">
                    {s.label}
                  </a>
                </motion.li>
              ))}
            </ul>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────
export function HubPage() {
  return (
    <>
      {useSkin() === 'showcase' ? (
        <ShowcaseHub />
      ) : (
        <Suspense fallback={<div className="min-h-screen" />}>
          <PersonalSpace />
        </Suspense>
      )}
      <SkillsChat />
    </>
  )
}

// The personal space is its own chunk: Studio visitors never download it (or its font).
const PersonalSpace = lazy(() => import('./personal/PersonalSpace').then((m) => ({ default: m.PersonalSpace })))

// ── Contact ────────────────────────────────────────────────────────────────
/** The contact form (shared by both skins): posts to /api/contact, with a honeypot field for bots. */
export function ContactForm() {
  const [form, setForm] = useState({ name: '', email: '', message: '', website: '' })
  const [state, setState] = useState('idle')
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setState('sending')
    setError('')
    try {
      const res = await fetch(`${API_BASE}/api/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        throw new Error(
          res.status === 429
            ? 'Too many messages. Please try again in a minute.'
            : res.status === 422
              ? 'Please check your email address and write at least 10 characters.'
              : 'Something went wrong. Please email me directly instead.',
        )
      }
      setState('sent')
      track('contact')
      setForm({ name: '', email: '', message: '', website: '' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setState('error')
    }
  }

  const field = 'w-full rounded-2xl border border-white/10 bg-ink-950/40 px-4 py-3 text-[14.5px] text-white outline-none transition placeholder:text-ink-500 focus:border-brand-400/60'

  return (
    <form onSubmit={(e) => void submit(e)} className="glass relative overflow-hidden rounded-3xl p-6 sm:p-8" aria-label="Contact form">
      <AnimatePresence mode="wait">
        {state === 'sent' ? (
          <motion.div key="sent" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="grid min-h-80 place-items-center text-center">
            <div>
              <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 16 }} className="mx-auto grid size-16 place-items-center rounded-full bg-emerald-500/15 text-emerald-300">
                <CircleCheck className="size-8" />
              </motion.span>
              <h3 className="mt-4 text-xl font-semibold text-white">Message sent</h3>
              <p className="mt-1 text-[14px] text-ink-300">Thanks for reaching out, I'll reply soon.</p>
              <button type="button" onClick={() => setState('idle')} className="mt-5 text-[13px] text-cyan-300 hover:underline">Send another</button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-[12.5px] font-medium text-ink-300">Name</span>
                <input id="contact-name" required minLength={2} maxLength={80} className={`${field} mt-1.5`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Your name" autoComplete="name" />
              </label>
              <label className="block">
                <span className="text-[12.5px] font-medium text-ink-300">Email</span>
                <input id="contact-email" required type="email" maxLength={254} className={`${field} mt-1.5`} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@company.com" autoComplete="email" />
              </label>
            </div>
            <label className="block">
              <span className="text-[12.5px] font-medium text-ink-300">Message</span>
              <textarea id="contact-message" required minLength={10} maxLength={3000} rows={6} className={`${field} mt-1.5 resize-y`} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder="What would you like to build?" />
            </label>
            {/* honeypot: hidden from people, irresistible to bots */}
            <input tabIndex={-1} autoComplete="off" aria-hidden className="absolute -left-[9999px] size-px opacity-0" name="website" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
            {state === 'error' && <p role="alert" className="text-[13px] text-rose-300">{error}</p>}
            <button type="submit" disabled={state === 'sending'} className="btn-primary inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500 py-3 text-[14.5px] font-semibold text-on-accent shadow-lg shadow-indigo-950/30 transition hover:brightness-110 disabled:opacity-60">
              {state === 'sending' ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
              {state === 'sending' ? 'Sending…' : 'Send message'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </form>
  )
}
