import { STATUSES } from './products'

export const TONE = {
  good: 'bg-emerald-500/10 text-emerald-200 ring-emerald-400/25',
  info: 'bg-sky-500/10 text-sky-200 ring-sky-400/25',
  warn: 'bg-amber-500/10 text-amber-200 ring-amber-400/25',
  neutral: 'bg-white/[0.05] text-ink-200 ring-white/15',
}

export function StatusBadge({ status, className = '' }) {
  const s = STATUSES[status] ?? { label: status, tone: 'neutral' }
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase ring-1 ${TONE[s.tone]} ${className}`}>
      {s.label}
    </span>
  )
}
