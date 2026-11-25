import {
  Bot, CalendarCheck, Check, CalendarDays, ChevronDown, ChevronUp, CloudRain, CloudSun, Compass, Copy, ExternalLink, FileText,
  History, Landmark, Lightbulb, MapPin, PencilLine, Pin, PiggyBank, Plus, RefreshCw, Route, Share2, Shuffle,
  Soup, Star, ThumbsDown, ThumbsUp, TrainFront, Trash2, Trees, Umbrella, Users, UtensilsCrossed, Wand2, WifiOff, X, Zap, TriangleAlert,
} from 'lucide-react'  // prettier-ignore
import { AnimatePresence, motion } from 'motion/react'
import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import '@fontsource-variable/fraunces'
import { API_BASE } from './config'
import { navigate, usePath } from '@appcore/web/router'
import { errorText } from '@appcore/web/http'
import { Button, Card, Empty, ErrorNote, Field, inputClass, Pill, ProductShell, Spinner, Steps, Tabs } from '@appcore/web/ui'
import { rememberShareKey, shareKeyFor, tripApi, trips as tripsApi } from './api'
import { Bookings } from './Bookings'
import { Budget } from './Budget'
import { DAY_COLORS } from './colors'
import { Companion } from './Companion'
import { Documents } from './Documents'
import { Explore } from './Explore'
import { forecastFreshness } from './freshness'
import { dateRange, endTime, groupByPart, groupTrips, isMoment, PHASE_LABEL, safeLink, shareUrl } from './logic'
import { appPath, getBase, setBase } from './base'
import { Summary, TripGlance } from './Overview'
import './styles/safarnama.css'
import { Connector, DayCheck, DayHeader, StopDot, useDone } from './DayParts'
import { DestinationStrip, HeroChip, PhotoCredits, PlaceImage, TripHero } from './Visuals'
import { ACCENT, QuickPlan, usePlanStream } from './QuickPlan'
import { Handoff, LabelChips } from './parts'
import { setAwayTrip } from './away'
import { AwayCheck } from './AwayCheck'
import { AccountBar } from './AccountBar'
import { fmtMin, NearbyPanel } from './Travel'

const TripMap = lazy(() => import('./TripMap').then((m) => ({ default: m.TripMap })))
const KIND_ICON = { outdoor: Trees, indoor: Landmark, food: UtensilsCrossed, transit: TrainFront }
const EXAMPLES = [
  '3 relaxed days in Lisbon next week, love food markets and viewpoints',
  '5 days: 3 in Kyoto then 2 in Osaka for two, temples, tea houses and street food, from this Saturday',
  '2 days in Jaipur with kids, forts and street food',
]
const CACHE = 'tripweaver-last'
const PART_LABEL = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' }
const PARTY_LABEL = { solo: 'Solo', couple: 'Couple', family: 'Family', friends: 'Friends', group: 'Group' }
const HERO_BTN = 'inline-flex items-center gap-1.5 rounded-full bg-[#fff]/15 px-3 py-1.5 text-[12.5px] font-medium text-[#fff] backdrop-blur-md transition hover:bg-[#fff]/25'

/** Safarnaama. `basePath` is where it is mounted: '' on its own site, '/safarnaama' inside the portfolio. */
export default function SafarnamaApp({ basePath = '' }) {
  setBase(basePath)
  const path = usePath()
  const tripId = path.startsWith(`${getBase()}/`) ? (path.slice(getBase().length + 1).match(/^([\w-]+)/)?.[1] ?? null) : null
  return (
    <ProductShell name="Safarnaama" tagline="Plan, book and keep every journey in one place" icon={Route} accent={ACCENT} product="safarnama">
      {tripId ? <TripView key={tripId} id={tripId} /> : <MyTrips />}
    </ProductShell>
  )
}

// ── My trips ────────────────────────────────────────────────────────────────
const plusDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number)
  const t = new Date(y, m - 1, d + n)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

/** The server keeps trips only when it has its database; on a serverless host without one they can vanish. */
function useStorageWarning() {
  const [warn, setWarn] = useState(false)
  useEffect(() => {
    if (/localhost|127\.0\.0\.1/.test(API_BASE)) return // a local server keeps its SQLite file
    const ctrl = new AbortController()
    fetch(`${API_BASE}/api/health`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => setWarn(h?.storage === 'sqlite'))
      .catch(() => {})
    return () => ctrl.abort()
  }, [])
  return warn
}

function MyTrips() {
  const [mode, setMode] = useState('quick')
  const [trips, setTrips] = useState(null)
  const [error, setError] = useState(null)
  const storageWarning = useStorageWarning()
  const load = useCallback(() => tripsApi.list().then(setTrips).catch((e) => (setTrips([]), setError(errorText(e)))), [])
  useEffect(() => void load(), [load])
  const groups = useMemo(() => groupTrips(trips ?? []), [trips])

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="pt-2 text-center">
        <p className="pa-ink text-[12px] font-semibold tracking-[0.18em] uppercase">Safarnaama · your travelogue</p>
        <h1 className="pa-display mt-2 text-[44px] leading-[1.02] font-semibold text-white sm:text-[64px]">
          Where to <span className="pa-gradient-text">next?</span>
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-[15px] text-ink-400">Four taps to a day-by-day plan with real places, weather and routes. Then book, budget and keep your documents in one place.</p>
      </header>
      <AccountBar onTrips={load} />
      <DestinationStrip />
      {storageWarning && (
        <p className="mx-auto flex max-w-3xl items-start gap-2 rounded-2xl border border-amber-400/30 bg-amber-400/[0.08] px-4 py-3 text-[13px] text-ink-200">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <span>Heads-up: this server isn't connected to its database yet, so a trip can fail to open or disappear between visits. Planning works, but nothing is kept reliably until the database is connected.</span>
        </p>
      )}
      <div className="mx-auto max-w-3xl space-y-4">
        {mode === 'quick' ? <QuickPlan /> : mode === 'ai' ? <Planner /> : <ManualTrip />}
        <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[12.5px] text-ink-500">
          {mode !== 'quick' && <button type="button" className="inline-flex items-center gap-1 hover:text-white" onClick={() => setMode('quick')}><Zap className="size-3.5" /> Quick plan (4 taps)</button>}
          {mode !== 'ai' && <button type="button" className="inline-flex items-center gap-1 hover:text-white" onClick={() => setMode('ai')}><Wand2 className="size-3.5" /> Describe it in your words</button>}
          {mode !== 'manual' && <button type="button" className="inline-flex items-center gap-1 hover:text-white" onClick={() => setMode('manual')}><PencilLine className="size-3.5" /> Build it myself</button>}
        </p>
        <ErrorNote message={error} />
      </div>
      {trips === null ? <Spinner label="Loading your trips…" /> : trips.length === 0 ? (
        <p className="text-center text-[12.5px] text-ink-500">Your trips appear here. Without signing in they're tied to this browser; share a trip with its link.</p>
      ) : (
        groups.map((g) => (
          <section key={g.phase}>
            <h2 className="pa-display mb-3 text-[22px] font-semibold text-white">{PHASE_LABEL[g.phase]}</h2>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {g.trips.map((t) => (
                <li key={t.id} className="group relative">
                  <button type="button" onClick={() => navigate(appPath(`/${t.id}`))} className="block w-full overflow-hidden rounded-3xl border border-white/[0.07] bg-ink-900/60 text-left shadow-lg shadow-black/10 transition hover:-translate-y-0.5 hover:shadow-xl">
                    <span className="relative block h-36 overflow-hidden">
                      <PlaceImage name={t.destinations[0]} className="transition duration-700 group-hover:scale-[1.05]" />
                      <span className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                      <span className="absolute bottom-3 left-4 text-[12px] font-medium text-[#fff]/90">{t.destinations.join(' → ')}</span>
                    </span>
                    <span className="block p-4">
                      <span className="pa-display block pr-6 text-[19px] leading-tight font-semibold text-white">{t.title}</span>
                      <span className="mt-1 block text-[12.5px] text-ink-400">{t.start ? dateRange(t.start, plusDays(t.start, t.days - 1)) : 'No dates yet'} · {t.days} day{t.days === 1 ? '' : 's'}</span>
                    </span>
                  </button>
                  <button type="button" aria-label={`Delete ${t.title}`} onClick={() => window.confirm(`Delete “${t.title}” with its bookings, expenses and documents?`) && void tripApi(t.id).remove().then(load)}
                    className="absolute top-3 right-3 grid size-8 place-items-center rounded-full bg-black/40 text-[#fff]/85 backdrop-blur hover:text-rose-200 sm:opacity-0 sm:group-hover:opacity-100">
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <div className="mx-auto max-w-3xl"><PhotoCredits /></div>
    </div>
  )
}

function Planner() {
  const [prompt, setPrompt] = useState('')
  const { steps, busy, error, run } = usePlanStream()
  return (
    <Card>
      <textarea id="trip-prompt" className={`${inputClass} min-h-28 text-[15px]`} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe your trip: where (one or more places), when, how long, who's going, what you love…" />
      <div className="mt-3 flex flex-wrap items-center gap-2">{EXAMPLES.map((e) => <button key={e} type="button" className="chip" onClick={() => setPrompt(e)}>{e}</button>)}</div>
      <Button accent={ACCENT} className="mt-4 w-full" onClick={() => void run(prompt)} busy={busy} disabled={prompt.trim().length < 10}><Wand2 className="size-4" /> Plan my trip</Button>
      {steps.length > 0 && <div className="mt-4"><Steps steps={steps} active={busy} /></div>}
      <div className="mt-3"><ErrorNote message={error} /></div>
    </Card>
  )
}

function ManualTrip() {
  const [f, setF] = useState({ title: '', start_date: '', party: 'couple', travellers: 2, budget: '', currency: '', interests: '', pace: 'balanced' })
  const [dests, setDests] = useState([{ name: '', days: 2 }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }))
  const total = dests.reduce((n, d) => n + Number(d.days || 0), 0)
  const create = async () => {
    setBusy(true)
    setError(null)
    const body = { destinations: dests.filter((d) => d.name.trim()).map((d) => ({ name: d.name.trim(), days: Number(d.days) })), party: f.party, travellers: Number(f.travellers) || null,
      ...(f.currency ? { currency: f.currency.toUpperCase() } : {}), pace: f.pace, interests: f.interests.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10) }  // prettier-ignore
    if (f.title.trim()) body.title = f.title.trim()
    if (f.start_date) body.start_date = f.start_date
    if (f.budget !== '') body.budget = Number(f.budget)
    try {
      const t = await tripsApi.create(body)
      navigate(appPath(`/${t.id}`))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Trip name" hint="optional"><input className={inputClass} value={f.title} onChange={set('title')} placeholder="Summer in Portugal" /></Field>
        <Field label="Start date" hint="optional"><input type="date" className={inputClass} value={f.start_date} onChange={set('start_date')} /></Field>
      </div>
      <p className="mt-3 text-[12px] font-medium text-ink-300">Destinations, in order ({total} day{total === 1 ? '' : 's'}, max 14)</p>
      <ul className="mt-1.5 space-y-2">
        {dests.map((d, i) => (
          <li key={i} className="flex gap-2">
            <input aria-label={`Destination ${i + 1}`} className={inputClass} value={d.name} placeholder={i ? 'Then…' : 'City or region'} onChange={(e) => setDests((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} />
            <input aria-label={`Days in destination ${i + 1}`} type="number" min="1" max="14" className={`${inputClass} !w-20`} value={d.days} onChange={(e) => setDests((x) => x.map((y, j) => (j === i ? { ...y, days: e.target.value } : y)))} />
            {dests.length > 1 && <button type="button" aria-label="Remove destination" className="text-ink-500 hover:text-rose-300" onClick={() => setDests((x) => x.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button>}
          </li>
        ))}
      </ul>
      {dests.length < 5 && <button type="button" className="chip mt-2" onClick={() => setDests((x) => [...x, { name: '', days: 1 }])}><Plus className="size-3" /> Add a destination</button>}
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="Who's travelling"><select className={inputClass} value={f.party} onChange={set('party')}>{['solo', 'couple', 'family', 'friends', 'group'].map((p) => <option key={p}>{p}</option>)}</select></Field>
        <Field label="Travellers"><input type="number" min="1" max="50" className={inputClass} value={f.travellers} onChange={set('travellers')} /></Field>
        <Field label="Pace"><select className={inputClass} value={f.pace} onChange={set('pace')}><option>relaxed</option><option>balanced</option><option>packed</option></select></Field>
        <Field label="Budget" hint="optional"><input type="number" min="0" className={inputClass} value={f.budget} onChange={set('budget')} /></Field>
        <Field label="Currency" hint="blank = local currency"><input maxLength={3} className={`${inputClass} uppercase`} value={f.currency} onChange={set('currency')} placeholder="auto" /></Field>
        <Field label="Interests" hint="comma-separated"><input className={inputClass} value={f.interests} onChange={set('interests')} placeholder="food, museums" /></Field>
      </div>
      <Button accent={ACCENT} className="mt-4 w-full" busy={busy} onClick={() => void create()} disabled={!dests.some((d) => d.name.trim().length >= 2) || total < 1 || total > 14 || (f.currency.length > 0 && f.currency.length !== 3)}>
        <Plus className="size-4" /> Create trip
      </Button>
      <div className="mt-3"><ErrorNote message={error} /></div>
    </Card>
  )
}

// ── one trip ────────────────────────────────────────────────────────────────
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
  const api = useMemo(() => {
    const share = new URLSearchParams(window.location.search).get('share')
    if (share) rememberShareKey(id, share)
    return tripApi(id)
  }, [id])
  const [trip, setTrip] = useState(null)
  const [offline, setOffline] = useState(false)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)
  const [live, setLive] = useState(false)
  const [tab, setTab] = useState('plan')
  const [chat, setChat] = useState(false)
  const [pins, setPins] = useState([])
  const [bookingPrefill, setBookingPrefill] = useState(null)
  useEffect(() => {
    setAwayTrip(id)
    return () => setAwayTrip(null)
  }, [id])

  const keep = useCallback((t) => {
    setTrip(t)
    try {
      localStorage.setItem(`${CACHE}-${t.id}`, JSON.stringify(t)) // offline copy
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    api.get().then(keep).catch((e) => {
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
  }, [api, id, keep])

  // Live updates from everyone viewing this trip (votes, re-plans). Each (re)connect resyncs the full trip.
  const shareKey = trip?.share_key ?? shareKeyFor(id)
  useEffect(() => {
    if (!trip) return
    let es = null
    let watchdog = 0
    const resync = () => void api.get().then(keep).catch(() => {})
    const arm = () => {
      window.clearTimeout(watchdog)
      watchdog = window.setTimeout(connect, 30_000)
    }
    function connect() {
      es?.close()
      es = new EventSource(api.liveUrl(shareKey))
      es.onopen = () => {
        setLive(true)
        resync()
        arm()
      }
      es.onerror = () => setLive(false)
      es.addEventListener('ping', arm)
      es.addEventListener('trip', (e) => {
        arm()
        const t = JSON.parse(e.data).trip
        setTrip((cur) => (cur ? { ...cur, ...t, role: cur.role } : t))
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
  }, [api, keep, shareKey, !!trip]) // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async () => {
    try {
      const t = await api.copy()
      navigate(appPath(`/${t.id}`))
    } catch (e) {
      setError(errorText(e))
    }
  }

  if (error && !trip)
    return (
      <div className="space-y-3">
        <ErrorNote message={error.includes('not found') ? "This trip doesn't exist, or you need its share link to open it." : error} />
        <button type="button" className="chip" onClick={() => navigate(appPath())}>← My trips</button>
      </div>
    )
  if (!trip) return <Spinner label="Loading trip…" />
  const owner = trip.role === 'owner'
  const member = trip.role === 'member'
  // Four tabs, like the travel planners people already know: the plan (with the trip at a glance on top), places to
  // explore, bookings with their documents, and the budget. The companion is a button that's there on every tab, and
  // the summary appears on the plan once the trip is over.
  const tabs = [
    { id: 'plan', label: 'Plan', icon: CalendarDays },
    { id: 'explore', label: 'Explore', icon: Compass },
    ...(owner ? [{ id: 'bookings', label: 'Bookings', icon: CalendarCheck }] : []),
    ...(owner || member ? [{ id: 'budget', label: 'Budget', icon: PiggyBank }] : []),
  ]

  return (
    <div className="space-y-4">
      <button type="button" className="text-[12.5px] text-ink-400 hover:text-white" onClick={() => navigate(appPath())}>← My trips</button>
      <TripHero
        trip={trip}
        chips={<>
          {trip.days[0]?.date && <HeroChip><CalendarDays className="size-3" /> {dateRange(trip.days[0].date, trip.days.at(-1).date)}</HeroChip>}
          <HeroChip>{trip.days.length} day{trip.days.length === 1 ? '' : 's'}</HeroChip>
          {trip.party?.type && <HeroChip><Users className="size-3" /> {PARTY_LABEL[trip.party.type] ?? trip.party.type}{trip.party.travellers ? ` · ${trip.party.travellers}` : ''}</HeroChip>}
          {trip.weather_updated_at && <HeroChip><CloudSun className="size-3" /> {forecastFreshness(trip.weather_updated_at).label}</HeroChip>}
          {!owner && <HeroChip tone="warn">{member ? 'Shared with you' : 'Read-only (created before trip ownership)'}</HeroChip>}
          {live ? <HeroChip tone="good"><Users className="size-3" /> live</HeroChip> : offline && <HeroChip tone="warn"><WifiOff className="size-3" /> offline copy</HeroChip>}
        </>}
        actions={<>
          {owner && trip.share_key && (
            <button type="button" className={HERO_BTN} onClick={() => void navigator.clipboard.writeText(shareUrl(location.origin, trip.id, trip.share_key)).then(() => setNote('Share link copied: people with it can view the itinerary, vote and add shared expenses. Documents and bookings stay private.'))}>
              <Share2 className="size-3.5" /> Share
            </button>
          )}
          {owner && <button type="button" className={HERO_BTN} title="Create a new share link (the old one stops working)" onClick={() => void api.rotateShare().then((t) => { keep(t); setNote('New share link created; the old one no longer works.') })}><RefreshCw className="size-3.5" /><span className="sr-only sm:not-sr-only">New link</span></button>}
          {!owner && <button type="button" className={HERO_BTN} onClick={() => void copy()}><Copy className="size-3.5" /> Save a copy</button>}
          {owner && trip.status !== 'archived' && trip.phase === 'past' && <button type="button" className={HERO_BTN} onClick={() => void api.update({ status: 'archived' }).then(keep)}>Archive</button>}
          {owner && trip.status === 'archived' && <button type="button" className={HERO_BTN} onClick={() => void api.update({ status: 'planning' }).then(keep)}>Unarchive</button>}
        </>}
      />

      <Tabs tabs={tabs} value={tab} onChange={(t) => { setTab(t); setPins([]); setNote(null) }} />
      {note && <p className="rounded-xl bg-emerald-500/[0.08] px-3 py-2 text-[13px] text-emerald-200">{note} <button type="button" className="ml-2 text-emerald-300/70 hover:text-white" onClick={() => setNote(null)}>dismiss</button></p>}
      <ErrorNote message={error} />

      {tab === 'plan' && owner && trip.phase === 'past' && <Summary trip={trip} api={api} />}
      {tab === 'plan' && <TripGlance trip={trip} api={api} owner={owner} goTab={setTab} />}
      {tab === 'bookings' && owner && (
        <>
          <Bookings trip={trip} api={api} setNote={setNote} prefill={bookingPrefill} onUsedPrefill={() => setBookingPrefill(null)} />
          <h2 className="pa-display flex items-center gap-2 pt-2 text-[19px] font-semibold text-white"><FileText className="pa-ink size-4" /> Documents & checklists</h2>
          <Documents trip={trip} api={api} onTrip={keep} setNote={setNote} />
        </>
      )}
      {tab === 'budget' && <Budget trip={trip} api={api} owner={owner} onTrip={keep} setNote={setNote} />}
      {['plan', 'explore'].includes(tab) && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="order-2 min-w-0 lg:order-1">
            {tab === 'plan' && <Itinerary trip={trip} api={api} owner={owner} keep={keep} setNote={setNote} setError={setError} onBook={(p) => { setBookingPrefill(p); setTab('bookings') }} setPins={setPins} />}
            {tab === 'explore' && <Explore trip={trip} api={api} owner={owner} onTrip={keep} onPins={setPins} setNote={setNote} />}
          </div>
          <div className="order-1 h-[320px] overflow-hidden rounded-2xl border border-white/[0.07] sm:h-[380px] lg:sticky lg:top-22 lg:order-2 lg:h-[calc(100vh-8rem)]">
            <Suspense fallback={<div className="grid size-full place-items-center"><Spinner label="Loading map…" /></div>}>
              <TripMapFor trip={trip} pins={pins} />
            </Suspense>
          </div>
        </div>
      )}
      {owner && <AwayCheck key={trip.id} trip={trip} api={api} setNote={setNote} onDetails={(p) => { setBookingPrefill(p); setTab('bookings') }} />}
      {owner && (
        <CompanionDock open={chat} onOpen={setChat}>
          <Companion trip={trip} api={api} onTrip={keep} setNote={setNote} onPins={(p) => { setPins(p); if (p?.length && tab !== 'plan' && tab !== 'explore') setTab('plan') }} />
        </CompanionDock>
      )}
    </div>
  )
}

/** The travel companion as a button that's there on every tab, opening a panel over the page. */
function CompanionDock({ open, onOpen, children }) {
  useEffect(() => {
    if (!open) return
    const close = (e) => e.key === 'Escape' && onOpen(false)
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open, onOpen])
  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.aside
            role="dialog"
            aria-label="Travel companion"
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.98 }}
            transition={{ duration: 0.2 }}
            className="fixed right-4 bottom-20 z-40 flex max-h-[min(78vh,720px)] w-[min(440px,calc(100vw-2rem))] flex-col overflow-hidden rounded-3xl border border-white/10 bg-ink-900 shadow-2xl"
          >
            <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-3">
              <Bot className="pa-ink size-4" />
              <p className="text-[14px] font-semibold text-white">Travel companion</p>
              <button type="button" className="ml-auto grid size-7 place-items-center rounded-full text-ink-400 hover:bg-white/[0.06] hover:text-white" aria-label="Close the companion" onClick={() => onOpen(false)}><X className="size-4" /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
          </motion.aside>
        )}
      </AnimatePresence>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpen(!open)}
        className="btn-primary pa-gradient fixed right-4 bottom-4 z-40 inline-flex items-center gap-2 rounded-full px-4 py-3 text-[13.5px] font-semibold text-on-accent shadow-xl"
      >
        {open ? <X className="size-4" /> : <Bot className="size-4" />} {open ? 'Close' : 'Ask the companion'}
      </button>
    </>
  )
}

function TripMapFor({ trip, pins }) {
  const [focus, setFocus] = useState(null)
  // Only redraw/refit when stops actually change (live updates re-send the whole trip, e.g. after a vote).
  const sig = JSON.stringify(trip.days.map((d) => d.activities.map((a) => [a.id, a.lat, a.lng, a.time, a.name])))
  const days = useMemo(() => trip.days.map((d) => ({ day: d.day, activities: d.activities })), [sig]) // eslint-disable-line react-hooks/exhaustive-deps
  const select = useCallback((aid) => setFocus(aid), [])
  const c = trip.destinations?.[0] ?? trip.city
  return <TripMap center={[c.lat, c.lng]} days={days} activeDay={null} focus={focus} onSelect={select} extra={pins} />
}

/** Provider links stored on a stop (from OpenStreetMap), offered only as confirmed hand-offs. */
function stopLinks(a) {
  return [
    a.reservation_url && { kind: 'booking', label: 'Book on the venue site', url: a.reservation_url },
    a.menu && { kind: 'menu', label: 'Menu / order', url: a.menu },
    a.website && { kind: 'website', label: 'Website', url: a.website },
  ].filter((l) => l && safeLink(l.url)).map((l) => ({ ...l, source: 'OpenStreetMap' }))
}

function Itinerary({ trip, api, owner, keep, setNote, setError, onBook, setPins }) {
  const [day, setDay] = useState(null)
  const [event, setEvent] = useState('')
  const [scope, setScope] = useState([])
  const [busy, setBusy] = useState(null)
  const [alerts, setAlerts] = useState([])
  const [voter, setVoter] = useVoter()
  const [nearbyFor, setNearbyFor] = useState(null)
  const [open, setOpen] = useState(null) // the stop whose details are showing
  const [done, toggleDone] = useDone(trip.id)
  const [editing, setEditing] = useState(null)
  const [alts, setAlts] = useState(null)
  const [handoff, setHandoff] = useState(null)
  const [newStop, setNewStop] = useState({ day: trip.days[0]?.day ?? 1, name: '', time: '15:00' })
  const [newDest, setNewDest] = useState({ name: '', days: 1 })

  const run = async (label, fn, done) => {
    setBusy(label)
    setError(null)
    try {
      const out = await fn()
      done?.(out)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  const replan = (text = event, days = scope) =>
    run('Re-planning…', () => api.replan(text, days), (out) => {
      keep(out.trip)
      setNote(out.explanation)
      setEvent('')
      setAlerts([])
      setDay(out.days_changed[0] ?? null)
    })
  const checkWeather = () => run('Checking the latest forecast…', () => api.weather(), (out) => {
    keep(out.trip)
    setAlerts(out.alerts)
    setNote(out.alerts.length ? null : 'Forecast checked: no wet days clash with outdoor plans.')
  })
  const optimise = (n) => run(`Optimising day ${n}…`, () => api.optimise(n), (out) => {
    keep(out.trip)
    const saved = out.travel_before - out.travel_after
    setNote(saved > 0 ? `Day ${n} reordered: ${fmtMin(saved)} less travel, times updated.` : `Day ${n} was already in the best order; times updated for travel and rush hour.`)
  })
  const edit = (a, changes, msg) => run('Saving…', () => api.editActivity(a.id, changes), (t) => { keep(t); if (msg) setNote(msg) })
  const vote = async (a, value) => {
    if (!voter.trim()) return setNote('Add your name (above the itinerary) to vote.')
    const name = voter.trim()
    const next = (a.votes[name] ?? 0) === value ? 0 : value
    await api.vote({ activity_id: a.id, voter: name, value: next }).then(keep).catch((e) => setError(errorText(e)))
  }
  const showAlts = (a) => run('Finding indoor alternatives…', () => api.alternatives(a.id), (out) => { setAlts({ ...out, for: a.id }); setPins(out.places) })

  const shown = day == null ? trip.days : trip.days.filter((d) => d.day === day)
  const destName = (d) => (trip.destinations ?? []).find((x) => x.id === d.destination)?.name

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex w-full min-w-0 gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
          <button type="button" onClick={() => setDay(null)} className={`chip shrink-0 whitespace-nowrap ${day == null ? '!bg-white/10 !text-white' : ''}`}>All days</button>
          {trip.days.map((d) => (
            <button key={d.day} type="button" onClick={() => setDay(d.day)} className={`chip shrink-0 ${day === d.day ? '!bg-white/10 !text-white' : ''}`}>
              <span className="size-2 rounded-full" style={{ background: DAY_COLORS[(d.day - 1) % DAY_COLORS.length] }} />
              Day {d.day}
              {d.weather?.tmax != null && <span className={d.weather.rain >= 60 ? 'text-sky-300' : 'text-ink-400'}>{d.weather.rain >= 60 ? <CloudRain className="inline size-3" /> : null} {Math.round(d.weather.tmax)}°</span>}
              {d.changed && <span className="text-amber-300">●</span>}
            </button>
          ))}
        </div>
        <input aria-label="Your name for voting" className={`${inputClass} !w-32 !py-1.5 text-[12.5px]`} placeholder="Your name" value={voter} onChange={(e) => setVoter(e.target.value)} />
        {owner && <Button variant="ghost" className="!py-1.5" onClick={() => void checkWeather()} disabled={!!busy}><CloudSun className="size-4" /> Check weather</Button>}
        {owner && <Button variant="ghost" className="!py-1.5" onClick={() => void run('Finding restaurants…', () => api.meals(), (out) => { keep(out.trip); setNote(out.added ? `Added ${out.added} meal stop${out.added > 1 ? 's' : ''} near where you'll be.` : 'Every day already has its meals planned.') })} disabled={!!busy}><Soup className="size-4" /> Add meal stops</Button>}
      </div>
      {busy && <Spinner label={busy} />}
      <AnimatePresence>
        {alerts.map((a) => (
          <motion.div key={a.day} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-center gap-2 rounded-xl border border-sky-400/25 bg-sky-500/[0.08] px-3 py-2 text-[13px] text-sky-200">
            <CloudRain className="size-4" /> Day {a.day}: {a.rain}% rain, outdoor plans: {a.outdoor.join(', ')}
            <button type="button" className="chip ml-auto" onClick={() => void replan(`Rain is forecast on day ${a.day} (${a.rain}%). Move outdoor activities indoors or to a drier time.`, [a.day])}>Re-plan day {a.day}</button>
          </motion.div>
        ))}
      </AnimatePresence>

      {shown.map((d) => (
        <Card key={`${d.day}-${trip.version}`} className={`!p-4 sm:!p-6 ${d.changed ? 'ring-1 ring-amber-400/30' : ''}`}>
          <DayHeader
            d={d}
            done={done}
            multiDest={(trip.destinations?.length ?? 0) > 1}
            destName={destName(d)}
            right={<>
              {d.changed && <Pill tone="warn">re-planned</Pill>}
              {owner && d.activities.length > 1 && <button type="button" className="chip" disabled={!!busy} onClick={() => void optimise(d.day)} title="Reorder for the least travel and re-time around rush hour"><Shuffle className="size-3" /> Optimise</button>}
            </>}
          />
          {(d.best_window || d.rain_spells?.length > 0) && (
            <p className="mt-2 flex items-start gap-1.5 text-[12px] text-sky-300">
              <CloudRain className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {d.rain_spells?.length > 0 && <>Rain likely {d.rain_spells.map((s) => `${s.from}–${s.to} (${s.max}%)`).join(', ')}. </>}
                {d.best_window && <>Driest window {d.best_window.from}–{d.best_window.to}.</>}
              </span>
            </p>
          )}
          <DayCheck d={d} owner={owner} busy={!!busy} onFixTiming={() => void optimise(d.day)} onFind={(aid) => { setEditing(aid); setOpen(aid) }} />
          {d.activities.length === 0 && <p className="mt-4 text-[13px] text-ink-400">Nothing planned yet. Add a stop below, or find places in Explore.</p>}
          {groupByPart(d.activities).map(({ part, items }) => (
            <div key={part} className="mt-4">
              <p className="mb-1 pl-[60px] text-[11px] font-semibold tracking-[0.14em] text-ink-500 uppercase">{PART_LABEL[part]}</p>
              <ol>
                {items.map(({ a, index: i }) => {
                  const Icon = KIND_ICON[a.kind] ?? Trees
                  const moment = isMoment(a)
                  const score = Object.values(a.votes ?? {}).reduce((s, v) => s + v, 0)
                  const mine = (a.votes ?? {})[voter] ?? 0
                  const leg = d.route?.legs.find((l) => l.to === a.id)
                  const links = stopLinks(a)
                  const weatherDep = (a.labels ?? []).some((l) => l.id === 'weather_dependent')
                  const isOpen = open === a.id
                  const isDone = done.has(a.id)
                  const bookable = !moment && (a.kind === 'food' || a.kind === 'indoor' || (a.labels ?? []).some((l) => l.id === 'reservation'))
                  if (moment)
                    return (
                      <Fragment key={a.id}>
                        <li className="grid grid-cols-[52px_28px_1fr] items-center gap-x-2 py-1">
                          <span className="text-right font-mono text-[11.5px] text-ink-500">{a.time}</span>
                          <span className="grid place-items-center"><StopDot a={a} Icon={Icon} moment /></span>
                          <button type="button" onClick={() => setOpen(isOpen ? null : a.id)} className="min-w-0 text-left text-[12.5px] text-ink-400 hover:text-ink-200">
                            <span className="text-ink-300">{a.name}</span> · {fmtMin(a.duration_min)}
                            {isOpen && a.note && <span className="block text-ink-500">{a.note}</span>}
                          </button>
                        </li>
                        {isOpen && owner && (
                          <li className="pl-[88px]">
                            <div className="flex flex-wrap gap-1.5 pb-1">
                              <button type="button" className="chip" onClick={() => setEditing(editing === a.id ? null : a.id)}><PencilLine className="size-3" /> Edit</button>
                            </div>
                            {editing === a.id && (
                              <EditStop a={a} trip={trip} day={d} index={i} busy={!!busy}
                                onSave={(changes) => void edit(a, changes, 'Saved; the day was re-timed and re-checked.')}
                                onMove={(toDay, index) => void run('Moving…', () => api.moveActivity(a.id, toDay, index), (t) => { keep(t); setEditing(null) })}
                                onDelete={() => void run('Removing…', () => api.deleteActivity(a.id), (t) => { keep(t); setEditing(null) })} />
                            )}
                          </li>
                        )}
                      </Fragment>
                    )
                  return (
                    <Fragment key={a.id}>
                      <Connector leg={leg} />
                      <li className="grid grid-cols-[52px_28px_1fr] gap-x-2">
                        <div className="pt-2.5 text-right">
                          <p className={`font-mono text-[13px] font-semibold ${isDone ? 'text-ink-500 line-through' : 'text-white'}`}>{a.time}</p>
                          <p className="text-[10.5px] text-ink-500">{fmtMin(a.duration_min)}</p>
                        </div>
                        <div className="flex justify-center pt-2"><StopDot a={a} Icon={Icon} done={isDone} /></div>
                        <motion.div layout="position" className={`mb-1 min-w-0 rounded-2xl border transition ${isOpen ? 'border-white/10 bg-white/[0.04]' : 'border-transparent hover:bg-white/[0.03]'}`}>
                          <div className="flex items-start gap-2 p-2.5">
                            <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : a.id)} className="min-w-0 flex-1 text-left">
                              <p className={`flex flex-wrap items-center gap-1.5 text-[14.5px] font-semibold ${isDone ? 'text-ink-400 line-through' : 'text-white'}`}>
                                {a.name}
                                {a.pinned && <Pin className="size-3 text-amber-400" aria-label="pinned" />}
                                {a.lat == null && <span className="rounded-full bg-amber-400/15 px-1.5 py-px text-[10.5px] font-medium text-amber-300 no-underline">no map pin</span>}
                              </p>
                              {a.note && <p className={`mt-0.5 text-[12.5px] text-ink-400 ${isOpen ? '' : 'line-clamp-1'}`}>{a.note}</p>}
                              <LabelChips labels={a.labels} />
                            </button>
                            <div className="flex shrink-0 items-center gap-1">
                              <button type="button" aria-label={`Upvote ${a.name}`} onClick={() => void vote(a, mine === 1 ? 0 : 1)} className={`inline-flex h-7 items-center gap-1 rounded-full px-2 text-[12px] ${mine === 1 ? 'bg-emerald-500/15 text-emerald-300' : 'text-ink-500 hover:text-white'}`}>
                                <ThumbsUp className="size-3.5" />{score !== 0 && <span className="tabular-nums">{score}</span>}
                              </button>
                              <button type="button" aria-label={isDone ? `Mark ${a.name} not done` : `Mark ${a.name} done`} aria-pressed={isDone} onClick={() => toggleDone(a.id)}
                                className={`grid size-7 place-items-center rounded-full border transition ${isDone ? 'border-emerald-400/50 bg-emerald-500/20 text-emerald-300' : 'border-white/10 text-ink-500 hover:border-white/25 hover:text-white'}`}>
                                <Check className="size-3.5" />
                              </button>
                            </div>
                          </div>
                          <AnimatePresence initial={false}>
                            {isOpen && (
                              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                                <div className="flex flex-wrap gap-1.5 px-2.5 pb-2.5">
                                  <span className="mr-1 self-center text-[11px] text-ink-500">until {endTime(a)}{a.added ? ` · added (${a.added === 'meal' ? 'meal slot' : a.added})` : ''}</span>
                                  {a.lat != null && <button type="button" className="chip" aria-expanded={nearbyFor === a.id} onClick={() => setNearbyFor(nearbyFor === a.id ? null : a.id)}><Compass className="size-3" /> Food & sights nearby</button>}
                                  {links.map((l) => <button key={l.url} type="button" className="chip" onClick={() => setHandoff({ link: l, place: a })}><ExternalLink className="size-3" /> {l.label}</button>)}
                                  {owner && weatherDep && <button type="button" className="chip" onClick={() => void showAlts(a)}><Umbrella className="size-3" /> Indoor alternatives</button>}
                                  {owner && bookable && <button type="button" className="chip" onClick={() => onBook({ type: a.kind === 'food' ? 'restaurant' : 'ticket', title: a.name, activity_id: a.id, day: d.day, url: links[0]?.url ?? '' })}><CalendarCheck className="size-3" /> Save a booking</button>}
                                  <button type="button" aria-label={`Downvote ${a.name}`} className={`chip ${mine === -1 ? '!text-rose-300' : ''}`} onClick={() => void vote(a, mine === -1 ? 0 : -1)}><ThumbsDown className="size-3" /> Not for us</button>
                                  {owner && <button type="button" aria-label={`Edit ${a.name}`} aria-expanded={editing === a.id} className="chip" onClick={() => setEditing(editing === a.id ? null : a.id)}><PencilLine className="size-3" /> {a.lat == null ? 'Edit or pin on the map' : 'Edit'}</button>}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                          {editing === a.id && owner && (
                            <div className="px-2.5 pb-2.5">
                              <EditStop a={a} trip={trip} day={d} index={i} busy={!!busy}
                                onSave={(changes) => void edit(a, changes, 'Saved; the day was re-timed and re-checked.')}
                                onMove={(toDay, index) => void run('Moving…', () => api.moveActivity(a.id, toDay, index), (t) => { keep(t); setEditing(null) })}
                                onDelete={() => void run('Removing…', () => api.deleteActivity(a.id), (t) => { keep(t); setEditing(null) })} />
                            </div>
                          )}
                          {alts?.for === a.id && (
                            <div className="mx-2.5 mb-2.5 rounded-xl border border-white/[0.07] bg-ink-950/40 p-3">
                              <p className="text-[12.5px] text-ink-300">Indoor places near {alts.around} (OpenStreetMap):</p>
                              {alts.places.length === 0 ? <p className="text-[12.5px] text-ink-500">None found nearby.</p> : (
                                <ul className="mt-1 space-y-1">
                                  {alts.places.slice(0, 6).map((p) => (
                                    <li key={p.name} className="flex items-center gap-2 text-[12.5px]">
                                      <span className="min-w-0 flex-1 truncate text-white">{p.name} <span className="text-ink-400">· {p.category} · {p.distance_m} m</span></span>
                                      {p.planned ? <span className="text-ink-500">in plan</span> : (
                                        <button type="button" className="chip" onClick={() => void run('Swapping…', async () => {
                                          await api.addStop(d.day, { name: p.name, lat: p.lat, lng: p.lng, kind: 'indoor', time: a.time, duration_min: a.duration_min, added: 'discovery', distance_m: p.distance_m, near: a.name, ...(p.opening_hours ? { opening_hours: p.opening_hours } : {}), ...(p.website ? { website: p.website } : {}) })
                                          return api.deleteActivity(a.id)
                                        }, (t) => { keep(t); setAlts(null); setNote(`Swapped ${a.name} for ${p.name}.`) })}>Swap in</button>
                                      )}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          )}
                        </motion.div>
                      </li>
                      {nearbyFor === a.id && (
                        <li className="pl-[88px]">
                          <NearbyPanel api={api} day={d.day} activityId={a.id} activityName={a.name} defaultTime={endTime(a)} onAdded={(t) => { keep(t); setNearbyFor(null); setNote(`Added to day ${d.day}; travel times updated.`) }} />
                        </li>
                      )}
                    </Fragment>
                  )
                })}
              </ol>
            </div>
          ))}
        </Card>
      ))}

      {owner && (
        <Card>
          <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><Plus className="pa-ink size-4" /> Add a stop</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <select aria-label="Day" className={`${inputClass} !w-auto`} value={newStop.day} onChange={(e) => setNewStop((s) => ({ ...s, day: Number(e.target.value) }))}>{trip.days.map((d) => <option key={d.day} value={d.day}>Day {d.day}</option>)}</select>
            <input aria-label="Time" type="time" className={`${inputClass} !w-auto`} value={newStop.time} onChange={(e) => setNewStop((s) => ({ ...s, time: e.target.value }))} />
            <input aria-label="Place name" className={`${inputClass} min-w-40 flex-1`} placeholder="Place name (found on the map near that day's destination)" value={newStop.name} onChange={(e) => setNewStop((s) => ({ ...s, name: e.target.value }))} />
            <Button variant="ghost" disabled={newStop.name.trim().length < 2 || !!busy} onClick={() => void run('Adding…', () => api.addStop(newStop.day, { name: newStop.name.trim(), time: newStop.time, kind: 'outdoor', added: 'manual' }), (t) => { keep(t); setNewStop((s) => ({ ...s, name: '' })) })}>Add</Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 border-t border-white/[0.05] pt-3">
            <input aria-label="New destination" className={`${inputClass} min-w-40 flex-1`} placeholder="Add a destination after the last day…" value={newDest.name} onChange={(e) => setNewDest((s) => ({ ...s, name: e.target.value }))} />
            <input aria-label="Days" type="number" min="1" max="7" className={`${inputClass} !w-20`} value={newDest.days} onChange={(e) => setNewDest((s) => ({ ...s, days: Number(e.target.value) }))} />
            <Button variant="ghost" disabled={newDest.name.trim().length < 2 || !!busy} onClick={() => void run('Adding destination…', () => api.addDestination({ name: newDest.name.trim(), days: newDest.days }), (t) => { keep(t); setNewDest({ name: '', days: 1 }) })}><MapPin className="size-4" /> Add destination</Button>
          </div>
        </Card>
      )}

      {owner && (
        <Card>
          <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><Wand2 className="pa-ink size-4" /> Something changed? Re-plan</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {['My flight is delayed 4 hours on day 1', 'It will rain all day on day 2', 'Make day 2 more relaxed, we are tired', 'Swap in more local food on day 1'].map((x) => <button key={x} type="button" className="chip" onClick={() => setEvent(x)}>{x}</button>)}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-400">
            Only change:
            {trip.days.map((d) => (
              <button key={d.day} type="button" onClick={() => setScope((s) => (s.includes(d.day) ? s.filter((x) => x !== d.day) : [...s, d.day]))} className={`chip ${scope.includes(d.day) ? '!bg-white/10 !text-white' : ''}`}>Day {d.day}</button>
            ))}
            <span>{scope.length ? '' : '(any day that needs it)'} · pinned stops are always kept</span>
          </div>
          <div className="mt-2 flex gap-2">
            <input id="replan-input" className={inputClass} value={event} onChange={(e) => setEvent(e.target.value)} placeholder="Describe what changed…" />
            <Button accent={ACCENT} className="shrink-0 whitespace-nowrap" onClick={() => void replan()} busy={busy?.startsWith('Re-plan')} disabled={event.trim().length < 5}>Re-plan</Button>
          </div>
        </Card>
      )}
      {trip.tips?.length > 0 && (
        <Card>
          <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><Lightbulb className="size-4 text-amber-300" /> Tips</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-ink-200">{trip.tips.map((t) => <li key={t}>{t}</li>)}</ul>
        </Card>
      )}
      {trip.history?.length > 0 && (
        <Card>
          <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><History className="size-4 text-ink-300" /> Changes</p>
          <ol className="mt-2 space-y-2">
            {[...trip.history].reverse().map((h) => (
              <li key={h.version + h.at} className="text-[12.5px]"><span className="text-ink-400">v{h.version} → v{h.version + 1} · </span><span className="text-ink-200">{h.event}</span><p className="text-ink-400">{h.explanation}</p></li>
            ))}
          </ol>
        </Card>
      )}
      {trip.days.length === 0 && <Empty icon={Route} title="Empty itinerary" text="Add a destination to start." />}
      {handoff && <Handoff link={handoff.link} place={handoff.place} onClose={() => setHandoff(null)} />}
    </div>
  )
}

function EditStop({ a, trip, day, index, busy, onSave, onMove, onDelete }) {
  const [f, setF] = useState({ time: a.time, duration_min: a.duration_min, note: a.note ?? '' })
  const tags = a.tags ?? []
  const toggleTag = (t) => onSave({ tags: tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t] })
  return (
    <div className="mt-2 ml-14 space-y-2 rounded-xl border border-white/[0.07] bg-ink-950/40 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Time"><input type="time" className={`${inputClass} !w-auto !py-1.5`} value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
        <Field label="Minutes"><input type="number" min="10" max="600" className={`${inputClass} !w-24 !py-1.5`} value={f.duration_min} onChange={(e) => setF({ ...f, duration_min: Number(e.target.value) })} /></Field>
        <div className="min-w-40 flex-1"><Field label="Note"><input className={`${inputClass} !py-1.5`} value={f.note} maxLength={300} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field></div>
        <Button variant="ghost" className="!py-1.5" disabled={busy} onClick={() => onSave({ time: f.time, duration_min: f.duration_min, note: f.note })}>Save</Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={`chip ${a.priority === 'must' ? '!bg-amber-500/15 !text-amber-200' : ''}`} onClick={() => onSave({ priority: a.priority === 'must' ? 'normal' : 'must' })}><Star className="size-3" /> Must visit</button>
        <button type="button" className={`chip ${a.pinned ? '!bg-amber-500/15 !text-amber-200' : ''}`} onClick={() => onSave({ pinned: !a.pinned })} title="Pinned stops are kept when you re-plan"><Pin className="size-3" /> Pin</button>
        {[['local_favourite', 'My local favourite'], ['hidden_gem', 'Hidden gem']].map(([t, label]) => (
          <button key={t} type="button" className={`chip ${tags.includes(t) ? '!bg-emerald-500/15 !text-emerald-200' : ''}`} onClick={() => toggleTag(t)}>{label}</button>
        ))}
        <span className="mx-1 h-5 w-px bg-white/10" />
        <button type="button" className="chip" disabled={index === 0} onClick={() => onMove(day.day, index - 1)}><ChevronUp className="size-3" /> Earlier</button>
        <button type="button" className="chip" disabled={index === day.activities.length - 1} onClick={() => onMove(day.day, index + 2)}><ChevronDown className="size-3" /> Later</button>
        <select aria-label="Move to day" className={`${inputClass} !w-auto !py-1 text-[12px]`} value="" onChange={(e) => e.target.value && onMove(Number(e.target.value), 99)}>
          <option value="">Move to day…</option>
          {trip.days.filter((d) => d.day !== day.day).map((d) => <option key={d.day} value={d.day}>Day {d.day}</option>)}
        </select>
        <button type="button" className="chip !text-rose-300" onClick={onDelete}><Trash2 className="size-3" /> Remove</button>
      </div>
      <p className="text-[11px] text-ink-500">“Local favourite” and “Hidden gem” are your own tags: free map data has no ratings or popularity, so Safarnaama never assigns them itself.</p>
    </div>
  )
}

/** Weather is stored, not live: show when it was fetched, and flag it when it's old. */
