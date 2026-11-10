import { Activity, BookOpenCheck, Check, Copy, Globe, ShieldX, Sparkles, TriangleExclamationPoint } from 'lucide-react'
import { motion } from 'motion/react'
import { memo, useState, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { linkCitations } from '../../lib/citations'
import { formatMs } from '../../lib/format'
import type { ChatMessage, GradeDetail } from '../../types'
import { SourceList } from './SourceList'

interface Props {
  message: ChatMessage
  /** Human label of the pipeline stage currently running (streaming bubbles only). */
  stage?: string
  selected?: boolean
  onInspect?: (id: string) => void
}

function MessageBubbleImpl({ message, stage, selected, onInspect }: Props) {
  const [highlight, setHighlight] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  if (message.role === 'user') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.25 }}
        className="flex justify-end"
      >
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-gradient-to-br from-indigo-500 to-violet-600 px-4 py-2.5 text-[14.5px] whitespace-pre-wrap text-on-accent shadow-[0_10px_30px_-12px_rgb(99_102_241/0.8)]">
          {message.content}
        </p>
      </motion.div>
    )
  }

  // react-markdown never renders raw HTML (no rehype-raw), so model output can't inject markup.
  const components: Components = {
    a: ({ href, children }) => {
      const cite = href?.match(/^#cite-(\d+)$/)
      if (cite) {
        const n = Number(cite[1])
        return (
          <button
            type="button"
            className="cite mx-0.5 inline-grid h-[18px] min-w-[18px] place-items-center rounded-md bg-brand-500/20 px-1 align-text-top font-mono text-[10px] font-semibold text-indigo-200 ring-1 ring-brand-400/30 transition hover:bg-brand-500/45"
            onMouseEnter={() => setHighlight(n)}
            onMouseLeave={() => setHighlight(null)}
            onFocus={() => setHighlight(n)}
            onBlur={() => setHighlight(null)}
            aria-label={`Source ${n}`}
          >
            {n}
          </button>
        )
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow">
          {children}
        </a>
      )
    },
  }

  const streaming = message.status === 'streaming'
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex gap-3"
    >
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-500/25 to-cyan-500/20 ring-1 ring-white/10">
        <Sparkles className={`size-4 text-indigo-200 ${streaming ? 'animate-pulse' : ''}`} />
      </span>

      <div
        className={`min-w-0 flex-1 rounded-2xl rounded-tl-md border px-4 py-3 text-[14.5px] text-ink-100 transition-colors ${
          selected ? 'border-brand-400/40 bg-ink-850/90' : 'border-white/[0.06] bg-ink-900/70'
        }`}
      >
        {message.content ? (
          <div className="prose-answer">
            <Markdown remarkPlugins={[remarkGfm]} components={components}>
              {linkCitations(message.content)}
            </Markdown>
            {streaming && <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-blink bg-indigo-300" />}
          </div>
        ) : streaming ? (
          <p className="text-shimmer py-0.5 text-sm font-medium">{stage ?? 'Thinking'}…</p>
        ) : null}

        {message.status === 'error' && (
          <p className="mt-1 flex items-start gap-2 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-200 ring-1 ring-rose-500/20">
            <TriangleExclamationPoint className="mt-0.5 size-4 shrink-0" />
            {message.error}
          </p>
        )}

        {!!message.sources?.length && message.route !== 'general' && (
          <SourceList sources={message.sources} highlight={highlight} />
        )}

        {!streaming && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.05] pt-2.5">
            <RouteBadge message={message} />
            {message.run?.totalMs !== undefined && (
              <span className="font-mono text-[10.5px] text-ink-400">{formatMs(message.run.totalMs)}</span>
            )}
            <span className="ml-auto flex items-center gap-1">
              {message.run && onInspect && (
                <button
                  type="button"
                  onClick={() => onInspect(message.id)}
                  className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition ${
                    selected ? 'bg-brand-500/15 text-indigo-200' : 'text-ink-300 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <Activity className="size-3.5" /> {selected ? 'Inspecting' : 'Inspect run'}
                </button>
              )}
              {message.content && (
                <button
                  type="button"
                  onClick={copy}
                  className="grid size-7 place-items-center rounded-md text-ink-400 transition hover:bg-white/5 hover:text-white"
                  aria-label="Copy answer"
                >
                  {copied ? <Check className="size-3.5 text-emerald-300" /> : <Copy className="size-3.5" />}
                </button>
              )}
            </span>
          </div>
        )}
      </div>
    </motion.div>
  )
}

function RouteBadge({ message }: { message: ChatMessage }) {
  const grade = message.run?.nodes.grade?.detail as Partial<GradeDetail> | undefined
  if (message.status === 'error') return null
  if (message.route === 'blocked')
    return (
      <Badge className="bg-rose-500/10 text-rose-200 ring-rose-500/25">
        <ShieldX className="size-3" /> Blocked by guardrails
      </Badge>
    )
  if (message.route === 'general')
    return (
      <Badge className="bg-amber-500/10 text-amber-200 ring-amber-500/25">
        <Globe className="size-3" /> General knowledge
      </Badge>
    )
  if (message.route === 'answered')
    return (
      <Badge className="bg-emerald-500/10 text-emerald-200 ring-emerald-500/25">
        <BookOpenCheck className="size-3" /> Grounded · {message.sources?.length ?? 0} sources
        {grade?.confidence && <span className="opacity-70">· {grade.confidence} confidence</span>}
      </Badge>
    )
  return null
}

function Badge({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ${className}`}>
      {children}
    </span>
  )
}

export const MessageBubble = memo(MessageBubbleImpl)
