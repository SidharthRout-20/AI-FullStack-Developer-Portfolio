import {
  AudioLines,
  CalendarClock,
  CircleDot,
  FileAudio,
  KanbanSquare,
  ListChecks,
  MessageSquareQuote,
  Mic,
  Search,
  ShieldAlert,
  Square,
  Trash2,
  Upload,
  Users,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { del, errorText, get, http, patch, post } from '../shared/http'
import { Answer, Button, Card, Empty, ErrorNote, Field, inputClass, Pill, ProductShell, Spinner, Tabs } from '@appcore/web/ui'

const ACCENT = 'from-emerald-500 via-teal-400 to-cyan-400'

const fmt = (s) => {
  const t = Math.floor(s)
  return t >= 3600 ? `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` : `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

const SAMPLE = `[00:00] Priya: Thanks everyone. Goal today is to lock the v2 launch plan.
[00:15] Arjun: Backend is feature complete. The only open item is load testing the search API.
[00:41] Priya: Can we commit to launching on the 28th?
[00:55] Meera: Marketing needs final screenshots by Monday to hit the 28th.
[01:20] Arjun: I'll run the load tests by Thursday and share the report.
[01:42] Priya: Decision then: we launch on the 28th, provided load tests pass.
[02:05] Meera: Risk: the pricing page copy still isn't approved by legal.
[02:30] Priya: I'll chase legal today. Meera, please send screenshots to the design team by Monday.`

export default function MeetingMindApp() {
  const [tab, setTab] = useState('new')
  const [openId, setOpenId] = useState(null)
  const [jump, setJump] = useState(null)

  const open = (id, at = null) => {
    setOpenId(id)
    setJump(at)
    setTab('meetings')
  }

  return (
    <ProductShell name="MeetingMind" tagline="Meetings in, decisions and action items out" icon={AudioLines}>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'new', label: 'New meeting', icon: Mic },
          { id: 'meetings', label: 'Meetings', icon: ListChecks },
          { id: 'board', label: 'Action board', icon: KanbanSquare },
          { id: 'ask', label: 'Ask the archive', icon: Search },
        ]}
      />
      {tab === 'new' && <NewMeeting onCreated={(m) => open(m.id)} />}
      {tab === 'meetings' && <MeetingsTab openId={openId} setOpenId={setOpenId} jump={jump} />}
      {tab === 'board' && <Board onOpen={open} />}
      {tab === 'ask' && <AskTab onOpen={open} />}
    </ProductShell>
  )
}

// ── Capture ────────────────────────────────────────────────────────────────
function NewMeeting({ onCreated }) {
  const [mode, setMode] = useState('record')
  const [title, setTitle] = useState('')
  const [transcript, setTranscript] = useState('')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const rec = useRef(null)

  useEffect(() => () => stopAll(), [])

  const sendAudio = async (blob) => {
    setBusy('Transcribing with Whisper, then extracting decisions…')
    setError(null)
    try {
      const m = await http('POST', `/api/meetings/audio${title ? `?title=${encodeURIComponent(title)}` : ''}`, blob, {
        'Content-Type': blob.type.split(';')[0] || 'audio/webm',
      })
      onCreated(m)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const start = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      const chunks = []
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      mr.onstop = () => void sendAudio(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }))
      // live input level meter
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      ctx.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.fftSize)
      const tick = () => {
        analyser.getByteTimeDomainData(data)
        let peak = 0
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128))
        setLevel(peak / 128)
        if (rec.current) rec.current.raf = requestAnimationFrame(tick)
      }
      const t0 = Date.now()
      rec.current = { mr, chunks, stream, raf: requestAnimationFrame(tick), timer: window.setInterval(() => setElapsed((Date.now() - t0) / 1000), 250) }
      mr.start(1000)
      setRecording(true)
    } catch {
      setError('Microphone access was denied or is unavailable. You can upload a file or paste a transcript instead.')
    }
  }

  function stopAll() {
    const r = rec.current
    if (!r) return
    cancelAnimationFrame(r.raf)
    window.clearInterval(r.timer)
    if (r.mr.state !== 'inactive') r.mr.stop()
    r.stream.getTracks().forEach((t) => t.stop())
    rec.current = null
    setRecording(false)
    setLevel(0)
  }

  const fromText = async () => {
    setBusy('Extracting decisions and action items…')
    setError(null)
    try {
      onCreated(await post('/api/meetings', { title: title || null, transcript }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Card>
        <Field label="Meeting title" hint="optional: the AI suggests one">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly product sync" />
        </Field>
        <div className="mt-4 inline-flex rounded-xl border border-white/[0.07] p-1">
          {(
            [
              ['record', 'Record', Mic],
              ['upload', 'Upload audio', Upload],
              ['paste', 'Paste transcript', MessageSquareQuote],
            ]).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setMode(id)}
              aria-pressed={mode === id}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${mode === id ? 'bg-white/[0.08] text-white' : 'text-ink-400 hover:text-white'}`}
            >
              <Icon className="size-3.5" /> {label}
            </button>
          ))}
        </div>

        <div className="mt-5">
          {mode === 'record' && (
            <div className="flex flex-col items-center py-4">
              <button
                type="button"
                onClick={() => (recording ? stopAll() : void start())}
                disabled={!!busy}
                aria-label={recording ? 'Stop recording' : 'Start recording'}
                className="relative grid size-24 place-items-center rounded-full bg-gradient-to-br from-emerald-500 to-cyan-500 text-on-accent shadow-xl shadow-emerald-950/40 transition hover:scale-105 disabled:opacity-50"
              >
                <motion.span className="absolute inset-0 rounded-full bg-emerald-400/30" animate={{ scale: 1 + level * 0.9 }} transition={{ duration: 0.1 }} />
                {recording ? <Square className="relative size-8 fill-current" /> : <Mic className="relative size-9" />}
              </button>
              <p className="mt-3 font-mono text-xl text-white tabular-nums">{fmt(elapsed)}</p>
              <p className="mt-1 text-[12.5px] text-ink-400">{recording ? 'Recording… click to stop and analyse' : 'Record a meeting or voice memo (up to ~24 MB)'}</p>
            </div>
          )}
          {mode === 'upload' && (
            <label className="flex cursor-pointer flex-col items-center rounded-2xl border border-dashed border-white/15 px-6 py-10 text-center transition hover:border-emerald-400/50">
              <FileAudio className="size-8 text-emerald-300" />
              <span className="mt-2 text-[14px] text-white">Choose an audio file</span>
              <span className="text-[12px] text-ink-400">mp3, m4a, wav, webm, ogg · up to 24 MB</span>
              <input type="file" accept="audio/*,video/webm,video/mp4" hidden onChange={(e) => e.target.files?.[0] && void sendAudio(e.target.files[0])} />
            </label>
          )}
          {mode === 'paste' && (
            <div className="space-y-3">
              <textarea
                id="transcript"
                className={`${inputClass} min-h-64 font-mono text-[12.5px]`}
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                placeholder="[00:00] Name: what was said…"
              />
              <div className="flex flex-wrap gap-2">
                <Button accent={ACCENT} onClick={() => void fromText()} disabled={transcript.trim().length < 40} busy={!!busy}>
                  Analyse transcript
                </Button>
                <Button variant="ghost" onClick={() => setTranscript(SAMPLE)}>Use a sample</Button>
              </div>
            </div>
          )}
        </div>
        {busy && <div className="mt-4"><Spinner label={busy} /></div>}
        <div className="mt-3"><ErrorNote message={error} /></div>
      </Card>
    </div>
  )
}

// ── Meetings list + detail ─────────────────────────────────────────────────
function MeetingsTab({ openId, setOpenId, jump }) {
  const [list, setList] = useState(null)
  const [loaded, setDetail] = useState(null)
  const detail = loaded && loaded.id === openId ? loaded : null
  const [error, setError] = useState(null)

  const load = useCallback(() => get('/api/meetings').then(setList).catch((e) => setError(errorText(e))), [])
  useEffect(() => void load(), [load])
  useEffect(() => {
    if (!openId) return
    get(`/api/meetings/${openId}`).then(setDetail).catch((e) => setError(errorText(e)))
  }, [openId])
  useEffect(() => {
    if (detail && jump != null) document.getElementById(`seg-${Math.floor(jump)}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [detail, jump])

  const remove = async (id) => {
    await del(`/api/meetings/${id}`)
    setOpenId(null)
    void load()
  }

  if (!list) return <Spinner label="Loading meetings…" />
  if (!list.length) return <Empty icon={AudioLines} title="No meetings yet" text="Record, upload or paste your first meeting to build the archive." />

  return (
    <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
      <ul className="space-y-2">
        {list.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => setOpenId(m.id)}
              className={`w-full rounded-2xl border p-3.5 text-left transition ${openId === m.id ? 'border-emerald-400/40 bg-emerald-500/[0.06]' : 'border-white/[0.06] bg-ink-900/60 hover:border-white/15'}`}
            >
              <p className="text-[14px] font-semibold text-white">{m.title}</p>
              <p className="mt-0.5 text-[11.5px] text-ink-400">
                {new Date(m.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · {m.action_items.length} actions
              </p>
            </button>
          </li>
        ))}
      </ul>
      <ErrorNote message={error} />
      {detail ? (
        <motion.div key={detail.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="min-w-0 space-y-4">
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-white">{detail.title}</h2>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Pill tone="info">{detail.source === 'audio' ? `audio · ${fmt(detail.duration)}` : 'transcript'}</Pill>
                  <Pill tone={detail.sentiment === 'positive' ? 'good' : detail.sentiment === 'tense' ? 'bad' : 'neutral'}>{detail.sentiment}</Pill>
                  {detail.topics.map((t) => <Pill key={t}>{t}</Pill>)}
                </div>
              </div>
              <button type="button" className="chip" onClick={() => void remove(detail.id)}><Trash2 className="size-3.5" /> Delete</button>
            </div>
            <p className="mt-3 text-[14px] leading-relaxed text-ink-100">{detail.summary}</p>
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <h3 className="flex items-center gap-2 text-[13px] font-semibold text-white"><CircleDot className="size-4 text-emerald-300" /> Decisions</h3>
              <ul className="mt-2 space-y-2 text-[13.5px] text-ink-100">
                {detail.decisions.length ? detail.decisions.map((d, i) => <li key={i}>• {d.text}{d.owner && <span className="text-ink-400"> ({d.owner})</span>}</li>) : <li className="text-ink-500">No decisions recorded.</li>}
              </ul>
            </Card>
            <Card>
              <h3 className="flex items-center gap-2 text-[13px] font-semibold text-white"><ShieldAlert className="size-4 text-amber-300" /> Risks</h3>
              <ul className="mt-2 space-y-2 text-[13.5px] text-ink-100">
                {detail.risks.length ? detail.risks.map((r, i) => <li key={i}>• {r}</li>) : <li className="text-ink-500">None raised.</li>}
              </ul>
            </Card>
          </div>
          <Card>
            <h3 className="flex items-center gap-2 text-[13px] font-semibold text-white"><ListChecks className="size-4 text-cyan-300" /> Action items</h3>
            <ul className="mt-2 divide-y divide-white/[0.05]">
              {detail.action_items.map((a, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2 py-2 text-[13.5px] text-ink-100">
                  <span className="flex-1">{a.text}</span>
                  {a.owner && <Pill><Users className="size-3" /> {a.owner}</Pill>}
                  {a.due && <Pill tone="warn"><CalendarClock className="size-3" /> {a.due}</Pill>}
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <h3 className="text-[13px] font-semibold text-white">Transcript</h3>
            <ol className="mt-2 max-h-96 space-y-1.5 overflow-y-auto pr-2">
              {detail.segments?.map((s, i) => (
                <li
                  key={i}
                  id={`seg-${Math.floor(s.start)}`}
                  className={`flex gap-3 rounded-lg px-2 py-1 text-[13px] ${jump != null && Math.abs(s.start - jump) < 1 ? 'bg-emerald-500/10' : ''}`}
                >
                  <span className="shrink-0 font-mono text-[11.5px] text-emerald-300">{fmt(s.start)}</span>
                  <span className="text-ink-200">{s.text}</span>
                </li>
              ))}
            </ol>
          </Card>
        </motion.div>
      ) : (
        <Empty icon={ListChecks} title="Pick a meeting" text="Summary, decisions, risks, owners and the timestamped transcript appear here." />
      )}
    </div>
  )
}

// ── Kanban board ───────────────────────────────────────────────────────────
const COLUMNS = [
  { id: 'todo', label: 'To do', dot: 'bg-ink-400' },
  { id: 'doing', label: 'In progress', dot: 'bg-sky-400' },
  { id: 'done', label: 'Done', dot: 'bg-emerald-400' },
]

function Board({ onOpen }) {
  const [tasks, setTasks] = useState(null)
  const [over, setOver] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => void get('/api/meetings/tasks').then(setTasks).catch((e) => setError(errorText(e))), [])

  const move = async (id, status) => {
    setTasks((ts) => ts?.map((t) => (t.id === id ? { ...t, status } : t)) ?? null)
    await patch(`/api/meetings/tasks/${id}`, { status }).catch((e) => setError(errorText(e)))
  }
  const drop = (status) => (e) => {
    e.preventDefault()
    setOver(null)
    const id = e.dataTransfer.getData('text/plain')
    if (id) void move(id, status)
  }

  if (!tasks) return <Spinner label="Loading the board…" />
  if (!tasks.length) return <Empty icon={KanbanSquare} title="No action items yet" text="Every action item extracted from a meeting lands here, with its owner and due date." />
  return (
    <>
      <ErrorNote message={error} />
      <div className="grid gap-3 md:grid-cols-3">
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.status === col.id)
          return (
            <section
              key={col.id}
              aria-label={col.label}
              onDragOver={(e) => {
                e.preventDefault()
                setOver(col.id)
              }}
              onDragLeave={() => setOver(null)}
              onDrop={drop(col.id)}
              className={`min-h-60 rounded-2xl border p-3 transition-colors ${over === col.id ? 'border-emerald-400/40 bg-emerald-500/[0.04]' : 'border-white/[0.06] bg-ink-900/40'}`}
            >
              <h3 className="mb-2.5 flex items-center gap-2 text-[12.5px] font-semibold text-ink-200">
                <span className={`size-2 rounded-full ${col.dot}`} /> {col.label} <span className="text-ink-500">{items.length}</span>
              </h3>
              <ul className="space-y-2">
                <AnimatePresence initial={false}>
                  {items.map((t) => (
                    <motion.li
                      key={t.id}
                      layout
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)}
                      className="cursor-grab rounded-xl border border-white/[0.07] bg-ink-900/80 p-3 active:cursor-grabbing"
                    >
                      <p className={`text-[13.5px] ${t.status === 'done' ? 'text-ink-400 line-through' : 'text-white'}`}>{t.text}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {t.owner && <Pill><Users className="size-3" /> {t.owner}</Pill>}
                        {t.due && <Pill tone="warn">{t.due}</Pill>}
                        <button type="button" onClick={() => onOpen(t.meeting_id)} className="truncate text-[11px] text-emerald-300 hover:underline">{t.meeting_title}</button>
                      </div>
                      <div className="mt-2 flex gap-1" role="group" aria-label="Move task">
                        {COLUMNS.filter((c) => c.id !== t.status).map((c) => (
                          <button key={c.id} type="button" className="chip !py-0.5 !text-[10.5px]" onClick={() => void move(t.id, c.id)}>→ {c.label}</button>
                        ))}
                      </div>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            </section>
          )
        })}
      </div>
    </>
  )
}

// ── Ask the archive ────────────────────────────────────────────────────────
function AskTab({ onOpen }) {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [focus, setFocus] = useState(null)

  const ask = async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(await post('/api/meetings/ask', { question: q }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <form
        className="glass flex gap-2 rounded-2xl p-2"
        onSubmit={(e) => {
          e.preventDefault()
          void ask()
        }}
      >
        <input id="ask" className="flex-1 bg-transparent px-3 text-[15px] text-white outline-none placeholder:text-ink-500" value={q} onChange={(e) => setQ(e.target.value)} placeholder="What did we decide about the launch date?" />
        <Button type="submit" accent={ACCENT} busy={busy} disabled={q.trim().length < 3}>Ask</Button>
      </form>
      <ErrorNote message={error} />
      {result && (
        <Card>
          <Answer text={result.answer} onCite={(n) => setFocus(n)} />
          <ul className="mt-4 space-y-2">
            {result.sources.map((s) => (
              <li key={s.n}>
                <button
                  type="button"
                  onClick={() => onOpen(s.meeting_id, s.start)}
                  className={`w-full rounded-xl border p-3 text-left transition ${focus === s.n ? 'border-emerald-400/40 bg-emerald-500/[0.06]' : 'border-white/[0.06] hover:border-white/15'}`}
                >
                  <p className="text-[12px] text-ink-400">
                    <span className="mr-1.5 rounded bg-white/[0.06] px-1.5 font-mono text-[10.5px] text-ink-200">{s.n}</span>
                    {s.meeting_title} · <span className="font-mono text-emerald-300">{fmt(s.start)}</span>
                  </p>
                  <p className="mt-1 line-clamp-2 text-[13px] text-ink-200">{s.text}</p>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
