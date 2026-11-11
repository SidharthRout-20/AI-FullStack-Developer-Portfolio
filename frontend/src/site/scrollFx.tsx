/**
 * Scroll-driven motion primitives for the portfolio page.
 *
 * Every effect is decorative: content is fully readable without it, and with `prefers-reduced-motion`
 * the scroll-linked transforms are skipped (MotionConfig only covers `animate`/`whileInView`, not values
 * bound through `style`, so each component checks `useReducedMotion()` itself).
 */
import Lenis from 'lenis'
import {
  animate,
  motion,
  useAnimationFrame,
  useInView,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  useVelocity,
  type MotionValue,
} from 'motion/react'
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'

const EASE = [0.2, 0.8, 0.2, 1] as const

// ── Smooth (inertial) scrolling ────────────────────────────────────────────
/** Lenis smooth scrolling for mouse/trackpad users. Touch devices keep native momentum scrolling. */
export function useSmoothScroll() {
  const reduce = useReducedMotion()
  useEffect(() => {
    if (reduce || !window.matchMedia('(pointer: fine)').matches) return
    const lenis = new Lenis({ duration: 1.1, autoRaf: true, anchors: true, allowNestedScroll: true })
    return () => lenis.destroy()
  }, [reduce])
}

// ── Page-level chrome ──────────────────────────────────────────────────────
/** Thin gradient bar at the very top that fills as you read down the page. */
export function ScrollProgressBar() {
  const { scrollYProgress } = useScroll()
  const scaleX = useSpring(scrollYProgress, { stiffness: 140, damping: 30, restDelta: 0.001 })
  return (
    <motion.div
      aria-hidden
      style={{ scaleX }}
      className="fixed inset-x-0 top-0 z-50 h-[2px] origin-left bg-gradient-to-r from-indigo-500 via-cyan-400 to-emerald-400"
    />
  )
}

/** Circular "back to top" button whose ring traces scroll progress; appears after the hero. */
export function BackToTop() {
  const { scrollY, scrollYProgress } = useScroll()
  const [show, setShow] = useState(false)
  useEffect(() => scrollY.on('change', (y) => setShow(y > 640)), [scrollY])
  const dash = useTransform(scrollYProgress, (p) => `${p * 100} 100`)
  return (
    <motion.button
      type="button"
      aria-label="Back to top"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      initial={false}
      animate={show ? { opacity: 1, scale: 1, y: 0 } : { opacity: 0, scale: 0.6, y: 16 }}
      transition={{ type: 'spring', stiffness: 320, damping: 24 }}
      style={{ pointerEvents: show ? 'auto' : 'none' }}
      className="glass fixed right-5 bottom-5 z-40 grid size-12 place-items-center rounded-full text-ink-100 transition-colors hover:text-white"
    >
      <svg viewBox="0 0 36 36" className="absolute inset-0 size-full -rotate-90" aria-hidden>
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--hairline)" strokeWidth="2" />
        <motion.circle
          cx="18"
          cy="18"
          r="15.9"
          fill="none"
          stroke="url(#btt-grad)"
          strokeWidth="2"
          strokeLinecap="round"
          pathLength={100}
          style={{ strokeDasharray: dash }}
        />
        <defs>
          <linearGradient id="btt-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#818cf8" />
            <stop offset="100%" stopColor="#22d3ee" />
          </linearGradient>
        </defs>
      </svg>
      <svg viewBox="0 0 24 24" className="relative size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <path d="M12 19V5M5 12l7-7 7 7" />
      </svg>
    </motion.button>
  )
}

/** Soft glow that trails the cursor across the page (fine pointers only). */
export function CursorGlow() {
  const reduce = useReducedMotion()
  const x = useMotionValue(-600)
  const y = useMotionValue(-600)
  const sx = useSpring(x, { stiffness: 90, damping: 22, mass: 0.6 })
  const sy = useSpring(y, { stiffness: 90, damping: 22, mass: 0.6 })
  const [finePointer] = useState(() => window.matchMedia('(pointer: fine)').matches)
  const enabled = finePointer && !reduce
  useEffect(() => {
    if (!enabled) return
    const move = (e: PointerEvent) => {
      x.set(e.clientX)
      y.set(e.clientY)
    }
    window.addEventListener('pointermove', move, { passive: true })
    return () => window.removeEventListener('pointermove', move)
  }, [enabled, x, y])
  if (!enabled) return null
  return (
    <motion.div
      aria-hidden
      style={{ x: sx, y: sy }}
      className="cursor-glow pointer-events-none fixed top-0 left-0 -z-[5]size-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full"
    />
  )
}

// ── Reveals ────────────────────────────────────────────────────────────────
type From = 'up' | 'left' | 'right' | 'scale'
const OFFSET: Record<From, { x?: number; y?: number; scale?: number }> = {
  up: { y: 36 },
  left: { x: -56 },
  right: { x: 56 },
  scale: { scale: 0.92, y: 24 },
}

/** Fades content in (with a slight blur and slide) the first time it scrolls into view. */
export function Reveal({
  children,
  delay = 0,
  from = 'up',
  className = '',
}: {
  children: ReactNode
  delay?: number
  from?: From
  className?: string
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, filter: 'blur(8px)', ...OFFSET[from] }}
      whileInView={{ opacity: 1, filter: 'blur(0px)', x: 0, y: 0, scale: 1 }}
      viewport={{ once: true, margin: '-70px' }}
      transition={{ duration: 0.8, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  )
}

/** Headline that rises in word by word from behind a mask. */
export function RevealWords({ text, className = '', delay = 0 }: { text: string; className?: string; delay?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, margin: '-60px' })
  return (
    <span ref={ref} className={className} aria-label={text}>
      {text.split(' ').map((word, i) => (
        <span key={i} aria-hidden className="inline-block overflow-hidden pb-[0.12em] align-top">
          <motion.span
            className="inline-block"
            initial={{ y: '110%', rotate: 4 }}
            animate={inView ? { y: '0%', rotate: 0 } : undefined}
            transition={{ duration: 0.75, delay: delay + i * 0.06, ease: EASE }}
          >
            {word}
            {' '}
          </motion.span>
        </span>
      ))}
    </span>
  )
}

// ── Scroll-linked motion ───────────────────────────────────────────────────
/** Moves its content at a different speed from the page (positive `speed` = lags behind). */
export function Parallax({ children, speed = 60, className = '' }: { children: ReactNode; speed?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] })
  const y = useTransform(scrollYProgress, [0, 1], [speed, -speed])
  return (
    <motion.div ref={ref} style={reduce ? undefined : { y }} className={className}>
      {children}
    </motion.div>
  )
}

/** A card that rises and un-tilts as it scrolls into place; `index` staggers siblings. */
export function ScrollRise({ children, index = 0, className = '' }: { children: ReactNode; index?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'start 55%'] })
  const p = useSpring(scrollYProgress, { stiffness: 110, damping: 26, restDelta: 0.001 })
  const lag = index * 0.12
  const y = useTransform(p, [0, 1], [110 + index * 40, 0])
  const rotateX = useTransform(p, [0, 1], [18, 0])
  const opacity = useTransform(p, [0, 0.35 + lag, 1], [0, 0.6, 1])
  const scale = useTransform(p, [0, 1], [0.9, 1])
  return (
    <div ref={ref} className={`[perspective:1200px] ${className}`}>
      <motion.div style={reduce ? undefined : { y, rotateX, opacity, scale, transformOrigin: '50% 100%' }} className="h-full">
        {children}
      </motion.div>
    </div>
  )
}

/** Oversized outline text that slides sideways as the page scrolls (two rows, opposite directions). */
export function ScrollTextBand({ rows }: { rows: [string, string] }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] })
  const a = useTransform(scrollYProgress, [0, 1], ['0%', '-28%'])
  const b = useTransform(scrollYProgress, [0, 1], ['-28%', '0%'])
  return (
    <div ref={ref} aria-hidden className="pointer-events-none relative overflow-hidden py-10 select-none sm:py-14">
      <BandRow text={rows[0]} x={reduce ? undefined : a} className="text-outline" />
      <BandRow text={rows[1]} x={reduce ? undefined : b} className="text-gradient" />
    </div>
  )
}

function BandRow({ text, x, className }: { text: string; x?: MotionValue<string>; className: string }) {
  const repeated = Array.from({ length: 4 }, () => text).join('  ·  ')
  return (
    <motion.p
      style={x ? { x } : undefined}
      // w-max: the row must be as wide as its text, or background-clipped gradient text vanishes past the viewport
      className={`w-max text-[clamp(2.75rem,9vw,7.5rem)] leading-[1.05] font-semibold tracking-tighter whitespace-nowrap ${className}`}
    >
      {repeated}
    </motion.p>
  )
}

/** Horizontal marquee whose speed (and direction) follows scroll velocity. */
export function VelocityMarquee({ children, baseVelocity = -2.2 }: { children: ReactNode; baseVelocity?: number }) {
  const reduce = useReducedMotion()
  const base = useMotionValue(0)
  const { scrollY } = useScroll()
  const velocity = useSpring(useVelocity(scrollY), { damping: 50, stiffness: 400 })
  const factor = useTransform(velocity, [-1000, 0, 1000], [-4, 0, 4], { clamp: false })
  const direction = useRef(1)
  const hovering = useRef(false)
  // Two identical halves → wrapping at -50% is seamless.
  const x = useMotionTemplate`${useTransform(base, (v) => ((((v % 50) + 50) % 50) - 50).toFixed(3))}%`

  useAnimationFrame((_, delta) => {
    if (reduce || hovering.current) return
    let move = direction.current * baseVelocity * (delta / 1000)
    const f = factor.get()
    if (f < 0) direction.current = -1
    else if (f > 0) direction.current = 1
    move += direction.current * move * Math.abs(f)
    base.set(base.get() + move)
  })

  return (
    <div
      className="overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_12%,black_88%,transparent)]"
      onMouseEnter={() => (hovering.current = true)}
      onMouseLeave={() => (hovering.current = false)}
    >
      <motion.div style={{ x }} className="flex w-max gap-2.5">
        {children}
        {children}
      </motion.div>
    </div>
  )
}

// ── Small interactions ─────────────────────────────────────────────────────
/** 3D tilt toward the cursor, plus the existing spotlight glow (sets --x/--y). */
export function TiltCard({ children, className = '', max = 7 }: { children: ReactNode; className?: string; max?: number }) {
  const reduce = useReducedMotion()
  const rx = useMotionValue(0)
  const ry = useMotionValue(0)
  const rotateX = useSpring(rx, { stiffness: 220, damping: 20 })
  const rotateY = useSpring(ry, { stiffness: 220, damping: 20 })

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width
    const py = (e.clientY - r.top) / r.height
    e.currentTarget.style.setProperty('--x', `${e.clientX - r.left}px`)
    e.currentTarget.style.setProperty('--y', `${e.clientY - r.top}px`)
    if (reduce) return
    rx.set((0.5 - py) * max * 2)
    ry.set((px - 0.5) * max * 2)
  }
  const reset = () => {
    rx.set(0)
    ry.set(0)
  }
  return (
    <div className={`h-full [perspective:1000px] ${className}`}>
      <motion.div onMouseMove={onMove} onMouseLeave={reset} style={{ rotateX, rotateY, transformStyle: 'preserve-3d' }} className="h-full">
        {children}
      </motion.div>
    </div>
  )
}

/** Animates the numeric part of a value like "5+" from 0 when it scrolls into view. */
export function CountUp({ value }: { value: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true })
  const reduce = useReducedMotion()
  const match = value.match(/^(\d+)(.*)$/)
  const target = match ? Number(match[1]) : 0
  const numeric = match !== null
  const [n, setN] = useState(reduce || !numeric ? target : 0)
  useEffect(() => {
    if (!inView || reduce || !numeric) return
    const controls = animate(0, target, { duration: 1.4, ease: EASE, onUpdate: (v) => setN(Math.round(v)) })
    return () => controls.stop()
  }, [inView, reduce, numeric, target])
  if (!match) return <span>{value}</span>
  return (
    <span ref={ref} className="tabular-nums">
      {n}
      {match[2]}
    </span>
  )
}

/** Small "scroll" cue under the hero. */
export function ScrollCue() {
  return (
    <a href="#expertise" aria-label="Scroll to content" className="group mx-auto mt-16 flex w-fit flex-col items-center gap-2 text-[11px] tracking-[0.2em] text-ink-500 uppercase hover:text-ink-300">
      <span className="flex h-9 w-5.5 justify-center rounded-full border border-white/15 pt-1.5">
        <motion.span
          className="h-2 w-1 rounded-full bg-cyan-300"
          animate={{ y: [0, 10, 0], opacity: [1, 0.2, 1] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
        />
      </span>
      Scroll
    </a>
  )
}
