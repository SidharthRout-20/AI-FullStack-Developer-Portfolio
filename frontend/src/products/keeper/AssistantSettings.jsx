/** "Make Tara yours": voice, speed, language, name, personality and how it listens. One sheet, saved on this device. */
import { Play, RotateCcw, X } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { DEFAULTS, LANGUAGES } from './prefs'
import { STYLES } from './ambient'
import { canSpeak, hearingMode, say, useVoices, wakeSupported } from './voice'

const field = 'w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[14px] text-white focus:border-white/25 focus:outline-none'

function Segmented({ value, options, onChange, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-xl border border-white/10 bg-white/[0.03] p-0.5">
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${value === v ? 'bg-white/[0.12] text-white' : 'text-ink-400 hover:text-white'}`}>
          {text}
        </button>
      ))}
    </div>
  )
}

function Row({ title, hint, children }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[13px] font-semibold text-ink-200">{title}{hint && <span className="ml-1.5 font-normal text-ink-500">{hint}</span>}</p>
      {children}
    </div>
  )
}

function Toggle({ checked, onChange, children }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl px-1 py-1.5 text-[14px] text-ink-200">
      <span>{children}</span>
      <input type="checkbox" className="size-4 accent-pink-500" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

export function AssistantSettings({ prefs, onChange, onClose }) {
  const voices = useVoices()
  const set = (k) => (v) => onChange({ ...prefs, [k]: v })
  const lang = prefs.lang || (typeof navigator !== 'undefined' ? navigator.language : 'en')
  // Voices for the chosen language first, then the rest.
  const sorted = useMemo(() => {
    const base = lang.split('-')[0].toLowerCase()
    const mine = voices.filter((v) => v.lang?.toLowerCase().startsWith(base))
    return [...mine, ...voices.filter((v) => !mine.includes(v))]
  }, [voices, lang])

  useEffect(() => {
    const close = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])

  const preview = () => void say(`Hi${prefs.name.trim() ? ` ${prefs.name.trim()}` : ''}! I'm Tara. This is how I'll sound.`, prefs)

  return (
    <div className="fixed inset-0 z-50 grid place-items-end bg-black/50 backdrop-blur-sm sm:place-items-center sm:p-6" role="dialog" aria-modal="true" aria-label="Make Tara yours" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-white/10 bg-ink-900 shadow-2xl sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-white/[0.07] px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-[17px] font-semibold text-white">Make Tara yours</p>
            <p className="text-[12px] text-ink-500">Saved on this device.</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="grid size-8 place-items-center rounded-full text-ink-400 hover:bg-white/[0.06] hover:text-white"><X className="size-4" /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <section className="space-y-4">
            <p className="text-[11.5px] font-semibold tracking-[0.14em] text-ink-500 uppercase">About you</p>
            <Row title="What should I call you?" hint="optional">
              <input className={field} value={prefs.name} maxLength={40} onChange={(e) => set('name')(e.target.value)} placeholder="Your first name" />
            </Row>
            <Row title="Home city" hint="for weather and local news">
              <input className={field} value={prefs.city} maxLength={80} onChange={(e) => set('city')(e.target.value)} placeholder="e.g. Bengaluru" />
            </Row>
            <Toggle checked={prefs.useLocation} onChange={set('useLocation')}>Use this device's location for weather and directions</Toggle>
            <Row title="Personality">
              <Segmented label="Personality" value={prefs.tone} onChange={set('tone')} options={[['warm', 'Warm'], ['professional', 'Professional'], ['cheerful', 'Cheerful']]} />
            </Row>
            <Row title="Answers">
              <Segmented label="Answer length" value={prefs.length} onChange={set('length')} options={[['short', 'Short'], ['detailed', 'Detailed']]} />
            </Row>
          </section>

          {canSpeak() && (
            <section className="space-y-4">
              <p className="text-[11.5px] font-semibold tracking-[0.14em] text-ink-500 uppercase">Voice</p>
              <Row title="Language" hint="for listening and speaking">
                <select className={field} value={prefs.lang} onChange={(e) => onChange({ ...prefs, lang: e.target.value, voice: '' })}>
                  {LANGUAGES.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
                </select>
              </Row>
              <Row title="Voice" hint={voices.length ? `${voices.length} on this device` : 'loading…'}>
                <div className="flex gap-2">
                  <select className={field} value={prefs.voice} onChange={(e) => set('voice')(e.target.value)}>
                    <option value="">Device default</option>
                    {sorted.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}
                  </select>
                  <button type="button" onClick={preview} className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-br from-fuchsia-500 to-orange-400 px-3 text-[13px] font-semibold text-on-accent"><Play className="size-3.5" /> Hear it</button>
                </div>
              </Row>
              <Row title="Speed" hint={`${prefs.rate.toFixed(2)}×`}>
                <input type="range" min="0.7" max="1.5" step="0.05" value={prefs.rate} onChange={(e) => set('rate')(Number(e.target.value))} className="w-full accent-pink-500" aria-label="Speaking speed" />
              </Row>
              <Row title="Pitch" hint={prefs.pitch === 1 ? 'natural' : prefs.pitch < 1 ? 'deeper' : 'higher'}>
                <input type="range" min="0.7" max="1.4" step="0.05" value={prefs.pitch} onChange={(e) => set('pitch')(Number(e.target.value))} className="w-full accent-pink-500" aria-label="Voice pitch" />
              </Row>
            </section>
          )}

          <section className="space-y-1">
            <p className="mb-2 text-[11.5px] font-semibold tracking-[0.14em] text-ink-500 uppercase">How it behaves</p>
            {canSpeak() && <Toggle checked={prefs.speak} onChange={set('speak')}>Read replies aloud</Toggle>}
            {wakeSupported() && <Toggle checked={prefs.wake} onChange={set('wake')}>Answer to “Hey Tara” while this page is open (your browser's speech service listens for it; Tara only gets what you say after it)</Toggle>}
            {hearingMode() && <Toggle checked={prefs.keep} onChange={set('keep')}>After a spoken answer, listen for a follow-up, so you can keep talking (say “that's all” to stop)</Toggle>}
            <Toggle checked={prefs.sounds} onChange={set('sounds')}>Chime when I start and stop listening</Toggle>
            {canSpeak() && <Toggle checked={prefs.briefOnOpen} onChange={set('briefOnOpen')}>Brief me when I open Tara: the time, the weather and what's due</Toggle>}
          </section>

          <section className="space-y-4">
            <p className="text-[11.5px] font-semibold tracking-[0.14em] text-ink-500 uppercase">Background music</p>
            <Toggle checked={prefs.music} onChange={set('music')}>Play slow, soothing music while Tara is open (it goes quiet while I listen)</Toggle>
            <Row title="Sound">
              <select className={field} value={prefs.musicStyle} onChange={(e) => set('musicStyle')(e.target.value)}>
                {STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </Row>
            <Row title="Volume" hint={`${Math.round(prefs.musicVolume * 100)}%`}>
              <input type="range" min="0.05" max="1" step="0.05" value={prefs.musicVolume} onChange={(e) => set('musicVolume')(Number(e.target.value))} className="w-full accent-pink-500" aria-label="Music volume" />
            </Row>
            <p className="text-[12px] text-ink-500">Made live in your browser, so nothing is downloaded and it never repeats exactly. “Match the weather” plays rain when it rains and a night sky after dark.</p>
          </section>
        </div>

        <div className="flex items-center gap-2 border-t border-white/[0.07] px-5 py-3">
          <button type="button" onClick={() => onChange({ ...DEFAULTS })} className="inline-flex items-center gap-1.5 text-[13px] text-ink-400 hover:text-white"><RotateCcw className="size-3.5" /> Reset</button>
          <button type="button" onClick={onClose} className="ml-auto rounded-xl bg-white/[0.1] px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-white/[0.15]">Done</button>
        </div>
      </div>
    </div>
  )
}
