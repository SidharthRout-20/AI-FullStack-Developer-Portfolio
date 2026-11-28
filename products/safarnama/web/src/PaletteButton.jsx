/** The personal space's palette button: recolours Safarnaama's cards with the next palette. */
import { Palette } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useState } from 'react'

export function PaletteButton({ onClick }) {
  const reduce = useReducedMotion()
  const [turns, setTurns] = useState(0)
  return (
    <motion.button
      type="button"
      aria-label="Change the colours"
      title="Change the colours"
      onClick={() => {
        onClick()
        setTurns((t) => t + 1)
      }}
      animate={reduce ? undefined : { rotate: turns * 360 }}
      transition={{ type: 'spring', stiffness: 120, damping: 14 }}
      whileTap={{ scale: 0.9 }}
      className="pc-round grid size-8 place-items-center rounded-full"
    >
      <Palette className="size-[17px]" aria-hidden />
    </motion.button>
  )
}
