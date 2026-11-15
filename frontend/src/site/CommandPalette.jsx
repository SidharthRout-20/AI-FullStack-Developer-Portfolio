import { ArrowRight, Clock3, CornerDownLeft, LayoutGrid, Moon, Search, Sun } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { navigate } from '../router'
import { setThemeMode } from '../theme/theme'
import { PRODUCTS, productHref, STATUSES } from './products'

const OPEN_EVENT = 'app:palette'
export const openPalette = () => window.dispatchEvent(new Event(OPEN_EVENT))

function buildActions() {
  return [
    ...PRODUCTS.map((p) => ({
      id: `p-${p.slug}`,
      label: p.name,
      hint: p.visibility === 'labs' ? 'Labs · open app' : `${STATUSES[p.status].label} · product page`,
      group: p.visibility === 'labs' ? 'Labs' : 'Products',
      icon: p.icon,
      run: () => navigate(productHref(p)),
    })),
    { id: 'hub', label: 'All products', hint: 'Portfolio home', group: 'Navigate', icon: LayoutGrid, run: () => navigate('/') },
    { id: 't-light', label: 'Light theme', hint: 'Theme', group: 'Theme', icon: Sun, run: () => setThemeMode('light') },
    { id: 't-dark', label: 'Dark theme', hint: 'Theme', group: 'Theme', icon: Moon, run: () => setThemeMode('dark') },
    { id: 't-auto', label: 'Auto theme (local time)', hint: 'Theme', group: 'Theme', icon: Clock3, run: () => setThemeMode('auto') },
  ]
}

/** Subsequence match ("kpr" → "Keeper"), scored so prefix and word-start hits rank first. */
export function fuzzyScore(query, text) {
  const q = query.toLowerCase().trim()
  const t = text.toLowerCase()
  if (!q) return 1
  if (t.startsWith(q)) return 3
  if (t.includes(` ${q}`)) return 2.5
  if (t.includes(q)) return 2
  let i = 0
  for (const ch of t) if (ch === q[i]) i++
  return i === q.length ? 1 : 0
}

/** ⌘K / Ctrl+K anywhere: jump to a product, go home, or switch theme. */
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef(null)
  const actions = useMemo(() => buildActions(), [])

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [])

  const results = useMemo(
    () =>
      actions
        .map((a) => ({ a, s: Math.max(fuzzyScore(query, a.label), fuzzyScore(query, a.hint) * 0.5) }))
        .filter((r) => r.s > 0)
        .sort((x, y) => y.s - x.s)
        .map((r) => r.a),
    [actions, query],
  )

  const close = () => {
    setOpen(false)
    setQuery('')
    setActive(0)
  }
  const run = (a) => {
    if (!a) return
    close()
    a.run()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[70] flex items-start justify-center bg-ink-950/50 px-4 pt-[14vh] backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && close()}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="glass w-full max-w-lg overflow-hidden rounded-2xl"
            initial={{ opacity: 0, y: -12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            onAnimationComplete={() => input.current?.focus()}
          >
            <div className="flex items-center gap-3 border-b border-white/[0.06] px-4">
              <Search className="size-4 text-ink-400" />
              <input
                ref={input}
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActive(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setActive((i) => Math.min(i + 1, results.length - 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setActive((i) => Math.max(i - 1, 0))
                  } else if (e.key === 'Enter') {
                    run(results[active])
                  } else if (e.key === 'Escape') {
                    close()
                  }
                }}
                placeholder="Jump to a product, or type 'dark'…"
                aria-label="Search commands"
                className="h-12 flex-1 bg-transparent text-[14px] text-white outline-none placeholder:text-ink-500"
              />
              <kbd className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-ink-400">Esc</kbd>
            </div>
            <ul role="listbox" className="max-h-[50vh] overflow-y-auto p-2">
              {results.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-ink-400">No matches</li>}
              {results.map((a, i) => {
                const Icon = a.icon
                const showGroup = i === 0 || results[i - 1]?.group !== a.group
                return (
                  <li key={a.id} role="option" aria-selected={i === active}>
                    {showGroup && (
                      <p className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-[0.14em] text-ink-500 uppercase">{a.group}</p>
                    )}
                    <button
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => run(a)}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                        i === active ? 'bg-white/[0.07] text-white' : 'text-ink-200'
                      }`}
                    >
                      <Icon className="size-4 shrink-0 text-ink-300" />
                      <span className="flex-1 text-[13.5px] font-medium">{a.label}</span>
                      <span className="text-[11.5px] text-ink-400">{a.hint}</span>
                      {i === active ? (
                        <CornerDownLeft className="size-3.5 text-ink-400" />
                      ) : (
                        <ArrowRight className="size-3.5 opacity-0" />
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Header affordance that shows the shortcut (keyboard users discover it, mouse users click it). */
export function PaletteButton() {
  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
  return (
    <button
      type="button"
      onClick={openPalette}
      className="hidden h-8 items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] pr-1.5 pl-3 text-[12px] text-ink-400 transition hover:border-white/20 hover:text-ink-200 sm:flex"
    >
      <Search className="size-3.5" />
      Search
      <kbd className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-px font-mono text-[10px]">
        {mac ? '⌘' : 'Ctrl'} K
      </kbd>
    </button>
  )
}
