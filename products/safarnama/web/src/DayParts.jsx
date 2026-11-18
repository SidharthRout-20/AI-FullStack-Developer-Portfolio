/**
 * The itinerary's building blocks: a day header to look forward to, one calm "day check" instead of a wall of
 * warnings, and a timeline (coloured stops, travel between them, moments of the day kept quiet), with stops you can
 * tick off as you go.
 */
import { Car, Check, ChevronDown, CircleCheck, Footprints, Lightbulb, MapPinned, Sparkles, TimerReset, Wand2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useState } from 'react'
import { DAY_COLORS } from './colors'
import { dateRange, dayCheck, dayHighlights, isMoment } from './logic'
import { fmtMin } from './Travel'

// ── done ticks (this browser only) ─────────────────────────────────────────
export function useDone(tripId) {
  const key = `safarnaama-done-${tripId}`
  const [done, setDone] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? '[]'))
    } catch {
      return new Set()
    }
  })
  const toggle = useCallback(
    (id) =>
      setDone((cur) => {
        const next = new Set(cur)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        try {
          localStorage.setItem(key, JSON.stringify([...next]))
        } catch {
          /* private mode: ticks last for this visit */
        }
        return next
      }),
    [key],
  )
  return [done, toggle]
}

// ── header ─────────────────────────────────────────────────────────────────
export function DayHeader({ d, multiDest, destName, done, right }) {
  const color = DAY_COLORS[(d.day - 1) % DAY_COLORS.length]
  const places = d.activities.filter((a) => !isMoment(a))
  const ticked = places.filter((a) => done.has(a.id)).length
  const highlights = dayHighlights(d)
  const travel = (d.route?.drive_min ?? 0) + (d.route?.walk_min ?? 0)
  return (
    <div>
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl text-[17px] font-bold text-[#fff] shadow-lg" style={{ background: color }}>
          {d.day}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium text-ink-400">
            {d.date ? dateRange(d.date) : `Day ${d.day}`}
            {multiDest && destName ? ` · ${destName}` : ''}
            {d.weather?.tmax != null && ` · ${Math.round(d.weather.tmin)}–${Math.round(d.weather.tmax)}°C${d.weather.rain >= 40 ? `, ${d.weather.rain}% rain` : ''}`}
          </p>
          <h3 className="pa-display text-[21px] leading-tight font-semibold text-white">{d.theme || `Day ${d.day}`}</h3>
          {highlights.length > 0 && (
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-300">
              <Sparkles className="pa-ink size-3.5" /> Today: {highlights.join(' · ')}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">{right}</div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-400">
        <span>{places.length} stop{places.length === 1 ? '' : 's'}</span>
        {travel > 0 && (
          <span className="inline-flex items-center gap-1">
            {d.route.drive_min > 0 ? <Car className="size-3.5" /> : <Footprints className="size-3.5" />} {fmtMin(travel)} getting around
          </span>
        )}
        {places.length > 0 && (
          <span className="ml-auto inline-flex items-center gap-2" aria-label={`${ticked} of ${places.length} stops done`}>
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-white/[0.08]">
              <motion.span className="block h-full rounded-full" style={{ background: color }} initial={false} animate={{ width: `${(ticked / places.length) * 100}%` }} />
            </span>
            {ticked}/{places.length} done
          </span>
        )}
      </div>
    </div>
  )
}

// ── day check ──────────────────────────────────────────────────────────────
export function DayCheck({ d, owner, busy, onFixTiming, onFind }) {
  const { problems, tips, timing, unmapped } = dayCheck(d)
  const [open, setOpen] = useState(false)
  if (!problems.length && !tips.length && !d.retimed) return null
  const ok = problems.length === 0
  const summary = ok
    ? `Day looks good${d.retimed ? ', times fitted to travel' : ''}`
    : [timing && `${timing} timing clash${timing > 1 ? 'es' : ''}`, unmapped && `${unmapped} place${unmapped > 1 ? 's' : ''} to pin on the map`, problems.length - timing - unmapped > 0 && `${problems.length - timing - unmapped} to check`].filter(Boolean).join(' · ')
  return (
    <div className={`mt-3 rounded-2xl border ${ok ? 'border-white/[0.07] bg-white/[0.02]' : 'border-amber-400/25 bg-amber-400/[0.06]'}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[13px]">
        {ok ? <CircleCheck className="size-4 shrink-0 text-emerald-400" /> : <Wand2 className="size-4 shrink-0 text-amber-400" />}
        <span className="font-medium text-ink-100">{summary}</span>
        {tips.length > 0 && <span className="text-ink-400">· {tips.length} tip{tips.length > 1 ? 's' : ''} for the day</span>}
        {!ok && owner && timing > 0 && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => (e.stopPropagation(), onFixTiming())}
            onKeyDown={(e) => e.key === 'Enter' && (e.stopPropagation(), onFixTiming())}
            className={`ml-auto inline-flex items-center gap-1 rounded-full bg-amber-400/20 px-2.5 py-1 text-[12px] font-semibold text-ink-100 hover:bg-amber-400/30 ${busy ? 'pointer-events-none opacity-50' : ''}`}
          >
            <TimerReset className="size-3.5" /> Fix timings
          </span>
        )}
        <ChevronDown className={`size-4 shrink-0 text-ink-500 transition ${!ok && owner && timing > 0 ? '' : 'ml-auto'} ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <ul className="space-y-1.5 px-3.5 pb-3 text-[12.5px]">
              {problems.map((p, i) => (
                <li key={`p${i}`} className="flex items-start gap-2 text-ink-200">
                  {p.kind === 'map' ? <MapPinned className="mt-0.5 size-3.5 shrink-0 text-amber-400" /> : <TimerReset className="mt-0.5 size-3.5 shrink-0 text-amber-400" />}
                  <span className="flex-1">{p.kind === 'timing' ? p.text.replace(' Use Optimise route to re-time the day.', '') : p.text}</span>
                  {owner && p.kind === 'map' && (
                    <button type="button" className="chip shrink-0" onClick={() => onFind(p.activity_id)}>Pin it</button>
                  )}
                </li>
              ))}
              {tips.map((t, i) => (
                <li key={`t${i}`} className="flex items-start gap-2 text-ink-300">
                  <Lightbulb className={`mt-0.5 size-3.5 shrink-0 ${t.important ? 'pa-ink' : 'text-ink-500'}`} />
                  <span>{t.text}</span>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── timeline pieces ────────────────────────────────────────────────────────
const KIND_TINT = { food: '#f59e0b', indoor: '#8b5cf6', outdoor: '#10b981', transit: '#0ea5e9' }

export function StopDot({ a, Icon, done, moment }) {
  const tint = moment ? 'var(--color-ink-600)' : KIND_TINT[a.kind] ?? '#10b981'
  return (
    <span
      className={`relative z-[1] grid place-items-center rounded-full ring-4 ring-[color:var(--color-ink-900)] transition ${moment ? 'size-5' : 'size-7'}`}
      style={{ background: done ? 'var(--color-ink-700)' : tint }}
    >
      {done ? <Check className="size-3.5 text-[#fff]" /> : <Icon className={`${moment ? 'size-2.5' : 'size-3.5'} text-[#fff]`} />}
    </span>
  )
}

/** Travel between two stops: a dashed connector with the time and distance. */
export function Connector({ leg }) {
  if (!leg) return null
  const Icon = leg.mode === 'walk' ? Footprints : Car
  return (
    <li className="grid grid-cols-[52px_28px_1fr] items-center gap-x-2" aria-label={`${leg.minutes} minutes by ${leg.mode}`}>
      <span />
      <span className="mx-auto h-7 w-px border-l border-dashed border-white/20" />
      <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/[0.04] px-2.5 py-0.5 text-[11.5px] text-ink-400">
        <Icon className="size-3" /> {leg.minutes} min {leg.mode === 'walk' ? 'walk' : 'drive'} · {leg.km} km
        {leg.peak && <span className="text-amber-400">· rush hour, allow ~{leg.peak_minutes} min</span>}
      </span>
    </li>
  )
}
