import { ArrowLeft, ArrowUpRight, CheckCircle2, Hammer } from 'lucide-react'
import { motion } from 'motion/react'
import { Link } from '../router'
import { SiteHeader } from './HubPage'
import type { Product } from './products'

/** Preview page for products that are still in development. */
export function ProductPage({ product: p }: { product: Product }) {
  const Icon = p.icon
  return (
    <div className="min-h-full">
      <SiteHeader />
      <main className="mx-auto max-w-4xl px-5 pt-26 pb-14 sm:pt-30">
        <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] text-ink-400 transition hover:text-white">
          <ArrowLeft className="size-4" /> All products
        </Link>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mt-6 flex items-start gap-5">
          <span className={`grid size-16 shrink-0 place-items-center rounded-2xl bg-gradient-to-br ${p.accent} text-on-accent shadow-2xl`}>
            <Icon className="size-8" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">{p.name}</h1>
              <span className="flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-amber-200 uppercase ring-1 ring-amber-400/25">
                <Hammer className="size-3" /> In development
              </span>
            </div>
            <p className="mt-1 text-[16px] text-ink-200">{p.tagline}</p>
          </div>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="mt-6 text-[15px] leading-relaxed text-ink-300"
        >
          {p.description}
        </motion.p>

        <h2 className="mt-10 text-[12px] font-semibold tracking-[0.18em] text-cyan-300 uppercase">Planned capabilities</h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {p.features.map((f, i) => (
            <motion.li
              key={f.title}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 + i * 0.05 }}
              className="glass rounded-2xl p-4"
            >
              <p className="flex items-center gap-2 text-[14px] font-semibold text-white">
                <CheckCircle2 className="size-4 text-emerald-300" /> {f.title}
              </p>
              <p className="mt-1 text-[13px] text-ink-300">{f.text}</p>
            </motion.li>
          ))}
        </ul>

        <h2 className="mt-10 text-[12px] font-semibold tracking-[0.18em] text-cyan-300 uppercase">Planned stack</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          {p.stack.map((s) => (
            <span key={s} className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 font-mono text-[12px] text-ink-200">
              {s}
            </span>
          ))}
        </div>

        <div className="glass mt-12 flex flex-col items-start gap-4 rounded-2xl p-6 sm:flex-row sm:items-center">
          <div className="flex-1">
            <p className="text-[15px] font-semibold text-white">Want to see the platform it builds on?</p>
            <p className="text-[13.5px] text-ink-300">
              DocuMind is live and shares the same pipeline, streaming and design-system foundations.
            </p>
          </div>
          <Link
            to="/documind"
            className="flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-[13.5px] font-semibold text-ink-950 transition hover:bg-ink-100"
          >
            Launch DocuMind <ArrowUpRight className="size-4" />
          </Link>
        </div>
      </main>
    </div>
  )
}
