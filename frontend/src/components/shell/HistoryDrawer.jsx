import { History, MessageSquarePlus, Search, Trash2, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { dayBucket } from '../../lib/sessions'

/** Slide-over chat history: hidden until the user asks for it, never takes permanent space. */
export function HistoryDrawer({ open, sessions, activeId, now, onClose, onOpen, onDelete, onNew }) {
  const [query, setQuery] = useState('')
  const [confirm, setConfirm] = useState(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? sessions.filter(
          (s) => s.title.toLowerCase().includes(q) || s.messages.some((m) => m.content.toLowerCase().includes(q)),
        )
      : sessions
    const map = new Map()
    for (const s of filtered) {
      const label = dayBucket(s.updatedAt, now)
      map.set(label, [...(map.get(label) ?? []), s])
    }
    return [...map.entries()]
  }, [sessions, query, now])

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-ink-950/60 backdrop-blur-sm"
          />
          <motion.aside
            key="drawer"
            role="dialog"
            aria-label="Chat history"
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'spring', bounce: 0, duration: 0.35 }}
            className="glass fixed inset-y-0 left-0 z-50 flex w-[340px] max-w-[88vw] flex-col rounded-r-2xl"
          >
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
              <History className="size-4 text-indigo-300" />
              <h2 className="text-[13px] font-semibold text-white">Chat history</h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close history"
                className="ml-auto grid size-7 place-items-center rounded-md text-ink-400 hover:bg-white/5 hover:text-white"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="space-y-2 p-3">
              <button
                type="button"
                onClick={onNew}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-cyan-500 px-3 py-2 text-[13px] font-medium text-on-accent shadow-lg shadow-indigo-950/40 transition hover:brightness-110"
              >
                <MessageSquarePlus className="size-4" /> New chat
              </button>
              <label className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-ink-900/70 px-3 py-2 focus-within:border-brand-400/50">
                <Search className="size-3.5 text-ink-400" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search conversations"
                  aria-label="Search conversations"
                  className="w-full bg-transparent text-[13px] text-ink-100 placeholder:text-ink-500 focus:outline-none"
                />
              </label>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {groups.length === 0 ? (
                <p className="px-3 py-8 text-center text-[12.5px] text-ink-400">
                  {sessions.length ? 'No conversations match your search.' : 'Your conversations will appear here.'}
                </p>
              ) : (
                groups.map(([label, items]) => (
                  <section key={label} className="mb-2">
                    <h3 className="px-3 pt-2 pb-1 text-[10.5px] font-semibold tracking-wider text-ink-500 uppercase">
                      {label}
                    </h3>
                    <ul>
                      {items.map((s) => (
                        <li key={s.id} className="group relative">
                          <button
                            type="button"
                            onClick={() => onOpen(s.id)}
                            className={`w-full rounded-lg px-3 py-2 pr-9 text-left transition ${
                              s.id === activeId ? 'bg-brand-500/15 ring-1 ring-brand-400/30' : 'hover:bg-white/[0.04]'
                            }`}
                          >
                            <span className="block truncate text-[13px] text-ink-100">{s.title}</span>
                            <span className="block font-mono text-[10.5px] text-ink-500">
                              {Math.ceil(s.messages.length / 2)} exchange{s.messages.length > 2 ? 's' : ''} ·{' '}
                              {new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => (confirm === s.id ? (onDelete(s.id), setConfirm(null)) : setConfirm(s.id))}
                            onBlur={() => setConfirm(null)}
                            aria-label={confirm === s.id ? 'Confirm delete' : `Delete ${s.title}`}
                            className={`absolute top-2 right-2 grid h-7 place-items-center rounded-md px-1.5 text-[11px] transition ${
                              confirm === s.id
                                ? 'bg-rose-500/20 text-rose-200'
                                : 'text-ink-500 opacity-0 group-hover:opacity-100 hover:bg-white/5 hover:text-rose-300 focus:opacity-100'
                            }`}
                          >
                            {confirm === s.id ? 'Delete?' : <Trash2 className="size-3.5" />}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </div>
            <p className="border-t border-white/[0.06] px-4 py-2.5 text-[10.5px] text-ink-500">
              Stored only in this browser · up to 30 conversations
            </p>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
