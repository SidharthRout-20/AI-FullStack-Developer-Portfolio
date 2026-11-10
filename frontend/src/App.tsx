import { MotionConfig } from 'motion/react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChatPanel } from './components/chat/ChatPanel'
import { Backdrop } from './components/shell/Backdrop'
import { HistoryDrawer } from './components/shell/HistoryDrawer'
import { SplitPane } from './components/shell/SplitPane'
import { TopBar, type ViewMode } from './components/shell/TopBar'
import { NODE_STAGE } from './components/studio/nodeMeta'
import { useBackend } from './hooks/useBackend'
import { MEMORY_TURNS, useChat } from './hooks/useChat'
import { useMediaQuery } from './hooks/useMediaQuery'
import { deleteSession, loadSessions, saveSessions, upsertSession } from './lib/sessions'
import type { ChatSession } from './types'

// Code-split heavy / secondary views into their own chunks.
const PipelineStudio = lazy(() =>
  import('./components/studio/PipelineStudio').then((m) => ({ default: m.PipelineStudio })),
)
const LibraryView = lazy(() => import('./components/products/LibraryView').then((m) => ({ default: m.LibraryView })))
const MatchView = lazy(() => import('./components/products/MatchView').then((m) => ({ default: m.MatchView })))

const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches
const SHORTCUTS: Record<string, ViewMode> = { '1': 'split', '2': 'chat', '3': 'pipeline', '4': 'library', '5': 'match' }

export default function App() {
  const { health, graph, documents, error, indexNotice } = useBackend()
  const nodeIds = useMemo(() => graph?.nodes.map((n) => n.id) ?? [], [graph])
  const chat = useChat(nodeIds)
  const [view, setView] = useState<ViewMode>(() => (isDesktop() ? 'split' : 'chat'))
  const desktop = useMediaQuery('(min-width: 1024px)')

  // ── Chat sessions (history drawer) ──────────────────────────────────────
  const [sessions, setSessions] = useState<ChatSession[]>(loadSessions)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [history, setHistory] = useState<{ open: boolean; now: number }>({ open: false, now: 0 })

  // Auto-save the active conversation whenever a turn finishes (browser-local only).
  useEffect(() => {
    if (chat.streaming || !sessionId || chat.messages.length === 0) return
    saveSessions(upsertSession(loadSessions(), sessionId, chat.messages, Date.now()))
  }, [chat.messages, chat.streaming, sessionId])

  const changeView = useCallback((v: ViewMode) => setView(v === 'split' && !isDesktop() ? 'chat' : v), [])
  const { send: sendChat, reset, load } = chat

  const send = useCallback(
    (q: string) => {
      if (!sessionId) setSessionId(crypto.randomUUID())
      void sendChat(q)
    },
    [sessionId, sendChat],
  )

  const newChat = useCallback(() => {
    reset()
    setSessionId(null)
    setHistory((h) => ({ ...h, open: false }))
  }, [reset])

  const openHistory = useCallback(() => {
    setSessions(loadSessions())
    setHistory({ open: true, now: Date.now() })
  }, [])

  const openSession = (id: string) => {
    const s = sessions.find((x) => x.id === id)
    if (!s) return
    load(s.messages)
    setSessionId(id)
    setHistory((h) => ({ ...h, open: false }))
    setView((v) => (v === 'library' || v === 'match' ? (isDesktop() ? 'split' : 'chat') : v))
  }

  const removeSession = (id: string) => {
    const next = deleteSession(loadSessions(), id)
    saveSessions(next)
    setSessions(next)
    if (id === sessionId) {
      reset()
      setSessionId(null)
    }
  }

  // Ask from another product (e.g. a Library suggested question) → jump to the assistant.
  const askFromProduct = useCallback(
    (q: string) => {
      setView(isDesktop() ? 'split' : 'chat')
      send(q)
    },
    [send],
  )

  // Keyboard shortcuts: Alt+1…5 switch views, Alt+H toggles history.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return
      if (e.key.toLowerCase() === 'h') {
        e.preventDefault()
        if (history.open) setHistory((h) => ({ ...h, open: false }))
        else openHistory()
        return
      }
      const next = SHORTCUTS[e.key]
      if (next) {
        e.preventDefault()
        changeView(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [changeView, history.open, openHistory])

  const { select } = chat
  const inspect = useCallback(
    (id: string) => {
      select(id)
      setView((v) => (v === 'chat' ? (isDesktop() ? 'split' : 'pipeline') : v))
    },
    [select],
  )

  const live = chat.workflow
  const activeNode = live.running ? live.path[live.path.length - 1] : undefined
  const stage = activeNode ? NODE_STAGE[activeNode] : undefined
  const ready = !!graph && !error

  const chatPanel = (
    <Panel>
      <ChatPanel
        messages={chat.messages}
        streaming={chat.streaming}
        ready={ready}
        stage={stage}
        selectedId={chat.selectedId}
        memory={{ used: chat.memoryTurns, max: MEMORY_TURNS }}
        onSend={send}
        onStop={chat.stop}
        onInspect={inspect}
      />
    </Panel>
  )

  const studioPanel = (
    <Panel>
      {graph ? (
        <Suspense fallback={<Loading label="Loading pipeline studio…" />}>
          <PipelineStudio
            topology={graph}
            run={chat.run}
            health={health}
            messages={chat.messages}
            selectedId={chat.selectedId}
            onSelect={chat.select}
          />
        </Suspense>
      ) : (
        <Loading label={error ? `Backend unreachable: ${error}` : 'Connecting to backend…'} />
      )}
    </Panel>
  )

  let content: ReactNode
  // Mount each panel exactly once: Workspace falls back to chat-only below the desktop breakpoint.
  if (view === 'split') content = desktop ? <SplitPane left={chatPanel} right={studioPanel} /> : chatPanel
  else if (view === 'chat') content = chatPanel
  else if (view === 'pipeline') content = studioPanel
  else
    content = (
      <Panel>
        <Suspense fallback={<Loading label="Loading…" />}>
          {view === 'library' ? <LibraryView documents={documents} onAsk={askFromProduct} /> : <MatchView />}
        </Suspense>
      </Panel>
    )

  return (
    <MotionConfig reducedMotion="user">
      <Backdrop />
      <div className="flex h-full flex-col">
        <TopBar
          view={view}
          onView={changeView}
          health={health}
          documents={documents}
          error={error}
          streaming={chat.streaming}
          onReset={newChat}
          canReset={chat.messages.length > 0}
          onHistory={openHistory}
        />
        <main className="min-h-0 flex-1 p-2 sm:p-3">{content}</main>
      </div>
      <IndexToast notice={indexNotice} />
      <HistoryDrawer
        open={history.open}
        now={history.now}
        sessions={sessions}
        activeId={sessionId}
        onClose={() => setHistory((h) => ({ ...h, open: false }))}
        onOpen={openSession}
        onDelete={removeSession}
        onNew={newChat}
      />
    </MotionConfig>
  )
}

function Panel({ children }: { children: ReactNode }) {
  return <div className="glass h-full min-h-0 overflow-hidden rounded-2xl">{children}</div>
}

function Loading({ label }: { label: string }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <p className="text-shimmer text-sm font-medium">{label}</p>
    </div>
  )
}

/** "Documents changed → re-indexed" toast, driven by the backend's document watcher. */
function IndexToast({ notice }: { notice: ReturnType<typeof useBackend>['indexNotice'] }) {
  const [dismissed, setDismissed] = useState<typeof notice>(null)
  const shown = notice && notice !== dismissed ? notice : null
  useEffect(() => {
    if (!shown) return
    const t = window.setTimeout(() => setDismissed(shown), 6000)
    return () => window.clearTimeout(t)
  }, [shown])
  if (!shown) return null
  const parts = [
    shown.added.length && `${shown.added.length} added`,
    shown.updated.length && `${shown.updated.length} updated`,
    shown.removed.length && `${shown.removed.length} removed`,
  ].filter(Boolean)
  return (
    <div role="status" className="glass fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-[13px] text-white">
      Documents changed · re-indexed ({parts.join(', ')}; {shown.chunks_written} chunks)
    </div>
  )
}
