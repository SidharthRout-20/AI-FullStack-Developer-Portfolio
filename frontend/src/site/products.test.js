import { describe, expect, it } from 'vitest'
import { forecastFreshness } from '../products/tripweaver/freshness'
import { fillCounts, LABS, LIVE_COUNT, MODULE_STATUSES, PORTFOLIO, PRODUCTS, productBySlug, productHref, STATUSES } from './products'

const ids = (list) => list.map((p) => p.id)
const APPROVED = ['tripweaver', 'efi', 'keeper', 'documind-respond', 'follow-through']

describe('approved portfolio', () => {
  it('contains exactly the five approved products, in priority order, each once', () => {
    expect(ids(PORTFOLIO)).toEqual(APPROVED)
    expect(PORTFOLIO.map((p) => p.priority)).toEqual([1, 2, 3, 4, 5])
    expect(PORTFOLIO.map((p) => p.name)).toEqual(['Safarnama', 'Jasoos', 'Tijori', 'Pramaan', 'Vaada'])
    expect(PORTFOLIO.every((p) => p.meaning)).toBe(true) // every name says what it means
  })

  it('keeps CareerPilot, FlowForge, Evolve and CodeLens in Labs, and TripWeaver out of Labs', () => {
    expect(ids(LABS).sort()).toEqual(['careerpilot', 'codelens', 'evolve', 'flowforge'])
    for (const id of ['careerpilot', 'flowforge', 'evolve', 'codelens']) expect(ids(PORTFOLIO)).not.toContain(id)
    expect(ids(LABS)).not.toContain('tripweaver')
    expect(LABS.every((p) => p.status === 'labs' && p.app?.route)).toBe(true) // still openable
  })

  it('has no duplicate identities, slugs or aliases', () => {
    const keys = PRODUCTS.flatMap((p) => [p.slug, ...p.aliases])
    expect(new Set(keys).size).toBe(keys.length)
    expect(PRODUCTS).toHaveLength(PORTFOLIO.length + LABS.length)
    expect(PRODUCTS.some((p) => p.id === 'documind' || p.id === 'meetingmind')).toBe(false) // folded into Respond / Follow-through
  })

  it('derives counts in site copy from the registry', () => {
    expect(fillCounts('{products} products · {labs} labs · {live} live')).toBe(`5 products · 4 labs · ${LIVE_COUNT} live`)
  })

  it('gives every approved product the required registry fields', () => {
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
    // renamed products keep their old addresses
    for (const [old, id] of [['efi', 'efi'], ['keeper', 'keeper'], ['documind-respond', 'documind-respond'], ['follow-through', 'follow-through'], ['tripweaver', 'tripweaver']])
      expect(productBySlug(old).id).toBe(id)
    expect(productBySlug('safarnama').app.route).toBe('/safarnama')
    expect(productBySlug('jasoos').app.route).toBe('/jasoos')
    expect(productHref(productBySlug('careerpilot'))).toBe('/careerpilot')
  })
})

describe('statuses reflect implementation', () => {
  const status = (id) => PORTFOLIO.find((p) => p.id === id).status
  it('uses the expected statuses', () => {
    expect(status('efi')).toBe('in_development') // tested with a mocked model; not live-verified, no Postgres on the deployed backend
    expect(status('keeper')).toBe('planned')
    expect(status('documind-respond')).toBe('gated')
    expect(status('follow-through')).toBe('planned')
    expect(status('tripweaver')).toBe('in_development') // implemented and tested; not browser-verified, no Postgres in production
    expect(LIVE_COUNT).toBe(0)
  })
  it('never presents a planned or gated product as live, and labels prototypes as prototypes', () => {
    for (const p of PORTFOLIO.filter((x) => ['planned', 'gated'].includes(x.status))) {
      expect(p.status).not.toBe('live')
      if (p.app) expect(p.app.kind).toBe('prototype')
    }
    expect(PORTFOLIO.find((p) => p.id === 'efi').app.kind).toBe('product')
    expect(PORTFOLIO.find((p) => p.id === 'tripweaver').app.kind).toBe('product')
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
