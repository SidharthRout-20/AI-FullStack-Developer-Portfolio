import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { __test__ as C } from './CodeLensApp'

const stages = [{ stage: 'download', detail: 'a/b', done: true }, { stage: 'read', detail: '0.1 MB', done: true }, { stage: 'chunk', detail: '13 files', done: false }]
const found = { repo: 'expressjs/morgan', event: 'preview', files: 13, lines: 2400, languages: [{ name: 'javascript', share: 80 }], folders: ['test', '(root)'], sample: ['index.js', 'test/a.js'], title: 'morgan' }

describe('CodeLens screens render with real-shaped data', () => {
  it('building, at every point of the stream', () => {
    for (const f of [{ repo: 'x/y' }, found, { ...found, embedded: 48, total: 174 }, { ...found, edges: 3, symbols: 40 }])
      for (const st of [[], stages, [...stages, { stage: 'embed', detail: '', done: false }]])
        expect(() => renderToString(h(C.Building, { stages: st, found: f }))).not.toThrow()
  })
  it('the start screen', () => {
    expect(() => renderToString(h(C.Start))).not.toThrow()
  })
})

describe('the onboarding pack chapters render', () => {
  const repo = { id: 'r1', owner: 'expressjs', name: 'morgan', url: 'https://github.com/expressjs/morgan', files: ['index.js'], languages: { javascript: 900, markdown: 100 } }
  const pack = {
    purpose: 'Logs HTTP requests.', architecture: 'One middleware.', run: [],
    areas: [{ name: 'Core', what: 'The middleware.', paths: ['index.js'] }],
    reading_path: [{ title: 'Start', path: 'index.js', explanation: 'Entry point.' }],
    week_plan: [{ day: 1, goal: 'Run it', tasks: [{ text: 'Install', paths: [] }], checkpoint: 'Tests pass' }],
    questions: ['Where are formats defined?'],
  }
  it.each(['Overview', 'Areas', 'ReadingPath', 'Week', 'Ask'])('%s', (name) => {
    expect(() => renderToString(h(C[name], { repo, pack, open: () => {} }))).not.toThrow()
  })
})
