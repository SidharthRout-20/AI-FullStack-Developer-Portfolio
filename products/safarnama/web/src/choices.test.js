import { describe, expect, it } from 'vitest'
import { composePrompt, customDestination, DESTINATIONS, isoDate, PARTIES, REQUESTS, suggestDestinations, whenOptions } from './choices'

const goa = DESTINATIONS.find((d) => d.name === 'Goa')
const wed = new Date(2026, 10, 18) // Wednesday 18 Nov 2026

describe('Safarnaama quick planner: where', () => {
  it('suggests six different destinations, in-season ones first', () => {
    const picks = suggestDestinations(11, 7)
    expect(picks).toHaveLength(6)
    expect(new Set(picks.map((d) => d.name)).size).toBe(6)
    expect(picks.every((d) => d.months.includes(11) || d.months.includes(12))).toBe(true)
    expect(picks.some((d) => d.name === 'Leh')).toBe(false) // a summer place, not in November
  })

  it('shows other options for another seed, and the same ones for the same seed', () => {
    expect(suggestDestinations(11, 7).map((d) => d.name)).toEqual(suggestDestinations(11, 7).map((d) => d.name))
    expect(suggestDestinations(11, 8).map((d) => d.name)).not.toEqual(suggestDestinations(11, 7).map((d) => d.name))
  })

  it('accepts a destination typed by hand', () => {
    expect(customDestination('Shillong, India')).toMatchObject({ name: 'Shillong', country: 'India', days: 3 })
    expect(customDestination(' x ')).toBeNull()
  })

  it('keeps the pool honest: no duplicates, sensible stays', () => {
    expect(new Set(DESTINATIONS.map((d) => d.name)).size).toBe(DESTINATIONS.length)
    for (const d of DESTINATIONS) {
      expect(d.days).toBeGreaterThanOrEqual(2)
      expect(d.days).toBeLessThanOrEqual(14)
      expect(d.months.length).toBeGreaterThan(0)
    }
  })
})

describe('Safarnaama quick planner: when', () => {
  it('offers this weekend, next week, two weeks out and next month, as real dates', () => {
    const opts = whenOptions(wed, 4)
    expect(opts.map((o) => o.id)).toEqual(['weekend', 'next-week', 'in-two-weeks', 'next-month'])
    expect(isoDate(opts[0].start)).toBe('2026-11-21') // Saturday
    expect(opts[0].days).toBe(2)
    expect(isoDate(opts[1].start)).toBe('2026-11-23') // Monday
    expect(opts[1].days).toBe(4)
    expect(isoDate(opts[2].start)).toBe('2026-11-30')
    expect(isoDate(opts[3].start)).toBe('2026-12-05') // first Saturday of December
    expect(opts[3].label).toBe('December')
    expect(opts[0].range).toBe('Sat 21 – Sun 22 Nov')
  })

  it('never offers today: on a Saturday, "this weekend" is the next one', () => {
    expect(isoDate(whenOptions(new Date(2026, 10, 21), 3)[0].start)).toBe('2026-11-28')
  })
})

describe('Safarnaama quick planner: the request', () => {
  it('spells out dates, party, interests, pace and requests for the planner', () => {
    const [, nextWeek] = whenOptions(wed, goa.days)
    const prompt = composePrompt({ dest: goa, when: nextWeek, party: 'couple', interests: ['beaches', 'food'], requests: ['veg', 'slow'] })
    expect(prompt).toBe(
      '4 days in Goa, India, from 2026-11-23 to 2026-11-26, for a couple (2 travellers). Interests: beaches, local food. ' +
        'Pace: relaxed. Special requests: vegetarian food only; no early starts.',
    )
    expect(prompt.length).toBeGreaterThanOrEqual(10)
  })

  it('keeps family trips kid-friendly and caps the free-text note', () => {
    const [weekend] = whenOptions(wed, 3)
    const prompt = composePrompt({ dest: { name: 'Singapore', country: 'Singapore' }, when: weekend, party: 'family', note: 'x'.repeat(2000) })
    expect(prompt).toMatch(/^2 days in Singapore, from 2026-11-21 to 2026-11-22, for a family with kids/)
    expect(prompt).toContain('Keep it kid-friendly.')
    expect(prompt.length).toBeLessThanOrEqual(1000)
  })

  it('takes four taps at most: place, dates, party, plan (interests come pre-selected)', () => {
    expect(PARTIES).toHaveLength(4)
    expect(REQUESTS.every((r) => r.label && r.text)).toBe(true)
  })
})
