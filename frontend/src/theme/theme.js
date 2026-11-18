import { useSyncExternalStore } from 'react'
import { DEFAULT_SKIN, isSkin, SKIN_KEY, themeColor } from './skin'

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

function readSkin() {
  try {
    const v = localStorage.getItem(SKIN_KEY)
    return isSkin(v) ? v : DEFAULT_SKIN
  } catch {
    return DEFAULT_SKIN
  }
}

let mode = typeof window === 'undefined' ? 'auto' : readMode()
let skin = typeof window === 'undefined' ? DEFAULT_SKIN : readSkin()
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
  syncChrome()
}

function syncChrome() {
  const root = document.documentElement
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor(root.dataset.theme, root.dataset.skin))
}

function applySkin(next) {
  document.documentElement.dataset.skin = next
  syncChrome()
}

/** The centre of the clicked element: where skin and theme transitions open from. */
export function originOf(e) {
  const r = e.currentTarget.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

/**
 * Change the site skin. Both directions open from the button that was clicked: going off the clock is a colourful
 * portal (a growing circle with a soft focus pull); going back to the Studio is the same circle, crisp and calm, with
 * the personal space settling back behind it.
 */
export function setSkin(next, origin) {
  if (!isSkin(next) || next === skin) return
  skin = next
  try {
    localStorage.setItem(SKIN_KEY, next)
  } catch {
    /* private mode: keep it for this session only */
  }
  const root = document.documentElement
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (document.startViewTransition && !reduce) {
    const cls = next === 'personal' ? 'skin-portal' : 'skin-iris'
    // No click origin (command palette, keyboard): open from the top-right corner where the switch lives.
    const o = origin ?? { x: innerWidth - 120, y: 24 }
    const r = Math.hypot(Math.max(o.x, innerWidth - o.x), Math.max(o.y, innerHeight - o.y))
    root.style.setProperty('--reveal-x', `${o.x}px`)
    root.style.setProperty('--reveal-y', `${o.y}px`)
    root.style.setProperty('--reveal-r', `${r}px`)
    root.classList.add(cls)
    const t = document.startViewTransition(() => {
      applySkin(next)
      emit()
    })
    t.finished.finally(() => root.classList.remove(cls))
  } else {
    applySkin(next)
    emit()
  }
  window.dispatchEvent(new CustomEvent('skin-change', { detail: { skin: next } }))
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
    applySkin(skin)
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

export function useSkin() {
  return useSyncExternalStore(subscribe, () => skin, () => DEFAULT_SKIN)
}
