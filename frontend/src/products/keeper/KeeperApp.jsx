import { ArrowLeft, CalendarDays, KeyRound, LayoutGrid, Mic, Route as RouteIcon, Settings2, Sparkles, WifiOff } from 'lucide-react'
import { AnimatePresence, motion, MotionConfig } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Backdrop } from '../../components/shell/Backdrop'
import { LITE } from '../../lib/lite'
import { Link } from '@appcore/web/router'
import { ThemeToggle } from '../../theme/ThemeToggle'
import {
  keeperApi,
  KeyRequiredError,
  setAccessKey,
} from './api'
import { Assistant, AssistantBoundary } from './Assistant'
import { Capture } from './Capture'
import { currentPosition, notify, registerServiceWorker } from '@appcore/web/device'
import { EntryCard } from './EntryCard'
import { AlarmBanner, ReminderSettingsCard, useAlarms } from './Reminders'
import { localISO, MODULES, moduleOf } from './modules'
import { ScanSheet } from './ScanSheet'
import { TodayView } from './TodayView'

const NOTIFIED_KEY = 'keeper-notified'

export default function KeeperApp() {
  const [status, setStatus] = useState(null)
  const [entries, setEntries] = useState([])
  const [agenda, setAgenda] = useState([])
  const [brief, setBrief] = useState(null)
  const [briefLoading, setBriefLoading] = useState(false)
  const [view, setView] = useState('assistant') // 'assistant' | 'today' | 'saved'
  const [settings, setSettings] = useState(false)
  const [module, setModule] = useState('today')
  const [busy, setBusy] = useState(false)
  const [turn, setTurn] = useState(null)
  const [offline, setOffline] = useState(false)
  const [needKey, setNeedKey] = useState(false)
  const [scan, setScan] = useState(null)
  const [toast, setToast] = useState(null)
  const [perm, setPerm] = useState(() =>
    'Notification' in window ? Notification.permission : 'unsupported',
  )
  const turnId = useRef(0)

  const handle = useCallback((err) => {
    if (err instanceof KeyRequiredError) setNeedKey(true)
    else if (err instanceof TypeError) setOffline(true) // network failure
    return err instanceof Error ? err.message : 'Something went wrong'
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [e, a] = await Promise.all([keeperApi.entries(), keeperApi.agenda()])
      setEntries(e)
      setAgenda(a)
      setOffline(false)
    } catch (err) {
      handle(err)
    }
  }, [handle])

  // Timed reminders: chime + read aloud + notification while Keeper is open.
  const alarms = useAlarms(!!status && !needKey, () => void refresh())

  const loadBrief = useCallback(async () => {
    setBriefLoading(true)
    try {
      setBrief(await keeperApi.brief())
    } catch (err) {
      handle(err)
    } finally {
      setBriefLoading(false)
    }
  }, [handle])

  const boot = useCallback(() => {
    keeperApi
      .status()
      .then((s) => {
        setStatus(s)
        setNeedKey(false)
        void refresh()
        void loadBrief()
      })
      .catch(handle)
  }, [handle, loadBrief, refresh])

  useEffect(() => {
    boot()
    void registerServiceWorker()
    // Installable as its own app: Keeper gets a dedicated web manifest while this route is open.
    const link = document.createElement('link')
    link.rel = 'manifest'
    link.href = '/keeper.webmanifest'
    document.head.appendChild(link)
    return () => link.remove()
  }, [boot])

  // Daily nudge for things due today without a set time (timed reminders come from useAlarms).
  useEffect(() => {
    if (perm !== 'granted') return
    const fire = () => {
      const today = localISO()
      let sent = {}
      try {
        sent = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? '{}')
      } catch {
        /* ignore */
      }
      for (const a of agenda) {
        if (a.bucket !== 'today' && a.bucket !== 'overdue') continue
        if (a.entry.due_time) continue
        if (sent[a.entry.id] === today) continue
        void notify('Tara', a.label, a.entry.id)
        sent[a.entry.id] = today
      }
      try {
        localStorage.setItem(NOTIFIED_KEY, JSON.stringify(sent))
      } catch {
        /* ignore */
      }
    }
    fire()
    const t = window.setInterval(fire, 60_000)
    return () => window.clearInterval(t)
  }, [agenda, perm])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 3200)
    return () => window.clearTimeout(t)
  }, [toast])

  // ── Actions ──────────────────────────────────────────────────────────
  const send = async ({ text, photo, withLocation }) => {
    const id = ++turnId.current
    setTurn({ id, text, result: null, error: null })
    setBusy(true)
    try {
      const [upload, pos] = await Promise.all([
        photo ? keeperApi.uploadPhoto(photo) : Promise.resolve(null),
        withLocation ? currentPosition() : Promise.resolve(null),
      ])
      const result = await keeperApi.command(text, {
        ...(upload ? { photo_id: upload.photo_id } : {}),
        ...(pos ?? {}),
      })
      setTurn({ id, text, result, error: null })
      if (result.brief) setBrief(result.brief)
      if (result.action === 'brief') setModule('today')
      else if (result.kind) setModule(result.kind)
      void refresh()
    } catch (err) {
      setTurn({ id, text, result: null, error: handle(err) })
    } finally {
      setBusy(false)
    }
  }

  const startScan = async (photo) => {
    setScan({ photo, photoId: null, result: null, error: null })
    try {
      const { photo_id } = await keeperApi.uploadPhoto(photo)
      setScan((s) => s && { ...s, photoId: photo_id })
      const result = await keeperApi.scan(photo_id)
      setScan((s) => s && { ...s, photoId: photo_id, result })
    } catch (err) {
      const message = handle(err)
      setScan((s) => s && { ...s, error: message })
    }
  }

  const saveScan = async (items) => {
    try {
      const saved = await Promise.all(items.map((i) => keeperApi.create(i)))
      setScan(null)
      const first = saved[0]
      if (first) {
        setModule(first.kind)
        setToast(`Saved to ${moduleOf(first.kind).label}`)
      }
      void refresh()
    } catch (err) {
      setToast(handle(err))
    }
  }

  const mutate = async (fn, message) => {
    try {
      await fn()
      setToast(message)
      await refresh()
    } catch (err) {
      setToast(handle(err))
    }
  }

  const counts = useMemo(() => {
    const c = { today: agenda.filter((a) => a.bucket !== 'soon').length }
    for (const e of entries) {
      if (e.kind === 'pantry' && e.data.state !== 'need') continue
      c[e.kind] = (c[e.kind] ?? 0) + 1
    }
    return c
  }, [entries, agenda])

  const visible = useMemo(() => {
    if (module === 'today') return []
    const list = entries.filter((e) => e.kind === module)
    if (module === 'pantry') return [...list].sort((a, b) => Number(b.data.state === 'need') - Number(a.data.state === 'need'))
    return list
  }, [entries, module])

  const meta = moduleOf(module)
  const examples = module === 'today' ? MODULES.slice(1, 6).map((m) => m.example) : [meta.example, "what's due?", 'help']

  const go = (v) => {
    setView(v)
    if (v === 'today') setModule('today')
    else if (v === 'saved' && module === 'today') setModule(MODULES[1]?.id ?? 'stash')
  }
  const openSettings = (open = true) => {
    if (open) setView('assistant') // the settings sheet lives with the assistant
    setSettings(open)
  }
  const NAV = [
    { id: 'assistant', label: 'Assistant', icon: Sparkles },
    { id: 'today', label: 'Today', icon: CalendarDays, count: counts.today },
    { id: 'saved', label: 'Saved', icon: LayoutGrid, count: entries.length || null },
  ]

  return (
    <MotionConfig reducedMotion={LITE ? 'always' : 'user'}>
      <Backdrop />
      <div className="flex min-h-full">
        {/* Sidebar (desktop) */}
        <aside className="sticky top-0 hidden h-svh w-64 shrink-0 flex-col border-r border-white/[0.06] bg-ink-950/60 px-3 py-4 backdrop-blur-xl lg:flex">
          <div className="flex items-center gap-2.5 px-2">
            <span className="grid size-9 place-items-center rounded-2xl bg-gradient-to-br from-fuchsia-500 via-pink-500 to-orange-400 text-on-accent shadow-lg shadow-pink-950/40"><Sparkles className="size-4.5" /></span>
            <div className="leading-tight">
              <p className="text-[16px] font-semibold tracking-tight text-white">Tara</p>
              <p className="text-[11px] text-ink-500">Personal assistant</p>
            </div>
          </div>
          <button type="button" onClick={() => go('assistant')} className="mt-6 flex items-center gap-2 rounded-2xl bg-gradient-to-r from-fuchsia-500/90 to-orange-400/90 px-3.5 py-2.5 text-[13.5px] font-semibold text-on-accent shadow-lg hover:opacity-95">
            <Mic className="size-4" /> Talk to Tara
          </button>
          <nav aria-label="Tara" className="mt-5 space-y-1">
            {NAV.map((n) => {
              const Icon = n.icon
              const active = view === n.id
              return (
                <button key={n.id} type="button" onClick={() => go(n.id)} aria-current={active ? 'page' : undefined}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] transition ${active ? 'bg-white/[0.08] text-white' : 'text-ink-300 hover:bg-white/[0.04] hover:text-white'}`}>
                  <Icon className="size-4.5" /> {n.label}
                  {!!n.count && <span className="ml-auto rounded-full bg-white/[0.07] px-2 text-[11px] text-ink-300 tabular-nums">{n.count}</span>}
                </button>
              )
            })}
          </nav>
          <div className="mt-auto space-y-1">
            <button type="button" onClick={() => openSettings(true)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] text-ink-300 hover:bg-white/[0.04] hover:text-white"><Settings2 className="size-4.5" /> Voice & personality</button>
            {status && (
              <p className="flex items-center gap-2 px-3 py-1 text-[11.5px] text-ink-500">
                <span className={`size-1.5 rounded-full ${offline ? 'bg-rose-400' : 'bg-emerald-400'}`} /> {offline ? 'Offline' : `Online · ${status.llm_provider}`}{status.protected ? ' · protected' : ''}
              </p>
            )}
            <div className="space-y-2 border-t border-white/[0.06] px-2 pt-3">
              <ThemeToggle compact className="w-full justify-between" />
              <Link to="/" className="flex h-8 items-center gap-1.5 rounded-lg px-1 text-[12px] text-ink-400 hover:text-white"><LayoutGrid className="size-3.5" /> All products</Link>
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Top bar (phones) */}
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2.5 border-b border-white/[0.06] bg-ink-950/70 px-4 backdrop-blur-xl lg:hidden">
            <Link to="/" aria-label="All products" className="grid size-8 place-items-center rounded-lg border border-white/[0.06] text-ink-300"><LayoutGrid className="size-4" /></Link>
            <span className="grid size-8 place-items-center rounded-xl bg-gradient-to-br from-fuchsia-500 via-pink-500 to-orange-400 text-on-accent"><Sparkles className="size-4" /></span>
            <p className="text-[15px] font-semibold text-white">Tara</p>
            {offline && <span className="flex items-center gap-1 rounded-lg bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-300"><WifiOff className="size-3" /> Offline</span>}
            <div className="ml-auto flex items-center gap-1.5">
              <ThemeToggle compact />
            </div>
          </header>

          {needKey ? (
            <KeyGate onUnlock={boot} />
          ) : (
            <>
              {/* The assistant stays mounted, so the conversation survives a look at Today or Saved. */}
              <div className={view === 'assistant' ? 'w-full flex-1 px-4 pb-16 lg:px-10 lg:pb-0' : 'hidden'}>
                <AssistantBoundary>
                  <Assistant
                    agenda={agenda}
                    onChanged={() => void refresh()}
                    onOpen={(kind) => { if (kind === 'today') go('today'); else { setModule(kind); setView('saved') } }}
                    onScan={(p) => void startScan(p)}
                    onError={handle}
                    settingsOpen={settings}
                    onWake={() => setView('assistant')}
                    onSettings={openSettings}
                  />
                </AssistantBoundary>
              </div>
              {view !== 'assistant' && (
          <div className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-[minmax(0,1fr)] gap-6 px-4 py-5 lg:grid-cols-[210px_minmax(0,1fr)] lg:px-8 lg:py-8">
            {/* Module rail (desktop) / chip strip (mobile) */}
            <nav aria-label="Keeper sections" className="lg:sticky lg:top-22 lg:self-start">
              <ul className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:px-0">
                {MODULES.map((m) => {
                  const Icon = m.icon
                  const active = m.id === module
                  return (
                    <li key={m.id} className="shrink-0">
                      <button
                        type="button"
                        onClick={() => setModule(m.id)}
                        aria-current={active ? 'page' : undefined}
                        className={`relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] transition-colors ${
                          active ? 'text-white' : 'text-ink-300 hover:text-white'
                        }`}
                      >
                        {active && (
                          <motion.span
                            layoutId="keeper-rail"
                            className="absolute inset-0 rounded-xl bg-white/[0.07] ring-1 ring-white/10"
                            transition={{ type: 'spring', stiffness: 450, damping: 36 }}
                          />
                        )}
                        <span className={`relative grid size-6 place-items-center rounded-lg ${m.tint}`}>
                          <Icon className="size-3.5" />
                        </span>
                        <span className="relative font-medium whitespace-nowrap">{m.label}</span>
                        {!!counts[m.id] && (
                          <span className="relative ml-auto rounded-full bg-white/[0.06] px-1.5 text-[10.5px] text-ink-300 tabular-nums">
                            {counts[m.id]}
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </nav>

            <main className="min-w-0 space-y-5 pb-44 lg:pb-8">
              <div className="fixed inset-x-0 bottom-16 z-20 border-t border-white/[0.06] bg-ink-950/80 p-3 backdrop-blur-xl lg:static lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
                <Capture
                  busy={busy}
                  placeholder="Tell me anything… “passport, top drawer”"
                  onSubmit={(i) => void send(i)}
                  onScan={(p) => void startScan(p)}
                  examples={examples}
                />
              </div>

              <AnimatePresence mode="wait">{turn && <TurnCard key={turn.id} turn={turn} />}</AnimatePresence>

              <motion.section key={module} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
                {module === 'today' ? (
                  <TodayView
                    brief={brief}
                    briefLoading={briefLoading}
                    onRefreshBrief={() => void loadBrief()}
                    agenda={agenda}
                    onDone={(item) => void mutate(() => keeperApi.done(item.entry.id), 'Done ✓')}
                    telegram={!!status?.telegram}
                    onSendTelegram={() => void mutate(() => keeperApi.sendBrief(), 'Brief sent to Telegram')}
                    notifications={perm}
                    onEnableNotifications={() => void Notification.requestPermission().then(setPerm)}
                  />
                ) : null}
                {module === 'today' ? (
                  <div className="mt-5">
                    <ReminderSettingsCard onToast={setToast} />
                  </div>
                ) : (
                  <>
                    <div className="mb-3 flex items-end justify-between gap-3">
                      <div>
                        <h1 className="text-xl font-semibold tracking-tight text-white">{meta.label}</h1>
                        <p className="mt-0.5 text-[12.5px] text-ink-400">
                          Try: <span className="text-ink-300">“{meta.example}”</span>
                        </p>
                      </div>
                      <span className="text-[12px] text-ink-500 tabular-nums">{visible.length} saved</span>
                    </div>
                    {visible.length === 0 ? (
                      <EmptyState label={meta.label} example={meta.example} />
                    ) : (
                      <ul className="grid gap-2.5 xl:grid-cols-2">
                        <AnimatePresence initial={false}>
                          {visible.map((e) => (
                            <EntryCard
                              key={e.id}
                              entry={e}
                              onDone={(x) => void mutate(() => keeperApi.done(x.id), `${moduleOf(x.kind).doneLabel ?? 'Done'} ✓`)}
                              onUsed={(x) => void mutate(() => keeperApi.used(x.id), 'Marked as used today')}
                              onDelete={(x) => void mutate(() => keeperApi.remove(x.id), `Deleted ${x.title}`)}
                            />
                          ))}
                        </AnimatePresence>
                      </ul>
                    )}
                  </>
                )}
              </motion.section>
            </main>
          </div>
              )}
            </>
          )}

          {/* Tab bar (phones) */}
          <nav aria-label="Tara" className="fixed inset-x-0 bottom-0 z-30 grid h-16 grid-cols-4 border-t border-white/[0.06] bg-ink-950/90 backdrop-blur-xl lg:hidden">
            {[...NAV, { id: 'settings', label: 'Settings', icon: Settings2 }].map((n) => {
              const Icon = n.icon
              const active = n.id === view
              return (
                <button key={n.id} type="button" onClick={() => (n.id === 'settings' ? openSettings(true) : go(n.id))} aria-current={active ? 'page' : undefined}
                  className={`flex flex-col items-center justify-center gap-1 text-[11px] ${active ? 'text-white' : 'text-ink-500'}`}>
                  <span className={`grid h-7 w-12 place-items-center rounded-full ${active ? 'bg-white/[0.1]' : ''}`}><Icon className="size-4.5" /></span>
                  {n.label}
                </button>
              )
            })}
          </nav>
        </div>
      </div>

      <ScanSheet scan={scan} onClose={() => setScan(null)} onSave={saveScan} />

      <AlarmBanner alerts={alarms.active} onResolve={(a, action) => void alarms.resolve(a, action).catch(handle)} />

      <AnimatePresence>
        {toast && (
          <motion.div
            role="status"
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8 }}
            className="glass fixed bottom-28 left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-[13px] text-white lg:bottom-8"
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  )
}

function TurnCard({ turn }) {
  const r = turn.result
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ type: 'spring', stiffness: 400, damping: 34 }}
      className="rounded-2xl border border-white/[0.07] bg-ink-900/70 p-4"
      aria-live="polite"
    >
      <p className="text-[12.5px] text-ink-400">
        You: <span className="text-ink-200">{turn.text}</span>
      </p>
      {turn.error ? (
        <p className="mt-2 text-[14px] text-rose-300">{turn.error}</p>
      ) : !r ? (
        <div className="mt-2 flex items-center gap-1.5" aria-label="Thinking">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="size-1.5 rounded-full bg-pink-400"
              animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0] }}
              transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }}
            />
          ))}
        </div>
      ) : (
        <>
          <p className="mt-1.5 text-[15px] leading-relaxed text-white">{r.reply}</p>
          <ol className="mt-3 flex flex-wrap items-center gap-1.5" aria-label="How Keeper handled this">
            <RouteIcon className="size-3.5 text-ink-500" />
            {r.trace.map((s, i) => (
              <motion.li
                key={s.node}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.08 * i }}
                className="flex items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] px-2 py-0.5 text-[11px] text-ink-300"
                title={s.detail}
              >
                <span className="font-medium text-ink-100">{s.node}</span>
                <span className="text-ink-500">{s.detail}</span>
                <span className="font-mono text-ink-500">{s.ms}ms</span>
              </motion.li>
            ))}
          </ol>
        </>
      )}
    </motion.div>
  )
}

function EmptyState({ label, example }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 p-10 text-center">
      <p className="text-[15px] font-medium text-white">Nothing in {label} yet</p>
      <p className="mt-1 text-[13px] text-ink-400">
        Type, say or snap it. For example: <span className="text-ink-200">“{example}”</span>
      </p>
    </div>
  )
}

function KeyGate({ onUnlock }) {
  const [key, setKey] = useState('')
  return (
    <div className="grid flex-1 place-items-center p-6">
      <form
        className="glass w-full max-w-sm rounded-3xl p-6"
        onSubmit={(e) => {
          e.preventDefault()
          setAccessKey(key.trim())
          onUnlock()
        }}
      >
        <KeyRound className="size-6 text-pink-300" />
        <h1 className="mt-3 text-lg font-semibold text-white">This Keeper is private</h1>
        <p className="mt-1 text-[13px] text-ink-400">Enter the access key set in KEEPER_ACCESS_KEY. It's stored only in this browser.</p>
        <input
          type="password"
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-label="Access key"
          className="mt-4 w-full rounded-xl border border-white/10 bg-ink-900/70 px-3 py-2.5 text-white outline-none focus:border-pink-400/50"
        />
        <button
          type="submit"
          className="btn-primary mt-3 w-full rounded-xl bg-gradient-to-r from-fuchsia-500 via-pink-500 to-orange-400 py-2.5 text-[14px] font-semibold text-on-accent"
        >
          Unlock
        </button>
        <Link to="/" className="mt-4 flex items-center justify-center gap-1.5 text-[12.5px] text-ink-400 hover:text-white">
          <ArrowLeft className="size-3.5" /> Back to products
        </Link>
      </form>
    </div>
  )
}
