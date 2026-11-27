/**
 * Small motion helpers for the Studio page: reveal-on-scroll and count-up numbers.
 *
 * Every effect is decorative: content is fully readable without it, and with `prefers-reduced-motion`
 * the scroll-linked transforms are skipped (MotionConfig only covers `animate`/`whileInView`, not values
 * bound through `style`, so each component checks `useReducedMotion()` itself).
 */
import { animate, motion, useInView, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'

const EASE = [0.2, 0.8, 0.2, 1]

const OFFSET = {
  up: { y: 36 },
  left: { x: -56 },
  right: { x: 56 },
  scale: { scale: 0.92, y: 24 },
}

/** Fades and slides content in the first time it scrolls into view. */
export function Reveal({
  children,
  delay = 0,
  from = 'up',
  className = '',
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, ...OFFSET[from] }}
      whileInView={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      viewport={{ once: true, margin: '-70px' }}
      transition={{ duration: 0.6, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  )
}

/** Animates the numeric part of a value like "5+" from 0 when it scrolls into view. */
export function CountUp({ value }) {
  const ref = useRef(null)
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
