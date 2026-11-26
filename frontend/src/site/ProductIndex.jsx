/**
 * The featured products as a bento of large media tiles, after bradleyziffer.com: real screenshots in rounded tiles
 * that alternate narrow/wide (40/60, then 60/40), each with its name set big over the image and the problem it
 * solves. Hovering presses the tile in slightly, eases the screenshot forward and slides up the outcome; on desktops
 * a round "try it" badge in the product's colours, with its label spinning around it, trails the cursor.
 *
 * Smooth on modest laptops: only transform and opacity change, the badge follows in one requestAnimationFrame loop that
 * runs only while the pointer is over a tile, and images load lazily. Lite mode and touch screens skip the badge.
 */
import { ArrowUpRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from '@appcore/web/router'
import { LITE } from '../lib/lite'
import { productHref } from './products'
import { StatusBadge } from './StatusBadge'

const SHOTS = new Set(['safarnaama', 'codelens', 'tara', 'jasoos'])
const shotOf = (p) => (SHOTS.has(p.slug) ? `/projects/${p.slug}.webp` : null)
// 5-column grid: narrow (2) + wide (3), then wide + narrow.
const SPAN = ['md:col-span-2', 'md:col-span-3', 'md:col-span-3', 'md:col-span-2']
const canFollow = () => !LITE && typeof window !== 'undefined' && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches

export function ProductIndex({ products, online }) {
  const [active, setActive] = useState(null)
  const [follow] = useState(canFollow)
  const badge = useRef(null)
  const target = useRef({ x: 0, y: 0 })
  const pos = useRef({ x: 0, y: 0 })

  useEffect(() => {
    if (!follow || active === null) return
    let raf = 0
    const loop = () => {
      pos.current.x += (target.current.x - pos.current.x) * 0.2
      pos.current.y += (target.current.y - pos.current.y) * 0.2
      badge.current?.style.setProperty('transform', `translate3d(${pos.current.x - 48}px, ${pos.current.y - 48}px, 0)`)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [follow, active])

  const onMove = (e) => {
    target.current = { x: e.clientX + 36, y: e.clientY + 36 } // beside the pointer, never under it
    if (active === null) pos.current = { ...target.current }
  }
  const shown = active === null ? null : products[active]

  return (
    <div onPointerMove={follow ? onMove : undefined}>
      <ul className="grid gap-4 md:grid-cols-5 md:gap-5">
        {products.map((p, i) => (
          <Tile key={p.slug} p={p} i={i} online={online} span={SPAN[i % 4]} onEnter={() => setActive(i)} onLeave={() => setActive(null)} />
        ))}
      </ul>

      {follow && (
        <div ref={badge} aria-hidden className="pointer-events-none fixed top-0 left-0 z-40 will-change-transform">
          <div className={`transition duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] ${shown ? 'scale-100 opacity-100' : 'scale-0 opacity-0'}`}>
            <div className={`relative grid size-24 place-items-center rounded-full bg-gradient-to-br ${shown?.accent ?? ''} text-on-accent shadow-2xl shadow-black/40`}>
              <svg viewBox="0 0 100 100" className="cursor-ring absolute inset-0 size-full">
                <defs>
                  <path id="ring" d="M50,50 m-37,0 a37,37 0 1,1 74,0 a37,37 0 1,1 -74,0" />
                </defs>
                <text className="fill-current text-[10.5px] font-semibold tracking-[0.2em] uppercase">
                  <textPath href="#ring">Try {shown?.name ?? ''} · Try it now ·</textPath>
                </text>
              </svg>
              <ArrowUpRight className="size-7" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Tile({ p, i, online, span, onEnter, onLeave }) {
  const Icon = p.icon
  const shot = shotOf(p)
  const route = p.app?.route ?? productHref(p)
  return (
    <li className={`min-w-0 ${span}`} onPointerEnter={onEnter} onPointerLeave={onLeave}>
      <article className="group relative isolate h-[23rem] overflow-hidden rounded-[22px] border border-white/[0.06] bg-ink-900 transition-transform duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[0.985] sm:h-[26rem]">
        {shot ? (
          <img src={shot} alt={`${p.name} screenshot`} loading="lazy" decoding="async"
            className="absolute inset-0 -z-10 size-full object-cover object-left-top opacity-75 transition-[transform,opacity] duration-[1400ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] group-hover:scale-[1.06] group-hover:opacity-100" />
        ) : (
          <div className={`absolute inset-0 -z-10 grid place-items-center bg-gradient-to-br ${p.accent}`}><Icon className="size-20 text-on-accent/80" strokeWidth={1.25} /></div>
        )}
        <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-t from-black via-black/60 via-45% to-black/10" />

        <div className="flex items-center gap-2 p-4 sm:p-5">
          <span className="grid size-9 place-items-center rounded-full bg-white/90 font-mono text-[12px] font-semibold text-black">{String(i + 1).padStart(2, '0')}</span>
          <span className={`inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r ${p.accent} px-2.5 py-1 text-[11.5px] font-semibold text-on-accent`}>
            <Icon className="size-3.5" /> {p.category}
          </span>
          <span className="ml-auto"><StatusBadge status={p.status} /></span>
        </div>

        <div className="absolute inset-x-0 bottom-0 p-5 sm:p-6">
          <h3 className="text-[clamp(2.1rem,4.4vw,3.6rem)] leading-[0.95] font-semibold tracking-tight text-white">{p.name}</h3>
          <p className="mt-2 max-w-xl text-[15px] leading-snug text-white/85">{p.problem}</p>
          <div className="grid grid-rows-[0fr] opacity-0 transition-all duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] group-focus-within:grid-rows-[1fr] group-focus-within:opacity-100 group-hover:grid-rows-[1fr] group-hover:opacity-100 max-md:grid-rows-[1fr] max-md:opacity-100">
            <p className="overflow-hidden text-[13.5px] leading-relaxed text-white/70"><span className="block pt-2">{p.outcome}</span></p>
          </div>
          <p className="relative z-10 mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
            <span className="font-semibold text-white">Try {p.name} →</span>
            <Link to={productHref(p)} className="text-white/60 underline-offset-4 hover:text-white hover:underline">How it works</Link>
            {p.app && online === false && <span className="text-rose-300">backend offline</span>}
          </p>
        </div>
        {/* The whole tile opens the product; "How it works" sits above this link. */}
        <Link to={route} aria-label={`Try ${p.name}`} className="absolute inset-0 rounded-[22px] outline-none focus-visible:ring-4 focus-visible:ring-white/50" />
      </article>
    </li>
  )
}
