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
const emit = () => listeners.forEach((l) => l())

function apply(theme, fade = false) {
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

let timer
function subscribe(cb) {
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

export function useTheme() {
  const m = useSyncExternalStore(subscribe, () => mode, () => 'auto')
  const theme = useSyncExternalStore(
    subscribe,
    () => document.documentElement.dataset.theme ?? resolveTheme(mode),
    () => 'dark',
  )
  return { mode: m, theme }
}
