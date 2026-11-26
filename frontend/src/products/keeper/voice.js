/**
 * Tara's voice: hear requests and speak replies, on laptops and phones.
 *
 * Hearing uses the browser's own speech recognition where it exists (Chrome, Edge, Safari on Mac and iPhone,
 * Android), with words appearing as you speak. Elsewhere (Firefox, some in-app browsers) it records a clip and the
 * server transcribes it with Whisper. Speaking uses the browser's built-in voices; nothing is installed.
 *
 * One microphone session covers "Hey Tara" and the request that follows, so nothing is lost handing the microphone
 * from one recogniser to another, and nobody has to touch the mic button. A request ends when the speaker pauses:
 * briefly after a sentence that sounds finished, longer after one that doesn't ("…and", "…to the", "um").
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export const END_MS = 1800 // quiet after a finished-sounding sentence that ends the request
export const HOLD_MS = 3500 // quiet allowed after an unfinished-sounding one ("remind me to… um")
export const NO_SPEECH_MS = 8000 // nobody said anything
export const FOLLOW_UP_MS = 7000 // after Tara answers, how long she waits for a follow-up
const MAX_MS = 60_000 // one request, however long

// Words a sentence rarely ends on: hearing one of these last means the speaker is still going.
const DANGLING =
  /\b(and|or|but|so|because|then|to|the|a|an|of|for|with|without|in|on|at|from|by|about|into|my|your|our|their|his|her|this|that|these|is|are|was|were|be|will|can|could|should|would|if|when|what|which|who|how|where|like|um+|uh+|er+|hmm+|also|plus|maybe|i|i'm|it's|than|between)\s*$/i

/** How long to wait for more after hearing `text`. */
export const pauseFor = (text) => (DANGLING.test(text.trim()) ? HOLD_MS : END_MS)

/** "That's all", "stop", "never mind": the end of a conversation, not a request. */
export const isGoodbye = (text) =>
  /^\s*(stop|cancel|never ?mind|nothing|no(pe)?|no thanks?( you)?|that'?s (all|it)( for now)?|(ok(ay)?,? )?thanks?( you)?,? that'?s (all|it)|bye|goodbye|see you|i'?m done)[.!\s]*$/i.test(text)

const recognizer = () => (typeof window === 'undefined' ? null : window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null)
const canRecord = () => typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'

/** How this device can hear: 'native' (live words), 'record' (clip → server), or null (type instead). */
export const hearingMode = () => (recognizer() ? 'native' : canRecord() ? 'record' : null)
export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window
export const wakeSupported = () => !!recognizer()

// "Hey Tara" (and how speech recognisers tend to hear it), or "Tara, …" as the first thing said.
// Includes how recognisers mishear it in different accents ("hey there", "hey Tyra", "hey Dara").
const NAMES = 'tara|tarah|taara|tarra|terra|tera|terah|thara|tharra|dara|dhara|sara|sarah|tora|tiara|tyra|there|tarot|kara|zara'
const WAKE = new RegExp(`\\b(?:hey|hi|hello|ok|okay|hay|hai|a|he)[\\s,.!-]*(?:${NAMES})\\b[\\s,.!?]*`, 'i')
const GLUED = /\b(?:hey|hi|he|hay)(?:tara|taara|tera|terra)\b[\s,.!?]*/i // "Hetara", "heytara"
const LEADING = /^\s*(?:tara|taara|tarah)\b[\s,.!?]*/i

/** Split a transcript at the wake phrase: null if it isn't there, else whatever was said after it (maybe ''). */
export function afterWake(text) {
  const t = text || ''
  const m = WAKE.exec(t) ?? GLUED.exec(t) ?? LEADING.exec(t)
  return m ? t.slice(m.index + m[0].length).trim() : null
}

const joinFrom = (results, from) =>
  Array.from(results)
    .slice(from)
    .map((r) => r[0]?.transcript ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Run one microphone session with a browser speech recogniser (`Ctor`).
 *
 * mode 'wake': listen until "Hey Tara", call onWake(), then carry on in the same session as a request.
 * mode 'command': the request starts straight away (mic tapped, or a follow-up after Tara answered).
 * The request ends after a pause (see pauseFor) and arrives in onDone(text, reason): reason is 'heard', 'silence'
 * (nothing said within noSpeechMs), 'blocked' (microphone not allowed) or 'error'. onInterim(text) shows the words
 * so far. onState: 'wake' | 'command' | 'blocked' | 'error' | 'off'. Browsers end sessions on their own every so
 * often; the session restarts and keeps what was already said.
 * Returns { stop() — discard, finish() — use what's been heard now, phase() }. Exported apart from the hook so it
 * can be tested with a fake recogniser and fake timers.
 */
export function startVoice(Ctor, { mode = 'command', lang, noSpeechMs = NO_SPEECH_MS, onWake, onHeard, onInterim, onDone, onState, schedule = setTimeout, cancel = clearTimeout }) {
  let rec = null
  let stopped = false
  let phase = mode
  let base = 0 // first result of this request in the current recogniser session
  let viaWake = false // the request began with "Hey Tara" in this session: strip it
  let carry = '' // words of this request heard in earlier sessions
  let text = ''
  let failures = 0
  let timer = null
  let cap = null
  let restart = null

  const end = (reason) => {
    if (stopped) return
    stopped = true
    ;[timer, cap, restart].forEach((t) => cancel(t))
    if (rec) {
      rec.onend = null
      rec.onresult = null
      try {
        rec.abort()
      } catch {
        /* already ended */
      }
    }
    if (reason === 'blocked' || reason === 'error') onState?.(reason)
    else onState?.('off')
    if (phase === 'command' || reason === 'blocked' || reason === 'error') onDone?.(reason === 'heard' ? text : '', reason)
  }
  // Wait for more words; answer after a pause that fits what's been said so far.
  const arm = () => {
    cancel(timer)
    timer = schedule(() => end(text ? 'heard' : 'silence'), text ? pauseFor(text) : noSpeechMs)
  }
  const toCommand = () => {
    phase = 'command'
    onState?.('command')
    cap = schedule(() => end(text ? 'heard' : 'silence'), MAX_MS)
    arm()
  }

  const begin = () => {
    if (stopped) return
    rec = new Ctor()
    rec.lang = lang || (typeof navigator !== 'undefined' && navigator.language) || 'en-IN'
    rec.continuous = true
    rec.interimResults = true
    rec.onstart = () => {
      failures = 0
    }
    rec.onresult = (e) => {
      if (phase === 'wake') {
        if (afterWake(joinFrom(e.results, 0)) === null) {
          onHeard?.(joinFrom(e.results, e.resultIndex)) // shown on screen, so a mishearing is never a mystery
          return
        }
        // The latest result the wake phrase is still found from: the request starts there.
        base = 0
        for (let i = e.results.length - 1; i >= 0; i--) {
          if (afterWake(joinFrom(e.results, i)) !== null) {
            base = i
            break
          }
        }
        viaWake = true
        onWake?.()
        toCommand()
      }
      const said = joinFrom(e.results, base)
      const own = viaWake ? (afterWake(said) ?? said) : said
      const next = [carry, own].filter(Boolean).join(' ')
      if (next !== text) {
        text = next
        onInterim?.(text)
      }
      arm()
    }
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') end('blocked')
      else if (e.error !== 'no-speech' && e.error !== 'aborted') failures += 1
    }
    rec.onend = () => {
      if (stopped) return
      if (failures >= 4) return end('error')
      if (phase === 'command') {
        carry = text // a new session starts with an empty transcript: keep what this one heard
        base = 0
        viaWake = false
      }
      restart = schedule(begin, failures ? 1200 : 250)
    }
    try {
      rec.start()
    } catch {
      failures += 1
      restart = schedule(begin, 1200)
    }
  }

  onState?.(phase)
  if (phase === 'command') {
    cap = schedule(() => end(text ? 'heard' : 'silence'), MAX_MS)
    arm()
  }
  begin()
  return { stop: () => ((phase = 'off'), end('cancelled')), finish: () => end(text ? 'heard' : 'silence'), phase: () => phase }
}

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = reject
    r.readAsDataURL(blob)
  })

/** Record a clip until a pause (browsers without speech recognition) and have the server transcribe it. */
async function recordClip(transcribe, { noSpeechMs, onState }) {
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    return { text: '', reason: 'blocked' }
  }
  return new Promise((resolve) => {
    const rec = new MediaRecorder(stream)
    const chunks = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const analyser = ctx.createAnalyser()
    ctx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Uint8Array(analyser.fftSize)
    const started = performance.now()
    let spoke = false
    let quietSince = started
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(buf)
      const level = Math.max(...buf.map((v) => Math.abs(v - 128)))
      const t = performance.now()
      if (level > 12) {
        spoke = true
        quietSince = t
      } else if (spoke ? t - quietSince > END_MS + 500 : t - started > noSpeechMs) finish()
    }, 120)
    const cap = setTimeout(() => finish(), 30_000)
    function finish() {
      clearInterval(timer)
      clearTimeout(cap)
      if (rec.state !== 'inactive') rec.stop()
    }
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
      if (!spoke || !chunks.length) return resolve({ text: '', reason: 'silence' })
      onState('transcribing')
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
        const { text } = await transcribe(await blobToBase64(blob), blob.type)
        resolve({ text: text ?? '', reason: 'heard' })
      } catch {
        resolve({ text: '', reason: 'error' })
      }
    }
    recordClip.finish = finish
    rec.start(250)
  })
}

/**
 * Tara's ears, as one hook: "Hey Tara" while the page is open, a request when the mic is tapped, and follow-ups
 * after an answer.
 *
 * state: 'idle' | 'listening' | 'transcribing'. wake: 'off' | 'waiting' (for a first tap, browsers need one) |
 * 'listening' | 'blocked' | 'error' | 'unsupported'. listen({ followUp }) starts a request; finish() sends what's
 * been heard; cancel() drops it. onRequest(text, { via, reason }) receives each request (text '' when nothing was
 * said); onWake() fires the moment "Hey Tara" is heard. Nothing listens while `busy` (thinking or speaking), so Tara
 * never hears herself.
 */
export function useVoice({ transcribe, lang, wake = true, busy = false, onRequest, onWake }) {
  const [state, setState] = useState('idle')
  const [interim, setInterim] = useState('')
  const [error, setError] = useState(null)
  const [wakeState, setWakeState] = useState('off')
  const [heard, setHeard] = useState('') // speech heard while waiting that wasn't "Hey Tara" (cleared after a moment)
  useEffect(() => {
    if (!heard) return
    const t = setTimeout(() => setHeard(''), 5000)
    return () => clearTimeout(t)
  }, [heard])
  const [touched, setTouched] = useState(false)
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible')
  const session = useRef(null)
  const handlers = useRef({ onRequest, onWake })
  useEffect(() => {
    handlers.current = { onRequest, onWake }
  }, [onRequest, onWake])

  const done = useCallback((text, reason, via) => {
    session.current = null
    setState('idle')
    setInterim('')
    if (reason === 'blocked') setError('Allow the microphone to talk to Tara (the lock icon in the address bar).')
    else if (reason === 'error') setError("I couldn't hear that. Try again, or type it.")
    handlers.current.onRequest?.(text.trim(), { via, reason })
  }, [])

  const listen = useCallback(
    ({ followUp = false } = {}) => {
      session.current?.stop()
      setError(null)
      setInterim('')
      setState('listening')
      const via = followUp ? 'followup' : 'tap'
      const noSpeechMs = followUp ? FOLLOW_UP_MS : NO_SPEECH_MS
      const Ctor = recognizer()
      if (Ctor) {
        session.current = startVoice(Ctor, { mode: 'command', lang, noSpeechMs, onInterim: setInterim, onDone: (t, r) => done(t, r, via) })
        return
      }
      if (!canRecord()) {
        setState('idle')
        setError("This browser can't use the microphone. Type your request instead.")
        return
      }
      const handle = { dead: false, finish: () => recordClip.finish?.(), phase: () => 'command' }
      handle.stop = () => {
        handle.dead = true // cancelled: whatever was recorded is dropped
        recordClip.finish?.()
      }
      session.current = handle
      void recordClip(transcribe, { noSpeechMs, onState: setState }).then(({ text, reason }) => {
        if (!handle.dead) done(text, reason, via)
      })
    },
    [done, lang, transcribe],
  )
  const finish = useCallback(() => session.current?.finish(), [])
  const cancel = useCallback(() => {
    const s = session.current
    session.current = null
    s?.stop()
    setState('idle')
    setInterim('')
  }, [])

  // Browsers only give the microphone to a page the user has interacted with, unless it's already allowed.
  useEffect(() => {
    if (touched) return
    let alive = true
    navigator.permissions
      ?.query({ name: 'microphone' })
      .then((p) => alive && p.state === 'granted' && setTouched(true))
      .catch(() => {})
    const go = () => setTouched(true)
    window.addEventListener('pointerdown', go, { once: true })
    window.addEventListener('keydown', go, { once: true })
    return () => {
      alive = false
      window.removeEventListener('pointerdown', go)
      window.removeEventListener('keydown', go)
    }
  }, [touched])
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])

  // "Hey Tara": a waiting session whenever Tara is idle, visible and allowed to listen.
  const Ctor = recognizer()
  const waiting = wake && !!Ctor && touched && visible && !busy && state === 'idle'
  useEffect(() => {
    if (!waiting) return
    const s = startVoice(Ctor, {
      mode: 'wake',
      lang,
      onState: (st) => setWakeState(st === 'wake' ? 'listening' : st === 'blocked' || st === 'error' ? st : 'off'),
      onWake: () => {
        setError(null)
        setInterim('')
        setState('listening')
        handlers.current.onWake?.()
      },
      onInterim: setInterim,
      onHeard: (t) => setHeard(t.slice(-80)),
      onDone: (t, r) => {
        if (r === 'blocked' || r === 'error') setWakeState(r)
        if (s.phase() === 'command') done(t, r, 'wake') // the request after "Hey Tara" (blocked/error: shown too)
      },
    })
    session.current = s
    return () => {
      if (s.phase() !== 'command') s.stop() // a request already under way finishes on its own
      if (session.current === s && s.phase() !== 'command') session.current = null
    }
  }, [waiting, Ctor, lang, done])
  useEffect(() => () => session.current?.stop(), [])

  const wakeOut = !wake
    ? 'off'
    : !Ctor
      ? 'unsupported'
      : !touched
        ? 'waiting'
        : wakeState === 'blocked' || wakeState === 'error'
          ? wakeState
          : 'listening'
  return { state, interim, error, wake: wakeOut, heard: wakeOut === 'listening' ? heard : '', listen, finish, cancel }
}

/** The voices this device offers (they load asynchronously, so this updates when they arrive). */
export function useVoices() {
  const [voices, setVoices] = useState(() => (canSpeak() ? speechSynthesis.getVoices() : []))
  useEffect(() => {
    if (!canSpeak()) return
    const update = () => setVoices(speechSynthesis.getVoices())
    speechSynthesis.addEventListener('voiceschanged', update)
    return () => speechSynthesis.removeEventListener('voiceschanged', update)
  }, [])
  return voices
}

/**
 * Read a reply aloud with the user's chosen voice, speed, pitch and language; resolves when it has been spoken
 * (or straight away when speech isn't available).
 */
export function say(text, { voice, rate = 1.03, pitch = 1, lang } = {}) {
  return new Promise((resolve) => {
    if (!canSpeak() || !text) return resolve()
    speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text.replace(/[*_#`]/g, ''))
    const chosen = voice && speechSynthesis.getVoices().find((v) => v.voiceURI === voice)
    if (chosen) u.voice = chosen
    u.rate = rate
    u.pitch = pitch
    u.lang = chosen?.lang || lang || navigator.language || 'en-IN'
    u.onend = () => resolve()
    u.onerror = () => resolve()
    speechSynthesis.speak(u)
  })
}
export const hush = () => canSpeak() && speechSynthesis.cancel()

let primed = false
/** iPhones only let a page speak after a tap: call this inside the tap, before any await. */
export function primeSpeech() {
  if (primed || !canSpeak()) return
  primed = true
  const u = new SpeechSynthesisUtterance(' ')
  u.volume = 0
  speechSynthesis.speak(u)
}

/** A soft two-note chime when Tara starts (up) or stops (down) listening. */
export function chime(up = true) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    const ctx = new Ctx()
    const notes = up ? [660, 880] : [880, 660]
    notes.forEach((f, i) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.frequency.value = f
      o.connect(g).connect(ctx.destination)
      const t = ctx.currentTime + i * 0.09
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.08, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
      o.start(t)
      o.stop(t + 0.18)
    })
    setTimeout(() => void ctx.close(), 600)
  } catch {
    /* no audio: silent */
  }
}
