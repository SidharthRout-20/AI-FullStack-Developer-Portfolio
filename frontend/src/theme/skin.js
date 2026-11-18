/**
 * Site skins. Independent of light/dark: every skin has both.
 *   showcase – "Studio": the landing page recruiters and visitors see first. Quiet and product-first: neutral greys,
 *              system type, generous whitespace, one blue accent.
 *   personal – "Off the clock": the original space. Aurora, glass, gradients, handwritten notes.
 * The ids stay as they were (they are stored in visitors' browsers); only the names people see changed.
 * Pure helpers only (unit-tested); state and transitions live in theme.js.
 */

export const SKINS = ['showcase', 'personal']
export const DEFAULT_SKIN = 'showcase'
export const SKIN_KEY = 'site-skin'

/** What people see. `to` is the label on the switch that leads INTO that skin. */
export const SKIN_NAMES = {
  showcase: { name: 'Studio', to: 'Studio', hint: 'Back to the Studio' },
  personal: { name: 'Off the clock', to: 'Off the clock', hint: 'Step off the clock: the personal side of this site' },
}

export const isSkin = (v) => SKINS.includes(v)

/** Browser chrome colour (mobile address bar) for a skin + theme. Keep in step with the CSS tokens. */
export function themeColor(theme, skin) {
  if (skin === 'showcase') return theme === 'light' ? '#f5f5f7' : '#000000'
  return theme === 'light' ? '#f4f5f9' : '#0b0d14'
}

/**
 * Time-of-day "lighting" for the personal space backdrop, from the visitor's local hour.
 * Each phase is three aurora tints (Tailwind colour utilities) and a label used for the greeting.
 */
export const DAY_PHASES = {
  dawn: { from: 5, label: 'morning', blobs: ['bg-amber-500', 'bg-rose-500/70', 'bg-violet-600/70'] },
  day: { from: 9, label: 'day', blobs: ['bg-indigo-600', 'bg-cyan-500/70', 'bg-violet-700/70'] },
  dusk: { from: 17, label: 'evening', blobs: ['bg-orange-500', 'bg-fuchsia-600/70', 'bg-indigo-700/70'] },
  night: { from: 20, label: 'night', blobs: ['bg-blue-700', 'bg-indigo-600/70', 'bg-teal-600/60'] },
}

export function dayPhase(hour) {
  if (hour >= 5 && hour < 9) return 'dawn'
  if (hour >= 9 && hour < 17) return 'day'
  if (hour >= 17 && hour < 20) return 'dusk'
  return 'night'
}

/** "Good evening" style greeting for an hour of the day. */
export function greeting(hour) {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 17) return 'Good afternoon'
  if (hour >= 17 && hour < 22) return 'Good evening'
  return 'Up late'
}

/** Local time somewhere else, e.g. "9:41 pm" in Asia/Kolkata. Returns null if the time zone isn't supported. */
export function timeIn(timeZone, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(now)
    const get = (t) => parts.find((p) => p.type === t)?.value ?? ''
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now))
    return { text: `${get('hour')}:${get('minute')} ${get('dayPeriod').toLowerCase()}`.trim(), hour }
  } catch {
    return null
  }
}
