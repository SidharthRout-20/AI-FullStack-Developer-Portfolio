import { Handle, Position } from '@xyflow/react'
import { Check, LoaderCircle, TriangleExclamationPoint } from 'lucide-react'
import { memo } from 'react'
import { formatMs } from '../../lib/format'
import { NODE_COLOR, NODE_ICONS } from './nodeMeta'

const CARD = {
  idle: 'border-white/[0.08] bg-ink-900/90',
  active: '',
  done: 'border-emerald-400/45 bg-ink-900/95',
  skipped: 'border-white/[0.05] bg-ink-925/80',
  error: 'border-rose-400/70 bg-rose-950/40',
}

const handle = 'h-2! w-2! border-2! border-ink-950! bg-ink-500!'

export const NODE_WIDTH = 196
export const TERMINAL_WIDTH = 118

function PipelineNodeImpl({ id, data }) {
  const Icon = NODE_ICONS[id] ?? Check
  const { status } = data
  const color = NODE_COLOR[id] ?? '#94a3b8'

  if (data.terminal) {
    const isEnd = id === '__end__'
    return (
      <div
        title={data.description}
        style={{ width: TERMINAL_WIDTH }}
        className={`node-card node-card--${status} flex items-center justify-center gap-2 rounded-full! border px-3 py-2 ${CARD[status]}`}
      >
        {isEnd && <Handle type="target" position={Position.Left} className={handle} />}
        {isEnd && <Handle id="t" type="target" position={Position.Top} className={handle} />}
        {isEnd && <Handle id="b" type="target" position={Position.Bottom} className={handle} />}
        <Icon className={`size-3.5 ${status === 'done' ? 'text-emerald-300' : 'text-ink-300'}`} />
        <span className="text-[12px] font-semibold text-ink-100">{data.label}</span>
        {!isEnd && <Handle type="source" position={Position.Right} className={handle} />}
      </div>
    )
  }

  return (
    <div
      title={data.description}
      style={{ width: NODE_WIDTH }}
      className={`node-card node-card--${status} border px-3 py-2.5 backdrop-blur ${CARD[status]}`}
    >
      <Handle type="target" position={Position.Left} className={handle} />
      <div className="flex items-center gap-2.5">
        <span
          className="grid size-9 shrink-0 place-items-center rounded-xl transition-colors duration-500"
          style={{
            background: status === 'skipped' ? 'rgb(255 255 255 / 0.04)' : `${color}1f`,
            color: status === 'skipped' ? '#6f7792' : color,
            boxShadow: status === 'active' ? `0 0 18px ${color}88` : undefined,
          }}
        >
          {status === 'active' ? <LoaderCircle className="size-4 animate-spin" /> : <Icon className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-ink-100">{data.label}</span>
          <span className="block font-mono text-[10.5px] text-ink-400">
            {status === 'active' ? 'running…' : status === 'done' && data.ms !== undefined ? formatMs(data.ms) : id}
          </span>
        </span>
        {status === 'error' && <TriangleExclamationPoint className="size-4 shrink-0 text-rose-300" />}
      </div>
      {data.metric && status === 'done' && (
        <p className="mt-2 truncate border-t border-white/[0.06] pt-1.5 font-mono text-[10.5px] text-ink-300">
          {data.metric}
        </p>
      )}
      <Handle type="source" position={Position.Right} className={handle} />
    </div>
  )
}

export const PipelineNode = memo(PipelineNodeImpl)
