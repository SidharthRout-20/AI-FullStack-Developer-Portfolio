/**
 * The owner's photo. Drop a square photo at frontend/public/me.jpg (or point SITE.avatar elsewhere) and it appears
 * everywhere: the polaroid in Off the clock, the small portraits in the headers and on the skin switch.
 * Until then a tasteful placeholder is shown (and, on the dev server only, a hint where to put the file).
 */
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react'
import { useEffect, useState } from 'react'
import { SITE } from './config'

export const initials = SITE.owner
  .split(' ')
  .map((w) => w[0])
  .join('')
  .slice(0, 2)

// One probe per page load, shared by every portrait on the page.
let probe = null
function photoStatus() {
  if (!SITE.avatar) return Promise.resolve(false)
  probe ??= new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img.naturalWidth > 0)
    img.onerror = () => resolve(false)
    img.src = SITE.avatar
  })
  return probe
}

/** null while checking, then true (the photo exists) or false (show the placeholder). */
export function usePhoto() {
  const [ok, setOk] = useState(null)
  useEffect(() => {
    let live = true
    void photoStatus().then((v) => live && setOk(v))
    return () => {
      live = false
    }
  }, [])
  return ok
}

/** Small round (or rounded-square) portrait for headers and the skin switch. */
export function MiniPortrait({ className = 'size-6', square = false, ring = false }) {
  const ok = usePhoto()
  const shape = square ? 'rounded-xl' : 'rounded-full'
  return (
    <span className={`relative grid shrink-0 place-items-center overflow-hidden ${shape} ${className} ${ring ? 'ring-2 ring-white/15' : ''}`}>
      {ok ? (
        <img src={SITE.avatarFace || SITE.avatar} alt="" className="size-full object-cover" />
      ) : (
        <span className="grid size-full place-items-center bg-gradient-to-br from-indigo-500 via-violet-500 to-cyan-400 text-[0.42em] font-semibold tracking-wide text-on-accent">
          <span className="text-[length:inherit]">{initials}</span>
        </span>
      )}
    </span>
  )
}

/**
 * Off the clock: the photo as a polaroid. It "develops" when the page opens, leans towards the pointer, and flips
 * over (click or tap) to a handwritten note on the back.
 */
export function Polaroid() {
  const ok = usePhoto()
  const reduce = useReducedMotion()
  const [flipped, setFlipped] = useState(false)
  const mx = useMotionValue(0)
  const my = useMotionValue(0)
  const rx = useSpring(useTransform(my, [-0.5, 0.5], [9, -9]), { stiffness: 220, damping: 22 })
  const ry = useSpring(useTransform(mx, [-0.5, 0.5], [-11, 11]), { stiffness: 220, damping: 22 })
  const glareX = useTransform(mx, [-0.5, 0.5], ['20%', '80%'])
  const glareY = useTransform(my, [-0.5, 0.5], ['15%', '85%'])
  const glare = useTransform([glareX, glareY], ([gx, gy]) => `radial-gradient(circle at ${gx} ${gy}, rgb(255 255 255 / 0.55), transparent 55%)`)

  const onMove = (e) => {
    if (reduce || e.pointerType !== 'mouse') return
    const r = e.currentTarget.getBoundingClientRect()
    mx.set((e.clientX - r.left) / r.width - 0.5)
    my.set((e.clientY - r.top) / r.height - 0.5)
  }
  const onLeave = () => {
    mx.set(0)
    my.set(0)
    setFlipped(false)
  }
  const year = new Date().getFullYear()
  const city = SITE.location.split(',')[0]

  return (
    <div className="relative mx-auto w-60 [perspective:1100px] sm:w-72" onPointerMove={onMove} onPointerLeave={onLeave}>
      {/* soft coloured glow behind the card, slowly turning */}
      <motion.div
        aria-hidden
        className="absolute -inset-8 rounded-[40%] bg-[conic-gradient(from_0deg,#6366f1,#22d3ee,#34d399,#f59e0b,#ec4899,#6366f1)] opacity-30 blur-3xl"
        animate={reduce ? undefined : { rotate: 360 }}
        transition={{ duration: 24, repeat: Infinity, ease: 'linear' }}
      />
      <motion.div
        role="button"
        tabIndex={0}
        aria-label={flipped ? 'Turn the photo back over' : 'Turn the photo over'}
        aria-pressed={flipped}
        onClick={() => setFlipped((f) => !f)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setFlipped((f) => !f))}
        style={reduce ? undefined : { rotateX: rx, rotateY: ry }}
        className="relative block w-full -rotate-3 cursor-pointer [transform-style:preserve-3d] focus-visible:outline-offset-8"
      >
        <motion.div
          animate={{ rotateY: flipped ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 160, damping: 20 }}
          className="relative [transform-style:preserve-3d]"
        >
          {/* front */}
          <div className="relative rounded-[6px] bg-[#f7f4ee] p-3 pb-14 shadow-[0_40px_80px_-30px_rgb(0_0_0/0.7),0_2px_6px_rgb(0_0_0/0.25)] [backface-visibility:hidden]">
            <div className="relative aspect-square overflow-hidden rounded-[2px] bg-[#1b1c22]">
              {ok ? (
                <motion.img
                  src={SITE.avatar}
                  alt={SITE.owner}
                  // A polaroid developing: washed-out and warm, then full colour.
                  initial={reduce ? false : { filter: 'sepia(0.9) brightness(1.7) contrast(0.55) blur(3px)', opacity: 0.4 }}
                  animate={{ filter: 'sepia(0) brightness(1) contrast(1) blur(0px)', opacity: 1 }}
                  transition={{ duration: 2.4, ease: [0.3, 0.6, 0.2, 1], delay: 0.3 }}
                  className="size-full object-cover"
                />
              ) : (
                <PhotoPlaceholder pending={ok === null} />
              )}
              {!reduce && (
                <motion.span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 mix-blend-soft-light"
                  style={{ background: glare }}
                />
              )}
            </div>
            <p className="font-hand absolute inset-x-0 bottom-3 text-center text-[24px] leading-none text-[#2b2b33]">
              {SITE.photoCaption || `${city}, ${year}`}
            </p>
          </div>
          {/* back */}
          <div
            aria-hidden={!flipped}
            className="absolute inset-0 flex flex-col justify-between rounded-[6px] bg-[#efe9dd] p-6 text-left text-[#2b2b33] shadow-[0_40px_80px_-30px_rgb(0_0_0/0.7)] [backface-visibility:hidden] [transform:rotateY(180deg)]"
          >
            <div className="font-hand space-y-2 text-[22px] leading-tight">
              <p>{city} · {year}</p>
              <p className="text-[19px] text-[#4a4a55]">{SITE.years} years in software, from COBOL to LLMs.</p>
              {SITE.now?.[0] && <p className="text-[19px] text-[#4a4a55]">These days: {SITE.now[0].charAt(0).toLowerCase() + SITE.now[0].slice(1)}.</p>}
            </div>
            <p className="font-hand text-right text-[24px] text-[#6d4bd8]">say hi, scroll down ↓</p>
          </div>
        </motion.div>
      </motion.div>
      <p aria-hidden className="font-hand mt-5 text-center text-[19px] text-ink-400">{flipped ? 'and back again ↺' : 'turn me over ↻'}</p>
    </div>
  )
}

function PhotoPlaceholder({ pending }) {
  return (
    <div className="relative grid size-full place-items-center bg-gradient-to-br from-indigo-500 via-violet-500 to-cyan-400">
      {!pending && (
        <>
          {/* a simple silhouette so the frame reads as "a photo goes here" */}
          <svg viewBox="0 0 100 100" aria-hidden className="absolute bottom-0 h-[78%] text-white/15">
            <circle cx="50" cy="38" r="18" fill="currentColor" />
            <path d="M14 100c2-22 17-34 36-34s34 12 36 34z" fill="currentColor" />
          </svg>
          <span className="font-hand relative text-[64px] leading-none text-white/90 drop-shadow">{initials}</span>
          {import.meta.env.DEV && (
            <span className="absolute inset-x-3 bottom-3 rounded-md border border-dashed border-white/40 bg-black/40 px-2 py-1 text-center text-[10.5px] leading-snug text-white/85">
              Dev only: add your photo at <b>frontend/public/me.jpg</b>
            </span>
          )}
        </>
      )}
    </div>
  )
}
