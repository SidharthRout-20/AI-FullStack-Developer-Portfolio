import { Background, BackgroundVariant, Controls, MarkerType, ReactFlow } from '@xyflow/react'
import { Code2, ExternalLink, FolderGit2, GitFork, Map as MapIcon, MessageSquareCode, Network, Plus, Trash2 } from 'lucide-react'
import { motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { del, errorText, get, post, streamPost } from '../shared/http'
import { Answer, Button, Card, Empty, ErrorNote, inputClass, ProductShell, Spinner, Steps, Tabs } from '@appcore/web/ui'

const ACCENT = 'from-amber-500 via-orange-500 to-rose-500'

const blobUrl = (r, path, start, end) =>
  `${r.url}/blob/HEAD/${path}${start ? `#L${start}${end ? `-L${end}` : ''}` : ''}`

export default function CodeLensApp() {
  const [repos, setRepos] = useState(null)
  const [active, setActive] = useState(null)
  const [tab, setTab] = useState('ask')
  const [url, setUrl] = useState('')
  const [steps, setSteps] = useState([])
  const [indexing, setIndexing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    const list = await get('/api/code/repos').catch(() => [])
    setRepos(list)
    return list
  }, [])
  useEffect(() => {
    let alive = true
    get('/api/code/repos')
      .catch(() => [])
      .then((l) => {
        if (!alive) return
        setRepos(l)
        setActive((a) => a ?? l[0] ?? null)
      })
    return () => {
      alive = false
    }
  }, [])

  const index = async () => {
    setIndexing(true)
    setError(null)
    setSteps([])
    try {
      await streamPost('/api/code/repos', { url: url.trim() }, (ev) => {
        if (ev.event === 'stage')
          setSteps((s) => [...s.map((x) => ({ ...x, done: true })), { name: String(ev.stage), detail: String(ev.detail ?? ''), done: false }])
        else if (ev.event === 'done') {
          setSteps((s) => s.map((x) => ({ ...x, done: true })))
          const repo = ev.repo
          setActive(repo)
          setTab('ask')
          setUrl('')
          void load()
        } else if (ev.event === 'error') setError(String(ev.message))
      })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setIndexing(false)
    }
  }

  const remove = async (r) => {
    await del(`/api/code/repos/${r.id}`)
    const list = await load()
    setActive(list[0] ?? null)
  }

  return (
    <ProductShell name="CodeLens" tagline="Understand any codebase in minutes" icon={Code2} accent={ACCENT}>
      <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <Card>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void index()
              }}
              className="space-y-2.5"
            >
              <label className="text-[12px] font-medium text-ink-300" htmlFor="repo-url">Index a public GitHub repo</label>
              <input id="repo-url" className={inputClass} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" />
              <Button type="submit" accent={ACCENT} busy={indexing} disabled={!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(url.trim())} className="w-full">
                <Plus className="size-4" /> Index repository
              </Button>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {['https://github.com/pallets/itsdangerous', 'https://github.com/sindresorhus/ky'].map((u) => (
                  <button key={u} type="button" className="chip" onClick={() => setUrl(u)}>{u.split('/').slice(-1)[0]}</button>
                ))}
              </div>
            </form>
            {steps.length > 0 && <div className="mt-4"><Steps steps={steps} active={indexing} /></div>}
            <div className="mt-3"><ErrorNote message={error} /></div>
          </Card>
          {repos && repos.length > 0 && (
            <ul className="space-y-1.5">
              {repos.map((r) => (
                <li key={r.id} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setActive(r)}
                    className={`flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px] ${active?.id === r.id ? 'bg-white/[0.07] text-white ring-1 ring-white/10' : 'text-ink-300 hover:text-white'}`}
                  >
                    <FolderGit2 className="size-4 shrink-0 text-orange-300" />
                    <span className="truncate">{r.owner}/<b className="font-semibold">{r.name}</b></span>
                  </button>
                  <button type="button" aria-label={`Remove ${r.name}`} onClick={() => void remove(r)} className="grid size-7 place-items-center rounded-lg text-ink-500 opacity-0 group-hover:opacity-100 hover:text-rose-300">
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="min-w-0">
          {!active ? (
            repos ? <Empty icon={GitFork} title="Index your first repository" text="CodeLens downloads the repo, chunks it by function and class, embeds it locally and maps its imports." /> : <Spinner label="Loading…" />
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <h1 className="text-xl font-semibold text-white">{active.owner}/{active.name}</h1>
                <a href={active.url} target="_blank" rel="noopener noreferrer" className="chip"><ExternalLink className="size-3.5" /> GitHub</a>
                <span className="text-[12px] text-ink-400">{active.files.length} files · {active.chunks} chunks · {active.edges.length} import edges</span>
              </div>
              <LanguageBar langs={active.languages} />
              <Tabs
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: 'ask', label: 'Ask', icon: MessageSquareCode },
                  { id: 'tour', label: 'Guided tour', icon: MapIcon },
                  { id: 'graph', label: 'Dependency graph', icon: Network },
                  { id: 'files', label: 'Files', icon: FolderGit2, badge: active.files.length },
                ]}
              />
              {tab === 'ask' && <AskPanel key={active.id} repo={active} />}
              {tab === 'tour' && <TourPanel key={active.id} repo={active} />}
              {tab === 'graph' && <GraphPanel key={active.id} repo={active} />}
              {tab === 'files' && <FilesPanel key={active.id} repo={active} />}
            </>
          )}
        </div>
      </div>
    </ProductShell>
  )
}

const LANG_COLORS = ['bg-orange-400', 'bg-sky-400', 'bg-violet-400', 'bg-emerald-400', 'bg-rose-400', 'bg-amber-300', 'bg-teal-400']

function LanguageBar({ langs }) {
  const entries = Object.entries(langs).slice(0, 7)
  const total = entries.reduce((s, [, n]) => s + n, 0) || 1
  return (
    <div className="mb-4">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
        {entries.map(([l, n], i) => <div key={l} className={LANG_COLORS[i]} style={{ width: `${(n / total) * 100}%` }} />)}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-3 text-[11px] text-ink-400">
        {entries.map(([l, n], i) => (
          <span key={l} className="flex items-center gap-1"><span className={`size-2 rounded-full ${LANG_COLORS[i]}`} />{l} {Math.round((n / total) * 100)}%</span>
        ))}
      </div>
    </div>
  )
}

function CodeBlock({ snippet, repo }) {
  const lines = snippet.text.split('\n')
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-ink-950/60">
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-1.5 text-[11.5px]">
        <span className="truncate font-mono text-orange-200">{snippet.path} <span className="text-ink-500">L{snippet.start}-{snippet.end}</span></span>
        <a href={blobUrl(repo, snippet.path, snippet.start, snippet.end)} target="_blank" rel="noopener noreferrer" className="shrink-0 text-ink-400 hover:text-white"><ExternalLink className="size-3.5" /></a>
      </div>
      <pre className="max-h-80 overflow-auto py-2 text-[12px] leading-[1.55]">
        {lines.map((l, i) => (
          <div key={i} className="flex">
            <span className="w-11 shrink-0 pr-3 text-right font-mono text-ink-600 select-none">{snippet.start + i}</span>
            <code className="font-mono whitespace-pre text-ink-100">{l}</code>
          </div>
        ))}
      </pre>
    </div>
  )
}

function AskPanel({ repo }) {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [focus, setFocus] = useState(1)
  const [error, setError] = useState(null)
  const ask = async (question = q) => {
    setBusy(true)
    setError(null)
    try {
      setResult(await post(`/api/code/repos/${repo.id}/ask`, { question }))
      setFocus(1)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const src = result?.sources.find((s) => s.n === focus)
  return (
    <div className="space-y-4">
      <form
        className="glass flex gap-2 rounded-2xl p-2"
        onSubmit={(e) => {
          e.preventDefault()
          void ask()
        }}
      >
        <input id="code-question" className="min-w-0 flex-1 bg-transparent px-3 text-[15px] text-white outline-none placeholder:text-ink-500" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Where is authentication handled? How does X work?" />
        <Button type="submit" accent={ACCENT} busy={busy} disabled={q.trim().length < 3}>Ask</Button>
      </form>
      {!result && !busy && (
        <div className="flex flex-wrap gap-1.5">
          {['What is the overall architecture?', 'Where is the main entry point?', 'How are errors handled?'].map((s) => (
            <button key={s} type="button" className="chip" onClick={() => { setQ(s); void ask(s) }}>{s}</button>
          ))}
        </div>
      )}
      <ErrorNote message={error} />
      {busy && <Spinner label="Searching code and reasoning…" />}
      {result && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card><Answer text={result.answer} onCite={setFocus} /></Card>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {result.sources.map((s) => (
                <button key={s.n} type="button" onClick={() => setFocus(s.n)} className={`rounded-lg px-2 py-1 font-mono text-[11px] ring-1 transition ${focus === s.n ? 'bg-orange-500/15 text-orange-200 ring-orange-400/30' : 'text-ink-300 ring-white/10 hover:text-white'}`}>
                  [{s.n}] {s.path.split('/').slice(-1)[0]}:{s.start}
                </button>
              ))}
            </div>
            {src && (
              <motion.div key={src.n} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
                {src.symbol && <p className="mb-1.5 text-[12px] text-ink-400">symbol <code className="text-orange-200">{src.symbol}</code></p>}
                <CodeBlock snippet={src} repo={repo} />
              </motion.div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function useSnippet(repo) {
  const [snippet, setSnippet] = useState(null)
  const open = (path, start = 1, end = 120) =>
    void get(`/api/code/repos/${repo.id}/file?${new URLSearchParams({ path, start: String(start), end: String(end) })}`).then(setSnippet)
  return { snippet, open }
}

function TourPanel({ repo }) {
  const [tour, setTour] = useState(repo.tour)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const { snippet, open } = useSnippet(repo)
  const make = async () => {
    setBusy(true)
    setError(null)
    try {
      setTour(await post(`/api/code/repos/${repo.id}/tour`))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  if (!tour)
    return (
      <Empty icon={MapIcon} title="Onboarding tour" text="An ordered reading path through the codebase for a new engineer: entry points first, then the core.">
        <Button accent={ACCENT} busy={busy} onClick={() => void make()}>Generate tour</Button>
        <div className="mt-3"><ErrorNote message={error} /></div>
      </Empty>
    )
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="space-y-3">
        <Card><p className="text-[14px] leading-relaxed text-ink-100">{tour.overview}</p></Card>
        <ol className="relative space-y-3 border-l border-white/10 pl-5">
          {tour.steps.map((s, i) => (
            <motion.li key={s.path + i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }} className="relative">
              <span className="absolute top-0.5 -left-[29px] grid size-5 place-items-center rounded-full bg-gradient-to-br from-amber-500 to-rose-500 text-[10px] font-bold text-on-accent">{i + 1}</span>
              <p className="text-[14px] font-semibold text-white">{s.title}</p>
              <button type="button" onClick={() => open(s.path)} className="font-mono text-[12px] text-orange-200 hover:underline">{s.path}</button>
              <p className="mt-1 text-[13px] text-ink-300">{s.explanation}</p>
            </motion.li>
          ))}
        </ol>
      </div>
      <div className="min-w-0">{snippet ? <CodeBlock snippet={snippet} repo={repo} /> : <Empty icon={Code2} title="Click a file" text="Its code opens here." />}</div>
    </div>
  )
}

/** Files (or directories, for big repos) laid out in layers by import depth. */
function buildGraph(repo, focus) {
  const byDir = repo.files.length > 70
  const keyOf = (p) => (byDir ? p.split('/').slice(0, -1).join('/') || '(root)' : p)
  const keys = new Set()
  const weights = new Map()
  for (const [a, b] of repo.edges) {
    const ka = keyOf(a)
    const kb = keyOf(b)
    keys.add(ka).add(kb)
    if (ka !== kb) weights.set(`${ka}→${kb}`, (weights.get(`${ka}→${kb}`) ?? 0) + 1)
  }
  if (!keys.size) repo.files.slice(0, 40).forEach((f) => keys.add(keyOf(f)))
  const list = [...keys].slice(0, 120)
  const deps = new Map(list.map((k) => [k, []]))
  for (const pair of weights.keys()) {
    const [a, b] = pair.split('→')
    if (deps.has(a) && deps.has(b)) deps.get(a).push(b)
  }
  // depth = longest import chain below a node (iterative, cycle-safe)
  const depth = new Map(list.map((k) => [k, 0]))
  for (let pass = 0; pass < list.length; pass++) {
    let changed = false
    for (const k of list) for (const d of deps.get(k)) if (depth.get(k) < depth.get(d) + 1 && depth.get(d) + 1 < 30) { depth.set(k, depth.get(d) + 1); changed = true }
    if (!changed) break
  }
  const layers = new Map()
  for (const k of list) layers.set(depth.get(k), [...(layers.get(depth.get(k)) ?? []), k])
  const maxDepth = Math.max(0, ...layers.keys())
  const related = focus ? new Set([focus, ...(deps.get(focus) ?? []), ...list.filter((k) => deps.get(k).includes(focus))]) : null
  const nodes = []
  for (const [d, ks] of layers)
    ks.sort().forEach((k, i) =>
      nodes.push({
        id: k,
        position: { x: (maxDepth - d) * 250, y: i * 64 },
        data: { label: byDir ? `${k}/` : k.split('/').slice(-2).join('/') },
        style: {
          fontSize: 11,
          fontFamily: 'JetBrains Mono Variable, monospace',
          padding: '6px 10px',
          width: 210,
          borderRadius: 10,
          background: 'var(--color-ink-850)',
          color: 'var(--color-ink-100)',
          border: `1px solid ${focus === k ? 'var(--color-orange-400)' : 'var(--hairline)'}`,
          opacity: related && !related.has(k) ? 0.25 : 1,
        },
      }),
    )
  const edges = [...weights.keys()]
    .map((pair) => pair.split('→'))
    .filter(([a, b]) => deps.has(a) && deps.has(b))
    .map(([a, b]) => ({
      id: `${a}→${b}`,
      source: a,
      target: b,
      animated: focus === a || focus === b,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      style: { stroke: focus === a || focus === b ? 'var(--color-orange-400)' : 'var(--color-ink-600)', opacity: related && !(related.has(a) && related.has(b)) ? 0.15 : 1 },
    }))
  return { nodes, edges, byDir }
}

function GraphPanel({ repo }) {
  const [focus, setFocus] = useState(null)
  const { nodes, edges, byDir } = useMemo(() => buildGraph(repo, focus), [repo, focus])
  const { snippet, open } = useSnippet(repo)
  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-ink-400">
        {byDir ? 'Large repo: grouped by directory. ' : ''}Arrows point from importer to imported. Click a node to highlight its neighbours{byDir ? '' : ' and open the file'}.
      </p>
      <div className="h-[560px] overflow-hidden rounded-2xl border border-white/[0.07] bg-ink-900/40">
        {edges.length === 0 ? (
          <Empty icon={Network} title="No internal imports found" text="This repo's files don't import each other via relative paths (common for single-module libraries)." />
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            fitView
            minZoom={0.1}
            nodesConnectable={false}
            onNodeClick={(_, n) => {
              setFocus((f) => (f === n.id ? null : n.id))
              if (!byDir) open(n.id)
            }}
            proOptions={{ hideAttribution: false }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-ink-700)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
      {snippet && <CodeBlock snippet={snippet} repo={repo} />}
    </div>
  )
}

function FilesPanel({ repo }) {
  const [filter, setFilter] = useState('')
  const { snippet, open } = useSnippet(repo)
  const shown = repo.files.filter((f) => f.toLowerCase().includes(filter.toLowerCase())).slice(0, 400)
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <Card className="!p-3">
        <input className={inputClass} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files…" />
        <ul className="mt-2 max-h-[520px] overflow-y-auto">
          {shown.map((f) => (
            <li key={f}>
              <button type="button" onClick={() => open(f)} className={`w-full truncate rounded-md px-2 py-1 text-left font-mono text-[12px] ${snippet?.path === f ? 'bg-white/[0.07] text-white' : 'text-ink-300 hover:text-white'}`}>{f}</button>
            </li>
          ))}
        </ul>
        <p className="mt-2 px-2 text-[11px] text-ink-500">{shown.length} of {repo.files.length}</p>
      </Card>
      <div className="min-w-0">{snippet ? <CodeBlock snippet={snippet} repo={repo} /> : <Empty icon={Code2} title="Pick a file" text="Indexed source files are listed on the left." />}</div>
    </div>
  )
}
