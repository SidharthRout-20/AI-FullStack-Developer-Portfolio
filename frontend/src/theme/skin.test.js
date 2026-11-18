import { describe, expect, it } from 'vitest'
import { DAY_PHASES, dayPhase, DEFAULT_SKIN, greeting, isSkin, SKIN_NAMES, SKINS, themeColor, timeIn } from './skin'

describe('site skins', () => {
  it('has exactly the Studio and Off the clock, landing visitors in the Studio', () => {
    expect(SKINS).toEqual(['showcase', 'personal'])
    expect(DEFAULT_SKIN).toBe('showcase')
    expect(SKIN_NAMES.showcase.name).toBe('Studio')
    expect(SKIN_NAMES.personal.name).toBe('Off the clock')
    expect(isSkin('showcase')).toBe(true)
    expect(isSkin('apple')).toBe(false)
    expect(isSkin(null)).toBe(false)
  })

  it('matches the browser chrome colour to each skin and theme', () => {
    expect(themeColor('dark', 'personal')).toBe('#0b0d14')
    expect(themeColor('light', 'personal')).toBe('#f4f5f9')
    expect(themeColor('light', 'showcase')).toBe('#f5f5f7')
    expect(themeColor('dark', 'showcase')).toBe('#000000')
  })
})

describe('personal space: time of day', () => {
  it('lights the backdrop by the visitor’s hour', () => {
    expect([4, 5, 8, 9, 16, 17, 19, 20, 23, 0].map(dayPhase)).toEqual([
      'night', 'dawn', 'dawn', 'day', 'day', 'dusk', 'dusk', 'night', 'night', 'night',
    ])
    for (const p of Object.values(DAY_PHASES)) expect(p.blobs).toHaveLength(3)
  })

  it('greets by hour', () => {
    expect(greeting(6)).toBe('Good morning')
    expect(greeting(13)).toBe('Good afternoon')
    expect(greeting(19)).toBe('Good evening')
    expect(greeting(2)).toBe('Up late')
  })

  it('shows the owner’s local time in their time zone', () => {
    const at = new Date('2026-11-17T15:41:00Z') // 21:11 in India (UTC+5:30)
    expect(timeIn('Asia/Kolkata', at)).toEqual({ text: '9:11 pm', hour: 21 })
    expect(timeIn('Not/AZone', at)).toBeNull()
  })
})
