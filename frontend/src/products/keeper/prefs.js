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
