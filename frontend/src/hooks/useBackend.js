import { useEffect, useState } from 'react'
import { api } from '../lib/api'

const POLL_MS = 10_000

/** Loads backend metadata on mount, then polls health so the UI follows the document watcher. */
export function useBackend() {
  const [state, setState] = useState({ health: null, graph: null, documents: [], error: null, indexNotice: null })

  useEffect(() => {
    const ctrl = new AbortController()
    let version = null
    Promise.all([api.health(ctrl.signal), api.graph(ctrl.signal), api.documents(ctrl.signal)])
      .then(([health, graph, documents]) => {
        version = health.index_version
        setState({ health, graph, documents, error: null, indexNotice: null })
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) {
          setState((s) => ({ ...s, error: err instanceof Error ? err.message : 'Backend unreachable' }))
        }
      })
    const timer = window.setInterval(async () => {
      try {
        const health = await api.health(ctrl.signal)
        if (version !== null && health.index_version !== version) {
          const documents = await api.documents(ctrl.signal)
          setState((s) => ({ ...s, health, documents, error: null, indexNotice: health.last_ingest }))
        } else {
          setState((s) => ({ ...s, health, error: null }))
        }
        version = health.index_version
      } catch {
        if (!ctrl.signal.aborted) setState((s) => ({ ...s, error: 'Backend unreachable' }))
      }
    }, POLL_MS)
    return () => {
      ctrl.abort()
      window.clearInterval(timer)
    }
  }, [])

  return state
}
