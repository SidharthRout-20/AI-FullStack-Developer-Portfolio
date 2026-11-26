/**
 * Lite mode: the same site, lighter to draw, for devices that would stutter. On when the visitor asked for reduced
 * motion, or the device looks low-powered (few CPU cores or little memory), or it can't hold a smooth frame rate.
 * Lite freezes ambient animation and turns off glass blur (both repaint every frame); content and layout are unchanged.
 *
 * `?lite=1` / `?lite=0` force it either way (handy for testing), remembered for the visit.
 */
const KEY = 'site-lite'

function decide() {
  if (typeof window === 'undefined') return false
  try {
    const forced = new URLSearchParams(window.location.search).get('lite')
    if (forced === '1' || forced === '0') sessionStorage.setItem(KEY, forced)
    const saved = sessionStorage.getItem(KEY)
    if (saved) return saved === '1'
  } catch {
    /* storage blocked: fall through to detection */
  }
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const cores = navigator.hardwareConcurrency || 8
  const memory = navigator.deviceMemory || 8 // Chrome/Edge only; others assume a capable device
  const saveData = navigator.connection?.saveData
  return Boolean(reduce || saveData || cores <= 2 || memory <= 4) // the frame-rate check catches the rest
}

export let LITE = decide()

function apply() {
  if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-lite', LITE)
}
apply()

/**
 * After load, watch the real frame rate for a couple of seconds: a device that drops well below 60 fps switches to
 * lite on its own (it's a one-way switch for the visit, so the page never flickers between modes).
 */
export function watchFrameRate() {
  if (LITE || typeof requestAnimationFrame === 'undefined') return
  let frames = 0
  let start = 0
  const tick = (t) => {
    if (!start) start = t
    frames += 1
    if (t - start < 2000) return requestAnimationFrame(tick)
    const fps = (frames * 1000) / (t - start)
    if (fps < 40 && document.visibilityState === 'visible') {
      LITE = true
      try {
        sessionStorage.setItem(KEY, '1')
      } catch {
        /* fine */
      }
      apply()
    }
  }
  setTimeout(() => requestAnimationFrame(tick), 1500) // let the first paint settle
}
