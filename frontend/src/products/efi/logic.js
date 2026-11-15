/** Pure helpers for the EFI UI (validated in efi.test.js; no React, no network). */

export const ARCHIVES = ['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war', '.whl']

export const KIND_LABELS = {
  error: 'Error',
  exception: 'Exception',
  stack_frame: 'Stack frame',
  source_reference: 'Source reference',
  test_failure: 'Failed test',
  test_summary: 'Test summary',
  diff_file: 'Changed file',
  diff_hunk: 'Changed lines',
  dependency_change: 'Dependency change',
  dependency: 'Dependency',
  command: 'Command',
  stage: 'Stage',
  config_line: 'Config',
  note: 'Your note',
}

export const FAILURE_KINDS = new Set(['error', 'exception', 'test_failure', 'source_reference'])

export const STATUS = {
  ready: { label: 'Evidence ready', tone: 'info' },
  analyzing: { label: 'Analysing…', tone: 'info' },
  analyzed: { label: 'Analysed', tone: 'good' },
  insufficient_evidence: { label: 'Insufficient evidence', tone: 'warn' },
  failed: { label: 'Analysis failed', tone: 'bad' },
}

export const CONFIDENCE_TONE = { high: 'good', medium: 'warn', low: 'neutral', rejected: 'bad' }

export function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const ext = (name) => {
  const base = name.toLowerCase().split(/[\\/]/).pop() ?? ''
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i) : ''
}

/**
 * Client-side pre-check of one file against the server's limits (the server re-validates everything).
 * Returns null when acceptable, else a user-facing reason.
 */
export function checkFile({ name, size }, limits) {
  const e = ext(name)
  if (ARCHIVES.includes(e)) return `${name}: archives aren't supported. Upload the log, diff or report files themselves.`
  if (e && limits?.extensions && !limits.extensions.includes(e))
    return `${name}: unsupported file type (${e}).`
  if (limits && size > limits.max_artifact_bytes)
    return `${name} is ${formatBytes(size)}; the limit is ${formatBytes(limits.max_artifact_bytes)} per artifact.`
  if (size === 0) return `${name} is empty.`
  return null
}

/** True if the first bytes look binary (NUL byte), the same signal the server uses. */
export function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8000)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

const byteLength = (text) => new TextEncoder().encode(text).length

/** Artifacts to submit: files + non-empty pasted fields. */
export function buildArtifacts(files, pasted) {
  const out = files.map((f) => ({ name: f.name, content: f.content }))
  if (pasted.log?.trim()) out.push({ name: 'pasted-log.txt', kind: 'log', content: pasted.log })
  if (pasted.diff?.trim()) out.push({ name: 'pasted.diff', kind: 'diff', content: pasted.diff })
  return out
}

/** Problems with the whole submission against the limits (null when it can be sent). */
export function checkSubmission(artifacts, notes, limits) {
  if (!artifacts.length) return 'Add at least one artifact: upload a file, or paste a log or a diff.'
  if (limits && artifacts.length > limits.max_artifacts) return `At most ${limits.max_artifacts} artifacts per investigation.`
  for (const a of artifacts) {
    const size = byteLength(a.content)
    if (limits && size > limits.max_artifact_bytes)
      return `${a.name} is ${formatBytes(size)}; the limit is ${formatBytes(limits.max_artifact_bytes)} per artifact.`
  }
  const total = byteLength(JSON.stringify({ artifacts, notes }))
  if (limits && total > limits.max_request_bytes)
    return `Everything together is ${formatBytes(total)}; the limit is ${formatBytes(limits.max_request_bytes)} per investigation.`
  return null
}

export const evidenceIndex = (evidence) => new Map(evidence.map((e) => [e.id, e]))

export const where = (e) => (e.line ? `${e.artifact}:${e.line}` : e.artifact)

/** Evidence filtered by a kind group: 'all' | 'failures' | 'changes' | 'context'. */
export function filterEvidence(evidence, group) {
  if (group === 'failures') return evidence.filter((e) => FAILURE_KINDS.has(e.kind) || e.kind === 'stack_frame' || e.kind === 'test_summary')
  if (group === 'changes') return evidence.filter((e) => ['diff_file', 'diff_hunk', 'dependency_change'].includes(e.kind))
  if (group === 'context') return evidence.filter((e) => ['command', 'stage', 'config_line', 'dependency', 'note'].includes(e.kind))
  return evidence
}

export function redactionText(r) {
  if (!r?.total) return 'No secrets detected.'
  const kinds = Object.entries(r.by_type)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k.replaceAll('_', ' ')} ×${n}`)
  return `${r.total} secret value${r.total === 1 ? '' : 's'} redacted before storage: ${kinds.join(', ')}.`
}

/** Markdown export of a report (only what the report actually contains). */
export function reportMarkdown(inv) {
  const r = inv.data.report
  if (!r) return ''
  const idx = evidenceIndex(inv.data.evidence)
  const cite = (ids) => ids.map((i) => `${i} (${idx.get(i) ? where(idx.get(i)) : '?'})`).join(', ') || 'none'
  const lines = [`# ${inv.title}`, '', `Status: ${STATUS[inv.status]?.label ?? inv.status} · model: ${r.model ?? 'not used'}`, '']
  if (r.summary) lines.push('## Summary (model-generated)', '', r.summary, '')
  if (r.insufficient_evidence) lines.push('## Insufficient evidence', '', r.insufficient_reason || 'The evidence does not support a root cause.', '')
  r.hypotheses.forEach((h) => {
    lines.push(`## ${h.id}. ${h.title} (${h.confidence})`, '', h.description, '', `Supporting: ${cite(h.supporting_evidence)}`)
    if (h.contradicting_evidence.length) lines.push(`Contradicting: ${cite(h.contradicting_evidence)}`)
    if (h.remediation.length) lines.push('', 'Suggested remediation:', ...h.remediation.map((x) => `- ${x}`))
    lines.push('')
  })
  if (r.validation_checklist.length) lines.push('## Validation checklist', '', ...r.validation_checklist.map((c) => `- [ ] ${c.text} (${c.source})`), '')
  if (r.limitations.length) lines.push('## Limitations', '', ...r.limitations.map((l) => `- ${l}`), '')
  return lines.join('\n')
}
