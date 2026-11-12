import { BaseEdge, getSmoothStepPath } from '@xyflow/react'
import { memo } from 'react'

/**
 * Smooth-step edge whose look follows the run:
 *  live      → dashed, glowing, with particles streaming along the path
 *  traversed → solid green with a slow "data packet"
 *  dim       → branch not taken
 */
function FlowEdgeImpl({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}) {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 16,
  })
  const state = data?.state ?? 'idle'
  const dashed = data?.conditional && state === 'idle'

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={`flow-edge flow-edge--${state}`}
        style={dashed ? { strokeDasharray: '4 6' } : undefined}
      />
      {state === 'live' &&
        [0, 0.33, 0.66].map((delay) => (
          <circle key={delay} r={3.2} fill="#c7d2fe" style={{ filter: 'drop-shadow(0 0 6px #818cf8)' }}>
            <animateMotion dur="1.1s" begin={`-${delay}s`} repeatCount="indefinite" path={path} />
          </circle>
        ))}
      {state === 'traversed' && (
        <circle r={2.4} fill="#6ee7b7" opacity={0.9}>
          <animateMotion dur="2.6s" repeatCount="indefinite" path={path} />
        </circle>
      )}
    </>
  )
}

export const FlowEdge = memo(FlowEdgeImpl)
