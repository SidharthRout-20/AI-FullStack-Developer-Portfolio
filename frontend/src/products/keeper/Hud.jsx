/**
 * A heads-up display around Tara's orb (personal space): rings of ticks turning at different speeds, an arc that
 * races while she thinks and swells while she listens, and four live read-outs (time, weather, what's due, status).
 * SVG turned by CSS transforms only, so it costs next to nothing to draw; still in lite mode.
 */
import { useEffect, useState } from 'react'

/** The time as HH:MM, updated on the minute. */
export function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let t = setTimeout(function tick() {
      setNow(new Date())
      t = setTimeout(tick, 60_000 - (Date.now() % 60_000))
    }, 60_000 - (Date.now() % 60_000))
    return () => clearTimeout(t)
  }, [])
  return now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function Hud({ state = 'idle', size = 300, readouts = [], children }) {
  return (
    <span className="tara-hud" data-state={state} style={{ '--hud': `min(${size}px, 66vw)` }}>
      <svg viewBox="0 0 200 200" className="tara-hud-svg" aria-hidden>
        <g className="tara-hud-r1">
          <circle cx="100" cy="100" r="96" fill="none" strokeWidth="4" strokeDasharray="0.7 7.68" />
          <circle cx="100" cy="100" r="96" fill="none" strokeWidth="7" strokeDasharray="1.2 49.07" className="tara-hud-major" />
        </g>
        <g className="tara-hud-r2">
          <circle cx="100" cy="100" r="87" fill="none" strokeWidth="0.8" strokeDasharray="22 6 3 6" />
        </g>
        <g className="tara-hud-r3">
          <path d="M 100 22 A 78 78 0 0 1 178 100" fill="none" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M 100 178 A 78 78 0 0 1 22 100" fill="none" strokeWidth="1.2" strokeLinecap="round" className="tara-hud-faint" />
        </g>
        <circle cx="100" cy="100" r="70" fill="none" strokeWidth="0.6" className="tara-hud-faint" />
      </svg>
      <span className="tara-hud-core">{children}</span>
      {readouts.slice(0, 4).map((r, i) => (
        <span key={r.label} className={`tara-hud-read tara-hud-read-${i}`}>
          <b>{r.value}</b>
          <i>{r.label}</i>
        </span>
      ))}
    </span>
  )
}
