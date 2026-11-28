import { describe, expect, it } from 'vitest'
import { buildTripPack, packFileName, packSections } from './packHtml'

const trip = {
  title: '4 days in Manali <script>',
  summary: 'Snow, cafés & old temples',
  destinations: [{ id: 'd1', name: 'Manali', country: 'India', start_day: 1, end_day: 2, lat: 32.24, lng: 77.19 }],
  days: [
    { day: 1, date: '2026-12-14', weather: { tmax: 9.4, tmin: -1.2, rain: 20 }, activities: [{ id: 'a', name: 'Hadimba Devi Temple', time: '09:30', duration_min: 60, lat: 32.248, lng: 77.18, note: 'Go early' }] },
    { day: 2, date: '2026-12-15', activities: [] },
  ],
  party: { travellers: 2 },
  budget: { total: 40000, currency: 'INR' },
  checklists: [{ id: 'l', title: 'Packing', items: [{ id: 'i', text: 'Thermals', done: true }] }],
  tips: ['Carry cash for Old Manali cafés'],
}
const cat = (budget, actual = 0) => ({ budget, actual, estimated: 0 })
const sum = { currency: 'INR', budget_total: 40000, actual_total: 1200, by_category: { lodging: cat(14000), transport: cat(10000), food: cat(8000, 1200), activities: cat(4000), shopping: cat(2000), other: cat(2000) } }
const stays = [{ destination: 'Manali', places: [{ name: 'Snow Peak Homestay', category: 'guest house', distance_m: 850, saved: true }, { name: 'Hotel Ridge', category: 'hotel', stars: 3, distance_m: 1500, website: 'javascript:alert(1)' }] }]
const nearby = [{ destination: 'Manali', groups: [{ label: 'Sights', places: [{ name: 'Vashisht Temple', category: 'temple', fee: 'no', lat: 32.26, lng: 77.19, distance_m: 2400 }] }] }]
const bookings = [{ title: 'Volvo to Manali', type: 'bus', start: '2026-12-13T21:00', status: 'booked', reference: 'PNR123' }, { title: 'Old hotel', type: 'hotel', status: 'cancelled' }]

describe('the trip pack', () => {
  it('turns the budget into everyday terms and keeps only real, mapped facts about places', () => {
    const s = packSections({ trip, sum, stays, nearby, bookings })
    expect(s.budget.rows.find((r) => r.label === 'Stay').everyday).toBe('about ₹14k a night') // 2 days = 1 night
    expect(s.budget.rows.find((r) => r.label === 'Food').everyday).toBe('about ₹2k a person a day')
    expect(s.stays[0]).toMatchObject({ nights: 1, checkin: 'Monday 14 December', checkout: 'Tuesday 15 December', perNight: '₹14k' }) // 2 days, 1 night
    expect(s.stays[0].places[1].stars).toBe('3-star (as mapped)')
    expect(s.stays[0].places[0].stars).toBe('') // never a rating that isn't mapped
    expect(decodeURIComponent(s.stays[0].search)).toContain('hotels in Manali from 14 December 2026 to 15 December 2026')
    expect(s.bookings).toEqual([{ title: 'Volvo to Manali', type: 'bus', when: '2026-12-13 21:00', status: 'booked' }])
  })

  it('is a safe, self-contained page: escaped text, https links only, no scripts or remote assets', () => {
    const html = buildTripPack({ trip, sum, stays, nearby, bookings }, new Date(2026, 10, 28))
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).not.toContain('<script')
    expect(html).toContain('4 days in Manali &lt;script&gt;')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('PNR123') // reference numbers stay in the app
    expect(html).not.toMatch(/<(img|link)\b/)
    expect(html).toContain('Hadimba Devi Temple')
    expect(html).toContain('free entry (as mapped)')
    expect(html).toContain('Thermals')
  })

  it('carries the guide: likely cost, stay levels, food and things to do, all marked as estimates', () => {
    const guide = {
      currency: 'INR', origin: 'Delhi',
      destinations: [{ destination: 'Manali', stay: [{ area: 'Old Manali', why: 'Cafés and quiet lanes', tiers: [{ tier: 'budget', kind: 'guest house', per_night: { min: 1000, max: 2000 } }] }],
        food: [{ dish: 'Siddu', what: 'Steamed bread', where: 'Johnson’s Cafe', per_person: { min: 150, max: 250 } }],
        things: [{ name: 'Paragliding', what: 'Over Solang', where: 'Solang Valley', cost: { min: 2000, max: 3500 }, per: 'person', tip: 'Go before noon' }],
        around: [{ mode: 'Local bus', fare: { min: 20, max: 60 } }], tips: ['Carry cash'] }],
      getting_there: [{ mode: 'bus', hours: 13, fare: { min: 1200, max: 2000 } }],
    }
    const estimate = { tier: 'budget', total: [20000, 30000], status: 'fits', parts: { stay: [3000, 6000], food: [6000, 9000], local: [800, 1600], things: [4000, 7000], getting_there: [4800, 8000] } }
    const html = buildTripPack({ trip, sum, guide, estimate })
    expect(html).toContain('≈ ₹20k–30k')
    expect(html).toContain('which fits the budget')
    expect(html).toContain('Budget: guest house, ≈ ₹1k–2k a night')
    expect(html).toContain('Siddu')
    expect(html).toContain('Johnson’s Cafe')
    expect(html).toContain('Paragliding')
    expect(html).toContain('Getting there from Delhi')
    expect(html).toContain('not live prices')
  })

  it('works without a budget or anything nearby', () => {
    const html = buildTripPack({ trip: { ...trip, budget: { total: null } }, sum: { currency: 'INR', budget_total: null } })
    expect(html).not.toContain('Budget plan')
    expect(html).toContain('Day by day')
  })

  it('names the file after the trip', () => {
    expect(packFileName({ title: 'Kyoto & Osaka: 5 days' })).toBe('kyoto-osaka-5-days-trip-pack.html')
    expect(packFileName({ title: '' })).toBe('trip-trip-pack.html')
  })
})
