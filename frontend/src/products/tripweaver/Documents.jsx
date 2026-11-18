/** Travel documents & checklists: private to the trip owner. */
import { CheckSquare, Download, FileText, ListChecks, Paperclip, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText } from '../shared/http'
import { Button, Card, Empty, ErrorNote, Field, inputClass, Pill, Spinner } from '../shared/ui'
import { DOC_KINDS } from './logic'

const uid = () => Math.random().toString(36).slice(2, 12)

export function Documents({ trip, api, onTrip, setNote }) {
  const [docs, setDocs] = useState(null)
  const [form, setForm] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [newList, setNewList] = useState('')
  const fileFor = useRef(null)
  const picker = useRef(null)
  const lists = trip.checklists ?? []

  const load = useCallback(() => api.documents().then(setDocs).catch((e) => (setDocs([]), setError(errorText(e)))), [api])
  useEffect(() => void load(), [load])

  const saveLists = async (next) => {
    try {
      onTrip(await api.setChecklists(next))
    } catch (e) {
      setError(errorText(e))
    }
  }
  const toggle = (lid, iid) => void saveLists(lists.map((l) => (l.id !== lid ? l : { ...l, items: l.items.map((i) => (i.id === iid ? { ...i, done: !i.done } : i)) })))
  const addItem = (lid, text) => void saveLists(lists.map((l) => (l.id !== lid ? l : { ...l, items: [...l.items, { id: uid(), text, done: false }] })))
  const packing = async () => {
    setBusy('packing')
    try {
      onTrip(await api.packing())
      setNote('Packing list built from your forecast, trip length and party.')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  const saveDoc = async () => {
    setBusy('doc')
    try {
      await api.addDocument({ kind: form.kind, title: form.title.trim(), body: form.body })
      setForm(null)
      void load()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  const attach = async (f) => {
    const did = fileFor.current
    if (!f || !did) return
    setBusy(`file-${did}`)
    setError(null)
    try {
      await api.uploadFile(did, f)
      void load()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
      if (picker.current) picker.current.value = ''
    }
  }
  const download = async (d) => {
    try {
      const blob = await api.downloadFile(d.id)
      const url = URL.createObjectURL(blob)
      Object.assign(document.createElement('a'), { href: url, download: d.file.name }).click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div className="space-y-3">
      <ErrorNote message={error} />
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><ListChecks className="pa-ink size-4" /> Checklists</p>
          <Button variant="ghost" className="ml-auto !py-1.5" busy={busy === 'packing'} onClick={() => void packing()}>
            {lists.some((l) => l.kind === 'packing') ? 'Rebuild packing list' : 'Build a packing list'}
          </Button>
        </div>
        {lists.length === 0 && <p className="mt-1 text-[12.5px] text-ink-400">Build a packing list from your trip, or start your own list below.</p>}
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {lists.map((l) => (
            <div key={l.id} className="rounded-xl border border-white/[0.06] p-3">
              <div className="flex items-center gap-2">
                <p className="text-[13.5px] font-medium text-white">{l.title}</p>
                <Pill>{l.items.filter((i) => i.done).length}/{l.items.length}</Pill>
                <button type="button" aria-label={`Delete ${l.title}`} className="ml-auto text-ink-500 hover:text-rose-300" onClick={() => void saveLists(lists.filter((x) => x.id !== l.id))}><Trash2 className="size-3.5" /></button>
              </div>
              {l.source && <p className="text-[11px] text-ink-500">Based on {l.source}</p>}
              <ul className="mt-1.5 space-y-1">
                {l.items.map((i) => (
                  <li key={i.id}>
                    <label className="flex items-start gap-2 text-[13px] text-ink-200">
                      <input type="checkbox" className="mt-1" checked={i.done} onChange={() => toggle(l.id, i.id)} />
                      <span className={i.done ? 'text-ink-500 line-through' : ''}>{i.text}{i.why && <span className="ml-1 text-[11px] text-ink-500">({i.why})</span>}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <form className="mt-2 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); const v = e.currentTarget.item.value.trim(); if (v) { addItem(l.id, v); e.currentTarget.reset() } }}>
                <input name="item" className={`${inputClass} !py-1 text-[12.5px]`} placeholder="Add an item…" maxLength={200} />
                <button type="submit" className="chip"><Plus className="size-3" /></button>
              </form>
            </div>
          ))}
        </div>
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newList.trim()) { void saveLists([...lists, { id: uid(), title: newList.trim().slice(0, 80), items: [] }]); setNewList('') } }}>
          <input className={`${inputClass} !py-1.5 text-[13px]`} placeholder="New list, e.g. Before we leave" value={newList} onChange={(e) => setNewList(e.target.value)} maxLength={80} />
          <Button variant="ghost" type="submit" className="shrink-0 !py-1.5 whitespace-nowrap"><CheckSquare className="size-4" /> Add list</Button>
        </form>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-white"><FileText className="size-4 text-sky-300" /> Travel documents</p>
          {!form && <Button variant="ghost" className="ml-auto !py-1.5" onClick={() => setForm({ kind: 'confirmation', title: '', body: '' })}><Plus className="size-4" /> Add</Button>}
        </div>
        <p className="mt-1 text-[12.5px] text-ink-400">Confirmations, tickets, insurance, emergency contacts and notes. Only you (this browser's owner token) can see them; people with the share link can't.</p>
        {form && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Kind"><select className={inputClass} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{DOC_KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</select></Field>
            <Field label="Title"><input className={inputClass} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Field label="Details" hint="policy numbers, phone numbers, addresses…"><textarea className={`${inputClass} min-h-20`} value={form.body} maxLength={5000} onChange={(e) => setForm({ ...form, body: e.target.value })} /></Field></div>
            <div className="flex gap-2"><Button accent="from-lime-500 to-teal-500" busy={busy === 'doc'} disabled={!form.title.trim()} onClick={() => void saveDoc()}>Save</Button><Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button></div>
          </div>
        )}
      </Card>
      <input ref={picker} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,text/plain" className="hidden" onChange={(e) => void attach(e.target.files?.[0])} />
      {!docs ? <Spinner label="Loading documents…" /> : docs.length === 0 ? (
        <Empty icon={FileText} title="No documents yet" text="Add your booking confirmations, insurance and emergency contacts so they're with the trip." />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {docs.map((d) => (
            <li key={d.id} className="rounded-2xl border border-white/[0.07] bg-ink-900/60 p-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-white">{d.title} <Pill>{d.kind.replace('_', ' ')}</Pill></p>
                  {d.body && <p className="mt-1 text-[12.5px] whitespace-pre-wrap text-ink-300">{d.body}</p>}
                </div>
                <button type="button" aria-label={`Delete ${d.title}`} className="text-ink-500 hover:text-rose-300" onClick={() => void api.deleteDocument(d.id).then(load)}><Trash2 className="size-3.5" /></button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {d.file ? (
                  <button type="button" className="chip" onClick={() => void download(d)}><Download className="size-3" /> {d.file.name} ({Math.round(d.file.size / 1024)} KB)</button>
                ) : (
                  <button type="button" className="chip" disabled={busy === `file-${d.id}`} onClick={() => { fileFor.current = d.id; picker.current?.click() }}>
                    <Paperclip className="size-3" /> {busy === `file-${d.id}` ? 'Uploading…' : 'Attach a file (max 1 MB)'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
