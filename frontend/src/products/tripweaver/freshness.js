/** How fresh a trip's stored forecast is. Weather is never presented as live: it's "as of" when it was fetched. */
export const STALE_AFTER_H = 6

export function forecastFreshness(iso, now = new Date()) {
  if (!iso) return { label: 'Forecast time not recorded', stale: true }
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return { label: 'Forecast time not recorded', stale: true }
  const hours = (now.getTime() - at.getTime()) / 3_600_000
  const when = hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min ago` : hours < 48 ? `${Math.round(hours)} h ago` : at.toLocaleDateString()
  return { label: `Forecast as of ${when}`, stale: hours >= STALE_AFTER_H }
}
