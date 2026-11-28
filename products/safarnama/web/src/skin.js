/**
 * Safarnaama inside the portfolio's personal space ("Off the clock", <html data-skin="personal">) gets the newer,
 * budget-first experience in the personal space's own look: plain paper (or near-black), condensed uppercase headings
 * and bright colour cards from the same palettes, recoloured with the same palette button. Everywhere else (the
 * Studio, its own site) it stays as it was.
 *
 * Applied as <html data-pa-theme="personal"> plus the palette as CSS variables (--pc-1…4 and the text colour on each,
 * --pc-on-1…4) while Safarnaama is open; the CSS lives in styles/safarnama.css.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'

/** The personal space's palettes (frontend/src/site/personal/PersonalSpace.jsx), in the same order. */
export const PALETTES = [
  ['#d7f75b', '#1f6feb', '#f6c445', '#f9dde5'],
  ['#ffb4a2', '#7fd1c7', '#b8a8ff', '#ffe066'],
  ['#ff8fab', '#8ecae6', '#ffd166', '#b5e48c'],
]
const KEY = 'safarnaama-palette'

/** Text on a card colour: white on dark colours, near-black on light ones (WCAG relative luminance). */
export function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.3 ? '#ffffff' : '#1f1f1f'
}

/** A card colour from the current palette, as CSS: { background, color } for the i-th card. */
export const cardColour = (i) => ({ background: `var(--pc-${(i % 4) + 1})`, color: `var(--pc-on-${(i % 4) + 1})` })

function watchSkin(fn) {
  const o = new MutationObserver(fn)
  o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin'] })
  return () => o.disconnect()
}
const isPersonal = () => document.documentElement.dataset.skin === 'personal'

/** True inside the personal space (follows the skin switch live). */
export function usePersonal() {
  return useSyncExternalStore(watchSkin, isPersonal, () => false)
}

function savedPalette() {
  try {
    const v = Number(localStorage.getItem(KEY))
    return Number.isInteger(v) && v >= 0 ? v % PALETTES.length : 0
  } catch {
    return 0
  }
}

let fontAsked = false
function loadDisplayFont() {
  if (fontAsked || document.querySelector('link[href*="family=Oswald"]')) return
  fontAsked = true
  document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&display=swap' }))
}

/** The personal look, applied while Safarnaama is open in the personal space: { palette, recolour }. */
export function usePersonalLook(personal) {
  const [index, setIndex] = useState(savedPalette)
  const palette = PALETTES[index]
  useEffect(() => {
    const root = document.documentElement
    if (!personal) return
    loadDisplayFont()
    root.dataset.paTheme = 'personal'
    palette.forEach((c, i) => {
      root.style.setProperty(`--pc-${i + 1}`, c)
      root.style.setProperty(`--pc-on-${i + 1}`, inkOn(c))
    })
    return () => {
      delete root.dataset.paTheme
      palette.forEach((_, i) => {
        root.style.removeProperty(`--pc-${i + 1}`)
        root.style.removeProperty(`--pc-on-${i + 1}`)
      })
    }
  }, [personal, palette])
  const recolour = () =>
    setIndex((i) => {
      const next = (i + 1) % PALETTES.length
      try {
        localStorage.setItem(KEY, String(next))
      } catch {
        /* the choice just isn't remembered */
      }
      return next
    })
  return { palette, recolour }
}
