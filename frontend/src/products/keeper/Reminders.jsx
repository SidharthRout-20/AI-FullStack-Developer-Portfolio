/**
 * Timed reminders on this device, plus the phone-delivery settings.
 *
 * While Keeper is open (or installed and in the background), due reminders chime, are read aloud and show a
 * notification, with Done / Snooze / Got it. Phones get the same reminders through free channels (ntfy push or
 * Telegram), sent by the server's scheduler even when this tab is closed.
 */
import { AlarmClock, BellRing, Check, Clock, Moon, Send, Smartphone, Volume2, VolumeX, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { keeperApi } from './api'
import { notify, speak } from '@appcore/web/device'

const SHOWN_KEY = 'keeper-alerts-shown'
const SPEAK_KEY = 'keeper-speak'
const POLL_MS = 30_000

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode: alerts may repeat after a reload, nothing else breaks */
  }
}

/** Short two-tone chime with the Web Audio API (no audio file to load). */
export function chime(urgent = false) {
  try {
    const Ctx = window.AudioContext ?? window.webkitAudioContext
    const ctx = new Ctx()
    const notes = urgent ? [880, 660, 880, 660] : [660, 880]
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const t = ctx.currentTime + i * 0.22
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.21)
    })
    window.setTimeout(() => void ctx.close(), notes.length * 220 + 300)
  } catch {
    /* audio blocked until the user interacts with the page */
  }
}

export const speakingEnabled = () => readJSON(SPEAK_KEY, true)

/** Polls the server for due reminders and raises each one once on this device. */
export function useAlarms(enabled, onChange) {
  const [active, setActive] = useState([])
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  const poll = useCallback(async () => {
    let due
    try {
      due = await keeperApi.dueAlerts()
    } catch {
      return // offline / locked: try again next round
    }
    const shown = readJSON(SHOWN_KEY, [])
    const fresh = due.filter((a) => !shown.includes(`${a.entry_id}|${a.key}`))
    for (const a of fresh) {
      const loud = !a.quiet || a.urgent
      if (loud) chime(a.urgent)
      if (loud && speakingEnabled()) window.setTimeout(() => speak(`Reminder. ${a.label}`), 700)
      void notify(a.urgent ? '⚠ Keeper reminder' : 'Keeper reminder', a.label, a.key)
    }
    if (fresh.length) writeJSON(SHOWN_KEY, [...shown, ...fresh.map((a) => `${a.entry_id}|${a.key}`)].slice(-200))
    setActive(due)
  }, [])

  useEffect(() => {
    if (!enabled) return
    const first = window.setTimeout(() => void poll(), 0) // first check right away, outside the render pass
    const t = window.setInterval(() => void poll(), POLL_MS)
    const onFocus = () => void poll()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(t)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, poll])

  const resolve = async (a, action) => {
    setActive((list) => list.filter((x) => x !== a))
    if (action === 'done') await keeperApi.done(a.entry_id)
    else if (action === 'snooze') await keeperApi.snooze(a.entry_id, 10, a.key)
    else await keeperApi.ack(a.entry_id, a.key)
    onChangeRef.current()
  }

  return { active, resolve }
}

export function AlarmBanner({ alerts, onResolve }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-40 flex flex-col items-center gap-2 px-4" aria-live="assertive">
      <AnimatePresence initial={false}>
        {alerts.slice(0, 3).map((a) => (
          <motion.div
            key={`${a.entry_id}|${a.key}`}
            layout
            initial={{ opacity: 0, y: -12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8 }}
            role="alertdialog"
            aria-label={`Reminder: ${a.label}`}
            className={`glass pointer-events-auto w-full max-w-md rounded-2xl p-3.5 ${a.urgent ? 'ring-1 ring-rose-400/50' : ''}`}
          >
            <div className="flex items-start gap-3">
              <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${a.urgent ? 'bg-rose-500/15 text-rose-300' : 'bg-amber-500/15 text-amber-300'}`}>
                <BellRing className="size-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold text-white">{a.label}</p>
                <p className="text-[11.5px] text-ink-400">
                  {new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {a.urgent ? ' · urgent' : ''}
                </p>
              </div>
              <button type="button" aria-label="Dismiss" onClick={() => onResolve(a, 'ack')} className="text-ink-500 hover:text-white">
                <X className="size-4" />
              </button>
            </div>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => onResolve(a, 'done')} className="chip flex-1 justify-center bg-emerald-500/15 text-emerald-200">
                <Check className="size-3.5" /> Done
              </button>
              <button type="button" onClick={() => onResolve(a, 'snooze')} className="chip flex-1 justify-center">
                <Clock className="size-3.5" /> Snooze 10 min
              </button>
              <button type="button" onClick={() => onResolve(a, 'ack')} className="chip flex-1 justify-center">
                Got it
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

function randomTopic() {
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  return `keeper-${Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14)}`
}

const field = 'w-full rounded-lg border border-white/10 bg-ink-950/40 px-2.5 py-1.5 text-[13px] text-white outline-none focus:border-amber-400/60'

/** Phone delivery + quiet hours + this device's sound settings. */
export function ReminderSettingsCard({ onToast }) {
  const [s, setS] = useState(null)
  const [saving, setSaving] = useState(false)
  const [speakOn, setSpeakOn] = useState(speakingEnabled)

  useEffect(() => {
    void keeperApi.reminderSettings().then(setS).catch(() => setS(null))
  }, [])

  if (!s) return null
  const set = (k, v) => setS({ ...s, [k]: v })

  const save = async (next = s, msg = 'Reminder settings saved') => {
    setSaving(true)
    try {
      setS(await keeperApi.saveReminderSettings(next))
      onToast(msg)
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    await save(s, 'Saved')
    try {
      const r = await keeperApi.testReminder()
      onToast(`Test sent to ${r.sent.join(' + ')}`)
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'Test failed')
    }
  }

  const toggleSpeak = () => {
    const next = !speakOn
    setSpeakOn(next)
    writeJSON(SPEAK_KEY, next)
    if (next) {
      chime()
      speak('Reminders will be read aloud on this device.')
    }
  }

  return (
    <section className="rounded-2xl border border-white/[0.07] bg-ink-900/60 p-4">
      <div className="flex items-center gap-2">
        <AlarmClock className="size-4 text-amber-300" />
        <h2 className="text-[14px] font-semibold text-white">Reminders</h2>
        <span className="ml-auto text-[11.5px] text-ink-500">free · no account needed</span>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-400">
        Say it with a time (“remind me to call the bank at 5pm”, “urgent: pay rent by 10am”). It alerts an hour before and on time.
      </p>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink-200">
            <Smartphone className="size-3.5" /> Phone (ntfy push)
          </p>
          <div className="flex gap-2">
            <input
              className={field}
              placeholder="your-private-topic"
              value={s.ntfy_topic ?? ''}
              onChange={(e) => set('ntfy_topic', e.target.value.trim() || null)}
              aria-label="ntfy topic"
            />
            <button type="button" className="chip shrink-0" onClick={() => set('ntfy_topic', randomTopic())}>
              Generate
            </button>
          </div>
          <p className="text-[11.5px] leading-relaxed text-ink-500">
            Install the free <a className="text-amber-300 underline" href="https://ntfy.sh/app" target="_blank" rel="noreferrer">ntfy app</a>,
            tap + and subscribe to this topic. Anyone who knows the topic can read it, so keep it random.
          </p>
          {s.telegram_configured && (
            <label className="flex items-center gap-2 text-[12.5px] text-ink-300">
              <input type="checkbox" checked={s.telegram} onChange={(e) => set('telegram', e.target.checked)} /> Also send to Telegram
            </label>
          )}
          {!s.cron_configured && (
            <p className="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] text-amber-200">
              Phone delivery needs the server scheduler: set CRON_SECRET on the backend and add a free every-minute cron.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink-200">
            <Moon className="size-3.5" /> Quiet hours &amp; follow-ups
          </p>
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-[12.5px] text-ink-300">
              <input type="checkbox" checked={s.quiet_enabled} onChange={(e) => set('quiet_enabled', e.target.checked)} />
              Quiet hours: hold non-urgent alerts
            </label>
            <div className="flex items-center gap-2 pl-6 text-[12.5px] text-ink-400">
              <input type="time" aria-label="Quiet from" className={`${field} !w-32`} value={s.quiet_start} disabled={!s.quiet_enabled} onChange={(e) => set('quiet_start', e.target.value)} />
              to
              <input type="time" aria-label="Quiet until" className={`${field} !w-32`} value={s.quiet_end} disabled={!s.quiet_enabled} onChange={(e) => set('quiet_end', e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-[12.5px] whitespace-nowrap text-ink-300">
            Re-send if not acknowledged after
            <select className={`${field} !w-28`} value={s.escalate_min} onChange={(e) => set('escalate_min', Number(e.target.value))}>
              {[0, 5, 10, 15, 30, 60].map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? 'never' : `${m} min`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-[12.5px] whitespace-nowrap text-ink-300">
            <input type="checkbox" checked={s.brief_push} onChange={(e) => set('brief_push', e.target.checked)} />
            Morning brief to phone at
            <select className={`${field} !w-28`} value={s.brief_hour} onChange={(e) => set('brief_hour', Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={toggleSpeak} className="chip">
            {speakOn ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
            {speakOn ? 'Reading reminders aloud on this device' : 'Silent on this device (notification only)'}
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" disabled={saving} onClick={() => void save()} className="chip bg-amber-500/15 text-amber-100">
          <Check className="size-3.5" /> Save
        </button>
        <button type="button" disabled={saving || !(s.ntfy_topic || (s.telegram && s.telegram_configured))} onClick={() => void test()} className="chip">
          <Send className="size-3.5" /> Send a test to my phone
        </button>
      </div>
    </section>
  )
}
