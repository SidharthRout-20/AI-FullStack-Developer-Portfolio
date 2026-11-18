/**
 * Light / dark mode, shared by every app: 'light', 'dark' or 'auto' (light from 07:00 to 18:59 local time).
 *
 * One store per page: apps can layer their own appearance on top (the portfolio adds its skins) through
 * `subscribe` / `emit`, `onFirstSubscribe` and `setChromeColor`, so there is never a second, out-of-sync store.
 * Mirrors public/theme-init.js, which applies the stored mode before first paint.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'theme-mode'
export const DAY_START = 7
export const NIGHT_START = 19

export function themeForTime(date) {
  const h = date.getHours()
  return h >= DAY_START && h < NIGHT_START ? 'light' : 'dark'
}

export function resolveTheme(mode, now = new Date()) {
  return mode === 'auto' ? themeForTime(now) : mode
}

function readMode() {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' || v === 'auto' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

let mode = typeof window === 'undefined' ? 'auto' : readMode()
const listeners = new Set()
const startHooks = []
/** Re-render every subscriber (after any change to the page's appearance). */
export const emit = () => listeners.forEach((l) => l())

// Browser chrome colour (mobile address bar) for the current theme; apps may refine it (e.g. per skin).
let chromeColor = (theme) => (theme === 'light' ? '#f4f5f9' : '#0b0d14')
export function setChromeColor(fn) {
  chromeColor = fn
  if (typeof document !== 'undefined') syncChrome()
}
export function syncChrome() {
  const root = document.documentElement
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', chromeColor(root.dataset.theme))
}

function apply(theme, fade = false) {
  const root = document.documentElement
  if (root.dataset.theme === theme) return
  if (fade) {
    root.classList.add('theme-fade')
    window.setTimeout(() => root.classList.remove('theme-fade'), 400)
  }
  root.dataset.theme = theme
  root.style.colorScheme = theme
  syncChrome()
}

/** The centre of the clicked element: where theme (and skin) transitions open from. */
export function originOf(e) {
  const r = e.currentTarget.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

/** Set the CSS variables a circular reveal grows from (--reveal-x / -y / -r), covering the whole viewport. */
export function revealFrom(o) {
  const root = document.documentElement
  const r = Math.hypot(Math.max(o.x, innerWidth - o.x), Math.max(o.y, innerHeight - o.y))
  root.style.setProperty('--reveal-x', `${o.x}px`)
  root.style.setProperty('--reveal-y', `${o.y}px`)
  root.style.setProperty('--reveal-r', `${r}px`)
}

/** Change mode; with a click origin the new theme is revealed as a growing circle from that point. */
export function setThemeMode(next, origin) {
  mode = next
  try {
    localStorage.setItem(KEY, next)
  } catch {
    /* private mode: keep it for this session only */
  }
  const target = resolveTheme(next)
  const root = document.documentElement
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (origin && document.startViewTransition && !reduce && root.dataset.theme !== target) {
    revealFrom(origin)
    root.classList.add('theme-reveal')
    const t = document.startViewTransition(() => apply(target))
    t.finished.finally(() => root.classList.remove('theme-reveal'))
  } else {
    apply(target, true)
  }
  emit()
}

/** Run `fn` when the store becomes active (first subscriber), e.g. to apply an app's own appearance. */
export function onFirstSubscribe(fn) {
  startHooks.push(fn)
}

let timer
export function subscribe(cb) {
  listeners.add(cb)
  if (listeners.size === 1) {
    apply(resolveTheme(mode))
    startHooks.forEach((fn) => fn())
    timer = window.setInterval(() => {
      if (mode === 'auto') {
        apply(resolveTheme('auto'), true)
        emit()
      }
    }, 60_000)
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) window.clearInterval(timer)
  }
}

export function useTheme() {
  const m = useSyncExternalStore(subscribe, () => mode, () => 'auto')
  const theme = useSyncExternalStore(
    subscribe,
    () => document.documentElement.dataset.theme ?? resolveTheme(mode),
    () => 'dark',
  )
  return { mode: m, theme }
}
