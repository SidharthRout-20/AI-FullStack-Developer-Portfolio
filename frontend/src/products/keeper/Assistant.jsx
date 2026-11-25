/**
 * Tara: a personal assistant you talk to or type to. It looks things up (weather, news, facts, rates, the time),
 * does things on this device (opens apps and sites, plays music, directions, calls, messages, email, timers, calendar),
 * remembers and reminds, and answers questions, with rich cards and spoken replies.
 *
 * Layout, after the assistants people already use: a home screen with a greeting, today at a glance and what Tara
 * can do; then a conversation with answer cards; a composer pinned to the bottom; and a full-screen voice mode.
 */
import { Camera, Check, Copy, Keyboard, Mic, Send, Sparkles, Square, Volume2, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Component, useCallback, useEffect, useRef, useState } from 'react'
import { compressImage, currentPosition } from '@appcore/web/device'
import { keeperApi } from './api'
import { AssistantSettings } from './AssistantSettings'
import { ActionCard, LookupCard, WeatherIcon } from './Cards'
import { moduleOf } from './modules'
import { readPrefs, replyPrefs, writePrefs } from './prefs'
import { afterWake, canSpeak, chime, hearingMode, hush, primeSpeech, say, useHearing, useWakeWord, wakeSupported } from './voice'

const GRAD = 'from-fuchsia-500 via-pink-500 to-orange-400'
// Things to try, four at a time and always changing.
const IDEAS = [
  "How's the weather today?", 'Top news in India', 'Set a timer for 10 minutes', 'Play lo-fi music',
  'Remind me to call Mom at 8 pm', 'Who is Sundar Pichai?', 'Convert 100 dollars to rupees', 'Open YouTube',
  'Directions to the airport', 'I parked on level 2, B14', 'What time is it in London?', 'Add a dentist appointment on Friday at 4 pm',
  'Message Ravi on WhatsApp: running late', 'Where did I keep my passport?', "I'm feeling stressed today", 'What can you do?',
]
// The orb takes on a colour for how the user seems to feel (calm for stress, warm for joy…), never a label.
const MOOD_GRAD = {
  stressed: 'from-teal-400 via-sky-500 to-indigo-500', anxious: 'from-teal-400 via-sky-500 to-indigo-500',
  sad: 'from-violet-400 via-indigo-500 to-sky-500', lonely: 'from-violet-400 via-indigo-500 to-sky-500', tired: 'from-indigo-400 via-violet-500 to-fuchsia-500',
  angry: 'from-sky-400 via-blue-500 to-indigo-600', frustrated: 'from-sky-400 via-blue-500 to-indigo-600',
  happy: 'from-amber-400 via-orange-500 to-pink-500', excited: 'from-amber-400 via-orange-500 to-pink-500', grateful: 'from-amber-400 via-orange-500 to-pink-500',
}  // prettier-ignore
const WAKE_REPLIES = ['Yes? How can I help?', "I'm here. What do you need?", 'Hi! What can I do for you?', "Hey! I'm listening."]
const WEATHERY = /\b(weather|rain|temperature|forecast|humid|sunny|hot|cold|umbrella)\b/i

const greeting = (h) => (h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening')
let lastFix = null // { lat, lng, at }: reuse a location for 10 minutes instead of asking the device every time

async function where(prefs) {
  if (!prefs.useLocation) return null
  if (lastFix && Date.now() - lastFix.at < 600_000) return { lat: lastFix.lat, lng: lastFix.lng }
  const pos = await currentPosition().catch(() => null)
  if (pos) lastFix = { ...pos, at: Date.now() }
  return pos
}

export function Assistant({ agenda, onChanged, onOpen, onScan, onError, settingsOpen, onSettings }) {
  const [thread, setThread] = useState([]) // [{ id, role, text, card?, action?, entries?, kind?, saved?, undone?, error? }]
  const [thinking, setThinking] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [voiceMode, setVoiceMode] = useState(false)
  const [typed, setTyped] = useState('')
  const [prefs, setPrefs] = useState(readPrefs)
  const [glance, setGlance] = useState(null)
  const [mood, setMood] = useState(null)
  const [typing, setTyping] = useState(() => !hearingMode())
  const hearing = useHearing(keeperApi.transcribe)
  const camera = useRef(null)
  const endRef = useRef(null)
  const threadRef = useRef(thread)
  const listenRef = useRef(null)
  useEffect(() => {
    threadRef.current = thread
  }, [thread])

  const savePrefs = (next) => {
    setPrefs(next)
    writePrefs(next)
  }

  // Today's weather for the home screen: home city, or this device's location if allowed.
  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await where(prefs)
      if (!prefs.city.trim() && !pos) return
      const res = await keeperApi.glance({ city: prefs.city.trim(), ...(pos ?? {}) }).catch(() => null)
      if (alive) setGlance(res?.weather ?? null)
    })()
    return () => {
      alive = false
    }
  }, [prefs])

  // Braces matter: newer browsers return a Promise from scrollIntoView, and an effect may only return a cleanup.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [thread, thinking])

  const ask = useCallback(
    async (text, { spoken = false } = {}) => {
      const q = text.trim()
      if (!q) return
      const history = threadRef.current.slice(-6).map((t) => ({ role: t.role, text: (t.text || '').slice(0, 700) }))
      setThread((t) => [...t, { id: crypto.randomUUID(), role: 'user', text: q }])
      setThinking(true)
      try {
        let pos = await where(prefs)
        // A weather question with no home city and no location shared: ask the device just this once.
        if (!pos && !prefs.city.trim() && WEATHERY.test(q)) pos = await currentPosition().catch(() => null)
        const res = await keeperApi.command(q, { history, prefs: replyPrefs(prefs), ...(pos ?? {}) })
        setMood(res.emotion && res.emotion !== 'neutral' ? res.emotion : null)
        const reply = res.reply || 'Done.'
        const created = res.action === 'add' && res.entries?.length > 0 && res.entries.every((e) => e.created_at === e.updated_at)
        setThread((t) => [...t, {
          id: crypto.randomUUID(), role: 'assistant', text: reply, card: res.card ?? null, action: res.client_action ?? null,
          entries: res.action === 'add' || res.action === 'done' ? res.entries : [], kind: res.kind, saved: created,
        }])
        if (res.action === 'add' || res.action === 'done') onChanged()
        setThinking(false)
        if (prefs.speak && canSpeak()) {
          setSpeaking(true)
          await say(reply, prefs)
          setSpeaking(false)
        }
        if (spoken && prefs.keep) listenRef.current?.()
        else if (spoken) setVoiceMode(false)
      } catch (e) {
        setThinking(false)
        setVoiceMode(false)
        const msg = onError(e)
        setThread((t) => [...t, { id: crypto.randomUUID(), role: 'assistant', text: msg || "Sorry, I couldn't do that. Please try again.", error: true }])
      }
    },
    [onChanged, onError, prefs],
  )

  const undo = async (turn) => {
    try {
      await Promise.all((turn.entries ?? []).map((e) => keeperApi.remove(e.id)))
      setThread((t) => t.map((x) => (x.id === turn.id ? { ...x, undone: true } : x)))
      onChanged()
    } catch (e) {
      onError(e)
    }
  }

  const listen = useCallback(() => {
    hush()
    setSpeaking(false)
    setVoiceMode(true)
    if (prefs.sounds) chime(true)
    void hearing.start(
      (text) => {
        if (prefs.sounds) chime(false)
        if (text.trim()) void ask(text, { spoken: true })
        else setVoiceMode(false)
      },
      { lang: prefs.lang || undefined },
    )
  }, [ask, hearing, prefs.lang, prefs.sounds])
  useEffect(() => {
    listenRef.current = listen
  }, [listen])

  const stopAll = () => {
    hearing.stop()
    hush()
    setSpeaking(false)
    setVoiceMode(false)
  }
  const talk = () => {
    primeSpeech()
    if (hearing.state === 'listening') return hearing.stop()
    if (speaking) return stopAll()
    if (!thinking && hearing.state === 'idle') listen()
  }

  // Space to talk (when not typing), Esc to stop.
  useEffect(() => {
    const key = (e) => {
      const field = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable
      if (e.code === 'Space' && !field && !e.repeat && !settingsOpen) {
        e.preventDefault()
        talk()
      } else if (e.key === 'Escape') stopAll()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  // "Hey Tara": greet, then take the request (said in the same breath, or the next thing said).
  // Paused while Tara is already listening, thinking or talking, and while settings are open.
  const wakeOn = !!prefs.wake && !voiceMode && !thinking && !speaking && hearing.state === 'idle' && !settingsOpen
  const wake = useWakeWord({
    enabled: wakeOn,
    lang: prefs.lang || undefined,
    onWake: async (rest) => {
      if (prefs.sounds) chime(true)
      if (rest && rest.split(/\s+/).length >= 2 && afterWake(rest) === null) {
        setVoiceMode(true)
        void ask(rest, { spoken: true })
        return
      }
      setVoiceMode(true)
      setSpeaking(true)
      await say(WAKE_REPLIES[Math.floor(Math.random() * WAKE_REPLIES.length)], prefs)
      setSpeaking(false)
      listen()
    },
  })

  const send = (text) => {
    primeSpeech()
    void ask(text)
  }
  const mode = hearingMode()
  const due = agenda.filter((a) => a.bucket === 'today' || a.bucket === 'overdue')
  const voiceState = hearing.state === 'listening' ? 'listening' : hearing.state === 'transcribing' || thinking ? 'thinking' : speaking ? 'speaking' : 'idle'
  const name = prefs.name.trim()

  return (
    <div className="relative mx-auto flex min-h-[calc(100svh-7rem)] w-full max-w-3xl flex-col">
      <div className="flex-1 pb-36">
        {thread.length === 0 ? (
          <Home name={name} glance={glance} due={due} mood={mood} wake={wake} onTalk={talk} onPick={send} onOpenToday={() => onOpen('today')} onSettings={onSettings} />
        ) : (
          <ol className="space-y-6 pt-2">
            <li className="flex justify-end">
              <button type="button" onClick={() => { stopAll(); setThread([]) }} className="text-[12px] text-ink-500 hover:text-white">New conversation</button>
            </li>
            <AnimatePresence initial={false}>
              {thread.map((t) => (
                <motion.li key={t.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
                  {t.role === 'user' ? (
                    <div className="flex justify-end"><p className="max-w-[85%] rounded-3xl rounded-br-lg bg-white/[0.08] px-4 py-2.5 text-[15px] text-white">{t.text}</p></div>
                  ) : (
                    <Reply t={t} prefs={prefs} onOpen={onOpen} onUndo={undo} />
                  )}
                </motion.li>
              ))}
            </AnimatePresence>
            {thinking && !voiceMode && (
              <li className="flex items-center gap-3">
                <Avatar />
                <span className="flex gap-1">{[0, 1, 2].map((i) => <motion.span key={i} className="size-1.5 rounded-full bg-ink-400" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: i * 0.15 }} />)}</span>
              </li>
            )}
            <li ref={endRef} />
          </ol>
        )}
      </div>

      {/* Dock: keyboard · mic · camera, like a phone's assistant; the text box only when you choose to type */}
      <div className="sticky bottom-[4.75rem] z-20 lg:bottom-5">
        {typing ? (
          <form
            className="flex items-end gap-2 rounded-[28px] border border-white/10 bg-ink-900/90 p-2 shadow-2xl shadow-black/30 backdrop-blur-xl focus-within:border-white/20"
            onSubmit={(e) => { e.preventDefault(); if (typed.trim() && !thinking) { send(typed); setTyped('') } }}
          >
            {mode && <button type="button" aria-label="Talk instead" title="Talk instead" onClick={() => setTyping(false)} className="grid size-10 shrink-0 place-items-center rounded-full text-ink-300 hover:bg-white/[0.06] hover:text-white"><Mic className="size-5" /></button>}
            <textarea
              rows={1}
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value.slice(0, 600))}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }}
              placeholder="Type to Tara…"
              aria-label="Message Tara"
              className="max-h-32 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-1 py-2.5 text-[15px] text-white placeholder:text-ink-500 focus:outline-none"
            />
            <button type="submit" disabled={thinking || !typed.trim()} aria-label="Send" className={`grid size-10 shrink-0 place-items-center rounded-full bg-gradient-to-br ${GRAD} text-on-accent disabled:opacity-40`}><Send className="size-4.5" /></button>
          </form>
        ) : (
          <div className="mx-auto flex w-fit items-center gap-5 rounded-full border border-white/10 bg-ink-900/80 px-4 py-2 shadow-2xl shadow-black/30 backdrop-blur-xl">
            <button type="button" aria-label="Type instead" title="Type instead" onClick={() => setTyping(true)} className="grid size-11 place-items-center rounded-full text-ink-300 hover:bg-white/[0.06] hover:text-white"><Keyboard className="size-5" /></button>
            <button type="button" onClick={talk} aria-label="Talk to Tara" title="Talk (Space)" className={`grid size-14 place-items-center rounded-full bg-gradient-to-br ${MOOD_GRAD[mood] ?? GRAD} text-on-accent shadow-lg shadow-pink-500/30 transition hover:scale-105`}><Mic className="size-6" /></button>
            <button type="button" aria-label="Scan a bill, warranty or label" title="Scan a bill or warranty" onClick={() => camera.current?.click()} className="grid size-11 place-items-center rounded-full text-ink-300 hover:bg-white/[0.06] hover:text-white"><Camera className="size-5" /></button>
          </div>
        )}
        <p className="mt-1.5 text-center text-[11px] text-ink-600">Looked-up answers show their source. Calls, messages and emails always wait for your tap.</p>
      </div>

      <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void compressImage(f).then(onScan) }} />

      <AnimatePresence>
        {voiceMode && <VoiceOverlay grad={MOOD_GRAD[mood] ?? GRAD} state={voiceState} interim={hearing.interim} error={hearing.error} lastReply={thread.at(-1)?.role === 'assistant' ? thread.at(-1).text : ''} onTap={talk} onClose={stopAll} />}
      </AnimatePresence>
      {settingsOpen && <AssistantSettings prefs={prefs} onChange={savePrefs} onClose={() => onSettings(false)} />}
    </div>
  )
}

function Avatar() {
  return <span className={`grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br ${GRAD} text-on-accent shadow-md`}><Sparkles className="size-4" /></span>
}

function Reply({ t, prefs, onOpen, onUndo }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex gap-3">
      <Avatar />
      <div className="min-w-0 flex-1">
        <p className={`text-[15.5px] leading-relaxed whitespace-pre-line ${t.error ? 'text-rose-300' : 'text-ink-100'}`}>{t.text}</p>
        <LookupCard card={t.card} />
        <ActionCard action={t.action} />
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-500">
          {t.entries?.length > 0 && t.kind && <button type="button" onClick={() => onOpen(t.kind)} className="hover:text-white">See it in {moduleOf(t.kind).label} →</button>}
          {t.saved && !t.undone && <button type="button" onClick={() => void onUndo(t)} className="hover:text-white">Undo</button>}
          {t.undone && <span>Undone</span>}
          {!t.error && canSpeak() && <button type="button" aria-label="Read aloud" title="Read aloud" onClick={() => void say(t.text, prefs)} className="hover:text-white"><Volume2 className="size-3.5" /></button>}
          {!t.error && (
            <button type="button" aria-label="Copy" title="Copy" onClick={() => void navigator.clipboard.writeText(t.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })} className="hover:text-white">
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** The home screen, voice first: a greeting, the orb at the centre, today at a glance, and things to try. */
function Home({ name, glance, due, mood, wake, onTalk, onPick, onOpenToday, onSettings }) {
  const [page, setPage] = useState(0)
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    if (paused) return
    const t = setInterval(() => setPage((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [paused])
  const shown = Array.from({ length: 4 }, (_, i) => IDEAS[(page * 4 + i) % IDEAS.length])
  const grad = MOOD_GRAD[mood] ?? GRAD
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  return (
    <div className="flex flex-col items-center pt-4 text-center sm:pt-8">
      <p className="text-[13px] text-ink-500">{today}</p>
      <h1 className="mt-1 text-[30px] leading-tight font-semibold tracking-tight sm:text-[40px]">
        <span className={`bg-gradient-to-r ${grad} bg-clip-text text-transparent`}>{greeting(new Date().getHours())}{name ? `, ${name}` : ''}.</span>
      </h1>
      <p className="mt-1 text-[15px] text-ink-400">How can I help?</p>

      <button type="button" onClick={onTalk} aria-label="Talk to Tara" className="group relative my-9 grid size-36 place-items-center rounded-full outline-none focus-visible:ring-4 focus-visible:ring-pink-400/40 sm:size-44">
        {[0, 1].map((i) => (
          <motion.span key={i} aria-hidden className={`absolute inset-0 rounded-full bg-gradient-to-br ${grad}`} initial={{ scale: 1, opacity: 0.25 }} animate={{ scale: 1.35, opacity: 0 }} transition={{ duration: 3, repeat: Infinity, delay: i * 1.5, ease: 'easeOut' }} />
        ))}
        <motion.span aria-hidden className={`absolute inset-0 rounded-full bg-gradient-to-br ${grad} shadow-2xl shadow-pink-500/30`} animate={{ scale: [1, 1.03, 1] }} transition={{ duration: 3, repeat: Infinity }} />
        <Mic className="relative size-12 text-on-accent transition group-hover:scale-110 sm:size-14" />
      </button>
      <p className="text-[14px] text-ink-300">
        Tap the mic{wakeSupported() ? <> or say <span className="font-semibold text-white">“Hey Tara”</span></> : ''}
      </p>
      <WakeStatus state={wake} onSettings={onSettings} />

      <div className="mt-8 grid w-full max-w-xl gap-3 text-left sm:grid-cols-2">
        {glance ? (
          <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-gradient-to-br from-sky-500/10 to-transparent p-3">
            <WeatherIcon code={glance.code} className="size-8 shrink-0 text-sky-200" strokeWidth={1.5} />
            <div className="min-w-0">
              <p className="text-[18px] leading-none font-semibold text-white tabular-nums">{glance.temp}° <span className="text-[12.5px] font-normal text-ink-300 capitalize">{glance.text}</span></p>
              <p className="mt-0.5 truncate text-[12px] text-ink-400">{glance.place}</p>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => onSettings(true)} className="flex items-center gap-3 rounded-2xl border border-dashed border-white/10 p-3 text-left hover:border-white/20">
            <WeatherIcon code={null} className="size-8 shrink-0 text-ink-500" strokeWidth={1.5} />
            <span className="text-[12.5px] text-ink-300">Add your city to see the weather here</span>
          </button>
        )}
        <button type="button" onClick={onOpenToday} className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-gradient-to-br from-orange-400/10 to-transparent p-3 text-left hover:border-white/15">
          <span className={`grid size-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${GRAD} text-[14px] font-semibold text-on-accent`}>{due.length}</span>
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold text-white">{due.length ? `${due.length} due today` : 'Nothing due today'}</span>
            <span className="block truncate text-[12px] text-ink-400">{due[0]?.label ?? 'Ask me to remind you of anything'}</span>
          </span>
        </button>
      </div>

      <div className="mt-7 w-full max-w-xl" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
        <p className="mb-2 text-[12px] text-ink-500">Try saying</p>
        <AnimatePresence mode="wait">
          <motion.div key={page % Math.ceil(IDEAS.length / 4)} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.35 }} className="flex flex-wrap justify-center gap-2">
            {shown.map((s) => (
              <button key={s} type="button" onClick={() => onPick(s)} className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 text-[13px] text-ink-200 hover:border-white/20 hover:text-white">“{s}”</button>
            ))}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

/** Where "Hey Tara" stands, always in plain words (it should never silently not work). */
function WakeStatus({ state, onSettings }) {
  const base = 'mt-2 inline-flex items-center gap-1.5 text-[12px]'
  if (state === 'listening')
    return <p className={`${base} text-emerald-300`}><span className="size-1.5 animate-pulse rounded-full bg-emerald-400" /> Listening for “Hey Tara”</p>
  if (state === 'waiting') return <p className={`${base} text-ink-400`}><span className="size-1.5 rounded-full bg-amber-400" /> Tap anywhere once to switch on “Hey Tara”</p>
  if (state === 'blocked')
    return <p className={`${base} max-w-sm text-rose-300`}>The microphone is blocked for this site. Allow it from the lock icon in the address bar, then reload.</p>
  if (state === 'error') return <p className={`${base} text-amber-300`}>“Hey Tara” couldn't start in this browser. Tap the mic instead.</p>
  if (state === 'unsupported') return <p className={`${base} text-ink-500`}>“Hey Tara” needs Chrome, Edge or Safari. Tap the mic instead.</p>
  return (
    <button type="button" onClick={() => onSettings(true)} className={`${base} text-ink-500 underline-offset-2 hover:text-white hover:underline`}>
      Turn on “Hey Tara”
    </button>
  )
}

/** Full-screen voice mode, like the assistants on your phone: the orb, your words as you speak, and Tara's reply. */
function VoiceOverlay({ grad, state, interim, error, lastReply, onTap, onClose }) {
  const caption = { listening: interim || 'Listening…', thinking: 'Thinking…', speaking: lastReply, idle: 'Tap to talk' }[state]
  return (
    <motion.div role="dialog" aria-modal="true" aria-label="Voice mode" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-ink-950/95 px-6 backdrop-blur-2xl">
      <button type="button" onClick={onClose} aria-label="Close voice mode" className="absolute top-5 right-5 grid size-10 place-items-center rounded-full bg-white/[0.06] text-ink-200 hover:text-white"><X className="size-5" /></button>
      <button type="button" onClick={onTap} aria-label={state === 'listening' ? 'Stop listening' : 'Talk'} className="relative grid size-44 place-items-center rounded-full sm:size-52">
        {(state === 'listening' || state === 'speaking') &&
          [0, 1, 2].map((i) => (
            <motion.span key={i} aria-hidden className={`absolute inset-0 rounded-full bg-gradient-to-br ${grad}`} initial={{ scale: 1, opacity: 0.35 }} animate={{ scale: 1.6, opacity: 0 }} transition={{ duration: 2, repeat: Infinity, delay: i * 0.66, ease: 'easeOut' }} />
          ))}
        <motion.span aria-hidden className={`absolute inset-0 rounded-full bg-gradient-to-br ${grad} shadow-2xl shadow-pink-500/40`}
          animate={state === 'thinking' ? { rotate: 360, scale: [1, 0.94, 1] } : state === 'speaking' ? { scale: [1, 1.07, 1] } : { scale: [1, 1.03, 1] }}
          transition={state === 'thinking' ? { duration: 1.6, repeat: Infinity, ease: 'linear' } : { duration: state === 'speaking' ? 0.8 : 2.4, repeat: Infinity }} />
        <span className="relative text-on-accent">{state === 'listening' || state === 'speaking' ? <Square className="size-12" /> : <Mic className="size-14" />}</span>
      </button>
      <p aria-live="polite" className="mt-10 max-w-xl text-center text-[20px] leading-snug text-white sm:text-[24px]">{caption}</p>
      {error && <p className="mt-3 text-center text-[14px] text-rose-300">{error}</p>}
      <p className="absolute bottom-8 text-[12.5px] text-ink-500">Tap the orb to {state === 'listening' ? 'finish' : state === 'speaking' ? 'stop' : 'talk'} · Esc to close</p>
    </motion.div>
  )
}

/** If something unexpected breaks the assistant, say so and offer a way back instead of a blank screen. */
export class AssistantBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <p className="text-[18px] font-semibold text-white">Something went wrong on this screen.</p>
        <p className="mt-1 text-[14px] text-ink-400">Your saved things are safe. Start a fresh conversation to carry on.</p>
        <button type="button" onClick={() => this.setState({ failed: false })} className={`mt-5 rounded-full bg-gradient-to-r ${GRAD} px-5 py-2 text-[14px] font-semibold text-on-accent`}>Start again</button>
      </div>
    )
  }
}
