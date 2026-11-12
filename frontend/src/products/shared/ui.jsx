import { AlertTriangle, LayoutGrid, LoaderCircle } from 'lucide-react'
import { motion, MotionConfig } from 'motion/react'
import { useId } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Backdrop } from '../../components/shell/Backdrop'
import { Link } from '../../router'
import { ThemeToggle } from '../../theme/ThemeToggle'

/** Common frame for every product: back to the hub, brand, tabs, theme. */
export function ProductShell({
  name,
  tagline,
  icon: Icon,
  accent,
  right,
  children,
}) {
  return (
    <MotionConfig reducedMotion="user">
      <Backdrop />
      <div className="flex min-h-full flex-col">
        <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-ink-950/70 backdrop-blur-xl">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
            <Link
              to="/"
              aria-label="All products"
              className="flex h-8 items-center gap-1.5 rounded-lg border border-white/[0.06] px-2 text-[12px] text-ink-300 transition hover:border-white/15 hover:text-white"
            >
              <LayoutGrid className="size-4" />
              <span className="hidden md:inline">Products</span>
            </Link>
            <span className={`grid size-8 place-items-center rounded-xl bg-gradient-to-br ${accent} text-on-accent shadow-lg`}>
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 leading-tight">
              <p className="text-[15px] font-semibold tracking-tight text-white">{name}</p>
              <p className="hidden truncate text-[11px] text-ink-400 sm:block">{tagline}</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {right}
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 lg:py-8">{children}</main>
      </div>
    </MotionConfig>
  )
}

export function Tabs({
  tabs,
  value,
  onChange,
}) {
  const pill = useId()
  return (
    <nav className="-mx-4 mb-5 overflow-x-auto px-4 [scrollbar-width:none]">
      <div className="inline-flex gap-0.5 rounded-xl border border-white/[0.06] bg-ink-900/60 p-1">
        {tabs.map(({ id, label, icon: Icon, badge }) => (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={value === id}
            className={`relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium whitespace-nowrap transition-colors ${
              value === id ? 'text-white' : 'text-ink-400 hover:text-ink-200'
            }`}
          >
            {value === id && (
              <motion.span
                layoutId={pill}
                className="absolute inset-0 rounded-lg bg-white/[0.08] ring-1 ring-white/10"
                transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
              />
            )}
            {Icon && <Icon className="relative size-3.5" />}
            <span className="relative">{label}</span>
            {!!badge && <span className="relative rounded-full bg-white/10 px-1.5 text-[10px] tabular-nums">{badge}</span>}
          </button>
        ))}
      </div>
    </nav>
  )
}

export function Card({ children, className = '' }) {
  return <section className={`rounded-2xl border border-white/[0.07] bg-ink-900/60 p-4 sm:p-5 ${className}`}>{children}</section>
}

export function Button({
  children,
  onClick,
  disabled,
  busy,
  variant = 'primary',
  accent = 'from-indigo-500 to-cyan-500',
  type = 'button',
  className = '',
}) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-[13px] font-semibold transition disabled:opacity-50'
  const look =
    variant === 'primary'
      ? `bg-gradient-to-r ${accent} text-on-accent shadow-lg shadow-black/20 hover:brightness-110 active:scale-[0.98]`
      : 'border border-white/10 bg-white/[0.03] text-ink-200 hover:border-white/20 hover:text-white'
  return (
    <button type={type} onClick={onClick} disabled={disabled || busy} className={`${base} ${look} ${className}`}>
      {busy && <LoaderCircle className="size-4 animate-spin" />}
      {children}
    </button>
  )
}

export function Field({
  label,
  hint,
  children,
}) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium text-ink-300">{label}</span>
      {hint && <span className="ml-2 text-[11px] text-ink-500">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  )
}

export const inputClass =
  'w-full rounded-xl border border-white/10 bg-ink-950/50 px-3 py-2.5 text-[14px] text-white outline-none transition placeholder:text-ink-500 focus:border-brand-400/60'

export function ErrorNote({ message, items = [] }) {
  if (!message) return null
  return (
    <div role="alert" className="flex gap-2.5 rounded-xl border border-rose-400/20 bg-rose-500/[0.08] px-3.5 py-2.5 text-[13px] text-rose-200">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div>
        <p>{message}</p>
        {items.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px] text-rose-300">
            {items.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export function Empty({ icon: Icon, title, text, children }) {
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-white/10 px-6 py-12 text-center">
      <Icon className="size-7 text-ink-500" />
      <p className="mt-3 text-[15px] font-medium text-white">{title}</p>
      <p className="mt-1 max-w-md text-[13px] text-ink-400">{text}</p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  )
}

/** Live progress list for streamed pipelines (index, plan, run…). */
export function Steps({ steps, active }) {
  return (
    <ol className="space-y-2">
      {steps.map((s, i) => (
        <motion.li
          key={s.name}
          initial={{ opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          className="flex items-start gap-2.5 text-[13px]"
        >
          <span
            className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
              s.done ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/[0.06] text-ink-300'
            }`}
          >
            {s.done ? '✓' : active && i === steps.length - 1 ? <LoaderCircle className="size-3 animate-spin" /> : i + 1}
          </span>
          <span>
            <span className="font-medium text-white capitalize">{s.name}</span>
            {s.detail && <span className="ml-2 text-ink-400">{s.detail}</span>}
          </span>
        </motion.li>
      ))}
    </ol>
  )
}

/** Markdown with `[n]` citations turned into clickable chips. */
export function Answer({ text, onCite }) {
  const withLinks = text.replace(/\[(\d{1,2})\]/g, (_, n) => `[${n}](#cite-${n})`)
  return (
    <div className="prose-answer text-[14.5px] text-ink-100">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const n = href?.startsWith('#cite-') ? Number(href.slice(6)) : null
            if (n == null) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
            return (
              <button
                type="button"
                onClick={() => onCite?.(n)}
                className="cite mx-0.5 inline-grid h-4.5 min-w-4.5 place-items-center rounded-md bg-brand-500/15 px-1 align-[1px] font-mono text-[10.5px] text-indigo-200 ring-1 ring-brand-400/25 hover:bg-brand-500/30"
              >
                {n}
              </button>
            )
          },
        }}
      >
        {withLinks}
      </ReactMarkdown>
    </div>
  )
}

export function Pill({ children, tone = 'neutral' }) {
  const t = {
    good: 'text-emerald-300 bg-emerald-500/10 ring-emerald-400/20',
    warn: 'text-amber-300 bg-amber-500/10 ring-amber-400/20',
    bad: 'text-rose-300 bg-rose-500/10 ring-rose-400/20',
    info: 'text-sky-300 bg-sky-500/10 ring-sky-400/20',
    neutral: 'text-ink-300 bg-white/[0.04] ring-white/10',
  }[tone]
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${t}`}>{children}</span>
}

export function Spinner({ label }) {
  return (
    <p className="flex items-center gap-2 text-[13px] text-ink-400">
      <LoaderCircle className="size-4 animate-spin" /> {label}
    </p>
  )
}
