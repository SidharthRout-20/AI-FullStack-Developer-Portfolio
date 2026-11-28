/**
 * The sky behind Tara in the personal space: it follows the real weather where you are (or your home city) and the
 * time of day. Clear days get a sun glow, nights get stars and a moon, clouds drift, rain falls, snow floats, fog
 * rolls in, and a storm flickers with lightning.
 *
 * Cheap to draw: gradients and drifting clouds are CSS (transform and opacity only), and one canvas draws the rain,
 * snow or stars at about 30 frames a second, sleeping while the tab is hidden. Lite mode (reduced motion, slow
 * devices) keeps the colours and drops the motion.
 */
import { useEffect, useRef, useState } from 'react'
import { LITE } from '../../lib/lite'
import { dayPhase } from '../../theme/skin'

/** WMO weather code → the scene to draw. */
export function sceneOf(code) {
  if (code == null) return 'clear'
  if (code <= 1) return 'clear'
  if (code <= 3) return 'cloudy'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 57) return 'drizzle'
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain'
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow'
  if (code >= 95) return 'storm'
  return 'cloudy'
}

const CLOUDS = { clear: 1, cloudy: 4, fog: 2, drizzle: 4, rain: 5, snow: 4, storm: 5 }
const PARTICLES = { drizzle: 70, rain: 150, storm: 220, snow: 90 }

/** The phase of the day, re-checked every few minutes. */
export function usePhase() {
  const [phase, setPhase] = useState(() => dayPhase(new Date().getHours()))
  useEffect(() => {
    const t = setInterval(() => setPhase(dayPhase(new Date().getHours())), 5 * 60_000)
    return () => clearInterval(t)
  }, [])
  return phase
}

export function Sky({ scene, phase }) {
  const stars = phase === 'night' && (scene === 'clear' || scene === 'cloudy')
  const sun = (scene === 'clear' || scene === 'cloudy') && phase !== 'night'
  const moon = phase === 'night' && scene !== 'storm' && scene !== 'rain'
  return (
    <div aria-hidden className="tara-sky" data-phase={phase} data-scene={scene}>
      <div className="tara-sky-tint" />
      {sun && <div className="tara-sun" />}
      {moon && <div className="tara-moon" />}
      {Array.from({ length: CLOUDS[scene] ?? 1 }, (_, i) => (
        <div key={i} className="tara-cloud" style={{ '--i': i, '--n': CLOUDS[scene] ?? 1 }} />
      ))}
      {scene === 'fog' && <><div className="tara-fog" /><div className="tara-fog tara-fog-b" /></>}
      {scene === 'storm' && <Lightning />}
      {!LITE && (stars || PARTICLES[scene]) && <Particles kind={PARTICLES[scene] ? (scene === 'snow' ? 'snow' : 'rain') : 'stars'} count={PARTICLES[scene] ?? 110} heavy={scene === 'storm'} />}
      {LITE && stars && <div className="tara-stars-static" />}
    </div>
  )
}

/** A flash every few seconds, at random, during a thunderstorm. */
function Lightning() {
  const el = useRef(null)
  useEffect(() => {
    if (LITE) return
    let t = 0
    const strike = () => {
      el.current?.animate([{ opacity: 0 }, { opacity: 0.55 }, { opacity: 0.1 }, { opacity: 0.4 }, { opacity: 0 }], { duration: 650, easing: 'ease-out' })
      t = setTimeout(strike, 5000 + Math.random() * 9000)
    }
    t = setTimeout(strike, 2500)
    return () => clearTimeout(t)
  }, [])
  return <div ref={el} className="tara-lightning" />
}

/** Rain streaks, snowflakes or twinkling stars on one canvas. */
function Particles({ kind, count, heavy }) {
  const canvas = useRef(null)
  useEffect(() => {
    const c = canvas.current
    const g = c?.getContext('2d')
    if (!g) return
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    let w = 0
    let h = 0
    const resize = () => {
      w = c.clientWidth
      h = c.clientHeight
      c.width = w * dpr
      c.height = h * dpr
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const light = document.documentElement.dataset.theme === 'light'
    const drops = Array.from({ length: count }, () => ({
      x: Math.random() * w, y: Math.random() * h, z: 0.4 + Math.random() * 0.6, t: Math.random() * 6.28,
    }))  // prettier-ignore
    const wind = heavy ? 2.6 : 1.2
    let raf = 0
    let last = 0
    const draw = (now) => {
      raf = requestAnimationFrame(draw)
      if (now - last < 33) return
      last = now
      g.clearRect(0, 0, w, h)
      if (kind === 'rain') {
        g.strokeStyle = light ? 'rgba(40,70,110,0.35)' : 'rgba(190,215,255,0.38)'
        g.lineWidth = 1
        g.beginPath()
        for (const d of drops) {
          const len = 10 + 16 * d.z
          d.y += (heavy ? 22 : 16) * d.z
          d.x += wind * d.z
          if (d.y > h + 20) (d.y = -20), (d.x = Math.random() * (w + 100) - 50)
          g.moveTo(d.x, d.y)
          g.lineTo(d.x - wind * 1.6, d.y - len)
        }
        g.stroke()
      } else if (kind === 'snow') {
        g.fillStyle = light ? 'rgba(120,140,170,0.6)' : 'rgba(255,255,255,0.75)'
        for (const d of drops) {
          d.t += 0.02
          d.y += 0.6 + 1.1 * d.z
          d.x += Math.sin(d.t) * 0.6
          if (d.y > h + 6) (d.y = -6), (d.x = Math.random() * w)
          g.globalAlpha = 0.4 + 0.6 * d.z
          g.beginPath()
          g.arc(d.x, d.y, 1 + 2.2 * d.z, 0, 6.283)
          g.fill()
        }
        g.globalAlpha = 1
      } else {
        g.fillStyle = '#ffffff'
        for (const d of drops) {
          if (d.y > h * 0.7) continue // stars sit in the upper sky
          d.t += 0.015 + d.z * 0.02
          g.globalAlpha = (0.25 + 0.75 * d.z) * (0.55 + 0.45 * Math.sin(d.t))
          g.beginPath()
          g.arc(d.x, d.y, 0.5 + d.z * 1.1, 0, 6.283)
          g.fill()
        }
        g.globalAlpha = 1
      }
    }
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
  }, [kind, count, heavy])
  return <canvas ref={canvas} className="tara-sky-canvas" />
}
