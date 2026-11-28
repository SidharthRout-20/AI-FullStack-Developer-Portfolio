/**
 * The quick planner: a whole trip in four taps, no typing needed.
 *   1 Where  – six real destinations in season (or "show me others", "surprise me", "somewhere else")
 *   2 When   – this weekend / next week / in two weeks / next month, as real dates (or pick a date)
 *   3 Who    – just me / the two of us / family / friends
 *   4 Plan   – interests come pre-selected from the destination; special requests are optional chips
 *              (in the personal space this step leads with the budget, which shapes the whole plan)
 * The choices become a precise request for the AI planner, which streams its progress and opens the new trip.
 */
import { ArrowLeft, Baby, CalendarDays, Check, Dices, Heart, MapPin, Plus, RefreshCw, Search, Sparkles, User, Users, Wand2 } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useMemo, useState } from 'react'
import { navigate } from '@appcore/web/router'
import { errorText } from '@appcore/web/http'
import { Button, ErrorNote, inputClass, Steps } from '@appcore/web/ui'
import { tripApi, trips as tripsApi } from './api'
import { appPath } from './base'
import { PhotoCredit, photoFor } from './Visuals'
import { homeCurrency, shortMoney, symbolOf } from './money'
import { cardColour, usePersonal } from './skin'
import { composePrompt, customDestination, DESTINATIONS, FILTERS, filterPool, INTERESTS, isoDate, PARTIES, rangeText, REQUESTS, searchDestinations, suggestDestinations, whenOptions } from './choices'

export const ACCENT = 'from-amber-400 via-orange-500 to-rose-500'
const NEXT_STEP = { understand: 'geocode', geocode: 'weather', weather: 'plan', plan: 'map', map: 'meals', meals: 'wellbeing' }
const STEP_LABELS = ['Where', 'When', 'Who', 'Plan']
// Spending levels to pick from, a person a day in rupees (the traveller chooses; these aren't prices).
const LEVELS = [
  { id: 'easy', label: 'Easy on the wallet', perDay: 1500 },
  { id: 'comfy', label: 'Comfortable', perDay: 3500 },
  { id: 'treat', label: 'Treat yourselves', perDay: 8000 },
]
const roundTo = (n, step) => Math.max(step, Math.round(n / step) * step)

/** Runs the AI planner and streams its steps; opens the trip when it's ready. Shared with the free-text planner. */
export function usePlanStream() {
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const run = async (prompt, choices = {}) => {
    setBusy(true)
    setError(null)
    setSteps([{ name: 'understand', detail: 'reading your request…', done: false }])
    try {
      await tripsApi.plan(prompt, choices, (ev) => {
        if (ev.event === 'step') {
          setSteps((s) => {
            const rest = s.filter((x) => x.name !== ev.step).map((x) => ({ ...x, done: true }))
            const next = NEXT_STEP[String(ev.step)]
            return [...rest, { name: String(ev.step), detail: String(ev.detail), done: true }, ...(next ? [{ name: next, detail: '…', done: false }] : [])]
          })
        } else if (ev.event === 'done') {
          // A server that doesn't take a budget while planning yet still keeps it: set it on the new trip.
          const t = ev.trip
          const keepBudget = choices.budget && t.budget?.total == null ? tripApi(t.id).update({ budget: choices.budget, currency: choices.currency }).catch(() => null) : null
          void Promise.resolve(keepBudget).then(() => navigate(appPath(`/${t.id}`)))
        }
        else if (ev.event === 'error') setError(String(ev.message))
      })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const reset = () => {
    setSteps([])
    setError(null)
  }
  return { steps, busy, error, run, reset }
}

export function QuickPlan() {
  const today = useMemo(() => new Date(), [])
  const reduce = useReducedMotion()
  // "Plan this" (from a trip's ideas) opens the planner with the place already chosen: …/?to=Udaipur
  const [preset] = useState(() => {
    const to = new URLSearchParams(window.location.search).get('to')
    return to ? (DESTINATIONS.find((d) => d.name.toLowerCase() === to.trim().toLowerCase()) ?? customDestination(to)) : null
  })
  const [step, setStep] = useState(preset ? 1 : 0)
  const [dir, setDir] = useState(1)
  const [seed, setSeed] = useState(() => today.getDate())
  const [dest, setDest] = useState(preset)
  const [when, setWhen] = useState(null)
  const [party, setParty] = useState(null)
  const [interests, setInterests] = useState(() => preset?.tags.slice(0, 2) ?? [])
  const [requests, setRequests] = useState([])
  const [note, setNote] = useState('')
  const [budget, setBudget] = useState('')
  const [origin, setOrigin] = useState(() => {
    try {
      return localStorage.getItem('safarnaama-origin') ?? ''
    } catch {
      return ''
    }
  })
  const personal = usePersonal()
  const currency = useMemo(() => homeCurrency() ?? 'INR', [])
  const plan = usePlanStream()

  const go = (n) => {
    setDir(n > step ? 1 : -1)
    setStep(n)
  }
  const chooseDest = (d) => {
    setDest(d)
    setInterests(d.tags.slice(0, 2)) // smart default: the place's two strongest themes
    setWhen(null)
    go(1)
  }
  const submit = () => {
    try {
      if (origin.trim()) localStorage.setItem('safarnaama-origin', origin.trim()) // the guide reads it for "getting there"
    } catch {
      /* not remembered */
    }
    void plan.run(composePrompt({ dest, when, party, interests, requests, note }), {
      party,
      travellers: PARTIES.find((p) => p.id === party)?.travellers,
      ...(personal && Number(budget) > 0 ? { budget: Number(budget), currency } : {}),
    })
  }
  const toggle = (list, set, id) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

  const slide = reduce
    ? {}
    : { initial: { opacity: 0, x: dir * 40 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: dir * -40 }, transition: { duration: 0.32, ease: [0.25, 0.1, 0.25, 1] } }

  if (plan.busy || plan.steps.length > 0) {
    return (
      <section className="ui-card rounded-3xl border border-white/[0.07] bg-ink-900/60 p-5 sm:p-7">
        <p className="text-[13px] text-ink-400">Planning</p>
        <h2 className="pc-head mt-0.5 text-2xl font-semibold tracking-tight text-white">
          {when?.days} days in {dest?.name}
        </h2>
        <p className="mt-1 text-[13px] text-ink-400">{when?.range} · {PARTIES.find((p) => p.id === party)?.label}</p>
        <div className="mt-5"><Steps steps={plan.steps} active={plan.busy} /></div>
        <div className="mt-3"><ErrorNote message={plan.error} /></div>
        {!plan.busy && plan.error && (
          <div className="mt-3 flex gap-2">
            <Button accent={ACCENT} onClick={submit}><RefreshCw className="size-4" /> Try again</Button>
            <Button variant="secondary" onClick={plan.reset}>Change my choices</Button>
          </div>
        )}
      </section>
    )
  }

  return (
    <section className="ui-card overflow-hidden rounded-3xl border border-white/[0.07] bg-ink-900/60 p-5 sm:p-7">
      {/* progress + the choices so far (tap one to change it) */}
      <div className="flex items-center gap-3">
        {step > 0 && (
          <button type="button" onClick={() => go(step - 1)} aria-label="Back" className="grid size-8 shrink-0 place-items-center rounded-full bg-white/[0.05] text-ink-300 transition hover:text-white">
            <ArrowLeft className="size-4" />
          </button>
        )}
        <ol className="flex flex-1 items-center gap-1.5" aria-label={`Step ${step + 1} of ${STEP_LABELS.length}`}>
          {STEP_LABELS.map((l, i) => (
            <li key={l} className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.07]">
              <motion.span className="block h-full rounded-full pa-gradient" initial={false} animate={{ width: i <= step ? '100%' : '0%' }} transition={{ duration: 0.4 }} />
            </li>
          ))}
        </ol>
        <span className="text-[12px] text-ink-500 tabular-nums">{step + 1}/{STEP_LABELS.length}</span>
      </div>
      {step > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {dest && <Choice icon={MapPin} onClick={() => go(0)}>{dest.name}</Choice>}
          {when && step > 1 && <Choice icon={CalendarDays} onClick={() => go(1)}>{when.range}</Choice>}
          {party && step > 2 && <Choice icon={Users} onClick={() => go(2)}>{PARTIES.find((p) => p.id === party)?.label}</Choice>}
        </div>
      )}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={step} {...slide} className="mt-5">
          {step === 0 && <Where today={today} seed={seed} onSeed={() => setSeed((s) => s + 1)} onPick={chooseDest} personal={personal} />}
          {step === 1 && dest && (
            <When today={today} dest={dest} onPick={(w) => (setWhen(w), go(2))} />
          )}
          {step === 2 && (
            <Who onPick={(p) => (setParty(p), go(3))} selected={party} />
          )}
          {step === 3 && dest && when && party && (
            <div>
              {personal && (
                <BudgetStep budget={budget} setBudget={setBudget} currency={currency} days={when.days} people={PARTIES.find((p) => p.id === party)?.travellers ?? 2} origin={origin} setOrigin={setOrigin} />
              )}
              <h2 className={`pc-head font-semibold tracking-tight text-white ${personal ? 'mt-7 text-[18px]' : 'text-2xl'}`}>Anything special?</h2>
              <p className="mt-1 text-[13.5px] text-ink-400">Optional. We've picked a few from {dest.name}'s strengths; tap to change.</p>
              <ChipGroup label="What it's about">
                {[...new Set([...dest.tags, 'food', 'nature', 'culture'])].slice(0, 6).map((id) => (
                  <Toggle key={id} on={interests.includes(id)} onClick={() => toggle(interests, setInterests, id)}>{INTERESTS[id] ?? id}</Toggle>
                ))}
              </ChipGroup>
              <ChipGroup label="Plan it with">
                {REQUESTS.map((r) => (
                  <Toggle key={r.id} on={requests.includes(r.id)} onClick={() => setRequests((list) => {
                    const without = list.filter((x) => x !== r.id && !(r.pace && REQUESTS.find((y) => y.id === x)?.pace))
                    return list.includes(r.id) ? without : [...without, r.id]
                  })}>{r.label}</Toggle>
                ))}
              </ChipGroup>
              <Note value={note} onChange={setNote} />
              <Button accent={ACCENT} className="mt-6 w-full !rounded-full !py-3 !text-[15px]" onClick={submit}>
                <Wand2 className="size-4" /> Plan my trip
              </Button>
              <p className="mt-2 text-center text-[11.5px] text-ink-500">Takes about a minute. Places, weather and routes come from real map and forecast data.</p>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </section>
  )
}

/**
 * The budget, first thing on the last step (personal space): one number for the whole trip, or a spending level that
 * turns into one. It shapes the plan, the stays, the budget plan and the trip pack.
 */
function BudgetStep({ budget, setBudget, currency, days, people, origin, setOrigin }) {
  const rupees = currency === 'INR'
  return (
    <fieldset>
      <legend className="pc-head text-2xl font-semibold tracking-tight text-white">Your budget</legend>
      <p className="mt-1 text-[13.5px] text-ink-400">For the whole trip: {people} {people === 1 ? 'person' : 'people'}, {days} days, getting there included. Safarnaama plans to it and shows what's left as you go.</p>
      <label className="relative mt-3 block max-w-sm">
        <span className="pc-head pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-[26px] text-ink-400">{symbolOf(currency)}</span>
        <input type="number" min="0" inputMode="numeric" aria-label={`Budget in ${currency}`} placeholder={rupees ? '40000' : '1500'} value={budget} onChange={(e) => setBudget(e.target.value)}
          className={`${inputClass} pc-head !py-3 !pl-11 !text-[28px] tabular-nums`} />
      </label>
      {rupees && (
        <div className="mt-3 flex flex-wrap gap-2.5" role="group" aria-label="Or pick a level">
          {LEVELS.map((l, i) => {
            const total = roundTo(l.perDay * days * people, 1000)
            const on = Number(budget) === total
            return (
              <button key={l.id} type="button" aria-pressed={on} onClick={() => setBudget(String(total))}
                className={`pc-card px-3.5 py-2.5 text-left ${on ? 'ring-2 ring-[var(--pl-ink)]' : ''}`} style={{ ...cardColour(i), transform: `rotate(${[-1.2, 0.8, -0.6][i]}deg)` }}>
                <span className="block text-[12px] font-semibold opacity-85">{l.label}</span>
                <span className="pc-head block text-[20px] leading-tight">{shortMoney(total, 'INR')}</span>
                <span className="block text-[11px] font-medium opacity-80">about {shortMoney(l.perDay, 'INR')} a person a day</span>
              </button>
            )
          })}
        </div>
      )}
      <p className="mt-2 text-[11.5px] text-ink-500">Optional. Leave it empty to plan without a budget; you can add one later.</p>
      <label className="mt-4 block max-w-sm">
        <span className="text-[12px] font-medium text-ink-400">Starting from <span className="text-ink-500">(optional: adds fares to get there)</span></span>
        <input value={origin} onChange={(e) => setOrigin(e.target.value.slice(0, 80))} placeholder="e.g. Bengaluru" aria-label="Starting from" className={`${inputClass} mt-1.5`} />
      </label>
    </fieldset>
  )
}

function Choice({ icon: Icon, children, onClick }) {
  return (
    <button type="button" onClick={onClick} className="chip !gap-1 !py-1 !text-[12px]">
      <Icon className="size-3" /> {children}
    </button>
  )
}

function Where({ today, seed, onSeed, onPick, personal }) {
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const pool = useMemo(() => filterPool(filter), [filter])
  const found = useMemo(() => searchDestinations(query, DESTINATIONS), [query])
  const picks = useMemo(() => (query.trim().length >= 2 ? found.slice(0, 6) : suggestDestinations(today.getMonth() + 1, seed, 6, pool)), [today, seed, pool, query, found])
  const custom = customDestination(text)
  const typed = customDestination(query)
  const surprise = () => onPick(picks[Math.floor(Math.random() * picks.length)])
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="pc-head text-2xl font-semibold tracking-tight text-white">Where to?</h2>
          <p className="mt-1 text-[13.5px] text-ink-400">{DESTINATIONS.length} places, the ones in season first. Tap one, or search.</p>
        </div>
        <div className="flex gap-1.5">
          <button type="button" className="chip" onClick={onSeed}><RefreshCw className="size-3" /> Others</button>
          <button type="button" className="chip" onClick={surprise}><Dices className="size-3" /> Surprise me</button>
        </div>
      </div>
      <label className="relative mt-4 block">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-500" />
        <input aria-label="Search places" value={query} onChange={(e) => setQuery(e.target.value.slice(0, 80))} placeholder="Search a city, state or country (e.g. Kerala, beaches, Japan)" className={`${inputClass} !pl-9`} />
      </label>
      {query.trim().length < 2 && (
        <div className="-mx-1 mt-2.5 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]" role="group" aria-label="Narrow the list">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
              className={`shrink-0 rounded-full border px-3 py-1 text-[12.5px] font-medium transition ${filter === f.id ? 'pa-on' : 'border-white/10 bg-white/[0.03] text-ink-300 hover:text-white'}`}>{f.label}</button>
          ))}
        </div>
      )}
      {query.trim().length >= 2 && picks.length === 0 && (
        <p className="mt-3 text-[13px] text-ink-400">
          Not in the list yet.{' '}
          {typed && <button type="button" className="font-semibold text-white underline-offset-2 hover:underline" onClick={() => onPick(typed)}>Plan “{typed.name}” anyway →</button>}
        </p>
      )}
      {personal ? (
        <ul className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {picks.map((d, i) => (
            <motion.li key={d.name} className="relative" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
              <button type="button" onClick={() => onPick(d)} className="pc-card flex w-full flex-col p-2 text-left" style={{ ...cardColour(i), transform: `rotate(${[-1.5, 1, -0.8, 1.4, -1.1, 0.7][i % 6]}deg)` }}>
                <span className="relative block h-28 overflow-hidden rounded-[18px] sm:h-32">
                  {photoFor(d.name) ? (
                    <img src={photoFor(d.name).src} alt="" loading={i < 3 ? 'eager' : 'lazy'} decoding="async" className="size-full object-cover" />
                  ) : (
                    <span className="pc-head grid size-full place-items-center bg-black/10 text-[34px]">{d.name.charAt(0)}</span>
                  )}
                </span>
                <span className="block px-1.5 pt-2 pb-1">
                  <span className="block text-[11px] font-semibold opacity-75">{d.country}</span>
                  <span className="pc-head block text-[20px] leading-none">{d.name}</span>
                  <span className="mt-1 line-clamp-2 block text-[11.5px] leading-snug font-medium opacity-85">{d.hook}</span>
                </span>
              </button>
              <PhotoCredit photo={photoFor(d.name)} className="top-3 right-3" />
            </motion.li>
          ))}
        </ul>
      ) : (
      <ul className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {picks.map((d, i) => (
          <motion.li key={d.name} className="relative" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
            <button
              type="button"
              onClick={() => onPick(d)}
              className={`group relative flex h-40 w-full flex-col justify-end overflow-hidden rounded-2xl bg-gradient-to-br ${d.tint} p-3.5 text-left text-on-accent shadow-lg shadow-black/20 transition hover:-translate-y-0.5 hover:shadow-xl focus-visible:outline-offset-2 sm:h-48`}
            >
              {photoFor(d.name) && (
                <img src={photoFor(d.name).src} alt="" loading={i < 3 ? 'eager' : 'lazy'} decoding="async" className="absolute inset-0 size-full object-cover transition duration-700 ease-out group-hover:scale-[1.06]" />
              )}
              <span aria-hidden className="absolute inset-0 bg-[linear-gradient(to_top,rgb(0_0_0/0.78),rgb(0_0_0/0.25)_55%,transparent)]" />
              {photoFor(d.name) && <span className="absolute top-2.5 left-2.5 rounded-full bg-black/35 px-2 py-0.5 text-[10.5px] font-medium text-[#fff]/90 backdrop-blur">{photoFor(d.name).landmark}</span>}
              <span className="relative text-[11px] font-medium text-on-accent/80">{d.country}</span>
              <span className="relative text-[19px] leading-tight font-semibold tracking-tight">{d.name}</span>
              <span className="relative mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-on-accent/85">{d.hook}</span>
            </button>
            <PhotoCredit photo={photoFor(d.name)} className="top-2 right-2" />
          </motion.li>
        ))}
      </ul>
      )}
      {typing ? (
        <form className="mt-3 flex gap-2" onSubmit={(e) => (e.preventDefault(), custom && onPick(custom))}>
          <input autoFocus aria-label="Destination" className={inputClass} value={text} onChange={(e) => setText(e.target.value)} placeholder="City, country (e.g. Shillong, India)" />
          <Button accent={ACCENT} type="submit" disabled={!custom}>Next</Button>
        </form>
      ) : (
        <button type="button" onClick={() => setTyping(true)} className="mt-3 inline-flex items-center gap-1 text-[13px] text-ink-400 transition hover:text-white">
          <Plus className="size-3.5" /> Somewhere else
        </button>
      )}
    </div>
  )
}

function When({ today, dest, onPick }) {
  const options = useMemo(() => whenOptions(today, dest.days), [today, dest])
  const [custom, setCustom] = useState(false)
  const [start, setStart] = useState('')
  const [days, setDays] = useState(dest.days)
  const pickCustom = () => {
    const [y, m, d] = start.split('-').map(Number)
    const s = new Date(y, m - 1, d)
    onPick({ id: 'custom', label: 'Your dates', start: s, days, range: rangeText(s, days) })
  }
  return (
    <div>
      <h2 className="pc-head text-2xl font-semibold tracking-tight text-white">When?</h2>
      <p className="mt-1 text-[13.5px] text-ink-400">{dest.days} days suits a first visit to {dest.name}.</p>
      <ul className="mt-4 grid gap-2.5 sm:grid-cols-2">
        {options.map((o) => (
          <li key={o.id}>
            <button type="button" onClick={() => onPick(o)} className="flex w-full items-center justify-between rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-3.5 text-left transition pa-hover hover:bg-white/[0.04]">
              <span>
                <span className="block text-[15px] font-semibold text-white">{o.label}</span>
                <span className="block text-[12.5px] text-ink-400">{o.range}</span>
              </span>
              <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11.5px] text-ink-300">{o.days} days</span>
            </button>
          </li>
        ))}
      </ul>
      {custom ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input type="date" aria-label="Start date" min={isoDate(today)} className={`${inputClass} !w-auto`} value={start} onChange={(e) => setStart(e.target.value)} />
          <label className="flex items-center gap-1.5 text-[13px] text-ink-300">
            for
            <input type="number" min="1" max="10" aria-label="Days" className={`${inputClass} !w-16`} value={days} onChange={(e) => setDays(Math.min(10, Math.max(1, Number(e.target.value) || 1)))} />
            days
          </label>
          <Button accent={ACCENT} disabled={!start} onClick={pickCustom}>Next</Button>
        </div>
      ) : (
        <button type="button" onClick={() => setCustom(true)} className="mt-3 inline-flex items-center gap-1 text-[13px] text-ink-400 transition hover:text-white">
          <CalendarDays className="size-3.5" /> Pick dates
        </button>
      )}
    </div>
  )
}

const PARTY_ICON = { solo: User, couple: Heart, family: Baby, friends: Users }
function PartyIcon({ id }) {
  const Icon = PARTY_ICON[id] ?? Users
  return <Icon className="size-5" />
}

function Who({ onPick, selected }) {
  return (
    <div>
      <h2 className="pc-head text-2xl font-semibold tracking-tight text-white">Who's going?</h2>
      <ul className="mt-4 grid grid-cols-2 gap-2.5">
        {PARTIES.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => onPick(p.id)} aria-pressed={selected === p.id}
              className={`flex w-full flex-col items-start gap-2 rounded-2xl border px-4 py-4 text-left transition pa-hover ${selected === p.id ? 'pa-on' : 'border-white/[0.08] bg-white/[0.02]'}`}>
              <span aria-hidden className="grid size-10 place-items-center rounded-full bg-white/[0.06] text-white"><PartyIcon id={p.id} /></span>
              <span className="text-[15px] font-semibold text-white">{p.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ChipGroup({ label, children }) {
  return (
    <fieldset className="mt-5">
      <legend className="text-[12px] font-medium text-ink-400">{label}</legend>
      <div className="mt-2 flex flex-wrap gap-1.5">{children}</div>
    </fieldset>
  )
}

function Toggle({ on, onClick, children }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition ${on ? 'pa-on' : 'border-white/10 bg-white/[0.03] text-ink-300 hover:text-white'}`}>
      {on && <Check className="size-3" />} {children}
    </button>
  )
}

function Note({ value, onChange }) {
  const [open, setOpen] = useState(value.length > 0)
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-4 inline-flex items-center gap-1 text-[13px] text-ink-400 transition hover:text-white">
        <Sparkles className="size-3.5" /> Add a note (a birthday, a must-see…)
      </button>
    )
  return (
    <textarea autoFocus aria-label="A note for the planner" maxLength={300} className={`${inputClass} mt-4 min-h-20`} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Anything else? e.g. it's our anniversary on day 2" />
  )
}
