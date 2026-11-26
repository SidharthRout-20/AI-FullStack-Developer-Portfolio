import { describe, expect, it } from 'vitest'
import { fuzzyScore } from '../../site/CommandPalette'
import { resolveTheme, themeForTime } from '../../theme/theme'
import { daysUntil, localISO, MODULES, subtitle, urgency } from './modules'

const at = (h, m = 0) => new Date(2026, 10, 10, h, m)

describe('theme by local time', () => {
  it('is light from 07:00 to 18:59 and dark otherwise', () => {
    expect(themeForTime(at(6, 59))).toBe('dark')
    expect(themeForTime(at(7))).toBe('light')
    expect(themeForTime(at(18, 59))).toBe('light')
    expect(themeForTime(at(19))).toBe('dark')
    expect(themeForTime(at(0, 30))).toBe('dark')
  })
  it('explicit choices override the clock', () => {
    expect(resolveTheme('dark', at(12))).toBe('dark')
    expect(resolveTheme('light', at(23))).toBe('light')
    expect(resolveTheme('auto', at(12))).toBe('light')
  })
})

describe('command palette search', () => {
  it('ranks prefix > word start > substring > subsequence', () => {
    expect(fuzzyScore('kee', 'Keeper')).toBeGreaterThan(fuzzyScore('the', 'Dark theme'))
    expect(fuzzyScore('theme', 'Dark theme')).toBeGreaterThan(fuzzyScore('eme', 'Dark theme'))
    expect(fuzzyScore('kpr', 'Keeper')).toBe(1)
    expect(fuzzyScore('xyz', 'Keeper')).toBe(0)
  })
})

const entry = (over) => ({
  id: 'x',
  kind: 'stash',
  title: 'T',
  place: null,
  person: null,
  note: null,
  photo_id: null,
  lat: null,
  lng: null,
  due: null,
  due_time: null,
  status: 'active',
  data: {},
  created_at: '',
  updated_at: '',
  ...over,
})

describe('keeper modules', () => {
  it('covers the 10 chores', () => {
    expect(MODULES).toHaveLength(10)
    expect(new Set(MODULES.map((m) => m.id)).size).toBe(10)
  })

  it('computes urgency with a 30-day window for expiries and 7 days otherwise', () => {
    const today = localISO()
    const plus = (n) => localISO(new Date(Date.now() + n * 86_400_000))
    expect(daysUntil(plus(3), today)).toBe(3)
    expect(urgency(entry({ kind: 'expiry', due: plus(20) }))).toBe('soon')
    expect(urgency(entry({ kind: 'bill', due: plus(20) }))).toBe('later')
    expect(urgency(entry({ kind: 'loan', due: plus(-1) }))).toBe('overdue')
    expect(urgency(entry({ kind: 'care', due: today }))).toBe('today')
    expect(urgency(entry({ kind: 'stash', due: today }))).toBe('none')
  })

  it('describes entries per kind', () => {
    expect(subtitle(entry({ kind: 'loan', person: 'Raj', data: { direction: 'lent' } }))).toBe('Lent to Raj')
    expect(subtitle(entry({ kind: 'bill', data: { amount: 649, currency: '₹', recurring: 'monthly', subscription: true } }))).toBe(
      '₹649 · monthly · subscription',
    )
    expect(subtitle(entry({ kind: 'care', data: { subject: 'medicine', times: ['09:00', '21:00'] } }))).toBe(
      'medicine · 09:00, 21:00',
    )
  })
})

describe('Tara with an older server', () => {
  it('asks again without the conversation history when the server rejects it', async () => {
    const { keeperApi } = await import('./api')
    const bodies = []
    const real = globalThis.fetch
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return bodies.length === 1
        ? new Response(JSON.stringify({ detail: [{ type: 'extra_forbidden' }] }), { status: 422 })
        : new Response(JSON.stringify({ reply: 'Saved.', action: 'add' }), { status: 200 })
    }
    try {
      const res = await keeperApi.command('passport, top drawer', { history: [{ role: 'user', text: 'hi' }], prefs: { name: 'Sid', tone: 'warm', length: 'short' } })
      expect(res.reply).toBe('Saved.')
      expect(bodies[0].history).toHaveLength(1)
      expect(bodies[1]).toEqual({ text: 'passport, top drawer' })
    } finally {
      globalThis.fetch = real
    }
  })
})

describe('"Hey Tara"', () => {
  it('hears the wake phrase the ways recognisers write it, and keeps what follows', async () => {
    const { afterWake } = await import('./voice')
    expect(afterWake('hey Tara')).toBe('')
    expect(afterWake("Hey Tara, what's the weather?")).toBe("what's the weather?")
    expect(afterWake('ok tarah set a timer for 5 minutes')).toBe('set a timer for 5 minutes')
    expect(afterWake('hey terra')).toBe('')
    expect(afterWake('hey there what time is it')).toBe('what time is it') // a common mishearing of "Hey Tara"
    expect(afterWake('Hey Tyra, play some music')).toBe('play some music')
    expect(afterWake('I was talking to Tara yesterday')).toBeNull() // the name alone isn't a wake-up
    expect(afterWake('what a day')).toBeNull()
  })
})

describe('Tara listening (simulated speech recogniser)', () => {
  const setup = async (opts = {}) => {
    const { startVoice } = await import('./voice')
    const made = []
    class FakeRec {
      constructor() {
        made.push(this)
      }
      start() {
        this.onstart?.()
      }
      abort() {
        this.aborted = true
      }
    }
    let n = 0
    const timers = new Map() // id -> { fn, ms }
    const out = { woke: 0, done: [], interim: [], states: [] }
    const session = startVoice(FakeRec, {
      mode: 'wake',
      onWake: () => (out.woke += 1),
      onDone: (text, reason) => out.done.push([text, reason]),
      onInterim: (t) => out.interim.push(t),
      onState: (s) => out.states.push(s),
      schedule: (fn, ms) => (timers.set(++n, { fn, ms }), n),
      cancel: (id) => timers.delete(id),
      ...opts,
    })
    // What the recogniser has heard in this session so far (each string is one result).
    const hear = (...parts) => made.at(-1).onresult({ resultIndex: 0, results: parts.map((t) => Object.assign([{ transcript: t }], { isFinal: false })) })
    const delays = () => [...timers.values()].map((t) => t.ms)
    const run = (ms) => [...timers].filter(([, t]) => t.ms === ms).forEach(([id, t]) => (timers.delete(id), t.fn()))
    return { made, out, session, hear, delays, run }
  }

  it('wakes on "Hey Tara" and takes the request that follows in the same breath', async () => {
    const { END_MS } = await import('./voice')
    const t = await setup()
    t.hear('hey Tara')
    expect(t.out.woke).toBe(1)
    t.hear('hey Tara', "what's the weather today")
    expect(t.out.interim.at(-1)).toBe("what's the weather today")
    t.run(END_MS) // the speaker paused
    expect(t.out.done).toEqual([["what's the weather today", 'heard']])
    expect(t.made.at(-1).aborted).toBe(true)
  })

  it('waits longer when the sentence sounds unfinished, so a pause doesn\'t cut you off', async () => {
    const { END_MS, HOLD_MS } = await import('./voice')
    const t = await setup({ mode: 'command' })
    t.hear('remind me to call mom and')
    expect(t.delays()).toContain(HOLD_MS)
    t.run(END_MS)
    expect(t.out.done).toEqual([]) // not yet
    t.hear('remind me to call mom and', 'pick up the cake at six')
    t.run(HOLD_MS) // the old, longer wait was replaced
    t.run(END_MS)
    expect(t.out.done).toEqual([['remind me to call mom and pick up the cake at six', 'heard']])
  })

  it('keeps what was said when the browser ends the session mid-request', async () => {
    const { END_MS } = await import('./voice')
    const t = await setup({ mode: 'command' })
    t.hear('add milk eggs')
    t.made.at(-1).onend() // browsers end sessions on their own
    t.run(250) // restart
    expect(t.made).toHaveLength(2)
    t.hear('and bread to the shopping list')
    t.run(END_MS)
    expect(t.out.done).toEqual([['add milk eggs and bread to the shopping list', 'heard']])
  })

  it('answers to "Tara, …" said first, but ignores the name in passing', async () => {
    const t = await setup()
    t.hear('I was talking to Tara yesterday')
    expect(t.out.woke).toBe(0)
    const u = await setup()
    u.hear('Tara what time is it')
    expect(u.out.woke).toBe(1)
    expect(u.out.interim.at(-1)).toBe('what time is it')
  })

  it('gives up quietly when nobody speaks, and says so when the microphone is blocked', async () => {
    const { FOLLOW_UP_MS } = await import('./voice')
    const t = await setup({ mode: 'command', noSpeechMs: FOLLOW_UP_MS })
    t.run(FOLLOW_UP_MS)
    expect(t.out.done).toEqual([['', 'silence']])
    const b = await setup()
    b.made.at(-1).onerror({ error: 'not-allowed' })
    expect(b.out.done).toEqual([['', 'blocked']])
    expect(b.out.states.at(-1)).toBe('blocked')
    expect(b.made).toHaveLength(1) // no restart loop
  })

  it('drops a request that was cancelled', async () => {
    const t = await setup({ mode: 'command' })
    t.hear('play some music')
    t.session.stop()
    expect(t.out.done).toEqual([])
  })

  it('knows a goodbye from a request', async () => {
    const { isGoodbye } = await import('./voice')
    for (const s of ["that's all", 'Thanks, that’s all', 'no thanks', 'stop', 'never mind']) expect(isGoodbye(s.replace('’', "'"))).toBe(true)
    for (const s of ['stop the timer', 'no I meant Pune', 'thanks for the weather, now the news']) expect(isGoodbye(s)).toBe(false)
  })
})
