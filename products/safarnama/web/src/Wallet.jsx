/**
 * The trip wallet (personal space): the three numbers a traveller actually checks — what's free to spend, what that
 * means a day, and what's been spent — and a one-line way to log a spend. The budget plan (BudgetPlan.jsx) shows how
 * the budget splits. Nothing here is a price Safarnaama made up.
 */
import { Check, Plus, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { errorText } from '@appcore/web/http'
import { Button, Card, ErrorNote, inputClass, Spinner } from '@appcore/web/ui'
import { ACCENT } from './QuickPlan'
import { allowance, shortMoney, symbolOf, wholeMoney as money } from './money'
import { localDate } from './logic'
import { cardColour } from './skin'

const QUICK = [
  { id: 'food', label: 'Food' },
  { id: 'transport', label: 'Travel' },
  { id: 'lodging', label: 'Stay' },
  { id: 'activities', label: 'Tickets' },
  { id: 'shopping', label: 'Shopping' },
  { id: 'other', label: 'Other' },
]

/** The budget summary from the server, reloaded whenever something is spent. */
export function useMoney(api, trip) {
  const [sum, setSum] = useState(null)
  const [error, setError] = useState(null)
  const reload = useCallback(() => api.budget().then(setSum).catch((e) => setError(errorText(e))), [api])
  useEffect(() => void reload(), [reload, trip.version, trip.budget?.total, trip.budget?.currency])
  return { sum, error, reload }
}

export function Wallet({ trip, api, owner, onTrip, setNote, money: m, onSpent }) {
  const { sum, error } = m
  const a = useMemo(() => allowance(sum, trip), [sum, trip])
  if (error) return <ErrorNote message={error} />
  if (!sum) return <Card className="!py-5"><Spinner label="Opening your wallet…" /></Card>
  const cur = sum.currency
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="pc-head text-[24px] leading-none text-white">Trip wallet</h2>
        <span className="text-[12px] text-ink-500">in {cur}</span>
      </div>
      {a ? (
        <>
          <div className="grid grid-cols-3 gap-2.5 sm:gap-4">
            <Figure i={0} label={a.over ? 'Over budget' : 'Free to spend'} value={shortMoney(a.free, cur)} />
            <Figure i={1} label={a.left ? `A day, ${a.left} day${a.left === 1 ? '' : 's'} left` : 'Trip over'} value={a.perDay != null ? shortMoney(Math.max(0, a.perDay), cur) : '—'} />
            <Figure i={3} label="Spent" value={shortMoney(sum.actual_total, cur)} />
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-white/[0.07]" role="img" aria-label={`${a.spentPct}% of the budget spent`}>
            <div className={`h-full rounded-full ${a.over ? 'bg-rose-400' : 'bg-[var(--pl-ink)]'}`} style={{ width: `${Math.max(2, a.spentPct)}%` }} />
          </div>
          <p className="text-[12.5px] text-ink-400">
            {a.spentPct}% of {money(sum.budget_total, cur)} spent
            {sum.estimated_total > 0 && <> · {money(sum.estimated_total, cur)} more planned</>}
            {a.people > 1 && a.perPersonPerDay != null && a.perPersonPerDay > 0 && <> · about {shortMoney(a.perPersonPerDay, cur)} a person a day</>}
          </p>
        </>
      ) : owner ? (
        <SetBudget trip={trip} api={api} onTrip={onTrip} setNote={setNote} />
      ) : (
        <p className="text-[13px] text-ink-400">Spent so far: <span className="font-semibold text-white">{money(sum.actual_total, cur)}</span></p>
      )}
      {(owner || trip.role === 'member') && <QuickSpend trip={trip} api={api} currency={cur} onSaved={() => { onSpent(); setNote('Spend saved.') }} />}
      {sum.settlements.length > 0 && (
        <div className="rounded-xl bg-white/[0.03] px-3 py-2">
          <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-white"><Users className="size-3.5" /> To settle up</p>
          <ul className="mt-1 text-[12.5px] text-ink-200">{sum.settlements.map((s) => <li key={`${s.from}-${s.to}`}>{s.from} pays {s.to} <span className="font-semibold">{money(s.amount, cur)}</span></li>)}</ul>
        </div>
      )}
    </Card>
  )
}

/** One of the wallet's three figures, as a tilted colour card like the personal space's. */
function Figure({ i, label, value }) {
  return (
    <div className="pc-card min-w-0 px-3 py-3 sm:px-4 sm:py-4" style={{ ...cardColour(i), transform: `rotate(${[-1.5, 1, 0, -0.8][i]}deg)` }}>
      <p className="pc-head truncate text-[24px] leading-none tabular-nums sm:text-[34px]">{value}</p>
      <p className="mt-1.5 truncate text-[11.5px] font-semibold opacity-85">{label}</p>
    </div>
  )
}

function SetBudget({ trip, api, onTrip, setNote }) {
  const [total, setTotal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const cur = trip.budget?.currency ?? 'INR'
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      onTrip(await api.update({ budget: Number(total), currency: cur }))
      setNote('Budget set. The wallet now shows what you can spend each day.')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <p className="text-[13.5px] text-ink-200">Set a budget and Safarnaama tells you what you can spend each day, as you go.</p>
      <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (Number(total) > 0) void save() }}>
        <span className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[14px] text-ink-400">{symbolOf(cur)}</span>
          <input type="number" min="1" inputMode="numeric" aria-label={`Total budget in ${cur}`} placeholder="Total for the trip" value={total} onChange={(e) => setTotal(e.target.value)} className={`${inputClass} !pl-8`} />
        </span>
        <Button type="submit" accent={ACCENT} busy={busy} disabled={!(Number(total) > 0)}>Set budget</Button>
      </form>
      <ErrorNote message={error} />
    </div>
  )
}

/** Log a spend in one line: amount, what for, and (on group trips) who paid. */
function QuickSpend({ trip, api, currency, onSaved }) {
  const [amount, setAmount] = useState('')
  const [cat, setCat] = useState('food')
  const [paidBy, setPaidBy] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState(null)
  const group = (Number(trip.party?.travellers) || 1) > 1
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const today = localDate()
      const day = trip.days.find((d) => d.date === today)?.day
      await api.addExpense({ amount: Number(amount), currency, category: cat, kind: 'actual', note: '', split_between: [], date: today, ...(day ? { day } : {}), ...(paidBy.trim() ? { paid_by: paidBy.trim() } : {}) })
      setAmount('')
      setDone(true)
      setTimeout(() => setDone(false), 1500)
      onSaved()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="space-y-2 border-t border-white/[0.06] pt-3" onSubmit={(e) => { e.preventDefault(); if (Number(amount) > 0) void save() }}>
      <p className="text-[12px] font-medium text-ink-400">Spent something?</p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="What for">
        {QUICK.map((q) => (
          <button key={q.id} type="button" aria-pressed={cat === q.id} onClick={() => setCat(q.id)}
            className={`rounded-full border px-2.5 py-1 text-[12px] font-medium transition ${cat === q.id ? 'pa-on' : 'border-white/10 text-ink-300 hover:text-white'}`}>{q.label}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <span className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[14px] text-ink-400">{symbolOf(currency)}</span>
          <input type="number" min="0" step="0.01" inputMode="decimal" aria-label={`Amount in ${currency}`} placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${inputClass} !pl-8`} />
        </span>
        {group && <input aria-label="Paid by" placeholder="Paid by" value={paidBy} onChange={(e) => setPaidBy(e.target.value.slice(0, 40))} className={`${inputClass} !w-28`} />}
        <Button type="submit" accent={ACCENT} busy={busy} disabled={!(Number(amount) > 0)}>{done ? <Check className="size-4" /> : <Plus className="size-4" />} Add</Button>
      </div>
      <ErrorNote message={error} />
    </form>
  )
}
