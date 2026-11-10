/** Slow-moving aurora gradients + a fading grid. Purely decorative (aria-hidden, no pointer events). */
export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="aurora-blob aurora-a top-[-18vh] left-[-10vw] h-[55vh] w-[55vw] bg-indigo-600" />
      <div className="aurora-blob aurora-b top-[-10vh] right-[-15vw] h-[50vh] w-[45vw] bg-cyan-500/70" />
      <div className="aurora-blob aurora-c bottom-[-25vh] left-[30vw] h-[45vh] w-[40vw] bg-violet-700/70" />
      <div className="bg-grid absolute inset-0" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom,transparent_20%,var(--color-ink-950)_75%)]" />
    </div>
  )
}
