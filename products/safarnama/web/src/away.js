/**
 * "Did you book it?": when the traveller leaves for a provider's site to book, remember where they went (on this
 * device only), and ask once when they come back to the trip. Nothing is sent anywhere until they answer.
 */
import { hostOf } from './logic'

const KEY = 'safarnaama-away'
export const MIN_AWAY_MS = 10_000 // back within seconds: they didn't book anything yet, so don't ask yet
export const MAX_AGE_MS = 2 * 24 * 3600_000 // after two days the question is stale

let currentTrip = null
/** The trip on screen, so a hand-off anywhere in it can be remembered against it. */
export const setAwayTrip = (id) => {
  currentTrip = id
}

const read = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}
  } catch {
    return {}
  }
}
const write = (all) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* private mode: we just won't ask */
  }
}

/** The booking a hand-off may lead to, pre-filled from the link and the place it's for. */
export function awayPrefill(link, place) {
  if (link.prefill) return { ...link.prefill, url: link.prefill.url || link.url }
  const food = place?.kind === 'food' || place?.group === 'food'
  return {
    type: food ? 'restaurant' : 'ticket',
    title: place?.name ?? '',
    provider: hostOf(link.url),
    url: link.url,
    status: 'booked',
    ...(place?.id && place?.time ? { activity_id: place.id } : {}),
  }
}

/** Remember a hand-off to a booking site (other links, like menus and websites, aren't asked about). */
export function noteAway(link, place, tripId = currentTrip, now = Date.now()) {
  if (!tripId || link?.kind !== 'booking') return
  const all = read()
  all[tripId] = { label: link.label || hostOf(link.url), host: hostOf(link.url), prefill: awayPrefill(link, place), at: now }
  write(all)
}

/** The hand-off to ask about now, if the traveller has been away long enough and it isn't stale. */
export function pendingAway(tripId, now = Date.now()) {
  const e = read()[tripId]
  if (!e || typeof e.at !== 'number') return null
  if (now - e.at > MAX_AGE_MS) {
    forgetAway(tripId)
    return null
  }
  return now - e.at >= MIN_AWAY_MS ? e : null
}

export function forgetAway(tripId) {
  const all = read()
  if (!(tripId in all)) return
  delete all[tripId]
  write(all)
}

/** A title the API accepts, even when the link didn't come with one. */
export const awayTitle = (e) => (e.prefill.title || `${e.prefill.type === 'hotel' ? 'Stay' : 'Booking'} via ${e.label}`).slice(0, 160)
