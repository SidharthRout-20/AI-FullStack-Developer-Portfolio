/**
 * Money, the way travellers think about it: how much is left, how much a day that leaves, and what the trip will
 * cost from your own numbers. Pure helpers (unit-tested in money.test.js).
 *
 * Safarnaama never invents prices: the cost planner only multiplies amounts the traveller types (a night's stay,
 * a day's food), and the allowance divides what's left of their own budget by the days that are left.
 */
import { localDate } from './logic'

const EURO = ['AT', 'BE', 'HR', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES']
const BY_REGION = { IN: 'INR', US: 'USD', GB: 'GBP', AE: 'AED', SG: 'SGD', AU: 'AUD', CA: 'CAD', JP: 'JPY', NZ: 'NZD', CH: 'CHF', NP: 'NPR', LK: 'LKR', BD: 'BDT', MY: 'MYR', TH: 'THB', ID: 'IDR', ...Object.fromEntries(EURO.map((r) => [r, 'EUR'])) }

/** The traveller's own currency, from their time zone and language (rupees for someone in India). null if unsure. */
export function homeCurrency({ timeZone, language } = {}) {
  const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  if (/^Asia\/(Kolkata|Calcutta)$/.test(tz ?? '')) return 'INR'
  try {
    const region = new Intl.Locale(language ?? navigator.language).maximize().region
    return BY_REGION[region] ?? null
  } catch {
    return null
  }
}

/** A currency symbol for an input prefix ("₹", "$", "€"…), or the code itself. */
export function symbolOf(currency) {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency
  } catch {
    return currency
  }
}

/** Whole amounts, no paise or cents: ₹40,000 rather than ₹40,000.00. */
export function wholeMoney(amount, currency) {
  if (amount == null || Number.isNaN(Number(amount))) return '—'
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
  } catch {
    return `${Math.round(amount)} ${currency}`
  }
}

/** Short money: ₹12.4k, ₹1.2L for rupees (how Indians say it), otherwise 12.4k / 1.2M. */
export function shortMoney(amount, currency) {
  if (amount == null || Number.isNaN(Number(amount))) return '—'
  const n = Math.abs(Number(amount))
  const sign = amount < 0 ? '−' : ''
  const sym = symbolOf(currency)
  const trim = (x) => String(Math.round(x * 10) / 10).replace(/\.0$/, '')
  if (currency === 'INR') {
    if (n >= 1e7) return `${sign}${sym}${trim(n / 1e7)}Cr`
    if (n >= 1e5) return `${sign}${sym}${trim(n / 1e5)}L`
  } else if (n >= 1e6) return `${sign}${sym}${trim(n / 1e6)}M`
  if (n >= 1e3) return `${sign}${sym}${trim(n / 1e3)}k`
  return `${sign}${sym}${Math.round(n)}`
}

/** Days of the trip still ahead, today included (all of them before it starts, none after it ends). */
export function daysLeft(trip, today = localDate()) {
  const dates = trip.days.map((d) => d.date).filter(Boolean)
  if (!dates.length) return trip.days.length
  const next = dates.findIndex((d) => d >= today)
  return next === -1 ? 0 : dates.length - next
}

/**
 * What the budget leaves: per day for the days ahead, and per person. `sum` is the server's budget summary.
 * Estimates (planned, not spent) are set aside first, so the daily figure is what's free to spend.
 */
export function allowance(sum, trip, today = localDate()) {
  if (!sum || sum.budget_total == null) return null
  const left = daysLeft(trip, today)
  const free = sum.remaining_after_estimates ?? sum.remaining
  const people = Math.max(1, Number(trip.party?.travellers) || 1)
  return {
    spentPct: sum.budget_total > 0 ? Math.min(100, Math.round((sum.actual_total / sum.budget_total) * 100)) : 0,
    left,
    free,
    perDay: left > 0 ? free / left : null,
    perPersonPerDay: left > 0 ? free / left / people : null,
    people,
    over: free < 0,
  }
}

/** Nights in the trip (the last day has no night). */
export const nightsOf = (trip) => Math.max(0, trip.days.length - 1)

/** The budget's categories in the order a traveller thinks about them ("other" is the buffer). */
export const PLAN_ROWS = [
  { id: 'lodging', label: 'Stay' },
  { id: 'transport', label: 'Getting there and around' },
  { id: 'food', label: 'Food' },
  { id: 'activities', label: 'Things to do' },
  { id: 'shopping', label: 'Shopping' },
  { id: 'other', label: 'Buffer' },
]

/**
 * The budget plan: each category's share of the budget (the server's suggested split, or the traveller's own), what's
 * spent and booked against it, and what it means in everyday terms (a night's stay, a person's food for a day).
 * `sum` is the server's budget summary. Returns null without a budget.
 */
export function budgetPlan(trip, sum) {
  if (!sum || sum.budget_total == null) return null
  const people = Math.max(1, Number(trip.party?.travellers) || 1)
  const days = Math.max(1, trip.days.length)
  const nights = nightsOf(trip)
  const rows = PLAN_ROWS.map((r) => {
    const c = sum.by_category?.[r.id] ?? { budget: 0, actual: 0, estimated: 0 }
    const used = c.actual + c.estimated
    const each = r.id === 'lodging' ? (nights ? c.budget / nights : null) : r.id === 'food' ? c.budget / days / people : null
    return { ...r, planned: c.budget, spent: c.actual, booked: c.estimated, left: c.budget - used, each, over: used > c.budget && c.budget > 0 }
  })
  return { rows, set: rows.some((r) => r.planned > 0), people, days, nights, perNight: rows[0].each, foodPerPersonDay: rows[2].each }
}
