import { ArrowLeft, ArrowUpRight, CheckCircle2, CircleDashed } from 'lucide-react'
import { motion } from 'motion/react'
import { Link } from '../router'
import { SiteHeader } from './HubPage'
import { MODULE_STATUSES, STATUSES } from './products'
import { StatusBadge, TONE } from './StatusBadge'

function Section({ title, children }) {
  return (
    <>
      <h2 className="mt-10 text-[12px] font-semibold tracking-[0.18em] text-cyan-300 uppercase">{title}</h2>
      <div className="mt-4">{children}</div>
    </>
  )
}

/** Product page for an approved portfolio product: real status, what works today, what's planned, and its app. */
export function ProductPage({ product: p }) {
  const Icon = p.icon
  return (
    <div className="min-h-full">
      <SiteHeader />
      <main className="mx-auto max-w-4xl px-5 pt-26 pb-14 sm:pt-30">
        <Link to="/#projects" className="inline-flex items-center gap-1.5 text-[13px] text-ink-400 transition hover:text-white">
          <ArrowLeft className="size-4" /> All products
        </Link>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mt-6 flex items-start gap-5">
          <span className={`grid size-16 shrink-0 place-items-center rounded-2xl bg-gradient-to-br ${p.accent} text-on-accent shadow-2xl`}>
            <Icon className="size-8" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">{p.fullName ?? p.name}</h1>
              <StatusBadge status={p.status} />
            </div>
            <p className="mt-1 text-[16px] text-ink-200">{p.tagline}</p>
            <p className="mt-1 text-[12px] text-ink-500">
              {p.visibility === 'portfolio' ? `Portfolio priority ${p.priority}` : 'Labs'} · {p.category} · status last verified {p.lastVerified}
            </p>
          </div>
        </motion.div>

        <p className="mt-6 text-[15px] leading-relaxed text-ink-300">{p.description}</p>

        <div className="glass mt-6 rounded-2xl p-4 text-[13.5px] text-ink-200">
          <p className="font-semibold text-white">Why it is “{STATUSES[p.status]?.label ?? p.status}”</p>
          <p className="mt-1 text-ink-300">{p.statusNote}</p>
          {p.app && (
            <Link
              to={p.app.route}
              className="mt-3 inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-[13.5px] font-semibold text-ink-950 transition hover:bg-ink-100"
            >
              {p.app.label} <ArrowUpRight className="size-4" />
            </Link>
          )}
          {p.app?.kind === 'prototype' && (
            <p className="mt-2 text-[12px] text-ink-400">This is an earlier app the product builds on. It does not provide the workflow described above.</p>
          )}
        </div>

        {p.available?.length > 0 && (
          <Section title="Available today">
            <ul className="space-y-2">
              {p.available.map((t) => (
                <li key={t} className="flex gap-2 text-[14px] text-ink-200">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-300" /> {t}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {p.planned?.length > 0 && (
          <Section title="Planned">
            <ul className="space-y-2">
              {p.planned.map((t) => (
                <li key={t} className="flex gap-2 text-[14px] text-ink-300">
                  <CircleDashed className="mt-0.5 size-4 shrink-0 text-ink-500" /> {t}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {p.modules?.length > 0 && (
          <Section title="Ecosystem modules (all connected to the trip's itinerary)">
            <ul className="grid gap-3 sm:grid-cols-2">
              {p.modules.map((m) => {
                const s = MODULE_STATUSES[m.status]
                return (
                  <li key={m.id} className="glass rounded-2xl p-4">
                    <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-white">
                      {m.title}
                      <span className={`rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold uppercase ring-1 ${TONE[s.tone]}`}>{s.label}</span>
                    </p>
                    <p className="mt-1 text-[13px] text-ink-300">{m.text}</p>
                  </li>
                )
              })}
            </ul>
          </Section>
        )}

        {p.roadmap?.length > 0 && (
          <Section title="Roadmap">
            <ol className="space-y-3 border-l border-white/10 pl-4">
              {p.roadmap.map((r) => (
                <li key={r.stage}>
                  <p className="text-[14px] font-semibold text-white">
                    <span className="text-ink-400">{r.stage} · </span>
                    {r.title}
                  </p>
                  <p className="mt-0.5 text-[13px] text-ink-300">{r.text}</p>
                </li>
              ))}
            </ol>
          </Section>
        )}

        <Section title="Stack">
          <div className="flex flex-wrap gap-2">
            {p.stack.map((s) => (
              <span key={s} className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 font-mono text-[12px] text-ink-200">
                {s}
              </span>
            ))}
          </div>
        </Section>
      </main>
    </div>
  )
}
