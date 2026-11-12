import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
} from '@xyflow/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { layoutGraph } from '../../lib/layout'
import { FlowEdge } from './FlowEdge'
import { nodeMetric } from './nodeMeta'
import { NODE_WIDTH, PipelineNode, TERMINAL_WIDTH } from './PipelineNode'

const nodeTypes = { pipeline: PipelineNode }
const edgeTypes = { flow: FlowEdge }

/**
 * Renders the backend's LangGraph topology (left → right) and animates it from live SSE events.
 * Layout is computed once per topology; only node/edge *state* changes per event.
 */
export function WorkflowGraph({ topology, run }) {
  const wrapperRef = useRef(null)
  const [flow, setFlow] = useState(null)

  // fitView only runs on mount; refit whenever the panel is resized (split drag, view switch, window).
  useEffect(() => {
    const el = wrapperRef.current
    if (!el || !flow) return
    const ro = new ResizeObserver(() => flow.fitView({ padding: 0.08, maxZoom: 1.15, duration: 250 }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [flow])

  const positions = useMemo(() => new Map(layoutGraph(topology).map((p) => [p.id, p])), [topology])

  const nodes = useMemo(
    () =>
      topology.nodes.map((n) => {
        const p = positions.get(n.id) ?? { x: 0, y: 0 }
        const r = run.nodes[n.id]
        const terminal = n.id === '__start__' || n.id === '__end__'
        return {
          id: n.id,
          type: 'pipeline',
          // Centre each node on its column; terminals are slimmer pills.
          position: { x: p.x - (terminal ? TERMINAL_WIDTH : NODE_WIDTH) / 2, y: p.y + (terminal ? 6 : 0) },
          draggable: false,
          selectable: false,
          data: {
            label: n.label,
            description: n.description,
            status: r?.status ?? 'idle',
            ms: r?.ms,
            metric: nodeMetric(n.id, r?.detail),
            terminal,
          },
        }
      }),
    [topology, positions, run.nodes],
  )

  const edges = useMemo(() => {
    // An edge is "traversed" when its endpoints appear consecutively in the visited path.
    const traversed = new Set()
    for (let i = 1; i < run.path.length; i++) traversed.add(`${run.path[i - 1]}->${run.path[i]}`)
    const active = run.running ? run.path[run.path.length - 1] : undefined
    const finished = !run.running && run.path.length > 0

    return topology.edges.map((e) => {
      const key = `${e.source}->${e.target}`
      let state = 'idle'
      if (traversed.has(key)) state = run.running && e.target === active ? 'live' : 'traversed'
      else if (finished) state = 'dim'
      const sy = positions.get(e.source)?.y ?? 0
      return {
        id: key,
        source: e.source,
        target: e.target,
        type: 'flow',
        // Branch lanes enter the END node from above/below instead of crossing the main lane.
        targetHandle: e.target === '__end__' && sy !== 0 ? (sy < 0 ? 't' : 'b') : undefined,
        data: { state, conditional: e.conditional },
        zIndex: state === 'live' || state === 'traversed' ? 1 : 0,
      }
    })
  }, [topology.edges, positions, run.path, run.running])

  return (
    <div ref={wrapperRef} className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={setFlow}
        fitView
        fitViewOptions={{ padding: 0.08, maxZoom: 1.15 }}
        nodesConnectable={false}
        nodesDraggable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        panOnScroll
        minZoom={0.12}
        maxZoom={1.5}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#262c3f" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </div>
  )
}
