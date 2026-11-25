/**
 * Asks once, when the traveller comes back from a provider's site: did you book it? A yes saves the booking in two
 * taps (reference and price optional), "not yet" keeps the search on the trip's shortlist so they can pick up where
 * they left off, and no just closes. Safarnaama never sees what happened on the provider's site, so it only asks.
 */
import { CalendarCheck, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { errorText } from '@appcore/web/http'
import { inputClass } from '@appcore/web/ui'
import { awayTitle, forgetAway, pendingAway } from './away'

export function AwayCheck({ trip, api, setNote, onDetails }) {
  // Asked on arrival too: phones often drop the tab while the traveller is on the other site.
  const [ask, setAsk] = useState(() => pendingAway(trip.id))
  const [step, setStep] = useState('ask') // ask → booked (quick details)
  const [ref, setRef] = useState('')
  const [cost, setCost] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const check = useCallback(() => {
    const e = pendingAway(trip.id)
    if (e) setAsk((cur) => cur ?? e)
  }, [trip.id])
  useEffect(() => {
    // Only ask on the way back (tab hidden, or the window left for another one), not on every click in the page.
    let left = false
    const leave = () => { left = true }
    const back = () => {
      if (document.visibilityState === 'hidden') return leave()
      if (left) {
        left = false
        check()
      }
    }
    document.addEventListener('visibilitychange', back)
    window.addEventListener('blur', leave)
    window.addEventListener('focus', back)
    return () => {
      document.removeEventListener('visibilitychange', back)
      window.removeEventListener('blur', leave)
      window.removeEventListener('focus', back)
    }
  }, [check])

  if (!ask) return null
  const done = (note) => {
    forgetAway(trip.id)
    setAsk(null)
    setStep('ask')
    setRef('')
    setCost('')
    setError(null)
    if (note) setNote(note)
  }
  const currency = trip.budget?.currency || undefined
  const base = { ...ask.prefill, title: awayTitle(ask) }
  delete base.add_expense
  // A search kept for later is replaced by the booking it led to, rather than listed twice.
  const sameSearch = async () => (await api.bookings().catch(() => [])).find((b) => b.status === 'planned' && b.url && b.url === base.url)

  const save = async (status) => {
    setBusy(true)
    setError(null)
    try {
      const earlier = await sameSearch()
      if (status === 'planned') {
        if (!earlier) await api.addBooking({ ...base, status: 'planned' })
        done(`Kept on your shortlist under Bookings, with the ${ask.label} link to pick up where you left off.`)
        return
      }
      const body = { ...base, status: 'booked' }
      if (ref.trim()) body.reference = ref.trim().slice(0, 80)
      if (cost !== '' && Number(cost) >= 0) Object.assign(body, { cost: Number(cost), currency, add_expense: true })
      if (!body.currency) delete body.currency
      await api.addBooking(body)
      if (earlier) await api.deleteBooking(earlier.id).catch(() => {})
      done(`Saved “${body.title}” to Bookings.${body.add_expense ? ' Its cost is in the budget.' : ''}`)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="dialog" aria-labelledby="away-title" className="fixed inset-x-3 bottom-20 z-40 mx-auto max-w-md rounded-2xl border border-white/10 bg-ink-900 p-4 shadow-2xl sm:bottom-6">
      <div className="flex items-start gap-3">
        <CalendarCheck className="pa-ink mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p id="away-title" className="text-[14px] font-semibold text-white">Welcome back. Did you book on {ask.label}?</p>
          <p className="mt-0.5 text-[12.5px] text-ink-400">{base.title}</p>
        </div>
        <button type="button" aria-label="Ask me later" title="Ask me later" onClick={() => setAsk(null)} className="text-ink-400 hover:text-white"><X className="size-4" /></button>
      </div>
      {step === 'ask' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn-primary pa-gradient rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold text-on-accent" onClick={() => setStep('booked')}>Yes, I booked it</button>
          <button type="button" className="chip" disabled={busy} onClick={() => void save('planned')}>Not yet, keep it for later</button>
          <button type="button" className="chip" onClick={() => done()}>No</button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <input className={inputClass} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Confirmation ref (optional)" aria-label="Confirmation reference" />
            <input type="number" min="0" step="0.01" className={`${inputClass} !w-32`} value={cost} onChange={(e) => setCost(e.target.value)} placeholder={`Paid${currency ? ` (${currency})` : ''}`} aria-label="Amount paid" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} className="btn-primary pa-gradient rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold text-on-accent" onClick={() => void save('booked')}>{busy ? 'Saving…' : 'Save booking'}</button>
            <button type="button" className="chip" onClick={() => { const p = { ...base, status: 'booked', reference: ref, cost }; done(); onDetails(p) }}>Add dates & more details</button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-[12px] text-rose-300">{error}</p>}
    </div>
  )
}
