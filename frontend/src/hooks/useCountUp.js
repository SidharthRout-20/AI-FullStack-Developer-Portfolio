import { useEffect, useRef, useState } from 'react'

/** Animate a number from its previous value to `target` (ease-out cubic), for KPI tiles. */
export function useCountUp(target, duration = 650) {
  const [value, setValue] = useState(null)
  const current = useRef(0)

  useEffect(() => {
    let raf = 0
    if (target === null || target === undefined) {
      raf = requestAnimationFrame(() => setValue(null))
      return () => cancelAnimationFrame(raf)
    }
    const from = current.current
    const start = performance.now()
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration)
      const v = from + (target - from) * (1 - Math.pow(1 - t, 3))
      current.current = v
      setValue(v)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])

  return value
}
