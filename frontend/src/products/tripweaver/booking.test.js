import { describe, expect, it } from 'vitest'
import { bookingLinks, dayAfter, stays } from './booking'
import { destinationInfo } from './choices'

const jaipur = { name: 'Jaipur', country: 'India', checkin: '2026-11-23', checkout: '2026-11-26' }
const find = (groups, id, provider) => groups.find((g) => g.id === id)?.items.find((i) => i.provider === provider)

describe('Safarnama booking hand-offs', () => {
  it('works out each destination’s stay from the itinerary dates', () => {
    const trip = {
      destinations: [{ name: 'Lisbon', country: 'Portugal', start_day: 1, end_day: 2 }, { name: 'Porto', country: 'Portugal', start_day: 3, end_day: 3 }],
      days: [{ day: 1, date: '2026-12-30' }, { day: 2, date: '2026-12-31' }, { day: 3, date: '2027-01-01' }],
    }
    expect(stays(trip)).toEqual([
      { name: 'Lisbon', country: 'Portugal', checkin: '2026-12-30', checkout: '2027-01-01', nights: 2 },
      { name: 'Porto', country: 'Portugal', checkin: '2027-01-01', checkout: '2027-01-02', nights: 1 },
    ])
    expect(dayAfter('2028-02-28')).toBe('2028-02-29')
    expect(stays({ city: { name: 'Goa' }, days: [{ day: 1, date: null }] })[0]).toMatchObject({ checkin: null, checkout: null })
  })

  it('pre-fills place, dates and guests on the providers that accept them', () => {
    const g = bookingLinks({ place: jaipur, adults: 2, info: destinationInfo('Jaipur') })
    expect(find(g, 'stay', 'google').url).toBe('https://www.google.com/travel/search?q=hotels%20in%20Jaipur%2C%20India&checkin=2026-11-23&checkout=2026-11-26&adults=2')
    expect(find(g, 'stay', 'airbnb').url).toBe('https://www.airbnb.com/s/Jaipur--India/homes?checkin=2026-11-23&checkout=2026-11-26&adults=2')
    expect(find(g, 'stay', 'booking').url).toContain('ss=Jaipur%2C%20India&checkin=2026-11-23&checkout=2026-11-26&group_adults=2')
  })

  it('offers MakeMyTrip for Indian destinations (dated search where the city code is known)', () => {
    const mmt = find(bookingLinks({ place: jaipur, adults: 3, info: destinationInfo('Jaipur') }), 'stay', 'makemytrip')
    expect(mmt.url).toBe('https://www.makemytrip.com/hotels/hotel-listing/?checkin=11232026&checkout=11262026&city=CTJAI&country=IN&locusId=CTJAI&locusType=city&roomStayQualifier=3e0e&searchText=Jaipur')
    expect(mmt.prefilled).toBe(false) // not verifiable automatically: say so in the UI
    const munnar = find(bookingLinks({ place: { name: 'Munnar', country: 'India' }, info: destinationInfo('Munnar') }), 'stay', 'makemytrip')
    expect(munnar.url).toBe('https://www.makemytrip.com/hotels/munnar-hotels.html')
    expect(find(bookingLinks({ place: { name: 'Lisbon', country: 'Portugal' } }), 'stay', 'makemytrip')).toBeUndefined()
  })

  it('adds travel options only once we know where the trip starts', () => {
    expect(bookingLinks({ place: jaipur }).some((g) => g.id === 'travel')).toBe(false)
    const g = bookingLinks({ place: { name: 'Munnar', country: 'India', checkin: '2026-11-23', checkout: '2026-11-26' }, from: 'Bengaluru', info: destinationInfo('Munnar') })
    const travel = g.find((x) => x.id === 'travel')
    expect(travel.title).toBe('Getting there (nearest airport: Kochi (COK))')
    expect(decodeURIComponent(find(g, 'travel', 'google-flights').url)).toContain('Flights to COK from Bengaluru on 2026-11-23 through 2026-11-26 for 2 adults')
    expect(find(g, 'travel', 'redbus').url).toBe('https://www.redbus.in/bus-tickets/bengaluru-to-munnar')
  })

  it('only ever links to https provider sites', () => {
    for (const g of bookingLinks({ place: jaipur, from: 'Delhi', info: destinationInfo('Jaipur') }))
      for (const i of g.items) expect(i.url).toMatch(/^https:\/\/(www\.)?(google|airbnb|booking|makemytrip|irctc|redbus|getyourguide)\.(com|co\.in|in)\//)
  })
})
