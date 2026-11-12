import { Activity, Globe, Layers, ShieldCheck, Sparkles } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useRef } from 'react'
import { Composer } from './Composer'
import { MessageBubble } from './MessageBubble'

const SUGGESTIONS = [
  { q: 'Summarize the professional experience', tag: 'Grounded' },
  { q: 'What are the key technical skills?', tag: 'Grounded' },
  { q: 'Which projects involve AI or machine learning?', tag: 'Grounded' },
  { q: 'What is retrieval-augmented generation?', tag: 'General' },
]

const CAPABILITIES = [
  { icon: Layers, title: 'Hybrid retrieval', text: 'Vectors + BM25 fused with RRF' },
  { icon: Activity, title: 'Explainable runs', text: 'Inspect every step & score' },
  { icon: ShieldCheck, title: 'Guardrails', text: 'Injection-aware, cited answers' },
]

export function ChatPanel({ messages, streaming, ready, stage, selectedId, memory, onSend, onStop, onInspect }) {
  const scrollRef = useRef(null)
  const last = messages[messages.length - 1]

  // Keep the newest tokens in view while streaming.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length, last?.content])

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Chat">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6 sm:px-6">
          {messages.length === 0 ? (
            <EmptyState onPick={onSend} disabled={!ready} />
          ) : (
            messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                stage={m.status === 'streaming' ? stage : undefined}
                selected={m.role === 'assistant' && m.id === selectedId && !!m.run}
                onInspect={onInspect}
              />
            ))
          )}
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4 sm:px-6">
        <Composer onSend={onSend} onStop={onStop} streaming={streaming} disabled={!ready} memory={memory} />
        <p className="mt-2 text-center text-[11px] text-ink-500">
          Remembers your last 4 exchanges · document answers cite sources · <kbd className="font-mono text-ink-300">/</kbd> to focus
        </p>
      </div>
    </section>
  )
}

function EmptyState({ onPick, disabled }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center pt-6 text-center">
      <motion.div
        initial={{ scale: 0.6, opacity: 0, rotate: -12 }}
        animate={{ scale: 1, opacity: 1, rotate: 0 }}
        transition={{ type: 'spring', bounce: 0.45, duration: 0.8 }}
        className="relative mb-6"
      >
        <span className="absolute inset-0 animate-pulse rounded-2xl bg-indigo-500/40 blur-2xl" />
        <span className="relative grid size-16 animate-float place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-cyan-400 shadow-2xl shadow-indigo-900/60">
          <Sparkles className="size-8 text-white" />
        </span>
      </motion.div>

      <motion.h2
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="text-gradient animate-gradient text-3xl font-semibold tracking-tight sm:text-4xl"
      >
        Ask your documents anything.
      </motion.h2>
      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.18 }}
        className="mt-3 max-w-lg text-[14.5px] leading-relaxed text-ink-300"
      >
        Answers are grounded in your knowledge base with inline citations. Every question runs through a live agentic
        pipeline you can watch, replay and inspect.
      </motion.p>

      <motion.div
        initial="hidden"
        animate="show"
        variants={{ show: { transition: { staggerChildren: 0.06, delayChildren: 0.25 } } }}
        className="mt-6 flex flex-wrap justify-center gap-2"
      >
        {CAPABILITIES.map(({ icon: Icon, title, text }) => (
          <motion.span
            key={title}
            variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0 } }}
            className="flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.03] px-3 py-1.5 text-[12px] text-ink-300"
          >
            <Icon className="size-3.5 text-cyan-300" />
            <span className="font-medium text-ink-100">{title}</span>
            <span className="hidden text-ink-400 sm:inline">· {text}</span>
          </motion.span>
        ))}
      </motion.div>

      <motion.div
        initial="hidden"
        animate="show"
        variants={{ show: { transition: { staggerChildren: 0.07, delayChildren: 0.4 } } }}
        className="mt-8 grid w-full max-w-2xl gap-2.5 sm:grid-cols-2"
      >
        {SUGGESTIONS.map(({ q, tag }) => (
          <motion.button
            key={q}
            type="button"
            disabled={disabled}
            onClick={() => onPick(q)}
            variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
            whileHover={{ y: -2 }}
            className="group relative overflow-hidden rounded-xl border border-white/[0.07] bg-ink-900/60 px-4 py-3.5 text-left transition hover:border-brand-400/40 hover:bg-ink-850 disabled:opacity-40"
          >
            <span className="absolute inset-0 bg-gradient-to-br from-indigo-500/0 to-cyan-500/0 transition duration-500 group-hover:from-indigo-500/10 group-hover:to-cyan-500/5" />
            <span className="relative flex items-center gap-1.5 text-[10.5px] font-medium tracking-wide text-ink-400 uppercase">
              {tag === 'General' ? <Globe className="size-3 text-amber-300" /> : <Layers className="size-3 text-emerald-300" />}
              {tag}
            </span>
            <span className="relative mt-1 block text-[13.5px] text-ink-100">{q}</span>
          </motion.button>
        ))}
      </motion.div>
    </div>
  )
}
