import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react'
import {
  Archive,
  Braces,
  CheckCircle2,
  Clock,
  Copy,
  FileText,
  Flag,
  GitBranch,
  Globe,
  Play,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Webhook,
  Workflow,
  XCircle,
  Zap,
} from 'lucide-react'
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { apiUrl } from '../../lib/apiBase'
import { ApiError, del, errorText, get, post, put, streamPost } from '../shared/http'
import { Button, Card, ErrorNote, Field, inputClass, Pill, ProductShell, Spinner } from '@appcore/web/ui'

const ACCENT = 'from-violet-500 via-purple-500 to-fuchsia-500'

const META = {
  trigger: { label: 'Trigger', icon: Zap, tint: 'text-amber-300 bg-amber-500/10', hint: 'Starts the flow; its payload is {{input}}' },
  llm: { label: 'LLM', icon: Sparkles, tint: 'text-violet-300 bg-violet-500/10', hint: 'Prompt a model' },
  template: { label: 'Template', icon: FileText, tint: 'text-sky-300 bg-sky-500/10', hint: 'Compose text from earlier outputs' },
  http: { label: 'HTTP', icon: Globe, tint: 'text-cyan-300 bg-cyan-500/10', hint: 'Call a public https:// URL' },
  condition: { label: 'Condition', icon: GitBranch, tint: 'text-orange-300 bg-orange-500/10', hint: 'Branch on true / false' },
  extract: { label: 'Extract', icon: Braces, tint: 'text-emerald-300 bg-emerald-500/10', hint: 'Pull fields out as JSON' },
  keeper: { label: 'Keeper', icon: Archive, tint: 'text-pink-300 bg-pink-500/10', hint: 'Save to your Keeper assistant' },
  output: { label: 'Output', icon: Flag, tint: 'text-ink-200 bg-white/[0.06]', hint: 'What the flow returns' },
}

const DEFAULTS = {
  trigger: { label: 'Start', sample: '' },
  llm: { label: 'LLM', prompt: 'Summarise:\n\n{{input}}' },
  template: { label: 'Template', text: '{{input}}' },
  http: { label: 'HTTP', url: 'https://', method: 'GET' },
  condition: { label: 'Condition', value: '{{input}}', op: 'contains', arg: '' },
  extract: { label: 'Extract', text: '{{input}}', fields: 'name, date' },
  keeper: { label: 'Save to Keeper', text: '{{input}}' },
  output: { label: 'Output', value: '{{input}}' },
}

const RunContext = createContext({})

const FlowNode = memo(function FlowNode({ id, type, data, selected }) {
  const t = fromCanvas(type)
  const m = META[t]
  const state = useContext(RunContext)[id] ?? 'idle'
  const Icon = m.icon
  const ring = {
    idle: selected ? 'border-violet-400/60' : 'border-white/10',
    running: 'node-card--active',
    done: 'border-emerald-400/50',
    skipped: 'node-card--skipped border-white/10',
    error: 'border-rose-400/70',
  }[state]
  const detail = String(data.prompt ?? data.url ?? data.text ?? data.value ?? data.fields ?? data.sample ?? '').slice(0, 46)
  return (
    <div className={`node-card w-[200px] border bg-ink-850 px-3 py-2.5 shadow-lg shadow-black/20 ${ring}`}>
      {t !== 'trigger' && <Handle type="target" position={Position.Left} className="!size-2.5 !border-0 !bg-violet-400" />}
      <div className="flex items-center gap-2">
        <span className={`grid size-7 place-items-center rounded-lg ${m.tint}`}><Icon className="size-3.5" /></span>
        <div className="min-w-0">
          <p className="truncate text-[12.5px] font-semibold text-white">{data.label || m.label}</p>
          <p className="text-[10px] tracking-wide text-ink-500 uppercase">{m.label}</p>
        </div>
        {state === 'done' && <CheckCircle2 className="ml-auto size-4 text-emerald-300" />}
        {state === 'error' && <XCircle className="ml-auto size-4 text-rose-300" />}
      </div>
      {detail && <p className="mt-1.5 truncate font-mono text-[10.5px] text-ink-400">{detail}</p>}
      {t === 'condition' ? (
        <>
          <Handle id="true" type="source" position={Position.Right} style={{ top: '35%' }} className="!size-2.5 !border-0 !bg-emerald-400" />
          <Handle id="false" type="source" position={Position.Right} style={{ top: '75%' }} className="!size-2.5 !border-0 !bg-rose-400" />
          <span className="absolute top-[26%] -right-9 text-[9px] text-emerald-300">true</span>
          <span className="absolute top-[66%] -right-9 text-[9px] text-rose-300">false</span>
        </>
      ) : (
        t !== 'output' && <Handle type="source" position={Position.Right} className="!size-2.5 !border-0 !bg-violet-400" />
      )}
    </div>
  )
})

// Canvas types are prefixed: React Flow ships built-in "input"/"output" node styles we don't want.
const toCanvasType = (t) => `ff-${t}`
const fromCanvas = (t) => (t ?? 'ff-llm').replace(/^ff-/, '')
const nodeTypes = Object.fromEntries(Object.keys(META).map((k) => [toCanvasType(k), FlowNode]))

const toCanvas = (f) => ({
  nodes: f.nodes.map((n) => ({ id: n.id, type: toCanvasType(n.type), data: n.data, position: n.position })),
  edges: f.edges.map((e, i) => ({
    id: `e${i}-${e.source}-${e.target}-${e.sourceHandle ?? ''}`,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? null,
    animated: false,
    style: { stroke: e.sourceHandle === 'false' ? 'var(--color-rose-400)' : e.sourceHandle === 'true' ? 'var(--color-emerald-400)' : 'var(--color-ink-500)' },
  })),
})

const BLANK = {
  name: 'Untitled flow',
  trigger: { type: 'manual' },
  nodes: [
    { id: 'trigger', type: 'trigger', data: { label: 'Start', sample: 'Paste some text here' }, position: { x: 0, y: 80 } },
    { id: 'llm1', type: 'llm', data: { label: 'Summarise', prompt: 'Summarise in one sentence:\n\n{{input}}' }, position: { x: 260, y: 80 } },
    { id: 'out', type: 'output', data: { label: 'Output', value: '{{llm1}}' }, position: { x: 520, y: 80 } },
  ],
  edges: [{ source: 'trigger', target: 'llm1' }, { source: 'llm1', target: 'out' }],
}

export default function FlowForgeApp() {
  const [flows, setFlows] = useState(null)
  const [templates, setTemplates] = useState([])
  const [meta, setMeta] = useState(null)
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [selected, setSelected] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [errors, setErrors] = useState({ message: null, items: [] })
  const [saving, setSaving] = useState(false)
  const [run, setRun] = useState({
    states: {},
    outputs: {},
    output: null,
    status: null,
    busy: false,
  })
  const [payload, setPayload] = useState('')
  const [runs, setRuns] = useState([])

  const loadList = useCallback(() => get('/api/flows').then((l) => (setFlows(l), l)), [])
  useEffect(() => {
    void get('/api/flows/templates').then(setTemplates).catch(() => setTemplates([]))
    void loadList().catch(() => setFlows([]))
  }, [loadList])

  const open = (f) => {
    const c = toCanvas(f)
    setNodes(c.nodes)
    setEdges(c.edges)
    setMeta({ id: f.id ?? '', name: f.name, description: f.description, trigger: f.trigger, hook_token: f.hook_token, last_run: f.last_run })
    setSelected(null)
    setDirty(!f.id)
    setErrors({ message: null, items: [] })
    setRun({ states: {}, outputs: {}, output: null, status: null, busy: false })
    const trig = f.nodes.find((n) => n.type === 'trigger')
    setPayload(String(trig?.data.sample ?? ''))
    if (f.id) void get(`/api/flows/${f.id}/runs`).then(setRuns)
    else setRuns([])
  }

  const serialise = () => ({
    name: meta?.name || 'Untitled flow',
    description: meta?.description ?? null,
    trigger: meta?.trigger ?? { type: 'manual' },
    nodes: nodes.map((n) => ({ id: n.id, type: fromCanvas(n.type), data: n.data, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })),
    edges: edges.map((e) => ({ source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
  })

  const save = async () => {
    setSaving(true)
    setErrors({ message: null, items: [] })
    try {
      const body = serialise()
      const saved = meta?.id ? await put(`/api/flows/${meta.id}`, body) : await post('/api/flows', body)
      setMeta((m) => ({ ...(m ?? saved), id: saved.id, hook_token: saved.hook_token, name: saved.name, trigger: saved.trigger }))
      setDirty(false)
      void loadList()
      return saved
    } catch (e) {
      setErrors({ message: errorText(e), items: e instanceof ApiError ? e.errors : [] })
      return null
    } finally {
      setSaving(false)
    }
  }

  const execute = async () => {
    const flow = dirty || !meta?.id ? await save() : { id: meta.id }
    if (!flow) return
    setRun({ states: {}, outputs: {}, output: null, status: null, busy: true })
    setEdges((es) => es.map((e) => ({ ...e, animated: false })))
    try {
      await streamPost(`/api/flows/${flow.id}/run`, { payload: payload || null }, (ev) => {
        const node = ev.node
        setRun((r) => {
          const states = { ...r.states }
          const outputs = { ...r.outputs }
          if (ev.event === 'node_start' && node) states[node] = 'running'
          if (ev.event === 'node_end' && node) {
            states[node] = 'done'
            outputs[node] = ev.output
          }
          if (ev.event === 'node_skip' && node) states[node] = 'skipped'
          if (ev.event === 'node_error' && node) {
            states[node] = 'error'
            outputs[node] = ev.message
          }
          if (ev.event === 'done') return { ...r, states, outputs, output: ev.output, status: String(ev.status), ms: Number(ev.ms), busy: false }
          return { ...r, states, outputs }
        })
        if (ev.event === 'node_end' && node) setEdges((es) => es.map((e) => (e.source === node ? { ...e, animated: true } : e)))
      })
    } catch (e) {
      setErrors({ message: errorText(e), items: [] })
    } finally {
      setRun((r) => ({ ...r, busy: false }))
      void get(`/api/flows/${flow.id}/runs`).then(setRuns)
    }
  }

  const addNode = (type) => {
    const taken = new Set(nodes.map((x) => x.id))
    const canvasType = toCanvasType(type)
    let n = 1
    while (taken.has(`${type}${n}`)) n++
    const id = `${type}${n}`
    const maxX = Math.max(0, ...nodes.map((x) => x.position.x))
    setNodes((ns) => [...ns, { id, type: canvasType, data: { ...DEFAULTS[type] }, position: { x: maxX + 60, y: 260 + (ns.length % 3) * 40 } }])
    setSelected(id)
    setDirty(true)
  }

  const onConnect = useCallback(
    (c) => {
      setEdges((es) =>
        addEdge(
          { ...c, style: { stroke: c.sourceHandle === 'false' ? 'var(--color-rose-400)' : c.sourceHandle === 'true' ? 'var(--color-emerald-400)' : 'var(--color-ink-500)' } },
          es,
        ),
      )
      setDirty(true)
    },
    [setEdges],
  )

  const node = nodes.find((n) => n.id === selected) ?? null
  const setData = (key, value) => {
    setNodes((ns) => ns.map((n) => (n.id === selected ? { ...n, data: { ...n.data, [key]: value } } : n)))
    setDirty(true)
  }
  const hookUrl = meta?.hook_token ? apiUrl(`/api/hooks/${meta.hook_token}`) : null
  const refs = useMemo(() => ['input', ...nodes.filter((n) => n.id !== selected && fromCanvas(n.type) !== 'trigger').map((n) => n.id)], [nodes, selected])

  return (
    <ProductShell
      name="FlowForge"
      tagline="Build your own AI automations by dragging steps onto a canvas"
      icon={Workflow}
      accent={ACCENT}
      right={meta && dirty ? <Pill tone="warn">unsaved</Pill> : undefined}
    >
      {!meta ? (
        <Gallery flows={flows} templates={templates} onOpen={open} onDelete={async (f) => { await del(`/api/flows/${f.id}`); void loadList() }} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" onClick={() => setMeta(null)}>← Flows</Button>
              <input
                aria-label="Flow name"
                className="min-w-0 flex-1 rounded-lg bg-transparent px-2 py-1 text-lg font-semibold text-white outline-none focus:bg-white/[0.04]"
                value={meta.name}
                onChange={(e) => {
                  setMeta({ ...meta, name: e.target.value })
                  setDirty(true)
                }}
              />
              <Button variant="ghost" onClick={() => void save()} busy={saving}><Save className="size-4" /> Save</Button>
              <Button accent={ACCENT} onClick={() => void execute()} busy={run.busy}><Play className="size-4" /> Run</Button>
            </div>
            <div className="flex flex-wrap gap-1.5" aria-label="Add a step">
              {Object.keys(META).filter((t) => t !== 'trigger').map((t) => {
                const Icon = META[t].icon
                return (
                  <button key={t} type="button" className="chip" title={META[t].hint} onClick={() => addNode(t)}>
                    <Plus className="size-3" /> <Icon className="size-3.5" /> {META[t].label}
                  </button>
                )
              })}
            </div>
            <ErrorNote message={errors.message} items={errors.items} />
            <div className="h-[600px] overflow-hidden rounded-2xl border border-white/[0.07] bg-ink-900/40">
              <RunContext.Provider value={run.states}>
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={(c) => {
                    onNodesChange(c)
                    if (c.some((x) => x.type === 'remove' || (x.type === 'position' && x.dragging === false))) setDirty(true)
                  }}
                  onEdgesChange={(c) => {
                    onEdgesChange(c)
                    if (c.some((x) => x.type === 'remove')) setDirty(true)
                  }}
                  onConnect={onConnect}
                  onNodeClick={(_, n) => setSelected(n.id)}
                  onPaneClick={() => setSelected(null)}
                  fitView
                  fitViewOptions={{ padding: 0.25 }}
                  deleteKeyCode={['Delete', 'Backspace']}
                >
                  <Background variant={BackgroundVariant.Dots} gap={20} size={1.1} color="var(--color-ink-700)" />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </RunContext.Provider>
            </div>
          </div>

          <aside className="space-y-4">
            {node ? (
              <Card>
                <div className="flex items-center justify-between">
                  <p className="text-[12px] font-semibold tracking-wide text-ink-300 uppercase">{META[fromCanvas(node.type)].label} step</p>
                  {fromCanvas(node.type) !== 'trigger' && (
                    <button type="button" className="chip" onClick={() => { setNodes((ns) => ns.filter((n) => n.id !== node.id)); setEdges((es) => es.filter((e) => e.source !== node.id && e.target !== node.id)); setSelected(null); setDirty(true) }}>
                      <Trash2 className="size-3.5" /> Remove
                    </button>
                  )}
                </div>
                <p className="mt-1 font-mono text-[11px] text-ink-500">id: {node.id} · reference as {`{{${node.id}}}`}</p>
                <div className="mt-3 space-y-3">
                  <Field label="Label"><input className={inputClass} value={String(node.data.label ?? '')} onChange={(e) => setData('label', e.target.value)} /></Field>
                  <NodeFields type={fromCanvas(node.type)} data={node.data} set={setData} />
                  <p className="text-[11px] text-ink-500">Insert: {refs.map((r) => <code key={r} className="mr-1 text-violet-300">{`{{${r}}}`}</code>)}</p>
                  {run.outputs[node.id] !== undefined && (
                    <div>
                      <p className="text-[11px] font-semibold text-ink-400 uppercase">Last output</p>
                      <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-ink-950/60 p-2 font-mono text-[11px] whitespace-pre-wrap text-ink-200">{fmtOut(run.outputs[node.id])}</pre>
                    </div>
                  )}
                </div>
              </Card>
            ) : (
              <Card>
                <p className="text-[12px] font-semibold tracking-wide text-ink-300 uppercase">Trigger & deploy</p>
                <div className="mt-3 space-y-3">
                  <Field label="Runs when">
                    <select
                      className={inputClass}
                      value={meta.trigger.type}
                      onChange={(e) => {
                        setMeta({ ...meta, trigger: { type: e.target.value, every_minutes: e.target.value === 'schedule' ? 60 : null } })
                        setDirty(true)
                      }}
                    >
                      <option value="manual">I click Run</option>
                      <option value="webhook">A webhook is called (API endpoint)</option>
                      <option value="schedule">On a schedule</option>
                    </select>
                  </Field>
                  {meta.trigger.type === 'schedule' && (
                    <Field label="Every (minutes)" hint="min 5">
                      <input type="number" min={5} className={inputClass} value={meta.trigger.every_minutes ?? 60} onChange={(e) => { setMeta({ ...meta, trigger: { ...meta.trigger, every_minutes: Number(e.target.value) } }); setDirty(true) }} />
                    </Field>
                  )}
                  {meta.trigger.type === 'webhook' && (hookUrl && !dirty ? (
                    <div className="space-y-2">
                      <p className="text-[12px] text-ink-300"><Webhook className="mr-1 inline size-3.5" />Deployed. POST text or JSON to:</p>
                      <code className="block rounded-lg bg-ink-950/60 p-2 font-mono text-[11px] break-all text-violet-200">{hookUrl}</code>
                      <button type="button" className="chip" onClick={() => void navigator.clipboard.writeText(`curl -X POST ${hookUrl} -H "Content-Type: application/json" -d '{"text":"hello"}'`)}>
                        <Copy className="size-3.5" /> Copy curl
                      </button>
                    </div>
                  ) : (
                    <p className="text-[12px] text-amber-300">Save the flow to get its webhook URL.</p>
                  ))}
                  <p className="text-[11.5px] text-ink-500">Click a step to edit it. Drag from a handle to connect. Select + Delete removes.</p>
                </div>
              </Card>
            )}
            <Card>
              <p className="text-[12px] font-semibold tracking-wide text-ink-300 uppercase">Test run</p>
              <textarea className={`${inputClass} mt-2 min-h-20 font-mono text-[12px]`} value={payload} onChange={(e) => setPayload(e.target.value)} placeholder="Input payload → {{input}}" />
              {run.busy && <div className="mt-2"><Spinner label="Running…" /></div>}
              {run.status && (
                <div className="mt-3">
                  <div className="flex items-center gap-2">
                    <Pill tone={run.status === 'ok' ? 'good' : 'bad'}>{run.status}</Pill>
                    <span className="font-mono text-[11px] text-ink-400">{run.ms} ms</span>
                  </div>
                  <pre id="flow-output" className="mt-2 max-h-56 overflow-auto rounded-lg bg-ink-950/60 p-2.5 text-[12px] whitespace-pre-wrap text-ink-100">{fmtOut(run.output)}</pre>
                </div>
              )}
              {runs.length > 0 && (
                <ul className="mt-3 space-y-1 border-t border-white/[0.06] pt-2">
                  {runs.slice(0, 6).map((r) => (
                    <li key={r.id} className="flex items-center gap-2 text-[11.5px] text-ink-400">
                      {r.status === 'ok' ? <CheckCircle2 className="size-3.5 text-emerald-300" /> : <XCircle className="size-3.5 text-rose-300" />}
                      {new Date(r.created_at).toLocaleTimeString()} · {r.source} · {r.ms} ms
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </aside>
        </div>
      )}
    </ProductShell>
  )
}

const fmtOut = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

function NodeFields({ type, data, set }) {
  const text = (key, label, rows = 4, placeholder = '') => (
    <Field label={label}>
      <textarea className={`${inputClass} font-mono text-[12px]`} rows={rows} value={String(data[key] ?? '')} placeholder={placeholder} onChange={(e) => set(key, e.target.value)} />
    </Field>
  )
  switch (type) {
    case 'trigger':
      return text('sample', 'Sample input (used when you click Run with no payload)', 3)
    case 'llm':
      return (
        <>
          {text('prompt', 'Prompt', 6)}
          {text('system', 'System instructions (optional)', 2)}
        </>
      )
    case 'template':
      return text('text', 'Text', 5)
    case 'http':
      return (
        <>
          <Field label="Method">
            <select className={inputClass} value={String(data.method ?? 'GET')} onChange={(e) => set('method', e.target.value)}>
              <option>GET</option>
              <option>POST</option>
            </select>
          </Field>
          {text('url', 'URL (public https only)', 2)}
          {data.method === 'POST' && text('body', 'JSON body', 3)}
        </>
      )
    case 'condition':
      return (
        <>
          {text('value', 'Value to test', 2)}
          <Field label="Operator">
            <select className={inputClass} value={String(data.op ?? 'contains')} onChange={(e) => set('op', e.target.value)}>
              {['contains', 'equals', 'regex', 'not_empty', 'gt', 'lt'].map((o) => <option key={o}>{o}</option>)}
            </select>
          </Field>
          {data.op !== 'not_empty' && text('arg', 'Compare with', 1)}
        </>
      )
    case 'extract':
      return (
        <>
          {text('text', 'Text', 3)}
          <Field label="Fields (comma-separated)"><input className={inputClass} value={String(data.fields ?? '')} onChange={(e) => set('fields', e.target.value)} /></Field>
        </>
      )
    case 'keeper':
      return text('text', 'Message for Keeper (e.g. "remind me to …")', 3)
    case 'output':
      return text('value', 'Output', 4)
  }
}

function Gallery({
  flows,
  templates,
  onOpen,
  onDelete,
}) {
  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-[13px] font-semibold tracking-wide text-ink-300 uppercase">Start a flow</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <button type="button" onClick={() => onOpen(BLANK)} className="rounded-2xl border border-dashed border-white/15 p-5 text-left transition hover:border-violet-400/50">
            <Plus className="size-5 text-violet-300" />
            <p className="mt-2 text-[14.5px] font-semibold text-white">Blank flow</p>
            <p className="text-[12.5px] text-ink-400">Trigger → LLM → Output, ready to extend.</p>
          </button>
          {templates.map((t) => (
            <button key={t.name} type="button" onClick={() => onOpen(t)} className="rounded-2xl border border-white/[0.07] bg-ink-900/60 p-5 text-left transition hover:border-violet-400/40">
              <div className="flex gap-1">
                {[...new Set(t.nodes.map((n) => n.type))].map((ty) => {
                  const Icon = META[ty].icon
                  return <span key={ty} className={`grid size-6 place-items-center rounded-md ${META[ty].tint}`}><Icon className="size-3" /></span>
                })}
              </div>
              <p className="mt-2 text-[14.5px] font-semibold text-white">{t.name}</p>
              <p className="text-[12.5px] text-ink-400">{t.description}</p>
            </button>
          ))}
        </div>
      </section>
      <section>
        <h2 className="text-[13px] font-semibold tracking-wide text-ink-300 uppercase">Your flows</h2>
        {!flows ? (
          <Spinner label="Loading…" />
        ) : flows.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-500">Nothing saved yet. Pick a template above.</p>
        ) : (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {flows.map((f) => (
              <li key={f.id} className="group relative rounded-2xl border border-white/[0.07] bg-ink-900/60 p-4 transition hover:border-white/15">
                <button type="button" onClick={() => onOpen(f)} className="block w-full text-left">
                  <p className="text-[14.5px] font-semibold text-white">{f.name}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-400">
                    {f.trigger.type === 'webhook' ? <Webhook className="size-3.5" /> : f.trigger.type === 'schedule' ? <Clock className="size-3.5" /> : <Play className="size-3.5" />}
                    {f.trigger.type === 'schedule' ? `every ${f.trigger.every_minutes} min` : f.trigger.type} · {f.nodes.length} steps
                    {f.last_run && <Pill tone={f.last_run.status === 'ok' ? 'good' : 'bad'}>{f.last_run.status} · {f.last_run.ms} ms</Pill>}
                  </p>
                </button>
                <button type="button" aria-label={`Delete ${f.name}`} onClick={() => onDelete(f)} className="absolute top-3 right-3 grid size-7 place-items-center rounded-lg text-ink-500 opacity-0 group-hover:opacity-100 hover:text-rose-300">
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
