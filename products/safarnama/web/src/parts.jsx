/** Shared TripWeaver pieces: provider hand-off confirmation, evidence-backed labels, discovery place cards. */
import { Bookmark, BookmarkCheck, ExternalLink, Leaf, MapPin, Phone, Plus, ShieldCheck, X } from 'lucide-react'
import { useState } from 'react'
import { Button, inputClass, Pill } from '@appcore/web/ui'
import { noteAway } from './away'
import { hostOf, LABEL_TONE, safeLink } from './logic'

/**
 * Every external action (order, book, reserve, call) is a hand-off to the provider's own site. TripWeaver never
 * places an order or booking itself, and says so before the traveller leaves.
 */
export function Handoff({ link, place, onClose, onSave }) {
  const [save, setSave] = useState(!!onSave)
  if (!link || !safeLink(link.url)) return null
  const host = hostOf(link.url)
  const go = () => {
    if (save && onSave) onSave()
    noteAway(link, place) // so we can ask "did you book it?" when they come back
    onClose()
  }
  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-black/50 p-3 backdrop-blur-sm sm:place-items-center" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-ink-900 p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-emerald-300" />
          <div className="min-w-0 flex-1">
            <h2 id="handoff-title" className="text-[15px] font-semibold text-white">
              {link.kind === 'phone' ? `Call ${place?.name ?? ''}` : `Continue on ${host}`}
            </h2>
            <p className="mt-1.5 text-[13px] text-ink-300">
              {link.kind === 'phone'
                ? 'Your phone will place the call. Safarnaama is not involved in the conversation.'
                : `You're leaving Safarnaama for ${host}${link.source ? ` (link from ${link.source})` : ''}. Safarnaama hasn't ordered, booked or paid for anything, and can't confirm availability.`}
            </p>
            {link.kind !== 'phone' && (
              <p className="mt-1.5 text-[12.5px] text-ink-400">{link.kind === 'booking' ? "When you come back, we'll ask if you booked, so it's saved with this trip in a tap." : 'After you book or order there, save the confirmation under Bookings so it sits with this trip.'}</p>
            )}
            {onSave && (
              <label className="mt-3 flex items-center gap-2 text-[13px] text-ink-200">
                <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Save {place?.name ?? 'this place'} to the trip
              </label>
            )}
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="text-ink-400 hover:text-white"><X className="size-4" /></button>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <a href={link.url} target="_blank" rel="noopener noreferrer" onClick={go} className="btn-primary inline-flex items-center gap-2 rounded-xl pa-gradient px-4 py-2 text-[13px] font-semibold text-on-accent">
            {link.kind === 'phone' ? <Phone className="size-4" /> : <ExternalLink className="size-4" />} {link.kind === 'phone' ? 'Call' : `Open ${host}`}
          </a>
        </div>
      </div>
    </div>
  )
}

export function LabelChips({ labels }) {
  if (!labels?.length) return null
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {labels.map((l) => (
        <span key={l.id} title={`${l.evidence} (source: ${l.source})`}>
          <Pill tone={LABEL_TONE[l.id] ?? 'neutral'}>{l.text}{l.source === 'you' ? ' · your tag' : ''}</Pill>
        </span>
      ))}
    </span>
  )
}

/** One real place from the provider, with save / add-to-day / hand-off actions. */
export function PlaceCard({ p, days, defaultDay, defaultTime = '12:00', onAdd, onSave, onLink, onFocus, busy }) {
  const [day, setDay] = useState(defaultDay ?? days?.[0]?.day ?? 1)
  const [time, setTime] = useState(defaultTime)
  const [open, setOpen] = useState(false)
  const links = (p.links ?? []).filter((l) => l.kind !== 'map' && safeLink(l.url))
  const map = (p.links ?? []).find((l) => l.kind === 'map')
  const facts = [
    p.category,
    p.cuisine,
    p.distance_m != null ? `${p.distance_m >= 1000 ? `${(p.distance_m / 1000).toFixed(1)} km` : `${p.distance_m} m`}` : null,
    p.open === true ? 'open then' : p.open === false ? 'closed then' : null,
    p.fee === 'no' ? 'free entry' : null,
    p.delivery === 'yes' ? 'delivery (per venue data)' : null,
    p.takeaway === 'yes' ? 'takeaway' : null,
    p.reservation && p.reservation !== 'no' ? `reservation: ${p.reservation}` : null,
  ].filter(Boolean)
  return (
    <li className="rounded-xl border border-white/[0.06] bg-ink-950/30 p-3">
      <div className="flex items-start gap-2">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onFocus?.(p)}>
          <p className="flex items-center gap-1.5 text-[13.5px] font-medium text-white">
            <span className="truncate">{p.name}</span>
            {p.veg && <Leaf className="size-3 shrink-0 text-emerald-300" aria-label={p.vegan ? 'vegan' : 'vegetarian-friendly'} />}
          </p>
          <p className="truncate text-[11.5px] text-ink-400">{facts.join(' · ')}</p>
          {p.opening_hours && <p className="truncate text-[11px] text-ink-500">Hours (OpenStreetMap): {p.opening_hours}</p>}
        </button>
        {onSave && (
          <button type="button" aria-label={p.saved ? 'Saved' : `Save ${p.name}`} disabled={p.saved || busy} onClick={() => onSave(p)} className="grid size-7 shrink-0 place-items-center rounded-lg text-ink-400 hover:text-white disabled:text-emerald-300">
            {p.saved ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {map && <a className="chip" href={map.url} target="_blank" rel="noopener noreferrer"><MapPin className="size-3" /> Map</a>}
        {links.map((l) => (
          <button key={l.url} type="button" className="chip" onClick={() => onLink(l, p)}>
            {l.kind === 'phone' ? <Phone className="size-3" /> : <ExternalLink className="size-3" />} {l.label}
          </button>
        ))}
        {p.planned ? (
          <span className="text-[11px] text-ink-500">in your plan</span>
        ) : onAdd && (
          open ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <select aria-label="Day" className={`${inputClass} !w-auto !py-1 text-[12px]`} value={day} onChange={(e) => setDay(Number(e.target.value))}>
                {days.map((d) => <option key={d.day} value={d.day}>Day {d.day}</option>)}
              </select>
              <input aria-label="Time" type="time" className={`${inputClass} !w-auto !py-1 text-[12px]`} value={time} onChange={(e) => setTime(e.target.value)} />
              <button type="button" className="chip !bg-emerald-500/15 !text-emerald-200" disabled={busy} onClick={() => onAdd(p, day, time)}><Plus className="size-3" /> Add</button>
              <button type="button" className="chip" onClick={() => setOpen(false)}>Cancel</button>
            </span>
          ) : (
            <button type="button" className="chip" onClick={() => setOpen(true)}><Plus className="size-3" /> Add to itinerary</button>
          )
        )}
      </div>
    </li>
  )
}

export function SourceNote({ children }) {
  return <p className="text-[11.5px] text-ink-500">{children}</p>
}
