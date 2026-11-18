/**
 * Safarnama's imagery: destination photos (Wikimedia Commons, credited), the trip hero banner, photo trip cards and a
 * drifting strip of places for the home screen. Places without a photo get a warm gradient with a contour pattern.
 */
import { Info } from 'lucide-react'
import { useState } from 'react'
import { PHOTOS } from './photos'

export const photoFor = (name) => {
  const key = Object.keys(PHOTOS).find((k) => k.toLowerCase() === String(name ?? '').trim().toLowerCase())
  return key ? PHOTOS[key] : null
}

/** Licence credit for a photo (required by CC BY / BY-SA): author, licence and a link to the source file. */
export function PhotoCredit({ photo, className = '' }) {
  const [open, setOpen] = useState(false)
  if (!photo) return null
  return (
    <span className={`absolute z-10 ${className}`}>
      <button
        type="button"
        aria-label={`Photo credit: ${photo.landmark}`}
        aria-expanded={open}
        onClick={(e) => (e.stopPropagation(), e.preventDefault(), setOpen((o) => !o))}
        className="grid size-6 place-items-center rounded-full bg-black/35 text-[#fff]/85 backdrop-blur transition hover:bg-black/55 hover:text-[#fff]"
      >
        <Info className="size-3.5" />
      </button>
      {open && (
        <span className="absolute right-0 bottom-8 w-56 rounded-lg bg-black/80 p-2.5 text-left text-[11px] leading-snug text-[#fff]/90 shadow-xl backdrop-blur">
          {photo.landmark}. Photo: {photo.author}, {photo.license}, via{' '}
          <a href={photo.source} target="_blank" rel="noopener noreferrer" className="underline" onClick={(e) => e.stopPropagation()}>
            Wikimedia Commons
          </a>
          .
        </span>
      )}
    </span>
  )
}

/** A photo, or a warm gradient placeholder for places we have no picture of. */
export function PlaceImage({ name, className = '', eager = false }) {
  const photo = photoFor(name)
  if (photo)
    return <img src={photo.src} alt={`${photo.landmark}, ${name}`} loading={eager ? 'eager' : 'lazy'} decoding="async" className={`size-full object-cover ${className}`} />
  return (
    <div className={`relative size-full bg-gradient-to-br from-amber-400 via-orange-500 to-rose-500 ${className}`}>
      <div className="absolute inset-0 opacity-25 [background:repeating-radial-gradient(circle_at_70%_40%,transparent_0_14px,rgb(255_255_255/0.5)_15px_16px)]" />
      <span className="pa-display absolute right-4 bottom-2 text-[64px] leading-none text-[#fff]/35">{String(name ?? '?').trim().charAt(0)}</span>
    </div>
  )
}

/** The big banner at the top of a trip: photo of the first destination, title in the travelogue serif. */
export function TripHero({ trip, chips, actions }) {
  const first = trip.destinations?.[0]?.name ?? trip.city?.name
  const photo = photoFor(first)
  return (
    <section className="relative overflow-hidden rounded-3xl bg-ink-900 shadow-[0_30px_60px_-30px_rgb(0_0_0/0.45)]">
      <div className="absolute inset-0">
        <PlaceImage name={first} eager />
        <div className="absolute inset-0 bg-[linear-gradient(to_top,rgb(0_0_0/0.78),rgb(0_0_0/0.35)_55%,rgb(0_0_0/0.1))]" />
      </div>
      <div className="relative flex min-h-[230px] flex-col justify-end p-5 text-[#fff] sm:min-h-[280px] sm:p-7">
        <div className="absolute top-4 right-4 flex flex-wrap justify-end gap-2 sm:top-5 sm:right-5">{actions}</div>
        <p className="text-[12px] font-medium tracking-wide text-[#fff]/75 uppercase">{(trip.destinations ?? []).map((d) => d.name).join(' → ')}</p>
        <h1 className="pa-display mt-1 max-w-3xl text-[34px] leading-[1.05] font-semibold sm:text-[46px]">{trip.title}</h1>
        {trip.summary && <p className="mt-2 max-w-2xl text-[14px] leading-snug text-[#fff]/80">{trip.summary}</p>}
        <div className="mt-3 flex flex-wrap gap-1.5">{chips}</div>
      </div>
      <PhotoCredit photo={photo} className="right-4 bottom-4" />
    </section>
  )
}

/** Small frosted chip for the hero (readable on any photo). */
export function HeroChip({ children, tone }) {
  const tones = { good: 'bg-emerald-400/30 text-[#fff]', warn: 'bg-amber-400/30 text-[#fff]' }
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium backdrop-blur-md ${tones[tone] ?? 'bg-[#fff]/15 text-[#fff]'}`}>{children}</span>
}

/** Home screen: a slow strip of real places to set the mood (decorative; pauses on hover, off with reduced motion). */
export function DestinationStrip() {
  const items = Object.entries(PHOTOS)
  return (
    <div aria-hidden className="relative -mx-4 overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_8%,#000_92%,transparent)]">
      <div className="pa-drift flex w-max gap-3 py-1">
        {[...items, ...items].map(([name, p], i) => (
          <figure key={i} className="relative h-36 w-28 shrink-0 overflow-hidden rounded-2xl sm:h-44 sm:w-36">
            <img src={p.src} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
            <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2.5 pt-6 pb-2 text-[11.5px] leading-tight font-medium text-[#fff]">
              {name}
              <span className="block text-[10px] font-normal text-[#fff]/75">{p.landmark}</span>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  )
}

/** All photo credits in one place (linked from the home screen). */
export function PhotoCredits() {
  return (
    <details className="text-[11.5px] text-ink-500">
      <summary className="cursor-pointer hover:text-ink-300">Photo credits</summary>
      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
        {Object.entries(PHOTOS).map(([name, p]) => (
          <li key={name}>
            {name} ({p.landmark}): {p.author}, {p.license},{' '}
            <a className="underline hover:text-ink-300" href={p.source} target="_blank" rel="noopener noreferrer">source</a>
          </li>
        ))}
      </ul>
    </details>
  )
}
