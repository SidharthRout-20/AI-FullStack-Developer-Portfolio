import { BookOpen, Columns2, Database, FileText, History, LayoutGrid, MessageSquareText, RotateCcw, Scale, Workflow } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { ThemeToggle } from '../../theme/ThemeToggle'
import { useEffect, useRef, useState } from 'react'
import { Link } from '../../router'

const VIEWS = [
  { id: 'split', label: 'Workspace', icon: Columns2, key: '1', desktopOnly: true },
  { id: 'chat', label: 'Chat', icon: MessageSquareText, key: '2' },
  { id: 'pipeline', label: 'Pipeline', icon: Workflow, key: '3' },
  { id: 'library', label: 'Library', icon: BookOpen, key: '4', divider: true },
  { id: 'match', label: 'Match', icon: Scale, key: '5' },
]

export function TopBar({ view, onView, health, documents, error, streaming, onReset, canReset, onHistory }) {
  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.06] bg-ink-950/60 px-3 backdrop-blur-xl sm:px-5">
      <Link
        to="/"
        aria-label="All products"
        title="All products"
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.06] px-2 text-[12px] text-ink-300 transition hover:border-white/15 hover:text-white"
      >
        <LayoutGrid className="size-4" />
        <span className="hidden xl:inline">Products</span>
      </Link>
      <button
        type="button"
        onClick={onHistory}
        aria-label="Chat history"
        title="Chat history (Alt+H)"
        className="grid size-8 shrink-0 place-items-center rounded-lg border border-white/[0.06] text-ink-300 transition hover:border-white/15 hover:text-white"
      >
        <History className="size-4" />
      </button>
      {/* Brand */}
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="relative grid size-8 place-items-center">
          <span className="absolute inset-0 animate-gradient rounded-lg bg-[linear-gradient(135deg,#6366f1,#22d3ee,#34d399,#6366f1)] bg-[length:300%_300%] opacity-90" />
          <img src="/favicon.svg" alt="" className="relative size-6" />
        </div>
        <div className="hidden min-w-0 sm:block">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold tracking-tight text-white">DocuMind</span>
            <span className="rounded-md border border-brand-400/30 bg-brand-500/10 px-1.5 py-px text-[10px] font-medium tracking-wide text-indigo-200">
              RAG STUDIO
            </span>
          </div>
        </div>
      </div>

      {/* View switcher (segmented control with a sliding highlight) */}
      <nav
        aria-label="Layout"
        className="mx-auto flex items-center gap-0.5 rounded-xl border border-white/[0.06] bg-ink-900/70 p-1"
      >
        {VIEWS.map(({ id, label, icon: Icon, key, desktopOnly, divider }) => [
          divider && <span key={`d-${id}`} className="mx-1 h-4 w-px bg-white/10" aria-hidden />,
          <button
            key={id}
            type="button"
            onClick={() => onView(id)}
            aria-pressed={view === id}
            title={`${label} (Alt+${key})`}
            aria-label={label}
            className={`relative flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors sm:px-3 ${
              desktopOnly ? 'hidden lg:flex' : ''
            } ${view === id ? 'text-white' : 'text-ink-400 hover:text-ink-200'}`}
          >
            {view === id && (
              <motion.span
                layoutId="view-pill"
                className="absolute inset-0 rounded-lg bg-white/[0.08] ring-1 ring-white/10"
                transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
              />
            )}
            <Icon className="relative size-3.5" />
            <span className="relative hidden sm:inline">{label}</span>
            {id === 'pipeline' && streaming && view !== 'pipeline' && (
              <span className="relative size-1.5 animate-pulse rounded-full bg-brand-400" />
            )}
          </button>,
        ])}
      </nav>

      {/* Status + actions */}
      <div className="flex items-center gap-2">
        {error ? (
          <StatusChip tone="bad" label="Backend offline" />
        ) : health ? (
          <>
            <DocumentsMenu documents={documents} chunks={health.chunks_indexed} />
            <StatusChip
              tone={health.llm_ready ? 'good' : 'warn'}
              label={health.llm_model}
              title={`${health.llm_provider} · ${health.llm_ready ? 'ready' : 'API key not configured'}`}
            />
          </>
        ) : (
          <span className="h-7 w-40 animate-pulse rounded-lg bg-white/5" />
        )}
        <ThemeToggle compact className="hidden md:flex" />
        <button
          type="button"
          onClick={onReset}
          disabled={!canReset}
          className="grid size-8 place-items-center rounded-lg border border-white/[0.06] text-ink-300 transition hover:border-white/15 hover:text-white disabled:opacity-30"
          aria-label="New conversation"
          title="New conversation"
        >
          <RotateCcw className="size-3.5" />
        </button>
      </div>
    </header>
  )
}

function StatusChip({ tone, label, title }) {
  const dot = { good: 'bg-emerald-400', warn: 'bg-amber-400', bad: 'bg-rose-400' }[tone]
  return (
    <span
      title={title}
      className="hidden items-center gap-2 rounded-lg border border-white/[0.06] bg-ink-900/70 px-2.5 py-1.5 font-mono text-[11px] text-ink-200 md:inline-flex"
    >
      <span className="relative flex size-2">
        {tone === 'good' && <span className={`absolute inset-0 animate-ping rounded-full ${dot} opacity-60`} />}
        <span className={`relative size-2 rounded-full ${dot}`} />
      </span>
      {label}
    </span>
  )
}

function DocumentsMenu({ documents, chunks }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false)
    const esc = (e) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-ink-900/70 px-2.5 py-1.5 font-mono text-[11px] text-ink-200 transition hover:border-white/15"
      >
        <Database className="size-3.5 text-cyan-300" />
        <span className="hidden sm:inline">
          {documents.length} doc{documents.length === 1 ? '' : 's'} · {chunks} chunks
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="glass absolute right-0 mt-2 w-72 rounded-xl p-2"
          >
            <p className="px-2 pt-1 pb-2 text-[10.5px] font-semibold tracking-wider text-ink-400 uppercase">
              Knowledge base
            </p>
            <ul className="space-y-1">
              {documents.map((d) => (
                <li key={d.source} className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-white/[0.04]">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-cyan-500/10 text-cyan-300">
                    <FileText className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-ink-100">{d.source}</span>
                    <span className="block font-mono text-[10.5px] text-ink-400">
                      {d.pages} page{d.pages === 1 ? '' : 's'} · {d.chunks} chunks indexed
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 border-t border-white/[0.06] px-2 pt-2 text-[11px] leading-snug text-ink-400">
              Stored locally in SQLite, embedded with bge-small (ONNX), searchable via vectors + BM25.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
