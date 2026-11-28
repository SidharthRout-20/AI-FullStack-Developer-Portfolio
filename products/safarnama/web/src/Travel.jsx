/** Travel times and the "nearby" explorer (food and sights around one stop) for Safarnaama. */
import { Landmark, Leaf, Plus, UtensilsCrossed } from 'lucide-react'
import { useEffect, useState } from 'react'
import { errorText } from '@appcore/web/http'
import { inputClass, Spinner } from '@appcore/web/ui'

export const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim() : `${m} min`)

/** Attractions and food around one stop, with filters and one-tap "add to this day". */
export function NearbyPanel({
  api, day, activityId, activityName, defaultTime, onAdded,
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
      api.nearby(Object.fromEntries(params))
        .then((r) => alive && setPlaces(r.places))
        .catch((e) => alive && setError(errorText(e)))
    }, cuisine ? 350 : 0)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [api, activityId, group, veg, openThen, cuisine])

  const add = async (p) => {
    setAdding(p.name)
    try {
      const trip = await api.addStop(day, {
        name: p.name, lat: p.lat, lng: p.lng, kind: p.group === 'food' ? 'food' : 'outdoor', time: defaultTime,
        duration_min: p.group === 'food' ? 60 : 45, added: 'nearby', distance_m: p.distance_m, near: activityName,
        note: [p.category, p.cuisine, `${p.distance_m} m from your stop`].filter(Boolean).join(' · '),
        ...(p.opening_hours ? { opening_hours: p.opening_hours.slice(0, 200) } : {}),
        ...(p.website ? { website: p.website.slice(0, 300) } : {}),
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
