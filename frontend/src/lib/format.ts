export function formatMs(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '—'
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

export const pct = (v: number) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}
