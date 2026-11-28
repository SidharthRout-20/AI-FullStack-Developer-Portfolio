import { describe, expect, it } from 'vitest'
import { forecastFreshness } from '@safarnama/web/freshness'
import * as config from './config'
import { fillCounts, FROZEN, LIVE_COUNT, MODULE_STATUSES, PORTFOLIO, PRODUCTS, productBySlug, productHref, STATUSES } from './products'

const ids = (list) => list.map((p) => p.id)
const FEATURED = ['tripweaver', 'codelens', 'keeper', 'efi']

describe('catalogue', () => {
  it('features exactly four products, problem first, in priority order', () => {
    expect(ids(PORTFOLIO)).toEqual(FEATURED)
    expect(PORTFOLIO.map((p) => p.priority)).toEqual([1, 2, 3, 4])
    expect(PORTFOLIO.map((p) => p.name)).toEqual(['Safarnaama', 'CodeLens', 'Tara', 'Jasoos'])
    for (const p of PORTFOLIO) {
      expect(p.problem, p.id).toMatch(/\?$/) // leads with the traveller's / developer's problem, as a question
      expect(p.outcome, p.id).toBeTruthy()
      expect(p.meaning, p.id).toBeTruthy()
      expect(p.app?.kind, p.id).toBe('product') // every featured product opens and works
    }
  })

  it('freezes everything else as in development', () => {
    expect(ids(FROZEN).sort()).toEqual(['careerpilot', 'documind-respond', 'evolve', 'flowforge', 'follow-through'])
    expect(FROZEN.every((p) => p.status === 'frozen' && STATUSES[p.status].label === 'In development')).toBe(true)
  })

  it('has no duplicate identities, slugs or aliases', () => {
    const keys = PRODUCTS.flatMap((p) => [p.slug, ...p.aliases])
    expect(new Set(keys).size).toBe(keys.length)
    expect(PRODUCTS).toHaveLength(PORTFOLIO.length + FROZEN.length)
  })

  it('derives counts in site copy from the registry', () => {
    expect(fillCounts('{products} products · {labs} frozen · {live} live')).toBe(`4 products · 5 frozen · ${LIVE_COUNT} live`)
  })

  it('gives every featured product the required registry fields', () => {
    for (const p of PORTFOLIO) {
      for (const f of ['id', 'name', 'description', 'category', 'status', 'visibility', 'priority', 'lastVerified', 'statusNote'])
        expect(p[f], `${p.id}.${f}`).toBeTruthy()
      expect(STATUSES[p.status]).toBeDefined()
      expect(productHref(p)).toBe(`/products/${p.slug}`)
    }
  })

  it('resolves old URLs to the product that replaced them', () => {
    expect(productBySlug('documind').id).toBe('documind-respond')
    expect(productBySlug('meetingmind').id).toBe('follow-through')
    for (const [old, id] of [['efi', 'efi'], ['keeper', 'keeper'], ['documind-respond', 'documind-respond'], ['follow-through', 'follow-through'], ['tripweaver', 'tripweaver']])
      expect(productBySlug(old).id).toBe(id)
    expect(productBySlug('safarnama').app.route).toBe('/safarnaama')
    expect(productBySlug('jasoos').app.route).toBe('/jasoos')
    expect(productHref(productBySlug('careerpilot'))).toBe('/products/careerpilot') // frozen: its page, not the app
  })
})

describe('statuses reflect implementation', () => {
  it('calls the featured products Beta until they are verified live', () => {
    expect(PORTFOLIO.every((p) => p.status === 'beta')).toBe(true)
    expect(LIVE_COUNT).toBe(0)
  })
})

describe('TripWeaver product definition', () => {
  const tw = PORTFOLIO.find((p) => p.id === 'tripweaver')
  it('defines the ecosystem modules and a staged roadmap', () => {
    const modules = tw.modules.map((m) => m.id)
    for (const m of ['planning', 'itinerary', 'discovery', 'food', 'shopping', 'experiences', 'weather', 'maps', 'bookings', 'budget', 'companion', 'documents', 'post-trip'])
      expect(modules).toContain(m)
    expect(tw.modules.every((m) => MODULE_STATUSES[m.status])).toBe(true)
    expect(tw.roadmap.map((r) => r.stage)).toEqual(['Stage 1', 'Stage 2', 'Stage 3', 'Stage 4', 'Stage 5'])
  })
  it('does not claim provider-dependent modules are complete', () => {
    const st = Object.fromEntries(tw.modules.map((m) => [m.id, m.status]))
    for (const m of ['food', 'shopping', 'experiences', 'maps']) expect(st[m]).toBe('partial') // ordering, stock, tours, transit need providers
    for (const m of ['planning', 'itinerary', 'discovery', 'weather', 'bookings', 'budget', 'companion', 'documents', 'post-trip']) expect(st[m]).toBe('available')
    expect(tw.status).not.toBe('live')
  })
})

describe('TripWeaver weather freshness', () => {
  const now = new Date('2026-11-14T12:00:00Z')
  it('labels stored forecasts with their age and flags old ones', () => {
    expect(forecastFreshness('2026-11-14T11:30:00Z', now)).toEqual({ label: 'Forecast as of 30 min ago', stale: false })
    expect(forecastFreshness('2026-11-14T03:00:00Z', now)).toEqual({ label: 'Forecast as of 9 h ago', stale: true })
    expect(forecastFreshness(null, now).stale).toBe(true)
    expect(forecastFreshness('garbage', now).label).toBe('Forecast time not recorded')
  })
})

describe('client confidentiality', () => {
  it('never names a client served through an employer, anywhere in the site copy', () => {
    // Icons are components (not copy), so they're dropped before scanning the text.
    const copy = JSON.stringify(config) + JSON.stringify(PRODUCTS.map((p) => ({ ...p, icon: undefined })))
    for (const name of [/\bHP\b/, /Hewlett/i, /Telef[oó]nica/i, /HSBC/i, /USAA/i]) expect(copy).not.toMatch(name)
    expect('React for HP and Telefónica').toMatch(/\bHP\b/) // the check itself can see a name
  })
})
