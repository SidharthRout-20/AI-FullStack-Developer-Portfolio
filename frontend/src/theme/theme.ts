import { useSyncExternalStore } from 'react'

/**
 * Theme engine.
 *
 *  mode  = what the user picked: 'auto' | 'light' | 'dark' (persisted)
 *  theme = what is applied:      'light' | 'dark'
 *
 * Auto follows the user's local clock (their time zone, via the browser): light from 07:00 to 18:59,
 * dark otherwise, re-checked every minute so the UI flips at 7 pm without a reload.
 * `public/theme-init.js` applies the same rule before first paint (no flash of the wrong theme).
 */
export type ThemeMode = 'auto' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const KEY = 'theme-mode'
export const DAY_START = 7
export const NIGHT_START = 19

export function themeForTime(date: Date): Theme {
  const h = date.getHours()
  return h >= DAY_START && h < NIGHT_START ? 'light' : 'dark'
}

export function resolveTheme(mode: ThemeMode, now = new Date()): Theme {
  return mode === 'auto' ? themeForTime(now) : mode
}

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' || v === 'auto' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

let mode: ThemeMode = typeof window === 'undefined' ? 'auto' : readMode()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function apply(theme: Theme, fade = false) {
  const root = document.documentElement
  if (root.dataset.theme === theme) return
  if (fade) {
    root.classList.add('theme-fade')
    window.setTimeout(() => root.classList.remove('theme-fade'), 400)
  }
  root.dataset.theme = theme
  root.style.colorScheme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f5f9' : '#0b0d14')
}

/** Change mode; with a click origin the new theme is revealed as a growing circle from that point. */
export function setThemeMode(next: ThemeMode, origin?: { x: number; y: number }) {
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
    const r = Math.hypot(Math.max(origin.x, innerWidth - origin.x), Math.max(origin.y, innerHeight - origin.y))
    root.style.setProperty('--reveal-x', `${origin.x}px`)
    root.style.setProperty('--reveal-y', `${origin.y}px`)
    root.style.setProperty('--reveal-r', `${r}px`)
    root.classList.add('theme-reveal')
    const t = document.startViewTransition(() => apply(target))
    t.finished.finally(() => root.classList.remove('theme-reveal'))
  } else {
    apply(target, true)
  }
  emit()
}

let timer: number | undefined
function subscribe(cb: () => void) {
  listeners.add(cb)
  if (listeners.size === 1) {
    apply(resolveTheme(mode))
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

export function useTheme(): { mode: ThemeMode; theme: Theme } {
  const m = useSyncExternalStore(subscribe, () => mode, () => 'auto' as ThemeMode)
  const theme = useSyncExternalStore(
    subscribe,
    () => (document.documentElement.dataset.theme as Theme) ?? resolveTheme(mode),
    () => 'dark' as Theme,
  )
  return { mode: m, theme }
}
