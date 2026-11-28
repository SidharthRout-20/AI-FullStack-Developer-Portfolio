/**
 * Tara's background music: slow, soothing sound made live in the browser with Web Audio. There are no tracks to
 * license, nothing to download and nothing to pay for, and it never repeats exactly.
 *
 *   calm   – warm pad chords that drift from one to the next
 *   piano  – soft, bell-like notes from a pentatonic scale over a quiet pad
 *   rain   – rain on a window: filtered noise, the odd drop, a low pad
 *   night  – a deep drone with distant chimes
 *   ocean  – slow swells of surf
 *   weather – picks one of the above from the weather outside (rain → rain, a clear night → night…)
 *
 * It hushes while Tara listens (so the microphone hears you, not the music) and dips while she speaks.
 * Browsers only allow sound after a tap, so it starts on the first one if it was left on.
 */

export const STYLES = [
  { id: 'weather', label: 'Match the weather' },
  { id: 'calm', label: 'Calm pads' },
  { id: 'piano', label: 'Soft piano' },
  { id: 'rain', label: 'Rain on the window' },
  { id: 'night', label: 'Night sky' },
  { id: 'ocean', label: 'Ocean waves' },
]

/** Which sound suits the weather outside (scene from sky.js) and the time of day. */
export function styleForWeather(scene, phase) {
  if (scene === 'rain' || scene === 'storm' || scene === 'drizzle') return 'rain'
  if (scene === 'snow' || scene === 'fog') return 'calm'
  if (phase === 'night') return 'night'
  if (scene === 'clear') return phase === 'day' ? 'piano' : 'ocean'
  return 'calm'
}

export const resolveStyle = (style, scene, phase) => (style === 'weather' ? styleForWeather(scene, phase) : style)

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12)
// Cmaj9 → Am9 → Fmaj7 → G6 (voiced low and close): resolves gently, never tense.
const CHORDS = [[48, 52, 55, 59, 62], [45, 48, 52, 55, 59], [41, 45, 48, 52, 57], [43, 47, 50, 52, 55]]
const PENTA = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81]
const rand = (a, b) => a + Math.random() * (b - a)
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)]

class Engine {
  ctx = null
  out = null // master gain (volume × duck)
  dry = null
  wet = null
  style = null
  volume = 0.35
  level = 1 // ducking: 1 normal, 0.3 while Tara speaks, 0 while she listens
  timers = []
  voices = [] // nodes to stop when the style changes

  get supported() {
    return typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext)
  }

  ensure() {
    if (this.ctx) return
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    this.ctx = ctx
    this.out = ctx.createGain()
    this.out.gain.value = 0
    const comp = ctx.createDynamicsCompressor()
    this.out.connect(comp).connect(ctx.destination)
    this.dry = ctx.createGain()
    this.dry.gain.value = 0.7
    this.dry.connect(this.out)
    // A long, soft room: noise with an exponential tail, made once.
    const len = Math.floor(ctx.sampleRate * 4)
    const ir = ctx.createBuffer(2, len, ctx.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch)
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.6
    }
    const verb = ctx.createConvolver()
    verb.buffer = ir
    this.wet = ctx.createGain()
    this.wet.gain.value = 0.55
    this.wet.connect(verb).connect(this.out)
  }

  /** Start (or switch to) a style at a volume (0–1). Safe to call again with the same values. */
  async play(style, volume = this.volume) {
    if (!this.supported) return false
    this.ensure()
    this.volume = volume
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {})
    if (style !== this.style) {
      this.silenceVoices()
      this.style = style
      this[style]?.()
    }
    this.apply(2.5)
    return this.ctx.state === 'running'
  }

  stop() {
    if (!this.ctx) return
    this.style = null
    this.ramp(0, 1.2)
    const ctx = this.ctx
    this.later(() => {
      this.silenceVoices()
      if (!this.style) void ctx.suspend().catch(() => {})
    }, 1400)
  }

  setVolume(v) {
    this.volume = v
    this.apply(0.3)
  }

  duck(level) {
    if (level === this.level) return
    this.level = level
    this.apply(level === 0 ? 0.25 : 1.2)
  }

  get playing() {
    return !!this.style && this.ctx?.state === 'running'
  }

  // ── plumbing ──────────────────────────────────────────────────────────────
  apply(seconds) {
    if (this.style) this.ramp(this.volume * this.level * 0.6, seconds)
  }

  ramp(value, seconds) {
    if (!this.ctx) return
    const g = this.out.gain
    const t = this.ctx.currentTime
    g.cancelScheduledValues(t)
    g.setValueAtTime(g.value, t)
    g.linearRampToValueAtTime(value, t + seconds)
  }

  later(fn, ms) {
    const id = setTimeout(() => {
      this.timers = this.timers.filter((x) => x !== id)
      fn()
    }, ms)
    this.timers.push(id)
  }

  loop(fn, min, max) {
    const tick = () => {
      fn()
      this.later(tick, rand(min, max))
    }
    tick()
  }

  silenceVoices() {
    this.timers.forEach(clearTimeout)
    this.timers = []
    const t = this.ctx?.currentTime ?? 0
    for (const n of this.voices) {
      try {
        n.gain?.gain.cancelScheduledValues(t)
        n.gain?.gain.setTargetAtTime(0, t, 0.3)
        n.stop?.(t + 1.5)
      } catch {
        /* already stopped */
      }
    }
    this.voices = []
  }

  send(node, wet = 0.5) {
    node.connect(this.dry)
    const s = this.ctx.createGain()
    s.gain.value = wet
    node.connect(s).connect(this.wet)
  }

  /** One sustained note with a slow swell and fade (pads, drones). */
  tone(freq, { type = 'sine', gain = 0.05, attack = 3, hold = 6, release = 5, cutoff = 1200, wet = 0.6, detune = 0 } = {}) {
    const ctx = this.ctx
    const t = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.value = freq
    o.detune.value = detune
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = cutoff
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(gain, t + attack)
    g.gain.setValueAtTime(gain, t + attack + hold)
    g.gain.linearRampToValueAtTime(0, t + attack + hold + release)
    o.connect(f).connect(g)
    this.send(g, wet)
    o.start(t)
    o.stop(t + attack + hold + release + 0.1)
    this.voices.push({ stop: (w) => o.stop(w), gain: g })
  }

  /** A soft, bell-like struck note (piano, chimes). */
  bell(freq, { gain = 0.06, decay = 3, wet = 0.7 } = {}) {
    const ctx = this.ctx
    const t = ctx.currentTime
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(gain, t + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay)
    for (const [mult, type, level] of [[1, 'triangle', 1], [2, 'sine', 0.25], [3, 'sine', 0.08]]) {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.value = freq * mult
      const lv = ctx.createGain()
      lv.gain.value = level
      o.connect(lv).connect(g)
      o.start(t)
      o.stop(t + decay + 0.1)
    }
    this.send(g, wet)
  }

  /** Looped noise: white, or brown (deeper, like distant surf). */
  noise(kind = 'white') {
    const ctx = this.ctx
    const len = ctx.sampleRate * 3
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    let last = 0
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1
      d[i] = kind === 'brown' ? (last = (last + 0.02 * w) / 1.02) * 3.5 : w
    }
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    return src
  }

  pads(gain = 0.045, every = 9000) {
    let i = 0
    this.loop(() => {
      for (const n of CHORDS[i++ % CHORDS.length]) {
        this.tone(hz(n), { type: 'sine', gain, attack: 3.5, hold: every / 1000 - 3, release: 5, cutoff: 900 })
        this.tone(hz(n), { type: 'triangle', gain: gain * 0.35, attack: 4, hold: every / 1000 - 3, release: 5, cutoff: 700, detune: 6 })
      }
    }, every, every)
  }

  // ── styles ────────────────────────────────────────────────────────────────
  calm() {
    this.pads(0.05, 9000)
  }

  piano() {
    this.pads(0.022, 11000)
    this.loop(() => {
      this.bell(hz(pick(PENTA)), { gain: rand(0.035, 0.06), decay: rand(2.5, 4) })
      if (Math.random() < 0.3) this.later(() => this.bell(hz(pick(PENTA) - 12), { gain: 0.03, decay: 3.5 }), rand(180, 420))
    }, 900, 2600)
  }

  rain() {
    const ctx = this.ctx
    const src = this.noise('white')
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 500
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 5200
    const g = ctx.createGain()
    g.gain.value = 0
    g.gain.linearRampToValueAtTime(0.09, ctx.currentTime + 3)
    src.connect(hp).connect(lp).connect(g)
    this.send(g, 0.25)
    src.start()
    this.voices.push({ stop: (w) => src.stop(w), gain: g })
    this.loop(() => {
      // a heavier drop on the glass
      const d = this.noise('white')
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = rand(1800, 4200)
      bp.Q.value = 6
      const dg = ctx.createGain()
      const t = ctx.currentTime
      dg.gain.setValueAtTime(0, t)
      dg.gain.linearRampToValueAtTime(rand(0.04, 0.09), t + 0.004)
      dg.gain.exponentialRampToValueAtTime(0.0001, t + 0.09)
      d.connect(bp).connect(dg)
      this.send(dg, 0.4)
      d.start(t)
      d.stop(t + 0.12)
    }, 120, 900)
    this.pads(0.02, 12000)
  }

  night() {
    this.loop(() => {
      this.tone(hz(33), { gain: 0.05, attack: 6, hold: 10, release: 8, cutoff: 400, wet: 0.4 })
      this.tone(hz(40), { gain: 0.03, attack: 7, hold: 9, release: 8, cutoff: 500, wet: 0.5, detune: -4 })
    }, 16000, 16000)
    this.loop(() => this.bell(hz(pick(PENTA) + 12), { gain: rand(0.02, 0.035), decay: 6, wet: 0.95 }), 3000, 7500)
  }

  ocean() {
    const ctx = this.ctx
    const src = this.noise('brown')
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 700
    const g = ctx.createGain()
    g.gain.value = 0.04
    // waves: the level rises and falls every ~10 s
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.1
    const depth = ctx.createGain()
    depth.gain.value = 0.05
    lfo.connect(depth).connect(g.gain)
    src.connect(lp).connect(g)
    this.send(g, 0.3)
    src.start()
    lfo.start()
    this.voices.push({ stop: (w) => src.stop(w), gain: g }, { stop: (w) => lfo.stop(w) })
    this.pads(0.018, 13000)
  }
}

export const ambient = new Engine()
