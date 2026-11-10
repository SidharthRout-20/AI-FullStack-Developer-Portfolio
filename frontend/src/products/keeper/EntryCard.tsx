import { Check, ExternalLink, Gift, History, MapPin, Trash2, Zap } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { keeperApi, type Entry } from './api'
import { moduleOf, relativeDay, subtitle, urgency, URGENCY_STYLE } from './modules'

export function usePhotoUrl(id: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!id) return
    let alive = true
    let made: string | null = null
    keeperApi
      .photoUrl(id)
      .then((u) => {
        made = u
        if (alive) setUrl(u)
        else URL.revokeObjectURL(u)
      })
      .catch(() => {})
    return () => {
      alive = false
      setUrl(null)
      if (made) URL.revokeObjectURL(made)
    }
  }, [id])
  return url
}

function Thumb({ id }: { id: string }) {
  const url = usePhotoUrl(id)
  return (
    <span className="relative size-12 shrink-0 overflow-hidden rounded-xl bg-white/[0.04] ring-1 ring-white/10">
      {url ? (
        <img src={url} alt="" className="size-full object-cover" />
      ) : (
        <span className="absolute inset-0 animate-pulse bg-white/[0.05]" />
      )}
    </span>
  )
}

interface Props {
  entry: Entry
  onDone: (e: Entry) => void
  onUsed: (e: Entry) => void
  onDelete: (e: Entry) => void
  busy?: boolean
}

export function EntryCard({ entry: e, onDone, onUsed, onDelete, busy }: Props) {
  const meta = moduleOf(e.kind)
  const Icon = meta.icon
  const u = urgency(e)
  const ideas = Array.isArray(e.data.gift_ideas) ? (e.data.gift_ideas as string[]) : []
  const moves = Array.isArray(e.data.moves) ? (e.data.moves as { place: string | null }[]) : []
  const caption = typeof e.data.caption === 'string' ? e.data.caption : null
  const manual = typeof e.data.manual_url === 'string' ? e.data.manual_url : null

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      className="group relative rounded-2xl border border-white/[0.06] bg-ink-900/60 p-3.5 transition-colors hover:border-white/[0.12]"
    >
      <div className="flex items-start gap-3">
        {e.photo_id ? (
          <Thumb id={e.photo_id} />
        ) : (
          <span className={`grid size-12 shrink-0 place-items-center rounded-xl ${meta.tint}`}>
            <Icon className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate text-[14.5px] font-semibold text-white">{e.title}</p>
            {u !== 'none' && (
              <span className={`rounded-full px-2 py-px text-[10.5px] font-medium ring-1 ${URGENCY_STYLE[u]}`}>
                {relativeDay(e.due)}
                {e.due_time ? ` · ${e.due_time}` : ''}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[12.5px] text-ink-300">{subtitle(e)}</p>
          {caption && <p className="mt-1 line-clamp-2 text-[12px] text-ink-400 italic">“{caption}”</p>}
          {e.note && <p className="mt-1 text-[12px] text-ink-400">{e.note}</p>}
          {ideas.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {ideas.map((g) => (
                <li key={g} className="flex items-center gap-1 rounded-full bg-pink-500/10 px-2 py-0.5 text-[11px] text-pink-300">
                  <Gift className="size-3" /> {g}
                </li>
              ))}
            </ul>
          )}
          {moves.length > 0 && (
            <p className="mt-1.5 flex items-center gap-1 text-[11px] text-ink-500">
              <History className="size-3" /> previously: {moves.map((m) => m.place).filter(Boolean).slice(-2).join(' → ')}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {e.kind === 'parking' && e.lat != null && e.lng != null && (
              <a
                href={`https://www.openstreetmap.org/?mlat=${e.lat}&mlon=${e.lng}#map=18/${e.lat}/${e.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="chip"
              >
                <MapPin className="size-3" /> Open map
              </a>
            )}
            {manual && (
              <a href={manual} target="_blank" rel="noopener noreferrer" className="chip">
                <ExternalLink className="size-3" /> Find manual
              </a>
            )}
            {e.kind === 'bill' && e.data.subscription === true && (
              <button type="button" className="chip" onClick={() => onUsed(e)} disabled={busy}>
                <Zap className="size-3" /> Used it today
              </button>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center">
          {meta.doneLabel && !(e.kind === 'pantry' && e.data.state !== 'need') && (
            <button
              type="button"
              onClick={() => onDone(e)}
              disabled={busy}
              className="flex items-center gap-1 rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-[11.5px] font-medium text-emerald-300 ring-1 ring-emerald-400/20 transition hover:bg-emerald-500/20 disabled:opacity-50"
            >
              <Check className="size-3.5" /> {meta.doneLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => onDelete(e)}
            disabled={busy}
            aria-label={`Delete ${e.title}`}
            className="grid size-7 place-items-center rounded-lg text-ink-500 opacity-60 transition hover:bg-rose-500/10 hover:text-rose-300 group-hover:opacity-100"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
    </motion.li>
  )
}
