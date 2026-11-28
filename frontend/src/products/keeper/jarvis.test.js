import { beforeEach, describe, expect, it } from 'vitest'
import { resolveStyle, styleForWeather } from './ambient'
import { _reset, newChat, openChat, ownerFor, removeChat, saveChat, setChatOwner, slim, titleOf, turnsOf, MAX_CHATS } from './chats'
import { sceneOf } from './Sky'

// Tests run in Node: a small in-memory localStorage (the store only uses getItem / setItem).
const mem = new Map()
globalThis.localStorage ??= { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), clear: () => mem.clear() }

describe('conversations', () => {
  beforeEach(() => {
    localStorage.clear()
    _reset()
  })

  it('keeps a conversation once it has something in it, titled by the first question', () => {
    newChat()
    saveChat('a', [])
    expect(turnsOf('a')).toEqual([])
    saveChat('a', [{ id: '1', role: 'user', text: 'Plan a relaxed weekend in Goa' }, { id: '2', role: 'assistant', text: 'Sure.', entries: [{ id: 'x' }], saved: true }])
    expect(turnsOf('a')).toHaveLength(2)
    expect(turnsOf('a')[1]).toEqual({ id: '2', role: 'assistant', text: 'Sure.' }) // no undo handles or saved payloads
    expect(titleOf(turnsOf('a'))).toBe('Plan a relaxed weekend in Goa')
  })

  it('reopens and deletes conversations, and caps how many are kept', () => {
    for (let i = 0; i < MAX_CHATS + 5; i++) saveChat(`c${i}`, [{ id: 'u', role: 'user', text: `q${i}` }])
    expect(turnsOf('c0')).toEqual([]) // the oldest fell off
    openChat('c30')
    removeChat('c30')
    expect(turnsOf('c30')).toEqual([])
  })

  it('keeps each signed-in person’s conversations apart on a shared browser', () => {
    setChatOwner(ownerFor('a@example.com'))
    saveChat('mine', [{ id: 'u', role: 'user', text: 'my question' }])
    setChatOwner(ownerFor('b@example.com'))
    expect(turnsOf('mine')).toEqual([])
    setChatOwner(ownerFor('A@Example.com '))
    expect(turnsOf('mine')).toHaveLength(1)
    expect(ownerFor('a@example.com')).not.toContain('example') // the email itself never becomes a storage key
  })

  it('trims very long turns', () => {
    expect(slim({ id: '1', role: 'user', text: 'x'.repeat(5000) }).text).toHaveLength(2000)
  })
})

describe('the sky and the music follow the weather', () => {
  it('reads WMO weather codes', () => {
    expect([0, 2, 45, 53, 63, 81, 73, 95, null].map(sceneOf)).toEqual(['clear', 'cloudy', 'fog', 'drizzle', 'rain', 'rain', 'snow', 'storm', 'clear'])
  })
  it('plays rain when it rains and a night sky after dark', () => {
    expect(styleForWeather('rain', 'day')).toBe('rain')
    expect(styleForWeather('storm', 'night')).toBe('rain')
    expect(styleForWeather('clear', 'night')).toBe('night')
    expect(styleForWeather('clear', 'day')).toBe('piano')
    expect(resolveStyle('ocean', 'rain', 'day')).toBe('ocean') // a chosen sound wins
  })
})
