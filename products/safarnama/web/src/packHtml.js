/**
 * The trip pack: everything about a trip in one self-contained web page to download, print as a PDF or share. It
 * needs no internet to open (no scripts, fonts or images from elsewhere) and prints cleanly on A4.
 *
 * Pure: `buildTripPack(data)` returns the HTML; TripPack.jsx gathers the data and hands the file over. What it holds:
 * what the trip will likely cost and the guide's stay levels, food haul, things to do and fares (typical prices,
 * marked as estimates), the plan day by day (with map links and the forecast as fetched), the budget plan, where to
 * stay (shortlisted and nearby, from OpenStreetMap, with dated search links), things to do nearby, saved places,
 * bookings (titles and dates, never reference numbers) and checklists. No price, rating or opening time is added that
 * isn't in the trip or its guide.
 * Unit-tested in packHtml.test.js.
 */
import { googleHotels, stays as stayWindows } from './booking'
import { budgetPlan, shortMoney, wholeMoney } from './money'
import { LEVELS, rangeText } from './guideKit'
import { safeLink } from './logic'

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const link = (url, text) => (safeLink(url) && /^https:/i.test(url) ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text))
const mapUrl = (p) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.lat != null ? `${p.lat},${p.lng}` : p.name)}`
const km = (m) => (m == null ? '' : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`)
const STAY_KIND = { hotel: 'Hotel', 'guest house': 'Guest house', hostel: 'Hostel', motel: 'Motel', apartment: 'Apartment', chalet: 'Chalet', 'alpine hut': 'Mountain hut' }
const PART = (t) => (t < '12:00' ? 'Morning' : t < '17:00' ? 'Afternoon' : 'Evening')

function day(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
}

function weatherLine(w) {
  if (!w || w.tmax == null) return ''
  const rain = w.rain != null ? ` · ${w.rain}% chance of rain` : ''
  return `${Math.round(w.tmin ?? w.tmax)}–${Math.round(w.tmax)}°C${rain}`
}

/** Everything the pack shows, in plain data (also what the tests check). */
export function packSections({ trip, sum, stays = [], nearby = [], saved = [], bookings = [], guide = null, estimate = null }) {
  const plan = budgetPlan(trip, sum)
  const cur = sum?.currency ?? trip.budget?.currency ?? 'INR'
  const windows = stayWindows(trip)
  return {
    title: trip.title,
    route: (trip.destinations ?? []).map((d) => d.name).join(' → ') || trip.city?.name || '',
    dates: trip.days[0]?.date ? `${day(trip.days[0].date)} to ${day(trip.days.at(-1).date)}` : 'Dates not set',
    days: trip.days.length,
    party: trip.party?.travellers ? `${trip.party.travellers} traveller${trip.party.travellers === 1 ? '' : 's'}` : '',
    summary: trip.summary ?? '',
    budget: plan && {
      total: wholeMoney(sum.budget_total, cur),
      spent: wholeMoney(sum.actual_total, cur),
      perPersonDay: shortMoney(sum.budget_total / plan.days / plan.people, cur),
      rows: plan.rows.filter((r) => r.planned > 0).map((r) => ({
        label: r.label,
        planned: wholeMoney(r.planned, cur),
        everyday: r.id === 'lodging' && r.each ? `about ${shortMoney(r.each, cur)} a night` : r.id === 'food' && r.each ? `about ${shortMoney(r.each, cur)} a person a day` : '',
        spent: r.spent ? wholeMoney(r.spent, cur) : '',
      })),
    },
    itinerary: trip.days.map((d) => ({
      day: d.day,
      date: day(d.date),
      weather: weatherLine(d.weather),
      stops: d.activities.map((a) => ({ time: a.time, part: PART(a.time ?? '09:00'), name: a.name, minutes: a.duration_min, note: a.note ?? '', map: mapUrl(a), meal: a.kind === 'food' })),
    })),
    stays: stays.map((s) => {
      const w = windows.find((x) => x.name === s.destination) ?? {}
      return {
        destination: s.destination,
        nights: w.nights,
        checkin: day(w.checkin),
        checkout: day(w.checkout),
        perNight: plan?.perNight ? shortMoney(plan.perNight, cur) : '',
        search: googleHotels(`hotels in ${s.destination}`, { checkin: w.checkin, checkout: w.checkout }),
        places: s.places.slice(0, 8).map((p) => ({
          name: p.name,
          kind: STAY_KIND[p.category] ?? 'Stay',
          stars: p.stars ? `${p.stars}-star (as mapped)` : '',
          distance: p.distance_m != null ? `${km(p.distance_m)} from where you'll spend your days` : '',
          saved: !!p.saved,
          prices: googleHotels(`${p.name}, ${s.destination}`, { checkin: w.checkin, checkout: w.checkout }),
          website: p.website ?? '',
        })),
      }
    }),
    nearby: nearby.map((n) => ({ destination: n.destination, groups: n.groups.filter((g) => g.places.length).map((g) => ({ label: g.label, places: g.places.slice(0, 8).map((p) => ({ name: p.name, what: p.category, free: p.fee === 'no', map: mapUrl(p), distance: km(p.distance_m) })) })) })),
    saved: saved.filter((p) => p.group !== 'stay').map((p) => ({ name: p.name, what: p.category ?? p.group, map: mapUrl(p) })),
    bookings: bookings.filter((b) => b.status !== 'cancelled').map((b) => ({ title: b.title, type: b.type, when: [b.start, b.end].filter(Boolean).join(' → ').replace('T', ' '), status: b.status })),
    checklists: (trip.checklists ?? []).filter((l) => l.items?.length).map((l) => ({ title: l.title, items: l.items.map((i) => ({ text: i.text, done: !!i.done })) })),
    tips: trip.tips ?? [],
    forecastAt: trip.weather_updated_at ?? null,
    guide: guide && guideSections(guide, estimate),
  }
}

/** The guide's part of the pack: likely cost, stay levels, food, things to do, fares and tips (all estimates). */
function guideSections(g, est) {
  const cur = g.currency
  const label = (t) => LEVELS.find((l) => l.id === t)?.label ?? t
  return {
    cost: est && {
      level: label(est.tier), total: rangeText({ min: est.total[0], max: est.total[1] }, cur),
      status: { fits: 'fits the budget', tight: 'is tight on the budget', over: 'is over the budget' }[est.status] ?? '',
      parts: [['Stay', est.parts.stay], ['Food', est.parts.food], ['Getting around', est.parts.local], ['Things to do', est.parts.things], ['Getting there', est.parts.getting_there]]
        .filter(([, r]) => r[1] > 0).map(([k, r]) => `${k} ${rangeText(r, cur)}`),
    },
    destinations: g.destinations.map((d) => ({
      name: d.destination,
      stay: d.stay.map((a) => ({ area: a.area, why: a.why, tiers: a.tiers.map((t) => `${label(t.tier)}: ${t.kind ? `${t.kind}, ` : ''}${rangeText(t.per_night, cur, ' a night')}`) })),
      food: d.food.map((f) => ({ dish: f.dish, where: f.where, what: f.what, cost: rangeText(f.per_person, cur, ' a person') })),
      things: d.things.map((t) => ({ name: t.name, what: t.what, where: t.where, cost: t.per === 'free' ? 'Free' : rangeText(t.cost, cur, t.per === 'group' ? ' for the group' : ' a person'), tip: t.tip })),
      around: d.around.map((r) => `${r.mode}: ${rangeText(r.fare, cur)}`),
      tips: d.tips,
    })),
    there: (g.getting_there ?? []).map((w) => `${w.mode}${w.hours ? ` (about ${w.hours} h)` : ''}: ${rangeText(w.fare, cur, ' a person')}`),
    origin: g.origin,
  }
}

const CSS = `
*{box-sizing:border-box}body{margin:0;font:15px/1.55 Inter,system-ui,-apple-system,'Segoe UI',sans-serif;color:#2b2b2b;background:#fff}
main{max-width:860px;margin:0 auto;padding:36px 22px 60px}h1,h2,h3{font-family:Oswald,'Arial Narrow','Helvetica Neue',sans-serif;text-transform:uppercase;letter-spacing:-.01em;line-height:1.02;margin:0}
h1{font-size:46px}h2{font-size:26px;margin:38px 0 12px;padding-top:14px;border-top:2px solid #2b2b2b}h3{font-size:18px;margin:18px 0 6px}
.cover{background:#d7f75b;border-radius:26px;padding:26px 26px 22px}.cover p{margin:6px 0 0}.muted{color:#5f5f5f}.small{font-size:12.5px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.chip{background:rgba(0,0,0,.08);border-radius:999px;padding:4px 11px;font-size:12.5px;font-weight:600}
table{width:100%;border-collapse:collapse;margin-top:6px}td,th{text-align:left;padding:7px 8px;border-bottom:1px solid #e3e3e3;vertical-align:top}th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#5f5f5f}
.day{break-inside:avoid;margin-top:14px;border:1px solid #e0e0e0;border-radius:20px;padding:14px 16px}.day h3{margin:0}.stop{display:grid;grid-template-columns:56px 1fr;gap:8px;padding:6px 0;border-top:1px dashed #e6e6e6}.stop:first-of-type{border-top:0}
.time{font-weight:700;font-variant-numeric:tabular-nums}ul{margin:6px 0;padding-left:20px}a{color:#1f4fd1}.tick{display:inline-block;width:12px;height:12px;border:1.5px solid #2b2b2b;border-radius:3px;margin-right:6px;vertical-align:-1px}
.tick.done{background:#2b2b2b}.card{break-inside:avoid;border:1px solid #e0e0e0;border-radius:16px;padding:10px 12px;margin:8px 0}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}
footer{margin-top:40px;font-size:12px;color:#5f5f5f}@media print{main{padding:0}h2{break-after:avoid}a{color:inherit;text-decoration:none}.cover{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
@page{size:A4;margin:14mm}`

/** The trip pack as a complete HTML document. `generatedAt` is shown in the footer. */
export function buildTripPack(data, generatedAt = new Date()) {
  const s = packSections(data)
  const h = []
  h.push(`<section class="cover"><p class="small" style="font-weight:700;letter-spacing:.12em;text-transform:uppercase">${esc(s.route)}</p><h1>${esc(s.title)}</h1>`)
  if (s.summary) h.push(`<p>${esc(s.summary)}</p>`)
  h.push(`<div class="chips"><span class="chip">${esc(s.dates)}</span><span class="chip">${s.days} day${s.days === 1 ? '' : 's'}</span>${s.party ? `<span class="chip">${esc(s.party)}</span>` : ''}${s.budget ? `<span class="chip">Budget ${esc(s.budget.total)}</span>` : ''}</div></section>`)

  const g = s.guide
  if (g?.cost) {
    h.push(`<h2>What it'll likely cost</h2><p><strong>${esc(g.cost.total)}</strong> with ${esc(g.cost.level.toLowerCase())} stays, which ${esc(g.cost.status)}.</p><p class="small muted">${esc(g.cost.parts.join(' · '))}. Typical prices for the season (estimates), not live prices.</p>`)
  }
  if (s.budget) {
    h.push(`<h2>Budget plan</h2><p class="muted small">${esc(s.budget.total)} in all, about ${esc(s.budget.perPersonDay)} a person a day. A plan for your own money, not prices: check real prices on the booking sites.</p>`)
    h.push('<table><thead><tr><th>For</th><th>Planned</th><th>That means</th><th>Spent so far</th></tr></thead><tbody>')
    for (const r of s.budget.rows) h.push(`<tr><td>${esc(r.label)}</td><td>${esc(r.planned)}</td><td>${esc(r.everyday)}</td><td>${esc(r.spent)}</td></tr>`)
    h.push('</tbody></table>')
  }

  h.push('<h2>Day by day</h2>')
  for (const d of s.itinerary) {
    h.push(`<div class="day"><h3>Day ${d.day}${d.date ? ` · ${esc(d.date)}` : ''}</h3>${d.weather ? `<p class="muted small" style="margin:2px 0 6px">Forecast: ${esc(d.weather)}</p>` : ''}`)
    if (!d.stops.length) h.push('<p class="muted">Nothing planned yet.</p>')
    for (const a of d.stops)
      h.push(`<div class="stop"><span class="time">${esc(a.time ?? '')}</span><span><strong>${link(a.map, a.name)}</strong>${a.minutes ? ` <span class="muted small">· ${a.minutes} min</span>` : ''}${a.note ? `<br><span class="muted small">${esc(a.note)}</span>` : ''}</span></div>`)
    h.push('</div>')
  }

  if (g) {
    for (const d of g.destinations) {
      if (d.stay.length) {
        h.push(`<h2>Staying in ${esc(d.name)}</h2>`)
        for (const a of d.stay) h.push(`<div class="card"><strong>Around ${esc(a.area)}</strong><br><span class="small muted">${esc(a.why)}</span><br><span class="small">${a.tiers.map(esc).join(' · ')}</span></div>`)
      }
      if (d.food.length) {
        h.push(`<h2>Eat like a local in ${esc(d.name)}</h2><div class="grid">`)
        for (const f of d.food) h.push(`<div class="card"><strong>${esc(f.dish)}</strong>${f.where ? ` <span class="small">at ${esc(f.where)}</span>` : ''}<br><span class="small muted">${esc(f.what)}</span><br><span class="small">${esc(f.cost)}</span></div>`)
        h.push('</div>')
      }
      if (d.things.length) {
        h.push(`<h2>Things to do in ${esc(d.name)}</h2><div class="grid">`)
        for (const t of d.things) h.push(`<div class="card"><strong>${esc(t.name)}</strong>${t.where ? ` <span class="small">· ${esc(t.where)}</span>` : ''}<br><span class="small muted">${esc(t.what)}</span><br><span class="small">${esc(t.cost)}${t.tip ? ` · ${esc(t.tip)}` : ''}</span></div>`)
        h.push('</div>')
      }
      if (d.around.length || d.tips.length) h.push(`<h3>Getting around ${esc(d.name)}</h3><ul>${[...d.around, ...d.tips].map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`)
    }
    if (g.there.length) h.push(`<h3>Getting there from ${esc(g.origin ?? '')}</h3><ul>${g.there.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`)
  }

  if (s.stays.length) {
    h.push('<h2>Where to stay</h2>')
    for (const st of s.stays) {
      h.push(`<h3>${esc(st.destination)}</h3><p class="small muted">${st.nights ? `${st.nights} night${st.nights === 1 ? '' : 's'}` : ''}${st.checkin ? `, ${esc(st.checkin)} to ${esc(st.checkout)}` : ''}${st.perNight ? ` · your budget allows ${esc(st.perNight)} a night` : ''} · ${link(st.search, 'see prices for your dates')}</p>`)
      if (!st.places.length) h.push('<p class="muted small">No places to stay are mapped near your plan; use the search link above.</p>')
      h.push('<div class="grid">')
      for (const p of st.places)
        h.push(`<div class="card"><strong>${esc(p.name)}</strong>${p.saved ? ' <span class="chip">Shortlisted</span>' : ''}<br><span class="small muted">${esc([p.kind, p.stars, p.distance].filter(Boolean).join(' · '))}</span><br><span class="small">${link(p.prices, 'Prices and reviews')}${p.website ? ` · ${link(p.website, 'Website')}` : ''}</span></div>`)
      h.push('</div>')
    }
  }

  if (s.nearby.some((n) => n.groups.length) || s.saved.length) {
    h.push('<h2>Things to do nearby</h2>')
    if (s.saved.length) {
      h.push('<h3>Your saved places</h3><ul>')
      for (const p of s.saved) h.push(`<li>${link(p.map, p.name)} <span class="muted small">· ${esc(p.what)}</span></li>`)
      h.push('</ul>')
    }
    for (const n of s.nearby)
      for (const g of n.groups) {
        h.push(`<h3>${esc(g.label)} · ${esc(n.destination)}</h3><ul>`)
        for (const p of g.places) h.push(`<li>${link(p.map, p.name)} <span class="muted small">· ${esc(p.what)}${p.distance ? `, ${esc(p.distance)} from the centre` : ''}${p.free ? ', free entry (as mapped)' : ''}</span></li>`)
        h.push('</ul>')
      }
  }

  if (s.bookings.length) {
    h.push('<h2>Bookings</h2><table><thead><tr><th>What</th><th>When</th><th>Status</th></tr></thead><tbody>')
    for (const b of s.bookings) h.push(`<tr><td>${esc(b.title)} <span class="muted small">(${esc(b.type)})</span></td><td>${esc(b.when)}</td><td>${esc(b.status)}</td></tr>`)
    h.push('</tbody></table><p class="small muted">Reference numbers are left out so the pack is safe to share; they are in the app.</p>')
  }

  if (s.checklists.length) {
    h.push('<h2>Checklists</h2>')
    for (const l of s.checklists) {
      h.push(`<h3>${esc(l.title)}</h3><ul style="list-style:none;padding:0">`)
      for (const i of l.items) h.push(`<li><span class="tick${i.done ? ' done' : ''}"></span>${esc(i.text)}</li>`)
      h.push('</ul>')
    }
  }
  if (s.tips.length) h.push(`<h2>Tips</h2><ul>${s.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`)

  const asOf = s.forecastAt ? ` Forecast as fetched on ${esc(new Date(s.forecastAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}; check again before you go.` : ''
  h.push(`<footer>Made with Safarnaama on ${esc(generatedAt.toLocaleDateString('en-GB', { dateStyle: 'long' }))}. Places from OpenStreetMap contributors; weather from Open-Meteo.${asOf} Prices, ratings and availability aren't included: they're on the booking sites. Star ratings are only shown where they're mapped.</footer>`)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(s.title)} · trip pack</title><style>${CSS}</style></head><body><main>${h.join('')}</main></body></html>`
}

/** A file name for the pack: "manali-4-days-trip-pack.html". */
export function packFileName(trip) {
  const base = String(trip.title ?? 'trip').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  return `${base || 'trip'}-trip-pack.html`
}
