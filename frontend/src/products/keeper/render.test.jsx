import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Assistant } from './Assistant'
import { ActionCard, LookupCard } from './Cards'

describe('Tara screens render', () => {
  it('the home screen', () => {
    const props = { agenda: [{ bucket: 'today', label: 'Pay rent', entry: { id: 'e1' } }], onChanged() {}, onOpen() {}, onScan() {}, onError() {}, settingsOpen: false, onSettings() {} }
    expect(renderToString(h(Assistant, props))).toContain('How can I help?')
  })
  it('every answer card', () => {
    const cards = [
      { type: 'weather', place: 'Pune', temp: 27, feels: 29, humidity: 60, wind: 9, code: 2, text: 'partly cloudy', source: 'Open-Meteo', days: [{ date: '2030-05-01', code: 63, max: 30, min: 21, rain: 70 }] },
      { type: 'news', topic: '', source: 'Google News', items: [{ title: 'Headline', source: 'The Hindu', link: 'https://x.example' }] },
      { type: 'fact', title: 'Taj Mahal', summary: 'A mausoleum.', source: 'Wikipedia', link: null, image: null },
      { type: 'currency', amount: 100, from: 'USD', to: 'INR', value: 9292, date: '2030-05-01', source: 'Frankfurter' },
      { type: 'time', place: 'Tokyo', time: '18:07', date: 'Wednesday', tz: 'Asia/Tokyo' },
    ]
    for (const card of cards) expect(() => renderToString(h(LookupCard, { card }))).not.toThrow()
    for (const action of [{ type: 'open', url: 'https://www.youtube.com', label: 'Open YouTube' }, { type: 'call', url: 'tel:123456', label: 'Call', confirm: true }, { type: 'timer', seconds: 60, label: 'Tea' }])
      expect(() => renderToString(h(ActionCard, { action }))).not.toThrow()
  })
})
