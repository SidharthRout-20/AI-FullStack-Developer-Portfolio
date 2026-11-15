import { MotionConfig } from 'motion/react'
import { lazy, Suspense, useEffect } from 'react'
import { Backdrop } from './components/shell/Backdrop'
import { CommandPalette } from './site/CommandPalette'
import { Link, usePath } from './router'
import { SITE } from './site/config'
import { HubPage } from './site/HubPage'
import { ProductPage } from './site/ProductPage'
import { productBySlug } from './site/products'

// Each product app is its own code-split chunk: the hub never downloads DocuMind's code.
const DocuMindApp = lazy(() => import('./App'))
const KeeperApp = lazy(() => import('./products/keeper/KeeperApp'))

// Every product is its own code-split chunk, loaded only when opened.
const APPS = [
  { prefix: '/careerpilot', title: 'CareerPilot · Job-hunt copilot', label: 'CareerPilot', App: lazy(() => import('./products/careerpilot/CareerPilotApp')) },
  { prefix: '/meetingmind', title: 'MeetingMind · Meeting intelligence', label: 'MeetingMind', App: lazy(() => import('./products/meetingmind/MeetingMindApp')) },
  { prefix: '/codelens', title: 'CodeLens · Codebase explorer', label: 'CodeLens', App: lazy(() => import('./products/codelens/CodeLensApp')) },
  { prefix: '/flowforge', title: 'FlowForge · AI automation builder', label: 'FlowForge', App: lazy(() => import('./products/flowforge/FlowForgeApp')) },
  { prefix: '/evolve', title: 'Evolve · Self-improving prompts', label: 'Evolve', App: lazy(() => import('./products/evolve/EvolveApp')) },
  { prefix: '/efi', title: 'EFI · Engineering Failure Investigator', label: 'EFI', App: lazy(() => import('./products/efi/EFIApp')) },
  { prefix: '/tripweaver', title: 'TripWeaver · Travel ecosystem', label: 'TripWeaver', App: lazy(() => import('./products/tripweaver/TripWeaverApp')) },
]

function useTitle(title) {
  useEffect(() => {
    document.title = title
  }, [title])
}

export function Root() {
  return (
    <>
      <Routes />
      <CommandPalette />
    </>
  )
}

function Routes() {
  const path = usePath()

  if (path === '/documind' || path.startsWith('/documind/')) return <DocuMindRoute />
  if (path === '/keeper' || path.startsWith('/keeper/')) return <KeeperRoute />
  const app = APPS.find((a) => path === a.prefix || path.startsWith(`${a.prefix}/`))
  if (app) return <ProductRoute {...app} />

  const slug = path.match(/^\/products\/([\w-]+)\/?$/)?.[1]
  const product = slug ? productBySlug(slug) : undefined
  // Labs products open straight into their app; portfolio products have a product page (status, roadmap, app link).
  if (product?.visibility === 'labs' && product.app) return <Redirect to={product.app.route} />

  return (
    <MotionConfig reducedMotion="user">
      <Backdrop />
      {path === '/' ? <Hub /> : product ? <Preview slug={product.slug} /> : <NotFound />}
    </MotionConfig>
  )
}

function Hub() {
  useTitle(`${SITE.owner} · AI Product Portfolio`)
  return <HubPage />
}

function Preview({ slug }) {
  const product = productBySlug(slug)
  useTitle(`${product.fullName ?? product.name} · ${SITE.owner}`)
  return <ProductPage product={product} />
}

function DocuMindRoute() {
  useTitle('DocuMind · RAG Studio')
  return (
    <Suspense
      fallback={
        <div className="grid h-full place-items-center">
          <p className="text-shimmer text-sm font-medium">Launching DocuMind…</p>
        </div>
      }
    >
      <DocuMindApp />
    </Suspense>
  )
}

function ProductRoute({ title, label, App }) {
  useTitle(title)
  return (
    <Suspense
      fallback={
        <div className="grid h-full place-items-center">
          <p className="text-shimmer text-sm font-medium">Opening {label}…</p>
        </div>
      }
    >
      <App />
    </Suspense>
  )
}

function KeeperRoute() {
  useTitle('Keeper · Personal assistant')
  return (
    <Suspense
      fallback={
        <div className="grid h-full place-items-center">
          <p className="text-shimmer text-sm font-medium">Opening Keeper…</p>
        </div>
      }
    >
      <KeeperApp />
    </Suspense>
  )
}

function Redirect({ to }) {
  useEffect(() => {
    window.history.replaceState(null, '', to)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, [to])
  return null
}

function NotFound() {
  useTitle(`Not found · ${SITE.owner}`)
  return (
    <div className="grid min-h-full place-items-center p-6 text-center">
      <div>
        <p className="font-mono text-6xl font-semibold text-white">404</p>
        <p className="mt-2 text-ink-300">That page doesn't exist.</p>
        <Link to="/" className="mt-6 inline-block rounded-xl bg-white px-4 py-2 text-sm font-semibold text-ink-950">
          Back to products
        </Link>
      </div>
    </div>
  )
}
