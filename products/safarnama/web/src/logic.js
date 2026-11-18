/** Pure Safarnama UI helpers (unit-tested in logic.test.js). */
import { appPath } from './base'

export const PARTS = ['morning', 'afternoon', 'evening']

export function toMin(hhmm) {
  const [h, m] = String(hhmm ?? '09:00').split(':').map(Number)
  return (Number.isFinite(h) ? h : 9) * 60 + (Number.isFinite(m) ? m : 0)
}

export const toHHMM = (min) => {
  const m = Math.max(0, Math.min(23 * 60 + 55, Math.round(min)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export const dayPart = (hhmm) => {
  const m = toMin(hhmm)
  return m < 12 * 60 ? 'morning' : m < 17 * 60 ? 'afternoon' : 'evening'
}

/** Activities grouped into morning / afternoon / evening, keeping their order and original index. */
export function groupByPart(activities) {
  const out = PARTS.map((part) => ({ part, items: [] }))
  activities.forEach((a, index) => out[PARTS.indexOf(dayPart(a.time))].items.push({ a, index }))
  return out.filter((g) => g.items.length)
}

export const endTime = (a) => toHHMM(toMin(a.time) + (a.duration_min ?? 60))

export function money(amount, currency = 'EUR') {
  if (amount == null || Number.isNaN(Number(amount))) return '—'
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount)
  } catch {
    return `${Number(amount).toFixed(2)} ${currency}`
  }
}

export const PHASES = ['active', 'upcoming', 'planning', 'past', 'archived']
export const PHASE_LABEL = { active: 'Travelling now', upcoming: 'Upcoming', planning: 'Planning (no dates yet)', past: 'Past trips', archived: 'Archived' }

export function groupTrips(trips) {
  const groups = Object.fromEntries(PHASES.map((p) => [p, []]))
  for (const t of trips) (groups[t.phase] ?? groups.planning).push(t)
  groups.upcoming.sort((a, b) => String(a.start).localeCompare(String(b.start)))
  groups.past.sort((a, b) => String(b.end).localeCompare(String(a.end)))
  return PHASES.filter((p) => groups[p].length).map((p) => ({ phase: p, trips: groups[p] }))
}

export function hostOf(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'tel:' ? url.slice(4) : u.hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const PLACE_FIELDS = ['website', 'menu', 'reservation_url', 'reservation', 'phone', 'opening_hours', 'osm_id']

/** A discovered/saved place → the stop body the API accepts (provider fields kept for labels and hand-offs). */
export function placeToStop(p, { time = '12:00', near, added = 'discovery' } = {}) {
  const food = p.group === 'food' || p.group === 'nightlife'
  const stop = {
    name: p.name.slice(0, 120),
    lat: p.lat,
    lng: p.lng,
    kind: food ? 'food' : p.indoor ? 'indoor' : 'outdoor',
    time,
    duration_min: food ? 60 : 60,
    note: [p.category, p.cuisine, p.distance_m != null && near ? `${p.distance_m} m from ${near}` : null].filter(Boolean).join(' · ').slice(0, 300),
    added,
  }
  if (p.distance_m != null) stop.distance_m = p.distance_m
  if (near) stop.near = near.slice(0, 120)
  for (const f of PLACE_FIELDS) if (p[f]) stop[f] = String(p[f]).slice(0, f === 'opening_hours' ? 200 : 300)
  return stop
}

export function placeToSaved(p, destination) {
  const body = { name: p.name.slice(0, 160), group: p.group, lat: p.lat, lng: p.lng, veg: !!p.veg, vegan: !!p.vegan }
  for (const f of ['category', 'cuisine', ...PLACE_FIELDS]) if (p[f]) body[f] = p[f]
  if (destination) body.destination = destination
  return body
}

/** The stop happening now or next, from the traveller's local clock. */
export function nextUp(trip, now = new Date()) {
  const today = localDate(now)
  const day = trip.days.find((d) => d.date === today)
  if (!day) return null
  const minute = now.getHours() * 60 + now.getMinutes()
  for (const a of day.activities) {
    const start = toMin(a.time)
    if (minute < start + (a.duration_min ?? 60)) return { day: day.day, activity: a, now: minute >= start }
  }
  return { day: day.day, activity: null, now: false }
}

export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const localIso = (d = new Date()) => `${localDate(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

export const shareUrl = (origin, id, key) => `${origin}${appPath(`/${id}`)}?share=${encodeURIComponent(key)}`

export const pct = (part, whole) => (whole ? Math.max(0, Math.min(100, Math.round((part / whole) * 100))) : 0)

export const LABEL_TONE = {
  must_visit: 'warn',
  local_favourite: 'good',
  hidden_gem: 'good',
  time_sensitive: 'bad',
  weather_dependent: 'info',
  reservation_recommended: 'warn',
  near_route: 'neutral',
  traveller_favourite: 'good',
}

export const BOOKING_TYPES = ['flight', 'hotel', 'train', 'bus', 'car', 'restaurant', 'activity', 'tour', 'ticket', 'other']
export const EXPENSE_CATEGORIES = ['lodging', 'food', 'transport', 'activities', 'shopping', 'other']
export const DOC_KINDS = ['confirmation', 'ticket', 'insurance', 'accommodation', 'emergency_contact', 'id', 'note', 'other']

/** Only ever open hand-off URLs that came from the provider data and use a safe scheme. */
export const safeLink = (url) => /^(https?:|tel:)/i.test(String(url ?? ''))

const parseIso = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number)
  return new Date(y, m - 1, d)
}
/** "Mon 23 – Wed 25 Nov 2026" from ISO dates (calendar dates: no time-zone shifts). One date → "Mon 23 Nov 2026". */
export function dateRange(start, end) {
  if (!start) return ''
  const a = parseIso(start)
  const b = end ? parseIso(end) : a
  const f = (d, { month = false, year = false } = {}) =>
    [d.toLocaleDateString('en-GB', { weekday: 'short' }), d.getDate(), month && d.toLocaleDateString('en-GB', { month: 'short' }), year && d.getFullYear()]
      .filter(Boolean)
      .join(' ')
  if (a.getTime() === b.getTime()) return f(a, { month: true, year: true })
  const sameYear = a.getFullYear() === b.getFullYear()
  const first = f(a, { month: !(a.getMonth() === b.getMonth() && sameYear), year: !sameYear })
  return `${first} – ${f(b, { month: true, year: true })}`
}
