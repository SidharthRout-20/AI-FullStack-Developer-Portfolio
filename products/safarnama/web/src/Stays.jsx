/**
 * Places to stay, for the guide's "Where you'll stay" (Guidebook.jsx): the booking sites with the dates already in,
 * and a shortlist of real places to stay near where the days happen (OpenStreetMap: hotels, guest houses, hostels…),
 * filtered to the stay level chosen. Prices, reviews and availability live on the booking sites; a star rating is
 * shown only where one is mapped.
 */
import { BadgeCheck, BedDouble, Bookmark, BookmarkCheck, ExternalLink, FlaskConical, MapPin, Star } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { errorText } from '@appcore/web/http'
import { ErrorNote, Spinner } from '@appcore/web/ui'
import { bookingLinks, googleHotels } from './booking'
import { destinationInfo } from './choices'
import { placeToSaved, safeLink, stopsCentre } from './logic'
import { shortMoney, wholeMoney } from './money'
import { LEVELS, levelFor } from './guideKit'

const KINDS = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'homely', label: 'Homestays & guest houses', match: (p) => ['guest house', 'apartment', 'chalet', 'alpine hut'].includes(p.category) },
  { id: 'hostel', label: 'Hostels', match: (p) => p.category === 'hostel' },
  { id: 'hotel', label: 'Hotels', match: (p) => ['hotel', 'motel'].includes(p.category) },
]
const KIND_LABEL = { hotel: 'Hotel', 'guest house': 'Guest house', hostel: 'Hostel', motel: 'Motel', apartment: 'Apartment', chalet: 'Chalet', 'alpine hut': 'Mountain hut' }
const km = (m) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`)

/** The booking sites for this destination, dates and guests filled in (the stay group of the booking hand-offs). */
export function StayLinks({ place, adults }) {
  const links = bookingLinks({ place, adults, info: destinationInfo(place.name) }).find((g) => g.id === 'stay')?.items ?? []
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {links.map((l) => (
        <a key={l.provider} href={l.url} target="_blank" rel="noopener noreferrer" className="pc-pill inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[12.5px] font-semibold">
          <ExternalLink className="size-3.5" /> {l.label}
        </a>
      ))}
      <p className="w-full text-[11.5px] opacity-75">Google opens with your dates filled in (set the guests there); on the others, check the dates once you're there. Nothing is booked until you confirm on their site.</p>
    </div>
  )
}

export function Shortlist({ trip, api, dest, window: w, perNight, currency, setNote, filter, limit = 18 }) {
  const [res, setRes] = useState(null)
  const [error, setError] = useState(null)
  const [kind, setKind] = useState('all')
  const [saved, setSaved] = useState(() => new Set())
  const centre = useMemo(() => stopsCentre(trip, dest), [trip, dest])
  useEffect(() => {
    let alive = true
    Promise.all([api.discover({ group: 'stay', lat: centre.lat, lng: centre.lng }), api.places().catch(() => [])])
      .then(([r, places]) => {
        if (!alive) return
        setRes(r)
        setSaved(new Set(places.filter((p) => p.group === 'stay').map((p) => p.osm_id ?? p.name.toLowerCase())))
      })
      .catch((e) => alive && setError(errorText(e)))
    return () => {
      alive = false
    }
  }, [api, centre.lat, centre.lng])

  // The stay level's kinds first (when any are mapped here), otherwise everything nearby.
  const pool = useMemo(() => {
    const all = res?.places ?? []
    return filter && all.some(filter) ? all.filter(filter) : all
  }, [res, filter])
  const counts = useMemo(() => Object.fromEntries(KINDS.map((k) => [k.id, pool.filter(k.match).length])), [pool])
  const shown = pool.filter(KINDS.find((k) => k.id === kind).match).slice(0, limit)
  const save = async (p) => {
    try {
      await api.savePlace(placeToSaved(p, dest.id))
      setSaved((s) => new Set(s).add(p.osm_id ?? p.name.toLowerCase()))
      setNote(`${p.name} is on your shortlist; it goes into the trip pack.`)
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <section className="ui-card rounded-2xl border border-white/[0.07] p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="pc-head flex items-center gap-2 text-[20px] text-white"><BedDouble className="size-5" /> Places to stay near your plan</h3>
        <p className="text-[12px] text-ink-400">Within about 2.5 km of where your days happen</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Kind of stay">
        {KINDS.filter((k) => k.id === 'all' || counts[k.id] > 0).map((k) => (
          <button key={k.id} type="button" aria-pressed={kind === k.id} onClick={() => setKind(k.id)} className={`chip ${kind === k.id ? 'pa-on' : ''}`}>{k.label} <span className="tabular-nums opacity-70">{counts[k.id]}</span></button>
        ))}
      </div>
      <ErrorNote message={error} />
      {!res && !error && <div className="mt-3"><Spinner label="Finding places to stay on the map…" /></div>}
      {res && shown.length === 0 && <p className="mt-3 text-[13px] text-ink-400">No places to stay are mapped here yet. The booking sites above list many more.</p>}
      <ul className="mt-3 grid gap-2.5 sm:grid-cols-2">
        {shown.map((p) => {
          const isSaved = saved.has(p.osm_id ?? p.name.toLowerCase())
          const where = `${p.name}, ${dest.name}`
          return (
            <li key={`${p.name}-${p.lat}`} className="rounded-2xl border border-white/[0.07] p-3.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[14.5px] leading-tight font-semibold text-white">{p.name}</p>
                  <p className="mt-0.5 text-[12px] text-ink-400">
                    {KIND_LABEL[p.category] ?? 'Stay'}
                    {p.stars ? ` · ${p.stars}-star (as mapped)` : ''} · {km(p.distance_m)} from your plan
                  </p>
                </div>
                <button type="button" aria-label={isSaved ? `${p.name} is shortlisted` : `Shortlist ${p.name}`} aria-pressed={isSaved} disabled={isSaved} onClick={() => void save(p)}
                  className={`grid size-8 shrink-0 place-items-center rounded-full ${isSaved ? 'bg-[var(--pc-1)] text-[var(--pc-on-1)]' : 'pc-round'}`}>
                  {isSaved ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}
                </button>
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <a className="chip" href={googleHotels(where, { checkin: w.checkin, checkout: w.checkout })} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-3" /> Prices and reviews</a>
                <a className="chip" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.lat},${p.lng}`)}`} target="_blank" rel="noopener noreferrer"><MapPin className="size-3" /> Map</a>
                {safeLink(p.website) && <a className="chip" href={p.website} target="_blank" rel="noopener noreferrer">Website</a>}
              </div>
            </li>
          )
        })}
      </ul>
      <p className="mt-3 text-[11.5px] text-ink-500">
        From OpenStreetMap contributors. Prices, reviews and availability aren't in free map data: "Prices and reviews" opens Google with your dates{perNight ? `, where you can set ${shortMoney(perNight, currency)} as the top price` : ''}.
      </p>
    </section>
  )
}

/**
 * Live prices for the stay (LiteAPI by Nuitee): real hotels near the plan with what the stay costs for these dates and
 * guests, cheapest first, each placed in a stay level; "Book" opens the hotel on the booking site with everything
 * filled in. One search per tap (cached on the server for 30 minutes). With a sandbox key the prices are test
 * prices, and the panel says so.
 */
export function LiveStays({ api, destIndex, tier, tiers, live, dates }) {
  const [res, setRes] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [all, setAll] = useState(false)
  const load = async () => {
    setBusy(true)
    setError(null)
    try {
      setRes(await api.liveStays(destIndex))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const hotels = (res?.hotels ?? []).map((h) => ({ ...h, level: levelFor(h.per_night, tiers) }))
  const mine = hotels.filter((h) => h.level === tier)
  const shown = (all || mine.length === 0 ? hotels : mine).slice(0, 12)
  const label = LEVELS.find((l) => l.id === tier)?.label
  return (
    <section className="ui-card rounded-2xl border border-white/[0.07] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="pc-head flex items-center gap-2 text-[20px] text-white"><BadgeCheck className="size-5" /> Live prices for your dates</h3>
          <p className="mt-1 text-[12.5px] text-ink-400">{res ? `${res.nights} night${res.nights === 1 ? '' : 's'}, ${res.people} guest${res.people === 1 ? '' : 's'} in ${res.rooms} room${res.rooms === 1 ? '' : 's'}` : dates}. Real hotels near your plan; you book on the booking site, where the final price is shown.</p>
        </div>
        {live.sandbox && <span className="pc-chip ring-1 ring-current"><FlaskConical className="size-3.5" /> Test prices (sandbox)</span>}
      </div>
      {!res && (
        <button type="button" disabled={busy} onClick={() => void load()} className="pc-pill mt-3 inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-semibold disabled:opacity-60">
          {busy ? 'Checking prices…' : 'Show live prices'}
        </button>
      )}
      <ErrorNote message={error} />
      {res && hotels.length === 0 && <p className="mt-3 text-[13px] text-ink-400">No rooms came back for these dates near your plan. Try the booking sites above.</p>}
      {res && hotels.length > 0 && (
        <>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {mine.length > 0 && <button type="button" aria-pressed={!all} onClick={() => setAll(false)} className={`chip ${!all ? 'pa-on' : ''}`}>{label} ({mine.length})</button>}
            <button type="button" aria-pressed={all || mine.length === 0} onClick={() => setAll(true)} className={`chip ${all || mine.length === 0 ? 'pa-on' : ''}`}>All ({hotels.length})</button>
          </div>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((h) => (
              <li key={h.id} className="flex flex-col overflow-hidden rounded-2xl border border-white/[0.07]">
                {h.photo ? <img src={h.photo} alt={h.name} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="h-36 w-full object-cover" /> : <div className="grid h-36 place-items-center bg-white/[0.04]"><BedDouble className="size-8 text-ink-500" /></div>}
                <div className="flex flex-1 flex-col p-3.5">
                  <p className="text-[14.5px] leading-tight font-semibold text-white">{h.name}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-400">
                    {h.stars > 0 && <span className="inline-flex items-center gap-0.5"><Star className="size-3" /> {h.stars}-star</span>}
                    {h.rating != null && <span>Guests {h.rating}/10{h.reviews ? ` (${h.reviews})` : ''}</span>}
                    {h.level && <span className="font-semibold text-ink-200">{LEVELS.find((l) => l.id === h.level)?.label}</span>}
                  </p>
                  <p className="mt-1 text-[12px] text-ink-400">{[h.board, h.refundable ? 'Free cancellation' : 'Non-refundable'].filter(Boolean).join(' · ')}</p>
                  <div className="mt-auto flex items-end justify-between gap-2 pt-3">
                    <p>
                      <span className="pc-head block text-[22px] leading-none text-white">{wholeMoney(h.total, h.currency)}</span>
                      <span className="text-[11.5px] text-ink-400">{shortMoney(h.per_night, h.currency)} a night, all rooms</span>
                    </p>
                    {h.book_url ? (
                      <a href={h.book_url} target="_blank" rel="noopener noreferrer" className="pc-pill inline-flex items-center gap-1 rounded-full px-3.5 py-2 text-[12.5px] font-semibold"><ExternalLink className="size-3.5" /> Book</a>
                    ) : (
                      <a href={googleHotels(`${h.name}`, { checkin: res.checkin, checkout: res.checkout })} target="_blank" rel="noopener noreferrer" className="chip"><ExternalLink className="size-3" /> Check on Google</a>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11.5px] text-ink-500">
            {res.sandbox ? 'Test prices from the LiteAPI sandbox: real hotels, not real prices. ' : 'Live prices from LiteAPI by Nuitee. '}
            As of {new Date(res.fetched_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}; rooms and prices change until you book.{!res.booking_site && ' Booking opens here once the booking site is connected.'}
          </p>
        </>
      )}
    </section>
  )
}
