/**
 * Control room (owner only): the AI provider (free tier or a paid model within a monthly budget), which products are
 * open, and Tara's switches. API keys are never typed here: they live in the server's environment, and this page only
 * shows whether each is set. Every change is checked by the server and recorded in the history below.
 */
import { ArrowLeft, Check, KeyRound, LoaderCircle, RotateCcw, Save, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from '@appcore/web/router'
import { API_BASE } from '../lib/apiBase'
import { setIgnored } from '../lib/visits'
import { getOwnerKey, setOwnerKey } from '../products/keeper/api'
import { SiteHeader } from './HubPage'

const TARA = [
  ['lookups', 'Look-ups', 'Weather, news, facts and exchange rates (calls to outside services).'],
  ['product_handoff', 'Products first', "Hand trips, codebases and failing builds to the site's own products before answering."],
  ['code_proposals', 'Code proposals', 'Your code change requests to Tara (still owner-only, and still reviewed before merge).'],
]
const PRODUCT_NOTE = 'A paused product answers "paused by the site owner" instead of working; nothing is deleted.'

const detail = (d) => (Array.isArray(d) ? d.map((x) => x.msg?.replace(/^Value error, /, '')).join('; ') : d)

async function call(method, key, body) {
  const res = await fetch(`${API_BASE}/api/control`, {
    method,
    headers: { 'X-Tara-Owner-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 404) throw Object.assign(new Error("This backend doesn't have the control room yet (an older deployment)."), { status: 404 })
  const d = await res.json().catch(() => null)
  if (!res.ok) throw Object.assign(new Error(detail(d?.detail) ?? `Request failed (${res.status})`), { status: res.status })
  return d
}

export function ControlPage() {
  const [key, setKey] = useState(getOwnerKey)
  const [data, setData] = useState(null)
  const [draft, setDraft] = useState(null)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(null)

  useEffect(() => {
    if (!key) return
    let live = true
    call('GET', key)
      .then((d) => live && (setData(d), setDraft(d.config), setError(null)))
      .catch((e) => live && setError(e))
    return () => {
      live = false
    }
  }, [key])

  const dirty = useMemo(() => data && draft && JSON.stringify(data.config) !== JSON.stringify(draft), [data, draft])
  const set = (path, value) =>
    setDraft((d) => {
      const [a, b] = path.split('.')
      return b ? { ...d, [a]: { ...d[a], [b]: value } } : { ...d, [a]: value }
    })

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const d = await call('PUT', key, draft)
      setData(d)
      setDraft(d.config)
      setSaved(d.changed?.length ?? 0)
    } catch (e) {
      setError(e)
    } finally {
      setSaving(false)
    }
  }

  const locked = !key || error?.status === 403
  return (
    <div className="min-h-full">
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-4 pt-26 pb-20 sm:px-5 sm:pt-30">
        <div className="flex flex-wrap items-center gap-4 text-[13px]">
          <Link to="/" className="inline-flex items-center gap-1.5 text-ink-400 hover:text-white"><ArrowLeft className="size-4" /> Home</Link>
          <Link to="/insights" className="text-ink-400 hover:text-white">Insights</Link>
          <Link to="/quality" className="text-ink-400 hover:text-white">Quality</Link>
        </div>
        <header className="mt-4">
          <p className="text-[12px] font-semibold tracking-[0.18em] text-cyan-300 uppercase">Control room · owner only</p>
          <h1 className="mt-2 text-[32px] leading-tight font-semibold text-white sm:text-[42px]">Settings for the whole site.</h1>
          <p className="mt-3 max-w-2xl text-[15px] text-ink-300">The AI provider, which products are open, and how Tara behaves. Keys and security settings stay on the server; every change here is checked and recorded.</p>
        </header>

        {locked ? (
          <KeyForm wrong={error?.status === 403} onUnlock={(k) => (setOwnerKey(k), setIgnored(true), setKey(k))} />
        ) : !draft ? (
          error ? <Alert>{error.message}</Alert> : <LoaderCircle className="mt-10 size-5 animate-spin text-ink-400" aria-label="Loading" />
        ) : (
          <>
            <Provider draft={draft} data={data} set={set} />
            <Panel title="Products" note={PRODUCT_NOTE}>
              <div className="grid gap-2 sm:grid-cols-2">
                {data.options.products.map((p) => (
                  <Toggle key={p.id} label={p.name} hint={draft.products[p.id] ? 'Open' : 'Paused'} on={draft.products[p.id]} onChange={(v) => set('products', { ...draft.products, [p.id]: v })} />
                ))}
              </div>
            </Panel>
            <Panel title="Tara">
              <div className="grid gap-2 sm:grid-cols-2">
                {TARA.map(([k, label, hint]) => <Toggle key={k} label={label} hint={hint} on={draft.tara[k]} onChange={(v) => set(`tara.${k}`, v)} />)}
                <label className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
                  <span className="flex justify-between text-[13.5px] text-white"><span>Conversation memory</span><span className="tabular-nums text-ink-300">{draft.tara.history_turns} turns</span></span>
                  <span className="block text-[12px] text-ink-400">How many earlier messages the model sees for follow-ups ("do it", "that one").</span>
                  <input type="range" min={0} max={8} value={draft.tara.history_turns} onChange={(e) => set('tara.history_turns', Number(e.target.value))} className="mt-2 w-full accent-cyan-400" />
                </label>
              </div>
            </Panel>

            <div className="sticky bottom-4 z-10 mt-6 flex flex-wrap items-center gap-3 rounded-2xl border border-white/[0.08] bg-ink-950/90 px-4 py-3 backdrop-blur">
              <p className="mr-auto text-[13px] text-ink-300">{dirty ? 'Unsaved changes.' : saved != null ? `Saved · ${saved} change${saved === 1 ? '' : 's'} recorded.` : 'Everything is saved.'}</p>
              <button type="button" disabled={!dirty || saving} onClick={() => setDraft(data.config)} className="inline-flex items-center gap-1.5 rounded-full border border-white/15 px-4 py-2 text-[13px] text-ink-200 disabled:opacity-40"><RotateCcw className="size-3.5" /> Undo</button>
              <button type="button" disabled={!dirty || saving} onClick={() => void save()} className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-cyan-400 to-violet-500 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-40">
                {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save
              </button>
            </div>
            {error && <Alert>{error.message}</Alert>}
            <Audit rows={data.audit} />
          </>
        )}
      </main>
    </div>
  )
}

function Provider({ draft, data, set }) {
  const ai = draft.ai
  const paid = ai.provider === 'anthropic'
  const spend = data.spend
  const model = data.options.claude_models.find((m) => m.id === ai.claude_model)
  return (
    <Panel title="AI provider" note="Speech and photos stay on the free tier; text answers follow this choice.">
      <div className="grid gap-2 sm:grid-cols-2">
        <Choice on={!paid} onClick={() => set('ai.provider', 'groq')} title="Groq · free tier" text="Open models on Groq's free tier, routed per task. No cost." ok={data.keys.groq} keyName="GROQ_API_KEY" />
        <Choice on={paid} onClick={() => set('ai', { ...ai, provider: 'anthropic', monthly_budget_usd: ai.monthly_budget_usd || 5 })} title="Claude · paid" text="Anthropic's Claude, billed per token, capped by your monthly budget." ok={data.keys.anthropic} keyName="ANTHROPIC_API_KEY" />
      </div>
      {paid && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Model">
            <select value={ai.claude_model} onChange={(e) => set('ai.claude_model', e.target.value)} className="w-full rounded-xl border border-white/10 bg-ink-900 px-3 py-2 text-[13.5px] text-white">
              {data.options.claude_models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            {model && <span className="mt-1 block text-[11.5px] text-ink-500">${model.input_per_mtok.toFixed(2)} input · ${model.output_per_mtok.toFixed(2)} output per million tokens</span>}
          </Field>
          <Field label="Effort">
            <select value={ai.claude_effort} onChange={(e) => set('ai.claude_effort', e.target.value)} className="w-full rounded-xl border border-white/10 bg-ink-900 px-3 py-2 text-[13.5px] text-white">
              <option value="low">Low · fastest, cheapest</option>
              <option value="medium">Medium</option>
              <option value="high">High · most thorough</option>
            </select>
          </Field>
          <Field label="Monthly budget (USD)">
            <input type="number" min={1} max={500} step={1} value={ai.monthly_budget_usd} onChange={(e) => set('ai.monthly_budget_usd', Number(e.target.value))} className="w-full rounded-xl border border-white/10 bg-ink-900 px-3 py-2 text-[13.5px] text-white" />
            <span className="mt-1 block text-[11.5px] text-ink-500">A hard cap: past it, calls go back to the free tier until next month.</span>
          </Field>
          <Field label="Use the paid model for">
            <span className="flex flex-wrap gap-1.5">
              {data.options.products.map((p) => {
                const on = ai.paid_for.includes(p.id)
                return (
                  <button key={p.id} type="button" aria-pressed={on} onClick={() => set('ai.paid_for', on ? ai.paid_for.filter((x) => x !== p.id) : [...ai.paid_for, p.id])}
                    className={`rounded-full border px-3 py-1 text-[12.5px] ${on ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-100' : 'border-white/10 text-ink-400'}`}>
                    {p.name}
                  </button>
                )
              })}
            </span>
          </Field>
        </div>
      )}
      <dl className="mt-4 grid grid-cols-2 gap-3 rounded-2xl bg-white/[0.02] p-4 text-[12.5px] sm:grid-cols-4">
        <Stat k={`Paid spend · ${spend.month}`} v={`$${spend.usd.toFixed(2)}${paid ? ` of $${ai.monthly_budget_usd}` : ''}`} />
        <Stat k="Paid calls" v={spend.calls} />
        <Stat k="Tokens in / out" v={`${spend.input_tokens.toLocaleString()} / ${spend.output_tokens.toLocaleString()}`} />
        <Stat k="Back to free tier" v={`${spend.budget_fallbacks} budget · ${spend.errors} errors`} />
      </dl>
    </Panel>
  )
}

function Choice({ on, onClick, title, text, ok, keyName }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={`rounded-2xl border px-4 py-3 text-left transition ${on ? 'border-cyan-400/50 bg-cyan-400/[0.07]' : 'border-white/[0.07] bg-white/[0.02] hover:border-white/15'}`}>
      <span className="block text-[14px] font-semibold text-white">{title}</span>
      <span className="block text-[12.5px] text-ink-400">{text}</span>
      <span className={`mt-2 inline-flex items-center gap-1 text-[11.5px] ${ok ? 'text-emerald-300' : 'text-amber-300'}`}>
        {ok ? <Check className="size-3" /> : <X className="size-3" />} {keyName} {ok ? 'is set on the server' : 'is not set (add it in Vercel first)'}
      </span>
    </button>
  )
}

function Toggle({ label, hint, on, onChange }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
      <span>
        <span className="block text-[13.5px] text-white">{label}</span>
        <span className="block text-[12px] text-ink-400">{hint}</span>
      </span>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} className="mt-1 size-4 shrink-0 accent-cyan-400" />
    </label>
  )
}

function Audit({ rows }) {
  return (
    <Panel title="Change history" note="Every saved change: when, which setting, from what to what.">
      {rows.length === 0 ? (
        <p className="text-[13px] text-ink-500">No changes yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.at + JSON.stringify(r.changes).length} className="rounded-xl bg-white/[0.02] px-3 py-2 text-[12.5px]">
              <span className="text-ink-500">{new Date(r.at).toLocaleString()}</span>
              {r.changes.map((c) => (
                <span key={c.setting} className="block text-ink-200">
                  <code className="text-cyan-200">{c.setting}</code>: {JSON.stringify(c.from)} → {JSON.stringify(c.to)}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

const Panel = ({ title, note, children }) => (
  <section className="mt-6 rounded-3xl border border-white/[0.07] bg-ink-900/60 p-5">
    <h2 className="text-[16px] font-semibold text-white">{title}</h2>
    {note && <p className="mt-0.5 mb-4 text-[12.5px] text-ink-400">{note}</p>}
    {!note && <div className="mb-4" />}
    {children}
  </section>
)
const Field = ({ label, children }) => (
  <label className="block">
    <span className="mb-1 block text-[12px] text-ink-400">{label}</span>
    {children}
  </label>
)
const Stat = ({ k, v }) => (
  <div>
    <dt className="text-ink-500">{k}</dt>
    <dd className="mt-0.5 font-semibold text-white tabular-nums">{v}</dd>
  </div>
)
const Alert = ({ children }) => <p className="mt-4 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] px-4 py-2 text-[13px] text-rose-200">{children}</p>

function KeyForm({ onUnlock, wrong }) {
  const [v, setV] = useState('')
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (v.trim()) onUnlock(v.trim()) }} className="mt-8 max-w-md rounded-3xl border border-white/[0.07] bg-ink-900/60 p-5">
      <p className="flex items-center gap-2 text-[14px] font-semibold text-white"><KeyRound className="size-4" /> Enter the owner key</p>
      <p className="mt-1 text-[13px] text-ink-400">TARA_OWNER_KEY from the server. It stays in this browser.</p>
      {wrong && <p className="mt-2 text-[13px] text-rose-300">That key didn't work.</p>}
      <div className="mt-3 flex gap-2">
        <input type="password" value={v} onChange={(e) => setV(e.target.value)} aria-label="Owner key" autoComplete="current-password" className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[14px] text-white outline-none focus:border-cyan-400/50" />
        <button type="submit" className="rounded-xl bg-white/[0.1] px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-white/[0.16]">Unlock</button>
      </div>
    </form>
  )
}
