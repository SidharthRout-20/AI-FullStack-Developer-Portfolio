import { ArrowUpRight, BookOpen, CheckCircle2, FileText, Layers, RefreshCw, Sparkles, TriangleExclamationPoint } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { formatMs } from '../../lib/format'

/** Knowledge-base library: every indexed document gets an AI-generated brief (cached server-side). */
export function LibraryView({ documents, onAsk }) {
  const [selected, setSelected] = useState(documents[0]?.source ?? null)
  const [state, setState] = useState({ status: 'idle' })
  const active = selected ?? documents[0]?.source ?? null

  const load = useCallback((source, refresh = false, signal) => {
    setState({ status: 'loading' })
    api
      .brief(source, refresh, signal)
      .then((data) => setState({ status: 'ready', data }))
      .catch((err) => {
        if (!signal?.aborted) setState({ status: 'error', message: err instanceof Error ? err.message : 'Failed to load' })
      })
  }, [])

  useEffect(() => {
    if (!active) return
    const ctrl = new AbortController()
    const id = requestAnimationFrame(() => load(active, false, ctrl.signal))
    return () => {
      cancelAnimationFrame(id)
      ctrl.abort()
    }
  }, [active, load])

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {/* Document list */}
      <aside className="shrink-0 border-white/[0.06] p-4 lg:w-80 lg:border-r">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold text-white">
          <BookOpen className="size-4 text-cyan-300" /> Library
        </h2>
        <p className="mt-0.5 text-[11.5px] text-ink-400">{documents.length} indexed · briefs generated on demand</p>
        <ul className="mt-4 flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
          {documents.map((d) => (
            <li key={d.source} className="shrink-0 lg:shrink">
              <button
                type="button"
                onClick={() => setSelected(d.source)}
                className={`flex w-64 items-center gap-3 rounded-xl border p-3 text-left transition lg:w-full ${
                  d.source === active
                    ? 'border-brand-400/40 bg-brand-500/10'
                    : 'border-white/[0.06] bg-white/[0.02] hover:border-white/15'
                }`}
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-cyan-500/20 to-indigo-500/20 text-cyan-200">
                  <FileText className="size-5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-ink-100">{d.source}</span>
                  <span className="block font-mono text-[10.5px] text-ink-400">
                    {d.pages}p · {d.chunks} chunks
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* Brief */}
      <section className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {!active ? (
          <p className="text-sm text-ink-400">No documents indexed yet. Add files to the documents folder.</p>
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={`${active}-${state.status}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="mx-auto max-w-4xl"
            >
              {state.status === 'ready' ? (
                <BriefCard data={state.data} onAsk={onAsk} onRefresh={() => load(active, true)} />
              ) : state.status === 'error' ? (
                <div className="rounded-xl bg-rose-500/10 p-4 text-sm text-rose-200 ring-1 ring-rose-500/25">
                  <p className="flex items-center gap-2 font-medium">
                    <TriangleExclamationPoint className="size-4" /> Couldn't generate the brief
                  </p>
                  <p className="mt-1 text-rose-200/80">{state.message}</p>
                  <button
                    type="button"
                    onClick={() => load(active)}
                    className="mt-3 rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/15"
                  >
                    Try again
                  </button>
                </div>
              ) : (
                <BriefSkeleton source={active} />
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </section>
    </div>
  )
}

function BriefCard({ data, onAsk, onRefresh }) {
  const { brief } = data
  return (
    <article className="space-y-5">
      <header>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
          <span className="rounded-md bg-white/[0.05] px-2 py-0.5 font-mono">{data.source}</span>
          <span className="font-mono">
            {data.pages} pages · {data.chunks} chunks
          </span>
          <span className="flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-emerald-200">
            <Sparkles className="size-3" /> {data.cached ? 'cached brief' : `generated in ${formatMs(data.generated_ms)}`}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-ink-300 hover:bg-white/5 hover:text-white"
          >
            <RefreshCw className="size-3" /> Regenerate
          </button>
        </div>
        <h1 className="text-gradient mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          {brief.title || data.source}
        </h1>
        <p className="mt-3 text-[14.5px] leading-relaxed text-ink-200">{brief.summary}</p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <h3 className="mb-3 text-[10.5px] font-semibold tracking-wider text-ink-400 uppercase">Key highlights</h3>
          <ul className="space-y-2">
            {brief.highlights.map((h, i) => (
              <motion.li
                key={h}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.05 }}
                className="flex gap-2 text-[13px] text-ink-100"
              >
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-300" /> {h}
              </motion.li>
            ))}
          </ul>
        </section>

        <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <h3 className="mb-3 text-[10.5px] font-semibold tracking-wider text-ink-400 uppercase">Topics</h3>
          <div className="space-y-3">
            {brief.topics.map((t) => (
              <div key={t.label}>
                <p className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-200">
                  <Layers className="size-3 text-cyan-300" /> {t.label}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {t.items.map((item) => (
                    <span key={item} className="rounded-md border border-white/[0.07] bg-ink-900/70 px-2 py-0.5 text-[11.5px] text-ink-200">
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {brief.suggested_questions.length > 0 && (
        <section>
          <h3 className="mb-2 text-[10.5px] font-semibold tracking-wider text-ink-400 uppercase">Ask the assistant</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {brief.suggested_questions.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => onAsk(q)}
                className="group flex items-center gap-2 rounded-xl border border-white/[0.07] bg-ink-900/60 px-3.5 py-3 text-left text-[13px] text-ink-100 transition hover:border-brand-400/40 hover:bg-ink-850"
              >
                <span className="flex-1">{q}</span>
                <ArrowUpRight className="size-4 shrink-0 text-ink-500 transition group-hover:text-indigo-300" />
              </button>
            ))}
          </div>
        </section>
      )}
    </article>
  )
}

function BriefSkeleton({ source }) {
  return (
    <div className="space-y-5" aria-busy>
      <p className="text-shimmer text-sm font-medium">Reading {source} and writing a brief…</p>
      <div className="h-8 w-2/3 animate-pulse rounded-lg bg-white/[0.06]" />
      <div className="space-y-2">
        {[1, 0.92, 0.75].map((w) => (
          <div key={w} className="h-3 animate-pulse rounded bg-white/[0.05]" style={{ width: `${w * 100}%` }} />
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="h-44 animate-pulse rounded-xl bg-white/[0.03]" />
        <div className="h-44 animate-pulse rounded-xl bg-white/[0.03]" />
      </div>
    </div>
  )
}
