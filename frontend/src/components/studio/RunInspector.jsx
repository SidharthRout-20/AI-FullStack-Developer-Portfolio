import {
  ArrowRight,
  BookOpenCheck,
  ChevronDown,
  Clock,
  Gauge,
  Globe,
  Layers,
  ShieldCheck,
  ShieldX,
  Timer,
  Zap,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { useCountUp } from '../../hooks/useCountUp'
import { asRecord, formatMs } from '../../lib/format'
import { NODE_COLOR } from './nodeMeta'

export function runOutcome(run) {
  if (!run.path.length) return 'idle'
  if (run.running) return 'running'
  if (Object.values(run.nodes).some((n) => n.status === 'error')) return 'error'
  if (run.path.includes('refuse')) return 'blocked'
  if (run.path.includes('general')) return 'general'
  if (run.path.includes('generate')) return 'grounded'
  return 'error'
}

export function RunInspector({ run, topology, health }) {
  const [tab, setTab] = useState('overview')

  if (!run.path.length) return <InspectorEmpty />

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-white/[0.06] px-3 pt-2">
        {(
          [
            ['overview', 'Overview'],
            ['retrieval', 'Retrieval'],
            ['query', 'Query & model'],
          ]).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`relative px-3 py-2 text-xs font-medium transition-colors ${
              tab === id ? 'text-white' : 'text-ink-400 hover:text-ink-200'
            }`}
          >
            {label}
            {tab === id && (
              <motion.span
                layoutId="inspector-tab"
                className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-gradient-to-r from-indigo-400 to-cyan-400"
              />
            )}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
          >
            {tab === 'overview' && <Overview run={run} topology={topology} />}
            {tab === 'retrieval' && <Retrieval run={run} />}
            {tab === 'query' && <QueryTab run={run} health={health} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

// ── Overview ──────────────────────────────────────────────────────────────
function Overview({ run, topology }) {
  const grade = run.nodes.grade?.detail
  const retrieve = run.nodes.retrieve
  const total = run.totalMs ?? undefined

  return (
    <div className="grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @4xl:items-start">
      <div className="space-y-4">
      <Decision run={run} />
      <div className="grid grid-cols-2 gap-2.5 @2xl:grid-cols-4 @4xl:grid-cols-2">
        <Kpi icon={Clock} label="End-to-end" value={total} format={formatMs} hint={run.running ? 'running' : undefined} />
        <Kpi icon={Zap} label="First token" value={run.firstTokenAt} format={formatMs} hint="perceived latency" />
        <Kpi icon={Layers} label="Retrieval" value={retrieve?.ms} format={formatMs} hint="embed + vector + BM25" />
        <Kpi
          icon={BookOpenCheck}
          label="Evidence used"
          value={grade?.kept}
          format={(v) => `${Math.round(v)} / ${(grade?.kept ?? 0) + (grade?.dropped ?? 0)}`}
          hint="chunks passed to the LLM"
        />
      </div>
      </div>
      <Waterfall run={run} topology={topology} />
    </div>
  )
}

const OUTCOME = {
  grounded: { icon: BookOpenCheck, title: 'Grounded answer', tone: 'from-emerald-500/15 ring-emerald-400/25 text-emerald-200' },
  general: { icon: Globe, title: 'General-knowledge answer', tone: 'from-amber-500/15 ring-amber-400/25 text-amber-200' },
  blocked: { icon: ShieldX, title: 'Blocked by guardrails', tone: 'from-rose-500/15 ring-rose-400/25 text-rose-200' },
  running: { icon: Gauge, title: 'Pipeline running…', tone: 'from-indigo-500/15 ring-indigo-400/25 text-indigo-200' },
  error: { icon: ShieldX, title: 'Run failed', tone: 'from-rose-500/15 ring-rose-400/25 text-rose-200' },
  idle: { icon: Gauge, title: 'Idle', tone: 'from-white/5 ring-white/10 text-ink-200' },
}

function Decision({ run }) {
  const outcome = runOutcome(run)
  const { icon: Icon, title, tone } = OUTCOME[outcome]
  const g = run.nodes.grade?.detail
  const guard = asRecord(run.nodes.guard?.detail)

  let why = 'Each step reports what it did as it runs.'
  if (outcome === 'grounded' && g)
    why = (
      <>
        Best match scored <b>{g.best?.toFixed(2)}</b> (threshold {g.threshold?.toFixed(2)}), so the{' '}
        <b>{g.kept}</b> chunk{g.kept === 1 ? '' : 's'} within {g.margin} of it became cited evidence.
      </>
    )
  else if (outcome === 'general' && g)
    why = (
      <>
        Best match scored only <b>{g.best?.toFixed(2)}</b>, below the {g.threshold?.toFixed(2)} relevance threshold. The
        documents don't cover this, so the model answered from general knowledge and pointed back to them.
      </>
    )
  else if (outcome === 'blocked')
    why = (
      <>
        Guardrails flagged <b>{String(guard.reason ?? 'unsafe input')}</b>. No retrieval or LLM call was made: zero tokens
        spent.
      </>
    )
  else if (outcome === 'error') why = 'A step failed. See the chat message for a safe, user-facing explanation.'

  return (
    <div className={`rounded-xl bg-gradient-to-br to-transparent p-3.5 ring-1 ${tone}`}>
      <div className="flex items-center gap-2">
        <Icon className="size-4" />
        <span className="text-[13px] font-semibold">{title}</span>
        {g?.confidence && outcome === 'grounded' && <ConfidenceMeter level={g.confidence} />}
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-200 [&_b]:font-semibold [&_b]:text-white">{why}</p>
    </div>
  )
}

function ConfidenceMeter({ level }) {
  const n = { low: 1, medium: 2, high: 3 }[level]
  return (
    <span className="ml-auto flex items-center gap-1.5 text-[10.5px] font-medium tracking-wide uppercase">
      {level} confidence
      <span className="flex gap-0.5">
        {[1, 2, 3].map((i) => (
          <span key={i} className={`h-2.5 w-1 rounded-full ${i <= n ? 'bg-emerald-300' : 'bg-white/15'}`} />
        ))}
      </span>
    </span>
  )
}

function Kpi({
  icon: Icon,
  label,
  value,
  format,
  hint,
}) {
  const animated = useCountUp(value)
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium tracking-wide text-ink-400 uppercase">
        <Icon className="size-3" /> {label}
      </div>
      <div className="mt-1 font-mono text-lg font-semibold text-white tabular-nums">
        {animated === null ? '—' : format(animated)}
      </div>
      {hint && <div className="text-[10.5px] text-ink-500">{hint}</div>}
    </div>
  )
}

/** Elapsed ms since `t0`, ticking while `active` (drives the live waterfall). */
function useElapsed(t0, active) {
  const [elapsed, setElapsed] = useState()
  useEffect(() => {
    if (!active || t0 === undefined) return
    const id = setInterval(() => setElapsed(performance.now() - t0), 100)
    return () => clearInterval(id)
  }, [t0, active])
  return active ? elapsed : undefined
}

/** Gantt-style latency breakdown: where did the time go? */
function Waterfall({ run, topology }) {
  const labels = new Map(topology.nodes.map((n) => [n.id, n.label]))
  const steps = run.path.filter((id) => id !== '__start__' && id !== '__end__')
  const elapsed = useElapsed(run.t0, run.running)
  const total = Math.max(
    run.totalMs ?? elapsed ?? 0,
    ...steps.map((id) => run.nodes[id]?.endedAt ?? run.nodes[id]?.startedAt ?? 0),
    1,
  )
  const ttft = run.firstTokenAt

  return (
    <section>
      <h4 className="mb-2 flex items-center gap-1.5 text-[10.5px] font-semibold tracking-wider text-ink-400 uppercase">
        <Timer className="size-3" /> Latency waterfall
      </h4>
      <div className="relative space-y-1.5">
        {ttft !== undefined && (
          <div
            className="pointer-events-none absolute inset-y-0 z-10 border-l border-dashed border-cyan-300/70"
            style={{ left: `calc(7.5rem + (100% - 7.5rem - 3.5rem) * ${ttft / total})` }}
            title={`First token at ${formatMs(ttft)}`}
          />
        )}
        {steps.map((id, i) => {
          const r = run.nodes[id]
          const start = r?.startedAt ?? 0
          const end = r?.endedAt ?? (run.running ? total : start)
          const color = NODE_COLOR[id] ?? '#94a3b8'
          return (
            <div key={id} className="flex items-center gap-2 text-[11px]">
              <span className="w-[7rem] shrink-0 truncate text-ink-300">{labels.get(id) ?? id}</span>
              <div className="relative h-4 flex-1 rounded bg-white/[0.03]">
                <motion.div
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ delay: i * 0.05, duration: 0.4, ease: 'easeOut' }}
                  className={`absolute inset-y-0 origin-left rounded ${r?.status === 'active' ? 'animate-pulse' : ''}`}
                  style={{
                    left: `${(start / total) * 100}%`,
                    width: `max(3px, ${((end - start) / total) * 100}%)`,
                    background: `linear-gradient(90deg, ${color}cc, ${color}66)`,
                    boxShadow: `0 0 12px ${color}44`,
                  }}
                />
              </div>
              <span className="w-[3rem] shrink-0 text-right font-mono text-ink-300 tabular-nums">
                {r?.status === 'error' ? 'failed' : formatMs(r?.ms)}
              </span>
            </div>
          )
        })}
      </div>
      {ttft !== undefined && (
        <p className="mt-2 flex items-center gap-1.5 text-[10.5px] text-ink-400">
          <span className="inline-block h-3 border-l border-dashed border-cyan-300" /> first token reached the browser at{' '}
          <span className="font-mono text-cyan-200">{formatMs(ttft)}</span>
        </p>
      )}
    </section>
  )
}

// ── Retrieval ─────────────────────────────────────────────────────────────
const SIM_MIN = 0.2
const SIM_MAX = 0.8
const simPos = (v) => `${Math.max(0, Math.min(1, (v - SIM_MIN) / (SIM_MAX - SIM_MIN))) * 100}%`

function Retrieval({ run }) {
  const detail = asRecord(run.nodes.retrieve?.detail)
  const candidates = detail.candidates ?? []
  const g = run.nodes.grade?.detail
  const kept = new Set(g?.kept_ranks ?? [])
  const [open, setOpen] = useState(null)

  if (!candidates.length)
    return (
      <Placeholder>
        {run.path.includes('refuse')
          ? 'Retrieval was skipped: guardrails stopped this request first.'
          : 'Retrieval results will appear here once the step completes.'}
      </Placeholder>
    )

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-[12px] text-ink-300">
        <span className="text-ink-400">Searched for</span>{' '}
        <span className="font-medium text-white">“{String(detail.query ?? run.question)}”</span>
        <p className="mt-1 text-[11px] text-ink-400">
          Dense vectors (bge-small) and BM25 each rank candidates; Reciprocal Rank Fusion merges the two lists. The
          grader then keeps chunks above the cutoff.
        </p>
      </div>

      {g && (
        <div className="flex flex-wrap items-center gap-3 text-[10.5px] text-ink-400">
          <Legend className="bg-amber-300" label={`threshold ${g.threshold?.toFixed(2)} (best must reach)`} />
          {g.decision === 'grounded' && <Legend className="bg-emerald-300" label={`cutoff ${g.cutoff?.toFixed(2)} (keep ≥)`} />}
        </div>
      )}

      <ol className="grid gap-1.5 @3xl:grid-cols-2">
        {candidates.map((c, i) => {
          const isKept = kept.has(c.rank)
          return (
            <motion.li
              key={c.rank}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.04 }}
              className={`rounded-xl border p-2.5 transition-colors ${
                isKept ? 'border-emerald-400/25 bg-emerald-500/[0.04]' : 'border-white/[0.06] bg-white/[0.015]'
              }`}
            >
              <button type="button" onClick={() => setOpen(open === c.rank ? null : c.rank)} className="w-full text-left">
                <div className="flex items-center gap-2 text-[11.5px]">
                  <span className="grid size-5 shrink-0 place-items-center rounded-md bg-white/[0.06] font-mono text-[10px] text-ink-200">
                    {c.rank}
                  </span>
                  <span className="min-w-0 truncate font-medium text-ink-100">
                    {c.source} <span className="text-ink-400">p.{c.page}</span>
                  </span>
                  <span
                    className={`ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${
                      isKept ? 'bg-emerald-400/15 text-emerald-200' : 'bg-white/[0.05] text-ink-400'
                    }`}
                  >
                    {isKept ? 'kept' : 'dropped'}
                  </span>
                  <ChevronDown className={`size-3.5 shrink-0 text-ink-500 transition ${open === c.rank ? 'rotate-180' : ''}`} />
                </div>

                {/* Similarity bar with threshold & cutoff markers */}
                <div className="relative mt-2 h-2 rounded-full bg-white/[0.05]">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: simPos(c.similarity) }}
                    transition={{ duration: 0.6, delay: i * 0.04 }}
                    className={`absolute inset-y-0 left-0 rounded-full ${
                      isKept ? 'bg-gradient-to-r from-emerald-500/70 to-emerald-300' : 'bg-gradient-to-r from-ink-600 to-ink-400'
                    }`}
                  />
                  {g && <Marker left={simPos(g.threshold ?? 0)} className="bg-amber-300" />}
                  {g?.decision === 'grounded' && <Marker left={simPos(g.cutoff ?? 0)} className="bg-emerald-300" />}
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-ink-400">
                  <span>
                    sim <span className="text-ink-100">{c.similarity.toFixed(3)}</span>
                  </span>
                  <Rank label="vector" value={c.dense_rank} />
                  <Rank label="bm25" value={c.sparse_rank} />
                  <span>
                    rrf <span className="text-ink-100">{c.rrf.toFixed(4)}</span>
                  </span>
                </div>
              </button>
              <AnimatePresence>
                {open === c.rank && (
                  <motion.p
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden text-[11.5px] leading-snug text-ink-300"
                  >
                    <span className="mt-2 block border-t border-white/[0.06] pt-2">{c.preview}…</span>
                  </motion.p>
                )}
              </AnimatePresence>
            </motion.li>
          )
        })}
      </ol>
    </div>
  )
}

const Marker = ({ left, className }) => (
  <span className={`absolute -top-1 h-4 w-0.5 rounded-full ${className}`} style={{ left }} />
)
const Legend = ({ className, label }) => (
  <span className="flex items-center gap-1.5">
    <span className={`h-3 w-0.5 rounded-full ${className}`} />
    {label}
  </span>
)
const Rank = ({ label, value }) => (
  <span>
    {label} <span className={value ? 'text-cyan-200' : 'text-ink-500'}>{value ? `#${value}` : '—'}</span>
  </span>
)

// ── Query & model ─────────────────────────────────────────────────────────
function QueryTab({ run, health }) {
  const guard = asRecord(run.nodes.guard?.detail)
  const rw = asRecord(run.nodes.rewrite?.detail)
  const gen = (run.nodes.generate?.detail ?? run.nodes.general?.detail)

  return (
    <div className="grid gap-3 @3xl:grid-cols-2">
      <Row icon={guard.allowed === false ? ShieldX : ShieldCheck} title="Guardrails">
        {guard.allowed === false ? (
          <span className="text-rose-200">Blocked: {String(guard.reason)}</span>
        ) : guard.allowed ? (
          'Passed: Unicode-normalised, no injection patterns detected.'
        ) : (
          '—'
        )}
      </Row>

      <Row icon={ArrowRight} title="Query understanding">
        <div className="space-y-1.5">
          <div>
            <span className="text-ink-400">Asked:</span> <span className="text-white">“{run.question}”</span>
          </div>
          {rw.rewritten ? (
            <div>
              <span className="text-ink-400">Searched:</span> <span className="text-cyan-200">“{String(rw.query)}”</span>
              <p className="text-[11px] text-ink-400">Follow-up rewritten into a standalone query using chat history.</p>
            </div>
          ) : rw.degraded ? (
            <p className="text-amber-200">LLM unavailable: searched with the original wording.</p>
          ) : run.nodes.rewrite ? (
            <p className="text-[11px] text-ink-400">First turn, so the question was searched as-is (no LLM call).</p>
          ) : null}
        </div>
      </Row>

      <Row icon={Zap} title="Generation">
        {gen && !gen.degraded ? (
          <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
            <Stat label="words" value={gen.words ?? '—'} />
            <Stat label="server TTFT" value={formatMs(gen.ttft_ms)} />
            <Stat label="chars / s" value={gen.chars_per_s ?? '—'} />
          </div>
        ) : gen?.degraded ? (
          'LLM unavailable: a static reply was returned instead of an error.'
        ) : (
          'No LLM call for this run.'
        )}
      </Row>

      {health && (
        <Row icon={Gauge} title="Model">
          <span className="font-mono text-[11.5px] text-ink-100">{health.llm_model}</span>{' '}
          <span className="text-ink-400">via {health.llm_provider}</span>
        </Row>
      )}
    </div>
  )
}

function Row({ icon: Icon, title, children }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold tracking-wider text-ink-400 uppercase">
        <Icon className="size-3" /> {title}
      </div>
      <div className="text-[12.5px] leading-relaxed text-ink-200">{children}</div>
    </div>
  )
}

const Stat = ({ label, value }) => (
  <div className="rounded-lg bg-white/[0.03] px-2 py-1.5">
    <div className="text-[13px] text-white">{value}</div>
    <div className="text-[10px] text-ink-500">{label}</div>
  </div>
)

const Placeholder = ({ children }) => (
  <p className="rounded-xl border border-dashed border-white/10 p-6 text-center text-[12.5px] text-ink-400">{children}</p>
)

function InspectorEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="grid w-full max-w-xs gap-2 opacity-60">
        {[0.9, 0.7, 0.8].map((w, i) => (
          <div key={i} className="h-2.5 animate-pulse rounded-full bg-white/[0.06]" style={{ width: `${w * 100}%` }} />
        ))}
      </div>
      <p className="max-w-xs text-[12.5px] text-ink-400">
        Ask a question to see <span className="text-ink-200">why</span> DocuMind answered the way it did: the routing
        decision, which passages won retrieval, and where every millisecond went.
      </p>
    </div>
  )
}
