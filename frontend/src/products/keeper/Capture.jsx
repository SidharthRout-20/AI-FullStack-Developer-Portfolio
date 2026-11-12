import { ArrowUp, Camera, LoaderCircle, MapPin, Mic, Square, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { compressImage, listen, voiceSupported } from './device'

/**
 * One box for everything: type, dictate, or snap a photo.
 * Parking messages attach the GPS pin automatically; the location chip lets you add it to anything.
 */
export function Capture({ busy, placeholder, onSubmit, onScan, examples }) {
  const [text, setText] = useState('')
  const [photo, setPhoto] = useState(null)
  const [withLocation, setWithLocation] = useState(false)
  const [listening, setListening] = useState(false)
  const [hint, setHint] = useState(null)
  const stopRef = useRef(null)
  const fileRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => () => stopRef.current?.(), [])

  const submit = (e) => {
    e?.preventDefault()
    if (busy) return
    const t = text.trim()
    if (!t && photo) {
      onScan(photo)
    } else if (t) {
      onSubmit({ text: t, photo, withLocation: withLocation || /\bpark(ed)?\b/i.test(t) })
    } else return
    setText('')
    setPhoto(null)
    setWithLocation(false)
    setHint(null)
  }

  const toggleVoice = () => {
    if (listening) {
      stopRef.current?.()
      return
    }
    setHint(null)
    setListening(true)
    stopRef.current = listen(
      (t, final) => {
        setText(t)
        if (final) inputRef.current?.focus()
      },
      (error) => {
        setListening(false)
        if (error) setHint(error)
      },
    )
  }

  const pickPhoto = async (file) => {
    if (!file) return
    try {
      setPhoto(await compressImage(file))
      setHint(text.trim() ? null : 'Add a note (e.g. "spare keys, blue box") or send the photo alone to read it.')
    } catch {
      setHint("Couldn't open that image.")
    }
  }

  return (
    <form onSubmit={submit} className="glass rounded-2xl p-2.5">
      <AnimatePresence>
        {photo && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden px-1 pt-1"
          >
            <div className="relative inline-block">
              <img src={photo} alt="Attached" className="h-20 rounded-xl object-cover ring-1 ring-white/10" />
              <button
                type="button"
                onClick={() => setPhoto(null)}
                aria-label="Remove photo"
                className="absolute -top-2 -right-2 grid size-6 place-items-center rounded-full bg-ink-800 text-ink-200 ring-1 ring-white/15"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          id="keeper-input"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={listening ? 'Listening…' : placeholder}
          aria-label="Tell Keeper something"
          maxLength={600}
          className="max-h-32 min-h-11 flex-1 resize-none bg-transparent px-2.5 py-2.5 text-[15px] text-white outline-none placeholder:text-ink-500 field-sizing-content"
        />
        <div className="flex items-center gap-1 pb-1">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              void pickPhoto(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <IconButton label="Attach a photo" onClick={() => fileRef.current?.click()} active={!!photo}>
            <Camera className="size-4" />
          </IconButton>
          <IconButton
            label={withLocation ? 'Location will be attached' : 'Attach my location'}
            onClick={() => setWithLocation((v) => !v)}
            active={withLocation}
          >
            <MapPin className="size-4" />
          </IconButton>
          {voiceSupported() && (
            <IconButton label={listening ? 'Stop listening' : 'Dictate'} onClick={toggleVoice} active={listening}>
              {listening ? (
                <span className="relative grid place-items-center">
                  <span className="absolute size-6 animate-ping rounded-full bg-rose-400/30" />
                  <Square className="relative size-3.5 fill-current text-rose-300" />
                </span>
              ) : (
                <Mic className="size-4" />
              )}
            </IconButton>
          )}
          <button
            type="submit"
            disabled={busy || (!text.trim() && !photo)}
            aria-label="Send"
            className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-fuchsia-500 via-pink-500 to-orange-400 text-on-accent shadow-lg shadow-pink-950/40 transition hover:scale-105 active:scale-95 disabled:scale-100 disabled:opacity-40"
          >
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
          </button>
        </div>
      </div>

      {hint && <p className="px-2.5 pt-1 text-[12px] text-amber-300">{hint}</p>}

      <div className="mt-1.5 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]">
        {examples.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => {
              setText(ex)
              inputRef.current?.focus()
            }}
            className="shrink-0 rounded-full border border-white/[0.07] bg-white/[0.02] px-2.5 py-1 text-[11.5px] text-ink-300 transition hover:border-white/15 hover:text-white"
          >
            {ex}
          </button>
        ))}
      </div>
    </form>
  )
}

function IconButton({
  label,
  onClick,
  active,
  children,
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`grid size-9 place-items-center rounded-xl transition ${
        active ? 'bg-white/10 text-white ring-1 ring-white/15' : 'text-ink-400 hover:bg-white/[0.06] hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}
