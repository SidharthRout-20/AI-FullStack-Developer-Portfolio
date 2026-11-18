import { describe, expect, it } from 'vitest'
import { PRODUCTS } from '../../site/products'
import {
  buildArtifacts,
  checkFile,
  checkSubmission,
  filterEvidence,
  formatBytes,
  looksBinary,
  redactionText,
  reportMarkdown,
  where,
} from './logic'

const LIMITS = {
  max_request_bytes: 2_500_000,
  max_artifact_bytes: 1_000_000,
  max_artifacts: 3,
  extensions: ['.log', '.txt', '.diff', '.patch', '.xml', '.json'],
}

describe('EFI intake validation', () => {
  it('rejects archives, unknown types, oversized and empty files', () => {
    expect(checkFile({ name: 'repo.zip', size: 10 }, LIMITS)).toMatch(/archives/)
    expect(checkFile({ name: 'app.exe', size: 10 }, LIMITS)).toMatch(/unsupported/)
    expect(checkFile({ name: 'ci.log', size: 2_000_000 }, LIMITS)).toMatch(/limit is/)
    expect(checkFile({ name: 'ci.log', size: 0 }, LIMITS)).toMatch(/empty/)
    expect(checkFile({ name: 'ci.log', size: 500 }, LIMITS)).toBeNull()
    expect(checkFile({ name: 'Dockerfile', size: 500 }, LIMITS)).toBeNull() // no extension: the server decides
  })

  it('detects binary content by NUL bytes', () => {
    expect(looksBinary(new Uint8Array([72, 105, 0, 1]))).toBe(true)
    expect(looksBinary(new TextEncoder().encode('plain log text'))).toBe(false)
  })

  it('builds artifacts from files and non-empty pasted fields only', () => {
    const files = [{ name: 'junit.xml', size: 3, content: '<x/>' }]
    expect(buildArtifacts(files, { log: '  ', diff: 'diff --git a/x b/x' })).toEqual([
      { name: 'junit.xml', content: '<x/>' },
      { name: 'pasted.diff', kind: 'diff', content: 'diff --git a/x b/x' },
    ])
  })

  it('checks the whole submission against the limits', () => {
    expect(checkSubmission([], '', LIMITS)).toMatch(/at least one/)
    const four = Array.from({ length: 4 }, (_, i) => ({ name: `${i}.log`, content: 'x' }))
    expect(checkSubmission(four, '', LIMITS)).toMatch(/At most 3/)
    expect(checkSubmission([{ name: 'a.log', content: 'x'.repeat(1_100_000) }], '', LIMITS)).toMatch(/per artifact/)
    expect(checkSubmission([{ name: 'a.log', content: 'error: boom' }], 'notes', LIMITS)).toBeNull()
  })

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB')
  })
})

const EVIDENCE = [
  { id: 'EV-001', kind: 'command', artifact: 'ci.log', artifact_index: 0, line: 3, content: 'pytest -q', attrs: { command: 'pytest -q' }, status: 'parsed' },
  { id: 'EV-002', kind: 'exception', artifact: 'ci.log', artifact_index: 0, line: 9, content: 'TypeError: boom', attrs: {}, status: 'parsed' },
  { id: 'EV-003', kind: 'diff_hunk', artifact: 'c.diff', artifact_index: 1, line: 5, content: 'src/a.py @@', attrs: {}, status: 'parsed' },
  { id: 'EV-004', kind: 'note', artifact: 'investigation notes', artifact_index: 2, line: 1, content: 'after refactor', attrs: {}, status: 'user_provided' },
]

describe('EFI evidence and report rendering helpers', () => {
  it('groups evidence', () => {
    expect(filterEvidence(EVIDENCE, 'failures').map((e) => e.id)).toEqual(['EV-002'])
    expect(filterEvidence(EVIDENCE, 'changes').map((e) => e.id)).toEqual(['EV-003'])
    expect(filterEvidence(EVIDENCE, 'context').map((e) => e.id)).toEqual(['EV-001', 'EV-004'])
    expect(filterEvidence(EVIDENCE, 'all')).toHaveLength(4)
    expect(where(EVIDENCE[1])).toBe('ci.log:9')
  })

  it('describes redaction without revealing values', () => {
    expect(redactionText({ total: 0, by_type: {} })).toBe('No secrets detected.')
    expect(redactionText({ total: 3, by_type: { groq_api_key: 1, named_secret: 2 } })).toBe(
      '3 secret values redacted before storage: named secret ×2, groq api key ×1.',
    )
  })

  it('exports only what the report contains, with evidence locations', () => {
    const inv = {
      title: 'CI red',
      status: 'analyzed',
      data: {
        evidence: EVIDENCE,
        report: {
          model: 'openai/gpt-oss-120b',
          summary: 'TypeError in a.py',
          insufficient_evidence: false,
          hypotheses: [{ id: 'H1', title: 'tax None', confidence: 'high', description: 'tax is None', supporting_evidence: ['EV-002', 'EV-003'], contradicting_evidence: [], remediation: ['Restore default'] }],
          validation_checklist: [{ text: 'Re-run pytest -q', source: 'artifacts' }],
          limitations: ['Model-generated'],
        },
      },
    }
    const md = reportMarkdown(inv)
    expect(md).toContain('## H1. tax None (high)')
    expect(md).toContain('Supporting: EV-002 (ci.log:9), EV-003 (c.diff:5)')
    expect(md).toContain('- [ ] Re-run pytest -q (artifacts)')
    expect(md).toContain('Summary (model-generated)')
    expect(reportMarkdown({ ...inv, data: { ...inv.data, report: null } })).toBe('')
  })

  it('is registered as the second portfolio product (after Safarnaama) with its own app route', () => {
    const p = PRODUCTS.find((x) => x.id === 'efi')
    expect(p?.app.route).toBe('/jasoos')
    expect(p?.priority).toBe(2)
    expect(p?.status).toBe('in_development')
  })
})
