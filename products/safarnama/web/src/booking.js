/**
 * Free booking hand-offs: pre-filled searches on the providers' own sites (no API keys, no fees, no affiliate account
 * needed). Safarnaama never books, holds or pays for anything: the traveller finishes on the provider's site and can
 * then save the confirmation with the trip. Pure helpers, unit-tested in booking.test.js.
 *
 * `prefilled` says what we checked: true = the provider opened with the place, dates and guests filled in when the
 * link was tested in a browser; 'dates' = the place and dates, but the guests need setting there (Google Hotels);
 * 'place' = it opens the right search but dates may need re-entering; false = built from
 * the provider's public URL pattern but not verifiable automatically (the site blocks automated browsers).
 *
 * To earn commission later, join a provider's affiliate programme and add its tracking parameter in AFFILIATE below.
 */

/** Affiliate tracking parameters per provider (empty = none). Example: { booking: { aid: '123456' } }. */
export const AFFILIATE = {}

const enc = encodeURIComponent
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const mmdd = (iso) => (iso ? `${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(0, 4)}` : '')
const withAffiliate = (provider, url) => {
  const extra = AFFILIATE[provider]
  if (!extra) return url
  const u = new URL(url)
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v)
  return u.toString()
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** "14 December 2026": how Google's travel search reads a date written into the query. */
export const longDate = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`

/**
 * A Google Hotels search for `what` with the dates written into the query. Checked in a browser (Nov 2026): Google
 * ignores checkin/checkout parameters but reads dates from the text; it reads the guest count from neither, so the
 * traveller sets that on Google.
 */
export function googleHotels(what, { checkin, checkout } = {}) {
  const dates = checkin && checkout ? ` from ${longDate(checkin)} to ${longDate(checkout)}` : ''
  return `https://www.google.com/travel/search?q=${enc(`${what}${dates}`)}`
}

/** Day after an ISO date (checkout after the last night). */
export function dayAfter(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + 1))
  return t.toISOString().slice(0, 10)
}

/**
 * The stay window for each destination of a trip: check in on its first day, check out the morning after its last,
 * except at the end of the trip, where the last day is the day you leave (a 4-day trip is 4 days, 3 nights, as the
 * budget plan counts it). A destination with no night has no dates; neither do undated days (the links still open
 * the right city).
 */
export function stays(trip) {
  const dests = trip.destinations?.length ? trip.destinations : trip.city ? [{ ...trip.city, start_day: 1, end_day: trip.days.length }] : []
  return dests.map((d, i) => {
    const end = i === dests.length - 1
    const nights = d.end_day - d.start_day + (end ? 0 : 1)
    const first = trip.days.find((x) => x.day === d.start_day)?.date ?? null
    const last = trip.days.find((x) => x.day === d.end_day)?.date ?? null
    const dated = !!(first && last && nights > 0)
    return { name: d.name, country: d.country ?? '', checkin: dated ? first : null, checkout: dated ? (end ? last : dayAfter(last)) : null, nights }
  })
}

/**
 * Booking links for one destination, grouped. `place` = { name, country, checkin, checkout }, `adults` ≥ 1,
 * `from` = where the traveller sets off (optional), `info` = optional known codes { iata, mmt, airport }.
 */
export function bookingLinks({ place, adults = 2, from = '', info = {} }) {
  const { name, country, checkin, checkout } = place
  const where = country && country !== name ? `${name}, ${country}` : name
  const india = /^india$/i.test(country ?? '')
  const dated = !!(checkin && checkout)
  const n = Math.max(1, Math.min(adults || 2, 16))
  const groups = []

  const stay = [
    {
      provider: 'google', label: 'Google Hotels', prefilled: 'dates',
      url: googleHotels(`hotels in ${where}`, { checkin, checkout }),
    },
    {
      provider: 'airbnb', label: 'Airbnb', prefilled: false,
      url: `https://www.airbnb.com/s/${enc(where.replace(/,\s*/g, '--').replace(/\s+/g, '-'))}/homes?${dated ? `checkin=${checkin}&checkout=${checkout}&` : ''}adults=${n}`,
    },
    {
      provider: 'booking', label: 'Booking.com', prefilled: 'place',
      url: `https://www.booking.com/searchresults.html?ss=${enc(where)}${dated ? `&checkin=${checkin}&checkout=${checkout}` : ''}&group_adults=${n}&no_rooms=1&group_children=0`,
    },
  ]
  if (india) {
    stay.splice(1, 0, info.mmt
      ? {
          provider: 'makemytrip', label: 'MakeMyTrip', prefilled: false,
          url: `https://www.makemytrip.com/hotels/hotel-listing/?${dated ? `checkin=${mmdd(checkin)}&checkout=${mmdd(checkout)}&` : ''}city=${info.mmt}&country=IN&locusId=${info.mmt}&locusType=city&roomStayQualifier=${n}e0e&searchText=${enc(name)}`,
        }
      : { provider: 'makemytrip', label: 'MakeMyTrip', prefilled: false, url: `https://www.makemytrip.com/hotels/${slug(name)}-hotels.html` })
  }
  groups.push({ id: 'stay', title: 'Stay', items: stay })

  if (from.trim()) {
    const to = info.airport ? info.iata : name
    const go = [
      {
        provider: 'google-flights', label: 'Google Flights', prefilled: true,
        url: `https://www.google.com/travel/flights?q=${enc(`Flights to ${to} from ${from.trim()}${checkin ? ` on ${checkin}` : ''}${checkout ? ` through ${checkout}` : ''} for ${n} adults`)}`,
      },
    ]
    if (india) {
      go.push(
        { provider: 'irctc', label: 'Trains on IRCTC', prefilled: false, url: 'https://www.irctc.co.in/nget/train-search' },
        { provider: 'redbus', label: 'Buses on redBus', prefilled: false, url: `https://www.redbus.in/bus-tickets/${slug(from)}-to-${slug(name)}` },
      )
    }
    groups.push({ id: 'travel', title: info.airport ? `Getting there (nearest airport: ${info.airport})` : 'Getting there', items: go })
  }

  groups.push({
    id: 'do', title: 'Things to do',
    items: [
      { provider: 'getyourguide', label: 'GetYourGuide', prefilled: 'place', url: `https://www.getyourguide.com/s/?q=${enc(name)}${dated ? `&date_from=${checkin}&date_to=${checkout}` : ''}` },
      { provider: 'google-maps', label: 'Google Maps', prefilled: true, url: `https://www.google.com/maps/search/${enc(`things to do in ${where}`).replace(/%20/g, '+')}` },
    ],
  })
  groups.push({
    id: 'eat', title: 'Tables',
    items: [{ provider: 'google-maps', label: 'Restaurants on Google Maps', prefilled: true, url: `https://www.google.com/maps/search/${enc(`restaurants in ${where}`).replace(/%20/g, '+')}` }],
  })
  return groups.map((g) => ({ ...g, items: g.items.map((i) => ({ ...i, url: withAffiliate(i.provider, i.url) })) }))
}
