/** Explore: real places (OpenStreetMap) around a destination, a stop, or your location, tied to the trip. */
import {
  Baby, Bike, Bookmark, Compass, Landmark, Leaf, LocateFixed, Moon, Mountain, Plane, ShoppingBag, Sparkles, Stethoscope,
  Theater, Trash2, Umbrella, UtensilsCrossed,
} from 'lucide-react'  // prettier-ignore
import { useCallback, useEffect, useMemo, useState } from 'react'
import { currentPosition } from '@appcore/web/device'
import { errorText } from '@appcore/web/http'
import { Button, Card, Empty, ErrorNote, inputClass, Pill, Spinner } from '@appcore/web/ui'
import { placeToSaved, placeToStop } from './logic'
import { Handoff, PlaceCard, SourceNote } from './parts'

export const GROUPS = [
  { id: 'food', label: 'Food & dining', icon: UtensilsCrossed },
  { id: 'sights', label: 'Sights', icon: Landmark },
  { id: 'experiences', label: 'Experiences', icon: Theater },
  { id: 'shopping', label: 'Shopping & souvenirs', icon: ShoppingBag },
  { id: 'nature', label: 'Nature', icon: Mountain },
  { id: 'indoor', label: 'Indoor', icon: Umbrella },
  { id: 'family', label: 'Family', icon: Baby },
  { id: 'nightlife', label: 'Nightlife', icon: Moon },
  { id: 'transport', label: 'Transport', icon: Bike },
  { id: 'services', label: 'Services', icon: Stethoscope },
]

export function Explore({ trip, api, owner, onTrip, onPins, setNote, initialGroup = 'food', order }) {
  const [group, setGroup] = useState(initialGroup)
  const groups = order ? order.map((id) => GROUPS.find((g) => g.id === id)).filter(Boolean) : GROUPS
  const dests = trip.destinations ?? []
  const stops = useMemo(() => trip.days.flatMap((d) => d.activities.filter((a) => a.lat != null).map((a) => ({ ...a, day: d.day }))), [trip])
  const [anchor, setAnchor] = useState(`dest:${dests[0]?.id ?? ''}`)
  const [me, setMe] = useState(null)
  const [f, setF] = useState({ veg: false, vegan: false, street_food: false, free: false, open_now: false, cuisine: '' })
  const [res, setRes] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [handoff, setHandoff] = useState(null)
  const [saved, setSaved] = useState([])
  const [spec, setSpec] = useState(null)
  const [transport, setTransport] = useState(null)

  const loadSaved = useCallback(() => api.places().then(setSaved).catch(() => setSaved([])), [api])
  useEffect(() => void loadSaved(), [loadSaved])

  const params = useMemo(() => {
    const p = { group, ...f }
    if (anchor.startsWith('act:')) p.activity_id = anchor.slice(4)
    else if (anchor === 'me' && me) Object.assign(p, me)
    else if (anchor.startsWith('dest:') && anchor.length > 5) p.destination = anchor.slice(5)
    return p
  }, [group, f, anchor, me])

  useEffect(() => {
    let alive = true
    if (anchor === 'me' && !me) return
    const t = window.setTimeout(() => {
      setRes(null)
      setError(null)
      api.discover(params).then((r) => alive && (setRes(r), onPins(r.places))).catch((e) => alive && setError(errorText(e)))
    }, f.cuisine ? 400 : 0)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [api, params, anchor, me, f.cuisine, onPins])

  const locateMe = async () => {
    setError(null)
    const pos = await currentPosition()
    if (!pos) return setError("Location isn't available (permission denied or unsupported). Pick a destination or stop instead.")
    setMe(pos)
    setAnchor('me')
  }

  const destinationId = anchor.startsWith('dest:') ? anchor.slice(5) : undefined
  const save = async (p) => {
    try {
      await api.savePlace(placeToSaved(p, destinationId))
      setRes((r) => r && { ...r, places: r.places.map((x) => (x.name === p.name ? { ...x, saved: true } : x)) })
      setNote(`Saved ${p.name} to this trip.`)
      void loadSaved()
    } catch (e) {
      setError(errorText(e))
    }
  }
  const add = async (p, day, time) => {
    setBusy(true)
    try {
      const t = await api.addStop(day, placeToStop(p, { time, near: res?.around?.endsWith('centre') ? undefined : res?.around, added: p.saved_at ? 'saved' : 'discovery' }))
      onTrip(t)
      setNote(`${p.name} added to day ${day}; route and travel times updated.`)
      setRes((r) => r && { ...r, places: r.places.map((x) => (x.name === p.name ? { ...x, planned: true } : x)) })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const loadSpecialities = async () => {
    setSpec('loading')
    try {
      setSpec(await api.specialities(destinationId))
    } catch (e) {
      setSpec(null)
      setError(errorText(e))
    }
  }
  const loadTransport = async () => {
    setTransport('loading')
    try {
      setTransport(await api.transport(destinationId))
    } catch (e) {
      setTransport(null)
      setError(errorText(e))
    }
  }
  const days = trip.days

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
          {groups.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" onClick={() => setGroup(id)} className={`chip shrink-0 ${group === id ? '!bg-white/10 !text-white' : ''}`}>
              <Icon className="size-3" /> {label}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <select aria-label="Search around" className={`${inputClass} !w-auto max-w-full !py-1.5 text-[12.5px]`} value={anchor} onChange={(e) => setAnchor(e.target.value)}>
            {dests.map((d) => <option key={d.id ?? 'c'} value={`dest:${d.id ?? ''}`}>Around {d.name} centre</option>)}
            {stops.map((a) => <option key={a.id} value={`act:${a.id}`}>Near day {a.day}: {a.name}</option>)}
            {me && <option value="me">Near my location</option>}
          </select>
          <button type="button" className="chip" onClick={() => void locateMe()}><LocateFixed className="size-3" /> Use my location</button>
          {group === 'food' && (
            <>
              {[['veg', 'Vegetarian'], ['vegan', 'Vegan'], ['street_food', 'Street food']].map(([k, label]) => (
                <button key={k} type="button" onClick={() => setF((x) => ({ ...x, [k]: !x[k] }))} className={`chip ${f[k] ? '!bg-emerald-500/15 !text-emerald-200' : ''}`}>
                  {k !== 'street_food' && <Leaf className="size-3" />} {label}
                </button>
              ))}
              <input aria-label="Cuisine" className={`${inputClass} !w-28 !py-1 text-[12px]`} placeholder="Cuisine…" value={f.cuisine} onChange={(e) => setF((x) => ({ ...x, cuisine: e.target.value }))} />
            </>
          )}
          {['sights', 'nature', 'experiences', 'family'].includes(group) && (
            <button type="button" onClick={() => setF((x) => ({ ...x, free: !x.free }))} className={`chip ${f.free ? '!bg-white/10 !text-white' : ''}`}>Free entry</button>
          )}
          <button type="button" onClick={() => setF((x) => ({ ...x, open_now: !x.open_now }))} className={`chip ${f.open_now ? '!bg-white/10 !text-white' : ''}`}>
            {anchor.startsWith('act:') ? "Open when you're there" : 'Open now'}
          </button>
        </div>
      </Card>

      <ErrorNote message={error} />
      {group === 'shopping' && owner && (
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><Sparkles className="size-4 text-amber-300" /> What's distinctive to buy here?</p>
            <Button variant="ghost" className="ml-auto !py-1.5" onClick={() => void loadSpecialities()} busy={spec === 'loading'}>Suggest local specialities</Button>
          </div>
          {spec && spec !== 'loading' && (
            <>
              <ul className="mt-2 space-y-1.5">
                {spec.items.map((i) => (
                  <li key={i.name} className="text-[13px]">
                    <span className="font-medium text-white">{i.name}</span> <Pill>{i.kind}</Pill>
                    <span className="text-ink-300"> {i.why}</span>
                    {i.shops.length > 0 && <span className="block text-[12px] text-emerald-300">Nearby shops that may carry it: {i.shops.join(', ')}</span>}
                  </li>
                ))}
              </ul>
              <SourceNote>AI-generated suggestions (verify locally). Shops are real OpenStreetMap places matched by name; stock and prices aren't known.</SourceNote>
            </>
          )}
        </Card>
      )}
      {group === 'transport' && (
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><Plane className="size-4 text-sky-300" /> Airports and transfers</p>
            <Button variant="ghost" className="ml-auto !py-1.5" onClick={() => void loadTransport()} busy={transport === 'loading'}>Find airports</Button>
          </div>
          {transport && transport !== 'loading' && (
            <ul className="mt-2 space-y-1 text-[13px]">
              {transport.airports.length === 0 && <li className="text-ink-400">No airport with an IATA code within 60 km in OpenStreetMap.</li>}
              {transport.airports.map((a) => (
                <li key={a.name}>
                  <span className="text-white">{a.name}</span> {a.iata && <Pill>{a.iata}</Pill>}
                  <span className="text-ink-300"> · ~{a.transfer.drive_min} min by road, {a.transfer.km} km</span>
                  <span className="block text-[11.5px] text-ink-500">{a.transfer.source}</span>
                </li>
              ))}
              <li className="pt-1 text-[11.5px] text-ink-500">{transport.note}</li>
            </ul>
          )}
        </Card>
      )}

      {!res && !error && <Spinner label="Searching OpenStreetMap…" />}
      {res && (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[13px] text-ink-300">{res.places.length} places near <span className="text-white">{res.around}</span></p>
            <SourceNote>{res.source} · {new Date(res.fetched_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</SourceNote>
          </div>
          {res.places.length === 0 ? (
            <Empty icon={Compass} title="Nothing found" text="Try another category, fewer filters, or a different stop." />
          ) : (
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {res.places.map((p) => (
                <PlaceCard key={`${p.name}-${p.lat}`} p={p} days={days} onAdd={owner ? add : null} onSave={save} busy={busy} onLink={(link, place) => setHandoff({ link, place })}
                  defaultDay={anchor.startsWith('act:') ? stops.find((s) => `act:${s.id}` === anchor)?.day : undefined} />
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11.5px] text-ink-500">{res.note}</p>
        </Card>
      )}

      <Card>
        <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><Bookmark className="pa-ink size-4" /> Saved places ({saved.length})</p>
        {saved.length === 0 ? (
          <p className="mt-1 text-[12.5px] text-ink-400">Save places from the results to keep a shortlist for this trip.</p>
        ) : (
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {saved.map((p) => (
              <div key={p.id} className="relative">
                <PlaceCard p={{ ...p, saved: true }} days={days} onAdd={owner ? add : null} onLink={(link, place) => setHandoff({ link, place })} busy={busy} />
                {owner && (
                  <button type="button" aria-label={`Remove ${p.name}`} className="absolute top-2 right-2 text-ink-500 hover:text-rose-300"
                    onClick={() => void api.deletePlace(p.id).then(loadSaved).catch((e) => setError(errorText(e)))}><Trash2 className="size-3.5" /></button>
                )}
              </div>
            ))}
          </ul>
        )}
      </Card>
      {handoff && <Handoff link={handoff.link} place={handoff.place} onClose={() => setHandoff(null)} onSave={handoff.place.saved ? null : () => void save(handoff.place)} />}
    </div>
  )
}
