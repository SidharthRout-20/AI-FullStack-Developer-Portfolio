/**
 * Tara's visual layer: a living orb, a voice-reactive ring, word-by-word replies, a cursor glow and drifting light.
 *
 * Built to stay smooth on modest laptops: everything animates only `transform` and `opacity` (no blur, no layout),
 * the one canvas draws a few dozen dots and sleeps when the tab is hidden, and the microphone level is written to a
 * single CSS variable per frame. Lite mode (low-powered devices, reduced motion) keeps the looks and drops the motion.
 */
import { useEffect, useRef } from 'react'
import { LITE } from '../../lib/lite'

const finePointer = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches

/**
 * The orb. `state`: idle | listening | thinking | speaking. `level` (0–1, a ref) drives the listening swell.
 * Layers: a rotating conic halo, three drifting colour lobes inside a glass sphere, a highlight, and a ring of bars.
 */
export function Orb({ state = 'idle', size = 176, levelRef, children }) {
  const el = useRef(null)
  // Write the microphone level to --lvl once per frame (no React re-render).
  useEffect(() => {
    const node = el.current
    if (LITE || state !== 'listening' || !levelRef || !node) return
    let raf = 0
    let smooth = 0
    const loop = () => {
      smooth += ((levelRef.current ?? 0) - smooth) * 0.25
      node.style.setProperty('--lvl', smooth.toFixed(3))
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      node.style.setProperty('--lvl', '0')
    }
  }, [state, levelRef])
  return (
    <span ref={el} data-state={state} className="tara-orb" style={{ '--size': `${size}px` }} aria-hidden={!children}>
      <span className="tara-halo" />
      <span className="tara-sphere">
        <span className="tara-lobe tara-lobe-a" />
        <span className="tara-lobe tara-lobe-b" />
        <span className="tara-lobe tara-lobe-c" />
        <span className="tara-gloss" />
      </span>
      <span className="tara-bars">
        {Array.from({ length: 36 }, (_, i) => (
          <i key={i} style={{ '--i': i }} />
        ))}
      </span>
      {children && <span className="tara-orb-content">{children}</span>}
    </span>
  )
}

/** The microphone's loudness (0–1) in a ref, while `on`: feeds the orb. Opens its own audio stream; closes it after. */
export function useMicLevel(on) {
  const level = useRef(0)
  useEffect(() => {
    if (!on || LITE || !navigator.mediaDevices?.getUserMedia) return
    let stream
    let ctx
    let raf = 0
    let alive = true
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop())
        stream = s
        ctx = new (window.AudioContext || window.webkitAudioContext)()
        const an = ctx.createAnalyser()
        an.fftSize = 256
        ctx.createMediaStreamSource(s).connect(an)
        const buf = new Uint8Array(an.fftSize)
        const loop = () => {
          an.getByteTimeDomainData(buf)
          let sum = 0
          for (const v of buf) sum += (v - 128) * (v - 128)
          level.current = Math.min(1, Math.sqrt(sum / buf.length) / 40)
          raf = requestAnimationFrame(loop)
        }
        loop()
      })
      .catch(() => {})
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
      level.current = 0
    }
  }, [on])
  return level
}

/** A soft light that follows the pointer across Tara's home (desktop only). */
export function CursorGlow() {
  const el = useRef(null)
  useEffect(() => {
    if (LITE || !finePointer()) return
    let raf = 0
    let x = window.innerWidth / 2
    let y = window.innerHeight / 3
    const move = (e) => {
      x = e.clientX
      y = e.clientY
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0
          el.current?.style.setProperty('transform', `translate3d(${x - 300}px, ${y - 300}px, 0)`)
        })
    }
    window.addEventListener('pointermove', move, { passive: true })
    return () => {
      window.removeEventListener('pointermove', move)
      cancelAnimationFrame(raf)
    }
  }, [])
  if (LITE) return null
  return <div ref={el} aria-hidden className="tara-cursor-glow" />
}

/** A few dozen slow motes of light behind Tara. Sleeps when the tab is hidden; off in lite mode. */
export function Motes({ count = 42 }) {
  const canvas = useRef(null)
  useEffect(() => {
    if (LITE) return
    const c = canvas.current
    const g = c?.getContext('2d')
    if (!g) return
    let w = 0
    let h = 0
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    const resize = () => {
      w = c.clientWidth
      h = c.clientHeight
      c.width = w * dpr
      c.height = h * dpr
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const dots = Array.from({ length: count }, () => ({
      x: Math.random() * w, y: Math.random() * h, r: 0.6 + Math.random() * 1.6,
      vx: (Math.random() - 0.5) * 0.12, vy: -0.05 - Math.random() * 0.18, a: 0.15 + Math.random() * 0.45, t: Math.random() * 6.28,
    }))  // prettier-ignore
    let raf = 0
    let last = 0
    const draw = (t) => {
      raf = requestAnimationFrame(draw)
      if (t - last < 33) return // ~30 fps is plenty for slow motes
      last = t
      g.clearRect(0, 0, w, h)
      for (const d of dots) {
        d.x += d.vx
        d.y += d.vy
        d.t += 0.02
        if (d.y < -4) (d.y = h + 4), (d.x = Math.random() * w)
        if (d.x < -4) d.x = w + 4
        if (d.x > w + 4) d.x = -4
        g.globalAlpha = d.a * (0.6 + 0.4 * Math.sin(d.t))
        g.beginPath()
        g.arc(d.x, d.y, d.r, 0, 6.283)
        g.fill()
      }
    }
    g.fillStyle = '#ffd9f0'
    const start = () => {
      cancelAnimationFrame(raf)
      if (document.visibilityState === 'visible') raf = requestAnimationFrame(draw)
    }
    start()
    document.addEventListener('visibilitychange', start)
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', start)
      window.removeEventListener('resize', resize)
    }
  }, [count])
  if (LITE) return null
  return <canvas ref={canvas} aria-hidden className="pointer-events-none fixed inset-0 -z-[5] h-full w-full" />
}

/** Text that arrives word by word, the way it would be spoken. Long replies reveal their first words only. */
export function Reveal({ text, className = '' }) {
  if (LITE) return <p className={className}>{text}</p>
  const words = text.split(/(\s+)/)
  let n = 0
  return (
    <p className={className} aria-label={text}>
      {words.map((w, i) =>
        /^\s+$/.test(w) ? (
          w
        ) : (
          <span key={i} aria-hidden className="tara-word" style={{ '--d': `${Math.min(n++, 60) * 28}ms` }}>
            {w}
          </span>
        ),
      )}
    </p>
  )
}
