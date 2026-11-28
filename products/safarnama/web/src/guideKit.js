/**
 * Small pure helpers for the trip guide (Guidebook.jsx): how a cost range reads, what a stop or a day usually costs,
 * and the icons (Lucide, the site's icon set) that make a long plan easy to scan. Unit-tested in guideKit.test.js.
 * Every amount is an estimate from the guide (typical prices), never a live price: the UI marks it with "≈".
 */
import {
  Bus, CakeSlice, Car, CloudFog, CloudLightning, CloudRain, CloudSun, Coffee, CookingPot, Footprints, Landmark,
  Mountain, Plane, Salad, Snowflake, Soup, Store, Sun, TrainFront, Trees, UtensilsCrossed,
} from 'lucide-react'  // prettier-ignore
import { shortMoney } from './money'

/** "≈ ₹1.2k–2k", "≈ ₹500", or "Free". `per` adds " a person", " a night"… */
export function rangeText(r, currency, per = '') {
  const lo = Math.max(0, Number(r?.min ?? r?.[0]) || 0)
  const hi = Math.max(lo, Number(r?.max ?? r?.[1]) || 0)
  if (hi === 0) return 'Free'
  const a = shortMoney(lo, currency)
  const b = shortMoney(hi, currency).replace(/^[^\d−-]+/, '') // "₹2k" → "2k" after the first figure
  return `≈ ${lo === hi || lo === 0 ? shortMoney(hi, currency) : `${a}–${b}`}${per}`
}

/** A map of stop id → its usual cost entry from the guide. */
export const costsById = (guide) => Object.fromEntries((guide?.stop_costs ?? []).map((c) => [c.id, c]))

/** What a day's tickets and activities usually cost for the group (meals are counted with food). */
export function dayCost(day, costs, people) {
  let lo = 0
  let hi = 0
  for (const a of day.activities) {
    const c = costs[a.id]
    if (!c || a.kind === 'food') continue
    const n = c.per === 'free' ? 0 : c.per === 'group' ? 1 : people
    lo += (c.cost?.min ?? 0) * n
    hi += (c.cost?.max ?? 0) * n
  }
  return { min: lo, max: hi }
}

/** The weather as one icon, from the WMO code (and the rain chance when there's no code); null without weather. */
export function weatherIcon(w) {
  if (!w) return null
  const c = w.code
  if (c == null) return w.rain >= 60 ? CloudRain : CloudSun
  if (c >= 95) return CloudLightning
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return Snowflake
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return CloudRain
  if (c === 45 || c === 48) return CloudFog
  return c <= 1 ? Sun : CloudSun
}

export const STOP_ICON = { food: UtensilsCrossed, indoor: Landmark, outdoor: Trees, transit: Footprints }
export const THING_TYPES = [
  { id: 'adventure', label: 'Adventure', icon: Mountain },
  { id: 'culture', label: 'Culture', icon: Landmark },
  { id: 'nature', label: 'Nature', icon: Trees },
  { id: 'local', label: 'Local life', icon: Store },
]
export const TRAVEL_ICON = { flight: Plane, train: TrainFront, bus: Bus, car: Car }
const FOOD_ICONS = [Soup, CookingPot, UtensilsCrossed, CakeSlice, Coffee, Salad]
export const foodIcon = (i) => FOOD_ICONS[i % FOOD_ICONS.length]

/** The stay levels in order, with how each reads. */
export const LEVELS = [
  { id: 'budget', label: 'Budget', hint: 'Homestays, guest houses, hostels' },
  { id: 'mid', label: 'Comfort', hint: 'Good hotels, boutique stays' },
  { id: 'premium', label: 'Treat', hint: 'Resorts and top hotels' },
]

/** The stay level a live price falls in, from the guide's room prices for the destination (null without them). */
export function levelFor(perNight, tiers) {
  if (!tiers?.budget && !tiers?.mid) return null
  if (tiers.budget && perNight <= tiers.budget.per_night.max) return 'budget'
  if (tiers.mid && perNight <= tiers.mid.per_night.max) return 'mid'
  return tiers.premium ? 'premium' : 'mid'
}

/** Which kinds of mapped stays (OpenStreetMap) match a stay level. Stars only count where they are mapped. */
export function fitsLevel(place, level) {
  const cat = place.category
  if (level === 'budget') return ['guest house', 'hostel', 'apartment', 'alpine hut', 'chalet', 'motel'].includes(cat)
  if (level === 'premium') return cat === 'hotel' && (place.stars ?? 0) >= 4
  return cat === 'hotel' && (place.stars == null || place.stars <= 4)
}

const core = (s) => String(s ?? '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
const nearM = (a, b) => {
  const r = Math.PI / 180
  const x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r)
  const y = (b.lat - a.lat) * r
  return Math.hypot(x, y) * 6371000
}

/**
 * Whether a guide item is already in the plan: a stop with the same name (brackets aside), or one within about 150 m
 * of it on the map ("Galtaji (Monkey Temple)" and "Galtaji Temple" are the same place).
 */
export function inPlan(trip, name, at = null) {
  const n = core(name)
  return trip.days.some((d) => d.activities.some((a) =>
    (n && core(a.name) === n) || (at?.lat != null && a.lat != null && nearM(at, a) < 150)))
}

/** The day to suggest for a new stop: the one with the fewest stops (the earliest on a tie). */
export const lightestDay = (trip) => [...trip.days].sort((a, b) => a.activities.length - b.activities.length || a.day - b.day)[0]?.day ?? 1
