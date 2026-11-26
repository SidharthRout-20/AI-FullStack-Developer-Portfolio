/**
 * Rich answers: what Tara looked up (weather, news, a fact, a rate, the time) and what it prepared for this device
 * (open, call, message, email, a timer). Each card says where its information came from.
 */
import { AlarmClock, ArrowUpRight, ChevronDown, GitPullRequest, KeyRound, Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, Droplets, FileCode2, FileText, Globe, IndianRupee, Mail, MessageCircle, Newspaper, Phone, Sun, Wind, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { editsApi, getOwnerKey, setOwnerKey } from './api'
import { chime } from './voice'

const shell = 'mt-2 overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.03]'
const Source = ({ children }) => <p className="border-t border-white/[0.06] px-4 py-2 text-[11px] text-ink-500">{children}</p>

const WX = { sun: Sun, partly: CloudSun, cloud: Cloud, fog: CloudFog, drizzle: CloudDrizzle, rain: CloudRain, snow: CloudSnow, storm: CloudLightning }
const wxKey = (code) => {
  if (code == null || code === 3) return 'cloud'
  if (code <= 1) return 'sun'
  if (code === 2) return 'partly'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 57) return 'drizzle'
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain'
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow'
  if (code >= 95) return 'storm'
  return 'cloud'
}
/** A weather icon for an Open-Meteo (WMO) weather code. */
export function WeatherIcon({ code, ...props }) {
  const Icon = WX[wxKey(code)]
  return <Icon {...props} />
}

const dayName = (iso, i) => (i === 0 ? 'Today' : i === 1 ? 'Tmrw' : new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' }))

function WeatherCard({ c }) {
  return (
    <div className={shell}>
      <div className="flex items-center gap-4 bg-gradient-to-br from-sky-500/15 via-indigo-500/10 to-transparent px-4 py-4">
        <WeatherIcon code={c.code} className="size-12 text-sky-200" strokeWidth={1.5} />
        <div className="min-w-0 flex-1">
          <p className="text-[34px] leading-none font-semibold text-white tabular-nums">{c.temp}°</p>
          <p className="mt-1 text-[13px] text-ink-200 capitalize">{c.text} · feels {c.feels}°</p>
          <p className="truncate text-[12px] text-ink-400">{c.place}</p>
        </div>
        <div className="space-y-1 text-right text-[12px] text-ink-300">
          <p className="flex items-center justify-end gap-1"><Droplets className="size-3.5" /> {c.humidity}%</p>
          <p className="flex items-center justify-end gap-1"><Wind className="size-3.5" /> {c.wind} km/h</p>
        </div>
      </div>
      <ol className="grid grid-cols-4 gap-1 px-2 py-3 sm:grid-cols-7">
        {c.days.slice(0, 7).map((d, i) => {
          return (
            <li key={d.date} className={`flex flex-col items-center gap-1 rounded-xl py-1.5 text-[11.5px] ${i > 3 ? 'hidden sm:flex' : ''}`}>
              <span className="text-ink-400">{dayName(d.date, i)}</span>
              <WeatherIcon code={d.code} className="size-5 text-ink-200" />
              <span className="text-white tabular-nums">{d.max}°<span className="text-ink-500"> {d.min}°</span></span>
              {d.rain > 20 && <span className="text-sky-300">{d.rain}%</span>}
            </li>
          )
        })}
      </ol>
      <Source>Forecast from {c.source}</Source>
    </div>
  )
}

function NewsCard({ c }) {
  return (
    <div className={shell}>
      <p className="flex items-center gap-2 px-4 pt-3 text-[12.5px] font-semibold text-ink-200"><Newspaper className="size-4 text-amber-300" /> {c.topic ? `News about ${c.topic}` : 'Top headlines'}</p>
      <ul className="divide-y divide-white/[0.05] px-2 py-1">
        {c.items.map((n) => (
          <li key={n.link}>
            <a href={n.link} target="_blank" rel="noopener noreferrer" className="group flex items-start gap-3 rounded-xl px-2 py-2.5 hover:bg-white/[0.03]">
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] leading-snug text-white group-hover:underline">{n.title}</span>
                <span className="text-[11.5px] text-ink-500">{n.source}</span>
              </span>
              <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-ink-500" />
            </a>
          </li>
        ))}
      </ul>
      <Source>Headlines from {c.source}; open a story to read it at the publisher.</Source>
    </div>
  )
}

function FactCard({ c }) {
  return (
    <div className={shell}>
      <div className="flex gap-3 px-4 py-3">
        {c.image && <img src={c.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-16 shrink-0 rounded-xl object-cover" />}
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-white">{c.title}</p>
          {c.description && <p className="text-[12px] text-ink-400">{c.description}</p>}
          <p className="mt-1 line-clamp-4 text-[13px] leading-relaxed text-ink-200">{c.summary}</p>
        </div>
      </div>
      <Source>
        From {c.source}
        {c.link && <> · <a href={c.link} target="_blank" rel="noopener noreferrer" className="underline hover:text-white">read more</a></>}
      </Source>
    </div>
  )
}

function CurrencyCard({ c }) {
  return (
    <div className={shell}>
      <div className="flex items-center gap-3 px-4 py-4">
        <span className="grid size-10 place-items-center rounded-xl bg-emerald-400/15 text-emerald-300"><IndianRupee className="size-5" /></span>
        <p className="text-[15px] text-ink-200">
          {Number(c.amount).toLocaleString()} {c.from} = <span className="text-[22px] font-semibold text-white tabular-nums">{Number(c.value).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span> {c.to}
        </p>
      </div>
      <Source>{c.source} · {c.date}</Source>
    </div>
  )
}

function TimeCard({ c }) {
  return (
    <div className={shell}>
      <div className="flex items-center gap-3 px-4 py-4">
        <Globe className="size-8 text-violet-300" strokeWidth={1.5} />
        <div>
          <p className="text-[28px] leading-none font-semibold text-white tabular-nums">{c.time}</p>
          <p className="mt-1 text-[12.5px] text-ink-400">{c.date} · {c.place}</p>
        </div>
      </div>
    </div>
  )
}

/** Where an answer about this app came from in its own code: the files and functions, with a peek at each. */
function CodeCard({ c }) {
  const [open, setOpen] = useState(null)
  return (
    <div className={shell}>
      <p className="flex items-center gap-2 px-4 pt-3 text-[12.5px] font-semibold text-ink-200"><FileCode2 className="size-4 text-emerald-300" /> Found in the code</p>
      <ul className="px-2 py-1">
        {c.hits.map((h, i) => (
          <li key={`${h.path}:${h.start}`}>
            <button type="button" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}
              className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-white/[0.03]">
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-100">{h.path}<span className="text-ink-500">:{h.start}</span></span>
              {h.symbol && !h.symbol.startsWith('(') && <span className="shrink-0 rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-[11px] text-emerald-200">{h.symbol}</span>}
              <ChevronDown className={`size-3.5 shrink-0 text-ink-500 transition ${open === i ? 'rotate-180' : ''}`} />
            </button>
            {open === i && <pre className="mx-2 mb-2 max-h-52 overflow-auto rounded-xl bg-black/30 p-3 font-mono text-[11.5px] leading-relaxed text-ink-200">{h.preview}</pre>}
          </li>
        ))}
      </ul>
      <Source>From {c.source} (read-only)</Source>
    </div>
  )
}

/** The documents an answer about the portfolio came from. */
function SourcesCard({ c }) {
  return (
    <div className={`${shell} flex flex-wrap items-center gap-2 px-4 py-3 text-[12px] text-ink-300`}>
      <FileText className="size-4 text-sky-300" /> From
      {c.items.map((s) => <span key={s} className="rounded-full border border-white/[0.08] px-2 py-0.5 text-ink-200">{s}</span>)}
    </div>
  )
}

export function LookupCard({ card }) {
  if (!card) return null
  if (card.type === 'code') return <CodeCard c={card} />
  if (card.type === 'sources') return <SourcesCard c={card} />
  if (card.type === 'weather') return <WeatherCard c={card} />
  if (card.type === 'news') return <NewsCard c={card} />
  if (card.type === 'fact') return <FactCard c={card} />
  if (card.type === 'currency') return <CurrencyCard c={card} />
  if (card.type === 'time') return <TimeCard c={card} />
  return null
}

const ACTION_ICON = { call: Phone, message: MessageCircle, email: Mail }

/** Something for this device to do. Calls, messages and emails always wait for a tap; the rest open straight away. */
export function ActionCard({ action }) {
  const tried = useRef(false)
  useEffect(() => {
    // Asked for outright ("open YouTube"): try straight away. If the browser wants a tap first, the button is there.
    if (tried.current || !action?.auto || action.type === 'timer') return
    tried.current = true
    window.open(action.url, '_blank', 'noopener,noreferrer')
  }, [action])
  if (!action) return null
  if (action.type === 'edit') return <EditCard request={action.request} />
  if (action.type === 'timer') return <TimerCard seconds={action.seconds} label={action.label} />
  const Icon = ACTION_ICON[action.type] ?? ArrowUpRight
  const sameTab = action.url.startsWith('/') || /^(tel|sms|mailto):/.test(action.url)
  return (
    <div className={`${shell} flex items-center gap-3 px-4 py-3`}>
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-fuchsia-500/25 to-orange-400/25 text-pink-200"><Icon className="size-5" /></span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-semibold text-white">{action.label}</p>
        {action.text && <p className="line-clamp-2 text-[12.5px] text-ink-300">“{action.text}”</p>}
      </div>
      <a href={action.url} target={sameTab ? undefined : '_blank'} rel="noopener noreferrer"
        className="shrink-0 rounded-full bg-gradient-to-r from-fuchsia-500 to-orange-400 px-4 py-2 text-[13px] font-semibold text-on-accent shadow-lg">
        {action.type === 'call' ? 'Call' : action.type === 'message' || action.type === 'email' ? 'Review & send' : 'Open'}
      </a>
    </div>
  )
}

/** A countdown that rings (and reads out) when it's done, as long as Tara is open. */
function TimerCard({ seconds, label }) {
  const [end] = useState(() => Date.now() + seconds * 1000)
  const [left, setLeft] = useState(seconds)
  const [stopped, setStopped] = useState(false)
  useEffect(() => {
    if (stopped) return
    const t = setInterval(() => {
      const s = Math.max(0, Math.round((end - Date.now()) / 1000))
      setLeft(s)
      if (s === 0) {
        clearInterval(t)
        chime(true)
        setTimeout(() => chime(true), 400)
        if ('Notification' in window && Notification.permission === 'granted') new Notification('Tara', { body: `${label} is done.` })
      }
    }, 250)
    return () => clearInterval(t)
  }, [end, label, stopped])
  const pct = 100 - (left / seconds) * 100
  const hh = Math.floor(left / 3600)
  const mm = Math.floor((left % 3600) / 60)
  const ss = left % 60
  return (
    <div className={`${shell} px-4 py-3`}>
      <div className="flex items-center gap-3">
        <AlarmClock className={`size-6 ${left === 0 ? 'text-emerald-300' : 'text-pink-300'}`} />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] text-ink-400">{label}</p>
          <p className="text-[26px] leading-none font-semibold text-white tabular-nums">
            {left === 0 ? 'Done' : stopped ? 'Cancelled' : `${hh ? `${hh}:` : ''}${String(mm).padStart(hh ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`}
          </p>
        </div>
        {left > 0 && !stopped && <button type="button" aria-label="Cancel timer" onClick={() => setStopped(true)} className="grid size-8 place-items-center rounded-full text-ink-400 hover:bg-white/[0.06] hover:text-white"><X className="size-4" /></button>}
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full bg-gradient-to-r from-fuchsia-500 to-orange-400 transition-[width] duration-300" style={{ width: `${stopped ? 0 : pct}%` }} /></div>
    </div>
  )
}

/**
 * A change to this site's code, as a pull request: plan it (a diff for small changes, Claude Code for bigger ones),
 * then open it on the owner's go-ahead. CI and a Claude review run on it, and only the owner can approve and merge.
 */
function EditCard({ request }) {
  const [key, setKey] = useState(getOwnerKey)
  const [draftKey, setDraftKey] = useState('')
  const [step, setStep] = useState('idle') // idle | planning | planned | opening | opened
  const [plan, setPlan] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const run = async (fn, busy, done) => {
    setError(null)
    setStep(busy)
    try {
      await fn()
      setStep(done)
    } catch (e) {
      if (e.status === 403) {
        setOwnerKey('')
        setKey('')
      }
      setError(e.message)
      setStep(busy === 'opening' ? 'planned' : 'idle')
    }
  }
  return (
    <div className={`${shell} px-4 py-3`}>
      <p className="flex items-center gap-2 text-[13px] font-semibold text-ink-100"><GitPullRequest className="size-4 text-emerald-300" /> Propose a code change</p>
      <p className="mt-1 text-[13px] text-ink-300">“{request}”</p>
      {!key ? (
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); setOwnerKey(draftKey.trim()); setKey(draftKey.trim()) }}>
          <KeyRound className="mt-2 size-4 shrink-0 text-ink-500" />
          <input type="password" value={draftKey} onChange={(e) => setDraftKey(e.target.value)} placeholder="Owner key" aria-label="Owner key" autoComplete="off"
            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-transparent px-3 py-1.5 text-[13px] text-white placeholder:text-ink-500 focus:border-white/25 focus:outline-none" />
          <button type="submit" disabled={!draftKey.trim()} className="rounded-full bg-white/10 px-3 text-[12.5px] text-white disabled:opacity-40">Unlock</button>
        </form>
      ) : step === 'idle' || step === 'planning' ? (
        <button type="button" disabled={step === 'planning'} onClick={() => void run(async () => setPlan(await editsApi.plan(request)), 'planning', 'planned')}
          className="mt-3 rounded-full bg-gradient-to-r from-fuchsia-500 to-orange-400 px-4 py-1.5 text-[13px] font-semibold text-on-accent disabled:opacity-60">
          {step === 'planning' ? 'Planning the change…' : 'Plan the change'}
        </button>
      ) : null}
      {plan && step !== 'opened' && (
        <div className="mt-3 space-y-2">
          <p className="text-[13px] text-ink-200">{plan.summary}</p>
          {plan.size === 'small' ? (
            plan.diffs.map((d) => <pre key={d.path} className="max-h-60 overflow-auto rounded-xl bg-black/30 p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre text-ink-200">{d.diff}</pre>)
          ) : (
            <p className="text-[12.5px] text-ink-400">{plan.reason} Claude Code will make it in GitHub Actions, following the repository's structure.</p>
          )}
          <button type="button" disabled={step === 'opening'} onClick={() => void run(async () => setResult(await editsApi.propose(plan)), 'opening', 'opened')}
            className="rounded-full bg-gradient-to-r from-fuchsia-500 to-orange-400 px-4 py-1.5 text-[13px] font-semibold text-on-accent disabled:opacity-60">
            {step === 'opening' ? 'Starting…' : plan.size === 'small' ? 'Open the pull request' : 'Hand it to Claude Code'}
          </button>
        </div>
      )}
      {step === 'opened' && result && (
        <p className="mt-3 text-[13px] text-emerald-300">
          Started. The pull request appears on <span className="font-mono">{result.branch}</span> in a few minutes; CI and the Claude review run on it, and you approve and merge.{' '}
          <a href={result.runs} target="_blank" rel="noopener noreferrer" className="underline">Watch the run</a>
        </p>
      )}
      {error && <p className="mt-2 text-[12.5px] text-rose-300">{error}</p>}
    </div>
  )
}
