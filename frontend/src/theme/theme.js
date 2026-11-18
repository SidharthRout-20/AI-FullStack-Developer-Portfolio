/**
 * The portfolio's appearance: light / dark mode from @appcore/web (one shared store) plus the portfolio's own skins
 * (Studio / Off the clock, see skin.js), applied as `data-skin` on <html>.
 */
import { emit, onFirstSubscribe, revealFrom, setChromeColor, subscribe } from '@appcore/web/theme'
import { useSyncExternalStore } from 'react'
import { DEFAULT_SKIN, isSkin, SKIN_KEY, themeColor } from './skin'

export { DAY_START, NIGHT_START, originOf, resolveTheme, setThemeMode, themeForTime, useTheme } from '@appcore/web/theme'

function readSkin() {
  try {
    const v = localStorage.getItem(SKIN_KEY)
    return isSkin(v) ? v : DEFAULT_SKIN
  } catch {
    return DEFAULT_SKIN
  }
}

let skin = typeof window === 'undefined' ? DEFAULT_SKIN : readSkin()

// The browser chrome colour depends on the skin as well as the theme.
setChromeColor((theme) => themeColor(theme, document.documentElement.dataset.skin))

function applySkin(next) {
  document.documentElement.dataset.skin = next
  setChromeColor((theme) => themeColor(theme, next))
}
onFirstSubscribe(() => applySkin(skin))

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
    revealFrom(origin ?? { x: innerWidth - 120, y: 24 })
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

export function useSkin() {
  return useSyncExternalStore(subscribe, () => skin, () => DEFAULT_SKIN)
}
