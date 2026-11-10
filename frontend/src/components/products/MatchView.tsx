import {
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  CircleMinus,
  ClipboardCheck,
  Copy,
  FileSearch,
  LoaderCircle,
  Scale,
  Search,
  Sparkles,
  TriangleExclamationPoint,
  XCircle,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useRef, useState } from 'react'
import { useCountUp } from '../../hooks/useCountUp'
import { streamMatch } from '../../lib/api'
import { formatMs } from '../../lib/format'
import type { MatchEvent, MatchRequirement, MatchResult, MatchStage, MatchStatus } from '../../types'

const SAMPLE = `Senior AI Full Stack Developer

We're hiring a senior engineer to build LLM-powered products end to end.

Requirements:
- 5+ years of professional software development experience
- Strong React and modern JavaScript/TypeScript skills
- Backend development with Python (Flask or FastAPI)
- Experience building RAG pipelines or LLM applications
- REST API design and integration
- Git-based workflows and CI/CD
- Docker and cloud deployment

Nice to have:
- LangGraph or agent frameworks
- Kubernetes
- UI/UX design skills (Figma)`

const STAGES: { id: MatchStage; label: string; icon: typeof Search }[] = [
  { id: 'extract', label: 'Extract requirements', icon: FileSearch },
  { id: 'retrieve', label: 'Retrieve evidence', icon: Search },
  { id: 'assess', label: 'Assess each requirement', icon: Scale },
  { id: 'score', label: 'Score & report', icon: ClipboardCheck },
]

const STATUS: Record<MatchStatus, { label: string; icon: typeof Check; className: string; bar: string }> = {
  met: { label: 'Met', icon: CheckCircle2, className: 'text-emerald-300 bg-emerald-500/10 ring-emerald-400/25', bar: '#34d399' },
  partial: { label: 'Partial', icon: CircleMinus, className: 'text-amber-300 bg-amber-500/10 ring-amber-400/25', bar: '#fbbf24' },
  missing: { label: 'Missing', icon: XCircle, className: 'text-rose-300 bg-rose-500/10 ring-rose-400/25', bar: '#fb7185' },
}

type StageState = Partial<Record<MatchStage, { status: 'active' | 'done'; ms?: number; note?: string }>>

/** Requirements Match Analyzer: score a JD / RFP / checklist against the knowledge base, with evidence. */
export function MatchView() {
  const [text, setText] = useState('')
  const [running, setRunning] = useState(false)
  const [stages, setStages] = useState<StageState>({})
  const [result, setResult] = useState<MatchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<MatchStatus | 'all'>('all')
  const abortRef = useRef<AbortController | null>(null)

  const onEvent = (ev: MatchEvent) => {
    if (ev.event === 'stage') {
      const note =
        ev.stage === 'extract' && ev.count !== undefined ? `${ev.count} requirements${ev.title ? ` · ${ev.title}` : ''}` : undefined
      setStages((s) => ({ ...s, [ev.stage]: { status: ev.status === 'start' ? 'active' : 'done', ms: ev.ms, note } }))
    } else if (ev.event === 'result') {
      const { event: _event, ...r } = ev
      void _event
      setResult(r)
    } else {
      setError(ev.message)
    }
  }

  const analyze = async () => {
    if (running || text.trim().length < 40) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setRunning(true)
    setStages({})
    setResult(null)
    setError(null)
    setFilter('all')
    try {
      await streamMatch(text, ctrl.signal, onEvent)
    } catch (err) {
      if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      if (ctrl.signal.aborted) {
        setStages({})
        setError('Analysis cancelled.')
      }
      setRunning(false)
    }
  }

  return (
    <div className="grid h-full min-h-0 lg:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
      {/* Input */}
      <section className="flex min-h-0 flex-col border-white/[0.06] p-4 sm:p-5 lg:border-r">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white">
          <Scale className="size-4 text-amber-300" /> Match Analyzer
        </h2>
        <p className="mt-0.5 text-[11.5px] text-ink-400">
          Paste a job description, RFP or checklist. Each requirement is checked against your documents with cited
          evidence.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={8000}
          placeholder="Paste requirements here…"
          aria-label="Requirements text"
          className="mt-4 min-h-48 flex-1 resize-none rounded-xl border border-white/[0.08] bg-ink-900/80 p-3 font-mono text-[12.5px] leading-relaxed text-ink-100 placeholder:text-ink-500 focus:border-brand-400/50 focus:outline-none"
        />
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setText(SAMPLE)}
            className="rounded-lg border border-white/[0.08] px-3 py-2 text-[12px] text-ink-200 transition hover:border-white/20"
          >
            Load sample JD
          </button>
          <span className="ml-auto font-mono text-[10.5px] text-ink-500">{text.length}/8000</span>
          {running && (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="rounded-lg border border-white/[0.08] px-3 py-2 text-[12px] text-ink-200 transition hover:border-rose-400/40 hover:text-rose-200"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={analyze}
            disabled={running || text.trim().length < 40}
            className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-amber-500 to-rose-500 px-4 py-2 text-[12.5px] font-semibold text-on-accent shadow-lg shadow-rose-950/40 transition hover:brightness-110 disabled:opacity-40"
          >
            {running ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {running ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>
      </section>

      {/* Output */}
      <section className="min-h-0 overflow-y-auto p-4 sm:p-6">
        {!running && !result && !error && Object.keys(stages).length === 0 ? (
          <EmptyMatch />
        ) : (
          <div className="mx-auto max-w-4xl space-y-5">
            <Stepper stages={stages} running={running} />
            {error && (
              <p className="flex items-start gap-2 rounded-xl bg-rose-500/10 p-3 text-sm text-rose-200 ring-1 ring-rose-500/25">
                <TriangleExclamationPoint className="mt-0.5 size-4 shrink-0" /> {error}
              </p>
            )}
            {result && <Report result={result} filter={filter} onFilter={setFilter} />}
          </div>
        )}
      </section>
    </div>
  )
}

function Stepper({ stages, running }: { stages: StageState; running: boolean }) {
  return (
    <ol className="grid gap-2 sm:grid-cols-4">
      {STAGES.map(({ id, label, icon: Icon }, i) => {
        const s = stages[id]
        const status = s?.status ?? (running ? 'pending' : 'pending')
        return (
          <motion.li
            key={id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            className={`relative overflow-hidden rounded-xl border p-3 transition-colors ${
              status === 'done'
                ? 'border-emerald-400/30 bg-emerald-500/[0.06]'
                : status === 'active'
                  ? 'border-brand-400/50 bg-brand-500/10'
                  : 'border-white/[0.06] bg-white/[0.02]'
            }`}
          >
            {status === 'active' && (
              <span className="absolute inset-x-0 bottom-0 h-0.5 animate-shimmer bg-[linear-gradient(90deg,transparent,#818cf8,transparent)] bg-[length:200%_100%]" />
            )}
            <div className="flex items-center gap-2">
              {status === 'done' ? (
                <Check className="size-4 text-emerald-300" />
              ) : status === 'active' ? (
                <LoaderCircle className="size-4 animate-spin text-indigo-300" />
              ) : (
                <CircleDashed className="size-4 text-ink-500" />
              )}
              <Icon className="size-3.5 text-ink-400" />
              <span className="text-[12px] font-medium text-ink-100">{label}</span>
            </div>
            <p className="mt-1 truncate font-mono text-[10.5px] text-ink-400">
              {s?.note ?? (status === 'done' && s?.ms !== undefined ? formatMs(s.ms) : status === 'active' ? 'running…' : 'waiting')}
            </p>
          </motion.li>
        )
      })}
    </ol>
  )
}

function ScoreRing({ score }: { score: number }) {
  const value = useCountUp(score, 1100) ?? 0
  const r = 52
  const c = 2 * Math.PI * r
  const color = score >= 75 ? '#34d399' : score >= 50 ? '#fbbf24' : '#fb7185'
  return (
    <div className="relative grid size-36 shrink-0 place-items-center">
      <svg viewBox="0 0 120 120" className="absolute inset-0 -rotate-90">
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgb(255 255 255 / 0.06)" strokeWidth="10" />
        <motion.circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - score / 100) }}
          transition={{ duration: 1.1, ease: 'easeOut' }}
          style={{ filter: `drop-shadow(0 0 8px ${color}88)` }}
        />
      </svg>
      <div className="text-center">
        <div className="font-mono text-3xl font-semibold text-white tabular-nums">{Math.round(value)}</div>
        <div className="text-[10px] tracking-wider text-ink-400 uppercase">match score</div>
      </div>
    </div>
  )
}

function toMarkdown(r: MatchResult): string {
  const lines = [`# ${r.title || 'Match report'}: ${r.score}/100`, '', r.verdict, '']
  for (const q of r.requirements) {
    lines.push(`- **${STATUS[q.status].label}** (${q.priority}) ${q.text}: ${q.rationale}`)
    for (const e of q.evidence) lines.push(`  - ${e.source} p.${e.page}: "${e.snippet.slice(0, 140)}…"`)
  }
  return lines.join('\n')
}

function Report({
  result,
  filter,
  onFilter,
}: {
  result: MatchResult
  filter: MatchStatus | 'all'
  onFilter: (f: MatchStatus | 'all') => void
}) {
  const [copied, setCopied] = useState(false)
  const items = filter === 'all' ? result.requirements : result.requirements.filter((r) => r.status === filter)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toMarkdown(result))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="glass flex flex-col items-center gap-5 rounded-2xl p-5 sm:flex-row">
        <ScoreRing score={result.score} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-white">{result.title || 'Match report'}</h2>
            <span className="font-mono text-[10.5px] text-ink-400">{formatMs(result.total_ms)}</span>
            <button
              type="button"
              onClick={copy}
              className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-ink-300 hover:bg-white/5 hover:text-white"
            >
              {copied ? <Check className="size-3.5 text-emerald-300" /> : <Copy className="size-3.5" />} Copy report
            </button>
          </div>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-200">{result.verdict}</p>
          {/* Stacked composition bar */}
          <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-white/5">
            {(['met', 'partial', 'missing'] as const).map((s) => (
              <motion.div
                key={s}
                initial={{ width: 0 }}
                animate={{ width: `${(result.counts[s] / Math.max(1, result.requirements.length)) * 100}%` }}
                transition={{ duration: 0.8, delay: 0.2 }}
                style={{ background: STATUS[s].bar }}
              />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(['all', 'met', 'partial', 'missing'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => onFilter(f)}
                aria-pressed={filter === f}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium ring-1 transition ${
                  filter === f ? 'bg-white/10 text-white ring-white/20' : 'text-ink-300 ring-white/[0.06] hover:text-white'
                }`}
              >
                {f === 'all' ? `All ${result.requirements.length}` : `${STATUS[f].label} ${result.counts[f]}`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {items.map((r, i) => (
            <RequirementRow key={r.id} req={r} index={i} />
          ))}
        </AnimatePresence>
      </ul>
    </motion.div>
  )
}

function RequirementRow({ req, index }: { req: MatchRequirement; index: number }) {
  const [open, setOpen] = useState(false)
  const s = STATUS[req.status]
  const Icon = s.icon
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ delay: index * 0.03 }}
      className="rounded-xl border border-white/[0.06] bg-white/[0.02]"
    >
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-3 p-3 text-left">
        <span className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg ring-1 ${s.className}`}>
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-medium text-ink-100">{req.text}</span>
            <span
              className={`rounded px-1.5 py-px text-[9.5px] font-semibold tracking-wider uppercase ${
                req.priority === 'must' ? 'bg-indigo-500/15 text-indigo-200' : 'bg-white/5 text-ink-400'
              }`}
            >
              {req.priority === 'must' ? 'Required' : 'Nice to have'}
            </span>
          </span>
          <span className="mt-0.5 block text-[12.5px] text-ink-300">{req.rationale}</span>
        </span>
        {req.evidence.length > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-400">
            {req.evidence.length} evidence
            <ChevronDown className={`size-3.5 transition ${open ? 'rotate-180' : ''}`} />
          </span>
        )}
      </button>
      <AnimatePresence>
        {open && req.evidence.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-2 border-t border-white/[0.06] p-3 pl-13">
              {req.evidence.map((e, k) => (
                <blockquote key={k} className="rounded-lg border-l-2 border-cyan-400/50 bg-ink-900/60 px-3 py-2">
                  <p className="font-mono text-[10.5px] text-ink-400">
                    {e.source} · p.{e.page} · sim {e.similarity.toFixed(2)}
                  </p>
                  <p className="mt-1 line-clamp-4 text-[12px] leading-snug text-ink-200">{e.snippet}</p>
                </blockquote>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  )
}

function EmptyMatch() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <motion.div
        initial={{ scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', bounce: 0.4 }}
        className="grid size-16 animate-float place-items-center rounded-2xl bg-gradient-to-br from-amber-500 to-rose-500 shadow-2xl shadow-rose-950/50"
      >
        <Scale className="size-8 text-white" />
      </motion.div>
      <h2 className="mt-5 text-xl font-semibold text-white">How well do the documents match?</h2>
      <p className="mt-2 max-w-md text-[13.5px] text-ink-300">
        A 4-stage agentic pipeline extracts requirements, retrieves evidence for each with hybrid search, judges them,
        and scores the fit, with every verdict backed by quotes from your documents.
      </p>
    </div>
  )
}
