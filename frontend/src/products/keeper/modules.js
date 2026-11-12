import {
  Bell,
  CalendarHeart,
  Car,
  HandCoins,
  Package,
  ReceiptText,
  ShieldAlert,
  ShoppingBasket,
  Sun,
  Wrench,
} from 'lucide-react'

/** The 10 chores: 9 entry kinds + the Today view (agenda & daily brief). */
export const MODULES = [
  { id: 'today', label: 'Today', icon: Sun, tint: 'text-amber-300 bg-amber-500/10', example: "what's due?" },
  { id: 'stash', label: 'Stash', icon: Package, tint: 'text-indigo-300 bg-indigo-500/10', example: 'passport, top drawer of the bedroom cupboard', doneLabel: 'Found it' },
  { id: 'parking', label: 'Parking', icon: Car, tint: 'text-sky-300 bg-sky-500/10', example: 'I parked at level B2, pillar 14', doneLabel: 'Picked up' },
  { id: 'loan', label: 'Lend & borrow', icon: HandCoins, tint: 'text-teal-300 bg-teal-500/10', example: 'lent my drill to Raj', doneLabel: 'Returned' },
  { id: 'expiry', label: 'Expiry radar', icon: ShieldAlert, tint: 'text-rose-300 bg-rose-500/10', example: 'car insurance expires 12/03/2027', doneLabel: 'Renewed' },
  { id: 'bill', label: 'Bills & subs', icon: ReceiptText, tint: 'text-violet-300 bg-violet-500/10', example: 'Netflix ₹649 monthly on the 2nd', doneLabel: 'Paid' },
  { id: 'occasion', label: 'Occasions', icon: CalendarHeart, tint: 'text-pink-300 bg-pink-500/10', example: "Mom's birthday is 14 March", doneLabel: 'Celebrated' },
  { id: 'appliance', label: 'Appliances', icon: Wrench, tint: 'text-orange-300 bg-orange-500/10', example: 'AC filter needs cleaning every 3 months', doneLabel: 'Serviced' },
  { id: 'pantry', label: 'Pantry', icon: ShoppingBasket, tint: 'text-emerald-300 bg-emerald-500/10', example: "we're out of milk and eggs", doneLabel: 'Bought' },
  { id: 'care', label: 'Care & reminders', icon: Bell, tint: 'text-cyan-300 bg-cyan-500/10', example: 'take vitamin D at 9am daily', doneLabel: 'Done' },
]

export const moduleOf = (id) => MODULES.find((m) => m.id === id)

const DAY = 86_400_000

/** Local calendar date as YYYY-MM-DD (not UTC: 'today' must match the user's wall clock). */
export function localISO(d = new Date()) {
  const off = d.getTimezoneOffset() * 60_000
  return new Date(d.getTime() - off).toISOString().slice(0, 10)
}

export function daysUntil(iso, today = localISO()) {
  return Math.round((Date.parse(iso) - Date.parse(today)) / DAY)
}

export function relativeDay(iso) {
  if (!iso) return 'No date'
  const n = daysUntil(iso)
  if (n === 0) return 'Today'
  if (n === 1) return 'Tomorrow'
  if (n === -1) return 'Yesterday'
  if (n < 0) return `${-n} days ago`
  if (n < 45) return `in ${n} days`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function urgency(e) {
  if (!e.due || e.kind === 'stash' || e.kind === 'parking' || e.kind === 'pantry') return 'none'
  const n = daysUntil(e.due)
  const window = e.kind === 'expiry' ? 30 : 7
  return n < 0 ? 'overdue' : n === 0 ? 'today' : n <= window ? 'soon' : 'later'
}

export const URGENCY_STYLE = {
  overdue: 'text-rose-300 bg-rose-500/10 ring-rose-400/25',
  today: 'text-amber-300 bg-amber-500/10 ring-amber-400/25',
  soon: 'text-sky-300 bg-sky-500/10 ring-sky-400/25',
  later: 'text-ink-300 bg-white/[0.04] ring-white/10',
  none: 'text-ink-300 bg-white/[0.04] ring-white/10',
}

/** One short line of kind-specific detail under an entry's title. */
export function subtitle(e) {
  const d = e.data
  switch (e.kind) {
    case 'stash':
      return e.place ?? 'No place saved'
    case 'parking':
      return [e.place, e.lat ? 'map pin' : null].filter(Boolean).join(' · ') || 'Map pin'
    case 'loan':
      return d.direction === 'borrowed' ? `Borrowed from ${e.person ?? 'someone'}` : `Lent to ${e.person ?? 'someone'}`
    case 'expiry':
      return `${String(d.category ?? 'document')} · expires ${e.due ?? 'date unknown'}`
    case 'bill': {
      const amount = typeof d.amount === 'number' ? `${d.currency ?? ''}${d.amount.toLocaleString()}` : null
      const rec = d.recurring && d.recurring !== 'none' ? String(d.recurring) : 'one-off'
      return [amount, rec, d.subscription ? 'subscription' : null].filter(Boolean).join(' · ')
    }
    case 'occasion': {
      const ideas = Array.isArray(d.gift_ideas) ? d.gift_ideas.length : 0
      return [e.person, ideas ? `${ideas} gift idea${ideas > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ') || 'Occasion'
    }
    case 'appliance':
      return `Every ${d.every_months ?? 6} months${d.last_service ? ` · last ${String(d.last_service)}` : ''}`
    case 'pantry':
      return d.state === 'need' ? 'On the shopping list' : 'In stock'
    case 'care': {
      const times = Array.isArray(d.times) && d.times.length ? d.times.join(', ') : null
      const every = d.every_days ? `every ${String(d.every_days)} day(s)` : null
      return [String(d.subject ?? 'reminder'), times ?? every ?? (e.due_time ? `at ${e.due_time}` : 'one-off')].join(' · ')
    }
  }
}
