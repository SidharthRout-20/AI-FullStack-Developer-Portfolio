/**
 * Loading placeholders shaped like what's coming, so the page doesn't jump when it arrives. The shimmer is a single
 * transform animation (cheap to draw) and stops in lite mode and for reduced motion.
 */
export function Bone({ className = '' }) {
  return <span aria-hidden className={`skeleton block rounded-xl ${className}`} />
}

/** A page-shaped placeholder: a header, a lead paragraph and a grid of cards. */
export function PageSkeleton({ label = 'Loading' }) {
  return (
    <div role="status" aria-label={label} className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <Bone className="h-3 w-24" />
      <Bone className="mt-4 h-9 w-3/4 max-w-xl" />
      <Bone className="mt-3 h-4 w-full max-w-2xl" />
      <Bone className="mt-2 h-4 w-2/3 max-w-xl" />
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Bone key={i} className="h-40" />
        ))}
      </div>
      <span className="sr-only">{label}…</span>
    </div>
  )
}

/** An app-shaped placeholder: a sidebar and a main panel (Tara, Jasoos, CodeLens…). */
export function AppSkeleton({ label = 'Loading' }) {
  return (
    <div role="status" aria-label={label} className="flex h-full min-h-[100svh] w-full">
      <div className="hidden w-60 shrink-0 space-y-3 border-r border-white/[0.06] p-4 lg:block">
        <Bone className="h-8 w-32" />
        {[0, 1, 2, 3].map((i) => (
          <Bone key={i} className="h-9" />
        ))}
      </div>
      <div className="flex flex-1 flex-col items-center px-4 pt-16">
        <Bone className="h-4 w-40" />
        <Bone className="mt-3 h-9 w-72 max-w-full" />
        <Bone className="mt-10 size-36 rounded-full" />
        <div className="mt-10 grid w-full max-w-xl gap-3 sm:grid-cols-2">
          <Bone className="h-16" />
          <Bone className="h-16" />
        </div>
      </div>
      <span className="sr-only">{label}…</span>
    </div>
  )
}
