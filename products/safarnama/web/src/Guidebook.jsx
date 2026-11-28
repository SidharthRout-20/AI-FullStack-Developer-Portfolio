/**
 * The trip as a guidebook (personal space): one page that reads like a good local guide talking you through the
 * trip, instead of tabs of tools.
 *
 *   What it'll cost  – the likely total at the stay level you pick, against your budget (live as you change things)
 *   Where you'll stay – Budget / Comfort / Treat with what a room usually costs there, the areas to stay in, real
 *                       places near your plan (OpenStreetMap) and the booking sites with your dates
 *   Your days        – swipeable day cards: weather, each stop with what it usually costs, tick them off as you go
 *   Eat like a local – dishes and the real places they're known at; one tap puts one into a day
 *   Things to do     – adventure, culture, nature and local life with costs, times and tips; "Surprise me"
 *   Getting there and around – fares for the ways to get around, and from where you start
 *   Money, take it with you – the wallet and budget plan, the trip pack, bookings and documents
 *
 * Costs are the guide's typical prices for the season (estimates, marked "≈"), never live prices or availability.
 * The guide is made once per trip by the server (safarnama/guide.py) and kept with it.
 */
import { BedDouble, Check, ChevronLeft, ChevronRight, Compass, Dices, ExternalLink, Lightbulb, LoaderCircle, MapPin, Plus, RefreshCw } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorText } from '@appcore/web/http'
import { ErrorNote, inputClass, Spinner } from '@appcore/web/ui'
import { useDone } from './DayParts'
import { costsById, dayCost, fitsLevel, foodIcon, inPlan, LEVELS, lightestDay, rangeText, STOP_ICON, THING_TYPES, TRAVEL_ICON, weatherIcon } from './guideKit'
import { dateRange } from './logic'
import { shortMoney } from './money'
import { cardColour } from './skin'
import { LiveStays, Shortlist, StayLinks } from './Stays'
import { stays as stayWindows } from './booking'

const TripMap = lazy(() => import('./TripMap').then((m) => ({ default: m.TripMap })))
const ORIGIN_KEY = 'safarnaama-origin'
const SECTIONS = [
  ['stay', 'Stay'], ['days', 'Days'], ['eat', 'Eat'], ['do', 'Do'], ['around', 'Getting around'], ['money', 'Money'], ['pack', 'Take it'],
]  // prettier-ignore
const tilt = (i) => [-1.4, 1, -0.6, 1.3, -1, 0.7][i % 6]
const safe = (fn, fallback = null) => {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** The trip's guide: loaded with the trip, made on the server the first time (one model call), kept after that. */
function useGuide(api, trip, canMake) {
  const [state, setState] = useState({ guide: null, estimate: null, status: 'loading', error: null })
  const make = useCallback(async (origin, refresh = false) => {
    setState((s) => ({ ...s, status: 'making', error: null }))
    try {
      const r = await api.makeGuide({ ...(origin ? { origin } : {}), refresh })
      setState({ guide: r.guide, estimate: r.estimate, live: r.live, status: 'ready', error: null })
    } catch (e) {
      setState((s) => ({ ...s, status: 'error', error: errorText(e) }))
    }
  }, [api])
  useEffect(() => {
    let alive = true
    api.guide()
      .then((r) => alive && setState({ guide: r.guide, estimate: r.estimate, live: r.live, status: 'ready', error: null }))
      .catch((e) => {
        if (!alive) return
        if (e?.status === 404 && canMake) void make(safe(() => localStorage.getItem(ORIGIN_KEY)) || undefined)
        else setState((s) => ({ ...s, status: e?.status === 404 ? 'none' : 'error', error: e?.status === 404 ? null : errorText(e) }))
      })
    return () => {
      alive = false
    }
  }, [api, trip.version, canMake, make])
  return { ...state, make, set: (r) => setState({ guide: r.guide, estimate: r.estimate, live: r.live, status: 'ready', error: null }) }
}

export function Guidebook({ trip, api, owner, member, keep, setNote, slots }) {
  const canMake = owner || member
  const g = useGuide(api, trip, canMake)
  const [pick, setPick] = useState(() => safe(() => localStorage.getItem(`safarnaama-level-${trip.id}`)))
  const levels = g.estimate?.levels ?? {}
  const tier = pick && levels[pick] ? pick : g.estimate?.chosen
  const choose = (t) => {
    setPick(t)
    safe(() => localStorage.setItem(`safarnaama-level-${trip.id}`, t))
  }
  const cur = g.guide?.currency ?? trip.budget?.currency ?? 'INR'
  const people = Math.max(1, Number(trip.party?.travellers) || 1)
  const [busy, setBusy] = useState(null)
  const add = async (kind, destination, index, day, label) => {
    setBusy(`${kind}-${destination}-${index}`)
    try {
      const r = await api.addFromGuide({ kind, destination, index, day })
      keep(r.trip)
      g.set(r)
      setNote(`${label} is on day ${day}; times and travel updated.`)
    } catch (e) {
      setNote(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  const making = g.status === 'making' || (g.status === 'loading' && canMake)
  return (
    <div className="space-y-12">
      <CostMeter est={tier ? levels[tier] : null} tier={tier} cur={cur} trip={trip} making={making} error={g.status === 'error' ? g.error : null} onRetry={() => void g.make(undefined, true)} />
      <JumpNav />
      <Section id="stay" kicker="Where you'll stay" title="Pick your kind of stay">
        <StayPicker trip={trip} api={api} guide={g.guide} levels={levels} tier={tier} onPick={choose} cur={cur} people={people} setNote={setNote} making={making} live={g.live} />
      </Section>
      <Section id="days" kicker="Your days" title="Swipe through the trip">
        <DayCarousel trip={trip} guide={g.guide} cur={cur} people={people} />
        {owner && slots.editor && <Fold label="Change the plan: add, move or re-plan stops">{slots.editor}</Fold>}
      </Section>
      <Section id="eat" kicker="Eat like a local" title="The food haul">
        {g.guide ? <FoodHaul trip={trip} guide={g.guide} cur={cur} owner={owner} busy={busy} onAdd={add} /> : <Placeholder making={making} />}
      </Section>
      <Section id="do" kicker="Things to do" title="Adventure, culture and local life">
        {g.guide ? <Things trip={trip} guide={g.guide} cur={cur} owner={owner} busy={busy} onAdd={add} /> : <Placeholder making={making} />}
        {slots.explore && <Fold label="Browse everything nearby on the map (OpenStreetMap)">{slots.explore}</Fold>}
      </Section>
      <Section id="around" kicker="Getting there and around" title="Fares and good to know">
        {g.guide ? <Around guide={g.guide} cur={cur} canMake={canMake} onOrigin={(o) => { safe(() => localStorage.setItem(ORIGIN_KEY, o)); void g.make(o, true) }} making={g.status === 'making'} /> : <Placeholder making={making} />}
      </Section>
      <Section id="money" kicker="Money" title="What's left to spend">{slots.money}</Section>
      <Section id="pack" kicker="Take it with you" title="Your trip pack">
        {slots.pack}
        {slots.bookings && <Fold label="Bookings and documents">{slots.bookings}</Fold>}
      </Section>
      {g.guide && <p className="text-center text-[11.5px] text-ink-500">Costs marked ≈ are typical prices for the season from Safarnaama's guide, not live prices or availability. Places are checked on OpenStreetMap.</p>}
    </div>
  )
}

/** Renders an icon component handed over as data (Lucide icons from guideKit). */
function Icon({ of: Of, ...props }) {
  return Of ? <Of aria-hidden {...props} /> : null
}

function Section({ id, kicker, title, children }) {
  return (
    <section id={`g-${id}`} className="scroll-mt-28 space-y-4">
      <div>
        <p className="pc-head text-[13px] tracking-[0.1em] text-ink-400">{kicker}</p>
        <h2 className="pc-head text-[30px] leading-none text-white sm:text-[40px]">{title}</h2>
      </div>
      {children}
    </section>
  )
}

function Fold({ label, children }) {
  return (
    <details className="group rounded-2xl border border-white/[0.07] px-4 py-3">
      <summary className="cursor-pointer list-none text-[13.5px] font-semibold text-white"><span className="mr-1 inline-block transition group-open:rotate-90">›</span> {label}</summary>
      <div className="mt-3">{children}</div>
    </details>
  )
}

function Placeholder({ making }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {[0, 1, 2].map((i) => <div key={i} className="h-36 animate-pulse rounded-[26px] bg-white/[0.05]" />)}
      <p className="text-[12.5px] text-ink-400 sm:col-span-3">{making ? 'Your guide is being written: stays, food, things to do and what they cost…' : 'No guide for this trip yet.'}</p>
    </div>
  )
}

/** Sticky chapter pills: jump anywhere in the guide. */
function JumpNav() {
  return (
    <nav aria-label="Guide sections" className="sticky top-16 z-20 -mx-4 overflow-x-auto px-4 [scrollbar-width:none]">
      <div className="ui-tabs-list inline-flex gap-0.5 rounded-xl border border-white/[0.06] bg-ink-900/60 p-1">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#g-${id}`} className="ui-tab rounded-lg px-3 py-1.5 text-[12.5px] font-medium whitespace-nowrap text-ink-300 hover:text-white">{label}</a>
        ))}
      </div>
    </nav>
  )
}

/** The likely cost of the trip, against the budget. */
function CostMeter({ est, tier, cur, trip, making, error, onRetry }) {
  const budget = trip.budget?.total
  if (error)
    return (
      <div className="space-y-2"><ErrorNote message={error} /><button type="button" className="chip" onClick={onRetry}><RefreshCw className="size-3.5" /> Try again</button></div>
    )
  if (!est)
    return (
      <section className="pc-card flex items-center gap-3 p-5" style={cardColour(2)}>
        <LoaderCircle className={`size-5 ${making ? 'animate-spin' : ''}`} />
        <p className="text-[15px] font-semibold">{making ? 'Working out what this trip will cost: stays, food, getting around and things to do…' : 'Costs appear once the guide is ready.'}</p>
      </section>
    )
  const [lo, hi] = est.total
  const top = Math.max(hi, budget ?? 0) * 1.12 || 1
  const status = { fits: ['Fits your budget', '✓'], tight: ['Tight: could go over', '!'], over: [`Over by ≈ ${shortMoney(lo - budget, cur)}`, '!'] }[est.status]
  const parts = [['Stay', est.parts.stay], ['Food', est.parts.food], ['Getting around', est.parts.local], ['Things to do', est.parts.things], ['Getting there', est.parts.getting_there]]
  return (
    <section className="pc-card p-5 sm:p-7" style={{ ...cardColour(2), transform: 'rotate(0.4deg)' }}>
      <p className="pc-head text-[13px] tracking-[0.1em]">What it'll likely cost</p>
      <p className="pc-head mt-1 text-[40px] leading-none sm:text-[56px]">{rangeText({ min: lo, max: hi }, cur).replace('≈ ', '≈')}</p>
      <p className="mt-1 text-[14px] font-medium">for {est.people} {est.people === 1 ? 'person' : 'people'}, {trip.days.length} days, {LEVELS.find((l) => l.id === tier)?.label.toLowerCase()} stays{est.rooms > 1 ? ` (${est.rooms} rooms)` : ''}{est.included_getting_there ? ', getting there included' : ''}</p>
      <div className="relative mt-5 h-4 rounded-full bg-black/10" role="img" aria-label={`Likely ${shortMoney(lo, cur)} to ${shortMoney(hi, cur)}${budget ? ` against a budget of ${shortMoney(budget, cur)}` : ''}`}>
        <motion.span className="absolute inset-y-0 rounded-full bg-[#1f1f1f]/80" initial={false} animate={{ left: `${(lo / top) * 100}%`, width: `${Math.max(2, ((hi - lo) / top) * 100)}%` }} transition={{ type: 'spring', stiffness: 160, damping: 22 }} />
        {budget != null && <span className="absolute -top-1.5 -bottom-1.5 w-[3px] rounded bg-[#1f1f1f]" style={{ left: `${(budget / top) * 100}%` }} title="Your budget" />}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12.5px] font-semibold">
        <span>{budget != null ? `Your budget: ${shortMoney(budget, cur)}` : 'No budget set'}</span>
        {status && <span className="pc-chip">{status[1]} {status[0]}</span>}
      </div>
      <ul className="mt-4 flex flex-wrap gap-1.5">
        {parts.filter(([, r]) => r[1] > 0).map(([label, r]) => <li key={label} className="pc-chip">{label} {rangeText(r, cur)}</li>)}
        {!est.included_getting_there && <li><a href="#g-around" className="pc-chip underline underline-offset-2">+ Add getting there</a></li>}
      </ul>
    </section>
  )
}

/** Budget / Comfort / Treat, with the room price there and the trip total at that level; then real places. */
function StayPicker({ trip, api, guide, levels, tier, onPick, cur, people, setNote, making, live }) {
  const dests = trip.destinations?.length ? trip.destinations : [trip.city]
  const [at, setAt] = useState(0)
  const d = dests[Math.min(at, dests.length - 1)]
  const dg = guide?.destinations?.find((x) => x.destination.toLowerCase() === d.name.toLowerCase()) ?? guide?.destinations?.[at]
  const tiers = Object.fromEntries((dg?.stay ?? []).flatMap((a) => a.tiers.map((t) => [t.tier, t])))
  const w = stayWindows(trip).find((x) => x.name === d.name) ?? {}
  if (!guide) return <Placeholder making={making} />
  return (
    <div className="space-y-5">
      {dests.length > 1 && <div className="flex flex-wrap gap-1.5">{dests.map((x, i) => <button key={x.name} type="button" onClick={() => setAt(i)} className={`chip ${i === at ? 'pa-on' : ''}`}>{x.name}</button>)}</div>}
      <div className="grid gap-4 sm:grid-cols-3" role="radiogroup" aria-label="Kind of stay">
        {LEVELS.filter((l) => levels[l.id]).map((l, i) => {
          const on = l.id === tier
          const t = tiers[l.id]
          const e = levels[l.id]
          return (
            <button key={l.id} type="button" role="radio" aria-checked={on} onClick={() => onPick(l.id)}
              className={`pc-card p-4 text-left ${on ? 'ring-[3px] ring-[var(--pl-ink)]' : 'opacity-90'}`} style={{ ...cardColour(i), transform: `rotate(${tilt(i)}deg)` }}>
              <p className="flex items-center justify-between text-[12px] font-semibold opacity-80">{l.hint} {on && <Check className="size-4" />}</p>
              <p className="pc-head mt-1 text-[26px] leading-none">{l.label}</p>
              {t && <p className="mt-2 text-[14px] font-semibold">{rangeText(t.per_night, cur, ' a night')}</p>}
              {t?.kind && <p className="text-[12px] font-medium opacity-80">{t.kind}</p>}
              <p className="mt-2 text-[12px] font-semibold">Whole trip {rangeText({ min: e.total[0], max: e.total[1] }, cur)}{e.status === 'fits' ? ' · fits ✓' : e.status === 'over' ? ' · over budget' : ''}</p>
            </button>
          )
        })}
      </div>
      {dg?.stay?.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {dg.stay.map((a) => (
            <li key={a.area} className="rounded-2xl border border-white/[0.07] p-4">
              <p className="flex items-center gap-2 text-[15px] font-semibold text-white"><MapPin className="size-4" /> Stay around {a.area}</p>
              <p className="mt-1 text-[13px] text-ink-300">{a.why}</p>
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-2xl border border-white/[0.07] p-4">
        <p className="flex items-center gap-2 text-[14px] font-semibold text-white"><BedDouble className="size-4" /> Book with your dates{w.nights ? ` (${w.nights} night${w.nights === 1 ? '' : 's'}, ${dateRange(w.checkin, w.checkout)})` : ''}</p>
        <div className="mt-1"><StayLinks place={{ ...w, name: d.name, country: d.country }} adults={people} /></div>
      </div>
      {live?.enabled && w.nights > 0 && (
        <LiveStays key={`${d.name}`} api={api} destIndex={Math.min(at, dests.length - 1)} tier={tier} tiers={tiers} live={live}
          dates={`${w.nights} night${w.nights === 1 ? '' : 's'}, ${dateRange(w.checkin, w.checkout)}`} />
      )}
      <Shortlist key={`${d.name}-${tier}`} trip={trip} api={api} dest={d} window={w} setNote={setNote} filter={(p) => fitsLevel(p, tier)} limit={6} />
    </div>
  )
}

/** The days as swipeable postcards. */
function DayCarousel({ trip, guide, cur, people }) {
  const reduce = useReducedMotion()
  const track = useRef(null)
  const [at, setAt] = useState(0)
  const [open, setOpen] = useState(null)
  const [done, toggleDone] = useDone(trip.id)
  const [map, setMap] = useState(false)
  const costs = useMemo(() => costsById(guide), [guide])
  const go = (i) => {
    const n = Math.max(0, Math.min(trip.days.length - 1, i))
    setAt(n)
    track.current?.children[n]?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', inline: 'center', block: 'nearest' })
  }
  const onScroll = () => {
    const el = track.current
    if (!el) return
    const w = el.children[0]?.getBoundingClientRect().width ?? 1
    setAt(Math.round(el.scrollLeft / (w + 16)))
  }
  const c = trip.destinations?.[0] ?? trip.city
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" aria-label="Previous day" onClick={() => go(at - 1)} disabled={at === 0} className="pc-round grid size-9 place-items-center rounded-full disabled:opacity-40"><ChevronLeft className="size-4" /></button>
        <button type="button" aria-label="Next day" onClick={() => go(at + 1)} disabled={at >= trip.days.length - 1} className="pc-round grid size-9 place-items-center rounded-full disabled:opacity-40"><ChevronRight className="size-4" /></button>
        <p className="text-[12.5px] text-ink-400">Day {Math.min(at + 1, trip.days.length)} of {trip.days.length} · swipe, or tap a stop for more</p>
        <button type="button" className="chip ml-auto" aria-pressed={map} onClick={() => setMap((m) => !m)}><MapPin className="size-3.5" /> {map ? 'Hide map' : 'Show on map'}</button>
      </div>
      <div ref={track} onScroll={onScroll} className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pt-2 pb-6 [scrollbar-width:none]">
        {trip.days.map((d, i) => {
          const cost = dayCost(d, costs, people)
          const left = d.activities.filter((a) => !done.has(a.id)).length
          return (
            <article key={d.day} className="pc-card w-[min(86vw,400px)] shrink-0 snap-center p-4 sm:p-5" style={{ ...cardColour(i), transform: `rotate(${tilt(i) * 0.6}deg)` }}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="pc-head text-[13px] tracking-[0.1em]">Day {d.day}{d.date ? ` · ${dateRange(d.date)}` : ''}</p>
                  <h3 className="pc-head mt-0.5 text-[24px] leading-[1.02]">{d.theme || 'Your day'}</h3>
                </div>
                {d.weather?.tmax != null && <span className="pc-chip shrink-0 text-[14px]"><Icon of={weatherIcon(d.weather)} className="size-4" /> {Math.round(d.weather.tmax)}°</span>}
              </div>
              <p className="mt-1 text-[12px] font-semibold opacity-80">{d.activities.length} stops{cost.max > 0 ? ` · tickets ${rangeText(cost, cur)} for ${people}` : ''}{left === 0 && d.activities.length ? ' · all done' : ''}</p>
              <ol className="mt-3 space-y-1.5">
                {d.activities.map((a) => {
                  const isOpen = open === a.id
                  const isDone = done.has(a.id)
                  const c = costs[a.id]
                  return (
                    <li key={a.id} className="rounded-2xl bg-black/[0.07]">
                      <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : a.id)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
                        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-black/10"><Icon of={STOP_ICON[a.kind] ?? MapPin} className="size-4" /></span>
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate text-[14px] font-semibold ${isDone ? 'line-through opacity-60' : ''}`}>{a.name}</span>
                          <span className="block text-[11.5px] font-medium opacity-75">{a.time}{a.duration_min ? ` · ${a.duration_min} min` : ''}</span>
                        </span>
                        {c && <span className="shrink-0 text-[11.5px] font-semibold">{rangeText(c.cost, cur)}</span>}
                      </button>
                      {isOpen && (
                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="overflow-hidden px-3 pb-3">
                          {a.note && <p className="text-[12.5px] leading-snug font-medium opacity-90">{a.note}</p>}
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <button type="button" onClick={() => toggleDone(a.id)} aria-pressed={isDone} className="pc-pill inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-semibold"><Check className="size-3.5" /> {isDone ? 'Done' : 'Mark done'}</button>
                            {a.lat != null && <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${a.lat},${a.lng}`)}`} target="_blank" rel="noopener noreferrer" className="pc-pill inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-semibold"><ExternalLink className="size-3.5" /> Directions</a>}
                          </div>
                        </motion.div>
                      )}
                    </li>
                  )
                })}
                {d.activities.length === 0 && <li className="text-[13px] font-medium opacity-80">A free day: pick something from the food haul or things to do below.</li>}
              </ol>
            </article>
          )
        })}
      </div>
      {map && c && (
        <div className="h-[340px] overflow-hidden rounded-[26px] border border-white/[0.07]">
          <Suspense fallback={<div className="grid size-full place-items-center"><Spinner label="Loading the map…" /></div>}>
            <TripMap center={[c.lat, c.lng]} days={trip.days.map((d) => ({ day: d.day, activities: d.activities }))} activeDay={trip.days[at]?.day ?? null} focus={null} onSelect={() => {}} extra={[]} />
          </Suspense>
        </div>
      )}
    </div>
  )
}

function AddButton({ trip, owner, item, placed, busy, onAdd }) {
  const [day, setDay] = useState(() => lightestDay(trip))
  if (inPlan(trip, placed, item)) return <span className="pc-chip"><Check className="size-3.5" /> In your plan</span>
  if (!owner || item.lat == null) return null
  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" disabled={busy} onClick={() => onAdd(day)} className="pc-pill inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-semibold disabled:opacity-60">
        {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Add to day
      </button>
      <select aria-label="Which day" value={day} onChange={(e) => setDay(Number(e.target.value))} className="rounded-full bg-black/10 px-2 py-1.5 text-[12px] font-semibold">
        {trip.days.map((d) => <option key={d.day} value={d.day}>{d.day}</option>)}
      </select>
    </span>
  )
}

function FoodHaul({ trip, guide, cur, owner, busy, onAdd }) {
  return guide.destinations.map((dg, di) => (
    <div key={dg.destination} className="space-y-3">
      {guide.destinations.length > 1 && <p className="pc-head text-[18px] text-white">{dg.destination}</p>}
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {dg.food.map((f, i) => (
          <li key={f.dish} className="pc-card flex flex-col p-4" style={{ ...cardColour(i + 1), transform: `rotate(${tilt(i)}deg)` }}>
            <div className="flex items-start justify-between gap-2">
              <span className="grid size-11 place-items-center rounded-2xl bg-black/10"><Icon of={foodIcon(i)} className="size-5" /></span>
              <span className="pc-chip">{f.popular ? 'Popular' : 'Local pick'}</span>
            </div>
            <p className="pc-head mt-2 text-[22px] leading-none">{f.dish}</p>
            <p className="mt-1 text-[13px] leading-snug font-medium opacity-90">{f.what}</p>
            <p className="mt-2 flex items-center gap-1 text-[12.5px] font-semibold">{f.where ? <><MapPin className="size-3.5 shrink-0" /> {f.where}</> : 'Ask locally where it’s best'}</p>
            <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3">
              <span className="text-[13px] font-semibold">{rangeText(f.per_person, cur, ' a person')}</span>
              {f.where && <AddButton trip={trip} owner={owner} item={f} placed={f.where} busy={busy === `food-${di}-${i}`} onAdd={(day) => onAdd('food', di, i, day, f.where)} />}
            </div>
          </li>
        ))}
      </ul>
    </div>
  ))
}

function Things({ trip, guide, cur, owner, busy, onAdd }) {
  const [type, setType] = useState('all')
  const [spot, setSpot] = useState(null)
  const [roll, setRoll] = useState(0)
  const all = guide.destinations.flatMap((dg, di) => dg.things.map((t, i) => ({ ...t, di, i, dest: dg.destination })))
  // New ideas first; what's already planned follows (marked "In your plan").
  const shown = all.filter((t) => type === 'all' || t.type === type).sort((a, b) => inPlan(trip, a.name, a) - inPlan(trip, b.name, b))
  // "Surprise me" walks through what isn't planned yet in a scattered order (7 steps at a time), never repeating soon.
  const surprise = () => {
    const pool = all.filter((t) => !inPlan(trip, t.name, t))
    const t = pool[(roll * 7 + 3) % Math.max(1, pool.length)]
    setRoll((r) => r + 1)
    if (!t) return
    setType('all')
    setSpot(`${t.di}-${t.i}`)
    window.setTimeout(() => document.getElementById(`thing-${t.di}-${t.i}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setType('all')} className={`chip ${type === 'all' ? 'pa-on' : ''}`}>All</button>
        {THING_TYPES.filter((x) => all.some((t) => t.type === x.id)).map((x) => <button key={x.id} type="button" onClick={() => setType(x.id)} className={`chip ${type === x.id ? 'pa-on' : ''}`}><Icon of={x.icon} className="size-3.5" /> {x.label}</button>)}
        <button type="button" onClick={surprise} className="pc-pill ml-auto inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[12.5px] font-semibold"><Dices className="size-4" /> Surprise me</button>
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((t, n) => {
          const kind = THING_TYPES.find((x) => x.id === t.type)
          return (
            <motion.li id={`thing-${t.di}-${t.i}`} key={`${t.di}-${t.i}`} animate={spot === `${t.di}-${t.i}` ? { scale: [1, 1.05, 1] } : {}} transition={{ duration: 0.6 }}
              className={`pc-card flex flex-col p-4 ${spot === `${t.di}-${t.i}` ? 'ring-[3px] ring-[var(--pl-ink)]' : ''}`} style={{ ...cardColour(n + 2), transform: `rotate(${tilt(n + 1)}deg)` }}>
              <div className="flex items-start justify-between gap-2">
                <span className="grid size-11 place-items-center rounded-2xl bg-black/10"><Icon of={kind?.icon ?? Compass} className="size-5" /></span>
                <span className="pc-chip">{kind?.label ?? 'Local life'}</span>
              </div>
              <p className="pc-head mt-2 text-[21px] leading-[1.02]">{t.name}</p>
              <p className="mt-1 text-[13px] leading-snug font-medium opacity-90">{t.what}</p>
              <p className="mt-2 text-[12px] font-semibold opacity-85">{t.where ? `${t.where} · ` : ''}{t.minutes >= 60 ? `${Math.round(t.minutes / 60 * 10) / 10} h` : `${t.minutes} min`}{t.best_time ? ` · ${t.best_time}` : ''}</p>
              {t.tip && <p className="mt-1 flex gap-1 text-[12px] font-medium opacity-80"><Lightbulb className="mt-0.5 size-3.5 shrink-0" /> {t.tip}</p>}
              <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3">
                <span className="text-[13px] font-semibold">{t.per === 'free' ? 'Free' : rangeText(t.cost, cur, t.per === 'group' ? ' for the group' : ' a person')}</span>
                <AddButton trip={trip} owner={owner} item={t} placed={t.name} busy={busy === `thing-${t.di}-${t.i}`} onAdd={(day) => onAdd('thing', t.di, t.i, day, t.name)} />
              </div>
            </motion.li>
          )
        })}
      </ul>
    </div>
  )
}

function Around({ guide, cur, canMake, onOrigin, making }) {
  const [from, setFrom] = useState(guide.origin ?? '')
  const per = { person: ' a person', trip: ' a ride', day: ' a day' }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border border-white/[0.07] p-4">
        <p className="pc-head text-[18px] text-white">Getting there</p>
        {guide.getting_there?.length ? (
          <ul className="mt-2 space-y-2">
            {guide.getting_there.map((w) => (
              <li key={w.mode} className="flex items-start gap-3 text-[13.5px]">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/[0.06] text-white"><Icon of={TRAVEL_ICON[w.mode] ?? Compass} className="size-4" /></span>
                <span className="min-w-0 flex-1"><span className="font-semibold text-white capitalize">{w.mode}</span>{w.hours ? <span className="text-ink-400"> · about {w.hours} h</span> : null}<span className="block text-[12.5px] text-ink-400">{w.what}</span></span>
                <span className="shrink-0 font-semibold text-white">{rangeText(w.fare, cur, ' a person')}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-[13px] text-ink-400">Tell the guide where you start, and it adds the ways to get there with fares.</p>
        )}
        {canMake && (
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (from.trim().length > 1) onOrigin(from.trim()) }}>
            <input aria-label="Starting from" className={inputClass} placeholder="Starting from (e.g. Bengaluru)" value={from} onChange={(e) => setFrom(e.target.value.slice(0, 80))} />
            <button type="submit" disabled={making || from.trim().length < 2} className="pc-pill shrink-0 rounded-full px-4 text-[12.5px] font-semibold disabled:opacity-50">{making ? 'Updating…' : guide.origin ? 'Update' : 'Add'}</button>
          </form>
        )}
      </div>
      <div className="space-y-4">
        {guide.destinations.map((dg) => (
          <div key={dg.destination} className="rounded-2xl border border-white/[0.07] p-4">
            <p className="pc-head text-[18px] text-white">Around {dg.destination}</p>
            <ul className="mt-2 space-y-1.5">
              {dg.around.map((r) => <li key={r.mode} className="flex items-baseline gap-2 text-[13.5px]"><span className="min-w-0 flex-1"><span className="font-semibold text-white">{r.mode}</span> <span className="text-[12.5px] text-ink-400">{r.what}</span></span><span className="shrink-0 font-semibold text-white">{rangeText(r.fare, cur, per[r.per] ?? '')}</span></li>)}
            </ul>
            {dg.tips?.length > 0 && <ul className="mt-3 space-y-1.5 border-t border-white/[0.07] pt-3 text-[13px] text-ink-300">{dg.tips.map((t) => <li key={t} className="flex gap-2"><Lightbulb className="mt-0.5 size-3.5 shrink-0 text-ink-400" /> {t}</li>)}</ul>}
          </div>
        ))}
      </div>
    </div>
  )
}
