import {
  Bug,
  CheckCircle2,
  Clock,
  Download,
  FileText,
  GitCompare,
  History,
  ListChecks,
  Play,
  Plus,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { download, errorText } from '../shared/http'
import { Button, Card, Empty, ErrorNote, Field, inputClass, Pill, ProductShell, Spinner, Tabs } from '../shared/ui'
import { efi } from './api'
import {
  buildArtifacts,
  checkFile,
  checkSubmission,
  CONFIDENCE_TONE,
  evidenceIndex,
  FAILURE_KINDS,
  filterEvidence,
  formatBytes,
  KIND_LABELS,
  looksBinary,
  redactionText,
  reportMarkdown,
  STATUS,
  where,
} from './logic'

const ACCENT = 'from-rose-500 via-red-500 to-orange-400'
const mono = 'font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words'

export default function EFIApp() {
  const [limits, setLimits] = useState(null)
  const [history, setHistory] = useState(null)
  const [historyError, setHistoryError] = useState(null)
  const [tab, setTab] = useState('new')
  const [current, setCurrent] = useState(null)

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await efi.list())
      setHistoryError(null)
    } catch (e) {
      setHistoryError(errorText(e))
      setHistory((h) => h ?? [])
    }
  }, [])

  useEffect(() => {
    let alive = true
    efi.limits().then((l) => alive && setLimits(l))
    efi
      .list()
      .then((l) => alive && setHistory(l))
      .catch((e) => {
        if (!alive) return
        setHistory([])
        setHistoryError(errorText(e))
      })
    return () => {
      alive = false
    }
  }, [])

  const open = async (id) => {
    setTab('investigation')
    setCurrent({ id, loading: true })
    try {
      setCurrent(await efi.get(id))
    } catch (e) {
      setCurrent({ id, error: errorText(e) })
    }
  }

  return (
    <ProductShell name="EFI" tagline="Engineering Failure Investigator: evidence-backed answers to why a build, test or deploy failed" icon={Bug} accent={ACCENT}>
      <Tabs
        value={tab === 'investigation' ? 'investigation' : tab}
        onChange={(t) => {
          setTab(t)
          if (t === 'history') void loadHistory()
        }}
        tabs={[
          { id: 'new', label: 'New investigation', icon: Plus },
          { id: 'history', label: 'History', icon: History, badge: history?.length || 0 },
          ...(current ? [{ id: 'investigation', label: current.title ? truncate(current.title, 28) : 'Investigation', icon: ScanSearch }] : []),
        ]}
      />
      {tab === 'new' && (
        <Intake
          limits={limits}
          onCreated={(inv) => {
            setCurrent(inv)
            setTab('investigation')
            void loadHistory()
          }}
        />
      )}
      {tab === 'history' && (
        <HistoryList
          items={history}
          error={historyError}
          onOpen={open}
          onDeleted={(id) => {
            setHistory((h) => h?.filter((x) => x.id !== id) ?? h)
            if (current?.id === id) setCurrent(null)
          }}
        />
      )}
      {tab === 'investigation' && current && (
        <Investigation
          key={current.id}
          inv={current}
          limits={limits}
          onChange={(inv) => {
            setCurrent(inv)
            void loadHistory()
          }}
          onDeleted={() => {
            setHistory((h) => h?.filter((x) => x.id !== current.id) ?? h)
            setCurrent(null)
            setTab('history')
          }}
        />
      )}
    </ProductShell>
  )
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '')

// ── intake ──────────────────────────────────────────────────────────────────
function Intake({ limits, onCreated }) {
  const [title, setTitle] = useState('')
  const [files, setFiles] = useState([])
  const [fileErrors, setFileErrors] = useState([])
  const [log, setLog] = useState('')
  const [diff, setDiff] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const input = useRef(null)

  const addFiles = async (list) => {
    const problems = []
    const added = []
    for (const f of list) {
      const reason = checkFile(f, limits)
      if (reason) {
        problems.push(reason)
        continue
      }
      const head = new Uint8Array(await f.slice(0, 8000).arrayBuffer())
      if (looksBinary(head)) {
        problems.push(`${f.name} looks like a binary file. Only text artifacts are supported.`)
        continue
      }
      added.push({ name: f.name, size: f.size, content: await f.text() })
    }
    setFiles((cur) => [...cur.filter((c) => !added.some((a) => a.name === c.name)), ...added])
    setFileErrors(problems)
  }

  const artifacts = buildArtifacts(files, { log, diff })
  const problem = checkSubmission(artifacts, notes, limits)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      onCreated(await efi.create({ title: title.trim() || null, notes: notes.trim() || null, artifacts }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="space-y-4">
        <Field label="Title" hint="optional: defaults to the first error">
          <input className={inputClass} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. main branch CI red after dependency bump" />
        </Field>
        <div>
          <p className="text-[12px] font-medium text-ink-300">Artifacts</p>
          <div
            className="mt-1.5 grid place-items-center rounded-xl border border-dashed border-white/15 px-4 py-6 text-center"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              void addFiles([...e.dataTransfer.files])
            }}
          >
            <Upload className="size-5 text-ink-400" />
            <p className="mt-2 text-[13px] text-ink-300">Drop CI / build logs, stack traces, .diff / .patch, JUnit .xml, manifests or config files</p>
            <Button variant="ghost" className="mt-3" onClick={() => input.current?.click()}>
              Choose files
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              className="hidden"
              accept={limits?.extensions?.join(',')}
              onChange={(e) => {
                void addFiles([...(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
          </div>
          {files.length > 0 && (
            <ul className="mt-2 space-y-1">
              {files.map((f) => (
                <li key={f.name} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-1.5 text-[12.5px]">
                  <FileText className="size-3.5 shrink-0 text-ink-400" />
                  <span className="min-w-0 flex-1 truncate text-ink-100">{f.name}</span>
                  <span className="text-ink-500">{formatBytes(f.size)}</span>
                  <button type="button" aria-label={`Remove ${f.name}`} className="text-ink-500 hover:text-rose-300" onClick={() => setFiles((c) => c.filter((x) => x.name !== f.name))}>
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {fileErrors.length > 0 && <div className="mt-2"><ErrorNote message="Some files were not added:" items={fileErrors} /></div>}
        </div>
        <Field label="Paste a log or stack trace" hint="optional">
          <textarea className={`${inputClass} h-36 font-mono text-[12px]`} value={log} onChange={(e) => setLog(e.target.value)} placeholder="##[error]Process completed with exit code 1." />
        </Field>
        <Field label="Paste a git diff" hint="optional: git diff / git show output">
          <textarea className={`${inputClass} h-28 font-mono text-[12px]`} value={diff} onChange={(e) => setDiff(e.target.value)} placeholder="diff --git a/src/app.py b/src/app.py" />
        </Field>
        <Field label="Investigation notes" hint="optional: what changed, when it started">
          <textarea className={`${inputClass} h-20`} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Started failing after merging the tax refactor; passes locally." />
        </Field>
        <ErrorNote message={error} />
        <div className="flex flex-wrap items-center gap-3">
          <Button accent={ACCENT} busy={busy} disabled={!!problem} onClick={() => void submit()}>
            <ScanSearch className="size-4" /> Extract evidence
          </Button>
          {problem && artifacts.length > 0 && <span className="text-[12px] text-amber-300">{problem}</span>}
        </div>
      </Card>
      <aside className="space-y-4">
        <Card>
          <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><ShieldCheck className="size-4 text-emerald-300" /> How it works</p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-[12.5px] text-ink-300">
            <li>Secrets (API keys, tokens, passwords, private keys, connection strings) are redacted on the server before anything is stored.</li>
            <li>Errors, stack frames, failed tests, changed lines and dependency changes are extracted with plain parsing and given IDs (EV-001…).</li>
            <li>You review the evidence, then choose to analyse it. Only then is a bounded selection sent to {limits?.model ?? 'the model'} on Groq.</li>
            <li>Every hypothesis must cite evidence IDs. References that don't exist are removed, and unsupported claims are rejected or downgraded.</li>
          </ol>
        </Card>
        <Card>
          <p className="text-[13px] font-semibold text-white">Limits</p>
          {limits ? (
            <ul className="mt-2 space-y-1 text-[12.5px] text-ink-300">
              <li>Text files only, up to {formatBytes(limits.max_artifact_bytes)} each</li>
              <li>Up to {limits.max_artifacts} artifacts, {formatBytes(limits.max_request_bytes)} in total</li>
              <li>No archives (.zip, .tar…): upload the files themselves</li>
              <li>Raw artifacts are deleted after {limits.retention_days} days; reports stay until you delete them</li>
              <li>Up to {limits.daily_analyses_per_owner} analyses per day</li>
            </ul>
          ) : (
            <Spinner label="Loading limits…" />
          )}
          <p className="mt-3 text-[11.5px] text-ink-500">Your history is tied to this browser (no account). Clearing site data removes access to it.</p>
        </Card>
      </aside>
    </div>
  )
}

// ── history ─────────────────────────────────────────────────────────────────
function HistoryList({ items, error, onOpen, onDeleted }) {
  if (items === null) return <Spinner label="Loading your investigations…" />
  return (
    <div className="space-y-3">
      <ErrorNote message={error} />
      {items.length === 0 ? (
        <Empty icon={History} title="No investigations yet" text="Start one from the New investigation tab. Investigations are listed here for this browser only." />
      ) : (
        <ul className="space-y-2">
          {items.map((i) => (
            <HistoryRow key={i.id} item={i} onOpen={onOpen} onDeleted={onDeleted} />
          ))}
        </ul>
      )}
    </div>
  )
}

function HistoryRow({ item, onOpen, onDeleted }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const status = STATUS[item.status] ?? { label: item.status, tone: 'neutral' }
  const remove = async () => {
    setBusy(true)
    try {
      await efi.remove(item.id)
      onDeleted(item.id)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }
  return (
    <li className="rounded-2xl border border-white/[0.07] bg-ink-900/60 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(item.id)}>
          <p className="truncate text-[14px] font-medium text-white hover:underline">{item.title}</p>
          <p className="mt-0.5 text-[11.5px] text-ink-400">
            {when(item.created_at)} · {item.artifacts} artifact{item.artifacts === 1 ? '' : 's'} · {item.evidence} evidence items
            {item.top_hypothesis ? ` · top: ${truncate(item.top_hypothesis, 60)}` : ''}
          </p>
        </button>
        <Pill tone={status.tone}>{status.label}</Pill>
        {item.confirmed && <Pill tone="good"><CheckCircle2 className="size-3" /> confirmed</Pill>}
        {confirm ? (
          <>
            <Button variant="ghost" busy={busy} onClick={() => void remove()} className="!px-3 !py-1.5 text-rose-300">Delete permanently</Button>
            <Button variant="ghost" onClick={() => setConfirm(false)} className="!px-3 !py-1.5">Cancel</Button>
          </>
        ) : (
          <button type="button" aria-label={`Delete ${item.title}`} className="grid size-8 place-items-center rounded-lg text-ink-500 hover:text-rose-300" onClick={() => setConfirm(true)}>
            <Trash2 className="size-4" />
          </button>
        )}
      </div>
      {error && <div className="mt-2"><ErrorNote message={error} /></div>}
    </li>
  )
}

// ── one investigation ───────────────────────────────────────────────────────
function Investigation({ inv, limits, onChange, onDeleted }) {
  const [view, setView] = useState(inv.data?.report ? 'report' : 'evidence')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [focus, setFocus] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (inv.loading) return <Spinner label="Loading investigation…" />
  if (inv.error) return <ErrorNote message={inv.error} />

  const { data } = inv
  const status = STATUS[inv.status] ?? { label: inv.status, tone: 'neutral' }
  const canAnalyse = inv.status !== 'analyzing'

  const analyse = async () => {
    setBusy(true)
    setError(null)
    try {
      const out = await efi.analyze(inv.id)
      onChange(out)
      setView('report')
    } catch (e) {
      setError(errorText(e))
      efi.get(inv.id).then(onChange).catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    try {
      await efi.remove(inv.id)
      onDeleted()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const showEvidence = (id) => {
    setFocus(id)
    setView('evidence')
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold break-words text-white">{inv.title}</h1>
            <p className="mt-1 text-[12px] text-ink-400">
              Created {when(inv.created_at)} · {data.artifacts.length} artifact{data.artifacts.length === 1 ? '' : 's'} · {data.evidence.length} evidence items ·{' '}
              {data.correlations.length} correlation{data.correlations.length === 1 ? '' : 's'}
            </p>
          </div>
          <Pill tone={status.tone}>{status.label}</Pill>
        </div>
        <p className="mt-3 flex items-start gap-2 text-[12.5px] text-ink-300">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-300" /> {redactionText(data.redaction)}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button accent={ACCENT} busy={busy} disabled={!canAnalyse} onClick={() => void analyse()}>
            {data.report ? <RotateCcw className="size-4" /> : <Play className="size-4" />}
            {busy ? `Analysing with ${limits?.model ?? 'Groq'}…` : data.report ? 'Re-run analysis' : `Analyse with ${limits?.model ?? 'Groq'}`}
          </Button>
          {data.report && (
            <Button variant="ghost" onClick={() => download(`efi-${inv.id.slice(0, 8)}.md`, reportMarkdown(inv))}>
              <Download className="size-4" /> Export Markdown
            </Button>
          )}
          {confirmDelete ? (
            <>
              <Button variant="ghost" className="text-rose-300" onClick={() => void remove()}>Delete permanently</Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-4" /> Delete
            </Button>
          )}
        </div>
        {busy && <p className="mt-2 text-[12px] text-ink-400">One bounded request to Groq. This usually takes 10–40 seconds.</p>}
        <div className="mt-3 space-y-2">
          <ErrorNote message={error} />
          {!error && inv.status === 'failed' && data.error && <ErrorNote message={`Last analysis failed: ${data.error.message}`} />}
        </div>
      </Card>

      <Tabs
        value={view}
        onChange={setView}
        tabs={[
          { id: 'report', label: 'Report', icon: ListChecks },
          { id: 'evidence', label: 'Evidence', icon: ScanSearch, badge: data.evidence.length },
          { id: 'timeline', label: 'Timeline', icon: Clock, badge: data.timeline.length },
        ]}
      />
      {view === 'report' && <Report inv={inv} onCite={showEvidence} onChange={onChange} onAnalyse={analyse} busy={busy} />}
      {view === 'evidence' && <EvidenceExplorer inv={inv} focus={focus} onCite={setFocus} />}
      {view === 'timeline' && <Timeline inv={inv} onCite={showEvidence} />}
    </div>
  )
}

function Cite({ id, onCite, idx }) {
  const e = idx?.get(id)
  return (
    <button
      type="button"
      title={e ? `${KIND_LABELS[e.kind] ?? e.kind} · ${where(e)}` : id}
      onClick={() => onCite(id)}
      className="mr-1 mb-1 inline-flex items-center rounded-md bg-rose-500/10 px-1.5 py-0.5 font-mono text-[11px] text-rose-200 ring-1 ring-rose-400/25 hover:bg-rose-500/20"
    >
      {id}
    </button>
  )
}

// ── report ──────────────────────────────────────────────────────────────────
function Report({ inv, onCite, onChange, onAnalyse, busy }) {
  const r = inv.data.report
  const idx = useMemo(() => evidenceIndex(inv.data.evidence), [inv.data.evidence])
  if (!r)
    return (
      <Empty icon={ListChecks} title="No report yet" text="Review the extracted evidence, then run the analysis. Nothing is sent to the model until you do.">
        <Button accent={ACCENT} busy={busy} onClick={() => void onAnalyse()}><Play className="size-4" /> Analyse</Button>
      </Empty>
    )
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        {r.insufficient_evidence && (
          <Card className="border-amber-400/25 bg-amber-500/[0.06]">
            <p className="flex items-center gap-2 text-[14px] font-semibold text-amber-200"><TriangleAlert className="size-4" /> The root cause can't be determined with confidence</p>
            <p className="mt-1 text-[13px] text-amber-100/90">{r.insufficient_reason || 'The evidence does not support a root cause.'}</p>
            {r.missing_artifacts?.length > 0 && (
              <>
                <p className="mt-2 text-[12px] font-medium text-amber-200">What would help:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12.5px] text-amber-100/90">
                  {r.missing_artifacts.map((m) => <li key={m}>{m}</li>)}
                </ul>
              </>
            )}
          </Card>
        )}
        {r.summary && (
          <Card>
            <p className="text-[11px] font-medium tracking-wide text-ink-500 uppercase">Summary · model-generated</p>
            <p className="mt-1.5 text-[14px] text-ink-100">{r.summary}</p>
          </Card>
        )}
        {r.symptoms.length > 0 && (
          <Card>
            <p className="text-[13px] font-semibold text-white">Observed symptoms</p>
            <ul className="mt-2 space-y-1.5">
              {r.symptoms.slice(0, 6).map((id) => {
                const e = idx.get(id)
                return e ? (
                  <li key={id} className="flex gap-2 text-[12.5px]">
                    <Cite id={id} onCite={onCite} idx={idx} />
                    <span className={`${mono} min-w-0 flex-1 text-ink-200`}>{e.content.split('\n')[0]}</span>
                    {id === r.first_failure && <Pill tone="bad">first failure</Pill>}
                  </li>
                ) : null
              })}
            </ul>
          </Card>
        )}
        {r.hypotheses.map((h) => <Hypothesis key={h.id} h={h} idx={idx} onCite={onCite} />)}
        {r.rejected_hypotheses?.length > 0 && (
          <details className="rounded-2xl border border-white/[0.07] bg-ink-900/40 p-4 text-[13px] text-ink-300">
            <summary className="cursor-pointer text-ink-200">{r.rejected_hypotheses.length} rejected hypothesis(es): no valid evidence</summary>
            <ul className="mt-2 space-y-2">
              {r.rejected_hypotheses.map((h) => (
                <li key={h.id}><b className="text-ink-100">{h.title}</b>: {h.description} <span className="text-rose-300">{h.verification_notes.join(' ')}</span></li>
              ))}
            </ul>
          </details>
        )}
        <Feedback inv={inv} onChange={onChange} />
      </div>
      <aside className="space-y-4">
        <Card>
          <p className="text-[13px] font-semibold text-white">Validation checklist</p>
          {r.validation_checklist.length === 0 ? (
            <p className="mt-1 text-[12.5px] text-ink-400">No checklist: there was no failure to validate against.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {r.validation_checklist.map((c) => (
                <li key={c.text} className="text-[12.5px] text-ink-200">
                  <p>{c.text}</p>
                  <p className="mt-0.5"><Pill tone={c.source === 'artifacts' ? 'info' : 'neutral'}>{c.source}</Pill> {c.evidence_ids.map((id) => <Cite key={id} id={id} onCite={onCite} idx={idx} />)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {(r.observed_commands.length > 0 || r.reproduction_steps.length > 0) && (
          <Card>
            <p className="text-[13px] font-semibold text-white">Reproduction</p>
            {r.observed_commands.length > 0 && (
              <>
                <p className="mt-2 text-[11.5px] text-ink-400">Commands run before the first failure (from the logs):</p>
                <ul className="mt-1 space-y-1">
                  {r.observed_commands.map((id) => idx.get(id) && (
                    <li key={id} className="flex items-start gap-1.5"><Cite id={id} onCite={onCite} idx={idx} /><code className={`${mono} text-ink-200`}>{idx.get(id).attrs.command}</code></li>
                  ))}
                </ul>
              </>
            )}
            {r.reproduction_steps.length > 0 && (
              <>
                <p className="mt-3 text-[11.5px] text-ink-400">Suggested steps (model):</p>
                <ol className="mt-1 list-decimal space-y-1 pl-4 text-[12.5px] text-ink-200">
                  {r.reproduction_steps.map((s) => (
                    <li key={s.step}>{s.step} <Pill tone={s.observed ? 'good' : 'warn'}>{s.observed ? 'seen in artifacts' : 'not seen in artifacts'}</Pill></li>
                  ))}
                </ol>
              </>
            )}
          </Card>
        )}
        {r.affected_files.length > 0 && (
          <Card>
            <p className="text-[13px] font-semibold text-white">Affected files</p>
            <ul className={`mt-2 space-y-0.5 ${mono} text-ink-200`}>{r.affected_files.map((f) => <li key={f}>{f}</li>)}</ul>
          </Card>
        )}
        <Card>
          <p className="text-[13px] font-semibold text-white">Confidence & limitations</p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[12px] text-ink-300">{r.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
          <p className="mt-2 text-[11.5px] text-ink-500">Model: {r.model ?? 'not used'} · {r.context.sent} evidence items analysed</p>
        </Card>
      </aside>
    </div>
  )
}

function Hypothesis({ h, idx, onCite }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid size-6 place-items-center rounded-lg bg-white/[0.06] text-[11px] font-bold text-ink-200">{h.rank}</span>
        <p className="min-w-0 flex-1 text-[15px] font-semibold text-white">{h.title}</p>
        <Pill tone={CONFIDENCE_TONE[h.confidence]}>{h.confidence} confidence</Pill>
        {h.model_confidence !== h.confidence && <span className="text-[11px] text-ink-500">model said {h.model_confidence}</span>}
      </div>
      {h.description && <p className="mt-2 text-[13.5px] text-ink-100">{h.description}</p>}
      <div className="mt-2 text-[12px]">
        <span className="mr-1 text-ink-400">Supporting:</span>
        {h.supporting_evidence.map((id) => <Cite key={id} id={id} onCite={onCite} idx={idx} />)}
      </div>
      {h.contradicting_evidence.length > 0 && (
        <div className="text-[12px]">
          <span className="mr-1 text-ink-400">Contradicting:</span>
          {h.contradicting_evidence.map((id) => <Cite key={id} id={id} onCite={onCite} idx={idx} />)}
        </div>
      )}
      {h.reasoning && (
        <details className="mt-2 text-[12.5px] text-ink-300">
          <summary className="cursor-pointer text-ink-200">Reasoning</summary>
          <p className="mt-1">{h.reasoning}</p>
        </details>
      )}
      {h.affected_files.length > 0 && <p className={`mt-2 ${mono} text-ink-300`}>{h.affected_files.join('  ·  ')}</p>}
      {h.remediation.length > 0 && (
        <>
          <p className="mt-3 text-[12px] font-medium text-ink-200">Suggested remediation (not applied or verified)</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12.5px] text-ink-300">{h.remediation.map((x) => <li key={x}>{x}</li>)}</ul>
        </>
      )}
      {h.verification_notes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11.5px] text-amber-300/90">{h.verification_notes.map((n) => <li key={n}>⚠ {n}</li>)}</ul>
      )}
    </Card>
  )
}

function Feedback({ inv, onChange }) {
  const r = inv.data.report
  const fb = inv.data.feedback
  const [choice, setChoice] = useState(r.hypotheses[0]?.id ?? 'none')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(!fb)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const body = choice === 'none' ? { outcome: 'none_correct', note: note || null } : { outcome: 'confirmed', hypothesis_id: choice, note: note || null }
      onChange(await efi.feedback(inv.id, body))
      setEditing(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  if (!editing && fb)
    return (
      <Card>
        <p className="flex items-center gap-2 text-[13px] text-ink-100">
          <CheckCircle2 className="size-4 text-emerald-300" />
          {fb.outcome === 'confirmed' ? `You confirmed ${fb.hypothesis_id} as the actual root cause.` : 'You marked none of the hypotheses as correct.'}
        </p>
        {fb.note && <p className="mt-1 text-[12.5px] text-ink-300">{fb.note}</p>}
        <button type="button" className="mt-2 text-[12px] text-ink-400 underline hover:text-white" onClick={() => setEditing(true)}>Change</button>
      </Card>
    )
  return (
    <Card>
      <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><GitCompare className="size-4" /> Mark the actual root cause</p>
      <p className="mt-1 text-[12px] text-ink-400">Once you've confirmed what really caused the failure, record it here.</p>
      <div className="mt-2 space-y-1.5">
        {[...r.hypotheses.map((h) => ({ id: h.id, label: `${h.id}. ${h.title}` })), { id: 'none', label: 'None of these' }].map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-[13px] text-ink-200">
            <input type="radio" name={`fb-${inv.id}`} checked={choice === o.id} onChange={() => setChoice(o.id)} /> {o.label}
          </label>
        ))}
      </div>
      <textarea className={`${inputClass} mt-2 h-16 text-[13px]`} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional: what the actual cause and fix were" />
      <div className="mt-2 flex items-center gap-2">
        <Button busy={busy} accent={ACCENT} onClick={() => void save()}>Save</Button>
        {fb && <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
      </div>
      <div className="mt-2"><ErrorNote message={error} /></div>
    </Card>
  )
}

// ── evidence explorer ───────────────────────────────────────────────────────
function EvidenceExplorer({ inv, focus, onCite }) {
  const [group, setGroup] = useState(focus ? 'all' : 'failures')
  const { data } = inv
  const list = filterEvidence(data.evidence, group)
  const idx = useMemo(() => evidenceIndex(data.evidence), [data.evidence])

  useEffect(() => {
    if (focus) document.getElementById(`ev-${focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [focus])

  return (
    <div className="space-y-4">
      {data.correlations.length > 0 && (
        <Card>
          <p className="text-[13px] font-semibold text-white">Correlations (deterministic)</p>
          <ul className="mt-2 space-y-1.5">
            {data.correlations.map((c) => (
              <li key={c.id} className="text-[12.5px] text-ink-200">
                <Pill tone={c.strength === 'strong' ? 'good' : 'info'}>{c.strength}</Pill> {c.description}{' '}
                {c.evidence_ids.map((id) => <Cite key={id} id={id} onCite={onCite} idx={idx} />)}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="flex flex-wrap gap-1.5">
        {[['failures', 'Failures'], ['changes', 'Changes'], ['context', 'Context'], ['all', 'All']].map(([id, label]) => (
          <button key={id} type="button" aria-pressed={group === id} className={`chip ${group === id ? 'ring-1 ring-white/30 text-white' : ''}`} onClick={() => setGroup(id)}>
            {label} ({filterEvidence(data.evidence, id).length})
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <Empty icon={ScanSearch} title="Nothing in this group" text={group === 'failures' ? 'No error lines, exceptions, stack frames or failed tests were found.' : 'No items of this kind were extracted.'} />
      ) : (
        <ul className="space-y-2">
          {list.map((e) => <EvidenceItem key={e.id} e={e} inv={inv} focused={focus === e.id} />)}
        </ul>
      )}
    </div>
  )
}

function EvidenceItem({ e, inv, focused }) {
  const [ctx, setCtx] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const artifact = inv.data.artifacts[e.artifact_index]
  const canShowContext = artifact && e.line && e.status !== 'user_provided' && inv.raw_artifacts_available?.includes(artifact.id)

  const load = async () => {
    setBusy(true)
    setError(null)
    try {
      setCtx(await efi.context(inv.id, artifact.id, e.line))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li id={`ev-${e.id}`} className={`rounded-xl border bg-ink-900/60 p-3 ${focused ? 'border-rose-400/50 ring-1 ring-rose-400/30' : 'border-white/[0.07]'}`}>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-mono font-semibold text-rose-200">{e.id}</span>
        <Pill tone={FAILURE_KINDS.has(e.kind) ? 'bad' : 'neutral'}>{KIND_LABELS[e.kind] ?? e.kind}</Pill>
        <span className="text-ink-400">{where(e)}</span>
        {e.status !== 'parsed' && <Pill tone="warn">{e.status === 'user_provided' ? 'user-provided' : 'partial'}</Pill>}
        {e.attrs.timestamp && <span className="text-ink-500">{e.attrs.timestamp}</span>}
        {canShowContext && !ctx && (
          <button type="button" className="ml-auto text-[11.5px] text-ink-400 underline hover:text-white" disabled={busy} onClick={() => void load()}>
            {busy ? 'Loading…' : 'Show surrounding lines'}
          </button>
        )}
      </div>
      <pre className={`mt-1.5 ${mono} text-ink-100`}>{e.content}</pre>
      {ctx && (
        <pre className={`mt-2 max-h-72 overflow-auto rounded-lg bg-ink-950/60 p-2 ${mono}`}>
          {ctx.lines.map((l) => (
            <div key={l.n} className={l.n === ctx.focus ? 'bg-rose-500/15 text-white' : 'text-ink-400'}>
              <span className="mr-3 inline-block w-10 text-right text-ink-600 select-none">{l.n}</span>
              {l.text}
            </div>
          ))}
        </pre>
      )}
      {error && <div className="mt-2"><ErrorNote message={error} /></div>}
    </li>
  )
}

// ── timeline ────────────────────────────────────────────────────────────────
function Timeline({ inv, onCite }) {
  const t = inv.data.timeline
  const idx = useMemo(() => evidenceIndex(inv.data.evidence), [inv.data.evidence])
  if (!t.length) return <Empty icon={Clock} title="No timeline" text="No stages, commands, errors or test results with an order were found in the artifacts." />
  return (
    <Card>
      <ol className="relative space-y-3 border-l border-white/10 pl-4">
        {t.map((ev) => (
          <li key={ev.evidence_id} className="relative">
            <span className={`absolute top-1.5 -left-[21px] size-2.5 rounded-full ${ev.first_failure ? 'bg-rose-400 ring-4 ring-rose-400/20' : FAILURE_KINDS.has(ev.kind) ? 'bg-rose-400/60' : 'bg-white/25'}`} />
            <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-400">
              <Cite id={ev.evidence_id} onCite={onCite} idx={idx} />
              <span>{KIND_LABELS[ev.kind] ?? ev.kind}</span>
              {ev.at && <span>{ev.at}</span>}
              {ev.stage && <span className="text-ink-500">in {ev.stage}</span>}
              <span className="text-ink-500">{ev.artifact}{ev.line ? `:${ev.line}` : ''}</span>
              {ev.first_failure && <Pill tone="bad">first failure</Pill>}
            </div>
            <p className={`mt-0.5 ${mono} text-ink-200`}>{ev.text}</p>
          </li>
        ))}
      </ol>
    </Card>
  )
}
