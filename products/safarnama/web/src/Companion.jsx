/** Travel companion: answers from the real trip context; every suggested action needs a tap to confirm. */
import { Bot, Clock, ExternalLink, LocateFixed, MapPin, Plus, Send, Bookmark } from 'lucide-react'
import { useState } from 'react'
import { currentPosition } from '@appcore/web/device'
import { errorText } from '@appcore/web/http'
import { Answer, Button, Card, ErrorNote, inputClass, Pill, Spinner } from '@appcore/web/ui'
import { localIso, placeToSaved, placeToStop } from './logic'
import { Handoff } from './parts'

const PROMPTS = ['What should we do nearby right now?', 'Rain is coming, how should we adjust today?', 'Find lunch near our next stop', 'Where can we buy local souvenirs today?']

export function Companion({ trip, api, onTrip, setNote, onPins }) {
  const [message, setMessage] = useState('')
  const [shareLocation, setShareLocation] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [last, setLast] = useState(null)
  const [handoff, setHandoff] = useState(null)
  const [done, setDone] = useState({})
  const history = (trip.companion ?? []).slice(0, last ? -2 : undefined) // the latest exchange is shown above

  const ask = async (text = message) => {
    if (text.trim().length < 2) return
    setBusy(true)
    setError(null)
    try {
      const body = { message: text.trim(), local_time: localIso() }
      if (shareLocation) {
        const pos = await currentPosition()
        if (pos) Object.assign(body, pos)
        else setNote("Location wasn't available, so the companion used your itinerary instead.")
      }
      const out = await api.companion(body)
      setLast(out)
      setMessage('')
      onPins(out.suggestions.filter((s) => s.place).map((s) => s.place))
      onTrip(await api.get())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const act = async (s, i) => {
    try {
      if (s.action === 'add_stop') {
        onTrip(await api.addStop(s.day, placeToStop(s.place, { time: s.time ?? '12:00', near: s.route?.from, added: 'companion' })))
        setNote(`${s.place.name} added to day ${s.day}.`)
      } else if (s.action === 'save_place') {
        await api.savePlace(placeToSaved(s.place))
        setNote(`Saved ${s.place.name}.`)
      } else if (s.action === 'move_earlier') {
        onTrip(await api.editActivity(s.activity_id, { time: s.time }))
        setNote(`${s.activity} moved to ${s.time}; the day was re-timed and re-checked.`)
      } else if (s.action === 'open_link') {
        return setHandoff({ link: s.link, place: s.place })
      }
      setDone((d) => ({ ...d, [i]: true }))
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><Bot className="pa-ink size-4" /> Travel companion</p>
        <p className="mt-1 text-[12.5px] text-ink-400">
          Answers from your itinerary, local time, stored forecast, budget, bookings and real nearby places. It never books, orders or pays: you confirm every change.
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {PROMPTS.map((p) => <button key={p} type="button" className="chip" disabled={busy} onClick={() => void ask(p)}>{p}</button>)}
        </div>
        <div className="mt-2 flex gap-2">
          <input className={inputClass} value={message} maxLength={800} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void ask()} placeholder="Ask about your trip…" />
          <Button accent="from-lime-500 to-teal-500" onClick={() => void ask()} busy={busy} disabled={message.trim().length < 2}><Send className="size-4" /></Button>
        </div>
        <label className="mt-2 flex items-center gap-2 text-[12.5px] text-ink-300">
          <input type="checkbox" checked={shareLocation} onChange={(e) => setShareLocation(e.target.checked)} />
          <LocateFixed className="size-3.5" /> Use my current location for this question (asks your browser's permission; never stored)
        </label>
      </Card>
      <ErrorNote message={error} />
      {busy && <Spinner label="Checking your trip, the forecast and nearby places…" />}
      {last && (
        <Card>
          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-500">
            <Pill tone="info">AI-generated</Pill>
            <span><Clock className="inline size-3" /> {last.context.now.local_time} · near {last.context.near}</span>
            {last.context.forecast_age_hours != null && <span>· forecast from {last.context.forecast_age_hours} h ago</span>}
            <span>· {last.context.candidates} real places considered</span>
          </div>
          <div className="mt-2"><Answer text={last.reply} /></div>
          {last.suggestions.length > 0 && (
            <ul className="mt-3 space-y-2">
              {last.suggestions.map((s, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.07] p-2.5 text-[13px]">
                  <div className="min-w-0 flex-1">
                    <p className="text-white">
                      {s.action === 'add_stop' && <>Add <b>{s.place.name}</b> to day {s.day}{s.time ? ` at ${s.time}` : ''}</>}
                      {s.action === 'save_place' && <>Save <b>{s.place.name}</b></>}
                      {s.action === 'move_earlier' && <>Move <b>{s.activity}</b> from {s.from_time} to {s.time}</>}
                      {s.action === 'open_link' && <>Open <b>{s.place.name}</b>'s site ({s.link.label})</>}
                    </p>
                    <p className="text-[12px] text-ink-400">
                      {s.why}
                      {s.route && <> · <MapPin className="inline size-3" /> ~{s.route.km} km from {s.route.from}, about {s.route.walk_min} min on foot (estimate)</>}
                    </p>
                  </div>
                  {done[i] ? <Pill tone="good">done</Pill> : (
                    <button type="button" className="chip !bg-emerald-500/15 !text-emerald-200" onClick={() => void act(s, i)}>
                      {s.action === 'open_link' ? <ExternalLink className="size-3" /> : s.action === 'save_place' ? <Bookmark className="size-3" /> : <Plus className="size-3" />}
                      {s.action === 'open_link' ? 'Review hand-off' : 'Confirm'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {history.length > 0 && (
        <Card>
          <p className="text-[12px] font-semibold tracking-wide text-ink-400 uppercase">Earlier</p>
          <ol className="mt-2 space-y-2">
            {history.slice(-10).reverse().map((m, i) => (
              <li key={i} className="text-[12.5px]">
                <span className={m.role === 'user' ? 'text-white' : 'text-ink-300'}>{m.role === 'user' ? 'You: ' : 'Companion: '}</span>
                <span className="text-ink-300">{m.text}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}
      {handoff && <Handoff link={handoff.link} place={handoff.place} onClose={() => setHandoff(null)} onSave={() => void api.savePlace(placeToSaved(handoff.place))} />}
    </div>
  )
}
