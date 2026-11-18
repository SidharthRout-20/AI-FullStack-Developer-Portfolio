import { describe, expect, it } from 'vitest'
import { cleanCitations, linkCitations } from './citations'
import { dayBucket, deleteSession, upsertSession } from './sessions'
import { completedTurns, initialState, reducer, selectRun } from '../hooks/useChat'
import { layoutGraph } from './layout'
import { createSSEParser } from '@appcore/web/sse'

describe('createSSEParser', () => {
  it('reassembles events split across network chunks', () => {
    const events = []
    const feed = createSSEParser((e) => events.push(e))
    feed('event: token\ndata: {"te')
    feed('xt":"Hel"}\n\nevent: token\r\ndata: {"text":"lo"}\r\n\r\n')
    feed('event: done\ndata: {"route":"answered","answer":"Hello"}\n\n')
    expect(events).toEqual([
      { event: 'token', text: 'Hel' },
      { event: 'token', text: 'lo' },
      { event: 'done', route: 'answered', answer: 'Hello' },
    ])
  })

  it('skips malformed frames', () => {
    const events = []
    createSSEParser((e) => events.push(e))('event: token\ndata: {oops\n\n')
    expect(events).toHaveLength(0)
  })
})

const topo = {
  nodes: ['__start__', 'guard', 'rewrite', 'refuse', 'retrieve', 'grade', 'generate', 'general', '__end__'].map(
    (id) => ({ id, label: id, description: '' }),
  ),
  edges: [
    ['__start__', 'guard', false],
    ['guard', 'rewrite', true],
    ['guard', 'refuse', true],
    ['rewrite', 'retrieve', false],
    ['retrieve', 'grade', false],
    ['grade', 'generate', true],
    ['grade', 'general', true],
    ['generate', '__end__', false],
    ['general', '__end__', false],
    ['refuse', '__end__', false],
  ].map(([source, target, conditional]) => ({ source: String(source), target: String(target), conditional: !!conditional })),
}

describe('layoutGraph (left → right)', () => {
  const pos = Object.fromEntries(layoutGraph(topo).map((p) => [p.id, p]))

  it('places columns by longest path from start', () => {
    expect(pos.__start__.x).toBe(0)
    expect(pos.retrieve.x).toBeGreaterThan(pos.rewrite.x)
    expect(pos.__end__.x).toBeGreaterThan(pos.generate.x)
  })

  it('keeps the happy path on the centre lane and puts branches above / below', () => {
    for (const id of ['__start__', 'guard', 'rewrite', 'retrieve', 'grade', 'generate', '__end__']) expect(pos[id].y).toBe(0)
    expect(pos.refuse.y).toBeLessThan(0)
    expect(pos.general.y).toBeGreaterThan(0)
  })
})

describe('chat reducer', () => {
  const all = topo.nodes.map((n) => n.id)
  const submitted = reducer(initialState, {
    type: 'submit',
    user: { id: 'u', role: 'user', content: 'hi', status: 'done' },
    assistant: { id: 'a', role: 'assistant', content: '', status: 'streaming' },
    now: 1000,
  })
  const ev = (state, e, now = 1000) =>
    reducer(state, { type: 'event', id: 'a', ev: e, allNodes: all, now })

  it('tracks node progress with client timings, TTFT and skipped branches', () => {
    let s = ev(submitted, { event: 'node', node: 'guard', status: 'start' }, 1010)
    expect(s.workflow.nodes.guard).toMatchObject({ status: 'active', startedAt: 10 })
    s = ev(s, { event: 'node', node: 'guard', status: 'end', ms: 1 }, 1012)
    s = ev(s, { event: 'token', text: 'Hel' }, 1100)
    s = ev(s, { event: 'token', text: 'lo' }, 1150)
    expect(s.messages[1]?.content).toBe('Hello')
    expect(s.workflow.firstTokenAt).toBe(100)
    s = ev(s, { event: 'done', route: 'answered', answer: 'Hello' }, 1200)

    expect(s.workflow).toMatchObject({ running: false, totalMs: 200 })
    expect(s.workflow.path).toEqual(['__start__', 'guard', '__end__'])
    expect(s.workflow.nodes.refuse?.status).toBe('skipped')
    expect(s.messages[1]).toMatchObject({ status: 'done', route: 'answered' })
  })

  it('snapshots each run onto its answer so past runs can be replayed', () => {
    const done = ev(submitted, { event: 'done', route: 'general', answer: 'x' }, 1300)
    expect(done.messages[1]?.run?.totalMs).toBe(300)
    expect(done.selectedId).toBe('a')
    expect(selectRun(done)).toBe(done.messages[1]?.run)
  })

  it('surfaces server errors on the message', () => {
    const s = ev(submitted, { event: 'error', message: 'boom' })
    expect(s.messages[1]).toMatchObject({ status: 'error', error: 'boom' })
  })
})

describe('completedTurns', () => {
  it('drops questions whose answer failed or is still streaming', () => {
    const m = (id, role, status) => ({
      id,
      role,
      status,
      content: id,
    })
    const turns = completedTurns([
      m('q1', 'user', 'done'),
      m('a1', 'assistant', 'error'),
      m('q2', 'user', 'done'),
      m('a2', 'assistant', 'done'),
      m('q3', 'user', 'done'),
      m('a3', 'assistant', 'streaming'),
    ])
    expect(turns.map((t) => t.id)).toEqual(['q2', 'a2'])
  })
})

describe('linkCitations', () => {
  it('links [n] and normalises gpt-oss style citations', () => {
    expect(linkCitations('a [1] b【2】 c【3†L4-L7】 d [x](http://e)')).toBe(
      'a [1](#cite-1) b[2](#cite-2) c[3](#cite-3) d [x](http://e)',
    )
    expect(linkCitations('x [2‑5] y [1, 3]')).toBe(
      'x [2](#cite-2)[3](#cite-3)[4](#cite-4)[5](#cite-5) y [1](#cite-1)[3](#cite-3)',
    )
  })
})

describe('cleanCitations', () => {
  it('drops trailing Sources sections and collapses repeats', () => {
    expect(cleanCitations('Python [1][1] and React [2].\n\n(Sources: skills on page 1 [1]; pages 2 [2-5])')).toBe(
      'Python [1] and React [2].',
    )
    expect(cleanCitations('Answer [1].\n\n**Sources:**\n- resume p.1')).toBe('Answer [1].')
    expect(cleanCitations('No sources here, the source of truth is code.')).toBe('No sources here, the source of truth is code.')
  })
})

describe('sessions', () => {
  const msg = (id, role, content, status = 'done') => ({
    id,
    role,
    content,
    status,
  })

  it('upserts most-recent-first, titles from the first question, skips streaming messages', () => {
    let s = upsertSession([], 'a', [msg('1', 'user', 'What are the key skills?'), msg('2', 'assistant', 'x')], 100)
    s = upsertSession(s, 'b', [msg('3', 'user', 'Second chat'), msg('4', 'assistant', '', 'streaming')], 200)
    expect(s.map((x) => x.id)).toEqual(['b', 'a'])
    expect(s[0].messages).toHaveLength(1)
    s = upsertSession(s, 'a', [msg('1', 'user', 'What are the key skills?'), msg('2', 'assistant', 'y')], 300)
    expect(s[0]).toMatchObject({ id: 'a', title: 'What are the key skills?', createdAt: 100, updatedAt: 300 })
    expect(deleteSession(s, 'a').map((x) => x.id)).toEqual(['b'])
  })

  it('buckets by day', () => {
    const now = new Date('2026-11-09T15:00:00').getTime()
    expect(dayBucket(now - 3_600_000, now)).toBe('Today')
    expect(dayBucket(now - 86_400_000, now)).toBe('Yesterday')
    expect(dayBucket(now - 10 * 86_400_000, now)).toBe('Older')
  })
})

describe('product registry', () => {
  it('has unique slugs, and every live product has a route', async () => {
    const { PRODUCTS } = await import('../site/products')
    const slugs = PRODUCTS.map((p) => p.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const p of PRODUCTS) if (p.status === 'live') expect(p.route).toMatch(/^\//)
  })
})
