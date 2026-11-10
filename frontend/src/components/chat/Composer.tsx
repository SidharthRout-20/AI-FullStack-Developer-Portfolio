import { Brain, CornerDownLeft, SendHorizontal, Square } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

const MAX_CHARS = 1000 // mirrors backend validation

interface Props {
  onSend: (text: string) => void
  onStop: () => void
  streaming: boolean
  disabled?: boolean
  /** Conversation memory usage, e.g. { used: 2, max: 4 } exchanges. */
  memory?: { used: number; max: number }
}

export function Composer({ onSend, onStop, streaming, disabled, memory }: Props) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // Auto-grow textarea up to ~6 lines.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  // "/" focuses the composer from anywhere (unless typing in another field).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(t.tagName) && !t.isContentEditable) {
        e.preventDefault()
        ref.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (streaming || disabled || !text.trim()) return
    onSend(text)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e)
  }

  return (
    <form onSubmit={submit} className="group relative">
      {/* Gradient focus ring */}
      <span className="pointer-events-none absolute -inset-px rounded-2xl bg-gradient-to-r from-indigo-500/0 via-indigo-500/0 to-cyan-500/0 opacity-0 transition duration-500 group-focus-within:from-indigo-500/60 group-focus-within:via-violet-500/40 group-focus-within:to-cyan-400/60 group-focus-within:opacity-100" />
      <div className="relative flex items-end gap-2 rounded-2xl border border-white/[0.08] bg-ink-900/90 p-2 shadow-2xl shadow-black/40 backdrop-blur-xl">
        <label htmlFor="question" className="sr-only">
          Ask a question about the documents
        </label>
        <textarea
          id="question"
          ref={ref}
          rows={1}
          value={text}
          maxLength={MAX_CHARS}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          placeholder={disabled ? 'Connecting to backend…' : 'Ask about your documents, or anything else…'}
          className="max-h-40 flex-1 resize-none bg-transparent px-2.5 py-2 text-[14.5px] text-ink-100 placeholder:text-ink-500 focus:outline-none disabled:opacity-50"
        />
        {memory && memory.used > 0 && (
          <span
            title={`The assistant remembers the last ${memory.max} exchanges of this chat`}
            className="mb-2 hidden items-center gap-1.5 rounded-md bg-white/[0.04] px-2 py-1 font-mono text-[10.5px] text-ink-300 sm:flex"
          >
            <Brain className="size-3 text-violet-300" />
            {memory.used}/{memory.max}
            <span className="flex gap-0.5">
              {Array.from({ length: memory.max }, (_, i) => (
                <span key={i} className={`h-2.5 w-1 rounded-full ${i < memory.used ? 'bg-violet-300' : 'bg-white/15'}`} />
              ))}
            </span>
          </span>
        )}
        <span className="mb-2.5 hidden items-center gap-1 font-mono text-[10.5px] text-ink-500 sm:flex">
          {text.length > MAX_CHARS * 0.8 ? (
            `${text.length}/${MAX_CHARS}`
          ) : (
            <>
              <CornerDownLeft className="size-3" /> send
            </>
          )}
        </span>
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            className="grid size-10 place-items-center rounded-xl bg-ink-700 text-ink-100 transition hover:bg-ink-600"
            aria-label="Stop generating"
          >
            <Square className="size-4 fill-current" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || !text.trim()}
            className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-500 text-on-accent shadow-lg shadow-indigo-900/50 transition hover:scale-105 hover:brightness-110 active:scale-95 disabled:scale-100 disabled:cursor-not-allowed disabled:opacity-35"
            aria-label="Send"
          >
            <SendHorizontal className="size-4" />
          </button>
        )}
      </div>
    </form>
  )
}
