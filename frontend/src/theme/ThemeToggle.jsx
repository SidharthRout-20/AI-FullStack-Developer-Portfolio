import { ModeToggle } from '@appcore/web/ModeToggle'
import { SkinSwitch } from './SkinSwitch'

/** Skin switch (Studio / Off the clock) + the shared Light · Auto · Dark control. */
export function ThemeToggle({ className = '', compact = false }) {
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <SkinSwitch compact={compact} />
      <ModeToggle />
    </div>
  )
}
