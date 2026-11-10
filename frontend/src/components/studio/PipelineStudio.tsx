import { ChevronLeft, ChevronRight, Workflow } from 'lucide-react'
import { useElementSize } from '../../hooks/useElementSize'
import { formatMs } from '../../lib/format'
import type { ChatMessage, GraphTopology, Health, WorkflowRun } from '../../types'
import { RunInspector, runOutcome, type RunOutcome } from './RunInspector'
import { WorkflowGraph } from './WorkflowGraph'

const PILL: Record<RunOutcome, { label: string; className: string }> = {
  running: { label: 'Running', className: 'bg-indigo-500/15 text-indigo-200 ring-indigo-400/30' },
  grounded: { label: 'Grounded', className: 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/30' },
  general: { label: 'General', className: 'bg-amber-500/15 text-amber-200 ring-amber-400/30' },
  blocked: { label: 'Blocked', className: 'bg-rose-500/15 text-rose-200 ring-rose-400/30' },
  error: { label: 'Failed', className: 'bg-rose-500/15 text-rose-200 ring-rose-400/30' },
  idle: { label: 'Ready', className: 'bg-white/5 text-ink-300 ring-white/10' },
}

interface Props {
  topology: GraphTopology
  run: WorkflowRun
  health: Health | null
  messages: ChatMessage[]
  selectedId: string | null
  onSelect: (id: string) => void
}

/**
 * The pipeline canvas + run inspector. Adapts to its own width (not the viewport):
 * side-by-side when roomy (Pipeline view), stacked when it shares the screen with chat.
 */
export function PipelineStudio({ topology, run, health, messages, selectedId, onSelect }: Props) {
  const [ref, { width }] = useElementSize<HTMLDivElement>()
  const wide = width >= 1700 // side-by-side only on very wide screens; otherwise the graph gets full width
  const outcome = runOutcome(run)
  const pill = PILL[outcome]

  // Run history = assistant messages that have a finished (or live) run.
  const runs = messages.filter((m) => m.role === 'assistant' && (m.run || m.status === 'streaming'))
  const idx = runs.findIndex((m) => m.id === selectedId)
  const prev = idx > 0 ? runs[idx - 1] : undefined
  const next = idx >= 0 && idx < runs.length - 1 ? runs[idx + 1] : undefined

  return (
    <section ref={ref} className="flex h-full min-h-0 flex-col" aria-label="Pipeline studio">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-indigo-500/25 to-cyan-500/20 ring-1 ring-white/10">
          <Workflow className="size-3.5 text-indigo-200" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[13px] font-semibold text-white">Pipeline Studio</h2>
            <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase ring-1 ${pill.className}`}>
              {outcome === 'running' && <span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-indigo-300" />}
              {pill.label}
            </span>
            {run.totalMs !== undefined && !run.running && (
              <span className="font-mono text-[10.5px] text-ink-400">{formatMs(run.totalMs)}</span>
            )}
          </div>
          <p className="truncate text-[11.5px] text-ink-400">
            {run.question ? `“${run.question}”` : 'LangGraph state machine · live from the backend topology'}
          </p>
        </div>
        {runs.length > 0 && (
          <div className="flex shrink-0 items-center gap-1 rounded-lg border border-white/[0.06] bg-ink-900/70 p-0.5">
            <NavButton label="Previous run" disabled={!prev || run.running} onClick={() => prev && onSelect(prev.id)}>
              <ChevronLeft className="size-3.5" />
            </NavButton>
            <span className="px-1 font-mono text-[10.5px] text-ink-300 tabular-nums">
              run {Math.max(1, idx + 1)}/{runs.length}
            </span>
            <NavButton label="Next run" disabled={!next || run.running} onClick={() => next && onSelect(next.id)}>
              <ChevronRight className="size-3.5" />
            </NavButton>
          </div>
        )}
      </div>

      {/* Body */}
      <div className={`flex min-h-0 flex-1 ${wide ? 'flex-row' : 'flex-col'}`}>
        <div className={`relative min-h-0 min-w-0 ${wide ? 'flex-1' : 'h-[46%] min-h-[220px] shrink-0'}`}>
          <WorkflowGraph topology={topology} run={run} />
        </div>
        <div
          className={`@container min-h-0 border-white/[0.06] bg-ink-950/40 ${
            wide ? 'w-[460px] shrink-0 border-l' : 'flex-1 border-t'
          }`}
        >
          <RunInspector run={run} topology={topology} health={health} />
        </div>
      </div>
    </section>
  )
}

function NavButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-6 place-items-center rounded-md text-ink-300 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
    >
      {children}
    </button>
  )
}
