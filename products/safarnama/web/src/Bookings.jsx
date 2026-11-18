/** Bookings & reservations: the traveller's own records, tied to days and stops. TripWeaver never books anything. */
import { BedDouble, Bus, Car, CalendarCheck, ExternalLink, Plane, Plus, Ticket, Trash2, TrainFront, UtensilsCrossed } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { errorText } from '@appcore/web/http'
import { Button, Card, Empty, ErrorNote, Field, inputClass, Pill, Spinner } from '@appcore/web/ui'
import { BookPanel } from './BookPanel'
import { BOOKING_TYPES, hostOf, money, safeLink } from './logic'
import { ACCENT } from './QuickPlan'

const ICON = { flight: Plane, hotel: BedDouble, train: TrainFront, bus: Bus, car: Car, restaurant: UtensilsCrossed }
const BLANK = { type: 'hotel', title: '', provider: '', reference: '', start: '', end: '', day: '', activity_id: '', cost: '', currency: '', cancellation: '', url: '', status: 'booked', notes: '', add_expense: true }

export function Bookings({ trip, api, setNote, prefill, onUsedPrefill }) {
  const [items, setItems] = useState(null)
  const [form, setForm] = useState(() => (prefill ? { ...BLANK, ...prefill } : null))
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => api.bookings().then(setItems).catch((e) => (setItems([]), setError(errorText(e)))), [api])
  useEffect(() => void load(), [load])
  useEffect(() => {
    if (prefill) onUsedPrefill?.() // consumed: the form above was initialised from it
  }, [prefill, onUsedPrefill])

  const stops = trip.days.flatMap((d) => d.activities.map((a) => ({ id: a.id, label: `Day ${d.day} · ${a.time} ${a.name}`, day: d.day })))
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  const submit = async () => {
    setBusy(true)
    setError(null)
    const body = { type: form.type, title: form.title.trim(), status: form.status, add_expense: !!form.add_expense && !!form.cost }
    for (const k of ['provider', 'reference', 'start', 'end', 'cancellation', 'url', 'notes', 'activity_id']) if (String(form[k] ?? '').trim()) body[k] = String(form[k]).trim()
    if (form.day) body.day = Number(form.day)
    if (form.cost !== '') body.cost = Number(form.cost)
    if (form.currency) body.currency = form.currency.toUpperCase()
    if (body.activity_id && !body.day) body.day = stops.find((s) => s.id === body.activity_id)?.day
    try {
      await api.addBooking(body)
      setForm(null)
      setNote(`Saved “${body.title}”.${body.add_expense ? ' Its cost was added to the budget.' : ''}`)
      void load()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <BookPanel trip={trip} onSave={(p) => { setForm({ ...BLANK, currency: trip.budget?.currency ?? '', ...p }); window.requestAnimationFrame(() => document.getElementById('booking-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })) }} />
      <Card>
        <div id="booking-form" className="flex scroll-mt-20 flex-wrap items-center gap-2">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><CalendarCheck className="pa-ink size-4" /> Your bookings</p>
          {!form && <Button variant="ghost" className="ml-auto !py-1.5" onClick={() => setForm({ ...BLANK, currency: trip.budget?.currency ?? 'EUR' })}><Plus className="size-4" /> Add a booking</Button>}
        </div>
        <p className="mt-1 text-[12.5px] text-ink-400">Keep flights, hotels, trains, tables and tickets with the trip. These are your records: Safarnaama doesn't make or confirm bookings.</p>
        {form && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Type">
              <select className={inputClass} value={form.type} onChange={set('type')}>{BOOKING_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
            </Field>
            <Field label="What"><input className={inputClass} value={form.title} onChange={set('title')} placeholder="e.g. Hotel Lisboa, 2 nights" /></Field>
            <Field label="Provider"><input className={inputClass} value={form.provider} onChange={set('provider')} placeholder="Airline, hotel, platform…" /></Field>
            <Field label="Confirmation reference"><input className={inputClass} value={form.reference} onChange={set('reference')} /></Field>
            <Field label="Starts"><input type="datetime-local" className={inputClass} value={form.start} onChange={set('start')} /></Field>
            <Field label="Ends"><input type="datetime-local" className={inputClass} value={form.end} onChange={set('end')} /></Field>
            <Field label="Linked stop" hint="optional">
              <select className={inputClass} value={form.activity_id} onChange={set('activity_id')}>
                <option value="">None</option>
                {stops.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="Day" hint="optional">
              <select className={inputClass} value={form.day} onChange={set('day')}>
                <option value="">Whole trip</option>
                {trip.days.map((d) => <option key={d.day} value={d.day}>Day {d.day}{d.date ? ` · ${d.date}` : ''}</option>)}
              </select>
            </Field>
            <Field label="Cost" hint="optional">
              <div className="flex gap-2">
                <input type="number" min="0" step="0.01" className={inputClass} value={form.cost} onChange={set('cost')} />
                <input aria-label="Currency" maxLength={3} className={`${inputClass} !w-20 uppercase`} value={form.currency} onChange={set('currency')} />
              </div>
            </Field>
            <Field label="Status">
              <select className={inputClass} value={form.status} onChange={set('status')}>
                <option value="booked">Booked (confirmed by the provider)</option>
                <option value="planned">Planned (not booked yet)</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </Field>
            <Field label="Cancellation terms" hint="as given by the provider"><input className={inputClass} value={form.cancellation} onChange={set('cancellation')} /></Field>
            <Field label="Provider link" hint="https://…"><input className={inputClass} value={form.url} onChange={set('url')} /></Field>
            <div className="sm:col-span-2"><Field label="Notes"><textarea className={`${inputClass} min-h-16`} value={form.notes} onChange={set('notes')} /></Field></div>
            <label className="flex items-center gap-2 text-[13px] text-ink-200 sm:col-span-2">
              <input type="checkbox" checked={!!form.add_expense} onChange={set('add_expense')} /> Add the cost to the budget ({form.status === 'booked' ? 'actual spend' : 'estimate'})
            </label>
            <div className="flex gap-2 sm:col-span-2">
              <Button accent={ACCENT} onClick={() => void submit()} busy={busy} disabled={!form.title.trim()}>Save booking</Button>
              <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </Card>
      <ErrorNote message={error} />
      {!items ? <Spinner label="Loading bookings…" /> : items.length === 0 ? (
        <Empty icon={Ticket} title="No bookings yet" text="Book with one of the searches above, then save the confirmation here, or add one you made elsewhere." />
      ) : (
        <ul className="space-y-2">
          {items.map((b) => {
            const Icon = ICON[b.type] ?? Ticket
            const stop = stops.find((s) => s.id === b.activity_id)
            return (
              <li key={b.id} className="flex items-start gap-3 rounded-2xl border border-white/[0.07] bg-ink-900/60 p-3">
                <Icon className="mt-0.5 size-4 shrink-0 text-ink-300" />
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-white">{b.title} <Pill tone={b.status === 'booked' ? 'good' : b.status === 'cancelled' ? 'bad' : 'warn'}>{b.status}</Pill></p>
                  <p className="text-[12px] text-ink-400">
                    {[b.provider, b.reference && `Ref ${b.reference}`, b.start && b.start.replace('T', ' '), b.end && `→ ${b.end.replace('T', ' ')}`, b.day && `Day ${b.day}`,
                      b.cost != null && money(b.cost, b.currency || trip.budget?.currency)].filter(Boolean).join(' · ')}
                  </p>
                  {stop && <p className="text-[12px] text-emerald-300">Linked to {stop.label}</p>}
                  {b.cancellation && <p className="text-[12px] text-ink-400">Cancellation: {b.cancellation}</p>}
                  {b.notes && <p className="text-[12px] text-ink-400">{b.notes}</p>}
                  <p className="text-[11px] text-ink-500">Saved by you · not booked or verified by Safarnaama</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {b.url && safeLink(b.url) && <a className="chip" href={b.url} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-3" /> {hostOf(b.url)}</a>}
                  {b.status !== 'cancelled' && <button type="button" className="chip" onClick={() => void api.updateBooking(b.id, { status: 'cancelled' }).then(() => { load(); setNote('Marked cancelled. Its cost was taken out of the budget; add any cancellation fee as an expense.') }).catch((e) => setError(errorText(e)))}>Mark cancelled</button>}
                  <button type="button" aria-label={`Delete ${b.title}`} className="grid size-7 place-items-center text-ink-500 hover:text-rose-300" onClick={() => void api.deleteBooking(b.id).then(() => { load(); setNote(`Deleted “${b.title}”, with any cost it had added to the budget.`) }).catch((e) => setError(errorText(e)))}><Trash2 className="size-3.5" /></button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
