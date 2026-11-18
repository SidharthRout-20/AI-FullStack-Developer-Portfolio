import { useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'

/**
 * Minimal client-side router on the History API (no dependency).
 * The backend's SPA fallback serves index.html for every non-API path, so deep links work.
 */
const NAV_EVENT = 'app:navigate'

function subscribe(onChange) {
  window.addEventListener('popstate', onChange)
  window.addEventListener(NAV_EVENT, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(NAV_EVENT, onChange)
  }
}

export function usePath() {
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => '/',
  )
}

export function navigate(to) {
  if (to === window.location.pathname) return
  const go = () => {
    window.history.pushState(null, '', to)
    window.scrollTo({ top: 0 })
    // flushSync: the View Transition snapshots the DOM right after this callback returns.
    flushSync(() => window.dispatchEvent(new Event(NAV_EVENT)))
  }
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!document.startViewTransition || reduce) return go()
  const root = document.documentElement
  root.classList.add('route-change')
  document.startViewTransition(go).finished.finally(() => root.classList.remove('route-change'))
}

/** Anchor that navigates client-side but keeps native behaviour for new-tab / modified clicks. */
export function Link({ to, onClick, ...rest }) {
  const handle = (e) => {
    onClick?.(e)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to)
  }
  return <a href={to} onClick={handle} {...rest} />
}
