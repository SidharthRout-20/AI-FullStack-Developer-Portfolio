/**
 * Safarnama's quick planner: a whole trip from four taps (where → when → who → plan), no typing needed.
 * Pure helpers (unit-tested in choices.test.js). The choices become a precise request for the existing AI planner
 * (POST /api/trips/plan), so places, weather and routes still come from real provider data.
 *
 * The destination pool is a hand-picked list of real places with a short, general description each. It names no
 * businesses and makes no claims about prices, ratings or availability.
 */

/**
 * months: when the place is at its best (1–12). days: a comfortable first visit. iata/airport: the nearest passenger
 * airport (for flight searches). mmt: MakeMyTrip's city code, where known (for its pre-filled hotel search).
 */
export const DESTINATIONS = [
  { name: 'Goa', iata: 'GOI', airport: 'Goa (GOI)', mmt: 'CTGOI', country: 'India', hook: 'Beaches, Portuguese-era churches and seafood', days: 4, tags: ['beaches', 'food', 'nightlife'], months: [11, 12, 1, 2, 3], tint: 'from-amber-400 via-orange-500 to-rose-500' },
  { name: 'Jaipur', iata: 'JAI', airport: 'Jaipur (JAI)', mmt: 'CTJAI', country: 'India', hook: 'Forts, palaces and bazaars of the Pink City', days: 3, tags: ['heritage', 'shopping', 'food'], months: [10, 11, 12, 1, 2, 3], tint: 'from-rose-400 via-pink-500 to-orange-400' },
  { name: 'Udaipur', iata: 'UDR', airport: 'Udaipur (UDR)', mmt: 'CTUDR', country: 'India', hook: 'Lakes, palaces and sunset rooftops', days: 3, tags: ['heritage', 'romance', 'photography'], months: [9, 10, 11, 12, 1, 2, 3], tint: 'from-sky-400 via-indigo-500 to-violet-500' },
  { name: 'Varanasi', iata: 'VNS', airport: 'Varanasi (VNS)', mmt: 'CTVNS', country: 'India', hook: 'Ghats, dawn boat rides and the evening aarti', days: 2, tags: ['culture', 'spiritual', 'food'], months: [10, 11, 12, 1, 2, 3], tint: 'from-orange-400 via-amber-500 to-yellow-400' },
  { name: 'Rishikesh', iata: 'DED', airport: 'Dehradun (DED)', country: 'India', hook: 'Yoga, river rafting and foothill trails', days: 3, tags: ['wellness', 'adventure', 'nature'], months: [9, 10, 11, 2, 3, 4, 5], tint: 'from-emerald-400 via-teal-500 to-cyan-500' },
  { name: 'Munnar', iata: 'COK', airport: 'Kochi (COK)', country: 'India', hook: 'Tea estates, misty hills and spice gardens', days: 3, tags: ['nature', 'relaxed', 'photography'], months: [9, 10, 11, 12, 1, 2, 3, 4, 5], tint: 'from-lime-400 via-green-500 to-emerald-600' },
  { name: 'Alappuzha', iata: 'COK', airport: 'Kochi (COK)', country: 'India', hook: 'Kerala backwaters, by houseboat', days: 2, tags: ['nature', 'relaxed', 'food'], months: [9, 10, 11, 12, 1, 2, 3], tint: 'from-teal-400 via-emerald-500 to-green-600' },
  { name: 'Hampi', iata: 'VDY', airport: 'Vijayanagar (VDY)', country: 'India', hook: 'Boulder hills and Vijayanagara temple ruins', days: 2, tags: ['heritage', 'photography', 'adventure'], months: [10, 11, 12, 1, 2], tint: 'from-amber-500 via-orange-600 to-red-600' },
  { name: 'Puducherry', iata: 'MAA', airport: 'Chennai (MAA)', country: 'India', hook: 'French Quarter lanes, cafés and quiet beaches', days: 3, tags: ['food', 'beaches', 'relaxed'], months: [10, 11, 12, 1, 2, 3], tint: 'from-yellow-300 via-amber-400 to-orange-500' },
  { name: 'Leh', iata: 'IXL', airport: 'Leh (IXL)', mmt: 'CTIXL', country: 'India', hook: 'High passes, monasteries and mountain lakes', days: 5, tags: ['adventure', 'nature', 'photography'], months: [6, 7, 8, 9], tint: 'from-sky-400 via-blue-500 to-indigo-600' },
  { name: 'Darjeeling', iata: 'IXB', airport: 'Bagdogra (IXB)', country: 'India', hook: 'The toy train, tea gardens and Himalayan views', days: 3, tags: ['nature', 'heritage', 'relaxed'], months: [3, 4, 5, 10, 11], tint: 'from-green-400 via-emerald-500 to-teal-600' },
  { name: 'Kodagu', iata: 'IXE', airport: 'Mangaluru (IXE)', country: 'India', hook: 'Coffee estates, waterfalls and misty forests', days: 3, tags: ['nature', 'relaxed', 'food'], months: [10, 11, 12, 1, 2, 3, 4, 5], tint: 'from-emerald-500 via-green-600 to-lime-500' },
  { name: 'Kyoto', iata: 'KIX', airport: 'Osaka Kansai (KIX)', country: 'Japan', hook: 'Temples, tea houses and old wooden streets', days: 4, tags: ['culture', 'food', 'heritage'], months: [3, 4, 5, 10, 11], tint: 'from-pink-400 via-rose-500 to-red-500' },
  { name: 'Lisbon', iata: 'LIS', airport: 'Lisbon (LIS)', country: 'Portugal', hook: 'Viewpoints, old trams and food markets', days: 3, tags: ['food', 'culture', 'photography'], months: [4, 5, 6, 9, 10], tint: 'from-yellow-400 via-amber-500 to-sky-500' },
  { name: 'Bali', iata: 'DPS', airport: 'Denpasar (DPS)', country: 'Indonesia', hook: 'Rice terraces, temples and surf beaches', days: 5, tags: ['beaches', 'wellness', 'nature'], months: [4, 5, 6, 7, 8, 9, 10], tint: 'from-emerald-400 via-cyan-500 to-blue-500' },
  { name: 'Singapore', iata: 'SIN', airport: 'Singapore (SIN)', country: 'Singapore', hook: 'Hawker food, gardens and a skyline by the bay', days: 3, tags: ['food', 'family', 'shopping'], months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], tint: 'from-red-400 via-rose-500 to-fuchsia-500' },
  { name: 'Istanbul', iata: 'IST', airport: 'Istanbul (IST)', country: 'Türkiye', hook: 'Bazaars, mosques and ferries on the Bosphorus', days: 4, tags: ['culture', 'food', 'shopping'], months: [4, 5, 9, 10, 11], tint: 'from-indigo-400 via-violet-500 to-fuchsia-500' },
  { name: 'Kathmandu', iata: 'KTM', airport: 'Kathmandu (KTM)', country: 'Nepal', hook: 'Durbar squares, stupas and mountain views', days: 4, tags: ['culture', 'heritage', 'adventure'], months: [3, 4, 10, 11], tint: 'from-red-500 via-orange-500 to-amber-400' },
]

/** Interest chips (what the trip is about) and special requests (how to plan it). */
export const INTERESTS = {
  beaches: 'Beaches', food: 'Local food', nightlife: 'Nightlife', heritage: 'Heritage', shopping: 'Markets & shopping',
  romance: 'Romantic spots', photography: 'Photo spots', culture: 'Culture', spiritual: 'Spiritual sites',
  wellness: 'Wellness & yoga', adventure: 'Adventure', nature: 'Nature', relaxed: 'Slow travel', family: 'Kid-friendly',
}  // prettier-ignore
export const REQUESTS = [
  { id: 'veg', label: 'Vegetarian food', text: 'vegetarian food only' },
  { id: 'slow', label: 'Slow mornings', text: 'no early starts', pace: 'relaxed' },
  { id: 'packed', label: 'Pack it in', text: 'see as much as possible', pace: 'packed' },
  { id: 'budget', label: 'On a budget', text: 'keep costs low, prefer free sights' },
  { id: 'nodrive', label: 'Short hops', text: 'avoid long drives between stops' },
  { id: 'access', label: 'Step-free', text: 'step-free, accessible places where possible' },
]

export const PARTIES = [
  { id: 'solo', label: 'Just me', travellers: 1 },
  { id: 'couple', label: 'The two of us', travellers: 2 },
  { id: 'family', label: 'Family with kids', travellers: 4 },
  { id: 'friends', label: 'Friends', travellers: 4 },
]

/** Small deterministic PRNG so "show me others" is stable in tests. */
function rng(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** n destinations, in-season ones first (this month or next), shuffled by seed. */
export function suggestDestinations(month, seed = 1, n = 6, pool = DESTINATIONS) {
  const next = (month % 12) + 1
  const rand = rng(seed)
  const shuffle = (list) => list.map((d) => [rand(), d]).sort((a, b) => a[0] - b[0]).map(([, d]) => d)
  const inSeason = pool.filter((d) => d.months.includes(month) || d.months.includes(next))
  const rest = pool.filter((d) => !inSeason.includes(d))
  return [...shuffle(inSeason), ...shuffle(rest)].slice(0, n)
}

const pad = (n) => String(n).padStart(2, '0')
/** Local calendar date as YYYY-MM-DD (not toISOString, which is UTC). */
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const fmt = (d, withMonth) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', ...(withMonth ? { month: 'short' } : {}) })
export const rangeText = (start, days) => {
  const end = addDays(start, days - 1)
  return days === 1 ? fmt(start, true) : `${fmt(start, start.getMonth() !== end.getMonth())} – ${fmt(end, true)}`
}

/** One-tap date choices. Lengths follow the destination's comfortable stay (weekends are two days). */
export function whenOptions(today, idealDays) {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const dow = t.getDay() // 0 Sun … 6 Sat
  const sat = addDays(t, (6 - dow + 7) % 7 || 7)
  const mon = addDays(t, (1 - dow + 7) % 7 || 7)
  const firstOfNext = new Date(t.getFullYear(), t.getMonth() + 1, 1)
  const nextMonthSat = addDays(firstOfNext, (6 - firstOfNext.getDay() + 7) % 7)
  const days = Math.min(Math.max(idealDays, 2), 10) // the planner plans up to 10 days
  return [
    { id: 'weekend', label: 'This weekend', start: sat, days: 2 },
    { id: 'next-week', label: 'Next week', start: mon, days },
    { id: 'in-two-weeks', label: 'In two weeks', start: addDays(mon, 7), days },
    { id: 'next-month', label: nextMonthSat.toLocaleDateString('en-GB', { month: 'long' }), start: nextMonthSat, days: Math.min(days + 1, 10) },
  ].map((o) => ({ ...o, range: rangeText(o.start, o.days) }))
}

/**
 * The request for the AI planner. Every choice is spelled out (explicit dates, party, pace) so the planner does not
 * have to guess. Stays within the API's 10–1000 character limit.
 */
export function composePrompt({ dest, when, party, interests = [], requests = [], note = '' }) {
  const p = PARTIES.find((x) => x.id === party) ?? PARTIES[1]
  const reqs = REQUESTS.filter((r) => requests.includes(r.id))
  const pace = reqs.find((r) => r.pace)?.pace ?? (interests.includes('relaxed') ? 'relaxed' : 'balanced')
  const end = addDays(when.start, when.days - 1)
  const where = dest.country && dest.country !== dest.name ? `${dest.name}, ${dest.country}` : dest.name
  const who = { solo: 'travelling solo (1 traveller)', couple: 'for a couple (2 travellers)', family: 'for a family with kids (4 travellers)', friends: 'for a group of friends (4 travellers)' }[p.id]  // prettier-ignore
  const parts = [
    `${when.days} days in ${where}, from ${isoDate(when.start)} to ${isoDate(end)}, ${who}.`,
    interests.length ? `Interests: ${interests.map((i) => (INTERESTS[i] ?? i).toLowerCase()).join(', ')}.` : '',
    `Pace: ${pace}.`,
    reqs.length ? `Special requests: ${reqs.map((r) => r.text).join('; ')}.` : '',
    p.id === 'family' ? 'Keep it kid-friendly.' : '',
    note.trim() ? `Note from the traveller: ${note.trim().slice(0, 300)}` : '',
  ]
  return parts.filter(Boolean).join(' ').slice(0, 1000)
}

/** A destination typed by hand ("Somewhere else"): a city and, optionally, a country after a comma. */
export function customDestination(text) {
  const [name, country] = text.split(',').map((s) => s.trim())
  if (!name || name.length < 2) return null
  return { name: name.slice(0, 80), country: (country ?? '').slice(0, 60), hook: '', days: 3, tags: ['food', 'culture'], months: [], tint: 'from-slate-400 via-slate-500 to-slate-600' }
}

/** Known details (airport, booking codes) for a destination by name; {} for places typed by hand. */
export const destinationInfo = (name) => DESTINATIONS.find((d) => d.name.toLowerCase() === String(name ?? '').trim().toLowerCase()) ?? {}
