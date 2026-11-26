/**
 * The featured products as an index, not a card grid: big typographic rows (number, name, the problem it solves).
 * On a desktop, a preview card with the outcome follows the cursor over the list and the other rows dim; on touch
 * screens and in lite mode the outcome sits inside each row instead. The preview moves with transforms only (one
 * requestAnimationFrame loop, only while the pointer is over the list), so it stays smooth on modest laptops.
 */
import { ArrowUpRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from '@appcore/web/router'
import { LITE } from '../lib/lite'
import { productHref } from './products'
import { StatusBadge } from './StatusBadge'

const canFollow = () => !LITE && typeof window !== 'undefined' && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches

export function ProductIndex({ products, online }) {
  const [active, setActive] = useState(null) // index of the hovered row
  const [follow] = useState(canFollow)
  const card = useRef(null)
  const target = useRef({ x: 0, y: 0 })
  const pos = useRef({ x: 0, y: 0 })

  // Ease the preview towards the pointer (a soft trail), only while a row is hovered.
  useEffect(() => {
    if (!follow || active === null) return
    let raf = 0
    const loop = () => {
      pos.current.x += (target.current.x - pos.current.x) * 0.18
      pos.current.y += (target.current.y - pos.current.y) * 0.18
      card.current?.style.setProperty('transform', `translate3d(${pos.current.x}px, ${pos.current.y}px, 0)`)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [follow, active])

  const onMove = (e) => {
    target.current = { x: e.clientX + 28, y: e.clientY - 120 }
    if (active === null) pos.current = { ...target.current } // appear at the pointer, then trail it
  }
  const shown = active === null ? null : products[active]

  return (
    <div className="relative" onPointerMove={follow ? onMove : undefined} onPointerLeave={() => setActive(null)}>
      <ol className="border-b border-white/[0.08] [&:hover>li]:opacity-45 [&>li:hover]:!opacity-100">
        {products.map((p, i) => {
          const Icon = p.icon
          return (
            <li key={p.slug} onPointerEnter={() => setActive(i)} className="group border-t border-white/[0.08] transition-opacity duration-300">
              <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 py-6 sm:gap-x-8 sm:py-8 md:grid-cols-[auto_minmax(0,1fr)_minmax(0,22rem)]">
                <span className="font-mono text-[12px] text-ink-500 tabular-nums sm:text-[13px]">{String(i + 1).padStart(2, '0')}</span>
                <Link to={p.app?.route ?? productHref(p)} className="min-w-0 outline-none focus-visible:underline">
                  <span className="flex items-center gap-3">
                    <span className="truncate text-[clamp(2.25rem,7vw,5.5rem)] leading-[0.95] font-semibold tracking-tight text-white transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] group-hover:translate-x-3">
                      {p.name}
                    </span>
                    <ArrowUpRight className="size-6 shrink-0 text-ink-500 opacity-0 transition duration-300 group-hover:translate-x-1 group-hover:text-white group-hover:opacity-100 sm:size-8" />
                  </span>
                </Link>
                <div className="col-start-2 mt-3 min-w-0 md:col-start-auto md:mt-0">
                  <p className="text-[15px] leading-snug text-ink-200 sm:text-[16px]">{p.problem}</p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-500">
                    <Icon className="size-3.5" /> {p.category} <StatusBadge status={p.status} />
                    {p.app && online === false && <span className="text-rose-300">backend offline</span>}
                  </p>
                  {!follow && <p className="mt-3 text-[14px] leading-relaxed text-ink-300">{p.outcome}</p>}
                  <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                    {p.app && (
                      <Link to={p.app.route} className="font-semibold text-white underline-offset-4 hover:underline">
                        Try {p.name} →
                      </Link>
                    )}
                    <Link to={productHref(p)} className="text-ink-400 underline-offset-4 hover:text-white hover:underline">How it works</Link>
                  </p>
                </div>
              </div>
            </li>
          )
        })}
      </ol>

      {follow && (
        <div ref={card} aria-hidden className="pointer-events-none fixed top-0 left-0 z-30 w-72 will-change-transform">
          <div className={`origin-top-left transition duration-300 ease-out ${shown ? 'scale-100 opacity-100' : 'scale-90 opacity-0'}`}>
            {shown && <Preview p={shown} />}
          </div>
        </div>
      )}
    </div>
  )
}

function Preview({ p }) {
  const Icon = p.icon
  return (
    <div className="overflow-hidden rounded-3xl border border-white/10 bg-ink-900 shadow-2xl shadow-black/40">
      <div className={`relative grid h-36 place-items-center bg-gradient-to-br ${p.accent}`}>
        <Icon className="size-14 text-on-accent drop-shadow-lg" strokeWidth={1.5} />
        <span className="absolute bottom-3 left-4 text-[12px] font-semibold tracking-wide text-on-accent/90 uppercase">{p.category}</span>
      </div>
      <div className="p-4">
        <p className="text-[13.5px] leading-relaxed text-ink-200">{p.outcome}</p>
        <p className="mt-3 text-[12.5px] font-semibold text-white">Click to try {p.name} →</p>
      </div>
    </div>
  )
}
