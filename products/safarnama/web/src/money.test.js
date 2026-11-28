import { describe, expect, it } from 'vitest'
import { allowance, budgetPlan, daysLeft, homeCurrency, shortMoney } from './money'

const trip = { days: [{ date: '2026-12-05' }, { date: '2026-12-06' }, { date: '2026-12-07' }, { date: '2026-12-08' }], party: { travellers: 2 } }

describe('money, the way travellers think about it', () => {
  it('uses rupees for someone in India, whatever the language', () => {
    expect(homeCurrency({ timeZone: 'Asia/Kolkata', language: 'en-US' })).toBe('INR')
    expect(homeCurrency({ timeZone: 'Europe/London', language: 'en-GB' })).toBe('GBP')
    expect(homeCurrency({ timeZone: 'Europe/Paris', language: 'fr-FR' })).toBe('EUR')
  })

  it('says big rupee amounts in lakh', () => {
    expect(shortMoney(150000, 'INR')).toBe('₹1.5L')
    expect(shortMoney(12400, 'INR')).toBe('₹12.4k')
    expect(shortMoney(800, 'INR')).toBe('₹800')
    expect(shortMoney(-2500, 'INR')).toBe('−₹2.5k')
  })

  it('counts the days still ahead', () => {
    expect(daysLeft(trip, '2026-12-01')).toBe(4) // before it starts: all of them
    expect(daysLeft(trip, '2026-12-07')).toBe(2) // today and tomorrow
    expect(daysLeft(trip, '2026-12-09')).toBe(0) // over
    expect(daysLeft({ days: [{}, {}, {}] })).toBe(3) // undated
  })

  it('turns what is left into a daily allowance, estimates set aside first', () => {
    const sum = { budget_total: 40000, actual_total: 10000, remaining: 30000, remaining_after_estimates: 20000 }
    const a = allowance(sum, trip, '2026-12-07')
    expect(a).toMatchObject({ spentPct: 25, left: 2, free: 20000, perDay: 10000, perPersonPerDay: 5000, over: false })
    expect(allowance({ ...sum, budget_total: null }, trip)).toBeNull()
    expect(allowance({ ...sum, remaining_after_estimates: -500 }, trip, '2026-12-07').over).toBe(true)
  })

  it('reads the budget plan in everyday terms: a night’s stay and a person’s food for a day', () => {
    const cat = (budget, actual = 0, estimated = 0) => ({ budget, actual, estimated })
    const sum = { budget_total: 40000, by_category: { lodging: cat(14000, 3000, 9000), transport: cat(10000), food: cat(8000, 9000), activities: cat(4000), shopping: cat(2000), other: cat(2000) } }
    const plan = budgetPlan(trip, sum)
    const by = Object.fromEntries(plan.rows.map((r) => [r.id, r]))
    expect(plan.perNight).toBeCloseTo(14000 / 3) // 4 days = 3 nights
    expect(plan.foodPerPersonDay).toBe(1000) // 8,000 over 4 days for 2 people
    expect(by.lodging).toMatchObject({ spent: 3000, booked: 9000, left: 2000, over: false })
    expect(by.food).toMatchObject({ left: -1000, over: true })
    expect(plan.set).toBe(true)
    expect(budgetPlan(trip, { budget_total: null })).toBeNull()
    expect(budgetPlan(trip, { budget_total: 5000, by_category: {} }).set).toBe(false) // a budget with no split yet
  })
})
