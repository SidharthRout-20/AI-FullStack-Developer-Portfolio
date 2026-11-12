import { Clock3, Moon, Sun } from 'lucide-react'
import { motion } from 'motion/react'
import { useId } from 'react'
import { DAY_START, NIGHT_START, setThemeMode, useTheme } from './theme'

const OPTIONS = [
  { mode: 'light', icon: Sun, label: 'Light' },
  { mode: 'auto', icon: Clock3, label: `Auto: light ${DAY_START}am–${NIGHT_START - 12}pm local time` },
  { mode: 'dark', icon: Moon, label: 'Dark' },
]

/** Three-way segmented control: Light · Auto (local time) · Dark. */
export function ThemeToggle({ className = '' }) {
  const { mode, theme } = useTheme()
  const pill = useId()

  const pick = (next) => (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    setThemeMode(next, { x: r.left + r.width / 2, y: r.top + r.height / 2 })
  }

  return (
    <div
      role="radiogroup"
      aria-label={`Theme (currently ${theme})`}
      className={`relative flex items-center rounded-full border border-white/10 bg-white/[0.03] p-0.5 ${className}`}
    >
      {OPTIONS.map(({ mode: m, icon: Icon, label }) => {
        const active = m === mode
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={pick(m)}
            className={`relative grid size-7 place-items-center rounded-full transition-colors ${
              active ? 'text-white' : 'text-ink-400 hover:text-ink-200'
            }`}
          >
            {active && (
              <motion.span
                layoutId={pill}
                className="absolute inset-0 rounded-full bg-white/10 ring-1 ring-white/10"
                transition={{ type: 'spring', stiffness: 500, damping: 35 }}
              />
            )}
            <Icon className="relative size-3.5" />
          </button>
        )
      })}
    </div>
  )
}
