import { AlarmClock, BellRing, CircleAlert, LoaderCircle, RefreshCw, Send, Sparkles, Volume2, VolumeX } from 'lucide-react'
import { motion } from 'motion/react'
import { useState } from 'react'
import { speak, stopSpeaking } from '@appcore/web/device'
import { moduleOf } from './modules'

const BUCKETS = [
  { id: 'overdue', label: 'Overdue', icon: CircleAlert, tone: 'text-rose-300' },
  { id: 'today', label: 'Today', icon: AlarmClock, tone: 'text-amber-300' },
  { id: 'soon', label: 'Coming up', icon: BellRing, tone: 'text-sky-300' },
  { id: 'nudge', label: 'Worth a look', icon: Sparkles, tone: 'text-violet-300' },
]

export function TodayView({
  brief,
  briefLoading,
  onRefreshBrief,
  agenda,
  onDone,
  telegram,
  onSendTelegram,
  notifications,
  onEnableNotifications,
}) {
  const [speaking, setSpeaking] = useState(false)
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  return (
    <div className="space-y-5">
      {/* Daily brief */}
      <section className="relative overflow-hidden rounded-3xl border border-white/[0.07] bg-gradient-to-br from-fuchsia-500/[0.12] via-pink-500/[0.06] to-orange-400/[0.10] p-5">
        <div className="pointer-events-none absolute -top-16 -right-10 size-48 rounded-full bg-pink-500/20 blur-3xl" />
        <div className="relative flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.16em] text-pink-300 uppercase">Daily brief</p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-white">{greeting}</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="chip"
              onClick={() => {
                if (speaking) {
                  stopSpeaking()
                  setSpeaking(false)
                } else if (brief) {
                  speak(brief.text)
                  setSpeaking(true)
                  window.setTimeout(() => setSpeaking(false), Math.min(30_000, brief.text.length * 70))
                }
              }}
              disabled={!brief}
              aria-label={speaking ? 'Stop reading' : 'Read aloud'}
            >
              {speaking ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
              <span className="hidden sm:inline">{speaking ? 'Stop' : 'Read aloud'}</span>
            </button>
            <button type="button" className="chip" onClick={onRefreshBrief} aria-label="Refresh brief" disabled={briefLoading}>
              <RefreshCw className={`size-3.5 ${briefLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
        <div className="relative mt-3 min-h-12 text-[15px] leading-relaxed text-ink-100">
          {brief ? (
            <motion.p key={brief.text} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
              {brief.text}
            </motion.p>
          ) : (
            <p className="flex items-center gap-2 text-ink-400">
              <LoaderCircle className="size-4 animate-spin" /> Putting your day together…
            </p>
          )}
        </div>
        <div className="relative mt-4 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-400">
          {brief && <span>{brief.source === 'llm' ? 'Written by the LLM from your agenda' : 'Offline summary (LLM unavailable)'}</span>}
          <span className="flex-1" />
          {notifications !== 'unsupported' && notifications !== 'granted' && (
            <button type="button" className="chip" onClick={onEnableNotifications}>
              <BellRing className="size-3.5" /> Enable reminders
            </button>
          )}
          {notifications === 'granted' && <span className="text-emerald-300">Reminders on</span>}
          {telegram && (
            <button type="button" className="chip" onClick={onSendTelegram}>
              <Send className="size-3.5" /> Send to Telegram
            </button>
          )}
        </div>
      </section>

      {/* Agenda */}
      {agenda.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center">
          <p className="text-[15px] font-medium text-white">Nothing needs you right now</p>
          <p className="mt-1 text-[13px] text-ink-400">Expiries, bills, birthdays, services and doses will show up here before they're due.</p>
        </div>
      ) : (
        BUCKETS.map(({ id, label, icon: Icon, tone }) => {
          const items = agenda.filter((a) => a.bucket === id)
          if (!items.length) return null
          return (
            <section key={id}>
              <h3 className={`mb-2 flex items-center gap-2 text-[12px] font-semibold tracking-wide uppercase ${tone}`}>
                <Icon className="size-3.5" /> {label} <span className="text-ink-500">{items.length}</span>
              </h3>
              <ul className="space-y-2">
                {items.map((item, i) => {
                  const meta = moduleOf(item.entry.kind)
                  const MIcon = meta.icon
                  return (
                    <motion.li
                      key={`${item.entry.id}-${item.bucket}`}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.03 }}
                      className="flex items-center gap-3 rounded-2xl border border-white/[0.06] bg-ink-900/60 px-3.5 py-3"
                    >
                      <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${meta.tint}`}>
                        <MIcon className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-medium text-white">{item.label}</p>
                        <p className="text-[11.5px] text-ink-400">{meta.label}</p>
                      </div>
                      {meta.doneLabel && item.bucket !== 'nudge' && (
                        <button type="button" className="chip" onClick={() => onDone(item)}>
                          {meta.doneLabel}
                        </button>
                      )}
                    </motion.li>
                  )
                })}
              </ul>
            </section>
          )
        })
      )}
    </div>
  )
}
