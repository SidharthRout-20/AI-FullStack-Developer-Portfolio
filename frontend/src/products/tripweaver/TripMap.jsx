import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'
import { useTheme } from '../../theme/theme'

import { DAY_COLORS } from './colors'

/** Leaflet map: numbered markers per day, a route line per day, plus discovery pins (real places, not yet planned). */
export function TripMap({
  center,
  days,
  activeDay,
  focus,
  onSelect,
  extra = [],
}) {
  const el = useRef(null)
  const map = useRef(null)
  const tiles = useRef(null)
  const layer = useRef(null)
  const markers = useRef(new Map())
  const extraLayer = useRef(null)
  const { theme } = useTheme()

  useEffect(() => {
    if (!el.current || map.current) return
    map.current = L.map(el.current, { zoomControl: true, attributionControl: true }).setView(center, 13)
    layer.current = L.layerGroup().addTo(map.current)
    extraLayer.current = L.layerGroup().addTo(map.current)
    return () => {
      map.current?.remove()
      map.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!map.current) return
    tiles.current?.remove()
    // OpenStreetMap standard tiles (free, no key; attribution required). Dark mode re-tints them in CSS.
    tiles.current = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      className: theme === 'dark' ? 'map-tiles-dark' : '',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map.current)
  }, [theme])

  useEffect(() => {
    const m = map.current
    const g = layer.current
    if (!m || !g) return
    g.clearLayers()
    markers.current.clear()
    const bounds = []
    for (const d of days) {
      const color = DAY_COLORS[(d.day - 1) % DAY_COLORS.length]
      const dim = activeDay != null && d.day !== activeDay
      const pts = []
      d.activities.forEach((a, i) => {
        if (a.lat == null || a.lng == null) return
        const ll = [a.lat, a.lng]
        pts.push(ll)
        if (!dim) bounds.push(ll)
        const icon = L.divIcon({
          className: '',
          iconSize: [26, 26],
          iconAnchor: [13, 13],
          html: `<div style="width:26px;height:26px;border-radius:999px;background:${color};color:#fff;display:grid;place-items:center;font:600 11px Inter Variable,sans-serif;border:2px solid #fff;box-shadow:0 4px 12px rgb(0 0 0/.35);opacity:${dim ? 0.35 : 1}">${d.day}.${i + 1}</div>`,
        })
        const mk = L.marker(ll, { icon, title: a.name }).addTo(g)
        mk.bindTooltip(`<b>${a.time}</b> ${a.name.replace(/</g, '&lt;')}`, { direction: 'top', offset: [0, -12] })
        mk.on('click', () => onSelect(a.id))
        markers.current.set(a.id, mk)
      })
      if (pts.length > 1) L.polyline(pts, { color, weight: 3, opacity: dim ? 0.2 : 0.8, dashArray: '6 6' }).addTo(g)
    }
    if (bounds.length) m.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom: 15, animate: false }) // an animated zoom would swallow a later fit (Leaflet ignores fits mid-animation)
  }, [days, activeDay, onSelect])

  useEffect(() => {
    const g = extraLayer.current
    if (!g) return
    g.clearLayers()
    const pts = extra.filter((p) => p.lat != null && p.lng != null).map((p) => [p.lat, p.lng])
    if (pts.length && map.current) map.current.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 16, animate: false })
    for (const p of extra) {
      if (p.lat == null || p.lng == null) continue
      const icon = L.divIcon({
        className: '',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
        html: '<div style="width:14px;height:14px;border-radius:999px;background:#fff;border:3px solid #10b981;box-shadow:0 2px 8px rgb(0 0 0/.35)"></div>',
      })
      L.marker([p.lat, p.lng], { icon, title: p.name })
        .addTo(g)
        .bindTooltip(`${p.name.replace(/</g, '&lt;')}${p.category ? ` · ${String(p.category).replace(/</g, '&lt;')}` : ''}`, { direction: 'top', offset: [0, -8] })
    }
  }, [extra])

  useEffect(() => {
    if (!focus) return
    const mk = markers.current.get(focus)
    if (mk && map.current) {
      map.current.setView(mk.getLatLng(), Math.max(map.current.getZoom(), 15), { animate: true })
      mk.openTooltip()
    }
  }, [focus])

  return <div ref={el} className="size-full" role="region" aria-label="Trip map" />
}
