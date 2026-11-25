/**
 * CodeLens: get a new joiner productive on a codebase in a week, without KT sessions.
 *
 * One story, one step at a time: paste a public GitHub repo → watch it being read → walk through the onboarding pack
 * chapter by chapter (what it is, how it's organised, what to read first, the week-one plan) → ask anything, with
 * answers that cite the exact files and lines. A pack has its own link, so a team can hand it to every new joiner.
 */
import { ArrowLeft, ArrowRight, Check, ChevronDown, Code2, Copy, ExternalLink, FolderGit2, MessageSquareCode, Route as RouteIcon, Send, Sparkles, Terminal, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Component, useCallback, useEffect, useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import { navigate, usePath } from '@appcore/web/router'
import { Card, ErrorNote, inputClass, ProductShell, Spinner } from '@appcore/web/ui'
import { errorText, get, post, streamPost } from '../shared/http'

const ACCENT = 'from-amber-500 via-orange-500 to-rose-500'
const BASE = '/codelens'
// Small, public and active, so a first try finishes in well under a minute on the free server.
const EXAMPLES = [
  { url: 'https://github.com/pallets/itsdangerous', lang: 'Python', what: 'signing data safely' },
  { url: 'https://github.com/expressjs/morgan', lang: 'JavaScript', what: 'HTTP request logging' },
  { url: 'https://github.com/pallets/markupsafe', lang: 'Python', what: 'safe HTML strings' },
]
const STAGES = {
  download: 'Downloading the code',
  read: 'Reading the files',
  chunk: 'Understanding the structure',
  embed: 'Building the search index',
  graph: 'Mapping how the files connect',
  pack: 'Writing the onboarding pack',
}
const CHAPTERS = [
  { id: 'overview', title: 'What it is', icon: Sparkles, blurb: 'What the project does and how the parts fit together.' },
  { id: 'areas', title: "How it's organised", icon: FolderGit2, blurb: 'The main parts of the code, and where each lives.' },
  { id: 'path', title: 'What to read first', icon: RouteIcon, blurb: 'An ordered reading path: entry points first.' },
  { id: 'week', title: 'Your first week', icon: Check, blurb: 'A five-day plan with checkpoints, from setup to first change.' },
  { id: 'ask', title: 'Ask anything', icon: MessageSquareCode, blurb: 'Answers with the exact files and lines.' },
]

const blobUrl = (r, path, start, end) => `${r.url}/blob/HEAD/${path}${start ? `#L${start}${end ? `-L${end}` : ''}` : ''}`
const repoIdFrom = (path) => (path.startsWith(`${BASE}/`) ? path.slice(BASE.length + 1).match(/^[\w-]+/)?.[0] ?? null : null)

export default function CodeLensApp() {
  const id = repoIdFrom(usePath())
  return (
    <ProductShell name="CodeLens" tagline="Onboard onto any codebase in a week, without waiting for KT sessions" icon={Code2} accent={ACCENT}>
      <Boundary key={id ?? 'start'}>{id ? <PackView key={id} id={id} /> : <Start />}</Boundary>
    </ProductShell>
  )
}

/** A crash shows a way back, never a blank page. */
class Boundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <p className="text-[18px] font-semibold text-white">Something went wrong on this screen.</p>
        <p className="mt-1 text-[14px] text-ink-400">Nothing was lost. Go back and try again.</p>
        <button type="button" onClick={() => { this.setState({ failed: false }); navigate(BASE) }} className={`mt-5 rounded-full bg-gradient-to-r ${ACCENT} px-5 py-2 text-[14px] font-semibold text-on-accent`}>Back to CodeLens</button>
      </div>
    )
  }
}

// ── 1. Start: one input, examples, packs already built ─────────────────────────
function Start() {
  const [url, setUrl] = useState('')
  const [repos, setRepos] = useState(null)
  const [stages, setStages] = useState(null) // [{ stage, detail, done }] while building
  const [found, setFound] = useState({}) // what the repo turned out to contain, shown while it keeps working
  const [error, setError] = useState(null)
  useEffect(() => void get('/api/code/repos').then(setRepos).catch(() => setRepos([])), [])

  const build = async (target) => {
    setError(null)
    setStages([])
    setFound({ repo: target.trim().replace(/^https:\/\/github\.com\//, '') })
    const step = (stage, detail = '') => setStages((s) => [...(s ?? []).map((x) => ({ ...x, done: true })), { stage, detail, done: false }])
    try {
      let repo = null
      await streamPost('/api/code/repos', { url: target.trim() }, (ev) => {
        if (ev.event === 'stage') step(String(ev.stage), String(ev.detail ?? ''))
        else if (ev.event === 'preview' || ev.event === 'found') setFound((f) => ({ ...f, ...ev }))
        else if (ev.event === 'progress') setFound((f) => ({ ...f, embedded: ev.done, total: ev.total }))
        else if (ev.event === 'done') repo = ev.repo
        else if (ev.event === 'error') throw new Error(String(ev.message))
      })
      // The stream can end without a result when the server runs out of time or memory on a big repo.
      if (!repo) throw new Error('The server stopped before it finished reading this repository. It may be too big for the free server: try a smaller one, or one of the examples.')
      step('pack')
      await post(`/api/code/repos/${repo.id}/pack`).catch(() => null) // the pack page retries if this fails
      navigate(`${BASE}/${repo.id}`)
    } catch (e) {
      setStages(null)
      setError(errorText(e))
    }
  }

  if (stages) return <Building stages={stages} found={found} />
  return (
    <div className="mx-auto max-w-3xl space-y-8 py-4">
      <header className="text-center">
        <h1 className="text-[30px] leading-tight font-semibold text-white sm:text-[40px]">New to a codebase? Skip the KT sessions.</h1>
        <p className="mx-auto mt-3 max-w-xl text-[15px] text-ink-400">
          Paste a public GitHub repository. CodeLens reads the code and gives you an onboarding pack: what it does, how it fits together, what to read first, a plan for your first week, and answers to any question with the exact files and lines.
        </p>
      </header>
      <Card className="!p-4 sm:!p-5">
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); if (url.trim()) void build(url) }}>
          <input className={`${inputClass} flex-1`} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" aria-label="GitHub repository URL" />
          <button type="submit" disabled={!url.trim()} className={`inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r ${ACCENT} px-5 py-2.5 text-[14px] font-semibold text-on-accent disabled:opacity-50`}>
            Build the onboarding pack <ArrowRight className="size-4" />
          </button>
        </form>
        <p className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-500">
          No repo handy? Try one:
          {EXAMPLES.map((x) => (
            <button key={x.url} type="button" className="chip" title={`${x.lang}: ${x.what}`} onClick={() => { setUrl(x.url); void build(x.url) }}>
              {x.url.replace('https://github.com/', '')} <span className="text-ink-500">· {x.lang}</span>
            </button>
          ))}
        </p>
        <ErrorNote message={error} />
      </Card>
      {repos?.length > 0 && (
        <section>
          <p className="mb-2 text-[13px] font-semibold text-ink-300">Onboarding packs already built</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {repos.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => navigate(`${BASE}/${r.id}`)} className="flex w-full items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3 text-left hover:border-white/20">
                  <FolderGit2 className="size-4 shrink-0 text-amber-300" />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-white">{r.owner}/{r.name}</span>
                  <span className="text-[12px] text-ink-500">{r.files.length} files</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <WhatYouGet />
      <p className="text-center text-[12px] text-ink-500">Public repositories only, up to 40 MB. Nothing is pushed to the repo; CodeLens only reads it.</p>
    </div>
  )
}

/** The selling point, before anyone pastes a URL: what a new joiner gets out of it. */
function WhatYouGet() {
  return (
    <section>
      <p className="mb-3 text-center text-[13px] font-semibold text-ink-300">What a new joiner gets, in about a minute</p>
      <ol className="grid gap-2 sm:grid-cols-5">
        {CHAPTERS.map((c, i) => {
          const Icon = c.icon
          return (
            <li key={c.id} className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
              <span className="flex items-center gap-2 text-[12px] text-ink-500"><span className={`grid size-6 place-items-center rounded-lg bg-gradient-to-br ${ACCENT} text-on-accent`}><Icon className="size-3.5" /></span> {i + 1}</span>
              <p className="mt-2 text-[13.5px] font-semibold text-white">{c.title}</p>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-400">{c.blurb}</p>
            </li>
          )
        })}
      </ol>
      <p className="mt-3 text-center text-[12.5px] text-ink-500">One link per repo: share it with every new joiner on the team.</p>
    </section>
  )
}

/** Count up to a number, so facts arrive with a bit of life. */
function CountUp({ to }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    let raf = 0
    const t0 = performance.now()
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / 900)
      setN(Math.round(to * (1 - (1 - k) ** 3)))
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [to])
  return <>{n.toLocaleString()}</>
}

/**
 * While the repo is read: a lens scanning the repo's real file names, facts appearing as they're found, the checklist
 * of what's happening, and a reminder of what the pack will contain. Every number shown is real.
 */
function Building({ stages, found }) {
  const [seconds, setSeconds] = useState(0)
  const [tip, setTip] = useState(0)
  const [file, setFile] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000)
    const u = setInterval(() => setTip((i) => (i + 1) % CHAPTERS.length), 4200)
    return () => { clearInterval(t); clearInterval(u) }
  }, [])
  const sample = found.sample ?? []
  useEffect(() => {
    if (!sample.length) return
    const t = setInterval(() => setFile((i) => (i + 1) % sample.length), 450)
    return () => clearInterval(t)
  }, [sample.length])
  const keys = Object.keys(STAGES)
  const doneCount = stages.filter((s) => s.done).length
  // Steps, with the long embedding step filled in as its pieces are done.
  const current = stages.at(-1)
  const within = current?.stage === 'embed' && found.total ? found.embedded / found.total : 0.5
  const pct = Math.min(99, Math.round(((doneCount + within) / keys.length) * 100))
  const nextUp = CHAPTERS[tip]

  return (
    <div className="mx-auto grid max-w-5xl gap-6 py-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className="flex flex-col items-center">
        {/* The lens */}
        <div className="relative grid size-64 place-items-center sm:size-72">
          <motion.div aria-hidden className="absolute inset-0 rounded-full" style={{ background: 'conic-gradient(from 0deg, transparent 0 70%, rgb(251 146 60 / 0.55) 85%, transparent 100%)' }} animate={{ rotate: 360 }} transition={{ duration: 2.6, repeat: Infinity, ease: 'linear' }} />
          <div aria-hidden className="absolute inset-3 rounded-full border border-white/10 bg-ink-950" />
          <div aria-hidden className="absolute inset-10 rounded-full border border-dashed border-white/10" />
          <div className="relative w-[78%] text-center">
            <Code2 className="mx-auto size-7 text-amber-300" />
            <AnimatePresence mode="popLayout">
              <motion.p key={sample[file] ?? current?.stage ?? 'start'} initial={{ opacity: 0, y: 14, filter: 'blur(4px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -14, filter: 'blur(4px)' }} transition={{ duration: 0.3 }}
                className="mt-3 truncate font-mono text-[12.5px] text-amber-100">
                {sample[file] ?? found.repo ?? '…'}
              </motion.p>
            </AnimatePresence>
            <p className="mt-2 text-[12px] text-ink-500">
              {current?.stage === 'embed' && found.total ? `Indexed ${found.embedded} of ${found.total} pieces of code` : STAGES[current?.stage] ?? 'Starting…'}
            </p>
          </div>
        </div>
        <div className="mt-6 w-full max-w-sm">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]"><motion.div className={`h-full bg-gradient-to-r ${ACCENT}`} animate={{ width: `${pct}%` }} transition={{ duration: 0.6 }} /></div>
          <p className="mt-2 flex justify-between text-[12px] text-ink-500"><span>{doneCount} of {keys.length} steps</span><span>{seconds}s</span></p>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <p className="text-[12px] font-semibold tracking-[0.14em] text-ink-500 uppercase">Reading</p>
          <p className="truncate text-[22px] font-semibold text-white">{found.title || found.repo}</p>
        </div>
        <AnimatePresence>
          {found.files && (
            <motion.div key="facts" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-2 gap-2">
              <Fact label="files to learn"><CountUp to={found.files} /></Fact>
              <Fact label="lines of code"><CountUp to={found.lines} /></Fact>
              {found.symbols != null && <Fact label="functions & classes"><CountUp to={found.symbols} /></Fact>}
              {found.edges != null && <Fact label="links between files"><CountUp to={found.edges} /></Fact>}
            </motion.div>
          )}
          {found.languages?.length > 0 && (
            <motion.div key="langs" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="space-y-1.5">
              {found.languages.map((l) => (
                <div key={l.name} className="flex items-center gap-2 text-[12.5px]">
                  <span className="w-20 shrink-0 text-ink-300">{l.name}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.05]"><motion.div className={`h-full bg-gradient-to-r ${ACCENT}`} initial={{ width: 0 }} animate={{ width: `${Math.max(2, l.share)}%` }} transition={{ duration: 0.8 }} /></div>
                  <span className="w-9 text-right text-ink-500">{l.share}%</span>
                </div>
              ))}
            </motion.div>
          )}
          {found.folders?.length > 0 && (
            <motion.p key="folders" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }} className="flex flex-wrap gap-1.5">
              {found.folders.map((f) => <span key={f} className="rounded-lg bg-white/[0.05] px-2 py-0.5 font-mono text-[11.5px] text-ink-300">{f}/</span>)}
            </motion.p>
          )}
        </AnimatePresence>
        <ol className="space-y-1 border-t border-white/[0.06] pt-3">
          {keys.map((key) => {
            const s = stages.find((x) => x.stage === key)
            return (
              <li key={key} className={`flex items-center gap-2.5 text-[13px] ${s ? 'text-ink-100' : 'text-ink-600'}`}>
                <span className="grid size-5 place-items-center">{s?.done ? <Check className="size-3.5 text-emerald-300" /> : s ? <motion.span className="size-2 rounded-full bg-amber-300" animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1, repeat: Infinity }} /> : <span className="size-1.5 rounded-full bg-ink-600" />}</span>
                {STAGES[key]}
              </li>
            )
          })}
        </ol>
        <AnimatePresence mode="wait">
          <motion.div key={nextUp.id} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
            <p className="text-[11.5px] text-ink-500">Coming up in your pack</p>
            <p className="mt-0.5 text-[14px] font-semibold text-white">{nextUp.title}</p>
            <p className="text-[12.5px] text-ink-400">{nextUp.blurb}</p>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

function CopyButton({ text }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" onClick={() => void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) })}
      className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-lg bg-white/[0.08] px-2 py-1 text-[11.5px] text-ink-200 hover:bg-white/[0.14]">
      {done ? <Check className="size-3" /> : <Copy className="size-3" />} {done ? 'Copied' : 'Copy'}
    </button>
  )
}

function Fact({ label, children }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
      <p className="text-[20px] font-semibold text-white tabular-nums">{children}</p>
      <p className="text-[11.5px] text-ink-500">{label}</p>
    </div>
  )
}

// ── 2. The pack, as a story in chapters ─────────────────────────────────────────
function PackView({ id }) {
  const [repo, setRepo] = useState(null)
  const [pack, setPack] = useState(null)
  const [error, setError] = useState(null)
  const [chapter, setChapter] = useState('overview')
  const [file, setFile] = useState(null) // { path, start, end } open in the code viewer
  const [copied, setCopied] = useState(false)

  const loadPack = useCallback(() => {
    setError(null)
    post(`/api/code/repos/${id}/pack`).then(setPack).catch((e) => setError(errorText(e)))
  }, [id])
  useEffect(() => {
    get(`/api/code/repos/${id}`).then((r) => { setRepo(r); loadPack() }).catch((e) => setError(errorText(e)))
  }, [id, loadPack])

  const go = (c) => {
    setChapter(c)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const share = () => void navigator.clipboard.writeText(location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800) })

  if (error && !repo) return <div className="mx-auto max-w-md py-10"><ErrorNote message={error} /><BackLink /></div>
  if (!repo) return <Spinner label="Opening the onboarding pack…" />
  const index = CHAPTERS.findIndex((c) => c.id === chapter)
  const next = CHAPTERS[index + 1]
  const open = (path, start, end) => setFile({ path, start, end })

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <BackLink />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[22px] font-semibold text-white">{repo.owner}/{repo.name}</h1>
          <p className="text-[12.5px] text-ink-400">Onboarding pack · {repo.files.length} files · {Object.keys(repo.languages).slice(0, 3).join(', ')}</p>
        </div>
        <button type="button" onClick={share} className="chip">{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Link copied' : 'Share with a new joiner'}</button>
        <a href={repo.url} target="_blank" rel="noopener noreferrer" className="chip"><ExternalLink className="size-3.5" /> GitHub</a>
      </div>

      <nav aria-label="Chapters" className="flex gap-1 overflow-x-auto rounded-2xl border border-white/[0.07] bg-ink-900/60 p-1">
        {CHAPTERS.map((c, i) => (
          <button key={c.id} type="button" onClick={() => go(c.id)} aria-current={chapter === c.id ? 'step' : undefined}
            className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-[13px] font-medium transition ${chapter === c.id ? 'bg-white/[0.08] text-white' : 'text-ink-400 hover:text-white'}`}>
            <span className={`grid size-5 place-items-center rounded-full text-[11px] ${i < index ? 'bg-emerald-400/20 text-emerald-300' : chapter === c.id ? `bg-gradient-to-br ${ACCENT} text-on-accent` : 'bg-white/[0.06]'}`}>{i < index ? <Check className="size-3" /> : i + 1}</span>
            {c.title}
          </button>
        ))}
      </nav>

      {!pack && chapter !== 'ask' ? (
        error ? (
          <Card><ErrorNote message={error} /><button type="button" className="chip mt-3" onClick={loadPack}>Try again</button></Card>
        ) : (
          <Card className="py-10 text-center"><Spinner label="Writing the onboarding pack from the code…" /></Card>
        )
      ) : (
        <AnimatePresence mode="wait">
          <motion.div key={chapter} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
            {chapter === 'overview' && <Overview repo={repo} pack={pack} />}
            {chapter === 'areas' && <Areas pack={pack} open={open} />}
            {chapter === 'path' && <ReadingPath pack={pack} open={open} />}
            {chapter === 'week' && <Week repo={repo} pack={pack} open={open} />}
            {chapter === 'ask' && <Ask repo={repo} pack={pack} open={open} />}
          </motion.div>
        </AnimatePresence>
      )}

      {next && (pack || chapter === 'ask') && (
        <div className="flex justify-end">
          <button type="button" onClick={() => go(next.id)} className={`inline-flex items-center gap-2 rounded-full bg-gradient-to-r ${ACCENT} px-5 py-2.5 text-[14px] font-semibold text-on-accent shadow-lg`}>
            Next: {next.title} <ArrowRight className="size-4" />
          </button>
        </div>
      )}
      {file && <CodeViewer repo={repo} file={file} onClose={() => setFile(null)} />}
    </div>
  )
}

function BackLink() {
  return <button type="button" onClick={() => navigate(BASE)} className="inline-flex items-center gap-1 text-[12.5px] text-ink-400 hover:text-white"><ArrowLeft className="size-3.5" /> All repos</button>
}

function Section({ title, lead, children }) {
  return (
    <Card className="space-y-4 !p-5 sm:!p-6">
      <div>
        <h2 className="text-[20px] font-semibold text-white">{title}</h2>
        {lead && <p className="mt-1 text-[14px] text-ink-400">{lead}</p>}
      </div>
      {children}
    </Card>
  )
}

function PathChip({ path, open }) {
  return (
    <button type="button" onClick={() => open(path)} className="inline-flex max-w-full items-center gap-1 rounded-lg bg-white/[0.05] px-2 py-1 font-mono text-[11.5px] text-amber-200 hover:bg-white/[0.1]">
      <Code2 className="size-3 shrink-0" /> <span className="truncate">{path}</span>
    </button>
  )
}

function Overview({ repo, pack }) {
  const total = Object.values(repo.languages).reduce((a, b) => a + b, 0) || 1
  return (
    <Section title="What this project is" lead="The short version, before you open a single file.">
      <p className="text-[15.5px] leading-relaxed text-ink-100">{pack.purpose}</p>
      <div>
        <p className="text-[13px] font-semibold text-ink-300">How it fits together</p>
        <p className="mt-1 text-[14px] leading-relaxed text-ink-300">{pack.architecture}</p>
      </div>
      <div>
        <p className="text-[13px] font-semibold text-ink-300">Languages</p>
        <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-white/[0.05]">
          {Object.entries(repo.languages).slice(0, 6).map(([lang, n], i) => (
            <span key={lang} title={lang} style={{ width: `${(n / total) * 100}%`, opacity: 1 - i * 0.13 }} className={`bg-gradient-to-r ${ACCENT}`} />
          ))}
        </div>
        <p className="mt-1.5 text-[12px] text-ink-500">{Object.entries(repo.languages).slice(0, 4).map(([l, n]) => `${l} ${Math.round((n / total) * 100)}%`).join(' · ')}</p>
      </div>
      <div>
        <p className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-300"><Terminal className="size-3.5" /> Get it running</p>
        {pack.run.length ? (
          <div className="relative mt-2">
            <pre className="overflow-x-auto rounded-xl bg-black/30 p-3 pr-20 font-mono text-[12.5px] text-emerald-200">{pack.run.join('\n')}</pre>
            <CopyButton text={pack.run.join('\n')} />
          </div>
        ) : (
          <p className="mt-1 text-[13px] text-ink-400">The README doesn't list setup commands. Ask “How do I run this locally?” in the last chapter.</p>
        )}
        <p className="mt-1 text-[11.5px] text-ink-500">Copied from the README, never made up.</p>
      </div>
    </Section>
  )
}

function Areas({ pack, open }) {
  return (
    <Section title="How it's organised" lead="The main parts of the code, and where each one lives.">
      <ul className="grid gap-3 sm:grid-cols-2">
        {pack.areas.map((a) => (
          <li key={a.name} className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
            <p className="text-[15px] font-semibold text-white">{a.name}</p>
            <p className="mt-1 text-[13px] text-ink-300">{a.what}</p>
            {a.paths.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{a.paths.map((p) => <PathChip key={p} path={p} open={open} />)}</div>}
          </li>
        ))}
      </ul>
    </Section>
  )
}

function ReadingPath({ pack, open }) {
  return (
    <Section title="What to read first" lead="Read these in order: entry points first, then the core, then the supporting code.">
      <ol className="space-y-3">
        {pack.reading_path.map((s, i) => (
          <li key={s.path + i} className="flex gap-3">
            <span className={`grid size-7 shrink-0 place-items-center rounded-full bg-gradient-to-br ${ACCENT} text-[12px] font-bold text-on-accent`}>{i + 1}</span>
            <div className="min-w-0">
              <p className="text-[14.5px] font-semibold text-white">{s.title}</p>
              <p className="mt-0.5 text-[13px] text-ink-300">{s.explanation}</p>
              <div className="mt-1.5"><PathChip path={s.path} open={open} /></div>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  )
}

/** The week-one plan, one day open at a time, with ticks saved on this device so a new joiner can track progress. */
function Week({ repo, pack, open }) {
  const key = `codelens-week-${repo.id}`
  const [done, setDone] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}')
    } catch {
      return {}
    }
  })
  const [day, setDay] = useState(() => pack.week_plan.find((d) => d.tasks.some((_, i) => !done[`${d.day}-${i}`]))?.day ?? 1)
  const toggle = (k) =>
    setDone((cur) => {
      const nxt = { ...cur, [k]: !cur[k] }
      try {
        localStorage.setItem(key, JSON.stringify(nxt))
      } catch {
        /* private mode */
      }
      return nxt
    })
  const total = pack.week_plan.reduce((n, d) => n + d.tasks.length, 0)
  const ticked = Object.values(done).filter(Boolean).length
  return (
    <Section title="Your first week" lead={`A day-by-day plan to go from zero to your first change. ${ticked} of ${total} done.`}>
      <ul className="space-y-2">
        {pack.week_plan.map((d) => {
          const isOpen = day === d.day
          const left = d.tasks.filter((_, i) => !done[`${d.day}-${i}`]).length
          return (
            <li key={d.day} className="overflow-hidden rounded-2xl border border-white/[0.07]">
              <button type="button" onClick={() => setDay(isOpen ? 0 : d.day)} aria-expanded={isOpen} className="flex w-full items-center gap-3 bg-white/[0.02] px-4 py-3 text-left">
                <span className={`grid size-8 shrink-0 place-items-center rounded-full text-[12px] font-bold ${left === 0 ? 'bg-emerald-400/20 text-emerald-300' : 'bg-white/[0.06] text-white'}`}>{left === 0 ? <Check className="size-4" /> : `D${d.day}`}</span>
                <span className="min-w-0 flex-1"><span className="block text-[14.5px] font-semibold text-white">Day {d.day}: {d.goal}</span></span>
                <ChevronDown className={`size-4 text-ink-400 transition ${isOpen ? 'rotate-180' : ''}`} />
              </button>
              {isOpen && (
                <div className="space-y-2 px-4 pt-1 pb-4">
                  {d.tasks.map((t, i) => {
                    const k = `${d.day}-${i}`
                    return (
                      <label key={k} className="flex gap-3 rounded-xl p-2 hover:bg-white/[0.02]">
                        <input type="checkbox" className="mt-1" checked={!!done[k]} onChange={() => toggle(k)} />
                        <span className="min-w-0">
                          <span className={`block text-[13.5px] ${done[k] ? 'text-ink-500 line-through' : 'text-ink-100'}`}>{t.text}</span>
                          {t.paths.length > 0 && <span className="mt-1 flex flex-wrap gap-1.5">{t.paths.map((p) => <PathChip key={p} path={p} open={open} />)}</span>}
                        </span>
                      </label>
                    )
                  })}
                  {d.checkpoint && <p className="rounded-xl bg-emerald-400/[0.06] px-3 py-2 text-[12.5px] text-emerald-200">You're on track if: {d.checkpoint}</p>}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <p className="text-[11.5px] text-ink-500">Ticks are kept on this device only.</p>
    </Section>
  )
}

function Ask({ repo, pack, open }) {
  const [q, setQ] = useState('')
  const [thread, setThread] = useState([]) // [{ q, answer, sources, error }]
  const [busy, setBusy] = useState(false)
  const ask = async (question) => {
    const text = question.trim()
    if (text.length < 3 || busy) return
    setBusy(true)
    setQ('')
    setThread((t) => [...t, { q: text }])
    try {
      const res = await post(`/api/code/repos/${repo.id}/ask`, { question: text })
      setThread((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, ...res } : x)))
    } catch (e) {
      setThread((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, error: errorText(e) } : x)))
    } finally {
      setBusy(false)
    }
  }
  const starters = useMemo(() => (pack?.questions?.length ? pack.questions : ['How do I run this locally?', 'Where is the main entry point?', 'How are errors handled?']), [pack])
  return (
    <Section title="Ask anything" lead="Like asking a senior teammate, except every answer points at the exact files and lines.">
      {thread.length === 0 && (
        <div className="flex flex-wrap gap-2">{starters.map((s) => <button key={s} type="button" className="chip" onClick={() => void ask(s)}>{s}</button>)}</div>
      )}
      <div className="space-y-5">
        {thread.map((t, i) => (
          <div key={i} className="space-y-2">
            <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-white/[0.08] px-3 py-2 text-[14px] text-white">{t.q}</p>
            {t.error ? <ErrorNote message={t.error} /> : !t.answer ? <Spinner label="Reading the relevant code…" /> : <AnswerBlock repo={repo} t={t} open={open} />}
          </div>
        ))}
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void ask(q) }}>
        <input className={`${inputClass} flex-1`} value={q} onChange={(e) => setQ(e.target.value.slice(0, 600))} placeholder="e.g. Where is authentication handled?" aria-label="Your question" />
        <button type="submit" disabled={busy || q.trim().length < 3} aria-label="Ask" className={`grid size-10 place-items-center rounded-xl bg-gradient-to-r ${ACCENT} text-on-accent disabled:opacity-50`}><Send className="size-4" /></button>
      </form>
    </Section>
  )
}

function AnswerBlock({ repo, t, open }) {
  const [showSources, setShowSources] = useState(false)
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="space-y-2 text-[14px] leading-relaxed text-ink-100 [&_code]:rounded [&_code]:bg-black/30 [&_code]:px-1 [&_li]:ml-4 [&_li]:list-disc [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/30 [&_pre]:p-3 [&_strong]:text-white">
        <Markdown>{t.answer}</Markdown>
      </div>
      {t.sources?.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setShowSources((s) => !s)} aria-expanded={showSources} className="text-[12.5px] text-ink-400 hover:text-white">
            {showSources ? 'Hide' : 'Show'} the {t.sources.length} code excerpts this is based on
          </button>
          {showSources && (
            <ul className="mt-2 space-y-1">
              {t.sources.map((s) => (
                <li key={s.n} className="flex items-center gap-2 text-[12.5px]">
                  <span className="w-6 text-ink-500">[{s.n}]</span>
                  <button type="button" onClick={() => open(s.path, s.start, s.end)} className="truncate font-mono text-amber-200 hover:underline">{s.path}:{s.start}-{s.end}</button>
                  <a href={blobUrl(repo, s.path, s.start, s.end)} target="_blank" rel="noopener noreferrer" aria-label="Open on GitHub" className="text-ink-500 hover:text-white"><ExternalLink className="size-3" /></a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function CodeViewer({ repo, file, onClose }) {
  const [snip, setSnip] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    const start = file.start ?? 1
    const end = file.end ?? start + 120
    get(`/api/code/repos/${repo.id}/file?${new URLSearchParams({ path: file.path, start: String(start), end: String(end) })}`).then(setSnip).catch((e) => setError(errorText(e)))
    const close = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [repo.id, file, onClose])
  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-black/50 backdrop-blur-sm sm:place-items-center sm:p-6" role="dialog" aria-modal="true" aria-label={file.path} onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-3xl border border-white/10 bg-ink-900 shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-3">
          <Code2 className="size-4 text-amber-300" />
          <p className="min-w-0 flex-1 truncate font-mono text-[13px] text-white">{file.path}</p>
          <a href={blobUrl(repo, file.path, file.start, file.end)} target="_blank" rel="noopener noreferrer" className="chip"><ExternalLink className="size-3" /> GitHub</a>
          <button type="button" aria-label="Close" onClick={onClose} className="grid size-7 place-items-center rounded-full text-ink-400 hover:text-white"><X className="size-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? <div className="p-4"><ErrorNote message={error} /></div> : !snip ? <div className="p-6"><Spinner label="Loading the code…" /></div> : (
            <pre className="p-4 font-mono text-[12px] leading-relaxed text-ink-100">{snip.text || 'This part of the file is empty.'}</pre>
          )}
        </div>
      </div>
    </div>
  )
}

export const __test__ = { Building, Start, Overview, Areas, ReadingPath, Week, Ask }
