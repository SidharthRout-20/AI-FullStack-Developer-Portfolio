/**
 * "Got a question about my skills?": a small chat on the home page that answers from my résumé (the indexed documents
 * behind /api/chat/stream), so a recruiter or client can ask instead of reading. Answers only what the documents say.
 */
import { MessageCircleQuestion, Send, Square, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { useChat } from '../hooks/useChat'

const NODES = []
const STARTERS = ['What is his experience with RAG and agents?', 'Which frontend stack does he use?', 'Has he shipped Python backends to production?']

export function SkillsChat() {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const chat = useChat(NODES)
  const end = useRef(null)

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [chat.messages])
  useEffect(() => {
    if (!open) return
    const close = (e) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])

  const ask = (q) => {
    if (!q.trim() || chat.streaming) return
    void chat.send(q)
    setText('')
  }

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.aside
            role="dialog"
            aria-label="Ask about my skills"
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.98 }}
            transition={{ duration: 0.2 }}
            className="fixed right-4 bottom-20 z-50 flex max-h-[min(72vh,640px)] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-3xl border border-white/10 bg-ink-900 shadow-2xl"
          >
            <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-3">
              <MessageCircleQuestion className="size-4 text-cyan-300" />
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-white">Ask about my skills</p>
                <p className="text-[11.5px] text-ink-500">Answers come from my résumé, with sources.</p>
              </div>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="ml-auto grid size-7 place-items-center rounded-full text-ink-400 hover:bg-white/[0.06] hover:text-white"><X className="size-4" /></button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-[13.5px]">
              {chat.messages.length === 0 && (
                <div className="space-y-2">
                  <p className="text-ink-300">Hiring, or wondering if I'd fit your project? Ask anything about my experience and skills.</p>
                  {STARTERS.map((q) => (
                    <button key={q} type="button" onClick={() => ask(q)} className="block w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-left text-ink-200 hover:border-white/20 hover:text-white">{q}</button>
                  ))}
                </div>
              )}
              {chat.messages.map((m) => (
                <div key={m.id} className={m.role === 'user' ? 'ml-8 rounded-2xl rounded-br-md bg-white/[0.08] px-3 py-2 text-white' : 'mr-4 text-ink-200'}>
                  {m.status === 'error' ? <span className="text-rose-300">{m.error || 'Something went wrong. Please try again.'}</span> : (
                    m.role === 'user' ? <p className="whitespace-pre-wrap">{m.content}</p> : (
                      <div className="space-y-2 [&_li]:ml-4 [&_li]:list-disc [&_strong]:text-white">
                        <Markdown>{m.content.replace(/\s*\[\d+\]/g, '') || (m.status === 'streaming' ? '…' : '')}</Markdown>
                      </div>
                    )
                  )}
                  {m.role === 'assistant' && m.sources?.length > 0 && (
                    <p className="mt-1 text-[11px] text-ink-500">Source: {[...new Set(m.sources.map((s) => s.source ?? s.title ?? s.document).filter(Boolean))].slice(0, 2).join(', ')}</p>
                  )}
                </div>
              ))}
              <div ref={end} />
            </div>
            <form className="flex gap-2 border-t border-white/[0.07] p-3" onSubmit={(e) => { e.preventDefault(); ask(text) }}>
              <input value={text} onChange={(e) => setText(e.target.value.slice(0, 500))} placeholder="e.g. Has he built RAG systems?" aria-label="Your question"
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[13.5px] text-white placeholder:text-ink-500 focus:border-white/25 focus:outline-none" />
              {chat.streaming ? (
                <button type="button" onClick={chat.stop} aria-label="Stop" className="grid size-9 place-items-center rounded-xl bg-white/10 text-white"><Square className="size-4" /></button>
              ) : (
                <button type="submit" disabled={!text.trim()} aria-label="Send" className="grid size-9 place-items-center rounded-xl bg-cyan-400 text-ink-950 disabled:opacity-40"><Send className="size-4" /></button>
              )}
            </form>
          </motion.aside>
        )}
      </AnimatePresence>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="fixed right-4 bottom-4 z-50 inline-flex items-center gap-2 rounded-full bg-cyan-400 px-4 py-3 text-[13.5px] font-semibold text-ink-950 shadow-xl hover:bg-cyan-300"
      >
        {open ? <X className="size-4" /> : <MessageCircleQuestion className="size-4" />} {open ? 'Close' : 'Ask about my skills'}
      </button>
    </>
  )
}
