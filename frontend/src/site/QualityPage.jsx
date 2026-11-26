/**
 * Quality: how well each product works, measured. Every number comes from a stored run (date, dataset size and
 * misses included); runs can be started here for one product or the whole application.
 */
import { Activity, ArrowLeft, Bot, ChevronDown, Cpu, FlaskConical, LoaderCircle, Play, ShieldCheck, Timer } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from '@appcore/web/router'
import { API_BASE } from '../lib/apiBase'
import { SiteHeader } from './HubPage'

const PRODUCTS = [
  ['all', 'Whole application'],
  ['tara', 'Tara'],
  ['codelens', 'CodeLens'],
  ['safarnaama', 'Safarnaama'],
  ['jasoos', 'Jasoos'],
  ['platform', 'Platform'],
]
const NAME = Object.fromEntries(PRODUCTS)

async function api(path, body) {
  const res = await fetch(`${API_BASE}/api/evals${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  if (!res.ok) {
    const d = await res.json().catch(() => null)
    if (res.status === 404)
      throw new Error("This backend doesn't have the evals yet (it's an older deployment). To try them locally, run the backend and `npm run dev:local`.")
    throw new Error(res.status === 429 ? 'Runs are limited to a few per hour to protect the free model quota. Try again later.' : d?.detail ?? `Request failed (${res.status})`)
  }
  return res.json()
}

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const ago = (iso) => {
  if (!iso) return 'never'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
const tone = (v) => (v == null ? 'text-ink-400' : v >= 0.9 ? 'text-emerald-300' : v >= 0.7 ? 'text-amber-300' : 'text-rose-300')
const ring = (v) => (v == null ? '#3f4454' : v >= 0.9 ? '#34d399' : v >= 0.7 ? '#fbbf24' : '#fb7185')

export function QualityPage() {
  const [product, setProduct] = useState('all')
  const [suites, setSuites] = useState([])
  const [results, setResults] = useState({})
  const [busy, setBusy] = useState(null) // 'app' | 'model'
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    api('/latest')
      .then((d) => {
        if (!alive) return
        setSuites(d.suites)
        setResults(Object.fromEntries(d.results.map((r) => [r.suite, r])))
      })
      .catch((e) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [])

  const run = async (models) => {
    setBusy(models ? 'model' : 'app')
    setError(null)
    try {
      const d = await api('/run', { product, models })
      setResults((r) => ({ ...r, ...Object.fromEntries(d.results.map((x) => [x.suite, x])) }))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  const shown = useMemo(() => suites.filter((s) => product === 'all' || s.product === product), [suites, product])
  const summary = useMemo(() => {
    const of = (kind) => shown.filter((s) => s.kind === kind).map((s) => results[s.id]).filter((r) => r?.value != null)
    const avg = (rs) => (rs.length ? rs.reduce((a, r) => a + r.value, 0) / rs.length : null)
    const all = shown.map((s) => results[s.id]).filter(Boolean)
    const last = all.map((r) => r.ran_at).sort().at(-1)
    const lat = of('model').map((r) => r.extra?.p95_ms).filter(Boolean)
    return { app: avg(of('app')), model: avg(of('model')), cases: shown.reduce((n, s) => n + s.size, 0), last, p95: lat.length ? Math.max(...lat) : null }
  }, [shown, results])

  return (
    <div className="min-h-full">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-5 pt-26 pb-20 sm:pt-30">
        <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] text-ink-400 hover:text-white"><ArrowLeft className="size-4" /> Home</Link>
        <header className="mt-4">
          <p className="text-[12px] font-semibold tracking-[0.18em] text-cyan-300 uppercase">Quality</p>
          <h1 className="mt-2 text-[34px] leading-tight font-semibold text-white sm:text-[44px]">Measured, not claimed.</h1>
          <p className="mt-3 max-w-2xl text-[15px] text-ink-300">
            Evaluation suites for every product and the platform underneath. Every number comes from a stored run, with its date, how many cases it covered and what it got wrong. Run them yourself.
          </p>
        </header>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <div role="tablist" aria-label="Product" className="flex flex-wrap gap-1 rounded-2xl border border-white/[0.07] bg-ink-900/60 p-1">
            {PRODUCTS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={product === id} onClick={() => setProduct(id)}
                className={`rounded-xl px-3 py-1.5 text-[13px] font-medium transition ${product === id ? 'bg-white/[0.1] text-white' : 'text-ink-400 hover:text-white'}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <button type="button" disabled={!!busy} onClick={() => void run(false)} className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-white/[0.08] disabled:opacity-50">
              {busy === 'app' ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />} Run app checks
            </button>
            <button type="button" disabled={!!busy} onClick={() => void run(true)} className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-cyan-400 to-violet-500 px-4 py-2 text-[13.5px] font-semibold text-white shadow-lg disabled:opacity-50">
              {busy === 'model' ? <LoaderCircle className="size-4 animate-spin" /> : <Bot className="size-4" />} Run with live model
            </button>
          </div>
        </div>
        {busy === 'model' && <p className="mt-2 text-right text-[12px] text-ink-500">Calling the live model on every labelled case: about a minute.</p>}
        {error && <p className="mt-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] px-4 py-2 text-[13px] text-rose-200">{error}</p>}

        <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat icon={ShieldCheck} label="App checks passing" value={pct(summary.app)} tone={tone(summary.app)} hint="deterministic suites" />
          <Stat icon={Bot} label="Model eval score" value={pct(summary.model)} tone={tone(summary.model)} hint="live model, labelled sets" />
          <Stat icon={Timer} label="Slowest p95 in evals" value={summary.p95 ? `${(summary.p95 / 1000).toFixed(1)} s` : '—'} tone="text-white" hint="per request, measured in the run" />
          <Stat icon={Activity} label="Last run" value={ago(summary.last)} tone="text-white" hint={`${summary.cases} labelled cases in ${shown.length} suites`} />
        </section>

        <section className="mt-6 grid gap-4 md:grid-cols-2">
          {shown.map((s, i) => (
            <motion.div key={s.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
              <SuiteCard s={s} r={results[s.id]} />
            </motion.div>
          ))}
        </section>

        <section className="mt-10 grid gap-4 text-[13px] text-ink-400 md:grid-cols-3">
          <Note icon={FlaskConical} title="App checks">Run the real code paths (search, parsers, rules, action builders) on small labelled sets. Deterministic, free and safe to run any time.</Note>
          <Note icon={Cpu} title="Model evals">Call the live model through the same router the products use, on labelled sets, and record latency, fallbacks and errors from that run.</Note>
          <Note icon={ShieldCheck} title="Honest by design">Sets are small and say so: a starting point, not a benchmark. Results are stored with their date; nothing here is typed in by hand.</Note>
        </section>
      </main>
    </div>
  )
}

function Stat({ icon: Icon, label, value, tone: t, hint }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-ink-900/60 p-4">
      <p className="flex items-center gap-2 text-[12px] text-ink-400"><Icon className="size-3.5" /> {label}</p>
      <p className={`mt-1.5 text-[26px] font-semibold tabular-nums ${t}`}>{value}</p>
      <p className="text-[11.5px] text-ink-500">{hint}</p>
    </div>
  )
}

function Gauge({ v }) {
  const r = 26
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 64 64" className="size-16 shrink-0 -rotate-90" aria-hidden>
      <circle cx="32" cy="32" r={r} fill="none" stroke="rgb(255 255 255 / 0.07)" strokeWidth="6" />
      <motion.circle cx="32" cy="32" r={r} fill="none" stroke={ring(v)} strokeWidth="6" strokeLinecap="round" strokeDasharray={c}
        initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - (v ?? 0)) }} transition={{ duration: 0.9, ease: 'easeOut' }} />
    </svg>
  )
}

function SuiteCard({ s, r }) {
  const [open, setOpen] = useState(false)
  const extra = r?.extra ?? {}
  return (
    <article className="h-full rounded-3xl border border-white/[0.07] bg-ink-900/60 p-5">
      <div className="flex items-start gap-4">
        <div className="relative">
          <Gauge v={r?.value} />
          <span className={`absolute inset-0 grid place-items-center text-[13px] font-semibold tabular-nums ${tone(r?.value)}`}>{pct(r?.value)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-ink-300">{NAME[s.product]}</span>
            <span className={`rounded-full px-2 py-0.5 ${s.kind === 'model' ? 'bg-violet-400/15 text-violet-200' : 'bg-cyan-400/10 text-cyan-200'}`}>{s.kind === 'model' ? 'Model eval' : 'App check'}</span>
          </p>
          <h2 className="mt-1.5 text-[16px] font-semibold text-white">{s.title}</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-400">{s.description}</p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-3">
        <Item k="Metric" v={s.metric} />
        <Item k="Cases" v={r ? `${r.passed}/${r.total}` : `${s.size}`} />
        <Item k="Last run" v={r ? ago(r.ran_at) : 'not run yet'} />
        {extra.hit_at_1 != null && <Item k="Top hit (hit@1)" v={pct(extra.hit_at_1)} />}
        {extra.p50_ms != null && <Item k="Latency p50 / p95" v={`${extra.p50_ms} / ${extra.p95_ms} ms`} />}
        {extra.fallback_rate != null && <Item k="Fell back to rules" v={pct(extra.fallback_rate)} />}
        {r?.status === 'error' && <Item k="Status" v={`error (${r.error})`} />}
      </dl>
      {r?.failures?.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 text-[12.5px] text-ink-300 hover:text-white">
            <ChevronDown className={`size-3.5 transition ${open ? 'rotate-180' : ''}`} /> {r.failures.length} miss{r.failures.length === 1 ? '' : 'es'}
          </button>
          {open && (
            <ul className="mt-2 space-y-1.5">
              {r.failures.map((f, i) => (
                <li key={i} className="rounded-xl bg-white/[0.03] px-3 py-2 text-[12px]">
                  <p className="text-ink-200">“{f.input}”</p>
                  <p className="text-ink-500">expected <span className="text-emerald-300">{f.expected}</span> · got <span className="text-rose-300">{f.got}</span></p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  )
}

const Item = ({ k, v }) => (
  <div className="min-w-0">
    <dt className="text-ink-500">{k}</dt>
    <dd className="truncate text-ink-200">{v}</dd>
  </div>
)

function Note({ icon: Icon, title, children }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] p-4">
      <p className="flex items-center gap-2 font-semibold text-ink-200"><Icon className="size-4 text-cyan-300" /> {title}</p>
      <p className="mt-1">{children}</p>
    </div>
  )
}
