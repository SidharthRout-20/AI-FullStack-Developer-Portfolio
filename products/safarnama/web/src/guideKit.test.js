import { CloudRain, Snowflake, Sun } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { costsById, dayCost, fitsLevel, inPlan, levelFor, lightestDay, rangeText, weatherIcon } from './guideKit'

describe('the trip guide helpers', () => {
  it('read a cost range the way people say it, always marked as an estimate', () => {
    expect(rangeText({ min: 1200, max: 2000 }, 'INR')).toBe('≈ ₹1.2k–2k')
    expect(rangeText({ min: 500, max: 500 }, 'INR', ' a person')).toBe('≈ ₹500 a person')
    expect(rangeText([0, 0], 'INR')).toBe('Free')
    expect(rangeText({ min: 0, max: 300 }, 'INR')).toBe('≈ ₹300')
  })

  it('add up what a day usually costs for the group, leaving meals to the food budget', () => {
    const costs = costsById({ stop_costs: [{ id: 'a', cost: { min: 100, max: 200 }, per: 'person' }, { id: 'b', cost: { min: 1500, max: 1500 }, per: 'group' }, { id: 'c', cost: { min: 0, max: 0 }, per: 'free' }, { id: 'm', cost: { min: 400, max: 600 }, per: 'person' }] })
    const day = { activities: [{ id: 'a', kind: 'outdoor' }, { id: 'b', kind: 'outdoor' }, { id: 'c', kind: 'indoor' }, { id: 'm', kind: 'food' }, { id: 'x', kind: 'outdoor' }] }
    expect(dayCost(day, costs, 3)).toEqual({ min: 1800, max: 2100 })
  })

  it('match mapped stays to a stay level, using stars only where they are mapped', () => {
    expect(fitsLevel({ category: 'guest house' }, 'budget')).toBe(true)
    expect(fitsLevel({ category: 'hotel', stars: 5 }, 'premium')).toBe(true)
    expect(fitsLevel({ category: 'hotel' }, 'premium')).toBe(false)
    expect(fitsLevel({ category: 'hotel' }, 'mid')).toBe(true)
  })

  it('know what is already planned, and suggest the lightest day for something new', () => {
    const trip = { days: [{ day: 1, activities: [{ name: 'Hadimba Temple' }, { name: 'Mall Road' }] }, { day: 2, activities: [{ name: 'Solang Valley' }] }] }
    expect(inPlan(trip, ' hadimba temple ')).toBe(true)
    expect(inPlan(trip, 'Jogini Falls')).toBe(false)
    const pinned = { days: [{ day: 1, activities: [{ name: 'Galtaji Temple (Monkey Temple)', lat: 26.9167, lng: 75.8584 }] }] }
    expect(inPlan(pinned, 'Galtaji (Monkey Temple)', { lat: 26.9172, lng: 75.8588 })).toBe(true) // ~70 m away
    expect(inPlan(pinned, 'Nahargarh Fort', { lat: 26.9374, lng: 75.8155 })).toBe(false)
    expect(lightestDay(trip)).toBe(2)
  })

  it('place a live price in a stay level from the guide’s room prices', () => {
    const tiers = { budget: { per_night: { min: 800, max: 2000 } }, mid: { per_night: { min: 3000, max: 6000 } }, premium: { per_night: { min: 9000, max: 15000 } } }
    expect(levelFor(1716, tiers)).toBe('budget')
    expect(levelFor(4500, tiers)).toBe('mid')
    expect(levelFor(7000, tiers)).toBe('premium')
    expect(levelFor(4500, {})).toBeNull()
  })

  it('show the weather as one icon', () => {
    expect(weatherIcon({ code: 0 })).toBe(Sun)
    expect(weatherIcon({ code: 63 })).toBe(CloudRain)
    expect(weatherIcon({ code: 73 })).toBe(Snowflake)
    expect(weatherIcon({ rain: 80 })).toBe(CloudRain)
    expect(weatherIcon(null)).toBeNull()
  })
})
