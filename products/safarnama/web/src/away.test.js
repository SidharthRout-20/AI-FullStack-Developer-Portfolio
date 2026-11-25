import { beforeEach, describe, expect, it } from 'vitest'
import { awayTitle, forgetAway, MAX_AGE_MS, MIN_AWAY_MS, noteAway, pendingAway } from './away'

const store = {}
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v) }, removeItem: (k) => { delete store[k] } }

describe('asking "did you book it?" after a provider hand-off', () => {
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k] })
  const link = { kind: 'booking', label: 'Booking.com', url: 'https://www.booking.com/x', prefill: { type: 'hotel', title: 'Stay in Kathmandu', start: '2026-11-30T14:00', status: 'booked' } }

  it('asks only after a real trip away, and not once it is stale', () => {
    noteAway(link, null, 't1', 0)
    expect(pendingAway('t1', MIN_AWAY_MS - 1)).toBeNull()
    expect(pendingAway('t1', MIN_AWAY_MS)).toMatchObject({ label: 'Booking.com', host: 'booking.com', prefill: { title: 'Stay in Kathmandu', url: link.url } })
    expect(pendingAway('t1', MAX_AGE_MS + 1)).toBeNull()
    expect(pendingAway('t1', MIN_AWAY_MS)).toBeNull() // dropped
  })

  it('ignores menus and websites, and forgets once answered', () => {
    noteAway({ kind: 'menu', url: 'https://m.example' }, { name: 'Cafe' }, 't2', 0)
    expect(pendingAway('t2', MIN_AWAY_MS)).toBeNull()
    noteAway({ kind: 'booking', url: 'https://venue.example/book' }, { name: 'Momo House', kind: 'food', id: 'a1', time: '13:00' }, 't2', 0)
    const e = pendingAway('t2', MIN_AWAY_MS)
    expect(e.prefill).toMatchObject({ type: 'restaurant', title: 'Momo House', activity_id: 'a1', provider: 'venue.example' })
    forgetAway('t2')
    expect(pendingAway('t2', MIN_AWAY_MS)).toBeNull()
  })

  it('always has a title the API accepts', () => {
    expect(awayTitle({ label: 'MakeMyTrip', prefill: { type: 'flight', title: '' } })).toBe('Booking via MakeMyTrip')
    expect(awayTitle({ label: 'Airbnb', prefill: { type: 'hotel', title: '' } })).toBe('Stay via Airbnb')
  })
})
