/**
 * Visits: a cookie-free page-view counter for the owner's Insights page (see backend/app/visits.py).
 *
 * Sends only the path (plus the ?ref= / utm_source tag of the link that brought the visitor), the referring host,
 * the viewport width and a random id that lives as long as the tab. Nothing is sent with Do Not Track or Global
 * Privacy Control on, from local development, or from the owner's own browser (they can turn that back on).
 */
import { API_BASE } from './apiBase'

const IGNORE = 'visits-ignore'
const SID = 'visits-sid'
const URL = `${API_BASE}/api/visits/hit`

const safe = (fn, fallback) => {
  try {
    return fn()
  } catch {
    return fallback
  }
}

export const isIgnored = () => safe(() => localStorage.getItem(IGNORE) === '1', false)
export const setIgnored = (on) => safe(() => (on ? localStorage.setItem(IGNORE, '1') : localStorage.removeItem(IGNORE)))

function allowed() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname)) return false // dev would pollute the real numbers
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl) return false
  if (navigator.webdriver) return false
  return !isIgnored()
}

function session() {
  return safe(() => {
    let id = sessionStorage.getItem(SID)
    if (!id) {
      id = Math.random().toString(36).slice(2, 12)
      sessionStorage.setItem(SID, id)
    }
    return id
  }, '')
}

// The tag of the link that opened the site ("?ref=linkedin"), kept for the whole tab so later pages still count it.
function tag() {
  return safe(() => {
    const q = new URLSearchParams(location.search)
    const t = (q.get('ref') || q.get('utm_source') || '').slice(0, 30)
    if (t) sessionStorage.setItem('visits-tag', t)
    return t || sessionStorage.getItem('visits-tag') || ''
  }, '')
}

function send(body) {
  if (!allowed()) return
  const data = JSON.stringify({ ...body, sid: session(), w: window.innerWidth, site: location.hostname })
  // text/plain keeps it a "simple" request: no CORS preflight, and sendBeacon survives the page closing.
  const blob = new Blob([data], { type: 'text/plain' })
  if (!(navigator.sendBeacon && navigator.sendBeacon(URL, blob))) {
    fetch(URL, { method: 'POST', body: data, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(() => {})
  }
}

let first = true
let lastPath = null
/** A page view. The first one carries the referrer; later ones are moves inside the site. */
export function trackView(path) {
  if (path === lastPath) return
  lastPath = path
  send({ type: 'view', path, ref: first ? document.referrer : location.origin, tag: tag() })
  first = false
}

/** A named moment: resume, contact, email, tara_ask, outbound, try. */
export function track(name, path = location.pathname) {
  send({ type: 'event', name, path, tag: tag() })
}

/** Résumé, email and outbound clicks, from anywhere on the site, without touching every link. */
export function watchClicks(resumeUrl) {
  const onClick = (e) => {
    const a = e.target.closest?.('a[href]')
    if (!a) return
    const href = a.getAttribute('href') || ''
    if (resumeUrl && (href === resumeUrl || a.href === resumeUrl)) track('resume')
    else if (href.startsWith('mailto:')) track('email')
    else if (a.host && a.host !== location.host && /^https?:/.test(a.href)) track('outbound')
  }
  document.addEventListener('click', onClick, { capture: true })
  return () => document.removeEventListener('click', onClick, { capture: true })
}
