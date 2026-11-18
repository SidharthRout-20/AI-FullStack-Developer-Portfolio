import { describe, expect, it } from 'vitest'
import { dayPart, endTime, groupByPart, groupTrips, hostOf, money, nextUp, pct, placeToSaved, placeToStop, safeLink, shareUrl } from './logic'

describe('TripWeaver itinerary helpers', () => {
  it('groups stops into morning, afternoon and evening, keeping indexes', () => {
    const acts = [{ time: '09:00' }, { time: '12:30' }, { time: '19:15' }, { time: '11:59' }]
    expect(dayPart('11:59')).toBe('morning')
    expect(dayPart('17:00')).toBe('evening')
    const g = groupByPart(acts)
    expect(g.map((x) => x.part)).toEqual(['morning', 'afternoon', 'evening'])
    expect(g[0].items.map((x) => x.index)).toEqual([0, 3])
    expect(endTime({ time: '23:30', duration_min: 90 })).toBe('23:55')
  })

  it('finds the current or next stop from local time', () => {
    const trip = { days: [{ day: 2, date: '2030-05-02', activities: [{ id: 'a', time: '09:00', duration_min: 60 }, { id: 'b', time: '14:00', duration_min: 60 }] }] }
    expect(nextUp(trip, new Date(2030, 4, 2, 9, 30))).toMatchObject({ day: 2, now: true, activity: { id: 'a' } })
    expect(nextUp(trip, new Date(2030, 4, 2, 11, 0))).toMatchObject({ now: false, activity: { id: 'b' } })
    expect(nextUp(trip, new Date(2030, 4, 2, 22, 0)).activity).toBeNull()
    expect(nextUp(trip, new Date(2030, 4, 3, 9, 0))).toBeNull()
  })
})

describe('TripWeaver discovery hand-offs', () => {
  const place = { name: 'Tasca', group: 'food', category: 'restaurant', cuisine: 'portuguese', lat: 1, lng: 2, distance_m: 120, website: 'https://t.example', osm_id: 'node/1', reservation: 'yes' }

  it('turns a discovered place into a stop that keeps provider fields', () => {
    const s = placeToStop(place, { time: '12:30', near: 'Castle' })
    expect(s).toMatchObject({ kind: 'food', time: '12:30', near: 'Castle', distance_m: 120, website: 'https://t.example', reservation: 'yes', added: 'discovery' })
    expect(s.note).toBe('restaurant · portuguese · 120 m from Castle')
    expect(placeToSaved(place, 'd1')).toMatchObject({ name: 'Tasca', group: 'food', destination: 'd1', osm_id: 'node/1' })
  })

  it('only opens safe provider links', () => {
    expect(safeLink('https://t.example')).toBe(true)
    expect(safeLink('tel:+351210')).toBe(true)
    expect(safeLink('javascript:alert(1)')).toBe(false)
    expect(hostOf('https://www.t.example/menu')).toBe('t.example')
  })
})

describe('TripWeaver trips and money', () => {
  it('groups trips by phase in a useful order', () => {
    const g = groupTrips([
      { id: 1, phase: 'past', end: '2029-01-02' },
      { id: 2, phase: 'upcoming', start: '2031-01-01' },
      { id: 3, phase: 'upcoming', start: '2030-06-01' },
      { id: 4, phase: 'active' },
    ])
    expect(g.map((x) => x.phase)).toEqual(['active', 'upcoming', 'past'])
    expect(g[1].trips.map((t) => t.id)).toEqual([3, 2])
  })

  it('formats money and percentages', () => {
    expect(money(null)).toBe('—')
    expect(money(12.5, 'EUR')).toMatch(/12[.,]50/)
    expect(pct(50, 200)).toBe(25)
    expect(pct(500, 200)).toBe(100)
    expect(shareUrl('https://x.app', 'abc', 'k y')).toBe('https://x.app/safarnama/abc?share=k%20y')
  })
})

describe('session errors', () => {
  it('explains an outdated backend instead of a bare status code', async () => {
    const { sessionError } = await import('../shared/http')
    expect(sessionError('TripWeaver', 405, 'https://api.example.app')).toMatch(/api\.example\.app.*doesn't have TripWeaver yet.*older deployment/)
    expect(sessionError('EFI', 404, 'https://api.example.app')).toMatch(/doesn't have EFI yet/)
    expect(sessionError('EFI', 500, 'https://api.example.app')).toBe("EFI: couldn't start a session (500).")
  })
})

describe('Safarnama dates', async () => {
  const { dateRange } = await import('./logic')
  it('reads like a person wrote it', () => {
    expect(dateRange('2026-11-23', '2026-11-25')).toBe('Mon 23 – Wed 25 Nov 2026')
    expect(dateRange('2026-11-30', '2026-12-02')).toBe('Mon 30 Nov – Wed 2 Dec 2026')
    expect(dateRange('2026-12-30', '2027-01-02')).toBe('Wed 30 Dec 2026 – Sat 2 Jan 2027')
    expect(dateRange('2026-11-23')).toBe('Mon 23 Nov 2026')
    expect(dateRange(null)).toBe('')
  })
})

describe('Safarnama with an older server', async () => {
  const { rejectsExtras } = await import('./api')
  const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  it('recognises a rejection that is only about unknown fields', async () => {
    const extra = { detail: [{ type: 'extra_forbidden', loc: ['body', 'party'], msg: 'Extra inputs are not permitted' }] }
    expect(await rejectsExtras(res(422, extra))).toBe(true)
    expect(await rejectsExtras(res(422, { detail: [...extra.detail, { type: 'string_too_short', loc: ['body', 'prompt'] }] }))).toBe(false)
    expect(await rejectsExtras(res(422, { detail: 'nope' }))).toBe(false)
  })
})
