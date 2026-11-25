/**
 * "Ask about my work": an AI spotlight instead of a chat bubble. A slim pill sits at the bottom centre (it tucks into
 * an icon while you scroll down) and "/" opens a command-bar style panel over the page, the pattern of Linear, Vercel
 * and Raycast AI: one big input, suggested questions, a streamed answer with its sources, and follow-ups in place.
 * Answers come only from my résumé and the portfolio's projects page (the documents indexed behind /api/chat/stream).
 */
import { ArrowUp, CornerDownLeft, FileText, Sparkles, Square, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { useChat } from '../hooks/useChat'

const NODES = []
// Questions the indexed documents answer definitely (the résumé and the portfolio's projects page).
const SUGGESTED = [
  'What AI products has he built?',
  'How does CodeLens use RAG and citations?',
  'What does he do at Deloitte?',
  'How many years of experience does he have?',
]
const PLACEHOLDERS = ['Ask about my experience…', 'Ask about my AI work…', 'Ask what I could build for you…']

function usePill() {
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    let last = window.scrollY
    const on = () => {
      const y = window.scrollY
      if (Math.abs(y - last) > 8) setCompact(y > last && y > 200)
      last = y
    }
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  return compact
}

export function SkillsChat() {
  const [open, setOpen] = useState(false)
  const compact = usePill()

  // "/" opens it from anywhere on the page (unless you're typing somewhere); Esc closes.
  useEffect(() => {
    const key = (e) => {
      const field = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable
      if (e.key === '/' && !field && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        setOpen(true)
      } else if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center">
      <motion.button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ask about my work"
        aria-keyshortcuts="/"
        layout
        className="group pointer-events-auto flex items-center gap-2.5 rounded-full border border-white/15 bg-ink-900/70 py-2 pr-2 pl-2 text-left shadow-[0_10px_40px_-10px_rgb(0_0_0/0.6)] ring-1 ring-white/5 backdrop-blur-2xl transition hover:border-white/25"
      >
        <span className="relative grid size-8 place-items-center rounded-full bg-gradient-to-br from-cyan-400 via-sky-500 to-violet-500 text-white">
          <motion.span aria-hidden className="absolute inset-0 rounded-full bg-gradient-to-br from-cyan-400 to-violet-500" animate={{ opacity: [0.5, 0, 0.5], scale: [1, 1.45, 1] }} transition={{ duration: 2.8, repeat: Infinity }} />
          <Sparkles className="relative size-4" />
        </span>
        <AnimatePresence initial={false}>
          {!compact && (
            <motion.span key="label" initial={{ opacity: 0, width: 0 }} animate={{ opacity: 1, width: 'auto' }} exit={{ opacity: 0, width: 0 }} className="flex items-center gap-3 overflow-hidden whitespace-nowrap">
              <span className="text-[14px] text-ink-200">Ask my AI about my work</span>
              <kbd className="mr-1 rounded-md border border-white/15 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-ink-300">/</kbd>
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>
      </div>
      <AnimatePresence>{open && <Spotlight onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  )
}

function Spotlight({ onClose }) {
  const [text, setText] = useState('')
  const [ph, setPh] = useState(0)
  const chat = useChat(NODES)
  const input = useRef(null)
  const end = useRef(null)

  useEffect(() => {
    input.current?.focus()
    const t = setInterval(() => setPh((i) => (i + 1) % PLACEHOLDERS.length), 3000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [chat.messages])

  const ask = (q) => {
    if (!q.trim() || chat.streaming) return
    void chat.send(q.trim())
    setText('')
  }
  const sources = (m) => [...new Set((m.sources ?? []).map((s) => s.source ?? s.title ?? s.document).filter(Boolean))].slice(0, 3)

  return (
    <motion.div className="fixed inset-0 z-50 flex items-start justify-center bg-ink-950/60 px-3 pt-[10vh] backdrop-blur-md sm:pt-[14vh]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Ask about my work"
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98 }}
        transition={{ duration: 0.18 }}
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-[76vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-ink-900/95 shadow-2xl ring-1 ring-white/5"
      >
        <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 h-48 w-[80%] -translate-x-1/2 rounded-full bg-gradient-to-r from-cyan-500/25 via-sky-500/20 to-violet-500/25 blur-3xl" />
        <form className="relative flex items-center gap-3 border-b border-white/[0.07] px-5 py-4" onSubmit={(e) => { e.preventDefault(); ask(text) }}>
          <Sparkles className="size-5 shrink-0 text-cyan-300" />
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 500))}
            placeholder={PLACEHOLDERS[ph]}
            aria-label="Your question"
            className="min-w-0 flex-1 bg-transparent text-[17px] text-white placeholder:text-ink-500 focus:outline-none"
          />
          {chat.streaming ? (
            <button type="button" onClick={chat.stop} aria-label="Stop" className="grid size-8 place-items-center rounded-full bg-white/10 text-white"><Square className="size-3.5" /></button>
          ) : text.trim() ? (
            <button type="submit" aria-label="Ask" className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-cyan-400 to-violet-500 text-white"><ArrowUp className="size-4" /></button>
          ) : (
            <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-full text-ink-400 hover:bg-white/[0.06] hover:text-white"><X className="size-4" /></button>
          )}
        </form>

        <div className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {chat.messages.length === 0 ? (
            <>
              <p className="mb-2 text-[11.5px] font-semibold tracking-[0.14em] text-ink-500 uppercase">Suggested</p>
              <ul className="space-y-1">
                {SUGGESTED.map((q) => (
                  <li key={q}>
                    <button type="button" onClick={() => ask(q)} className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14.5px] text-ink-200 hover:bg-white/[0.05] hover:text-white">
                      <Sparkles className="size-3.5 shrink-0 text-ink-500 group-hover:text-cyan-300" /> {q}
                      <CornerDownLeft className="ml-auto size-3.5 text-ink-600 opacity-0 group-hover:opacity-100" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="space-y-5">
              {chat.messages.map((m) =>
                m.role === 'user' ? (
                  <p key={m.id} className="text-[13px] font-semibold text-ink-400">{m.content}</p>
                ) : (
                  <div key={m.id} className="space-y-2">
                    {m.status === 'error' ? (
                      <p className="text-[14px] text-rose-300">{m.error || 'Something went wrong. Please try again.'}</p>
                    ) : (
                      <div className="space-y-2 text-[15px] leading-relaxed text-ink-100 [&_li]:ml-4 [&_li]:list-disc [&_strong]:text-white">
                        {m.content ? <Markdown>{m.content.replace(/\s*\[\d+\]/g, '')}</Markdown> : <Thinking />}
                      </div>
                    )}
                    {sources(m).length > 0 && (
                      <p className="flex flex-wrap gap-1.5">
                        {sources(m).map((s) => <span key={s} className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11.5px] text-ink-400"><FileText className="size-3" /> {s}</span>)}
                      </p>
                    )}
                  </div>
                ),
              )}
              <div ref={end} />
            </div>
          )}
        </div>
        <p className="relative flex items-center justify-between border-t border-white/[0.06] px-5 py-2.5 text-[11.5px] text-ink-500">
          <span>Answers come only from my résumé and project notes, with sources.</span>
          <span className="hidden sm:inline"><kbd className="rounded border border-white/10 px-1">Esc</kbd> to close</span>
        </p>
      </motion.div>
    </motion.div>
  )
}

function Thinking() {
  return (
    <span className="flex items-center gap-1 py-1" aria-label="Thinking">
      {[0, 1, 2].map((i) => <motion.span key={i} className="size-1.5 rounded-full bg-cyan-300/80" animate={{ opacity: [0.25, 1, 0.25], y: [0, -2, 0] }} transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }} />)}
    </span>
  )
}
