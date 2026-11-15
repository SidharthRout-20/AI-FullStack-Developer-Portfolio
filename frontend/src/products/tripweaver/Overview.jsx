/** Trip dashboard and post-trip summary. */
import { Bot, CalendarCheck, CloudRain, CloudSun, Flag, ListChecks, MapPin, PiggyBank, Sparkles, Thermometer, Bookmark } from 'lucide-react'
import { useEffect, useState } from 'react'
import { errorText } from '../shared/http'
import { Button, Card, ErrorNote, Pill, Spinner } from '../shared/ui'
import { forecastFreshness } from './freshness'
import { money, nextUp, pct } from './logic'

function Tile({ icon: Icon, title, children, action }) {
  return (
    <Card>
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-emerald-300" />
        <p className="text-[13px] font-semibold text-white">{title}</p>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <div className="mt-2 text-[13px] text-ink-300">{children}</div>
    </Card>
  )
}

export function Overview({ trip, api, owner, goTab }) {
  const [budget, setBudget] = useState(null)
  const [bookings, setBookings] = useState(null)
  const [places, setPlaces] = useState(null)
  useEffect(() => {
    api.budget().then(setBudget).catch(() => setBudget(null))
    api.places().then(setPlaces).catch(() => setPlaces([]))
    if (owner) api.bookings().then(setBookings).catch(() => setBookings([]))
  }, [api, owner, trip.version])

  const up = nextUp(trip)
  const fresh = forecastFreshness(trip.weather_updated_at)
  const alerts = trip.days.flatMap((d) => (d.alerts ?? []).map((a) => ({ ...a, day: d.day })))
  const checklists = trip.checklists ?? []
  const items = checklists.flatMap((l) => l.items)
  const upcoming = (bookings ?? []).filter((b) => b.status !== 'cancelled').slice(0, 4)

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Tile icon={Flag} title={up ? `Today · day ${up.day}` : 'Your itinerary'} action={<button type="button" className="chip" onClick={() => goTab('itinerary')}>Open itinerary</button>}>
        {up?.activity ? (
          <p><span className="text-white">{up.now ? 'Now' : `Next at ${up.activity.time}`}: {up.activity.name}</span>{up.activity.note ? ` · ${up.activity.note}` : ''}</p>
        ) : up ? <p>Nothing else planned today.</p> : (
          <p>{trip.days.length} day{trip.days.length > 1 ? 's' : ''} in {(trip.destinations ?? []).map((d) => d.name).join(' → ')}
            {trip.days[0]?.date ? `, starting ${trip.days[0].date}` : ' (no dates yet)'} · {trip.days.reduce((n, d) => n + d.activities.length, 0)} stops</p>
        )}
      </Tile>
      <Tile icon={CloudSun} title="Weather" action={<Pill tone={fresh.stale ? 'warn' : 'neutral'}>{fresh.label}</Pill>}>
        <ul className="space-y-1">
          {(trip.destinations ?? []).map((d) => {
            const now = trip.weather_now?.[String(d.id)]
            const day = trip.days.find((x) => x.destination === d.id && x.weather) ?? (d.id == null ? trip.days.find((x) => x.weather) : null)
            return (
              <li key={d.id ?? d.name}>
                <span className="text-white">{d.name}</span>
                {now ? <> · now {Math.round(now.temp)}°C (observed {now.observed_at?.slice(11, 16)}, fetched {new Date(now.fetched_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})</> : ''}
                {day?.weather ? <> · day {day.day}: {Math.round(day.weather.tmin)}–{Math.round(day.weather.tmax)}°C, {day.weather.rain}% rain</> : !now && <span> · no forecast for these dates</span>}
              </li>
            )
          })}
        </ul>
        {alerts.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {alerts.slice(0, 4).map((a, i) => (
              <li key={i} className="text-amber-200">{a.type === 'heavy_rain' ? <CloudRain className="inline size-3.5" /> : <Thermometer className="inline size-3.5" />} Day {a.day}: {a.text}</li>
            ))}
            <li className="text-[11px] text-ink-500">Derived from the Open-Meteo forecast; not official weather warnings.</li>
          </ul>
        )}
      </Tile>
      {owner && (
        <Tile icon={CalendarCheck} title="Bookings" action={<button type="button" className="chip" onClick={() => goTab('bookings')}>Manage</button>}>
          {!bookings ? <Spinner label="Loading…" /> : upcoming.length === 0 ? <p>No bookings saved yet.</p> : (
            <ul className="space-y-0.5">{upcoming.map((b) => <li key={b.id}><span className="text-white">{b.title}</span>{b.start ? ` · ${b.start.replace('T', ' ')}` : ''}{b.reference ? ` · ref ${b.reference}` : ''}</li>)}</ul>
          )}
        </Tile>
      )}
      <Tile icon={PiggyBank} title="Budget" action={<button type="button" className="chip" onClick={() => goTab('budget')}>Open</button>}>
        {!budget ? <p>—</p> : (
          <>
            <p>Spent <span className="text-white">{money(budget.actual_total, budget.currency)}</span>{budget.budget_total != null && <> of {money(budget.budget_total, budget.currency)}</>}
              {budget.estimated_total > 0 && <> · {money(budget.estimated_total, budget.currency)} estimated</>}</p>
            {budget.budget_total != null && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]"><div className={`h-full ${budget.over_budget ? 'bg-rose-400' : 'bg-emerald-400'}`} style={{ width: `${pct(budget.actual_total, budget.budget_total)}%` }} /></div>}
          </>
        )}
      </Tile>
      <Tile icon={Bookmark} title="Saved places" action={<button type="button" className="chip" onClick={() => goTab('explore')}>Explore</button>}>
        {!places ? <p>—</p> : places.length === 0 ? <p>None yet: save restaurants, shops and sights from Explore.</p> : <p>{places.slice(0, 6).map((p) => p.name).join(' · ')}{places.length > 6 ? ` +${places.length - 6}` : ''}</p>}
      </Tile>
      {owner && (
        <Tile icon={ListChecks} title="Checklists" action={<button type="button" className="chip" onClick={() => goTab('documents')}>Open</button>}>
          {checklists.length === 0 ? <p>No checklists yet.</p> : <p>{items.filter((i) => i.done).length} of {items.length} items done across {checklists.length} list{checklists.length > 1 ? 's' : ''}.</p>}
        </Tile>
      )}
      {owner && (
        <Tile icon={Bot} title="Travel companion">
          <p>Ask what to do nearby, how to adjust for the weather, or where to eat next. It uses this trip's real data.</p>
          <Button variant="ghost" className="mt-2 !py-1.5" onClick={() => goTab('companion')}>Ask the companion</Button>
        </Tile>
      )}
    </div>
  )
}

export function Summary({ trip, api }) {
  const [s, setS] = useState(null)
  const [ideas, setIdeas] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => void api.summary().then(setS).catch((e) => setError(errorText(e))), [api, trip.version])
  const more = async () => {
    setBusy(true)
    try {
      setIdeas(await api.nextIdeas())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  if (error) return <ErrorNote message={error} />
  if (!s) return <Spinner label="Summarising your trip…" />
  return (
    <div className="space-y-3">
      <Card>
        <p className="flex items-center gap-2 text-[15px] font-semibold text-white"><MapPin className="size-4 text-emerald-300" /> {s.title}</p>
        <p className="mt-1 text-[13px] text-ink-300">
          {s.destinations.join(' → ')} · {s.dates.start ? `${s.dates.start} to ${s.dates.end}` : 'undated'} · {s.days} days · {s.stops} stops · {s.distance_km} km between stops
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div><p className="text-[12px] text-ink-400">Spent</p><p className="text-[18px] font-semibold text-white">{money(s.spend.actual_total, s.spend.currency)}</p>
            {s.spend.budget_total != null && <p className="text-[12px] text-ink-400">budget {money(s.spend.budget_total, s.spend.currency)} · {money(s.spend.remaining, s.spend.currency)} left</p>}</div>
          <div><p className="text-[12px] text-ink-400">Top spending</p><p className="text-[13px] text-ink-200">{s.top_categories.map(([c, v]) => `${c} ${money(v, s.spend.currency)}`).join(' · ') || '—'}</p></div>
          <div><p className="text-[12px] text-ink-400">Stops by type</p><p className="text-[13px] text-ink-200">{Object.entries(s.by_kind).map(([k, v]) => `${v} ${k}`).join(' · ')}</p></div>
        </div>
        {s.favourites.length > 0 && <p className="mt-3 text-[13px] text-ink-300"><span className="text-white">Favourites</span> (pinned, must-visit or voted up): {s.favourites.join(', ')}</p>}
        {s.saved_places.length > 0 && <p className="mt-1 text-[13px] text-ink-300"><span className="text-white">Saved places:</span> {s.saved_places.join(', ')}</p>}
      </Card>
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><Sparkles className="size-4 text-amber-300" /> Where next?</p>
          <Button variant="ghost" className="ml-auto !py-1.5" busy={busy} onClick={() => void more()}>Suggest future trips</Button>
        </div>
        {ideas && (
          <>
            <ul className="mt-2 space-y-1 text-[13px]">{ideas.ideas.map((i) => <li key={i.destination}><span className="text-white">{i.destination}</span> · <span className="text-ink-300">{i.why}</span></li>)}</ul>
            <p className="mt-1 text-[11.5px] text-ink-500">AI-generated ideas based on this trip; no prices or availability implied.</p>
          </>
        )}
      </Card>
    </div>
  )
}
