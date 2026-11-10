/**
 * Device capabilities, all native browser APIs (no SDKs, nothing leaves the device except the final upload):
 * camera (file input + canvas downscale), voice (Web Speech API), location (Geolocation API),
 * read-aloud (speechSynthesis) and local notifications (Notification API via the service worker).
 */

/** Downscale + re-encode a photo on the device: ~1600px JPEG keeps text legible and uploads small. */
export async function compressImage(file: File, maxSide = 1600, quality = 0.82): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', quality)
}

export function currentPosition(timeoutMs = 8000): Promise<{ lat: number; lng: number } | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null)
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null), // denied / unavailable: parking still saves the typed place
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    ),
  )
}

// ── Voice input (Web Speech API; Chrome / Edge / Safari) ──────────────────
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error: string }) => void) | null
  start(): void
  stop(): void
}

type SpeechCtor = new () => SpeechRecognitionLike

function speechCtor(): SpeechCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

export const voiceSupported = () => typeof window !== 'undefined' && !!speechCtor()

/** Start dictation. Calls back with interim text, then the final transcript. Returns a stop function. */
export function listen(onText: (text: string, final: boolean) => void, onEnd: (error?: string) => void): () => void {
  const Ctor = speechCtor()
  if (!Ctor) {
    onEnd('Voice input is not supported in this browser.')
    return () => {}
  }
  const rec = new Ctor()
  rec.lang = navigator.language || 'en-IN'
  rec.interimResults = true
  rec.continuous = false
  rec.onresult = (e) => {
    const parts = Array.from(e.results)
    const text = parts.map((r) => r[0]?.transcript ?? '').join(' ')
    onText(text, parts.every((r) => r.isFinal))
  }
  rec.onerror = (e) => onEnd(e.error === 'not-allowed' ? 'Microphone permission was denied.' : undefined)
  rec.onend = () => onEnd()
  rec.start()
  return () => rec.stop()
}

export function speak(text: string) {
  if (!('speechSynthesis' in window)) return
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.rate = 1.02
  speechSynthesis.speak(u)
}

export const stopSpeaking = () => 'speechSynthesis' in window && speechSynthesis.cancel()

// ── Local notifications + installable app (service worker) ────────────────
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return null
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  } catch {
    return null
  }
}

export async function notify(title: string, body: string, tag: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const reg = await navigator.serviceWorker?.getRegistration()
  if (reg) await reg.showNotification(title, { body, tag, icon: '/keeper-192.png', badge: '/keeper-192.png' })
  else new Notification(title, { body, tag })
}
