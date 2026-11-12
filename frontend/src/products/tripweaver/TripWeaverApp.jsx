import {
  CalendarDays,
  Compass,
  CloudRain,
  CloudSun,
  History,
  Landmark,
  Lightbulb,
  MapPin,
  Route,
  Share2,
  ThumbsDown,
  ThumbsUp,
  Shuffle,
  Trash2,
  TrainFront,
  Trees,
  Users,
  UtensilsCrossed,
  Soup,
  WifiOff,
  Wand2,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { navigate, usePath } from '../../router'
import { API_BASE } from '../../lib/apiBase'
import { del, errorText, get, post, streamPost } from '../shared/http'
import { Button, Card, Empty, ErrorNote, inputClass, Pill, ProductShell, Spinner, Steps } from '../shared/ui'
import { DAY_COLORS } from './colors'
import { DayInsights, LegRow, NearbyPanel, RouteSummary, fmtMin } from './Travel'

const TripMap = lazy(() => import('./TripMap').then((m) => ({ default: m.TripMap })))
const ACCENT = 'from-lime-500 via-emerald-500 to-teal-500'

const KIND_ICON = { outdoor: Trees, indoor: Landmark, food: UtensilsCrossed, transit: TrainFront }
const EXAMPLES = [
  '3 relaxed days in Lisbon next week, love food markets and viewpoints',
  'Weekend in Kyoto for two, temples and tea houses, start this Saturday',
  '2 days in Jaipur with kids, forts and street food',
]
const CACHE = 'tripweaver-last'

export default function TripWeaverApp() {
  const path = usePath()
  const tripId = path.match(/^\/tripweaver\/([\w-]+)/)?.[1] ?? null
  return (
    <ProductShell name="TripWeaver" tagline="A trip planner that re-plans while you travel" icon={Route} accent={ACCENT}>
      {tripId ? <TripView key={tripId} id={tripId} /> : <Planner />}
    </ProductShell>
  )
}

function Planner() {
  const [prompt, setPrompt] = useState('')
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [trips, setTrips] = useState(null)

  const load = useCallback(() => get('/api/trips').then(setTrips).catch(() => setTrips([])), [])
  useEffect(() => void load(), [load])

  const plan = async () => {
    setBusy(true)
    setError(null)
    setSteps([{ name: 'understand', detail: 'reading your request…', done: false }])
    try {
      await streamPost('/api/trips/plan', { prompt }, (ev) => {
        if (ev.event === 'step') {
          setSteps((s) => {
            const rest = s.filter((x) => x.name !== ev.step).map((x) => ({ ...x, done: true }))
            const next = { understand: 'geocode', geocode: 'weather', weather: 'plan', plan: 'map', map: '' }[String(ev.step)]
            return [...rest, { name: String(ev.step), detail: String(ev.detail), done: true }, ...(next ? [{ name: next, detail: '…', done: false }] : [])]
          })
        } else if (ev.event === 'done') navigate(`/tripweaver/${ev.trip.id}`)
        else if (ev.event === 'error') setError(String(ev.message))
      })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Where to next?</h1>
        <p className="mt-2 text-[14px] text-ink-400">An agent checks the map and the forecast, plans each day, then keeps re-planning as things change.</p>
      </div>
      <Card>
        <textarea
          id="trip-prompt"
          className={`${inputClass} min-h-28 text-[15px]`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe your trip: where, when, how long, what you love…"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {EXAMPLES.map((e) => <button key={e} type="button" className="chip" onClick={() => setPrompt(e)}>{e}</button>)}
        </div>
        <Button accent={ACCENT} className="mt-4 w-full" onClick={() => void plan()} busy={busy} disabled={prompt.trim().length < 10}>
          <Wand2 className="size-4" /> Plan my trip
        </Button>
        {steps.length > 0 && <div className="mt-4"><Steps steps={steps} active={busy} /></div>}
        <div className="mt-3"><ErrorNote message={error} /></div>
      </Card>
      {trips && trips.length > 0 && (
        <section>
          <h2 className="mb-2 text-[12px] font-semibold tracking-wide text-ink-400 uppercase">Your trips</h2>
          <ul className="grid gap-2.5 sm:grid-cols-2">
            {trips.map((t) => (
              <li key={t.id} className="group relative">
                <button type="button" onClick={() => navigate(`/tripweaver/${t.id}`)} className="w-full rounded-2xl border border-white/[0.07] bg-ink-900/60 p-4 text-left transition hover:border-emerald-400/40">
                  <p className="text-[14.5px] font-semibold text-white">{t.title}</p>
                  <p className="mt-0.5 text-[12px] text-ink-400">{t.city?.name} · {t.request?.days} days{t.request?.start_date ? ` · ${t.request.start_date}` : ''} · v{t.version}</p>
                </button>
                <button type="button" aria-label={`Delete ${t.title}`} onClick={() => void del(`/api/trips/${t.id}`).then(load)} className="absolute top-3 right-3 grid size-7 place-items-center rounded-lg text-ink-500 opacity-0 group-hover:opacity-100 hover:text-rose-300">
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function useVoter() {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('tripweaver-voter') ?? ''
    } catch {
      return ''
    }
  })
  const set = (v) => {
    setName(v)
    try {
      localStorage.setItem('tripweaver-voter', v)
    } catch {
      /* ignore */
    }
  }
  return [name, set]
}

function TripView({ id }) {
  const [trip, setTrip] = useState(null)
  const [offline, setOffline] = useState(false)
  const [error, setError] = useState(null)
  const [day, setDay] = useState(null)
  const [focus, setFocus] = useState(null)
  const [event, setEvent] = useState('')
  const [busy, setBusy] = useState(null)
  const [note, setNote] = useState(null)
  const [alerts, setAlerts] = useState([])
  const [voter, setVoter] = useVoter()
  const [live, setLive] = useState(false)
  const [nearbyFor, setNearbyFor] = useState(null)

  const keep = (t) => {
    setTrip(t)
    try {
      localStorage.setItem(`${CACHE}-${t.id}`, JSON.stringify(t)) // offline copy
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    get(`/api/trips/${id}`)
      .then(keep)
      .catch((e) => {
        const cached = (() => {
          try {
            return localStorage.getItem(`${CACHE}-${id}`)
          } catch {
            return null
          }
        })()
        if (cached) {
          setTrip(JSON.parse(cached))
          setOffline(true)
        } else setError(errorText(e))
      })
    // Group mode: live updates from everyone viewing this trip. Every (re)connect resyncs the full trip, so
    // events missed while disconnected are never lost; a silent stream (no ping for 30 s) is reopened.
    let es = null
    let watchdog = 0
    const resync = () => void get(`/api/trips/${id}`).then(keep).catch(() => {})
    const arm = () => {
      window.clearTimeout(watchdog)
      watchdog = window.setTimeout(connect, 30_000)
    }
    function connect() {
      es?.close()
      es = new EventSource(`${API_BASE}/api/trips/${id}/live`)
      es.onopen = () => {
        setLive(true)
        resync()
        arm()
      }
      es.onerror = () => setLive(false)
      es.addEventListener('ping', arm)
      es.addEventListener('trip', (e) => {
        arm()
        keep(JSON.parse(e.data).trip)
      })
      es.addEventListener('vote', (e) => {
        arm()
        const v = JSON.parse(e.data)
        setTrip((t) => t && { ...t, days: t.days.map((d) => ({ ...d, activities: d.activities.map((a) => (a.id === v.activity_id ? { ...a, votes: v.votes } : a)) })) })
      })
    }
    connect()
    return () => {
      window.clearTimeout(watchdog)
      es?.close()
    }
  }, [id])

  const mapDays = useMemo(() => trip?.days.map((d) => ({ day: d.day, activities: d.activities })) ?? [], [trip])
  const select = useCallback((aid) => setFocus(aid), [])

  const replan = async (text = event) => {
    if (!trip) return
    setBusy('Re-planning the affected days…')
    setError(null)
    try {
      const out = await post(`/api/trips/${trip.id}/replan`, { event: text })
      keep(out.trip)
      setNote(out.explanation)
      setEvent('')
      setAlerts([])
      setDay(out.days_changed[0] ?? null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  const checkWeather = async () => {
    if (!trip) return
    setBusy('Checking the latest forecast…')
    try {
      const out = await post(`/api/trips/${trip.id}/weather-check`)
      keep(out.trip)
      setAlerts(out.alerts)
      setNote(out.alerts.length ? null : 'Forecast checked: no wet days clash with outdoor plans.')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  const optimise = async (dayNo) => {
    if (!trip) return
    setBusy(`Optimising day ${dayNo}…`)
    setError(null)
    try {
      const out = await post(`/api/trips/${trip.id}/days/${dayNo}/optimise`)
      keep(out.trip)
      const saved = out.travel_before - out.travel_after
      setNote(saved > 0 ? `Day ${dayNo} reordered: ${fmtMin(saved)} less travel, times updated.` : `Day ${dayNo} was already in the best order; times updated for travel and rush hour.`)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  const addMeals = async () => {
    if (!trip) return
    setBusy('Finding restaurants near your stops…')
    setError(null)
    try {
      const out = await post(`/api/trips/${trip.id}/meals`)
      keep(out.trip)
      setNote(out.added ? `Added ${out.added} meal stop${out.added > 1 ? 's' : ''} near where you'll be.` : 'Every day already has its meals planned.')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  const vote = async (a, value) => {
    if (!trip || !voter.trim()) return setNote('Add your name (top right of the itinerary) to vote.')
    const current = a.votes[voter] ?? 0
    const next = current === value ? 0 : value
    const name = voter.trim()
    // optimistic: show my vote immediately; the server broadcast keeps everyone else in sync
    setTrip((t) =>
      t && {
        ...t,
        days: t.days.map((d) => ({
          ...d,
          activities: d.activities.map((x) => {
            if (x.id !== a.id) return x
            const votes = { ...x.votes }
            if (next === 0) delete votes[name]
            else votes[name] = next
            return { ...x, votes }
          }),
        })),
      },
    )
    await post(`/api/trips/${trip.id}/votes`, { activity_id: a.id, voter: name, value: next })
      .then(keep)
      .catch((e) => setError(errorText(e)))
  }

  if (error && !trip)
    return (
      <div className="space-y-3">
        <ErrorNote message={error.includes('not found') ? 'This trip no longer exists (it may have been deleted).' : error} />
        <button type="button" className="chip" onClick={() => navigate('/tripweaver')}>← All trips</button>
      </div>
    )
  if (!trip) return <Spinner label="Loading trip…" />
  const shown = day == null ? trip.days : trip.days.filter((d) => d.day === day)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button type="button" className="text-[12px] text-ink-400 hover:text-white" onClick={() => navigate('/tripweaver')}>← All trips</button>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">{trip.title}</h1>
          <p className="mt-1 max-w-3xl text-[13.5px] text-ink-300">{trip.summary}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Pill><MapPin className="size-3" /> {trip.city.name}{trip.city.country ? `, ${trip.city.country}` : ''}</Pill>
            {trip.request.start_date && <Pill><CalendarDays className="size-3" /> from {trip.request.start_date}</Pill>}
            <Pill tone="info">v{trip.version}</Pill>
            {live ? <Pill tone="good"><Users className="size-3" /> live</Pill> : offline && <Pill tone="warn"><WifiOff className="size-3" /> offline copy</Pill>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="Your name for voting" className={`${inputClass} !w-36 !py-2 text-[13px]`} placeholder="Your name" value={voter} onChange={(e) => setVoter(e.target.value)} />
          <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(location.href).then(() => setNote('Link copied: anyone with it can view and vote live.'))}>
            <Share2 className="size-4" /> Share
          </Button>
          <Button variant="ghost" onClick={() => void checkWeather()} disabled={!!busy}><CloudSun className="size-4" /> Check weather</Button>
          <Button variant="ghost" onClick={() => void addMeals()} disabled={!!busy}><Soup className="size-4" /> Add meal stops</Button>
        </div>
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
        <button type="button" onClick={() => setDay(null)} className={`chip ${day == null ? '!bg-white/10 !text-white' : ''}`}>All days</button>
        {trip.days.map((d) => (
          <button key={d.day} type="button" onClick={() => setDay(d.day)} className={`chip shrink-0 ${day === d.day ? '!bg-white/10 !text-white' : ''}`}>
            <span className="size-2 rounded-full" style={{ background: DAY_COLORS[(d.day - 1) % DAY_COLORS.length] }} />
            Day {d.day}
            {d.weather && <span className={d.weather.rain >= 60 ? 'text-sky-300' : 'text-ink-400'}>{d.weather.rain >= 60 ? <CloudRain className="inline size-3" /> : null} {Math.round(d.weather.tmax)}°</span>}
            {d.changed && <span className="text-amber-300">●</span>}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="order-2 min-w-0 space-y-3 lg:order-1">
          <AnimatePresence>
            {alerts.map((a) => (
              <motion.div key={a.day} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-center gap-2 rounded-xl border border-sky-400/25 bg-sky-500/[0.08] px-3 py-2 text-[13px] text-sky-200">
                <CloudRain className="size-4" /> Day {a.day}: {a.rain}% rain, outdoor plans: {a.outdoor.join(', ')}
                <button type="button" className="chip ml-auto" onClick={() => void replan(`Rain is forecast on day ${a.day} (${a.rain}%). Move outdoor activities indoors or to a drier day.`)}>Fix with re-plan</button>
              </motion.div>
            ))}
          </AnimatePresence>
          {note && <p className="rounded-xl bg-emerald-500/[0.08] px-3 py-2 text-[13px] text-emerald-200">{note}</p>}
          <ErrorNote message={error} />
          {shown.map((d) => (
            <Card key={`${d.day}-${trip.version}`} className={d.changed ? 'ring-1 ring-amber-400/30' : ''}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid size-7 place-items-center rounded-lg text-[12px] font-bold text-white" style={{ background: DAY_COLORS[(d.day - 1) % DAY_COLORS.length] }}>{d.day}</span>
                <h3 className="text-[15px] font-semibold text-white">{d.theme || `Day ${d.day}`}</h3>
                {d.date && <span className="text-[12px] text-ink-400">{new Date(d.date + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>}
                {d.weather && <Pill tone={d.weather.rain >= 60 ? 'info' : 'neutral'}>{d.weather.rain >= 60 ? <CloudRain className="size-3" /> : <CloudSun className="size-3" />} {Math.round(d.weather.tmin)}–{Math.round(d.weather.tmax)}°C · {d.weather.rain}% rain</Pill>}
                {d.changed && <Pill tone="warn">re-planned</Pill>}
                <span className="ml-auto flex items-center gap-2">
                  <RouteSummary route={d.route} />
                  <button type="button" className="chip" disabled={!!busy} onClick={() => void optimise(d.day)} title="Reorder for the least travel and re-time around rush hour">
                    <Shuffle className="size-3" /> Optimise route
                  </button>
                </span>
              </div>
              <DayInsights insights={d.insights} />
              <ol className="mt-3 space-y-1">
                {d.activities.map((a, i) => {
                  const Icon = KIND_ICON[a.kind]
                  const score = Object.values(a.votes).reduce((s, v) => s + v, 0)
                  const mine = a.votes[voter] ?? 0
                  const leg = d.route?.legs.find((l) => l.to === a.id)
                  const ends = (() => {
                    const [h, m] = a.time.split(':').map(Number)
                    const t = Math.min(23 * 60 + 30, (h ?? 9) * 60 + (m ?? 0) + a.duration_min)
                    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
                  })()
                  return (
                    <Fragment key={a.id}>
                    {leg && <LegRow leg={leg} />}
                    <li className={`flex items-start gap-3 rounded-xl p-2 transition ${focus === a.id ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'}`}>
                      <span className="w-11 shrink-0 pt-0.5 font-mono text-[12px] text-ink-400">{a.time}</span>
                      <button type="button" onClick={() => setFocus(a.id)} className="min-w-0 flex-1 text-left">
                        <p className="flex items-center gap-1.5 text-[14px] font-medium text-white">
                          <Icon className="size-3.5 shrink-0 text-ink-400" /> {a.name}
                          {a.lat == null && <span className="text-[10.5px] text-ink-500">(not on map)</span>}
                        </p>
                        {a.note && <p className="text-[12.5px] text-ink-400">{a.note}</p>}
                        <p className="text-[11px] text-ink-500">{d.day}.{i + 1} · {a.duration_min} min{a.label ? ` · ${a.label}` : ''}{a.added ? ` · added (${a.added === 'meal' ? 'meal slot' : 'nearby'})` : ''}</p>
                      </button>
                      <div className="flex shrink-0 items-center gap-0.5">
                        {a.lat != null && (
                          <button type="button" aria-label={`Explore near ${a.name}`} aria-expanded={nearbyFor === a.id} onClick={() => setNearbyFor(nearbyFor === a.id ? null : a.id)} className={`grid size-7 place-items-center rounded-lg ${nearbyFor === a.id ? 'bg-white/10 text-white' : 'text-ink-500 hover:text-white'}`} title="Food and sights nearby"><Compass className="size-3.5" /></button>
                        )}
                        <button type="button" aria-label={`Upvote ${a.name}`} onClick={() => void vote(a, 1)} className={`grid size-7 place-items-center rounded-lg ${mine === 1 ? 'bg-emerald-500/15 text-emerald-300' : 'text-ink-500 hover:text-white'}`}><ThumbsUp className="size-3.5" /></button>
                        <span className={`w-5 text-center text-[12px] tabular-nums ${score > 0 ? 'text-emerald-300' : score < 0 ? 'text-rose-300' : 'text-ink-500'}`}>{score}</span>
                        <button type="button" aria-label={`Downvote ${a.name}`} onClick={() => void vote(a, -1)} className={`grid size-7 place-items-center rounded-lg ${mine === -1 ? 'bg-rose-500/15 text-rose-300' : 'text-ink-500 hover:text-white'}`}><ThumbsDown className="size-3.5" /></button>
                      </div>
                    </li>
                    {nearbyFor === a.id && (
                      <li className="pl-14">
                        <NearbyPanel tripId={trip.id} day={d.day} activityId={a.id} defaultTime={ends} onAdded={(t) => { keep(t); setNearbyFor(null); setNote(`Added to day ${d.day}; travel times updated.`) }} />
                      </li>
                    )}
                    </Fragment>
                  )
                })}
              </ol>
            </Card>
          ))}
          <Card>
            <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><Wand2 className="size-4 text-emerald-300" /> Something changed?</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {['My flight is delayed 4 hours on day 1', 'It will rain all day on day 2', 'Make day 2 more relaxed, we are tired', 'Swap in more local food on day 1'].map((x) => (
                <button key={x} type="button" className="chip" onClick={() => setEvent(x)}>{x}</button>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <input id="replan-input" className={inputClass} value={event} onChange={(e) => setEvent(e.target.value)} placeholder="Describe what changed…" />
              <Button accent={ACCENT} onClick={() => void replan()} busy={busy?.startsWith('Re-plan')} disabled={event.trim().length < 5}>Re-plan</Button>
            </div>
            {busy && <div className="mt-2"><Spinner label={busy} /></div>}
          </Card>
          {trip.tips.length > 0 && (
            <Card>
              <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><Lightbulb className="size-4 text-amber-300" /> Tips</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-ink-200">{trip.tips.map((t) => <li key={t}>{t}</li>)}</ul>
            </Card>
          )}
          {trip.history.length > 0 && (
            <Card>
              <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><History className="size-4 text-ink-300" /> Changes</p>
              <ol className="mt-2 space-y-2">
                {[...trip.history].reverse().map((h) => (
                  <li key={h.version + h.at} className="text-[12.5px]">
                    <span className="text-ink-400">v{h.version} → v{h.version + 1} · </span>
                    <span className="text-ink-200">{h.event}</span>
                    <p className="text-ink-400">{h.explanation}</p>
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </div>
        <div className="order-1 h-[380px] overflow-hidden rounded-2xl border border-white/[0.07] lg:sticky lg:top-22 lg:order-2 lg:h-[calc(100vh-8rem)]">
          <Suspense fallback={<div className="grid size-full place-items-center"><Spinner label="Loading map…" /></div>}>
            <TripMap center={[trip.city.lat, trip.city.lng]} days={mapDays} activeDay={day} focus={focus} onSelect={select} />
          </Suspense>
        </div>
      </div>
      {trip.days.length === 0 && <Empty icon={Route} title="Empty itinerary" text="Try re-planning." />}
    </div>
  )
}
