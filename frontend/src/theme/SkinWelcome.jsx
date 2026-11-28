import { Sparkle } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { SITE } from '../site/config'
import { greeting } from './skin'

/**
 * A small handwritten hello when someone steps into the personal space (only on an actual switch, never on page load).
 * Decorative: aria-hidden, no pointer events, gone after a couple of seconds.
 */
export function SkinWelcome() {
  const [show, setShow] = useState(0)
  useEffect(() => {
    let timer = 0
    const onSkin = (e) => {
      if (e.detail?.skin !== 'personal') return
      setShow(Date.now())
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setShow(0), 2600)
    }
    window.addEventListener('skin-change', onSkin)
    return () => {
      window.removeEventListener('skin-change', onSkin)
      window.clearTimeout(timer)
    }
  }, [])
  const first = SITE.owner.split(' ')[0]
  return (
    <AnimatePresence>
      {show > 0 && (
        <motion.div
          key={show}
          aria-hidden
          initial={{ opacity: 0, y: 14, rotate: -4 }}
          animate={{ opacity: 1, y: 0, rotate: -2 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ delay: 0.45, duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
          className="pointer-events-none fixed inset-x-0 bottom-[12vh] z-[70] flex justify-center px-6"
        >
          <p className="font-hand glass rounded-2xl px-6 py-3 text-center text-[28px] leading-tight text-ink-100 sm:text-[34px]">
            {greeting(new Date().getHours())}, welcome in <Sparkle className="inline size-6 text-amber-300" aria-hidden />
            <span className="block text-[20px] text-ink-300">make yourself at home · {first}</span>
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
