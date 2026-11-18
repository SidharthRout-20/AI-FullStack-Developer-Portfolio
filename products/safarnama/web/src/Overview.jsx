/** The trip at a glance (top of the plan) and the post-trip summary. */
import { CalendarCheck, CloudRain, Flag, MapPin, Sparkles, Thermometer } from 'lucide-react'
import { useEffect, useState } from 'react'
import { navigate } from '@appcore/web/router'
import { appPath } from './base'
import { errorText } from '@appcore/web/http'
import { Button, Card, ErrorNote, Spinner } from '@appcore/web/ui'
import { dateRange, money, nextUp } from './logic'

/**
 * The trip at a glance, at the top of the plan: what's next, weather warnings and (until something is booked) a
 * nudge to book. Budget, bookings and saved places have their own tabs, so they aren't repeated here.
 */
export function TripGlance({ trip, api, owner, goTab }) {
  const [bookings, setBookings] = useState(null)
  useEffect(() => {
    if (owner) api.bookings().then(setBookings).catch(() => setBookings([]))
  }, [api, owner, trip.version])

  const up = nextUp(trip)
  const alerts = trip.days.flatMap((d) => (d.alerts ?? []).map((a) => ({ ...a, day: d.day })))
  const booked = (bookings ?? []).some((b) => b.status !== 'cancelled')
  const showBook = owner && bookings !== null && !booked && trip.phase !== 'past'
  if (!up && alerts.length === 0 && !showBook) return null
  return (
    <div className="space-y-2">
      {up && (
        <p className="flex items-center gap-2 rounded-2xl border border-[color:var(--pa-line)] bg-[color:var(--pa-soft)] px-4 py-2.5 text-[13px] text-ink-200">
          <Flag className="pa-ink size-4 shrink-0" />
          <span>
            <span className="font-semibold text-white">Today · day {up.day}</span>
            {up.activity ? <> · {up.now ? 'Now' : `Next at ${up.activity.time}`}: <span className="text-white">{up.activity.name}</span></> : ' · nothing else planned today'}
          </span>
        </p>
      )}
      {alerts.length > 0 && (
        <ul className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-2.5 text-[12.5px] text-amber-100">
          {alerts.slice(0, 3).map((a, i) => (
            <li key={i}>{a.type === 'heavy_rain' ? <CloudRain className="mr-1 inline size-3.5" /> : <Thermometer className="mr-1 inline size-3.5" />}Day {a.day}: {a.text}</li>
          ))}
          <li className="mt-0.5 text-[11px] text-ink-500">From the Open-Meteo forecast; not official weather warnings.</li>
        </ul>
      )}
      {showBook && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-2.5 text-[13px] text-ink-300">
          <CalendarCheck className="pa-ink size-4 shrink-0" />
          <span className="min-w-0 flex-1">Stays, travel and tickets with your dates already filled in. Nothing is booked until you confirm on their site.</span>
          <button type="button" className="chip" onClick={() => goTab('bookings')}>See booking options</button>
        </div>
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
        <p className="flex items-center gap-2 text-[15px] font-semibold text-white"><MapPin className="pa-ink size-4" /> {s.title}</p>
        <p className="mt-1 text-[13px] text-ink-300">
          {s.destinations.join(' → ')} · {s.dates.start ? dateRange(s.dates.start, s.dates.end) : 'undated'} · {s.days} days · {s.stops} stops · {s.distance_km} km between stops
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
            <ul className="mt-2 space-y-1 text-[13px]">{ideas.ideas.map((i) => <li key={i.destination} className="flex flex-wrap items-baseline gap-x-2"><span className="text-white">{i.destination}</span> · <span className="text-ink-300">{i.why}</span> <button type="button" className="pa-ink text-[12.5px] font-medium hover:underline" onClick={() => navigate(appPath(`/?to=${encodeURIComponent(i.destination)}`))}>Plan this →</button></li>)}</ul>
            <p className="mt-1 text-[11.5px] text-ink-500">AI-generated ideas based on this trip; no prices or availability implied.</p>
          </>
        )}
      </Card>
    </div>
  )
}
