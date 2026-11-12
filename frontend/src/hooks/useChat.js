import { useCallback, useReducer, useRef } from 'react'
import { streamChat } from '../lib/api'

/** Conversation memory: the last 4 exchanges (question + answer) are sent as context. */
export const MEMORY_TURNS = 4

export const idleWorkflow = { nodes: {}, path: [], running: false }
export const initialState = { messages: [], workflow: idleWorkflow, selectedId: null }

function patchMessage(messages, id, patch) {
  return messages.map((m) => (m.id === id ? patch(m) : m))
}

function setNode(wf, node, run) {
  return { ...wf, nodes: { ...wf.nodes, [node]: { ...wf.nodes[node], ...run } } }
}

const since = (wf, now) => Math.max(0, Math.round(now - (wf.t0 ?? now)))

/** Mark everything the run didn't touch as skipped, so the taken branch stands out. */
function settle(wf, allNodes, ok, now) {
  const nodes = { ...wf.nodes }
  for (const id of allNodes) if (!nodes[id]) nodes[id] = { status: 'skipped' }
  const total = since(wf, now)
  if (ok) nodes['__end__'] = { status: 'done', startedAt: total, endedAt: total }
  return { ...wf, nodes, path: ok ? [...wf.path, '__end__'] : wf.path, running: false, totalMs: total }
}

/** Finish the live run and snapshot it onto the assistant message for later replay. */
function complete(state, id, run, patch) {
  return {
    ...state,
    workflow: run,
    messages: patchMessage(state.messages, id, (m) => ({ ...m, ...patch, run })),
  }
}

export function reducer(state, action) {
  switch (action.type) {
    case 'submit':
      return {
        messages: [...state.messages, action.user, action.assistant],
        selectedId: action.assistant.id,
        workflow: {
          nodes: { __start__: { status: 'done', startedAt: 0, endedAt: 0 } },
          path: ['__start__'],
          running: true,
          question: action.user.content,
          t0: action.now,
        },
      }

    case 'event': {
      const { ev, id, now } = action
      const wf = state.workflow
      switch (ev.event) {
        case 'node': {
          if (ev.status === 'start') {
            const next = setNode(wf, ev.node, { status: 'active', startedAt: since(wf, now) })
            return { ...state, workflow: { ...next, path: [...next.path, ev.node] } }
          }
          const status = ev.status === 'end' ? 'done' : 'error'
          return {
            ...state,
            workflow: setNode(wf, ev.node, { status, ms: ev.ms, detail: ev.detail, endedAt: since(wf, now) }),
          }
        }
        case 'sources':
          return { ...state, messages: patchMessage(state.messages, id, (m) => ({ ...m, sources: ev.sources })) }
        case 'token':
          return {
            ...state,
            workflow: wf.firstTokenAt === undefined ? { ...wf, firstTokenAt: since(wf, now) } : wf,
            messages: patchMessage(state.messages, id, (m) => ({ ...m, content: m.content + ev.text })),
          }
        case 'done':
          return complete(state, id, settle(wf, action.allNodes, true, now), {
            status: 'done',
            route: ev.route,
          })
        case 'error':
          return reducer(state, { type: 'fail', id, error: ev.message, allNodes: action.allNodes, now })
      }
      return state
    }

    case 'fail':
      return complete(state, action.id, settle(state.workflow, action.allNodes, false, action.now), {
        status: 'error',
        error: action.error,
      })

    case 'finish': {
      // Stream closed (or was aborted) without a terminal event.
      const msg = state.messages.find((m) => m.id === action.id)
      if (!state.workflow.running || !msg) return state
      return complete(state, action.id, settle(state.workflow, action.allNodes, false, action.now), {
        status: msg.status === 'streaming' ? 'done' : msg.status,
      })
    }

    case 'select':
      return { ...state, selectedId: action.id }

    case 'load': {
      const lastRun = [...action.messages].reverse().find((m) => m.run)
      return {
        messages: action.messages,
        workflow: lastRun?.run ?? idleWorkflow,
        selectedId: lastRun?.id ?? null,
      }
    }

    case 'reset':
      return initialState
  }
}

const uid = () => crypto.randomUUID()

/** Only user→assistant pairs whose answer completed: failed turns would confuse the query rewriter. */
export function completedTurns(messages) {
  const out = []
  for (let i = 0; i + 1 < messages.length; i++) {
    const [q, a] = [messages[i], messages[i + 1]]
    if (q.role === 'user' && a.role === 'assistant' && a.status === 'done' && a.content) {
      out.push(q, a)
      i++
    }
  }
  return out
}

/** The run to display: the live run while streaming, otherwise the selected answer's snapshot. */
export function selectRun(state) {
  if (state.workflow.running) return state.workflow
  const selected = state.messages.find((m) => m.id === state.selectedId)
  return selected?.run ?? state.workflow
}

export function useChat(nodeIds) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const abortRef = useRef(null)

  const send = useCallback(
    async (question) => {
      const q = question.trim()
      if (!q || abortRef.current) return

      // Stateless backend: the client sends recent turns as context.
      const history = completedTurns(state.messages)
        .slice(-MEMORY_TURNS * 2)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))

      const assistantId = uid()
      dispatch({
        type: 'submit',
        user: { id: uid(), role: 'user', content: q, status: 'done' },
        assistant: { id: assistantId, role: 'assistant', content: '', status: 'streaming' },
        now: performance.now(),
      })

      const controller = new AbortController()
      abortRef.current = controller
      try {
        await streamChat({
          question: q,
          history,
          signal: controller.signal,
          onEvent: (ev) => dispatch({ type: 'event', id: assistantId, ev, allNodes: nodeIds, now: performance.now() }),
        })
      } catch (err) {
        if (!controller.signal.aborted) {
          dispatch({
            type: 'fail',
            id: assistantId,
            error: err instanceof Error ? err.message : 'Network error',
            allNodes: nodeIds,
            now: performance.now(),
          })
        }
      } finally {
        abortRef.current = null
        dispatch({ type: 'finish', id: assistantId, allNodes: nodeIds, now: performance.now() })
      }
    },
    [state.messages, nodeIds],
  )

  const stop = useCallback(() => abortRef.current?.abort(), [])
  const reset = useCallback(() => {
    abortRef.current?.abort()
    dispatch({ type: 'reset' })
  }, [])
  const select = useCallback((id) => dispatch({ type: 'select', id }), [])
  const load = useCallback((messages) => {
    abortRef.current?.abort()
    dispatch({ type: 'load', messages })
  }, [])

  return {
    ...state,
    run: selectRun(state),
    send,
    stop,
    reset,
    select,
    load,
    streaming: state.workflow.running,
    /** Completed exchanges currently inside the memory window (0–MEMORY_TURNS). */
    memoryTurns: Math.min(MEMORY_TURNS, completedTurns(state.messages).length / 2),
  }
}
