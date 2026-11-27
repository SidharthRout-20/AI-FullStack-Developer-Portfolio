/** How the user has set Tara up. Kept on this device only (nothing about it is stored on the server). */
const KEY = 'tijori-voice'

export const DEFAULTS = {
  name: '',
  voice: '', // a voiceURI from this device; '' = the device default
  rate: 1.03,
  pitch: 1,
  lang: '', // listening and speaking language; '' = the browser's language
  tone: 'warm', // warm | professional | cheerful
  length: 'short', // short | detailed
  speak: true, // read replies aloud
  keep: true, // after answering a spoken request, listen for a follow-up (a conversation, no tapping)
  sounds: true, // chime when listening starts and stops
  wake: true, // answer to "Hey Tara" while the page is open (starts after the first tap; can be turned off)
  city: '', // home city: weather when location isn't shared
  useLocation: false, // share this device's location for weather and directions
}

export const LANGUAGES = [
  ['', 'Same as this browser'],
  ['en-IN', 'English (India)'],
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['hi-IN', 'Hindi'],
]

const VERSION = 2 // v2: conversations (listen for a follow-up) became the default

export function readPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if ((saved.v ?? 1) < 2) saved.keep = true
    return { ...DEFAULTS, ...saved, v: VERSION }
  } catch {
    return { ...DEFAULTS, v: VERSION }
  }
}

export function writePrefs(p) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* private mode: settings last for this visit */
  }
}

/** What the server needs to shape replies (never the voice settings). */
export const replyPrefs = (p) => ({
  name: p.name.trim().slice(0, 40),
  tone: p.tone,
  length: p.length,
  city: p.city.trim().slice(0, 80),
  lang: p.lang || (typeof navigator !== 'undefined' ? navigator.language : '') || 'en-IN',
})

// Voice names browsers commonly ship, by how they sound (used for "use a female / male voice").
const FEMALE = /female|woman|zira|samantha|heera|aria|jenny|veena|karen|moira|tessa|victoria|susan|hazel|neerja|swara|kalpana|kajal|sonia|libby|natasha|ava|allison|fiona|serena|google (uk english|us english|हिन्दी)$/i
const MALE = /\bmale\b|\bman\b|david|mark|alex|daniel|ravi|guy|ryan|george|prabhat|hemant|fred|thomas|oliver|rishi|aaron|arthur|google uk english male/i
const LANGS = { english: 'en-IN', hindi: 'hi-IN', 'indian english': 'en-IN', 'british': 'en-GB', american: 'en-US', us: 'en-US', uk: 'en-GB' }
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(n * 100) / 100))
const on = (v) => !/\b(off|no|stop|disable|don'?t|never|mute|quiet)\b/i.test(v)

/**
 * Apply a spoken settings change ("speak slower", "use a female voice", "call me Sid") to the preferences.
 * Returns the new preferences, or null when it can't be done here (the settings panel opens instead).
 */
export function applySetting({ setting, value = '' }, prefs, voices = []) {
  const v = String(value).toLowerCase().trim()
  const p = { ...prefs }
  switch (setting) {
    case 'speed':
      p.rate = clamp(/slow/.test(v) ? p.rate - 0.15 : /fast|quick/.test(v) ? p.rate + 0.15 : Number.parseFloat(v) || p.rate, 0.7, 1.6)
      return p
    case 'pitch':
      p.pitch = clamp(/low|deep/.test(v) ? p.pitch - 0.15 : /high/.test(v) ? p.pitch + 0.15 : p.pitch, 0.6, 1.6)
      return p
    case 'tone': {
      const tone = ['warm', 'professional', 'cheerful'].find((t) => v.includes(t)) ?? (/formal|serious/.test(v) ? 'professional' : /fun|happy|upbeat/.test(v) ? 'cheerful' : null)
      return tone ? { ...p, tone } : null
    }
    case 'length':
      p.length = /short|brief|concise/.test(v) ? 'short' : 'detailed'
      return p
    case 'name':
      return value.trim() ? { ...p, name: value.trim().slice(0, 40) } : null
    case 'language': {
      const lang = /^[a-z]{2}-[a-z]{2}$/i.test(v) ? v : LANGS[v] ?? Object.entries(LANGS).find(([k]) => v.includes(k))?.[1]
      return lang ? { ...p, lang } : null
    }
    case 'wake':
    case 'speak':
    case 'sounds':
    case 'keep':
      p[setting] = on(v)
      return p
    case 'city':
      return value.trim() ? { ...p, city: value.trim().slice(0, 80) } : null
    case 'voice': {
      const lang = (p.lang || (typeof navigator !== 'undefined' ? navigator.language : '') || 'en').slice(0, 2)
      const pool = voices.filter((x) => x.lang?.toLowerCase().startsWith(lang)).concat(voices.filter((x) => !x.lang?.toLowerCase().startsWith(lang)))
      if (!pool.length) return null
      const want = /female|woman|girl|lady/.test(v) ? FEMALE : /\bmale\b|\bman\b|\bboy\b|guy/.test(v) ? MALE : null
      const named = v && !want && v !== 'different' ? pool.find((x) => x.name.toLowerCase().includes(v)) : null
      const candidates = named ? [named] : want ? pool.filter((x) => want.test(x.name) && !(want === MALE && FEMALE.test(x.name))) : pool
      if (!candidates.length) return null
      const i = candidates.findIndex((x) => x.voiceURI === p.voice)
      return { ...p, voice: candidates[(i + 1) % candidates.length].voiceURI } // a different one each time you ask
    }
    default:
      return null
  }
}
