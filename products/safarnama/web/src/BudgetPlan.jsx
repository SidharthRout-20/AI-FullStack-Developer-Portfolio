/**
 * The budget plan (personal space): the traveller's budget split across stay, getting there and around, food, things
 * to do, shopping and a buffer, with what each share means day to day (a night's stay, a person's food for a day)
 * and how much of it is spent or booked. The split starts as a suggestion from the server and follows the budget
 * until the traveller changes a line; it is a plan for their money, never a price.
 */
import { PencilLine, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { errorText } from '@appcore/web/http'
import { Button, ErrorNote, inputClass } from '@appcore/web/ui'
import { budgetPlan, shortMoney, symbolOf, wholeMoney } from './money'
import { cardColour } from './skin'

export function BudgetPlan({ trip, api, owner, onTrip, money, onChanged, setNote }) {
  const plan = budgetPlan(trip, money.sum)
  const [edit, setEdit] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  if (!plan) return null
  const cur = money.sum.currency
  const total = money.sum.budget_total
  const own = trip.budget?.split === 'own'
  const run = async (fn, msg) => {
    setBusy(true)
    setError(null)
    try {
      onTrip(await fn())
      onChanged()
      setEdit(null)
      setNote?.(msg)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const editTotal = edit ? Object.values(edit).reduce((n, v) => n + (Number(v) || 0), 0) : 0
  const save = () => run(() => api.update({ budget_categories: Object.fromEntries(Object.entries(edit).map(([k, v]) => [k, Math.max(0, Number(v) || 0)])) }), 'Budget plan saved.')
  // Back to the suggested split: clear the categories, then set the total again so the server splits it afresh.
  const reset = () => run(async () => (await api.update({ budget_categories: {} }), api.update({ budget: total })), 'Back to the suggested split.')

  return (
    <section className="ui-card rounded-2xl border border-white/[0.07] p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="pc-head text-[24px] leading-none text-white">Budget plan</h2>
          <p className="mt-1 text-[12.5px] text-ink-400">{wholeMoney(total, cur)} for {plan.days} day{plan.days === 1 ? '' : 's'}{plan.people > 1 ? `, ${plan.people} people` : ''} · {own ? 'your own split' : 'a suggested split, change any line'}</p>
        </div>
        {owner && !edit && plan.set && (
          <div className="flex gap-1.5">
            <button type="button" className="chip" onClick={() => setEdit(Object.fromEntries(plan.rows.map((r) => [r.id, String(Math.round(r.planned))])))}><PencilLine className="size-3" /> Change it</button>
            {own && <button type="button" className="chip" disabled={busy} onClick={() => void reset()}><RotateCcw className="size-3" /> Suggested split</button>}
          </div>
        )}
      </div>
      <ErrorNote message={error} />
      {!plan.set && !edit && <p className="mt-3 text-[13px] text-ink-400">This budget isn't split yet. {owner && <button type="button" className="font-semibold text-white underline underline-offset-2" onClick={() => void reset()}>Split it for me</button>}</p>}
      {edit ? (
        <div className="mt-4 space-y-2">
          {plan.rows.map((r) => (
            <label key={r.id} className="flex items-center gap-3">
              <span className="w-44 shrink-0 text-[13.5px] font-medium text-white">{r.label}</span>
              <span className="relative w-40">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[13px] text-ink-400">{symbolOf(cur)}</span>
                <input type="number" min="0" inputMode="numeric" aria-label={`${r.label} budget`} className={`${inputClass} !py-1.5 !pl-8`} value={edit[r.id]} onChange={(e) => setEdit((x) => ({ ...x, [r.id]: e.target.value }))} />
              </span>
            </label>
          ))}
          <p className={`text-[12.5px] ${Math.round(editTotal) === Math.round(total) ? 'text-ink-400' : 'font-semibold text-white'}`}>
            Adds up to {wholeMoney(editTotal, cur)}{Math.round(editTotal) !== Math.round(total) && ` (your budget is ${wholeMoney(total, cur)}; saving keeps the budget as it is)`}
          </p>
          <div className="flex gap-2">
            <Button busy={busy} onClick={() => void save()}>Save the plan</Button>
            <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        plan.set && (
          <ul className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {plan.rows.filter((r) => r.planned > 0).map((r, i) => {
              const used = r.spent + r.booked
              const pct = r.planned > 0 ? Math.min(100, Math.round((used / r.planned) * 100)) : 0
              return (
                <li key={r.id} className="pc-card p-4" style={{ ...cardColour(i), transform: `rotate(${[-1.2, 0.8, -0.6][i % 3]}deg)` }}>
                  <p className="text-[12px] font-semibold tracking-[0.08em] uppercase opacity-80">{r.label}</p>
                  <p className="pc-head mt-1 text-[30px] leading-none">{shortMoney(r.planned, cur)}</p>
                  <p className="mt-1 min-h-[1.2em] text-[12.5px] font-medium">
                    {r.id === 'lodging' && r.each ? `about ${shortMoney(r.each, cur)} a night` : r.id === 'food' && r.each ? `about ${shortMoney(r.each, cur)} a person a day` : r.id === 'other' ? 'for surprises' : ''}
                  </p>
                  <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-black/10" role="img" aria-label={`${pct}% used`}>
                    <div className="h-full rounded-full bg-current" style={{ width: `${Math.max(used > 0 ? 3 : 0, pct)}%` }} />
                  </div>
                  <p className="mt-1.5 text-[12px] font-medium opacity-85">
                    {used === 0 ? 'Nothing spent yet' : r.over ? `${shortMoney(-r.left, cur)} over` : `${shortMoney(r.left, cur)} left`}
                    {r.booked > 0 && ` · ${shortMoney(r.booked, cur)} booked`}
                  </p>
                </li>
              )
            })}
          </ul>
        )
      )}
    </section>
  )
}
