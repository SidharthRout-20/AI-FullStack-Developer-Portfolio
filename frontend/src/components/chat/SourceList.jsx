import { ChevronDown, FileText } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'

export function SourceList({ sources, highlight }) {
  const [open, setOpen] = useState(false)
  const expanded = open || highlight !== null

  return (
    <div className="mt-3 border-t border-ink-700/70 pt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 text-xs font-medium text-ink-300 transition hover:text-ink-100"
        aria-expanded={expanded}
      >
        <FileText className="size-3.5" />
        {sources.length} source{sources.length > 1 ? 's' : ''}
        <ChevronDown className={`ml-auto size-3.5 transition ${expanded ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="mt-2 space-y-1.5 overflow-hidden"
          >
            {sources.map((s) => (
              <li
                key={s.id}
                className={`rounded-lg border px-2.5 py-2 transition ${
                  highlight === s.id ? 'border-indigo-400/70 bg-indigo-500/10' : 'border-ink-700/60 bg-ink-900/50'
                }`}
              >
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="grid h-4 min-w-4 place-items-center rounded bg-indigo-500/25 px-1 font-mono font-semibold text-indigo-200">
                    {s.id}
                  </span>
                  <span className="truncate font-medium text-ink-100">{s.source}</span>
                  <span className="text-ink-400">p.{s.page}</span>
                  <span className="ml-auto flex items-center gap-1.5 font-mono text-ink-400">
                    <span className="h-1 w-12 overflow-hidden rounded-full bg-ink-700">
                      <span
                        className="block h-full rounded-full bg-gradient-to-r from-indigo-400 to-emerald-400"
                        style={{ width: `${Math.round(Math.max(0, Math.min(1, s.similarity)) * 100)}%` }}
                      />
                    </span>
                    {s.similarity.toFixed(2)}
                  </span>
                </div>
                <p className="mt-1 line-clamp-3 text-[11.5px] leading-snug text-ink-300">{s.snippet}</p>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}
