/**
 * Quality: how well each product works, measured. Every number comes from a stored run (date, dataset size and
 * misses included); runs can be started here for one product or the whole application.
 */
import { Activity, ArrowLeft, Bot, Check, ChevronDown, Cpu, FlaskConical, History, Lock, LoaderCircle, Play, ShieldCheck, Timer, X } from 'lucide-react'
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
    const err = new Error(res.status === 429 ? 'Runs are limited to a few per hour to protect the free model quota. Try again later.' : detailText(d?.detail) ?? `Request failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return res.json()
}

/** FastAPI sends validation errors as a list; show them as a sentence, not "[object Object]". */
const detailText = (detail) =>
  detail == null ? null : Array.isArray(detail) ? detail.map((x) => `${(x.loc ?? []).slice(1).join('.')}: ${x.msg}`).join('; ') : String(detail)

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
  const [step, setStep] = useState(null) // the model suite being measured right now
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

  const shown = useMemo(() => suites.filter((s) => product === 'all' || s.product === product), [suites, product])
  const keep = (d) => setResults((r) => ({ ...r, ...Object.fromEntries(d.results.map((x) => [x.suite, x])) }))
  // App checks in one go; model suites one request each (each stays well inside the server's time limit, and you
  // see every result as it lands instead of waiting minutes for all of them).
  const PASSES = 3
  const run = async (models) => {
    setBusy(models ? 'model' : 'app')
    setError(null)
    try {
      keep(await api('/run', { product, models: false }))
      if (models) {
        suites: for (const s of shown.filter((x) => x.kind === 'model')) {
          // A pass that the free tier cut short comes back "partial"; the next pass asks only the refused cases,
          // so one click usually ends with every case measured.
          for (let pass = 1; pass <= PASSES; pass++) {
            setStep({ title: s.title, pass })
            let d
            try {
              // "resume" only on later passes: a backend from before resumable runs still takes the first pass.
              d = await api('/run', { product, models: true, suite: s.id, ...(pass > 1 && { resume: true }) })
            } catch (e) {
              if (pass > 1 && e.status === 422) break // that older backend can't resume: keep the first pass
              if (e.status === 422 && /suite/.test(e.message)) {
                // A backend from before one-suite runs: it measures every model suite in one request.
                setStep({ title: 'every model suite', pass: 1 })
                keep(await api('/run', { product, models: true }))
                break suites
              }
              throw e
            }
            keep(d)
            if (d.results[0]?.status !== 'partial') break
          }
        }
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
      setStep(null)
    }
  }

  const summary = useMemo(() => {
    const of = (kind) => shown.filter((s) => s.kind === kind).map((s) => results[s.id]).filter((r) => r?.value != null)
    const avg = (rs) => (rs.length ? rs.reduce((a, r) => a + r.value, 0) / rs.length : null)
    const all = shown.map((s) => results[s.id]).filter(Boolean)
    const last = all.map((r) => r.ran_at).sort().at(-1)
    const lat = of('model').map((r) => r.extra?.p95_ms).filter(Boolean)
    const sec = results['platform.security']
    return { app: avg(of('app')), model: avg(of('model')), cases: shown.reduce((n, s) => n + s.size, 0), last, p95: lat.length ? Math.max(...lat) : null, security: sec?.value ?? null, securityOf: sec ? `${sec.passed}/${sec.total} controls` : 'run the app checks' }
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
        {step && (
          <p aria-live="polite" className="mt-3 text-[13px] text-ink-400">
            {step.pass === 1
              ? `Measuring “${step.title}” with the live model… (paced to stay inside the free-tier limits, so this can take a minute)`
              : `“${step.title}”: asking the cases the free tier refused again (pass ${step.pass} of ${PASSES})…`}
          </p>
        )}
        {error && <p className="mt-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] px-4 py-2 text-[13px] text-rose-200">{error}</p>}

        <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat icon={ShieldCheck} label="App checks passing" value={pct(summary.app)} tone={tone(summary.app)} hint="deterministic suites" />
          <Stat icon={Bot} label="Model eval score" value={pct(summary.model)} tone={tone(summary.model)} hint="live model, labelled sets" />
          <Stat icon={Timer} label="Slowest p95 in evals" value={summary.p95 ? `${(summary.p95 / 1000).toFixed(1)} s` : '—'} tone="text-white" hint="per request, measured in the run" />
          <Stat icon={Lock} label="Security controls" value={pct(summary.security)} tone={tone(summary.security)} hint={summary.securityOf} />
          <Stat icon={Activity} label="Last run" value={ago(summary.last)} tone="text-white" hint={`${summary.cases} labelled cases in ${shown.length} suites`} />
        </section>

        <section className="mt-6 grid gap-4 md:grid-cols-2">
          {shown.map((s, i) => (
            <motion.div key={s.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
              <SuiteCard s={s} r={results[s.id]} />
            </motion.div>
          ))}
        </section>

        <HistoryPanel suites={shown} />
        {results['platform.security'] && <SecurityPanel r={results['platform.security']} />}
        <Standards />

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
        <Item k="Cases" v={!r ? `${s.size}` : r.measured != null && r.measured < r.total ? `${r.passed}/${r.measured} measured (of ${r.total})` : `${r.passed}/${r.total}`} />
        {r?.status === 'partial' && <Item k="Not measured" v={`${r.total - r.measured} (free-tier limit reached; run again later)`} />}
        {r?.status === 'unmeasured' && <Item k="Status" v="Not measured: the model was unavailable (free-tier limit). Nothing was scored." />}
        <Item k="Last run" v={r ? ago(r.ran_at) : 'not run yet'} />
        {extra.ci95 && <Item k="95% interval" v={`${pct(extra.ci95[0])} – ${pct(extra.ci95[1])}`} />}
        {extra.macro_f1 != null && <Item k="Macro-F1" v={pct(extra.macro_f1)} />}
        {extra.hit_at_1 != null && <Item k="Top hit (hit@1)" v={pct(extra.hit_at_1)} />}
        {extra.mrr_at_10 != null && <Item k="MRR@10 · nDCG@3" v={`${extra.mrr_at_10.toFixed(2)} · ${extra.ndcg_at_3.toFixed(2)}`} />}
        {extra.p50_ms != null && <Item k="Latency p50 / p95" v={`${extra.p50_ms} / ${extra.p95_ms} ms`} />}
        {extra.coverage == null && extra.fallback_rate != null && <Item k="Fell back to rules" v={pct(extra.fallback_rate)} />}
        {r?.status === 'error' && <Item k="Status" v={`error (${r.error})`} />}
      </dl>
      {r?.trend && <Trend t={r.trend} />}
      {s.standards?.length > 0 && (
        <p className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
          {s.standards.map((x) => <span key={x} className="rounded-full border border-white/[0.08] px-2 py-0.5 text-ink-400">{x}</span>)}
        </p>
      )}
      {r && <RunHistory suite={s.id} />}
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

/** The last runs as a line (one series: the suite's score), with the change since the previous run. */
function Trend({ t }) {
  const v = t.values
  const W = 120
  const H = 28
  const x = (i) => (v.length < 2 ? W / 2 : (i / (v.length - 1)) * (W - 8) + 4)
  const y = (val) => H - 4 - val * (H - 8)
  const pts = v.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(' ')
  const d = t.delta
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-[12px]">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Score over the last ${v.length} runs: ${v.map((n) => Math.round(n * 100) + '%').join(', ')}`}>
        <line x1="0" x2={W} y1={y(1)} y2={y(1)} stroke="rgb(255 255 255 / 0.06)" strokeWidth="1" />
        {v.length > 1 && <polyline points={pts} fill="none" stroke="#67e8f9" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        <circle cx={x(v.length - 1)} cy={y(v.at(-1))} r="4" fill="#67e8f9" />
      </svg>
      <span className="text-ink-400">{t.runs} run{t.runs === 1 ? '' : 's'}</span>
      {d != null && (
        <span className={d > 0 ? 'text-emerald-300' : d < 0 ? 'text-rose-300' : 'text-ink-400'}>
          {d > 0 ? '▲' : d < 0 ? '▼' : '='} {Math.abs(Math.round(d * 100))} pts vs previous run
        </span>
      )}
      {t.regression && <span className="rounded-full bg-rose-400/15 px-2 py-0.5 font-semibold text-rose-200">Regression</span>}
    </div>
  )
}

/**
 * History for one suite at a time: its score run by run (a line, with the 95% interval as a band) and every run in
 * a table. Every run is stored, so improvements and regressions stay visible.
 */
function HistoryPanel({ suites }) {
  const [suite, setSuite] = useState(null)
  const [runs, setRuns] = useState(null)
  const id = suite ?? suites[0]?.id
  useEffect(() => {
    if (!id) return
    let live = true
    api(`/history?suite=${encodeURIComponent(id)}&limit=30`)
      .then((d) => live && setRuns({ id, rows: d.runs }))
      .catch(() => live && setRuns({ id, rows: [], failed: true }))
    return () => {
      live = false
    }
  }, [id])
  const rows = runs && id && runs.id === id ? runs.rows : null
  const pts = (rows ?? []).filter((r) => r.value != null).slice().reverse() // oldest → newest
  const W = 640
  const H = 160
  const x = (i) => (pts.length < 2 ? W / 2 : 36 + (i / (pts.length - 1)) * (W - 52))
  const y = (v) => 12 + (1 - v) * (H - 36)
  const line = pts.map((r, i) => `${x(i)},${y(r.value)}`).join(' ')
  const band = pts.length > 1 && pts.every((r) => r.ci95)
    ? `${pts.map((r, i) => `${x(i)},${y(r.ci95[1])}`).join(' ')} ${pts.map((r, i) => `${x(i)},${y(r.ci95[0])}`).reverse().join(' ')}`
    : null
  const title = suites.find((s) => s.id === id)?.title ?? id
  if (!id) return null // suites not loaded yet
  return (
    <section aria-labelledby="hist-title" className="mt-10 rounded-3xl border border-white/[0.07] bg-ink-900/60 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="hist-title" className="flex items-center gap-2 text-[16px] font-semibold text-white"><History className="size-4 text-cyan-300" /> History</h2>
        <label className="flex items-center gap-2 text-[12.5px] text-ink-400">
          Suite
          <select value={id ?? ''} onChange={(e) => setSuite(e.target.value)} className="rounded-xl border border-white/10 bg-ink-900 px-3 py-1.5 text-[13px] text-white">
            {suites.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </label>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-400">Every run is kept: the line is “{title}” run by run, the band its 95% interval. A drop of 5 points or more is flagged as a regression on the card.</p>
      {rows == null ? (
        <p className="mt-4 text-[13px] text-ink-500">Loading…</p>
      ) : runs.failed ? (
        <p className="mt-4 text-[13px] text-ink-500">This backend doesn't keep history yet (it's an older deployment).</p>
      ) : pts.length === 0 ? (
        <p className="mt-4 text-[13px] text-ink-500">No runs of this suite yet. Run the checks above and each run is added here.</p>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="mt-4 h-auto w-full" role="img" aria-label={`${title}: ${pts.map((r) => Math.round(r.value * 100) + '%').join(', ')}`}>
            {[0, 0.5, 1].map((v) => (
              <g key={v}>
                <line x1="36" x2={W - 16} y1={y(v)} y2={y(v)} stroke="rgb(255 255 255 / 0.07)" strokeWidth="1" />
                <text x="28" y={y(v) + 4} textAnchor="end" className="fill-ink-500 text-[10px]">{Math.round(v * 100)}%</text>
              </g>
            ))}
            {band && <polygon points={band} fill="#67e8f9" fillOpacity="0.1" />}
            {pts.length > 1 && <polyline points={line} fill="none" stroke="#67e8f9" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
            {pts.map((r, i) => <circle key={`${r.ran_at}-${i}`} cx={x(i)} cy={y(r.value)} r="4" fill="#67e8f9"><title>{`${new Date(r.ran_at).toLocaleString()}: ${pct(r.value)}`}</title></circle>)}
            <text x="36" y={H - 4} className="fill-ink-500 text-[10px]">{new Date(pts[0].ran_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</text>
            <text x={W - 16} y={H - 4} textAnchor="end" className="fill-ink-500 text-[10px]">{new Date(pts.at(-1).ran_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</text>
          </svg>
          <RunTable rows={rows} />
        </>
      )}
    </section>
  )
}

function RunTable({ rows }) {
  return (
    <div className="mt-3 max-h-64 overflow-auto rounded-xl border border-white/[0.06]">
      <table className="w-full text-left text-[12px]">
        <thead className="sticky top-0 bg-ink-900 text-ink-500">
          <tr><th className="px-3 py-1.5 font-medium">When</th><th className="px-3 py-1.5 font-medium">Score</th><th className="px-3 py-1.5 font-medium">95% interval</th><th className="px-3 py-1.5 font-medium">Cases</th></tr>
        </thead>
        <tbody>
          {rows.map((h, i) => (
            <tr key={`${h.ran_at}-${i}`} className="border-t border-white/[0.05] text-ink-200">
              <td className="px-3 py-1.5 whitespace-nowrap">{new Date(h.ran_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
              <td className="px-3 py-1.5 tabular-nums">{h.value == null ? 'not measured' : pct(h.value)}</td>
              <td className="px-3 py-1.5 tabular-nums text-ink-400">{h.ci95 ? `${pct(h.ci95[0])} – ${pct(h.ci95[1])}` : '—'}</td>
              <td className="px-3 py-1.5 tabular-nums text-ink-400">{h.measured != null && h.measured < h.total ? `${h.passed}/${h.measured} of ${h.total}` : `${h.passed}/${h.total}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Every stored run of a suite: when, the score, its interval and how much was measured. */
function RunHistory({ suite }) {
  const [rows, setRows] = useState(null)
  const [open, setOpen] = useState(false)
  const toggle = async () => {
    setOpen((o) => !o)
    if (!rows) {
      try {
        setRows((await api(`/history?suite=${encodeURIComponent(suite)}&limit=20`)).runs)
      } catch {
        setRows([])
      }
    }
  }
  return (
    <div className="mt-3">
      <button type="button" onClick={() => void toggle()} aria-expanded={open} className="inline-flex items-center gap-1 text-[12.5px] text-ink-300 hover:text-white">
        <History className="size-3.5" /> Run history
      </button>
      {open && (
        <div className="mt-2 max-h-56 overflow-auto rounded-xl border border-white/[0.06]">
          <table className="w-full text-left text-[12px]">
            <thead className="sticky top-0 bg-ink-900 text-ink-500">
              <tr><th className="px-3 py-1.5 font-medium">When</th><th className="px-3 py-1.5 font-medium">Score</th><th className="px-3 py-1.5 font-medium">95% interval</th><th className="px-3 py-1.5 font-medium">Cases</th></tr>
            </thead>
            <tbody>
              {rows == null && <tr><td className="px-3 py-2 text-ink-500" colSpan={4}>Loading…</td></tr>}
              {rows?.length === 0 && <tr><td className="px-3 py-2 text-ink-500" colSpan={4}>No history yet (only runs from now on are kept).</td></tr>}
              {rows?.map((h, i) => (
                <tr key={`${h.ran_at}-${i}`} className="border-t border-white/[0.05] text-ink-200">
                  <td className="px-3 py-1.5 whitespace-nowrap">{new Date(h.ran_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="px-3 py-1.5 tabular-nums">{h.value == null ? 'not measured' : pct(h.value)}</td>
                  <td className="px-3 py-1.5 tabular-nums text-ink-400">{h.ci95 ? `${pct(h.ci95[0])} – ${pct(h.ci95[1])}` : '—'}</td>
                  <td className="px-3 py-1.5 tabular-nums text-ink-400">{h.measured != null && h.measured < h.total ? `${h.passed}/${h.measured} of ${h.total}` : `${h.passed}/${h.total}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** The security KPIs: each control, whether it held in the last run, and the standard it answers to. */
function SecurityPanel({ r }) {
  const controls = r.extra?.controls ?? []
  return (
    <section aria-labelledby="sec-title" className="mt-10 rounded-3xl border border-white/[0.07] bg-ink-900/60 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="sec-title" className="flex items-center gap-2 text-[16px] font-semibold text-white"><Lock className="size-4 text-cyan-300" /> Security controls</h2>
        <p className="text-[12.5px] text-ink-400">{r.passed}/{r.total} holding · checked against the running app {ago(r.ran_at)}</p>
      </div>
      <ul className="mt-4 grid gap-2 md:grid-cols-2">
        {controls.map((c) => (
          <li key={c.id} className="flex gap-3 rounded-2xl border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5">
            <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full ${c.passed ? 'bg-emerald-400/15 text-emerald-300' : 'bg-rose-400/15 text-rose-300'}`}>
              {c.passed ? <Check className="size-3.5" aria-label="holds" /> : <X className="size-3.5" aria-label="failed" />}
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] text-ink-100">{c.name}</span>
              <span className="block text-[11.5px] text-ink-500">{c.standards}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** What each KPI means and which standard's vocabulary it follows (aligned with, not certified against). */
const KPIS = [
  ['Accuracy with a 95% interval', 'Share of labelled cases right; the Wilson interval says how sure a small set can be.', 'ISO/IEC 25010 functional correctness · NIST AI RMF (Measure): valid & reliable'],
  ['Macro-F1 and per-label precision / recall', 'Quality per class, so a rare intent or feeling that fails is not hidden by the common ones.', 'Standard classification metrics · NIST AI RMF: valid & reliable'],
  ['hit@k, MRR@10, nDCG@3', 'Whether search finds the right file, and how high it ranks it.', 'Information-retrieval standards (TREC-style ranking metrics)'],
  ['Latency p50 / p95', 'Typical and slow-end response time per model call, measured in the run.', 'ISO/IEC 25010 performance efficiency (time behaviour)'],
  ['Coverage and fallback rate', 'How much the live model answered vs. the offline rules (refused calls are not scored).', 'ISO/IEC 25010 reliability (availability, fault tolerance)'],
  ['Security controls passing', 'Each control exercised against the running app.', 'OWASP Top 10 for LLM apps (2025) · OWASP API Top 10 (2023) · ISO/IEC 25010 security'],
  ['History, change and regressions', 'Every run is kept; a drop of 5 points or more between two runs is flagged.', 'NIST AI RMF (Manage): monitoring over time · regression gating'],
]

function Standards() {
  return (
    <section aria-labelledby="std-title" className="mt-6 rounded-3xl border border-white/[0.07] bg-ink-900/60 p-5">
      <h2 id="std-title" className="text-[16px] font-semibold text-white">How it's measured</h2>
      <p className="mt-1 text-[12.5px] text-ink-400">The KPIs follow the categories enterprises use; the sets are small, so read them with their intervals.</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-[12.5px]">
          <thead className="text-ink-500">
            <tr><th className="py-1.5 pr-4 font-medium">KPI</th><th className="py-1.5 pr-4 font-medium">What it tells you</th><th className="py-1.5 font-medium">Standard it follows</th></tr>
          </thead>
          <tbody>
            {KPIS.map(([k, what, std]) => (
              <tr key={k} className="border-t border-white/[0.05] align-top">
                <td className="py-2 pr-4 font-medium text-ink-100">{k}</td>
                <td className="py-2 pr-4 text-ink-300">{what}</td>
                <td className="py-2 text-ink-400">{std}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
