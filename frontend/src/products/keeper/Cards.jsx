/**
 * Rich answers: what Tara looked up (weather, news, a fact, a rate, the time) and what it prepared for this device
 * (open, call, message, email, a timer). Each card says where its information came from.
 */
import { AlarmClock, ArrowUpRight, Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, Droplets, Globe, IndianRupee, Mail, MessageCircle, Newspaper, Phone, Sun, Wind, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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

export function LookupCard({ card }) {
  if (!card) return null
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
