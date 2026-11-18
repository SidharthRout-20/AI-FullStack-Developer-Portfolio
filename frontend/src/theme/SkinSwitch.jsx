import { ArrowUpRight } from 'lucide-react'
import { MiniPortrait } from '../site/Portrait'
import { SKIN_NAMES } from './skin'
import { originOf, setSkin, useSkin } from './theme'

/**
 * Switch between the two sides of the site. In the Studio it is a small portrait that hints at the colourful space
 * behind it (hover to see the ring): "Off the clock". Off the clock, it is a quiet "Studio" pill back to work.
 */
export function SkinSwitch({ compact = false }) {
  const skin = useSkin()
  if (skin === 'showcase') {
    const to = SKIN_NAMES.personal
    return (
      <button
        type="button"
        onClick={(e) => setSkin('personal', originOf(e))}
        title={to.hint}
        aria-label={to.hint}
        className="skin-door group flex h-8 items-center gap-2 rounded-full pr-1 pl-1 text-[12px] font-medium text-ink-300 transition-colors hover:text-white sm:pr-3"
      >
        <span className="relative grid size-6 place-items-center">
          <span aria-hidden className="skin-door-ring absolute -inset-[3px] rounded-full opacity-0 transition-opacity duration-500 group-hover:opacity-100 group-focus-visible:opacity-100" />
          <MiniPortrait className="relative size-6 text-[22px]" />
        </span>
        {!compact && <span className="hidden whitespace-nowrap sm:inline">{to.to}</span>}
      </button>
    )
  }
  const to = SKIN_NAMES.showcase
  return (
    <button
      type="button"
      onClick={(e) => setSkin('showcase', originOf(e))}
      title={to.hint}
      aria-label={to.hint}
      className="flex h-8 items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-2.5 text-[12px] font-medium text-ink-300 transition hover:border-white/20 hover:text-white"
    >
      {!compact && <span>{to.to}</span>}
      <ArrowUpRight className="size-3.5" />
    </button>
  )
}
