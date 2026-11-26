/**
 * Insights (owner only): who visits the site, where they come from and what they look at, with advice computed
 * from those numbers. Counted without cookies or raw IPs (backend/app/visits.py); the owner key unlocks it.
 */
import { ArrowLeft, Check, Copy, KeyRound, Lightbulb, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from '@appcore/web/router'
import { API_BASE } from '../lib/apiBase'
import { isIgnored, setIgnored } from '../lib/visits'
import { getOwnerKey, setOwnerKey } from '../products/keeper/api'
import { SiteHeader } from './HubPage'

const PERIODS = [7, 30, 45]
const fmt = (n) => (n == null ? '—' : n >= 10000 ? `${(n / 1000).toFixed(1)}K` : n.toLocaleString())
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const EVENT_NAMES = { tara_ask: 'Questions asked to Tara', contact: 'Messages sent', resume: 'Résumé opened', email: 'Email links clicked', outbound: 'Links out (GitHub, LinkedIn…)' }
const SHARE = [
  ['LinkedIn', 'linkedin'],
  ['GitHub', 'github'],
  ['Résumé', 'resume'],
  ['Email', 'email'],
  ['X', 'x'],
  ['WhatsApp', 'whatsapp'],
]

async function load(days, key) {
  const res = await fetch(`${API_BASE}/api/visits/summary?days=${days}`, { headers: { 'X-Tara-Owner-Key': key } })
  if (res.status === 404) throw new Error("This backend doesn't count visits yet (it's an older deployment).")
  if (!res.ok) {
    const d = await res.json().catch(() => null)
    const err = new Error(d?.detail ?? `Request failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return res.json()
}

export function InsightsPage() {
  const [key, setKey] = useState(getOwnerKey)
  const [days, setDays] = useState(30)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null) // which (period, key) the shown result is for
  const want = `${days}|${key}`
  const busy = !!key && done !== want

  useEffect(() => {
    if (!key) return
    let live = true
    load(days, key)
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && (setError(e), e.status === 403 && setData(null)))
      .finally(() => live && setDone(`${days}|${key}`))
    return () => {
      live = false
    }
  }, [days, key])

  const unlock = (k) => {
    setOwnerKey(k)
    setIgnored(true) // the owner's own visits would skew the numbers
    setKey(k)
  }
  const locked = !key || error?.status === 403

  return (
    <div className="min-h-full">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 pt-26 pb-20 sm:px-5 sm:pt-30">
        <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] text-ink-400 hover:text-white"><ArrowLeft className="size-4" /> Home</Link>
        <header className="mt-4">
          <p className="text-[12px] font-semibold tracking-[0.18em] text-cyan-300 uppercase">Insights · owner only</p>
          <h1 className="mt-2 text-[32px] leading-tight font-semibold text-white sm:text-[44px]">Who’s visiting, and from where.</h1>
          <p className="mt-3 max-w-2xl text-[15px] text-ink-300">
            Real visits to this site, counted without cookies or IP addresses. Use it to see which channel brings people and what they open, then share more of what works.
          </p>
        </header>

        {locked ? (
          <KeyForm onUnlock={unlock} wrong={error?.status === 403} />
        ) : (
          <>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <div role="tablist" aria-label="Period" className="flex gap-1 rounded-2xl border border-white/[0.07] bg-ink-900/60 p-1">
                {PERIODS.map((d) => (
                  <button key={d} type="button" role="tab" aria-selected={days === d} onClick={() => setDays(d)}
                    className={`rounded-xl px-3 py-1.5 text-[13px] font-medium transition ${days === d ? 'bg-white/[0.1] text-white' : 'text-ink-400 hover:text-white'}`}>
                    Last {d} days
                  </button>
                ))}
              </div>
              {busy && <LoaderCircle className="size-4 animate-spin text-ink-400" aria-label="Loading" />}
              <IgnoreToggle />
            </div>
            {error && <p className="mt-4 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] px-4 py-2 text-[13px] text-rose-200">{error.message}</p>}
            {data && <Report d={data} />}
          </>
        )}
      </main>
    </div>
  )
}

function KeyForm({ onUnlock, wrong }) {
  const [v, setV] = useState('')
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (v.trim()) onUnlock(v.trim()) }} className="mt-8 max-w-md rounded-3xl border border-white/[0.07] bg-ink-900/60 p-5">
      <p className="flex items-center gap-2 text-[14px] font-semibold text-white"><KeyRound className="size-4" /> Enter the owner key</p>
      <p className="mt-1 text-[13px] text-ink-400">The same key that unlocks Tara’s code proposals (TARA_OWNER_KEY). It stays in this browser, which also stops counting your own visits.</p>
      {wrong && <p className="mt-2 text-[13px] text-rose-300">That key didn’t work.</p>}
      <div className="mt-3 flex gap-2">
        <input type="password" value={v} onChange={(e) => setV(e.target.value)} aria-label="Owner key" autoComplete="current-password"
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[14px] text-white outline-none focus:border-cyan-400/50" />
        <button type="submit" className="rounded-xl bg-white/[0.1] px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-white/[0.16]">Unlock</button>
      </div>
    </form>
  )
}

function IgnoreToggle() {
  const [on, setOn] = useState(isIgnored)
  return (
    <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink-400">
      <input type="checkbox" checked={on} onChange={(e) => { setIgnored(e.target.checked); setOn(e.target.checked) }} className="accent-cyan-400" />
      Don’t count my visits on this browser
    </label>
  )
}

function Report({ d }) {
  const c = d.current
  const p = d.previous
  return (
    <>
      <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Tile label="Page views" v={fmt(c.views)} now={c.views} before={p.views} />
        <Tile label="Visitors" v={fmt(c.visitors)} now={c.visitors} before={p.visitors} hint={d.visitor_hash ? 'unique per day' : 'counted by visit'} />
        <Tile label="Visits" v={fmt(c.sessions)} now={c.sessions} before={p.sessions} />
        <Tile label="Pages per visit" v={c.pages_per_session ?? '—'} now={c.pages_per_session} before={p.pages_per_session} />
        <Tile label="Opened a product" v={pct(c.explored_rate)} now={c.explored_rate} before={p.explored_rate} />
        <Tile label="Left after one page" v={pct(c.bounce_rate)} now={c.bounce_rate} before={p.bounce_rate} downIsGood />
      </section>

      <section className="mt-4 rounded-3xl border border-white/[0.07] bg-ink-900/60 p-5">
        <h2 className="text-[14px] font-semibold text-white">Page views per day</h2>
        <p className="text-[12px] text-ink-500">Last {d.days} days, UTC. Hover a day for its numbers.</p>
        <Daily rows={d.daily} />
      </section>

      <section className="mt-4 rounded-3xl border border-white/[0.07] bg-ink-900/60 p-5">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-white"><Lightbulb className="size-4 text-amber-300" /> What to do next</h2>
        <ul className="mt-3 grid gap-3 md:grid-cols-2">
          {d.advice.map((a) => (
            <li key={a.title} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[14px] font-medium text-white">{a.title}</p>
              <p className="mt-1 text-[13px] text-ink-400">{a.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Bars title="Where they came from" rows={d.top.sources} total={c.views} />
        <Bars title="What they looked at" rows={d.top.sections} total={c.views} />
        <Bars title="Top pages" rows={d.top.pages} total={c.views} mono />
        <Bars title="Devices" rows={d.top.devices} total={c.views} />
        <Bars title="Browsers" rows={d.top.browsers} total={c.views} />
        <Bars title="Systems" rows={d.top.os} total={c.views} />
        <Bars title="Countries" rows={d.top.countries.map((x) => ({ ...x, name: x.name || 'Unknown' }))} total={c.views} />
        <div className="min-w-0 rounded-3xl border border-white/[0.07] bg-ink-900/60 p-5">
          <h2 className="text-[14px] font-semibold text-white">What they did</h2>
          <dl className="mt-3 space-y-2 text-[13px]">
            {Object.entries(EVENT_NAMES).map(([k, label]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-ink-400">{label}</dt>
                <dd className="font-semibold text-white tabular-nums">{fmt(d.events[k] ?? 0)}</dd>
              </div>
            ))}
          </dl>
        </div>
        <ShareLinks />
      </section>

      <p className="mt-8 text-[12px] text-ink-500">
        Counted without cookies: a visitor is a hash of the day, network and browser that changes daily, so people are never followed across days. No IP address, query text or anything typed is stored. Do Not Track, local development and your own browser are not counted.
      </p>
    </>
  )
}

function Tile({ label, v, now, before, hint, downIsGood = false }) {
  const delta = now != null && before ? (now - before) / before : null
  const good = delta == null || delta === 0 ? null : (delta > 0) !== downIsGood
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-ink-900/60 p-4">
      <p className="text-[12px] text-ink-400">{label}</p>
      <p className="mt-1 text-[24px] font-semibold text-white tabular-nums">{v}</p>
      <p className="text-[11.5px] text-ink-500">
        {delta == null ? (hint ?? 'no earlier period to compare') : (
          <span className={good == null ? '' : good ? 'text-emerald-300' : 'text-rose-300'}>
            {delta > 0 ? '▲' : delta < 0 ? '▼' : '='} {Math.abs(Math.round(delta * 100))}% vs previous
          </span>
        )}
      </p>
    </div>
  )
}

/** One series of columns (≤24px, rounded data-end, 2px gaps), hairline grid, a per-day tooltip. */
function Daily({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.views))
  const half = max <= 4 ? 2 : 10 ** Math.floor(Math.log10(max)) / 2 // clean ticks: 0, half-way, top
  const top = Math.ceil(max / half / 2) * half * 2
  const day = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })
  return (
    <div className="mt-4">
      <div className="relative h-44">
        {[0, 0.5, 1].map((f) => (
          <div key={f} className="absolute inset-x-0 border-t border-white/[0.06]" style={{ bottom: `${f * 100}%` }}>
            <span className="absolute -top-2 left-0 bg-transparent text-[10.5px] text-ink-500 tabular-nums">{Math.round(top * f)}</span>
          </div>
        ))}
        <div className="absolute inset-0 left-7 flex items-end gap-[2px]">
          {rows.map((r) => (
            <div key={r.day} className="group relative flex h-full flex-1 items-end justify-center" tabIndex={0} aria-label={`${day(r.day)}: ${r.views} views, ${r.visitors} visitors`}>
              <div className="w-full max-w-6 rounded-t-[4px] bg-cyan-400 transition-opacity group-hover:opacity-80" style={{ height: `${(r.views / top) * 100}%`, minHeight: r.views ? 2 : 0 }} />
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-lg border border-white/10 bg-ink-950 px-2.5 py-1.5 text-[11.5px] whitespace-nowrap text-ink-200 shadow-lg group-hover:block group-focus:block">
                <span className="font-semibold text-white">{day(r.day)}</span> · {r.views} views · {r.visitors} visitors
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-1.5 ml-7 flex justify-between text-[10.5px] text-ink-500">
        <span>{day(rows[0]?.day)}</span>
        <span>{day(rows.at(-1)?.day)}</span>
      </div>
    </div>
  )
}

function Bars({ title, rows, total, mono = false }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <div className="min-w-0 rounded-3xl border border-white/[0.07] bg-ink-900/60 p-5">
      <h2 className="text-[14px] font-semibold text-white">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-500">Nothing yet.</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {rows.map((r) => (
            <li key={r.name} title={`${r.count} views · ${pct(r.count / Math.max(1, total))}`}>
              <div className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className={`truncate text-ink-200 ${mono ? 'font-mono text-[12px]' : ''}`}>{r.name}</span>
                <span className="shrink-0 text-ink-400 tabular-nums">{fmt(r.count)} <span className="text-ink-500">· {pct(r.count / Math.max(1, total))}</span></span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-white/[0.05]">
                <div className="h-full rounded-full bg-cyan-400/80" style={{ width: `${(r.count / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Links tagged with where they're shared, so each channel shows up by name under "Where they came from". */
function ShareLinks() {
  const [copied, setCopied] = useState(null)
  const base = `${location.origin}/`
  const copy = async (url, id) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(id)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      /* clipboard blocked: the link is visible to copy by hand */
    }
  }
  return (
    <div className="min-w-0 rounded-3xl border border-white/[0.07] bg-ink-900/60 p-5 lg:col-span-1">
      <h2 className="text-[14px] font-semibold text-white">Links to share</h2>
      <p className="text-[12px] text-ink-500">Each one shows up by its channel’s name.</p>
      <ul className="mt-3 space-y-1.5">
        {SHARE.map(([label, tag]) => {
          const url = `${base}?ref=${tag}`
          return (
            <li key={tag} className="flex items-center gap-2 text-[12.5px]">
              <span className="w-20 shrink-0 text-ink-300">{label}</span>
              <code className="min-w-0 flex-1 truncate text-ink-500">{url}</code>
              <button type="button" onClick={() => void copy(url, tag)} aria-label={`Copy the ${label} link`} className="rounded-lg p-1.5 text-ink-400 hover:bg-white/[0.06] hover:text-white">
                {copied === tag ? <Check className="size-3.5 text-emerald-300" /> : <Copy className="size-3.5" />}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
