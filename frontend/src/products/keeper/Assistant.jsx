/**
 * Tijori's home: a personal assistant you talk to. Tap the orb (or press Space) and speak; Tijori answers out loud
 * and does it: saves, finds, reminds, ticks off, plans your day, or just answers the question. "Keep listening"
 * turns it into a back-and-forth conversation, like the assistants on your phone.
 */
import { Camera, Keyboard, Mic, Send, Square, Volume2, VolumeX } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { compressImage } from '@appcore/web/device'
import { keeperApi } from './api'
import { moduleOf } from './modules'
import { canSpeak, hearingMode, hush, primeSpeech, say, useHearing } from './voice'

const PREFS = 'tijori-voice'
const SUGGESTIONS = ["What's on today?", 'Remind me to call Mom at 6 pm', 'I parked on level 2, B14', 'Where did I keep my passport?', 'My car insurance renews on 3 March']

const readPrefs = () => {
  try {
    return { speak: true, keep: false, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') }
  } catch {
    return { speak: true, keep: false }
  }
}
const greeting = (h) => (h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening')

export function Assistant({ agenda, onChanged, onOpen, onScan, onError }) {
  const [thread, setThread] = useState([]) // [{ id, role, text, entries?, kind? }]
  const [thinking, setThinking] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [typed, setTyped] = useState('')
  const [typing, setTyping] = useState(() => !hearingMode())
  const [prefs, setPrefs] = useState(readPrefs)
  const hearing = useHearing(keeperApi.transcribe)
  const camera = useRef(null)
  const endRef = useRef(null)
  const threadRef = useRef(thread)
  const listenRef = useRef(null)
  useEffect(() => {
    threadRef.current = thread
  }, [thread])

  const setPref = (k, v) =>
    setPrefs((p) => {
      const next = { ...p, [k]: v }
      try {
        localStorage.setItem(PREFS, JSON.stringify(next))
      } catch {
        /* private mode */
      }
      return next
    })

  // Braces matter: newer browsers return a Promise from scrollIntoView, and an effect may only return a cleanup.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [thread, thinking])

  const ask = useCallback(
    async (text, { spoken = false } = {}) => {
      const q = text.trim()
      if (!q) return
      const history = threadRef.current.slice(-6).map((t) => ({ role: t.role, text: t.text.slice(0, 700) }))
      setThread((t) => [...t, { id: crypto.randomUUID(), role: 'user', text: q }])
      setThinking(true)
      try {
        const res = await keeperApi.command(q, { history })
        const reply = res.reply || 'Done.'
        setThread((t) => [...t, { id: crypto.randomUUID(), role: 'assistant', text: reply, entries: res.action === 'add' || res.action === 'done' ? res.entries : [], kind: res.kind }])
        if (res.action !== 'chat' && res.action !== 'help') onChanged()
        setThinking(false)
        if (prefs.speak && canSpeak()) {
          setSpeaking(true)
          await say(reply)
          setSpeaking(false)
        }
        if (spoken && prefs.keep) listenRef.current?.() // back-and-forth: listen for the follow-up
      } catch (e) {
        setThinking(false)
        const msg = onError(e)
        setThread((t) => [...t, { id: crypto.randomUUID(), role: 'assistant', text: msg || "Sorry, I couldn't do that. Please try again.", error: true }])
      }
    },
    [onChanged, onError, prefs.keep, prefs.speak],
  )

  const listen = useCallback(() => {
    hush()
    setSpeaking(false)
    void hearing.start((text) => {
      if (text.trim()) void ask(text, { spoken: true })
    })
  }, [ask, hearing])
  useEffect(() => {
    listenRef.current = listen
  }, [listen])

  const orb = () => {
    primeSpeech()
    if (hearing.state === 'listening') return hearing.stop()
    if (speaking) {
      hush()
      setSpeaking(false)
      return
    }
    if (!thinking && hearing.state === 'idle') listen()
  }

  // Space to talk (when not typing), Esc to stop.
  useEffect(() => {
    const key = (e) => {
      const field = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable
      if (e.code === 'Space' && !field && !e.repeat) {
        e.preventDefault()
        orb()
      } else if (e.key === 'Escape') {
        hearing.stop()
        hush()
        setSpeaking(false)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const mode = hearingMode()
  const state = hearing.state === 'listening' ? 'listening' : hearing.state === 'transcribing' || thinking ? 'thinking' : speaking ? 'speaking' : 'idle'
  const due = agenda.filter((a) => a.bucket === 'today' || a.bucket === 'overdue').length
  const label = {
    idle: mode ? (matchMedia('(pointer: fine)').matches ? 'Tap or press Space to talk' : 'Tap to talk') : 'Type below to ask',
    listening: hearing.interim || 'Listening…',
    thinking: 'On it…',
    speaking: 'Tap to stop',
  }[state]

  return (
    <div className="mx-auto flex max-w-2xl flex-col">
      <header className="pt-2 text-center">
        <p className="text-[26px] font-semibold tracking-tight text-white sm:text-[30px]">{greeting(new Date().getHours())}.</p>
        <p className="mt-1 text-[14px] text-ink-400">
          {due ? `You have ${due} thing${due === 1 ? '' : 's'} due today. Ask me "what's on today?"` : "Nothing due today. What can I do for you?"}
        </p>
      </header>

      {/* The orb */}
      <div className="my-8 flex flex-col items-center">
        <button
          type="button"
          onClick={orb}
          disabled={!mode && state === 'idle'}
          aria-label={state === 'listening' ? 'Stop listening' : state === 'speaking' ? 'Stop speaking' : 'Talk to Tijori'}
          className="relative grid size-32 place-items-center rounded-full outline-none focus-visible:ring-4 focus-visible:ring-pink-400/40 sm:size-36"
        >
          {state === 'listening' &&
            [0, 1, 2].map((i) => (
              <motion.span key={i} aria-hidden className="absolute inset-0 rounded-full bg-pink-500/25" initial={{ scale: 1, opacity: 0.6 }} animate={{ scale: 1.7, opacity: 0 }} transition={{ duration: 1.8, repeat: Infinity, delay: i * 0.6, ease: 'easeOut' }} />
            ))}
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-full bg-gradient-to-br from-fuchsia-500 via-pink-500 to-orange-400 shadow-2xl shadow-pink-950/50"
            animate={state === 'thinking' ? { rotate: 360 } : state === 'speaking' ? { scale: [1, 1.06, 1] } : { scale: 1, rotate: 0 }}
            transition={state === 'thinking' ? { duration: 2.4, repeat: Infinity, ease: 'linear' } : state === 'speaking' ? { duration: 0.9, repeat: Infinity } : { duration: 0.3 }}
          />
          <span className="relative text-on-accent">{state === 'listening' || state === 'speaking' ? <Square className="size-9" /> : <Mic className="size-11" />}</span>
        </button>
        <p aria-live="polite" className={`mt-5 min-h-6 max-w-md text-center text-[15px] ${state === 'listening' && hearing.interim ? 'text-white' : 'text-ink-400'}`}>{label}</p>
        {hearing.error && <p className="mt-1 text-center text-[13px] text-rose-300">{hearing.error}</p>}
      </div>

      {/* Conversation */}
      {thread.length === 0 ? (
        <div className="flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => { primeSpeech(); void ask(s) }} className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 text-[13px] text-ink-200 hover:border-white/20 hover:text-white">
              “{s}”
            </button>
          ))}
        </div>
      ) : (
        <ol className="space-y-3">
          <AnimatePresence initial={false}>
            {thread.slice(-12).map((t) => (
              <motion.li key={t.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={t.role === 'user' ? 'flex justify-end' : ''}>
                {t.role === 'user' ? (
                  <p className="max-w-[85%] rounded-2xl rounded-br-md bg-white/[0.08] px-3.5 py-2 text-[14.5px] text-white">{t.text}</p>
                ) : (
                  <div className="max-w-[92%]">
                    <p className={`text-[15px] leading-relaxed whitespace-pre-line ${t.error ? 'text-rose-300' : 'text-ink-100'}`}>{t.text}</p>
                    {t.entries?.length > 0 && t.kind && (
                      <button type="button" onClick={() => onOpen(t.kind)} className="mt-1.5 text-[12.5px] text-ink-400 underline-offset-2 hover:text-white hover:underline">
                        See it in {moduleOf(t.kind).label} →
                      </button>
                    )}
                  </div>
                )}
              </motion.li>
            ))}
          </AnimatePresence>
          {thinking && <li className="text-[14px] text-ink-500">…</li>}
          <li ref={endRef} />
        </ol>
      )}

      {/* Typing, camera and voice settings: there when needed, out of the way otherwise */}
      <div className="sticky bottom-3 mt-8">
        {typing ? (
          <form className="flex items-center gap-2 rounded-2xl border border-white/10 bg-ink-900/90 p-2 backdrop-blur-xl" onSubmit={(e) => { e.preventDefault(); primeSpeech(); void ask(typed); setTyped('') }}>
            <button type="button" aria-label="Scan a bill, warranty or label" onClick={() => camera.current?.click()} className="grid size-9 shrink-0 place-items-center rounded-xl text-ink-300 hover:bg-white/[0.06] hover:text-white"><Camera className="size-4.5" /></button>
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value.slice(0, 600))} placeholder="Ask or tell Tijori anything…" aria-label="Message" className="min-w-0 flex-1 bg-transparent px-1 text-[14.5px] text-white placeholder:text-ink-500 focus:outline-none" />
            <button type="submit" disabled={!typed.trim() || thinking} aria-label="Send" className="grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-fuchsia-500 to-orange-400 text-on-accent disabled:opacity-40"><Send className="size-4" /></button>
          </form>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[12.5px] text-ink-500">
          {mode && (
            <button type="button" onClick={() => setTyping((t) => !t)} className="inline-flex items-center gap-1.5 hover:text-white"><Keyboard className="size-3.5" /> {typing ? 'Hide keyboard' : 'Type instead'}</button>
          )}
          {!typing && <button type="button" onClick={() => camera.current?.click()} className="inline-flex items-center gap-1.5 hover:text-white"><Camera className="size-3.5" /> Scan a bill or warranty</button>}
          {canSpeak() && (
            <button type="button" onClick={() => setPref('speak', !prefs.speak)} aria-pressed={prefs.speak} className="inline-flex items-center gap-1.5 hover:text-white">
              {prefs.speak ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />} {prefs.speak ? 'Speaking replies' : 'Replies muted'}
            </button>
          )}
          {mode && (
            <label className="inline-flex cursor-pointer items-center gap-1.5 hover:text-white">
              <input type="checkbox" checked={prefs.keep} onChange={(e) => setPref('keep', e.target.checked)} /> Keep listening (conversation)
            </label>
          )}
        </div>
        <input
          ref={camera}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void compressImage(f).then(onScan)
          }}
        />
      </div>
    </div>
  )
}
