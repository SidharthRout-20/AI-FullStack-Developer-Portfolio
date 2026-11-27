/**
 * The owner's photo. Drop a square photo at frontend/public/me.jpg (or point SITE.avatar elsewhere) and it appears
 * everywhere: the small portraits in the headers and on the skin switch.
 * Until then a tasteful placeholder is shown (and, on the dev server only, a hint where to put the file).
 */
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
