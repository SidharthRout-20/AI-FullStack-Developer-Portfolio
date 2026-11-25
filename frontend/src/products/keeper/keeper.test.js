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
    expect(afterWake('I was talking to Tara yesterday')).toBeNull() // the name alone isn't a wake-up
    expect(afterWake('what a day')).toBeNull()
  })
})

describe('"Hey Tara" listener (simulated speech recogniser)', () => {
  const setup = async () => {
    const { startWakeListener } = await import('./voice')
    const made = []
    class FakeRec {
      constructor() {
        made.push(this)
      }
      start() {
        this.started = true
        this.onstart?.()
      }
      abort() {
        this.aborted = true
      }
    }
    const timers = []
    const woke = []
    const states = []
    const stop = startWakeListener(FakeRec, {
      onWake: (rest) => woke.push(rest),
      onState: (s) => states.push(s),
      schedule: (fn) => timers.push(fn),
      cancel: () => {},
    })
    const say = (text, isFinal) => made.at(-1).onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] })
    const runTimers = () => timers.splice(0).forEach((fn) => fn())
    return { made, woke, states, stop, say, runTimers }
  }

  it('answers "Hey Tara" on its own, even if the browser never finalises the sentence', async () => {
    const t = await setup()
    expect(t.states).toEqual(['listening'])
    t.say('hey Tara', false)
    expect(t.woke).toEqual([]) // waits a moment for the rest…
    t.runTimers()
    expect(t.woke).toEqual(['']) // …then answers
    expect(t.made.at(-1).aborted).toBe(true)
  })

  it('takes a request said in the same breath', async () => {
    const t = await setup()
    t.say("Hey Tara, what's the weather today", false) // 3+ words after the phrase: no need to wait
    expect(t.woke).toEqual(["what's the weather today"])
  })

  it('ignores other speech and keeps listening when the browser ends the session', async () => {
    const t = await setup()
    t.say('I was talking to Tara yesterday', true)
    t.made.at(-1).onend()
    t.runTimers()
    expect(t.woke).toEqual([])
    expect(t.made).toHaveLength(2) // restarted
    t.say('hetara', true) // glued together, as some recognisers write it
    expect(t.woke).toEqual([''])
  })

  it('says so when the microphone is blocked, instead of silently doing nothing', async () => {
    const t = await setup()
    t.made.at(-1).onerror({ error: 'not-allowed' })
    t.made.at(-1).onend()
    t.runTimers()
    expect(t.states.at(-1)).toBe('blocked')
    expect(t.made).toHaveLength(1) // no restart loop
  })
})
