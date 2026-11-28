/**
 * Tara: a personal assistant you talk to or type to. It looks things up (weather, news, facts, rates, the time, this
 * portfolio's own code and documents), does things on this device (opens apps, sites and the products here, plays
 * music, directions, calls, messages, email, timers, calendar), remembers and reminds, and answers as the right
 * expert for each question (a chef, an architect, a supportive listener…), with rich cards and spoken replies.
 *
 * Hands-free: say "Hey Tara" (or tap the orb), speak, and pause; Tara answers and then listens for a follow-up, so a
 * conversation never needs the mic button. Say "that's all" or press Esc to stop.
 */
import { Camera, Check, ChevronDown, Copy, Mic, Music2, Radio, Send, Sparkles, Square, Volume2, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Component, useCallback, useEffect, useRef, useState } from 'react'
import { compressImage, currentPosition } from '@appcore/web/device'
import { keeperApi } from './api'
import { AssistantSettings } from './AssistantSettings'
import { ActionCard, LookupCard, WeatherIcon } from './Cards'
import { CursorGlow, Motes, Orb, Reveal, useMicLevel } from './Magic'
import { moduleOf } from './modules'
import { AUTO, GROUPS, PERSONAS, personaOf } from './personas'
import { applySetting, readPrefs, replyPrefs, writePrefs } from './prefs'
import { track } from '../../lib/visits'
import { saveChat, turnsOf, useChats } from './chats'
import { useSkin } from '../../theme/theme'
import { ambient, resolveStyle, STYLES } from './ambient'
import { Hud, useClock } from './Hud'
import { sceneOf, usePhase } from './Sky'
import { canSpeak, chime, hearingMode, hush, isGoodbye, primeSpeech, say, useVoice, useVoices, wakeSupported } from './voice'

const GRAD = 'from-fuchsia-500 via-pink-500 to-orange-400'
// Things to try, four at a time and always changing.
const IDEAS = [
  "How's the weather today?", 'Set a timer for 10 minutes', 'I have eggs, spinach and bread. What can I cook?',
  'How does the "Hey Tara" wake word work in this app?', 'Remind me to call Mom at 8 pm', 'Top news in India',
  'Postgres or MongoDB for a booking system?', "I'm feeling stressed about tomorrow", 'Convert 100 dollars to rupees',
  'What has Sidharth built?', 'Plan a relaxed weekend in Goa', 'Open CodeLens', 'Where did I keep my passport?',
  'Write a polite leave request email', 'What time is it in London?', 'Mock interview me for a React role',
]
// The orb takes on a colour for how the user seems to feel (calm for stress, warm for joy…), never a label.
const MOOD_GRAD = {
  stressed: 'from-teal-400 via-sky-500 to-indigo-500', anxious: 'from-teal-400 via-sky-500 to-indigo-500',
  sad: 'from-violet-400 via-indigo-500 to-sky-500', lonely: 'from-violet-400 via-indigo-500 to-sky-500', tired: 'from-indigo-400 via-violet-500 to-fuchsia-500',
  angry: 'from-sky-400 via-blue-500 to-indigo-600', frustrated: 'from-sky-400 via-blue-500 to-indigo-600',
  happy: 'from-amber-400 via-orange-500 to-pink-500', excited: 'from-amber-400 via-orange-500 to-pink-500', grateful: 'from-amber-400 via-orange-500 to-pink-500',
}  // prettier-ignore
const WEATHERY = /\b(weather|rain|temperature|forecast|humid|sunny|hot|cold|umbrella)\b/i
// "Play something calm", "put on some soothing music" → Tara's own background music; "stop the music" stops it.
const MUSIC_ON = /\b(play|start|put on|turn on)\b.*\b(calm|soothing|relaxing|slow|soft|ambient|background|sleep|rain|night|ocean|piano)\b.*\b(music|songs?|sounds?|something)\b|\b(background|ambient|soothing|relaxing) music\b/i
const MUSIC_OFF = /\b(stop|pause|turn off|switch off|no more|kill)\b.*\b(music|songs?|sounds?)\b|\bmute( the)? music\b/i
const MUSIC_KIND = [[/rain/i, 'rain'], [/piano/i, 'piano'], [/night|sleep/i, 'night'], [/ocean|wave|sea/i, 'ocean'], [/calm|pad/i, 'calm']]

/** A short spoken briefing, Jarvis-style: the time of day, the weather, what's due. Built here from what's on screen. */
export function briefText({ name, glance, due, hour = new Date().getHours() }) {
  const hi = `${greeting(hour)}${name ? `, ${name}` : ''}.`
  const sky = glance ? ` It's ${glance.temp} degrees and ${String(glance.text).toLowerCase()} in ${glance.place}.` : ''
  const todo = due.length === 0 ? ' Nothing is due today.' : due.length === 1 ? ` One thing is due today: ${due[0].label}.` : ` ${due.length} things are due today: ${due.slice(0, 3).map((d) => d.label).join(', ')}${due.length > 3 ? ', and more' : ''}.`
  return `${hi}${sky}${todo} Say “Hey Tara” whenever you need me.`
}

const greeting = (h) => (h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening')
let lastFix = null // { lat, lng, at }: reuse a location for 10 minutes instead of asking the device every time

async function where(prefs) {
  if (!prefs.useLocation) return null
  if (lastFix && Date.now() - lastFix.at < 600_000) return { lat: lastFix.lat, lng: lastFix.lng }
  const pos = await currentPosition().catch(() => null)
  if (pos) lastFix = { ...pos, at: Date.now() }
  return pos
}

export function Assistant({ agenda, onChanged, onOpen, onScan, onError, settingsOpen, onSettings, onWake, onGlance }) {
  const personal = useSkin() === 'personal'
  // The conversation on screen is one of Tara's chats (chats.js): new, or reopened from the list in the sidebar.
  const { current: chatId } = useChats()
  const [loaded, setLoaded] = useState(() => ({ id: chatId, turns: turnsOf(chatId) }))
  const [thread, setThread] = useState(loaded.turns) // [{ id, role, text, card?, action?, entries?, kind?, saved?, undone?, error?, persona? }]
  const [thinking, setThinking] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [voiceMode, setVoiceMode] = useState(false)
  const [followUp, setFollowUp] = useState(false)
  // Switched to another chat: show its turns, and leave whatever the old one was doing (React's "adjust state while
  // rendering" pattern, so there's no flash of the old thread).
  if (loaded.id !== chatId) {
    const turns = turnsOf(chatId)
    setLoaded({ id: chatId, turns })
    setThread(turns)
    setVoiceMode(false)
    setFollowUp(false)
    setThinking(false)
  }
  const [typed, setTyped] = useState('')
  const [prefs, setPrefs] = useState(readPrefs)
  const [persona, setPersona] = useState('auto')
  const [picking, setPicking] = useState(false)
  const [glance, setGlance] = useState(null)
  const [mood, setMood] = useState(null)
  const voices = useVoices()
  const camera = useRef(null)
  const endRef = useRef(null)
  const threadRef = useRef(thread)
  const chatRef = useRef(chatId)
  const askRef = useRef(null)
  const quiet = useRef(false) // set when the user closes voice mode: no follow-up listening after this answer
  useEffect(() => {
    threadRef.current = thread
    // Keep the chat as it grows (not when it was only reopened, so opening an old chat doesn't reorder the list).
    if (thread !== loaded.turns) saveChat(loaded.id, thread)
  }, [thread, loaded])
  // Leaving a chat stops listening and speaking (an answer still on its way is kept with the chat it belongs to).
  useEffect(() => {
    chatRef.current = chatId
    quiet.current = true
    hush()
  }, [chatId])

  const savePrefs = (next) => {
    setPrefs(next)
    writePrefs(next)
  }

  // iPhones only let a page speak after a tap: unlock speech on the first one, so "Hey Tara" can answer aloud later.
  useEffect(() => {
    const unlock = () => primeSpeech()
    window.addEventListener('pointerdown', unlock, { once: true })
    return () => window.removeEventListener('pointerdown', unlock)
  }, [])

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

  useEffect(() => {
    onGlance?.(glance)
  }, [glance, onGlance])
  const scene = sceneOf(glance?.code)
  const phase = usePhase()

  // Background music: follows the settings and, on "Match the weather", the sky. Browsers only allow sound after a
  // tap, so if it was left on it starts with the first one. Leaving Tara stops it.
  const musicStyle = resolveStyle(prefs.musicStyle, scene, phase)
  useEffect(() => {
    if (!prefs.music) return void ambient.stop()
    let off = () => {}
    void ambient.play(musicStyle, prefs.musicVolume).then((ok) => {
      if (ok) return
      const go = () => void ambient.play(musicStyle, prefs.musicVolume)
      window.addEventListener('pointerdown', go, { once: true })
      off = () => window.removeEventListener('pointerdown', go)
    })
    return () => off()
  }, [prefs.music, musicStyle, prefs.musicVolume])
  useEffect(() => () => ambient.stop(), [])

  // Braces matter: newer browsers return a Promise from scrollIntoView, and an effect may only return a cleanup.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [thread, thinking])

  // ── Hearing: "Hey Tara", the orb, and follow-ups ──────────────────────────
  const onRequest = useCallback(
    (text, { reason }) => {
      setFollowUp(false)
      if (!text || isGoodbye(text)) {
        if (prefs.sounds && reason !== 'blocked') chime(false)
        setVoiceMode(reason === 'blocked' || reason === 'error') // keep the overlay up to show what went wrong
        return
      }
      if (prefs.sounds) chime(false)
      void askRef.current?.(text, { spoken: true })
    },
    [prefs.sounds],
  )
  const busy = thinking || speaking || !!settingsOpen || picking
  const voice = useVoice({
    transcribe: keeperApi.transcribe,
    lang: prefs.lang || undefined,
    wake: !!prefs.wake,
    busy,
    onRequest,
    onWake: () => {
      quiet.current = false
      setVoiceMode(true)
      onWake?.()
      if (prefs.sounds) chime(true)
    },
  })

  const ask = useCallback(
    async (text, { spoken = false } = {}) => {
      const q = text.trim()
      if (!q) return
      track('tara_ask') // counted, never the words
      quiet.current = false
      const chat = chatRef.current
      const musicOff = MUSIC_OFF.test(q)
      if (musicOff || MUSIC_ON.test(q)) {
        const kind = MUSIC_KIND.find(([re]) => re.test(q))?.[1]
        const next = musicOff ? { ...prefs, music: false } : { ...prefs, music: true, ...(kind ? { musicStyle: kind } : {}) }
        savePrefs(next)
        const label = STYLES.find((x) => x.id === next.musicStyle)?.label.toLowerCase() ?? 'calm music'
        const reply = musicOff ? 'Music off.' : `Playing ${label}. It goes quiet while I listen. Say “stop the music” any time.`
        setThread((t) => [...t, { id: crypto.randomUUID(), role: 'user', text: q, spoken }, { id: crypto.randomUUID(), role: 'assistant', text: reply }])
        if (spoken) setVoiceMode(false)
        return
      }
      const history = threadRef.current.slice(-6).map((t) => ({ role: t.role, text: (t.text || '').slice(0, 700) }))
      setThread((t) => [...t, { id: crypto.randomUUID(), role: 'user', text: q, spoken }])
      setThinking(true)
      try {
        let pos = await where(prefs)
        // A weather question with no home city and no location shared: ask the device just this once.
        if (!pos && !prefs.city.trim() && WEATHERY.test(q)) pos = await currentPosition().catch(() => null)
        const res = await keeperApi.command(q, { history, prefs: replyPrefs(prefs), persona, ...(pos ?? {}) })
        const reply = res.reply || 'Done.'
        const created = res.action === 'add' && res.entries?.length > 0 && res.entries.every((e) => e.created_at === e.updated_at)
        const turn = {
          id: crypto.randomUUID(), role: 'assistant', text: reply, card: res.card ?? null, action: res.client_action ?? null,
          entries: res.action === 'add' || res.action === 'done' ? res.entries : [], kind: res.kind, saved: created, persona: res.persona ?? null,
        }
        if (res.action === 'add' || res.action === 'done') onChanged()
        if (chatRef.current !== chat) {
          // The user moved to another chat while this was on its way: file the answer with its own conversation.
          saveChat(chat, [...turnsOf(chat), turn])
          setThinking(false)
          return
        }
        setMood(res.emotion && res.emotion !== 'neutral' ? res.emotion : null)
        setThread((t) => [...t, turn])
        // "Speak slower", "use a female voice", "call me Sid": the user's own settings, applied right here (and the
        // reply is spoken in the new voice). Anything that can't be applied opens the settings panel instead.
        let voicePrefs = prefs
        if (res.client_action?.type === 'settings') {
          const next = res.client_action.setting === 'open' ? null : applySetting(res.client_action, prefs, voices)
          if (next) {
            savePrefs(next)
            voicePrefs = next
          } else onSettings(true)
        }
        setThinking(false)
        if (voicePrefs.speak && canSpeak()) {
          setSpeaking(true)
          await say(reply, voicePrefs)
        }
        // A conversation: after a spoken answer, listen for a follow-up (no tapping), unless the user closed it.
        if (spoken && prefs.keep && !quiet.current && hearingMode()) {
          setFollowUp(true)
          voice.listen({ followUp: true })
        } else if (spoken) setVoiceMode(false)
        setSpeaking(false)
      } catch (e) {
        setThinking(false)
        setSpeaking(false)
        setVoiceMode(false)
        if (chatRef.current !== chat) return void onError(e)
        const msg = onError(e)
        setThread((t) => [...t, { id: crypto.randomUUID(), role: 'assistant', text: msg || "Sorry, I couldn't do that. Please try again.", error: true }])
      }
    },
    [onChanged, onError, onSettings, prefs, persona, voice, voices],
  )
  useEffect(() => {
    askRef.current = ask
  }, [ask])

  const undo = async (turn) => {
    try {
      await Promise.all((turn.entries ?? []).map((e) => keeperApi.remove(e.id)))
      setThread((t) => t.map((x) => (x.id === turn.id ? { ...x, undone: true } : x)))
      onChanged()
    } catch (e) {
      onError(e)
    }
  }

  const stopAll = () => {
    quiet.current = true
    voice.cancel()
    hush()
    setSpeaking(false)
    setFollowUp(false)
    setVoiceMode(false)
  }
  const talk = () => {
    primeSpeech()
    if (voice.state === 'listening') return voice.finish() // answer now, without waiting for the pause
    if (speaking) return hush() // cut the answer short; Tara then listens for what you want instead
    if (thinking || voice.state === 'transcribing') return
    quiet.current = false
    setFollowUp(false)
    setVoiceMode(true)
    if (prefs.sounds) chime(true)
    voice.listen()
  }

  // Space to talk (when not typing), Esc to stop.
  useEffect(() => {
    const key = (e) => {
      const field = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable
      if (e.code === 'Space' && !field && !e.repeat && !settingsOpen && !picking) {
        e.preventDefault()
        talk()
      } else if (e.key === 'Escape' && voiceMode) stopAll()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const send = (text) => {
    primeSpeech()
    void ask(text)
  }
  const mode = hearingMode()
  const due = agenda.filter((a) => a.bucket === 'today' || a.bucket === 'overdue')
  const voiceState = voice.state === 'listening' ? 'listening' : voice.state === 'transcribing' || thinking ? 'thinking' : speaking ? 'speaking' : 'idle'
  const name = prefs.name.trim()
  const chosen = personaOf(persona)

  // Music hushes while Tara listens (so the microphone hears you) and dips while she speaks.
  useEffect(() => {
    ambient.duck(voiceState === 'listening' ? 0 : voiceState === 'speaking' || voiceState === 'thinking' ? 0.3 : 1)
  }, [voiceState])

  const briefMe = useCallback(async () => {
    primeSpeech()
    const text = briefText({ name, glance, due })
    setThread((t) => (t.length ? [...t, { id: crypto.randomUUID(), role: 'assistant', text }] : t))
    if (canSpeak()) {
      setSpeaking(true)
      await say(text, prefs)
      setSpeaking(false)
    }
    return text
  }, [name, glance, due, prefs])
  // "Brief me when I open Tara": once per visit, on the first tap (browsers need one before anything can speak).
  useEffect(() => {
    if (!prefs.briefOnOpen) return
    try {
      if (sessionStorage.getItem('tara-briefed')) return
    } catch {
      /* no storage: brief anyway */
    }
    const go = () => {
      try {
        sessionStorage.setItem('tara-briefed', '1')
      } catch {
        /* fine */
      }
      void briefMe()
    }
    window.addEventListener('pointerdown', go, { once: true })
    return () => window.removeEventListener('pointerdown', go)
  }, [prefs.briefOnOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative mx-auto flex min-h-[calc(100svh-7rem)] w-full max-w-3xl flex-col">
      {!personal && <Motes />}
      <CursorGlow />
      <div className="flex-1 pb-40">
        {thread.length === 0 ? (
          <Home name={name} glance={glance} due={due} mood={mood} wake={voice.wake} heard={voice.heard} onTalk={talk} onPick={send} onOpenToday={() => onOpen('today')} onSettings={onSettings}
            personal={personal} scene={scene} music={prefs.music} onBrief={() => void briefMe()} />
        ) : (
          <ol className="space-y-6 pt-2" aria-live="polite">
            <AnimatePresence initial={false}>
              {thread.map((t) => (
                <motion.li key={t.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
                  {t.role === 'user' ? (
                    <div className="flex justify-end"><p className="max-w-[85%] rounded-3xl rounded-br-lg bg-white/[0.08] px-4 py-2.5 text-[15px] text-white">{t.text}</p></div>
                  ) : (
                    <Reply t={t} prefs={prefs} onOpen={onOpen} onUndo={undo} onSettings={onSettings} />
                  )}
                </motion.li>
              ))}
            </AnimatePresence>
            {thinking && !voiceMode && (
              <li className="flex items-center gap-3">
                <Avatar />
                <span className="flex gap-1">{[0, 1, 2].map((i) => <motion.span key={i} className="size-1.5 rounded-full bg-ink-400" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1, repeat: Infinity, delay: i * 0.15 }} />)}</span>
                {persona !== 'auto' && <span className="text-[12px] text-ink-500">as {chosen.label}</span>}
              </li>
            )}
            <li ref={endRef} />
          </ol>
        )}
      </div>

      {/* Composer: who answers, then one box for typing with the mic beside it (send appears once you type) */}
      <div className="sticky bottom-[4.75rem] z-20 lg:bottom-5">
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          <button type="button" onClick={() => setPicking(true)} aria-haspopup="dialog"
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-white/10 bg-ink-900/80 py-1 pr-2.5 pl-1.5 text-[12.5px] text-ink-200 backdrop-blur-xl hover:border-white/20 hover:text-white">
            <span className={`grid size-5 place-items-center rounded-full bg-gradient-to-br ${GRAD} text-on-accent`}><chosen.icon className="size-3" /></span>
            <span className="truncate">{persona === 'auto' ? 'Auto expert' : chosen.label}</span>
            <ChevronDown className="size-3.5 shrink-0 text-ink-500" />
          </button>
          <span className="flex items-center gap-2">
            {persona !== 'auto' && <button type="button" onClick={() => setPersona('auto')} className="text-[12px] text-ink-500 hover:text-white">Back to Auto</button>}
            <MusicButton prefs={prefs} style={musicStyle} onChange={savePrefs} />
          </span>
        </div>
        <form
          className="flex items-end gap-1.5 rounded-[28px] border border-white/10 bg-ink-900/90 p-1.5 shadow-2xl shadow-black/30 backdrop-blur-xl focus-within:border-white/20"
          onSubmit={(e) => { e.preventDefault(); if (typed.trim() && !thinking) { send(typed); setTyped('') } }}
        >
          <button type="button" aria-label="Scan a bill, warranty or label" title="Scan a bill or warranty" onClick={() => camera.current?.click()} className="grid size-10 shrink-0 place-items-center rounded-full text-ink-300 hover:bg-white/[0.06] hover:text-white"><Camera className="size-5" /></button>
          <textarea
            rows={1}
            value={typed}
            onChange={(e) => setTyped(e.target.value.slice(0, 600))}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }}
            placeholder={persona === 'auto' ? 'Ask Tara anything…' : `Ask the ${chosen.label.toLowerCase()}…`}
            aria-label="Message Tara"
            className="max-h-32 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-1 py-2.5 text-[15px] text-white placeholder:text-ink-500 focus:outline-none"
          />
          {typed.trim() || !mode ? (
            <button type="submit" disabled={thinking || !typed.trim()} aria-label="Send" className={`grid size-10 shrink-0 place-items-center rounded-full bg-gradient-to-br ${GRAD} text-on-accent disabled:opacity-40`}><Send className="size-4.5" /></button>
          ) : (
            <button type="button" onClick={talk} aria-label="Talk to Tara" title="Talk (Space)" className={`grid size-10 shrink-0 place-items-center rounded-full bg-gradient-to-br ${MOOD_GRAD[mood] ?? GRAD} text-on-accent shadow-lg shadow-pink-500/25 transition hover:scale-105`}><Mic className="size-5" /></button>
          )}
        </form>
        <p className="mt-1.5 text-center text-[11px] text-ink-600">Looked-up answers show their source. Calls, messages and emails always wait for your tap.</p>
      </div>

      <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void compressImage(f).then(onScan) }} />

      <AnimatePresence>
        {voiceMode && (
          <VoiceOverlay state={voiceState} followUp={followUp} interim={voice.interim} error={voice.error} persona={persona === 'auto' ? null : chosen.label}
            lastReply={thread.at(-1)?.role === 'assistant' ? thread.at(-1).text : ''} onTap={talk} onClose={stopAll} />
        )}
        {picking && <PersonaPicker value={persona} onPick={(k) => { setPersona(k); setPicking(false) }} onClose={() => setPicking(false)} />}
      </AnimatePresence>
      {settingsOpen && <AssistantSettings prefs={prefs} onChange={savePrefs} onClose={() => onSettings(false)} />}
    </div>
  )
}

function Avatar() {
  return <span className={`grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br ${GRAD} text-on-accent shadow-md`}><Sparkles className="size-4" /></span>
}

function Reply({ t, prefs, onOpen, onUndo, onSettings }) {
  const [copied, setCopied] = useState(false)
  const who = t.persona && t.persona !== 'assistant' ? personaOf(t.persona) : null
  return (
    <div className="flex gap-3">
      <Avatar />
      <div className="min-w-0 flex-1">
        {who && <p className="mb-1 inline-flex items-center gap-1.5 text-[11.5px] font-medium text-pink-200/80"><who.icon className="size-3.5" /> {who.label}</p>}
        {t.error ? (
          <p className="text-[15.5px] leading-relaxed whitespace-pre-line text-rose-300">{t.text}</p>
        ) : (
          <Reveal text={t.text} className="text-[15.5px] leading-relaxed whitespace-pre-line text-ink-100" />
        )}
        <LookupCard card={t.card} />
        {t.action?.type === 'settings' ? (
          <button type="button" onClick={() => onSettings(true)} className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1 text-[12.5px] text-ink-300 hover:border-white/20 hover:text-white">
            Voice & personality settings →
          </button>
        ) : (
          <ActionCard action={t.action} />
        )}
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

/** Choose who answers: Auto (Tara picks per question) or one expert, grouped so twenty choices never feel like a wall. */
function PersonaPicker({ value, onPick, onClose }) {
  const first = useRef(null)
  useEffect(() => first.current?.focus(), [])
  return (
    <motion.div role="dialog" aria-modal="true" aria-label="Who should answer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center" onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <motion.div initial={{ y: 24 }} animate={{ y: 0 }} exit={{ y: 24 }} onClick={(e) => e.stopPropagation()}
        className="max-h-[85svh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border border-white/10 bg-ink-900 p-5 shadow-2xl sm:rounded-3xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[17px] font-semibold text-white">Who should answer?</p>
            <p className="text-[13px] text-ink-400">Pick an expert for your next questions, or let Tara choose each time.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-9 shrink-0 place-items-center rounded-full bg-white/[0.06] text-ink-300 hover:text-white"><X className="size-4.5" /></button>
        </div>
        <div className="mt-4"><PersonaItem p={AUTO} value={value} onPick={onPick} inputRef={first} /></div>
        {GROUPS.map((g) => (
          <section key={g} className="mt-4">
            <p className="mb-2 text-[11.5px] font-semibold tracking-wide text-ink-500 uppercase">{g}</p>
            <div className="grid gap-2 sm:grid-cols-2">{PERSONAS.filter((p) => p.group === g).map((p) => <PersonaItem key={p.key} p={p} value={value} onPick={onPick} />)}</div>
          </section>
        ))}
        <p className="mt-4 text-[11.5px] text-ink-500">Health, legal and money answers are general guidance, not professional advice.</p>
      </motion.div>
    </motion.div>
  )
}

function PersonaItem({ p, value, onPick, inputRef }) {
  return (
    <button ref={inputRef} type="button" onClick={() => onPick(p.key)} aria-pressed={value === p.key}
      className={`flex w-full items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left transition ${value === p.key ? 'border-pink-400/50 bg-pink-500/10' : 'border-white/[0.07] hover:border-white/20 hover:bg-white/[0.03]'}`}>
      <p.icon className="size-4.5 shrink-0 text-pink-200" />
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-semibold text-white">{p.label}</span>
        <span className="block truncate text-[11.5px] text-ink-400">{p.hint}</span>
      </span>
    </button>
  )
}

/** The home screen, voice first: a greeting, the orb at the centre, today at a glance, and things to try. */
function Home({ name, glance, due, mood, wake, heard, onTalk, onPick, onOpenToday, onSettings, personal, scene, music, onBrief }) {
  const clock = useClock()
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
        <span className={`tara-sheen bg-gradient-to-r ${grad} bg-clip-text text-transparent`}>{greeting(new Date().getHours())}{name ? `, ${name}` : ''}.</span>
      </h1>
      <p className="mt-1 text-[15px] text-ink-400">How can I help?</p>

      {personal ? (
        <div className="my-9 sm:my-12">
          <Hud size={270} readouts={[
            { label: 'Local time', value: clock },
            { label: glance ? glance.text : 'Weather', value: glance ? `${glance.temp}°` : '—' },
            { label: 'Due today', value: String(due.length) },
            { label: music ? 'Music' : 'Systems', value: music ? 'Playing' : 'Online' },
          ]}>
            <button type="button" onClick={onTalk} aria-label="Talk to Tara" className="group relative grid place-items-center rounded-full outline-none transition-transform duration-300 hover:scale-[1.04] focus-visible:ring-4 focus-visible:ring-pink-400/40">
              <Orb size={148}>
                <Mic className="size-12 drop-shadow transition group-hover:scale-110" />
              </Orb>
            </button>
          </Hud>
        </div>
      ) : (
        <button type="button" onClick={onTalk} aria-label="Talk to Tara" className="group relative my-12 grid place-items-center rounded-full outline-none transition-transform duration-300 hover:scale-[1.04] focus-visible:ring-4 focus-visible:ring-pink-400/40">
          <Orb size={148}>
            <Mic className="size-12 drop-shadow transition group-hover:scale-110" />
          </Orb>
        </button>
      )}
      <p className="text-[14px] text-ink-300">
        Tap the orb{wakeSupported() ? <> or say <span className="font-semibold text-white">“Hey Tara”</span></> : ''}, then just talk. I'll answer when you pause.
      </p>
      <WakeStatus state={wake} onSettings={onSettings} />
      {personal && canSpeak() && (
        <button type="button" onClick={onBrief} className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-[12.5px] font-medium text-ink-200 backdrop-blur hover:border-white/25 hover:text-white">
          <Radio className="size-3.5" /> Brief me{scene && scene !== 'clear' ? ` · ${scene === 'storm' ? 'storm' : scene} outside` : ''}
        </button>
      )}
      {heard && <p aria-live="polite" className="mt-1 max-w-sm truncate text-[12px] text-ink-500">Heard “{heard}”. Say “Hey Tara” first to wake me.</p>}

      <div className={`mt-8 grid w-full max-w-xl gap-3 text-left sm:grid-cols-2 ${personal && glance ? 'hidden' : ''}`}>
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
        <button type="button" onClick={onOpenToday} className={`flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-gradient-to-br from-orange-400/10 to-transparent p-3 text-left hover:border-white/15 ${personal ? 'hidden' : ''}`}>
          <span className={`grid size-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${GRAD} text-[14px] font-semibold text-on-accent`}>{due.length}</span>
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold text-white">{due.length ? `${due.length} due today` : 'Nothing due today'}</span>
            <span className="block truncate text-[12px] text-ink-400">{due[0]?.label ?? 'Ask me to remind you of anything'}</span>
          </span>
        </button>
      </div>

      {personal ? (
        <div className="mt-7 w-full max-w-2xl">
          <p className="mb-2 text-[12px] text-ink-500">Try saying</p>
          <div className="relative overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_10%,#000_90%,transparent)]">
            <div className="tara-stream">
              {[...IDEAS, ...IDEAS].map((s, i) => (
                <button key={i} type="button" onClick={() => onPick(s)} tabIndex={i < IDEAS.length ? 0 : -1} aria-hidden={i >= IDEAS.length || undefined}
                  className="shrink-0 rounded-full border border-white/[0.1] bg-white/[0.04] px-3.5 py-1.5 text-[13px] whitespace-nowrap text-ink-200 backdrop-blur hover:border-white/25 hover:text-white">“{s}”</button>
              ))}
            </div>
          </div>
        </div>
      ) : (
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
      )}
    </div>
  )
}

/** Background music on and off, its sound and volume, from the composer. */
function MusicButton({ prefs, style, onChange }) {
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  useEffect(() => {
    if (!open) return
    const close = (e) => (e.key === 'Escape' || (e.type === 'pointerdown' && !box.current?.contains(e.target))) && setOpen(false)
    window.addEventListener('keydown', close)
    window.addEventListener('pointerdown', close)
    return () => {
      window.removeEventListener('keydown', close)
      window.removeEventListener('pointerdown', close)
    }
  }, [open])
  if (!ambient.supported) return null
  const set = (k, v) => onChange({ ...prefs, [k]: v })
  const now = STYLES.find((x) => x.id === style)?.label
  return (
    <span ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={prefs.music ? `Music: ${now}` : 'Background music'}
        className={`inline-flex items-center gap-1.5 rounded-full border py-1 pr-2.5 pl-2 text-[12.5px] backdrop-blur-xl transition ${prefs.music ? 'border-pink-400/40 bg-pink-500/10 text-pink-100' : 'border-white/10 bg-ink-900/80 text-ink-300 hover:text-white'}`}>
        <Music2 className={`size-3.5 ${prefs.music ? 'animate-pulse' : ''}`} /> <span className="hidden sm:inline">{prefs.music ? now : 'Music'}</span>
      </button>
      {open && (
        <span role="dialog" aria-label="Background music" className="absolute right-0 bottom-full z-30 mb-2 block w-64 rounded-2xl border border-white/10 bg-ink-900 p-3 text-left shadow-2xl shadow-black/40">
          <label className="flex items-center justify-between gap-3 text-[13px] font-semibold text-white">
            Soothing music
            <input type="checkbox" className="size-4 accent-pink-500" checked={prefs.music} onChange={(e) => set('music', e.target.checked)} />
          </label>
          <span className="mt-2 block space-y-0.5">
            {STYLES.map((x) => (
              <button key={x.id} type="button" onClick={() => onChange({ ...prefs, music: true, musicStyle: x.id })}
                className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-[12.5px] ${prefs.musicStyle === x.id ? 'bg-white/[0.08] text-white' : 'text-ink-300 hover:bg-white/[0.04] hover:text-white'}`}>
                {x.label}{x.id === 'weather' && prefs.musicStyle === 'weather' && <span className="text-[11px] text-ink-500">now: {now}</span>}
              </button>
            ))}
          </span>
          <input type="range" min="0.05" max="1" step="0.05" value={prefs.musicVolume} onChange={(e) => set('musicVolume', Number(e.target.value))} aria-label="Music volume" className="mt-2 w-full accent-pink-500" />
          <span className="mt-1 block text-[11px] text-ink-500">Made in your browser. Quiet while I listen.</span>
        </span>
      )}
    </span>
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
  if (state === 'error') return <p className={`${base} text-amber-300`}>“Hey Tara” couldn't start in this browser. Tap the orb instead.</p>
  if (state === 'unsupported') return <p className={`${base} text-ink-500`}>“Hey Tara” needs Chrome, Edge or Safari. Tap the orb instead.</p>
  return (
    <button type="button" onClick={() => onSettings(true)} className={`${base} text-ink-500 underline-offset-2 hover:text-white hover:underline`}>
      Turn on “Hey Tara”
    </button>
  )
}

/** Full-screen voice mode, like the assistants on your phone: the orb, your words as you speak, and Tara's reply. */
// The orb follows your voice on desktops; phones skip the extra microphone stream (iOS can drop recognition for it).
const METER = typeof navigator !== 'undefined' && !/iP(hone|ad|od)|Android/i.test(navigator.userAgent)

function VoiceOverlay({ state, followUp, interim, error, persona, lastReply, onTap, onClose }) {
  const level = useMicLevel(METER && state === 'listening')
  const caption = { listening: interim || (followUp ? 'Anything else?' : 'Listening…'), thinking: 'Thinking…', speaking: lastReply, idle: 'Tap to talk' }[state]
  const hint = {
    listening: interim ? "I'll answer when you pause · tap the orb to send now" : followUp ? "Keep talking, or say “that's all”" : 'Go ahead, I’m listening',
    speaking: 'Tap the orb to interrupt',
    thinking: persona ? `Answering as ${persona}` : '',
    idle: '',
  }[state]
  return (
    <motion.div role="dialog" aria-modal="true" aria-label="Voice mode" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-ink-950/95 px-6 backdrop-blur-2xl">
      <button type="button" onClick={onClose} aria-label="Close voice mode" className="absolute top-5 right-5 grid size-10 place-items-center rounded-full bg-white/[0.06] text-ink-200 hover:text-white"><X className="size-5" /></button>
      <button type="button" onClick={onTap} aria-label={state === 'listening' ? 'Send now' : state === 'speaking' ? 'Interrupt' : 'Talk'} className="relative grid place-items-center rounded-full outline-none focus-visible:ring-4 focus-visible:ring-pink-400/40">
        <Orb state={state} size={196} levelRef={level}>
          {state === 'speaking' ? <Square className="size-11" /> : state === 'listening' ? <Send className="size-11" /> : <Mic className="size-12" />}
        </Orb>
      </button>
      <p aria-live="polite" className="mt-10 line-clamp-6 max-w-xl text-center text-[20px] leading-snug text-white sm:text-[24px]">{caption}</p>
      {hint && <p className="mt-3 text-center text-[13px] text-ink-400">{hint}</p>}
      {error && <p className="mt-3 text-center text-[14px] text-rose-300">{error}</p>}
      <p className="absolute bottom-8 text-[12.5px] text-ink-500">Press Esc to close</p>
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
