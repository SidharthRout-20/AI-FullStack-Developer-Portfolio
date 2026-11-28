/**
 * Budget & expenses: estimates kept apart from actual spend, dated reference rates, group settle-up, receipt scan.
 * `compact` (the personal space's Money tab, under the wallet): the headline numbers and settle-up live in the wallet,
 * so this shows where the money went and the history, with the detailed form and settings one tap away.
 */
import { Camera, ChevronDown, PiggyBank, Plus, Receipt, Trash2, Users } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText } from '@appcore/web/http'
import { Button, Card, ErrorNote, Field, inputClass, Pill, Spinner } from '@appcore/web/ui'
import { EXPENSE_CATEGORIES, localDate, money, pct } from './logic'
import { compressImage } from '@appcore/web/device'

const blank = (cur) => ({ amount: '', currency: cur, category: 'food', kind: 'actual', date: localDate(), day: '', paid_by: '', split_between: '', note: '', rate: '' })

export function Budget({ trip, api, owner, onTrip, setNote, compact = false, onChanged }) {
  const [details, setDetails] = useState(!compact) // compact: the detailed form opens on request
  const cur = trip.budget?.currency ?? 'EUR'
  const [sum, setSum] = useState(null)
  const [items, setItems] = useState([])
  const [form, setForm] = useState(blank(cur))
  const [settings, setSettings] = useState({ total: trip.budget?.total ?? '', currency: cur })
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [draftNote, setDraftNote] = useState(null)
  const file = useRef(null)

  const load = useCallback(() => {
    api.budget().then(setSum).catch((e) => setError(errorText(e)))
    api.expenses().then(setItems).catch(() => setItems([]))
  }, [api])
  useEffect(() => void load(), [load])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const add = async () => {
    setBusy('add')
    setError(null)
    const body = { amount: Number(form.amount), currency: form.currency.toUpperCase(), category: form.category, kind: form.kind, note: form.note.trim(),
      split_between: form.split_between.split(',').map((s) => s.trim()).filter(Boolean) }  // prettier-ignore
    if (form.date) body.date = form.date
    if (form.day) body.day = Number(form.day)
    if (form.paid_by.trim()) body.paid_by = form.paid_by.trim()
    if (form.rate) body.rate = Number(form.rate)
    try {
      const e = await api.addExpense(body)
      setForm(blank(cur))
      setDraftNote(null)
      setNote(e.currency !== cur && !e.fx ? `Saved, but no reference rate was available for ${e.currency}: it's listed as not converted.` : 'Expense saved.')
      load()
      onChanged?.()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  const saveSettings = async () => {
    setBusy('settings')
    try {
      onTrip(await api.update({ budget: settings.total === '' ? null : Number(settings.total), currency: settings.currency.toUpperCase() }))
      setNote('Budget updated.')
      load()
      onChanged?.()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  const scan = async (f) => {
    if (!f) return
    setBusy('scan')
    setError(null)
    try {
      const blob = await (await fetch(await compressImage(f))).blob()
      const out = await api.scanReceipt(blob)
      const d = out.draft
      setForm((x) => ({ ...x, amount: d.amount ?? '', currency: d.currency ?? x.currency, date: d.date ?? x.date, category: d.category ?? x.category, note: d.merchant ?? x.note }))
      setDraftNote(out.note)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
      if (file.current) file.current.value = ''
    }
  }

  return (
    <div className="space-y-3">
      <ErrorNote message={error} />
      {!sum ? <Spinner label="Loading budget…" /> : (
        <Card>
          {compact ? <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><PiggyBank className="pa-ink size-4" /> Where the money went</p> : (
          <>
          <div className="flex flex-wrap items-baseline gap-3">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><PiggyBank className="pa-ink size-4" /> Budget</p>
            <p className="text-[13px] text-ink-300">
              Spent <span className="font-semibold text-white">{money(sum.actual_total, sum.currency)}</span>
              {sum.budget_total != null && <> of {money(sum.budget_total, sum.currency)} · <span className={sum.over_budget ? 'text-rose-300' : 'text-emerald-300'}>{money(sum.remaining, sum.currency)} left</span></>}
            </p>
            {sum.estimated_total > 0 && <Pill tone="info">+ {money(sum.estimated_total, sum.currency)} estimated, not spent</Pill>}
          </div>
          {sum.budget_total != null && (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/[0.06]" role="img" aria-label={`${pct(sum.actual_total, sum.budget_total)}% of budget spent`}>
              <div className={`h-full ${sum.over_budget ? 'bg-rose-400' : 'bg-emerald-400'}`} style={{ width: `${pct(sum.actual_total, sum.budget_total)}%` }} />
            </div>
          )}
          {sum.remaining_after_estimates != null && sum.estimated_total > 0 && <p className="mt-1 text-[12px] text-ink-400">After estimates: {money(sum.remaining_after_estimates, sum.currency)} left.</p>}
          </>
          )}
          {!Object.values(sum.by_category).some((v) => v.actual || v.estimated || v.budget) ? (
            <p className="mt-3 rounded-xl border border-dashed border-white/10 px-3 py-4 text-center text-[12.5px] text-ink-400">Nothing spent or planned yet. Add an expense below, or set a total budget to track against.</p>
          ) : (
          <table className="mt-3 w-full text-[12.5px]">
            <thead><tr className="text-left text-ink-400"><th className="py-1 font-medium">Category</th><th className="font-medium">Actual</th><th className="font-medium">Estimated</th><th className="font-medium">Budget</th></tr></thead>
            <tbody>
              {Object.entries(sum.by_category).filter(([, v]) => v.actual || v.estimated || v.budget).map(([c, v]) => (
                <tr key={c} className="border-t border-white/[0.05] text-ink-200"><td className="py-1 capitalize">{c}</td><td>{money(v.actual, sum.currency)}</td><td>{v.estimated ? money(v.estimated, sum.currency) : '—'}</td><td>{v.budget ? money(v.budget, sum.currency) : '—'}</td></tr>
              ))}
            </tbody>
          </table>
          )}
          {sum.unconverted.length > 0 && <p className="mt-2 text-[12px] text-amber-300">{sum.unconverted.length} expense(s) in another currency had no reference rate, so they're not in the totals. Re-add them with your own rate.</p>}
          {sum.rates.length > 0 && <p className="mt-2 text-[11.5px] text-ink-500">Rates used: {sum.rates.join('; ')}. Reference rates, not live quotes.</p>}
          {!compact && sum.settlements.length > 0 && (
            <div className="mt-3">
              <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-white"><Users className="size-3.5" /> Settle up</p>
              <ul className="mt-1 text-[12.5px] text-ink-200">{sum.settlements.map((s) => <li key={`${s.from}-${s.to}`}>{s.from} pays {s.to} {money(s.amount, sum.currency)}</li>)}</ul>
            </div>
          )}
        </Card>
      )}

      {!details ? (
        <button type="button" onClick={() => setDetails(true)} className="flex w-full items-center justify-between gap-2 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-left text-[13px] text-ink-200 hover:border-white/15 hover:text-white">
          <span className="flex items-center gap-2"><Receipt className="size-4 text-amber-300" /> Add with details: another currency, a split, a receipt photo, or budget settings</span>
          <ChevronDown className="size-4 shrink-0" />
        </button>
      ) : (
      <>
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><Receipt className="size-4 text-amber-300" /> Add an expense</p>
          {owner && (
            <>
              <input ref={file} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void scan(e.target.files?.[0])} />
              <Button variant="ghost" className="ml-auto !py-1.5" busy={busy === 'scan'} onClick={() => file.current?.click()}><Camera className="size-4" /> Scan a receipt</Button>
            </>
          )}
        </div>
        {draftNote && <p className="mt-2 rounded-lg bg-amber-500/[0.08] px-2.5 py-1.5 text-[12.5px] text-amber-200">{draftNote}</p>}
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Amount"><input type="number" min="0" step="0.01" className={inputClass} value={form.amount} onChange={set('amount')} /></Field>
          <Field label="Currency"><input maxLength={3} className={`${inputClass} uppercase`} value={form.currency} onChange={set('currency')} /></Field>
          <Field label="Category"><select className={inputClass} value={form.category} onChange={set('category')}>{EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Type"><select className={inputClass} value={form.kind} onChange={set('kind')}><option value="actual">Actual (spent)</option><option value="estimate">Estimate (planned)</option></select></Field>
          <Field label="Date"><input type="date" className={inputClass} value={form.date} onChange={set('date')} /></Field>
          <Field label="Day" hint="optional"><select className={inputClass} value={form.day} onChange={set('day')}><option value="">—</option>{trip.days.map((d) => <option key={d.day} value={d.day}>Day {d.day}</option>)}</select></Field>
          <Field label="Paid by" hint="for group trips"><input className={inputClass} value={form.paid_by} onChange={set('paid_by')} /></Field>
          <Field label="Split between" hint="names, comma-separated"><input className={inputClass} value={form.split_between} onChange={set('split_between')} /></Field>
          <Field label="Note"><input className={inputClass} value={form.note} onChange={set('note')} /></Field>
          {form.currency.toUpperCase() !== cur && (
            <Field label={`Your rate to ${cur}`} hint="optional; otherwise today's reference rate"><input type="number" min="0" step="0.0001" className={inputClass} value={form.rate} onChange={set('rate')} /></Field>
          )}
        </div>
        <Button accent="from-lime-500 to-teal-500" className="mt-3" onClick={() => void add()} busy={busy === 'add'} disabled={!(Number(form.amount) > 0) || form.currency.length !== 3}><Plus className="size-4" /> Save expense</Button>
      </Card>

      {owner && (
        <Card>
          <p className="text-[13px] font-semibold text-white">Budget settings</p>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Field label="Total budget"><input type="number" min="0" className={`${inputClass} !w-36`} value={settings.total} onChange={(e) => setSettings((s) => ({ ...s, total: e.target.value }))} /></Field>
            <Field label="Trip currency"><input maxLength={3} className={`${inputClass} !w-24 uppercase`} value={settings.currency} onChange={(e) => setSettings((s) => ({ ...s, currency: e.target.value }))} /></Field>
            <Button variant="ghost" onClick={() => void saveSettings()} busy={busy === 'settings'}>Save</Button>
          </div>
        </Card>
      )}
      </>
      )}

      {items.length > 0 && (
        <Card>
          <p className="text-[13px] font-semibold text-white">Expense history</p>
          <ul className="mt-2 divide-y divide-white/[0.05]">
            {items.map((e) => (
              <li key={e.id} className="flex items-center gap-2 py-1.5 text-[12.5px]">
                <span className="w-24 shrink-0 text-ink-400">{e.date ?? (e.day ? `Day ${e.day}` : '')}</span>
                <span className="min-w-0 flex-1 truncate text-ink-200">{e.note || e.category}{e.paid_by ? ` · paid by ${e.paid_by}` : ''}</span>
                {e.kind === 'estimate' && <Pill tone="info">estimate</Pill>}
                <span className="text-white tabular-nums">{money(e.amount, e.currency)}</span>
                {owner && <button type="button" aria-label="Delete expense" className="text-ink-500 hover:text-rose-300" onClick={() => void api.deleteExpense(e.id).then(() => { load(); onChanged?.() })}><Trash2 className="size-3.5" /></button>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
