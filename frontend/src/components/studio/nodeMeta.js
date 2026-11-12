import {
  CircleCheckBig,
  Funnel,
  Globe,
  MessageSquare,
  PenLine,
  Search,
  ShieldCheck,
  ShieldX,
  Sparkles,
} from 'lucide-react'

export const NODE_ICONS = {
  __start__: MessageSquare,
  guard: ShieldCheck,
  rewrite: PenLine,
  retrieve: Search,
  grade: Funnel,
  generate: Sparkles,
  general: Globe,
  refuse: ShieldX,
  __end__: CircleCheckBig,
}

/** Present-tense status shown in the chat while a node is running. */
export const NODE_STAGE = {
  guard: 'Checking guardrails',
  rewrite: 'Understanding your question',
  retrieve: 'Searching the knowledge base',
  grade: 'Ranking the evidence',
  generate: 'Writing a cited answer',
  general: 'Answering from general knowledge',
  refuse: 'Applying guardrails',
}

/** Per-node accent used for the waterfall bars and node icons. */
export const NODE_COLOR = {
  guard: '#a78bfa',
  rewrite: '#f472b6',
  retrieve: '#22d3ee',
  grade: '#38bdf8',
  generate: '#818cf8',
  general: '#fbbf24',
  refuse: '#fb7185',
}

/** Compact metric shown under a finished node on the canvas. */
export function nodeMetric(node, detail) {
  if (!detail) return null
  switch (node) {
    case 'guard':
      return detail.allowed ? 'input allowed' : 'injection blocked'
    case 'rewrite':
      if (detail.degraded) return 'LLM offline · raw query'
      return detail.rewritten ? 'query rewritten' : 'used as-is'
    case 'retrieve':
      return `${String(detail.count)} candidates`
    case 'grade': {
      const g = detail
      return g.decision === 'grounded' ? `kept ${g.kept} · best ${g.best?.toFixed(2)}` : `best ${g.best?.toFixed(2)} < ${g.threshold}`
    }
    case 'generate':
    case 'general': {
      const g = detail
      if (g.degraded) return 'static reply'
      return g.words !== undefined ? `${g.words} words · TTFT ${Math.round(g.ttft_ms ?? 0)} ms` : null
    }
    default:
      return null
  }
}
