import { useEffect, useState } from 'react'
import { dayPhase, DAY_PHASES } from '../../theme/skin'

/**
 * Slow-moving aurora gradients + a fading grid. Purely decorative (aria-hidden, no pointer events).
 * In the personal space the light follows the visitor's time of day: warm at dawn, bright by day, amber and magenta
 * at dusk, deep blue at night. The showcase skin hides it entirely.
 */
export function Backdrop() {
  const [phase, setPhase] = useState(() => dayPhase(new Date().getHours()))
  useEffect(() => {
    const id = window.setInterval(() => setPhase(dayPhase(new Date().getHours())), 5 * 60_000)
    return () => window.clearInterval(id)
  }, [])
  const [a, b, c] = DAY_PHASES[phase].blobs
  return (
    <div aria-hidden data-phase={phase} className="backdrop-fx pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className={`aurora-blob aurora-a top-[-18vh] left-[-10vw] h-[55vh] w-[55vw] transition-colors duration-[3000ms] ${a}`} />
      <div className={`aurora-blob aurora-b top-[-10vh] right-[-15vw] h-[50vh] w-[45vw] transition-colors duration-[3000ms] ${b}`} />
      <div className={`aurora-blob aurora-c bottom-[-25vh] left-[30vw] h-[45vh] w-[40vw] transition-colors duration-[3000ms] ${c}`} />
      <div className="bg-grid absolute inset-0" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom,transparent_20%,var(--color-ink-950)_75%)]" />
    </div>
  )
}
