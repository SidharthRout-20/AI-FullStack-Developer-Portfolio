/** Route legs, day insights (traffic, heat, air, pace…) and the "nearby" explorer for TripWeaver. */
import {
  Accessibility,
  AlertTriangle,
  Car,
  CloudRain,
  Coffee,
  Droplets,
  Footprints,
  Landmark,
  Leaf,
  Plus,
  Sun,
  Thermometer,
  TrafficCone,
  UtensilsCrossed,
  Wind,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { errorText, get, post } from '../shared/http'
import { inputClass, Spinner } from '../shared/ui'

const INSIGHT_ICON = {
  traffic: TrafficCone, rest: Coffee, heat: Thermometer, hydration: Droplets, uv: Sun, air: Wind,
  rain: CloudRain, meal: UtensilsCrossed, pace: AlertTriangle, access: Accessibility,
}

export const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim() : `${m} min`)

export function RouteSummary({ route }) {
  if (!route || route.legs.length === 0) return null
  const peaks = route.legs.filter((l) => l.peak).length
  return (
    <span className="inline-flex items-center gap-2 text-[11.5px] text-ink-400">
      {route.drive_min > 0 && <span className="inline-flex items-center gap-1"><Car className="size-3" /> {fmtMin(route.drive_min)}</span>}
      {route.walk_min > 0 && <span className="inline-flex items-center gap-1"><Footprints className="size-3" /> {fmtMin(route.walk_min)}</span>}
      {peaks > 0 && <span className="inline-flex items-center gap-1 text-amber-300"><TrafficCone className="size-3" /> {peaks} rush-hour leg{peaks > 1 ? 's' : ''}</span>}
    </span>
  )
}

export function DayInsights({ insights }) {
  if (!insights?.length) return null
  return (
    <ul className="mt-3 space-y-1.5">
      {insights.map((x, i) => {
        const Icon = INSIGHT_ICON[x.type] ?? AlertTriangle
        return (
          <li
            key={i}
            className={`flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] ${
              x.level === 'warn' ? 'bg-amber-500/[0.08] text-amber-100' : 'bg-white/[0.03] text-ink-300'
            }`}
          >
            <Icon className={`mt-0.5 size-3.5 shrink-0 ${x.level === 'warn' ? 'text-amber-300' : 'text-ink-400'}`} />
            <span>{x.text}</span>
          </li>
        )
      })}
    </ul>
  )
}

export function LegRow({ leg }) {
  const Icon = leg.mode === 'walk' ? Footprints : Car
  return (
    <li className="flex items-center gap-2 py-0.5 pl-14 text-[11.5px] text-ink-500" aria-label={`${leg.minutes} minutes by ${leg.mode}`}>
      <Icon className="size-3" />
      {leg.minutes} min {leg.mode} · {leg.km} km
      {leg.peak && <span className="text-amber-300">· rush hour: allow ~{leg.peak_minutes} min</span>}
    </li>
  )
}

/** Attractions and food around one stop, with filters and one-tap "add to this day". */
export function NearbyPanel({
  tripId, day, activityId, defaultTime, onAdded,
}) {  // prettier-ignore
  const [group, setGroup] = useState('food')
  const [veg, setVeg] = useState(false)
  const [openThen, setOpenThen] = useState(false)
  const [cuisine, setCuisine] = useState('')
  const [places, setPlaces] = useState(null)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(null)

  useEffect(() => {
    let alive = true
    const params = new URLSearchParams({ activity_id: activityId, group, veg: String(veg), open_now: String(openThen) })
    if (cuisine.trim()) params.set('cuisine', cuisine.trim())
    const t = window.setTimeout(() => {
      setPlaces(null)
      setError(null)
      get(`/api/trips/${tripId}/nearby?${params}`)
        .then((r) => alive && setPlaces(r.places))
        .catch((e) => alive && setError(errorText(e)))
    }, cuisine ? 350 : 0)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [tripId, activityId, group, veg, openThen, cuisine])

  const add = async (p) => {
    setAdding(p.name)
    try {
      const trip = await post(`/api/trips/${tripId}/days/${day}/stops`, {
        name: p.name, lat: p.lat, lng: p.lng, kind: p.group === 'food' ? 'food' : 'outdoor', time: defaultTime,
        duration_min: p.group === 'food' ? 60 : 45,
        note: [p.category, p.cuisine, `${p.distance_m} m from your stop`].filter(Boolean).join(' · '),
      })  // prettier-ignore
      onAdded(trip)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setAdding(null)
    }
  }

  return (
    <div className="mt-2 rounded-xl border border-white/[0.07] bg-ink-950/40 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {['food', 'sights'].map((g) => (
          <button key={g} type="button" onClick={() => setGroup(g)} className={`chip ${group === g ? '!bg-white/10 !text-white' : ''}`}>
            {g === 'food' ? <UtensilsCrossed className="size-3" /> : <Landmark className="size-3" />} {g === 'food' ? 'Food' : 'Sights'}
          </button>
        ))}
        {group === 'food' && (
          <>
            <button type="button" onClick={() => setVeg(!veg)} className={`chip ${veg ? '!bg-emerald-500/15 !text-emerald-200' : ''}`}>
              <Leaf className="size-3" /> Veg
            </button>
            <input aria-label="Cuisine" className={`${inputClass} !w-28 !py-1 text-[12px]`} placeholder="Cuisine…" value={cuisine} onChange={(e) => setCuisine(e.target.value)} />
          </>
        )}
        <button type="button" onClick={() => setOpenThen(!openThen)} className={`chip ${openThen ? '!bg-white/10 !text-white' : ''}`}>
          Open when you're there
        </button>
      </div>
      {error && <p className="mt-2 text-[12px] text-rose-300">{error}</p>}
      {!places && !error && <div className="mt-3"><Spinner label="Searching OpenStreetMap…" /></div>}
      {places && places.length === 0 && <p className="mt-3 text-[12.5px] text-ink-400">Nothing found with these filters.</p>}
      {places && places.length > 0 && (
        <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto pr-1">
          {places.map((p) => (
            <li key={p.name} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/[0.03]">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-white">
                  {p.name} {p.veg && <Leaf className="inline size-3 text-emerald-300" aria-label="vegetarian-friendly" />}
                </p>
                <p className="truncate text-[11.5px] text-ink-400">
                  {[p.category, p.cuisine, `${p.distance_m} m`, p.open === true ? 'open then' : p.open === false ? 'closed then' : null]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <a
                className="chip shrink-0"
                href={`https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=18/${p.lat}/${p.lng}`}
                target="_blank"
                rel="noreferrer"
              >
                Map
              </a>
              {p.planned ? (
                <span className="shrink-0 text-[11px] text-ink-500">in plan</span>
              ) : (
                <button type="button" className="chip shrink-0" disabled={!!adding} onClick={() => void add(p)}>
                  <Plus className="size-3" /> {adding === p.name ? 'Adding…' : 'Add'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
