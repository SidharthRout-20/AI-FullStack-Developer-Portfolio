import { GripVertical } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'

const STORAGE_KEY = 'documind.split'
const MIN = 0.28
const MAX = 0.72

function readRatio() {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY))
    return v >= MIN && v <= MAX ? v : 0.46
  } catch {
    return 0.46
  }
}

/**
 * Two resizable panes with an accessible drag handle (pointer + arrow keys).
 * The ratio is remembered per browser as a convenience.
 */
export function SplitPane({ left, right }) {
  const [ratio, setRatio] = useState(readRatio)
  const [dragging, setDragging] = useState(false)
  const containerRef = useRef(null)

  const commit = useCallback((r) => {
    const clamped = Math.min(MAX, Math.max(MIN, r))
    setRatio(clamped)
    try {
      localStorage.setItem(STORAGE_KEY, String(clamped))
    } catch {
      /* storage unavailable — keep in memory only */
    }
  }, [])

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }
  const onPointerMove = (e) => {
    if (!dragging || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    commit((e.clientX - rect.left) / rect.width)
  }
  const onKeyDown = (e) => {
    if (e.key === 'ArrowLeft') commit(ratio - 0.03)
    if (e.key === 'ArrowRight') commit(ratio + 0.03)
  }

  return (
    <div ref={containerRef} className={`flex h-full min-h-0 ${dragging ? 'cursor-col-resize select-none' : ''}`}>
      <div className="min-h-0 min-w-0" style={{ flexBasis: `${ratio * 100}%` }}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={MIN * 100}
        aria-valuemax={MAX * 100}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDragging(false)}
        onKeyDown={onKeyDown}
        onDoubleClick={() => commit(0.46)}
        className="group relative z-10 flex w-3 shrink-0 cursor-col-resize items-center justify-center outline-none"
      >
        <span
          className={`absolute inset-y-4 w-px transition-colors ${dragging ? 'bg-brand-400' : 'bg-white/8 group-hover:bg-brand-400/60 group-focus-visible:bg-brand-400'}`}
        />
        <span className="relative grid h-9 w-3.5 place-items-center rounded-md border border-white/10 bg-ink-850 text-ink-400 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
          <GripVertical className="size-3" />
        </span>
      </div>
      <div className="min-h-0 min-w-0 flex-1">{right}</div>
    </div>
  )
}
