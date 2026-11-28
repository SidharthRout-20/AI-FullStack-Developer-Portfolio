/**
 * "Book this trip": free, pre-filled searches on the providers' own sites (MakeMyTrip, Booking.com, Airbnb, Google…)
 * for every destination and its dates. Each opens through the hand-off dialog; when the traveller comes back, the trip
 * asks whether they booked (see AwayCheck) and saves it in a tap. Safarnaama never books or pays for anything.
 */
import { ArrowUpRight, BedDouble, Plane, Ticket, UtensilsCrossed } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Card, inputClass } from '@appcore/web/ui'
import { bookingLinks, stays } from './booking'
import { destinationInfo } from './choices'
import { dateRange } from './logic'
import { Handoff } from './parts'
import { PlaceImage } from './Visuals'

const FROM_KEY = 'safarnama-from'
const CITIES = ['Bengaluru', 'Mumbai', 'Delhi', 'Chennai', 'Hyderabad', 'Kolkata', 'Pune', 'Ahmedabad', 'Kochi', 'Jaipur', 'Goa']
const GROUP_ICON = { stay: BedDouble, travel: Plane, do: Ticket, eat: UtensilsCrossed }
const BOOKING_TYPE = { stay: 'hotel', travel: 'flight', do: 'activity', eat: 'restaurant' }
const TYPE_FOR = { irctc: 'train', redbus: 'bus' }

const readFrom = () => {
  try {
    return localStorage.getItem(FROM_KEY) ?? ''
  } catch {
    return ''
  }
}

export function BookPanel({ trip }) {
  const [from, setFrom] = useState(readFrom)
  const [open, setOpen] = useState(null) // the link being handed off
  const places = useMemo(() => stays(trip), [trip])
  const adults = trip.party?.travellers ?? (trip.party?.type === 'solo' ? 1 : 2)
  const saveFrom = (v) => {
    setFrom(v)
    try {
      localStorage.setItem(FROM_KEY, v)
    } catch {
      /* private mode */
    }
  }
  if (!places.length) return null

  return (
    <Card className="!p-0 overflow-hidden">
      <div className="border-b border-white/[0.06] p-5 sm:p-6">
        <h2 className="pa-display text-[26px] leading-tight font-semibold text-white">Book this trip</h2>
        <p className="mt-1 max-w-2xl text-[13px] text-ink-400">
          Searches open on the provider's own site with your places, dates and {adults} guest{adults === 1 ? '' : 's'} filled in where the site
          allows it. It's free, and nothing is booked until you confirm there.
        </p>
        <label className="mt-4 flex max-w-sm flex-col gap-1 text-[12px] font-medium text-ink-300">
          Setting off from <span className="font-normal text-ink-500">(for flights, trains and buses)</span>
          <input list="safarnama-cities" className={inputClass} value={from} onChange={(e) => saveFrom(e.target.value.slice(0, 60))} placeholder="e.g. Bengaluru" />
          <datalist id="safarnama-cities">{CITIES.map((c) => <option key={c} value={c} />)}</datalist>
        </label>
      </div>

      <ul className="divide-y divide-white/[0.06]">
        {places.map((p) => {
          const info = destinationInfo(p.name)
          const groups = bookingLinks({ place: p, adults, from, info })
          return (
            <li key={`${p.name}-${p.checkin}`} className="grid gap-4 p-5 sm:grid-cols-[180px_1fr] sm:p-6">
              <div>
                <div className="relative h-28 overflow-hidden rounded-2xl sm:h-32"><PlaceImage name={p.name} /></div>
                <p className="pa-display mt-2 text-[19px] font-semibold text-white">{p.name}</p>
                <p className="text-[12px] text-ink-400">
                  {p.checkin ? `${dateRange(p.checkin, p.checkout)} · ${p.nights} night${p.nights === 1 ? '' : 's'}` : 'No dates yet: pick them on the provider site'}
                </p>
              </div>
              <div className="space-y-3">
                {groups.map((g) => {
                  const Icon = GROUP_ICON[g.id] ?? Ticket
                  return (
                    <div key={g.id}>
                      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-300"><Icon className="pa-ink size-3.5" /> {g.title}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {g.items.map((it) => (
                          <button
                            key={it.provider + it.label}
                            type="button"
                            onClick={() => setOpen({
                              kind: 'booking', url: it.url, label: it.label, source: `${it.label} search, pre-filled by Safarnaama`,
                              prefill: { type: TYPE_FOR[it.provider] ?? BOOKING_TYPE[g.id], provider: it.label.replace(/^(Trains|Buses|Restaurants) on /, ''), title: g.id === 'stay' ? `Stay in ${p.name}` : '', url: it.url, status: 'booked',
                                start: g.id === 'stay' && p.checkin ? `${p.checkin}T14:00` : '', end: g.id === 'stay' && p.checkout ? `${p.checkout}T11:00` : '' },
                            })}
                            className="pa-hover inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[12.5px] font-medium text-ink-100 transition hover:bg-white/[0.06]"
                            title={it.prefilled === true ? 'Opens with your details filled in' : it.prefilled === 'dates' ? 'Opens with the place and dates filled in; set the guests there' : it.prefilled === 'place' ? 'Opens the right place; check the dates there' : 'Opens the provider; check the place and dates there'}
                          >
                            {it.label}
                            {it.prefilled !== true && <span className="text-[10.5px] font-normal text-ink-500">· {it.prefilled === 'dates' ? 'set guests' : 'check dates'}</span>}
                            <ArrowUpRight className="size-3 text-ink-400" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </li>
          )
        })}
      </ul>
      <p className="border-t border-white/[0.06] px-5 py-3 text-[11.5px] text-ink-500 sm:px-6">
        Prices, availability and cancellation terms come from the provider. Safarnaama doesn't see or store your payment details.
      </p>
      {open && <Handoff link={open} onClose={() => setOpen(null)} />}
    </Card>
  )
}
