import {
  BriefcaseBusiness,
  CheckCircle2,
  CircleMinus,
  ClipboardCopy,
  Download,
  FileText,
  KanbanSquare,
  Mic,
  Plus,
  Square,
  Target,
  Trash2,
  Volume2,
  XCircle,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useState } from 'react'
import { streamMatch } from '../../lib/api'
import { listen, speak, voiceSupported } from '@appcore/web/device'
import { del, download, errorText, get, patch, post, put } from '../shared/http'
import { Button, Card, Empty, ErrorNote, Field, inputClass, Pill, ProductShell, Spinner, Tabs } from '@appcore/web/ui'

const ACCENT = 'from-sky-500 via-blue-500 to-indigo-500'

const STAGES = [
  { id: 'saved', label: 'Saved', tone: 'bg-ink-400' },
  { id: 'applied', label: 'Applied', tone: 'bg-sky-400' },
  { id: 'interview', label: 'Interviewing', tone: 'bg-violet-400' },
  { id: 'offer', label: 'Offer', tone: 'bg-emerald-400' },
  { id: 'rejected', label: 'Closed', tone: 'bg-rose-400' },
]

export default function CareerPilotApp() {
  const [tab, setTab] = useState('match')
  const [job, setJob] = useState({ jd: '', company: '', role: '' })
  const [gaps, setGaps] = useState([])
  const [score, setScore] = useState(null)

  return (
    <ProductShell name="CareerPilot" tagline="Your job hunt, with a copilot" icon={BriefcaseBusiness} accent={ACCENT}>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'match', label: 'Match & tailor', icon: Target },
          { id: 'interview', label: 'Mock interview', icon: Mic },
          { id: 'tracker', label: 'Applications', icon: KanbanSquare },
          { id: 'resume', label: 'Resume', icon: FileText },
        ]}
      />
      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
          {tab === 'match' && (
            <MatchTab
              job={job}
              setJob={setJob}
              onGaps={setGaps}
              onScore={setScore}
              onPractice={() => setTab('interview')}
              onTrack={() => setTab('tracker')}
              score={score}
            />
          )}
          {tab === 'interview' && <InterviewTab job={job} gaps={gaps} onNeedJob={() => setTab('match')} />}
          {tab === 'tracker' && <TrackerTab prefill={job.company && job.role ? { ...job, score } : null} />}
          {tab === 'resume' && <ResumeTab />}
        </motion.div>
      </AnimatePresence>
    </ProductShell>
  )
}

// ── Match & tailor ─────────────────────────────────────────────────────────
function MatchTab({
  job,
  setJob,
  onGaps,
  onScore,
  onPractice,
  onTrack,
  score,
}) {
  const [match, setMatch] = useState(null)
  const [stage, setStage] = useState(null)
  const [tailored, setTailored] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [tracked, setTracked] = useState(false)

  const run = async () => {
    setBusy(true)
    setError(null)
    setMatch(null)
    setTailored(null)
    setTracked(false)
    onScore(null)
    const ctrl = new AbortController()
    const matching = streamMatch(job.jd, ctrl.signal, (ev) => {
      if (ev.event === 'stage') setStage(ev.status === 'start' ? ev.stage : null)
      else if (ev.event === 'result') {
        setMatch(ev)
        onScore(ev.score)
        onGaps(ev.requirements.filter((r) => r.status !== 'met').map((r) => r.text))
      } else if (ev.event === 'error') setError(ev.message)
    })
    const tailoring = post('/api/career/tailor', { jd: job.jd, company: job.company || null, role: job.role || null }).then(setTailored)
    const results = await Promise.allSettled([matching, tailoring])
    const failed = results.find((r) => r.status === 'rejected')
    if (failed) setError(errorText(failed.reason))
    setStage(null)
    setBusy(false)
  }

  const track = async () => {
    await post('/api/career/applications', { company: job.company, role: job.role, match_score: score, stage: 'saved' })
    setTracked(true)
  }

  const letter = tailored ? tailored.cover_letter : ''
  const markdown = tailored
    ? `# ${tailored.headline}\n\n${tailored.summary}\n\n## Experience highlights\n${tailored.bullets.map((b) => `- ${b.rewritten}`).join('\n')}\n\n## Cover letter\n\n${letter}\n`
    : ''

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <Card className="h-fit lg:sticky lg:top-22">
        <div className="space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Company">
              <input className={inputClass} value={job.company} onChange={(e) => setJob({ ...job, company: e.target.value })} placeholder="Acme" />
            </Field>
            <Field label="Role">
              <input className={inputClass} value={job.role} onChange={(e) => setJob({ ...job, role: e.target.value })} placeholder="AI Engineer" />
            </Field>
          </div>
          <Field label="Job description" hint={`${job.jd.length}/12000`}>
            <textarea
              id="jd"
              className={`${inputClass} min-h-56 resize-y font-[450]`}
              value={job.jd}
              maxLength={12000}
              onChange={(e) => setJob({ ...job, jd: e.target.value })}
              placeholder="Paste the full job description…"
            />
          </Field>
          <Button accent={ACCENT} onClick={() => void run()} busy={busy} disabled={job.jd.trim().length < 40} className="w-full">
            Analyse & tailor
          </Button>
          <p className="text-[11.5px] text-ink-500">Uses DocuMind's Match engine on your resume, plus a tailoring pass. Nothing is invented: rewrites only rephrase what your resume says.</p>
        </div>
      </Card>

      <div className="min-w-0 space-y-5">
        <ErrorNote message={error} />
        {!busy && !match && !tailored && !error && (
          <Empty icon={Target} title="Paste a job description" text="You'll get a cited match score, the gaps to close, a tailored resume and a cover letter." />
        )}
        {busy && (
          <Card>
            <Spinner label={stage ? `Matching: ${stage}…` : 'Tailoring your resume…'} />
          </Card>
        )}
        {match && (
          <Card>
            <div className="flex flex-wrap items-center gap-5">
              <ScoreRing score={match.score} />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold tracking-[0.14em] text-sky-300 uppercase">Match score</p>
                <p className="mt-1 text-[15px] text-white">{match.verdict}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Pill tone="good">{match.counts.met} met</Pill>
                  <Pill tone="warn">{match.counts.partial} partial</Pill>
                  <Pill tone="bad">{match.counts.missing} missing</Pill>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={onPractice}>
                  <Mic className="size-4" /> Practice interview
                </Button>
                {job.company && job.role && (
                  <Button variant="ghost" onClick={() => void (tracked ? onTrack() : track())}>
                    <KanbanSquare className="size-4" /> {tracked ? 'Open tracker' : 'Track application'}
                  </Button>
                )}
              </div>
            </div>
            <ul className="mt-4 divide-y divide-white/[0.05]">
              {match.requirements.map((r) => {
                const Icon = r.status === 'met' ? CheckCircle2 : r.status === 'partial' ? CircleMinus : XCircle
                const tone = r.status === 'met' ? 'text-emerald-300' : r.status === 'partial' ? 'text-amber-300' : 'text-rose-300'
                return (
                  <li key={r.id} className="flex gap-3 py-2.5">
                    <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} />
                    <div className="min-w-0">
                      <p className="text-[13.5px] text-white">
                        {r.text} {r.priority === 'must' && <span className="ml-1 text-[10px] font-semibold text-ink-400 uppercase">must</span>}
                      </p>
                      <p className="text-[12.5px] text-ink-400">{r.rationale}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
          </Card>
        )}
        {tailored && (
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold tracking-[0.14em] text-sky-300 uppercase">Tailored resume</p>
                <h2 className="mt-1 text-lg font-semibold text-white">{tailored.headline}</h2>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(markdown)}>
                  <ClipboardCopy className="size-4" /> Copy
                </Button>
                <Button variant="ghost" onClick={() => download(`${(job.company || 'tailored').replace(/\W+/g, '-')}-resume.md`, markdown)}>
                  <Download className="size-4" /> .md
                </Button>
              </div>
            </div>
            <p className="mt-3 text-[14px] leading-relaxed text-ink-100">{tailored.summary}</p>
            <ul className="mt-4 space-y-2.5">
              {tailored.bullets.map((b, i) => (
                <li key={i} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                  <p className="text-[13.5px] text-white">• {b.rewritten}</p>
                  {b.original && <p className="mt-1 text-[12px] text-ink-500 line-through decoration-ink-600">{b.original}</p>}
                  {b.why && <p className="mt-1 text-[12px] text-sky-300">{b.why}</p>}
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {tailored.keywords_matched.map((k) => (
                <Pill key={k} tone="good">{k}</Pill>
              ))}
              {tailored.keywords_missing.map((k) => (
                <Pill key={k} tone="bad">missing: {k}</Pill>
              ))}
            </div>
            <h3 className="mt-6 text-[13px] font-semibold text-white">Cover letter</h3>
            <div className="mt-2 rounded-xl border border-white/[0.06] bg-ink-950/40 p-4 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink-100">{letter}</div>
          </Card>
        )}
      </div>
    </div>
  )
}

function ScoreRing({ score }) {
  const r = 34
  const c = 2 * Math.PI * r
  const color = score >= 75 ? 'var(--color-emerald-400)' : score >= 50 ? 'var(--color-amber-400)' : 'var(--color-rose-400)'
  return (
    <svg viewBox="0 0 80 80" className="size-20 -rotate-90">
      <circle cx="40" cy="40" r={r} fill="none" strokeWidth="7" style={{ stroke: 'var(--hairline)' }} />
      <motion.circle
        cx="40"
        cy="40"
        r={r}
        fill="none"
        strokeWidth="7"
        strokeLinecap="round"
        style={{ stroke: color }}
        strokeDasharray={c}
        initial={{ strokeDashoffset: c }}
        animate={{ strokeDashoffset: c * (1 - score / 100) }}
        transition={{ duration: 1, ease: 'easeOut' }}
      />
      <text x="40" y="46" textAnchor="middle" className="rotate-90 [transform-origin:40px_40px]" style={{ fill: 'var(--color-white)', fontSize: 18, fontWeight: 700 }}>
        {score}
      </text>
    </svg>
  )
}

// ── Mock interview ─────────────────────────────────────────────────────────
function InterviewTab({ job, gaps, onNeedJob }) {
  const [session, setSession] = useState(null)
  const [current, setCurrent] = useState(0)
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [listening, setListening] = useState(null)

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      const s = await post('/api/career/interviews', { jd: job.jd, company: job.company || null, role: job.role || null, gaps })
      setSession(s)
      setCurrent(0)
      const first = s.questions[0]
      if (first) speak(first.text)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const q = session?.questions[current]
  const graded = session && q ? session.answers.find((a) => a.question_id === q.id) : undefined

  const submit = async () => {
    if (!session || !q) return
    setBusy(true)
    setError(null)
    try {
      const out = await post(
        `/api/career/interviews/${session.id}/answers`,
        { question_id: q.id, answer },
      )
      setSession({ ...out.session, summary: out.summary })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const next = () => {
    if (!session) return
    const n = Math.min(current + 1, session.questions.length - 1)
    setCurrent(n)
    setAnswer('')
    const nq = session.questions[n]
    if (nq && n !== current) speak(nq.text)
  }

  const dictate = () => {
    if (listening) return listening()
    const base = answer ? `${answer} ` : ''
    const stop = listen(
      (t) => setAnswer(base + t),
      () => setListening(null),
    )
    setListening(() => stop)
  }

  if (job.jd.trim().length < 40)
    return (
      <Empty icon={Mic} title="Start from a job description" text="The interview is generated from the role and the gaps found in your match analysis.">
        <Button accent={ACCENT} onClick={onNeedJob}>Add a job description</Button>
      </Empty>
    )

  if (!session)
    return (
      <Card className="mx-auto max-w-2xl text-center">
        <Mic className="mx-auto size-8 text-sky-300" />
        <h2 className="mt-3 text-lg font-semibold text-white">Mock interview{job.role ? ` · ${job.role}` : ''}</h2>
        <p className="mx-auto mt-1 max-w-md text-[13px] text-ink-400">
          5 questions: technical, behavioural, and one on your biggest gap{gaps.length ? ` (${gaps.slice(0, 2).join(', ')})` : ''}. Questions are read aloud; answer by voice or typing. Weak answers get one follow-up.
        </p>
        <ErrorNote message={error} />
        <Button accent={ACCENT} onClick={() => void start()} busy={busy} className="mt-5">Start interview</Button>
      </Card>
    )

  return (
    <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
      <Card className="h-fit">
        <p className="text-[11px] font-semibold tracking-[0.14em] text-ink-400 uppercase">Progress</p>
        <p className="mt-1 text-2xl font-semibold text-white tabular-nums">
          {session.summary.average ?? '–'}
          <span className="text-[13px] text-ink-400"> / 5 avg</span>
        </p>
        <ol className="mt-3 space-y-1">
          {session.questions.map((qq, i) => {
            const a = session.answers.find((x) => x.question_id === qq.id)
            return (
              <li key={qq.id}>
                <button
                  type="button"
                  onClick={() => {
                    setCurrent(i)
                    setAnswer('')
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] ${i === current ? 'bg-white/[0.07] text-white' : 'text-ink-300 hover:text-white'}`}
                >
                  <span className={`grid size-5 place-items-center rounded-full text-[10px] ${a ? (a.score >= 4 ? 'bg-emerald-500/20 text-emerald-300' : a.score === 3 ? 'bg-amber-500/20 text-amber-300' : 'bg-rose-500/20 text-rose-300') : 'bg-white/[0.06]'}`}>
                    {a ? a.score : i + 1}
                  </span>
                  <span className="truncate">{qq.kind === 'follow_up' ? '↳ Follow-up' : qq.kind}</span>
                </button>
              </li>
            )
          })}
        </ol>
      </Card>

      {q && (
        <Card>
          <div className="flex items-start justify-between gap-3">
            <Pill tone={q.kind === 'follow_up' ? 'warn' : q.kind === 'gap' ? 'bad' : 'info'}>{q.kind.replace('_', '-')}</Pill>
            <button type="button" className="chip" onClick={() => speak(q.text)}>
              <Volume2 className="size-3.5" /> Read aloud
            </button>
          </div>
          <h2 className="mt-3 text-[17px] leading-snug font-semibold text-white" id="question-text">{q.text}</h2>
          {graded ? (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-4 space-y-3">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-[13px] text-ink-300 italic">“{graded.answer}”</div>
              <div className="flex items-center gap-3">
                <span className="text-3xl font-semibold text-white tabular-nums">{graded.score}/5</span>
                <p className="text-[13.5px] text-ink-100">{graded.feedback}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <ListBox title="Strengths" items={graded.strengths} tone="text-emerald-300" />
                <ListBox title="Improve" items={graded.improve} tone="text-amber-300" />
              </div>
              <Button accent={ACCENT} onClick={next} disabled={current >= session.questions.length - 1}>
                {session.questions[current + 1]?.kind === 'follow_up' ? 'Answer the follow-up' : current >= session.questions.length - 1 ? 'Interview complete' : 'Next question'}
              </Button>
            </motion.div>
          ) : (
            <div className="mt-4 space-y-3">
              <textarea
                id="answer"
                className={`${inputClass} min-h-40`}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="Answer as you would in the interview. Use STAR for behavioural questions."
              />
              <div className="flex flex-wrap items-center gap-2">
                {voiceSupported() && (
                  <Button variant="ghost" onClick={dictate}>
                    {listening ? <Square className="size-4 fill-current text-rose-300" /> : <Mic className="size-4" />}
                    {listening ? 'Stop' : 'Answer by voice'}
                  </Button>
                )}
                <Button accent={ACCENT} onClick={() => void submit()} busy={busy} disabled={!answer.trim()}>
                  Submit answer
                </Button>
              </div>
              <ErrorNote message={error} />
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

function ListBox({ title, items, tone }) {
  return (
    <div className="rounded-xl border border-white/[0.06] p-3">
      <p className={`text-[11px] font-semibold tracking-wide uppercase ${tone}`}>{title}</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[12.5px] text-ink-200">
        {items.length ? items.map((i) => <li key={i}>{i}</li>) : <li className="list-none text-ink-500">–</li>}
      </ul>
    </div>
  )
}

// ── Tracker (kanban) ───────────────────────────────────────────────────────
function TrackerTab({ prefill }) {
  const [apps, setApps] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ company: prefill?.company ?? '', role: prefill?.role ?? '', url: '' })
  const [error, setError] = useState(null)
  const [dragging, setDragging] = useState(null)

  const load = useCallback(() => get('/api/career/applications').then(setApps).catch((e) => setError(errorText(e))).finally(() => setLoading(false)), [])
  useEffect(() => void load(), [load])

  const add = async () => {
    setError(null)
    try {
      await post('/api/career/applications', {
        company: form.company.trim(),
        role: form.role.trim(),
        url: form.url.trim() || null,
        match_score: prefill?.company === form.company ? prefill?.score : null,
      })
      setForm({ company: '', role: '', url: '' })
      void load()
    } catch (e) {
      setError(errorText(e))
    }
  }
  const move = async (id, stage) => {
    setApps((list) => list.map((a) => (a.id === id ? { ...a, stage } : a)))
    await patch(`/api/career/applications/${id}`, { stage }).catch((e) => setError(errorText(e)))
  }
  const remove = async (id) => {
    setApps((list) => list.filter((a) => a.id !== id))
    await del(`/api/career/applications/${id}`).catch((e) => setError(errorText(e)))
  }

  const onDrop = (stage) => (e) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain')
    if (id) void move(id, stage)
    setDragging(null)
  }

  return (
    <div className="space-y-5">
      <Card>
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_1.4fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <Field label="Company"><input className={inputClass} value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} required /></Field>
          <Field label="Role"><input className={inputClass} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} required /></Field>
          <Field label="Posting URL" hint="optional"><input className={inputClass} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://" /></Field>
          <Button type="submit" accent={ACCENT}><Plus className="size-4" /> Add</Button>
        </form>
        <div className="mt-3"><ErrorNote message={error} /></div>
      </Card>
      {loading ? (
        <Spinner label="Loading applications…" />
      ) : (
        <div className="grid gap-3 overflow-x-auto pb-2 md:grid-cols-5">
          {STAGES.map((s) => {
            const items = apps.filter((a) => a.stage === s.id)
            return (
              <section
                key={s.id}
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop(s.id)}
                aria-label={s.label}
                className={`min-h-40 rounded-2xl border p-2.5 transition-colors ${dragging ? 'border-dashed border-white/15 bg-white/[0.02]' : 'border-white/[0.06] bg-ink-900/40'}`}
              >
                <h3 className="mb-2 flex items-center gap-2 px-1 text-[12px] font-semibold text-ink-200">
                  <span className={`size-2 rounded-full ${s.tone}`} /> {s.label}
                  <span className="text-ink-500">{items.length}</span>
                </h3>
                <ul className="space-y-2">
                  <AnimatePresence initial={false}>
                    {items.map((a) => (
                      <motion.li
                        key={a.id}
                        layout
                        initial={{ opacity: 0, scale: 0.96 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.96 }}
                        draggable
                        onDragStart={(e) => {
                          const ev = e
                          ev.dataTransfer.setData('text/plain', a.id)
                          setDragging(a.id)
                        }}
                        onDragEnd={() => setDragging(null)}
                        className="group cursor-grab rounded-xl border border-white/[0.07] bg-ink-900/80 p-3 active:cursor-grabbing"
                      >
                        <p className="text-[13.5px] font-semibold text-white">{a.company}</p>
                        <p className="text-[12px] text-ink-300">{a.role}</p>
                        <div className="mt-2 flex items-center gap-1.5">
                          {a.match_score != null && <Pill tone={a.match_score >= 75 ? 'good' : a.match_score >= 50 ? 'warn' : 'bad'}>{a.match_score}% match</Pill>}
                          {a.url && <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-sky-300 hover:underline">posting</a>}
                        </div>
                        <div className="mt-2 flex items-center gap-1">
                          <select
                            aria-label={`Move ${a.company}`}
                            value={a.stage}
                            onChange={(e) => void move(a.id, e.target.value)}
                            className="flex-1 rounded-lg border border-white/10 bg-transparent px-1.5 py-1 text-[11.5px] text-ink-300"
                          >
                            {STAGES.map((x) => <option key={x.id} value={x.id} className="bg-ink-900">{x.label}</option>)}
                          </select>
                          <button type="button" aria-label={`Delete ${a.company}`} onClick={() => void remove(a.id)} className="grid size-7 place-items-center rounded-lg text-ink-500 hover:bg-rose-500/10 hover:text-rose-300">
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Resume ─────────────────────────────────────────────────────────────────
function ResumeTab() {
  const [text, setText] = useState('')
  const [source, setSource] = useState(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    get('/api/career/resume')
      .then((r) => {
        setText(r.text)
        setSource(r.source)
      })
      .catch((e) => setError(errorText(e)))
  }, [])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await put('/api/career/resume', { text })
      setSource(r.source)
      setNote('Saved. Tailoring and interviews now use this version.')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-white">Your resume</h2>
        <Pill tone="info">{source === 'saved' ? 'Custom version' : source ? `From knowledge base: ${source}` : 'Not set'}</Pill>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-400">Tailoring and interviews read this text. The match score uses the documents indexed in DocuMind.</p>
      <textarea className={`${inputClass} mt-3 min-h-96 font-mono text-[12.5px]`} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button accent={ACCENT} onClick={() => void save()} busy={busy} disabled={text.trim().length < 50}>Save resume</Button>
        {source === 'saved' && (
          <Button
            variant="ghost"
            onClick={() =>
              void del('/api/career/resume').then(() =>
                get('/api/career/resume').then((r) => {
                  setText(r.text)
                  setSource(r.source)
                  setNote('Reverted to the knowledge-base resume.')
                }),
              )
            }
          >
            Use knowledge-base resume
          </Button>
        )}
      </div>
      {note && <p className="mt-2 text-[12.5px] text-emerald-300">{note}</p>}
      <div className="mt-2"><ErrorNote message={error} /></div>
    </Card>
  )
}

