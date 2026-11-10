import { LoaderCircle, ScanLine, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import type { EntryInput, Kind, ScanResult } from './api'
import { MODULES } from './modules'

export interface ScanState {
  photo: string // data URL preview
  photoId: string | null
  result: ScanResult | null
  error: string | null
}

const KINDS: Kind[] = ['expiry', 'appliance', 'bill', 'pantry', 'stash']

/** Review what the vision model read from a photo before anything is saved (human in the loop). */
export function ScanSheet({
  scan,
  onClose,
  onSave,
}: {
  scan: ScanState | null
  onClose: () => void
  onSave: (entries: EntryInput[]) => Promise<void>
}) {
  return (
    <AnimatePresence>
      {scan && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/60 backdrop-blur-sm sm:items-center sm:p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Review photo"
            className="glass w-full max-w-md rounded-t-3xl p-5 sm:rounded-3xl"
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
          >
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-white">
                <ScanLine className="size-4 text-pink-300" /> Read from photo
              </h2>
              <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-lg text-ink-400 hover:bg-white/5">
                <X className="size-4" />
              </button>
            </div>

            <div className="mt-4 flex gap-4">
              <div className="relative h-28 w-24 shrink-0 overflow-hidden rounded-xl ring-1 ring-white/10">
                <img src={scan.photo} alt="" className="size-full object-cover" />
                {!scan.result && !scan.error && (
                  <motion.span
                    className="absolute inset-x-0 h-8 bg-gradient-to-b from-transparent via-pink-400/50 to-transparent"
                    animate={{ top: ['-20%', '100%'] }}
                    transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
                  />
                )}
              </div>
              <div className="min-w-0 flex-1 text-[13px]">
                {scan.error ? (
                  <p className="text-rose-300">{scan.error}</p>
                ) : !scan.result ? (
                  <p className="flex items-center gap-2 text-ink-300">
                    <LoaderCircle className="size-4 animate-spin" /> Reading the photo…
                  </p>
                ) : (
                  <p className="text-ink-300">{scan.result.caption ?? 'Check the details below, then save.'}</p>
                )}
              </div>
            </div>

            {scan.result && scan.photoId && (
              <ScanForm key={scan.photoId} photoId={scan.photoId} result={scan.result} onSave={onSave} />
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function ScanForm({
  photoId,
  result,
  onSave,
}: {
  photoId: string
  result: ScanResult
  onSave: (entries: EntryInput[]) => Promise<void>
}) {
  const [kind, setKind] = useState<Kind>(KINDS.includes(result.kind) ? result.kind : 'stash')
  const [title, setTitle] = useState(result.title)
  const [date, setDate] = useState(result.date ?? '')
  const [place, setPlace] = useState('')
  const [items, setItems] = useState(result.items.join(', '))
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    const r = result
    const base = { photo_id: photoId, data: { caption: r.caption } }
    let entries: EntryInput[]
    if (kind === 'pantry') {
      const names = items.split(',').map((s) => s.trim()).filter(Boolean)
      entries = (names.length ? names : [title]).map((n, i) => ({
        kind: 'pantry',
        title: n,
        photo_id: i === 0 ? photoId : null,
        data: { state: 'have' },
      }))
    } else {
      const data: Record<string, unknown> = { ...base.data }
      if (kind === 'expiry') data.category = r.category ?? 'other'
      if (kind === 'appliance') Object.assign(data, { model: r.model, every_months: 6 })
      if (kind === 'bill') Object.assign(data, { amount: r.amount, recurring: 'none' })
      entries = [{ ...base, kind, title: title || 'Photo', due: date || null, place: place || null, data }]
    }
    try {
      await onSave(entries)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {KINDS.map((k) => {
          const m = MODULES.find((x) => x.id === k)!
          return (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={`rounded-full px-2.5 py-1 text-[12px] ring-1 transition ${
                kind === k ? `${m.tint} ring-current/30` : 'text-ink-400 ring-white/10 hover:text-white'
              }`}
            >
              {m.label}
            </button>
          )
        })}
      </div>
      {kind === 'pantry' ? (
        <Field label="Items (comma-separated)" value={items} onChange={setItems} />
      ) : (
        <>
          <Field label="Title" value={title} onChange={setTitle} />
          {kind === 'stash' ? (
            <Field label="Where is it?" value={place} onChange={setPlace} placeholder="e.g. top drawer, bedroom" />
          ) : (
            <Field
              label={kind === 'expiry' ? 'Expires on' : kind === 'bill' ? 'Due on' : 'Next service'}
              value={date}
              onChange={setDate}
              type="date"
            />
          )}
        </>
      )}
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="w-full rounded-xl bg-gradient-to-r from-fuchsia-500 via-pink-500 to-orange-400 py-2.5 text-[14px] font-semibold text-on-accent shadow-lg shadow-pink-950/30 transition hover:brightness-110 disabled:opacity-60"
      >
        {saving ? 'Saving…' : 'Save to Keeper'}
      </button>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
}) {
  return (
    <label className="block">
      <span className="text-[11.5px] font-medium text-ink-400">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-xl border border-white/10 bg-ink-900/70 px-3 py-2 text-[14px] text-white outline-none focus:border-pink-400/50"
      />
    </label>
  )
}
