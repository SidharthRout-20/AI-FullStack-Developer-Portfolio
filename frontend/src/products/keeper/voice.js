/**
 * Tijori's voice: hear a command and speak the reply, on laptops and phones.
 *
 * Hearing uses the browser's own speech recognition where it exists (Chrome, Edge, Safari on Mac and iPhone,
 * Android), with words appearing as you speak. Elsewhere (Firefox, some in-app browsers) it records a short clip and
 * the server transcribes it with Whisper. Speaking uses the browser's built-in voices; nothing is installed.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const MAX_CLIP_MS = 12_000 // a command, not a recording
const SILENCE_MS = 1_400 // stop the clip after this much quiet once someone has spoken

const recognizer = () => (typeof window === 'undefined' ? null : window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null)
const canRecord = () => typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'

/** How this device can hear: 'native' (live words), 'record' (clip → server), or null (type instead). */
export const hearingMode = () => (recognizer() ? 'native' : canRecord() ? 'record' : null)
export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window

const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = reject
    r.readAsDataURL(blob)
  })

/**
 * state: 'idle' | 'listening' | 'transcribing'. `start(onFinal)` begins hearing; onFinal gets the text (or '' when
 * nothing was said). `interim` holds the words so far (native mode only).
 */
export function useHearing(transcribe) {
  const [state, setState] = useState('idle')
  const [interim, setInterim] = useState('')
  const [error, setError] = useState(null)
  const stopRef = useRef(null)

  const stop = useCallback(() => stopRef.current?.(), [])

  const start = useCallback(
    async (onFinal, { lang } = {}) => {
      setError(null)
      setInterim('')
      const Ctor = recognizer()
      if (Ctor) {
        const rec = new Ctor()
        rec.lang = lang || navigator.language || 'en-IN'
        rec.interimResults = true
        rec.continuous = false
        let text = ''
        rec.onresult = (e) => {
          text = Array.from(e.results).map((r) => r[0]?.transcript ?? '').join(' ').trim()
          setInterim(text)
        }
        rec.onerror = (e) => {
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setError('Allow the microphone to talk to Tijori.')
          else if (e.error !== 'no-speech' && e.error !== 'aborted') setError("I couldn't hear that. Try again, or type it.")
        }
        rec.onend = () => {
          stopRef.current = null
          setState('idle')
          onFinal(text)
        }
        stopRef.current = () => rec.stop()
        setState('listening')
        try {
          rec.start()
        } catch {
          setState('idle')
        }
        return
      }
      if (!canRecord()) {
        setError("This browser can't use the microphone. Type your request instead.")
        return
      }
      let stream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch {
        setError('Allow the microphone to talk to Tijori.')
        return
      }
      const rec = new MediaRecorder(stream)
      const chunks = []
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      // Stop on its own after a pause in speech, or at the cap.
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const analyser = ctx.createAnalyser()
      ctx.createMediaStreamSource(stream).connect(analyser)
      const buf = new Uint8Array(analyser.fftSize)
      let spoke = false
      let quietSince = performance.now()
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(buf)
        const level = Math.max(...buf.map((v) => Math.abs(v - 128)))
        if (level > 12) {
          spoke = true
          quietSince = performance.now()
        } else if (spoke && performance.now() - quietSince > SILENCE_MS) finish()
      }, 120)
      const cap = setTimeout(() => finish(), MAX_CLIP_MS)
      function finish() {
        clearInterval(timer)
        clearTimeout(cap)
        if (rec.state !== 'inactive') rec.stop()
      }
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        void ctx.close()
        stopRef.current = null
        if (!spoke || !chunks.length) {
          setState('idle')
          onFinal('')
          return
        }
        setState('transcribing')
        try {
          const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
          const { text } = await transcribe(await blobToBase64(blob), blob.type)
          setState('idle')
          onFinal(text ?? '')
        } catch (e) {
          setState('idle')
          setError(e?.message || "I couldn't understand the recording. Try again, or type it.")
          onFinal('')
        }
      }
      stopRef.current = finish
      rec.start(250)
      setState('listening')
    },
    [transcribe],
  )

  useEffect(() => () => stopRef.current?.(), [])
  return { state, interim, error, start, stop }
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
 * Read a reply aloud with the traveller's chosen voice, speed, pitch and language; resolves when it has been spoken
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

/** A soft two-note chime when Tijori starts (up) or stops (down) listening. */
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
