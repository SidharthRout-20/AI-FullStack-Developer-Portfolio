/**
 * The trip pack, handed over: download it as a page that opens offline, print it (or save it as a PDF), or share the
 * file from a phone. The data is gathered when asked for (places to stay and things to do from OpenStreetMap, saved
 * places, bookings); a part that can't be fetched is left out rather than failing the pack.
 */
import { Download, LoaderCircle, Printer, Share2 } from 'lucide-react'
import { useState } from 'react'
import { stopsCentre } from './logic'
import { buildTripPack, packFileName } from './packHtml'

const NEARBY = [
  { group: 'sights', label: 'Sights' },
  { group: 'nature', label: 'Nature and viewpoints' },
  { group: 'experiences', label: 'Experiences' },
]
// Notable first (places with a Wikipedia or Wikidata entry, a fact on the map), then the nearest.
const byNote = (a, b) => Number(!!b.wiki) - Number(!!a.wiki) || (a.distance_m ?? 0) - (b.distance_m ?? 0)
const value = (r) => (r.status === 'fulfilled' ? r.value : null)

/** Everything the pack needs, fetched in parallel. */
export async function gatherPack(trip, api, sum) {
  const dests = trip.destinations?.length ? trip.destinations : trip.city ? [trip.city] : []
  const owner = trip.role === 'owner'
  const [saved, bookings, guide, ...perDest] = await Promise.allSettled([
    api.places(),
    owner ? api.bookings() : Promise.resolve([]),
    api.guide(),
    ...dests.map(async (d) => {
      const c = stopsCentre(trip, d)
      const [stay, ...groups] = await Promise.allSettled([
        api.discover({ group: 'stay', lat: c.lat, lng: c.lng }),
        ...NEARBY.map((g) => api.discover({ group: g.group, ...(d.id ? { destination: d.id } : {}) })),
      ])
      return {
        stays: { destination: d.name, places: value(stay)?.places ?? [] },
        nearby: { destination: d.name, groups: NEARBY.map((g, i) => ({ label: g.label, places: [...(value(groups[i])?.places ?? [])].sort(byNote) })) },
      }
    }),
  ])
  const dest = perDest.map(value).filter(Boolean)
  const savedPlaces = value(saved) ?? []
  const savedIds = new Set(savedPlaces.map((p) => p.osm_id ?? p.name.toLowerCase()))
  // Stays the traveller shortlisted come first, marked as such.
  const stays = dest.map(({ stays: s }) => ({
    ...s,
    places: [
      ...savedPlaces.filter((p) => p.group === 'stay' && (!p.destination || trip.destinations?.find((x) => x.id === p.destination)?.name === s.destination)).map((p) => ({ ...p, saved: true })),
      ...s.places.filter((p) => !savedIds.has(p.osm_id ?? p.name.toLowerCase())),
    ],
  }))
  const g = value(guide)
  let level = null
  try {
    level = localStorage.getItem(`safarnaama-level-${trip.id}`) // the stay level picked in the guide
  } catch {
    /* use the one the budget points to */
  }
  const estimate = g?.estimate ? g.estimate.levels[level] ?? g.estimate.levels[g.estimate.chosen] : null
  return { trip, sum, stays, nearby: dest.map((x) => x.nearby), saved: savedPlaces, bookings: value(bookings) ?? [], guide: g?.guide ?? null, estimate }
}

function saveFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/html;charset=utf-8' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** Print from a hidden frame (no pop-up to be blocked); the browser's dialog offers "Save as PDF". */
function printHtml(html) {
  const frame = Object.assign(document.createElement('iframe'), { title: 'Trip pack for printing' })
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  frame.srcdoc = html
  frame.onload = () => {
    frame.contentWindow?.focus()
    frame.contentWindow?.print()
    window.setTimeout(() => frame.remove(), 60_000)
  }
  document.body.append(frame)
}

const canShareFiles = () => {
  try {
    return typeof navigator !== 'undefined' && !!navigator.canShare?.({ files: [new File(['x'], 'x.html', { type: 'text/html' })] })
  } catch {
    return false
  }
}

/** A dark pill for actions on a colour card (readable on every palette colour, in light and dark mode). */
export function PillButton({ icon: Icon, busy, disabled, onClick, children }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="pc-pill inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[12.5px] font-semibold disabled:opacity-60">
      {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : Icon && <Icon className="size-3.5" />} {children}
    </button>
  )
}

export function TripPack({ trip, api, sum, setNote, compact = false }) {
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const share = canShareFiles()
  const make = async (how) => {
    setBusy(how)
    setError(null)
    try {
      const html = buildTripPack(await gatherPack(trip, api, sum))
      const name = packFileName(trip)
      if (how === 'download') {
        saveFile(name, html)
        setNote?.('Trip pack downloaded. It opens in any browser, even offline.')
      } else if (how === 'print') printHtml(html)
      else await navigator.share({ title: trip.title, files: [new File([html], name, { type: 'text/html' })] })
    } catch (e) {
      if (e?.name !== 'AbortError') setError("Couldn't put the pack together. Please try again.")
    } finally {
      setBusy(null)
    }
  }
  return (
    <section aria-label="Trip pack" className={`pc-card flex flex-wrap items-center gap-x-5 gap-y-3 ${compact ? 'px-4 py-3.5' : 'p-5'}`} style={{ background: 'var(--pc-2)', color: 'var(--pc-on-2)', transform: 'rotate(0.4deg)' }}>
      <div className="min-w-0 flex-1 basis-64">
        <p className="pc-head text-[20px] leading-none">Your trip pack</p>
        <p className="mt-1 text-[13px] font-medium opacity-85">The plan, where to stay, things to do and the budget in one file. Opens offline, prints on A4, safe to share.</p>
        {busy && <p className="mt-1 text-[12px] font-semibold" role="status">Putting your pack together…</p>}
        {error && <p className="mt-1 text-[12px] font-semibold" role="alert">{error}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <PillButton busy={busy === 'download'} disabled={!!busy} onClick={() => void make('download')} icon={Download}>Download</PillButton>
        <PillButton busy={busy === 'print'} disabled={!!busy} onClick={() => void make('print')} icon={Printer}>Print or PDF</PillButton>
        {share && <PillButton busy={busy === 'share'} disabled={!!busy} onClick={() => void make('share')} icon={Share2}>Share</PillButton>}
      </div>
    </section>
  )
}
