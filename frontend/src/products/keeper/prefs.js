/** How the user has set Tijori up. Kept on this device only (nothing about it is stored on the server). */
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
  keep: false, // keep listening after each reply (a conversation)
  sounds: true, // chime when listening starts and stops
}

export const LANGUAGES = [
  ['', 'Same as this browser'],
  ['en-IN', 'English (India)'],
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['hi-IN', 'Hindi'],
]

export function readPrefs() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return { ...DEFAULTS }
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
export const replyPrefs = (p) => ({ name: p.name.trim().slice(0, 40), tone: p.tone, length: p.length })
