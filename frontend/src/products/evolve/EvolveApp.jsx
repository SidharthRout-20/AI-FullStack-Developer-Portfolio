import {
  ArrowLeft,
  BrainCog,
  CircleCheck,
  Dna,
  FlaskConical,
  GitCompareArrows,
  History,
  ListChecks,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  TrendingUp,
  XCircle,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { del, errorText, get, post, streamPost } from '../shared/http'
import { Button, Card, Empty, ErrorNote, Field, inputClass, Pill, ProductShell, Spinner, Steps, Tabs } from '@appcore/web/ui'
import { diffLines } from './diff'

const ACCENT = 'from-teal-500 via-emerald-500 to-lime-400'

const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`)

export default function EvolveApp() {
  const [tasks, setTasks] = useState(null)
  const [templates, setTemplates] = useState([])
  const [openId, setOpenId] = useState(null)
  const [creating, setCreating] = useState(null)

  const load = useCallback(() => get('/api/evolve/tasks').then(setTasks).catch(() => setTasks([])), [])
  useEffect(() => {
    void load()
    void get('/api/evolve/templates').then(setTemplates).catch(() => setTemplates([]))
  }, [load])

  return (
    <ProductShell name="Evolve" tagline="Prompts that learn from their mistakes" icon={Dna}>
      {openId ? (
        <TaskView id={openId} samples={templates.find((t) => tasks?.find((x) => x.id === openId)?.name === t.name)?.samples ?? []} onBack={() => { setOpenId(null); void load() }} />
      ) : creating ? (
        <NewTask template={creating} onCancel={() => setCreating(null)} onCreated={(t) => { setCreating(null); setOpenId(t.id); void load() }} />
      ) : (
        <Gallery tasks={tasks} templates={templates} onOpen={setOpenId} onNew={setCreating} onDelete={async (t) => { await del(`/api/evolve/tasks/${t.id}`); void load() }} />
      )}
    </ProductShell>
  )
}

// ── Gallery ────────────────────────────────────────────────────────────────
const BLANK = { name: '', goal: '', input_label: 'Input', prompt: '', validators: {}, auto_reflect_after: 3, samples: [] }

function Gallery({ tasks, templates, onOpen, onNew, onDelete }) {
  return (
    <div className="space-y-8">
      <Card className="bg-gradient-to-br from-teal-500/[0.08] via-emerald-500/[0.04] to-lime-400/[0.06]">
        <div className="flex flex-wrap items-start gap-4">
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-teal-500 to-lime-400 text-on-accent"><BrainCog className="size-6" /></span>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold text-white">How Evolve learns</h1>
            <ol className="mt-2 grid gap-2 text-[13.5px] text-ink-200 sm:grid-cols-4">
              {[['Run', 'Every output is validated: deterministic checks, then an LLM judge against your rubric.'], ['Lessons', 'Failures (and your thumbs-down) become lessons with the reason they failed.'], ['Reflect', 'The model rewrites the prompt from those lessons and explains what changed.'], ['Prove it', 'The candidate is re-tested on recent inputs and promoted only if it does at least as well.']].map(([t, d], i) => (
                <li key={t} className="rounded-xl border border-white/[0.06] bg-ink-950/30 p-3"><span className="font-mono text-[11px] text-emerald-300">0{i + 1}</span><p className="font-semibold text-white">{t}</p><p className="text-[12.5px] text-ink-300">{d}</p></li>
              ))}
            </ol>
          </div>
        </div>
      </Card>
      <section>
        <h2 className="text-[13px] font-semibold tracking-wide text-ink-300 uppercase">Start a task</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <button type="button" onClick={() => onNew(BLANK)} className="rounded-2xl border border-dashed border-white/15 p-5 text-left transition hover:border-emerald-400/50">
            <Plus className="size-5 text-emerald-300" />
            <p className="mt-2 text-[14.5px] font-semibold text-white">Blank task</p>
            <p className="text-[12.5px] text-ink-400">Your own goal, prompt and validators.</p>
          </button>
          {templates.map((t) => (
            <button key={t.name} type="button" onClick={() => onNew(t)} className="rounded-2xl border border-white/[0.07] bg-ink-900/60 p-5 text-left transition hover:border-emerald-400/40">
              <FlaskConical className="size-5 text-teal-300" />
              <p className="mt-2 text-[14.5px] font-semibold text-white">{t.name}</p>
              <p className="text-[12.5px] text-ink-400">{t.goal}</p>
            </button>
          ))}
        </div>
      </section>
      <section>
        <h2 className="text-[13px] font-semibold tracking-wide text-ink-300 uppercase">Your tasks</h2>
        {!tasks ? <Spinner label="Loading…" /> : tasks.length === 0 ? <p className="mt-2 text-[13px] text-ink-500">Nothing yet. Pick a template above and run a few inputs.</p> : (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tasks.map((t) => (
              <li key={t.id} className="group relative rounded-2xl border border-white/[0.07] bg-ink-900/60 p-4 transition hover:border-white/15">
                <button type="button" onClick={() => onOpen(t.id)} className="block w-full text-left">
                  <p className="text-[14.5px] font-semibold text-white">{t.name}</p>
                  <p className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-400">{t.goal}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <Pill tone="info">v{t.current_version}</Pill>
                    <Pill tone={t.summary.pass_rate == null ? 'neutral' : t.summary.pass_rate >= 0.8 ? 'good' : t.summary.pass_rate >= 0.5 ? 'warn' : 'bad'}>pass {pct(t.summary.pass_rate)}</Pill>
                    <Pill>{t.summary.runs} runs</Pill>
                    {t.summary.promotions > 0 && <Pill tone="good"><TrendingUp className="size-3" /> {t.summary.promotions} improvement{t.summary.promotions > 1 ? 's' : ''}</Pill>}
                    {t.reflecting && <Pill tone="warn">reflecting…</Pill>}
                  </div>
                </button>
                <button type="button" aria-label={`Delete ${t.name}`} onClick={() => onDelete(t)} className="absolute top-3 right-3 grid size-7 place-items-center rounded-lg text-ink-500 opacity-0 group-hover:opacity-100 hover:text-rose-300"><Trash2 className="size-3.5" /></button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

// ── New task ───────────────────────────────────────────────────────────────
function NewTask({ template, onCancel, onCreated }) {
  const [form, setForm] = useState({
    name: template.name,
    goal: template.goal,
    input_label: template.input_label,
    prompt: template.prompt,
    must_include: (template.validators.must_include ?? []).join(', '),
    must_avoid: (template.validators.must_avoid ?? []).join(', '),
    max_words: template.validators.max_words ?? '',
    json_keys: (template.validators.json_keys ?? []).join(', '),
    rubric: template.validators.rubric ?? '',
    auto_reflect_after: template.auto_reflect_after,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean)
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      onCreated(
        await post('/api/evolve/tasks', {
          name: form.name,
          goal: form.goal,
          input_label: form.input_label || 'Input',
          prompt: form.prompt,
          auto_reflect_after: Number(form.auto_reflect_after) || 3,
          validators: { must_include: list(form.must_include), must_avoid: list(form.must_avoid), max_words: form.max_words === '' ? null : Number(form.max_words), json_keys: list(form.json_keys), rubric: form.rubric },
        }),
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mx-auto max-w-3xl">
      <button type="button" onClick={onCancel} className="flex items-center gap-1 text-[12.5px] text-ink-400 hover:text-white"><ArrowLeft className="size-3.5" /> Tasks</button>
      <h1 className="mt-2 text-xl font-semibold text-white">New task</h1>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Name"><input className={inputClass} value={form.name} onChange={set('name')} /></Field>
        <Field label="Input label"><input className={inputClass} value={form.input_label} onChange={set('input_label')} /></Field>
      </div>
      <div className="mt-4 space-y-4">
        <Field label="Goal" hint="what a perfect output achieves"><textarea rows={2} className={inputClass} value={form.goal} onChange={set('goal')} /></Field>
        <Field label="Starting system prompt (v1)" hint="it will evolve from here"><textarea rows={4} className={`${inputClass} font-mono text-[12.5px]`} value={form.prompt} onChange={set('prompt')} /></Field>
        <p className="text-[12px] font-semibold tracking-wide text-ink-400 uppercase">Validators</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Must include" hint="comma-separated"><input className={inputClass} value={form.must_include} onChange={set('must_include')} /></Field>
          <Field label="Must avoid" hint="comma-separated"><input className={inputClass} value={form.must_avoid} onChange={set('must_avoid')} /></Field>
          <Field label="Max words"><input type="number" className={inputClass} value={form.max_words} onChange={set('max_words')} /></Field>
          <Field label="Required JSON keys" hint="leave empty for free text"><input className={inputClass} value={form.json_keys} onChange={set('json_keys')} /></Field>
        </div>
        <Field label="Quality rubric" hint="the LLM judge scores 1-5 against this"><textarea rows={3} className={inputClass} value={form.rubric} onChange={set('rubric')} /></Field>
        <Field label="Reflect automatically after N failures"><input type="number" min={1} max={20} className={`${inputClass} !w-32`} value={form.auto_reflect_after} onChange={set('auto_reflect_after')} /></Field>
      </div>
      <ErrorNote message={error} />
      <div className="mt-4 flex gap-2">
        <Button accent={ACCENT} onClick={() => void create()} busy={busy} disabled={form.name.length < 2 || form.goal.length < 10 || form.prompt.length < 10}>Create task</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </Card>
  )
}

// ── Task view ──────────────────────────────────────────────────────────────
function TaskView({ id, samples, onBack }) {
  const [task, setTask] = useState(null)
  const [tab, setTab] = useState('play')
  const [error, setError] = useState(null)
  const refresh = useCallback(() => get(`/api/evolve/tasks/${id}`).then(setTask).catch((e) => setError(errorText(e))), [id])
  useEffect(() => void refresh(), [refresh])
  // while a background reflection runs, keep the view current
  useEffect(() => {
    if (!task?.reflecting) return
    const t = window.setInterval(() => void refresh(), 2500)
    return () => window.clearInterval(t)
  }, [task?.reflecting, refresh])

  if (error && !task)
    return (
      <div className="space-y-3">
        <ErrorNote message={error.includes('not found') ? 'This task no longer exists (it may have been deleted).' : error} />
        <button type="button" onClick={onBack} className="chip"><ArrowLeft className="size-3.5" /> Back to tasks</button>
      </div>
    )
  if (!task) return <Spinner label="Loading task…" />
  const current = task.versions.find((v) => v.n === task.current_version)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button type="button" onClick={onBack} className="flex items-center gap-1 text-[12.5px] text-ink-400 hover:text-white"><ArrowLeft className="size-3.5" /> Tasks</button>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">{task.name}</h1>
          <p className="mt-1 max-w-2xl text-[13.5px] text-ink-300">{task.goal}</p>
        </div>
        <EvolutionChart task={task} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill tone="info">prompt v{task.current_version}</Pill>
        <Pill tone={task.summary.pass_rate == null ? 'neutral' : task.summary.pass_rate >= 0.8 ? 'good' : 'warn'}>pass rate {pct(task.summary.pass_rate)}</Pill>
        <Pill>{task.failures_since_reflect}/{task.auto_reflect_after} failures until auto-reflect</Pill>
        {task.reflecting && <Pill tone="warn"><Sparkles className="size-3 animate-pulse" /> reflecting in the background…</Pill>}
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'play', label: 'Playground', icon: Play },
          { id: 'versions', label: 'Prompt versions', icon: History, badge: task.versions.length },
          { id: 'lessons', label: 'Lessons', icon: ListChecks, badge: task.runs.filter((r) => !r.passed).length },
          { id: 'reflect', label: 'Reflect', icon: BrainCog },
        ]}
      />
      {tab === 'play' && <Playground task={task} samples={samples} onChange={refresh} />}
      {tab === 'versions' && <Versions task={task} current={current} onChange={refresh} />}
      {tab === 'lessons' && <Lessons task={task} />}
      {tab === 'reflect' && <Reflect task={task} onDone={(t) => { setTask(t); setTab('versions') }} />}
    </div>
  )
}

function EvolutionChart({ task }) {
  const points = task.versions.map((v) => ({ n: v.n, rate: task.summary.pass_rate_by_version[String(v.n)] ?? v.score ?? null, promoted: v.promoted }))
  if (points.length < 1) return null
  return (
    <div className="glass rounded-2xl px-4 py-3">
      <p className="text-[10.5px] font-semibold tracking-[0.14em] text-ink-400 uppercase">Pass rate by version</p>
      <div className="mt-2 flex h-14 items-end gap-1.5">
        {points.map((p) => (
          <div key={p.n} className="flex w-7 flex-col items-center gap-1" title={`v${p.n}: ${pct(p.rate)}${p.promoted ? '' : ' (rejected)'}`}>
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: `${Math.max(6, (p.rate ?? 0) * 40)}px` }}
              className={`w-full rounded-t-md ${p.n === task.current_version ? 'bg-gradient-to-t from-teal-500 to-lime-400' : p.promoted ? 'bg-emerald-500/40' : 'bg-rose-500/30'}`}
            />
            <span className={`font-mono text-[10px] ${p.n === task.current_version ? 'text-white' : 'text-ink-500'}`}>v{p.n}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Playground ─────────────────────────────────────────────────────────────
function Playground({ task, samples, onChange }) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [last, setLast] = useState(null)

  const run = async (text = input) => {
    setBusy(true)
    setError(null)
    try {
      const r = await post(`/api/evolve/tasks/${task.id}/run`, { input: text })
      setLast(r)
      await onChange()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const feedback = async (r, fb) => {
    const note = fb === 'bad' ? window.prompt('What was wrong? (optional, becomes a lesson)') ?? undefined : undefined
    const updated = await post(`/api/evolve/runs/${r.id}/feedback`, { feedback: fb, note: note || null })
    setLast((l) => (l?.id === r.id ? { ...l, ...updated } : l))
    await onChange()
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-3">
        <Card>
          <Field label={task.input_label}>
            <textarea id="evolve-input" rows={5} className={inputClass} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Paste an input and run the current prompt…" />
          </Field>
          {samples.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">{samples.map((s) => <button key={s} type="button" className="chip" onClick={() => setInput(s)}>{s.slice(0, 60)}{s.length > 60 ? '…' : ''}</button>)}</div>
          )}
          <Button accent={ACCENT} className="mt-3" onClick={() => void run()} busy={busy} disabled={!input.trim()}><Play className="size-4" /> Run v{task.current_version}</Button>
          <div className="mt-3"><ErrorNote message={error} /></div>
        </Card>
        <Card>
          <p className="text-[12px] font-semibold tracking-wide text-ink-400 uppercase">Recent runs</p>
          <ul className="mt-2 divide-y divide-white/[0.05]">
            {task.runs.slice(0, 8).map((r) => (
              <li key={r.id} className="flex items-center gap-2 py-2 text-[12.5px]">
                {r.passed ? <CircleCheck className="size-4 shrink-0 text-emerald-300" /> : <XCircle className="size-4 shrink-0 text-rose-300" />}
                <button type="button" onClick={() => setLast(r)} className="min-w-0 flex-1 truncate text-left text-ink-200 hover:text-white">{r.input}</button>
                <span className="font-mono text-[11px] text-ink-500">v{r.version_n}</span>
                {r.feedback && <Pill tone={r.feedback === 'good' ? 'good' : 'bad'}>{r.feedback}</Pill>}
              </li>
            ))}
            {task.runs.length === 0 && <li className="py-2 text-[12.5px] text-ink-500">No runs yet.</li>}
          </ul>
        </Card>
      </div>
      <div>
        <AnimatePresence mode="wait">
          {last ? (
            <motion.div key={last.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <RunCard run={last} onFeedback={feedback} />
            </motion.div>
          ) : (
            <Empty icon={FlaskConical} title="Run something" text="The output, every check, the judge's score and reasons appear here. Mark it good or bad to teach the system." />
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function RunCard({ run, onFeedback }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={run.passed ? 'good' : 'bad'}>{run.passed ? 'passed' : 'failed'}</Pill>
        <Pill>v{run.version_n}</Pill>
        {run.judge && <Pill tone={run.judge.score >= 4 ? 'good' : run.judge.score === 3 ? 'warn' : 'bad'}>judge {run.judge.score}/5</Pill>}
        <span className="font-mono text-[11px] text-ink-500">{run.ms} ms</span>
        {run.auto_reflect && <Pill tone="warn"><Sparkles className="size-3" /> auto-reflection started</Pill>}
        <span className="flex-1" />
        <button type="button" aria-label="Good output" onClick={() => void onFeedback(run, 'good')} className={`grid size-8 place-items-center rounded-lg ${run.feedback === 'good' ? 'bg-emerald-500/15 text-emerald-300' : 'text-ink-400 hover:text-white'}`}><ThumbsUp className="size-4" /></button>
        <button type="button" aria-label="Bad output" onClick={() => void onFeedback(run, 'bad')} className={`grid size-8 place-items-center rounded-lg ${run.feedback === 'bad' ? 'bg-rose-500/15 text-rose-300' : 'text-ink-400 hover:text-white'}`}><ThumbsDown className="size-4" /></button>
      </div>
      <p className="mt-3 text-[11.5px] text-ink-500">Input</p>
      <p className="text-[13px] text-ink-300">{run.input}</p>
      <p className="mt-3 text-[11.5px] text-ink-500">Output</p>
      <pre id="evolve-output" className="mt-1 rounded-xl bg-ink-950/50 p-3 font-sans text-[13.5px] leading-relaxed whitespace-pre-wrap text-white">{run.output}</pre>
      <ul className="mt-3 space-y-1">
        {run.checks.map((c) => (
          <li key={c.name} className="flex items-center gap-2 text-[12.5px]">{c.passed ? <CircleCheck className="size-3.5 text-emerald-300" /> : <XCircle className="size-3.5 text-rose-300" />}<span className="text-ink-200">{c.name}</span>{c.detail && <span className="text-ink-500">· {c.detail}</span>}</li>
        ))}
        {run.judge && (
          <li className="mt-2 rounded-xl border border-white/[0.06] p-2.5 text-[12.5px]">
            <p className="font-semibold text-white">Judge: {run.judge.score}/5</p>
            {run.judge.reasons.map((r) => <p key={r} className="text-ink-300">• {r}</p>)}
            {run.judge.failed_criteria.length > 0 && <p className="mt-1 text-rose-300">Failed: {run.judge.failed_criteria.join(', ')}</p>}
          </li>
        )}
      </ul>
      {run.note && <p className="mt-2 text-[12.5px] text-amber-300">Your note: {run.note}</p>}
    </Card>
  )
}

// ── Versions ───────────────────────────────────────────────────────────────
function Versions({ task, current, onChange }) {
  const [selected, setSelected] = useState(task.current_version)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(current?.prompt ?? '')
  const [busy, setBusy] = useState(false)
  const v = task.versions.find((x) => x.n === selected) ?? current
  const prev = v ? task.versions.filter((x) => x.n < v.n && x.promoted).at(-1) : undefined
  const diff = useMemo(() => (v ? diffLines(prev?.prompt ?? '', v.prompt) : []), [v, prev])

  const save = async () => {
    setBusy(true)
    await post(`/api/evolve/tasks/${task.id}/versions`, { prompt: draft, rationale: 'Manual edit.' })
    setEditing(false)
    await onChange()
    setBusy(false)
  }
  const rollback = async (n) => {
    await post(`/api/evolve/tasks/${task.id}/versions/${n}/promote`)
    await onChange()
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <ol className="space-y-2">
        {[...task.versions].reverse().map((x) => (
          <li key={x.id}>
            <button type="button" onClick={() => setSelected(x.n)} className={`w-full rounded-2xl border p-3 text-left transition ${selected === x.n ? 'border-emerald-400/40 bg-emerald-500/[0.06]' : 'border-white/[0.06] bg-ink-900/60 hover:border-white/15'}`}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[13px] font-semibold text-white">v{x.n}</span>
                {x.n === task.current_version && <Pill tone="good">current</Pill>}
                {!x.promoted && <Pill tone="bad">rejected</Pill>}
                <span className="ml-auto text-[11px] text-ink-500">{x.source}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-[12px] text-ink-400">{x.rationale}</p>
              {x.evaluated_on > 0 && <p className="mt-1 font-mono text-[11px] text-ink-500">regression {pct(x.score)} vs {pct(x.baseline)} on {x.evaluated_on} cases</p>}
            </button>
          </li>
        ))}
      </ol>
      {v && (
        <div className="min-w-0 space-y-3">
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-semibold text-white">Prompt v{v.n}</h3>
              <span className="text-[12px] text-ink-500">{new Date(v.created_at).toLocaleString()}</span>
              <span className="flex-1" />
              {v.n !== task.current_version && <button type="button" className="chip" onClick={() => void rollback(v.n)}><RotateCcw className="size-3.5" /> Use this version</button>}
              {v.n === task.current_version && !editing && <button type="button" className="chip" onClick={() => { setDraft(v.prompt); setEditing(true) }}>Edit manually</button>}
            </div>
            <p className="mt-2 text-[13px] text-ink-300">{v.rationale}</p>
            {v.lessons.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5">{v.lessons.map((l) => <li key={l} className="rounded-full bg-teal-500/10 px-2.5 py-0.5 text-[11.5px] text-teal-200">{l}</li>)}</ul>
            )}
            {editing ? (
              <div className="mt-3 space-y-2">
                <textarea rows={8} className={`${inputClass} font-mono text-[12.5px]`} value={draft} onChange={(e) => setDraft(e.target.value)} />
                <div className="flex gap-2"><Button accent={ACCENT} onClick={() => void save()} busy={busy} disabled={draft.trim().length < 10}>Save as v{task.versions.length + 1}</Button><Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
              </div>
            ) : (
              <>
                <p className="mt-4 flex items-center gap-1.5 text-[11.5px] font-semibold tracking-wide text-ink-400 uppercase"><GitCompareArrows className="size-3.5" /> {prev ? `Changes vs v${prev.n}` : 'Seed prompt'}</p>
                <pre className="mt-1.5 overflow-x-auto rounded-xl bg-ink-950/50 p-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
                  {diff.map((d, i) => (
                    <div key={i} className={d.type === 'add' ? 'bg-emerald-500/15 text-emerald-200' : d.type === 'del' ? 'bg-rose-500/15 text-rose-300 line-through decoration-rose-400/50' : 'text-ink-300'}>
                      <span className="mr-2 select-none text-ink-600">{d.type === 'add' ? '+' : d.type === 'del' ? '−' : ' '}</span>{d.text || ' '}
                    </div>
                  ))}
                </pre>
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}

// ── Lessons ────────────────────────────────────────────────────────────────
function Lessons({ task }) {
  const [lessons, setLessons] = useState(null)
  useEffect(() => void get(`/api/evolve/tasks/${task.id}/lessons`).then(setLessons), [task.id, task.runs.length])
  if (!lessons) return <Spinner label="Loading lessons…" />
  if (!lessons.length) return <Empty icon={ListChecks} title="No lessons yet" text="Every failed run (or thumbs-down) shows up here with the reason. Reflection learns from these." />
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {lessons.map((l) => (
        <li key={l.run_id} className="rounded-2xl border border-rose-400/15 bg-ink-900/60 p-4">
          <p className="text-[11.5px] text-ink-500">v{l.version_n} · {new Date(l.at).toLocaleString()}</p>
          <p className="mt-1 line-clamp-2 text-[13px] text-ink-200">{l.input}</p>
          <p className="mt-2 line-clamp-3 rounded-lg bg-ink-950/50 p-2 text-[12.5px] text-ink-300">{l.output}</p>
          <ul className="mt-2 space-y-0.5">{l.why.map((w) => <li key={w} className="flex gap-1.5 text-[12.5px] text-rose-300"><XCircle className="mt-0.5 size-3.5 shrink-0" /> {w}</li>)}</ul>
        </li>
      ))}
    </ul>
  )
}

function Reflect({ task, onDone }) {
  const [steps, setSteps] = useState([])
  const [proposal, setProposal] = useState(null)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const failures = task.runs.filter((r) => !r.passed).length

  const go = async () => {
    setBusy(true)
    setError(null)
    setSteps([])
    setProposal(null)
    setResult(null)
    try {
      await streamPost(`/api/evolve/tasks/${task.id}/reflect`, {}, (ev) => {
        if (ev.event === 'step') {
          const name = String(ev.step)
          setSteps((s) => [...s.map((x) => ({ ...x, done: true })).filter((x) => !(x.name === 'evaluate' && name === 'evaluate')), { name, detail: String(ev.detail), done: name === 'evaluate' }])
          if (name === 'propose') setProposal({ prompt: String(ev.prompt), lessons: ev.lessons ?? [] })
        } else if (ev.event === 'done') {
          setSteps((s) => s.map((x) => ({ ...x, done: true })))
          setResult(ev)
        } else if (ev.event === 'error') setError(String(ev.message))
      })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <h3 className="flex items-center gap-2 text-[15px] font-semibold text-white"><BrainCog className="size-4 text-teal-300" /> Reflect now</h3>
        <p className="mt-1 text-[13px] text-ink-300">
          Reads the {failures} failed run{failures === 1 ? '' : 's'} and recent successes, proposes a revised prompt, then re-tests it on up to 6 recent inputs. It is promoted only if it does at least as well as v{task.current_version} and fixes something. Automatic reflection does the same after {task.auto_reflect_after} failures.
        </p>
        <Button accent={ACCENT} className="mt-4" onClick={() => void go()} busy={busy || task.reflecting} disabled={failures === 0}><Sparkles className="size-4" /> {failures === 0 ? 'Nothing to learn from yet' : `Learn from ${failures} failure${failures === 1 ? '' : 's'}`}</Button>
        {steps.length > 0 && <div className="mt-4"><Steps steps={steps} active={busy} /></div>}
        <div className="mt-3"><ErrorNote message={error} /></div>
        {proposal && !result && (
          <div className="mt-4">
            <p className="text-[11.5px] font-semibold tracking-wide text-ink-400 uppercase">Candidate prompt (testing…)</p>
            <pre className="mt-1.5 max-h-60 overflow-auto rounded-xl bg-ink-950/50 p-3 font-mono text-[12px] whitespace-pre-wrap text-ink-200">{proposal.prompt}</pre>
          </div>
        )}
      </Card>
      <div>
        {result ? (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
            <Card className={result.promoted ? 'ring-1 ring-emerald-400/30' : 'ring-1 ring-rose-400/20'}>
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={result.promoted ? 'good' : 'bad'}>{result.promoted ? `promoted → v${result.version.n}` : `rejected (kept v${task.current_version})`}</Pill>
                <Pill>regression {pct(result.score)} vs {pct(result.baseline)}</Pill>
                <Pill tone="good">{result.fixed} fixed</Pill>
                {result.regressed > 0 && <Pill tone="bad">{result.regressed} regressed</Pill>}
              </div>
              <p className="mt-3 text-[13.5px] text-ink-100">{result.version.rationale}</p>
              <ul className="mt-3 space-y-1.5">
                {result.cases.map((c, i) => (
                  <li key={i} className="flex items-start gap-2 text-[12.5px]">
                    <span className="mt-0.5 flex shrink-0 items-center gap-1">{c.before ? <CircleCheck className="size-3.5 text-ink-500" /> : <XCircle className="size-3.5 text-ink-500" />}<span className="text-ink-600">→</span>{c.after ? <CircleCheck className="size-3.5 text-emerald-300" /> : <XCircle className="size-3.5 text-rose-300" />}</span>
                    <span className="truncate text-ink-300" title={c.output}>{c.input}</span>
                  </li>
                ))}
              </ul>
              <Button variant="ghost" className="mt-4" onClick={() => onDone(result.task)}>See versions</Button>
            </Card>
          </motion.div>
        ) : (
          <Empty icon={TrendingUp} title="Proof before promotion" text="Each candidate is scored on the same recent inputs as the current prompt. Before → after results for every case appear here." />
        )}
      </div>
    </div>
  )
}
