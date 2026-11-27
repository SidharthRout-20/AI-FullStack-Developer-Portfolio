import { MotionConfig } from 'motion/react'
import { API_BASE } from './lib/apiBase'
import { LITE } from './lib/lite'
import { trackView, watchClicks } from './lib/visits'
import { lazy, Suspense, useEffect, useState } from 'react'
import { Backdrop } from './components/shell/Backdrop'
import { AppSkeleton, PageSkeleton } from './components/Skeleton'
import { CommandPalette } from './site/CommandPalette'
import { Link, usePath } from '@appcore/web/router'
import { ShellProvider } from '@appcore/web/ui'
import { SITE } from './site/config'
import { setSkin } from './theme/theme'
import { HubPage } from './site/HubPage'
import { productBySlug } from './site/products'
import { SkinWelcome } from './theme/SkinWelcome'
import { ThemeToggle } from './theme/ThemeToggle'
import { AccountButton } from './site/AccountButton'

// Each product app is its own code-split chunk: the hub never downloads DocuMind's code.
const DocuMindApp = lazy(() => import('./App'))
const KeeperApp = lazy(() => import('./products/keeper/KeeperApp'))
const ProductPage = lazy(() => import('./site/ProductPage').then((m) => ({ default: m.ProductPage })))
const QualityPage = lazy(() => import('./site/QualityPage').then((m) => ({ default: m.QualityPage })))
const InsightsPage = lazy(() => import('./site/InsightsPage').then((m) => ({ default: m.InsightsPage })))
const ControlPage = lazy(() => import('./site/ControlPage').then((m) => ({ default: m.ControlPage })))

// Every product is its own code-split chunk, loaded only when opened.
const APPS = [
  { labs: true, prefix: '/careerpilot', title: 'CareerPilot · Job-hunt copilot', label: 'CareerPilot', App: lazy(() => import('./products/careerpilot/CareerPilotApp')) },
  { labs: true, prefix: '/meetingmind', title: 'MeetingMind · Meeting intelligence', label: 'MeetingMind', App: lazy(() => import('./products/meetingmind/MeetingMindApp')) },
  { prefix: '/codelens', title: 'CodeLens · Onboard onto any codebase', label: 'CodeLens', App: lazy(() => import('./products/codelens/CodeLensApp')) },
  { labs: true, prefix: '/flowforge', title: 'FlowForge · AI automation builder', label: 'FlowForge', App: lazy(() => import('./products/flowforge/FlowForgeApp')) },
  { labs: true, prefix: '/evolve', title: 'Evolve · Self-improving prompts', label: 'Evolve', App: lazy(() => import('./products/evolve/EvolveApp')) },
  { prefix: '/jasoos', title: 'Jasoos · Build-failure detective', label: 'Jasoos', App: lazy(() => import('./products/efi/EFIApp')) },
  // Safarnaama lives in products/safarnama/web (its own app); the portfolio embeds it at /safarnaama.
  { prefix: '/safarnaama', title: 'Safarnaama · Travel companion', label: 'Safarnaama', App: lazy(() => import('@safarnama/web/App')), props: { basePath: '/safarnaama' } },
]
/** Apps that were renamed: old links (including shared trip links) keep working and land on the new address. */
const RENAMED = { '/efi': '/jasoos', '/tripweaver': '/safarnaama', '/safarnama': '/safarnaama', '/tara': '/keeper', '/tijori': '/keeper' }

function useTitle(title) {
  useEffect(() => {
    document.title = title
  }, [title])
}

// Every product page gets the portfolio's backdrop, sign-in, its skin-aware theme toggle and a link back to the hub.
function HeaderControls() {
  return (
    <div className="flex items-center gap-2">
      <AccountButton />
      <ThemeToggle />
    </div>
  )
}

const HOME = { to: '/', label: 'All products', short: 'Products' }

export function Root() {
  return (
    <ShellProvider backdrop={Backdrop} controls={HeaderControls} home={HOME}>
      <Routes />
      <CommandPalette />
      <SkinWelcome />
      {import.meta.env.DEV && <DevBackend />}
    </ShellProvider>
  )
}

function Routes() {
  const path = usePath()
  useEffect(() => trackView(path), [path])
  useEffect(() => watchClicks(SITE.resume), [])

  // The old preview address of the personal space: open the personal space itself.
  if (path === '/preview/playful' || path === '/preview/playful/') return <ToPersonal />
  if (path === '/documind' || path.startsWith('/documind/')) return <DocuMindRoute />
  if (path === '/keeper' || path.startsWith('/keeper/')) return <KeeperRoute />
  const renamed = Object.keys(RENAMED).find((p) => path === p || path.startsWith(`${p}/`))
  if (renamed) return <Redirect to={RENAMED[renamed] + path.slice(renamed.length) + window.location.search} />
  const app = APPS.find((a) => path === a.prefix || path.startsWith(`${a.prefix}/`))
  if (app) return <ProductRoute {...app} />

  const slug = path.match(/^\/products\/([\w-]+)\/?$/)?.[1]
  const product = slug ? productBySlug(slug) : undefined
  // Labs products open straight into their app; portfolio products have a product page (status, roadmap, app link).
  if (product?.visibility === 'labs' && product.app) return <Redirect to={product.app.route} />

  return (
    <MotionConfig reducedMotion={LITE ? 'always' : 'user'}>
      <Backdrop />
      <Suspense fallback={<PageSkeleton />}>
        {path === '/' ? <Hub /> : path === '/quality' || path === '/quality/' ? <Quality /> : path === '/insights' || path === '/insights/' ? <Insights /> : path === '/control' || path === '/control/' ? <Control /> : product ? <Preview slug={product.slug} /> : <NotFound />}
      </Suspense>
    </MotionConfig>
  )
}

function Hub() {
  useTitle(`${SITE.owner} · AI Product Portfolio`)
  return <HubPage />
}

function Quality() {
  useTitle(`Quality · ${SITE.owner}`)
  return <QualityPage />
}

function ToPersonal() {
  useEffect(() => setSkin('personal'), [])
  return <Redirect to="/" />
}

function Control() {
  useTitle(`Control room · ${SITE.owner}`)
  return <ControlPage />
}

function Insights() {
  useTitle(`Insights · ${SITE.owner}`)
  return <InsightsPage />
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
      fallback={<AppSkeleton label={'Opening DocuMind'} />}
    >
      <DocuMindApp />
    </Suspense>
  )
}

function ProductRoute({ title, label, App, props, labs = false }) {
  useTitle(title)
  const open = useLabsOpen(labs)
  if (labs && open === false) return <Paused label={label} />
  return (
    <Suspense
      fallback={<AppSkeleton label={`Opening ${label}`} />}
    >
      <App {...props} />
    </Suspense>
  )
}

/** The in-development apps keep one shared store for every visitor, so they are paused until they have per-person
 * data (the owner can open them in the control room). null while asking; true if the API doesn't say. */
function useLabsOpen(labs) {
  const [open, setOpen] = useState(labs ? null : true)
  useEffect(() => {
    if (!labs) return
    let live = true
    fetch(`${API_BASE}/api/control/public`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setOpen(d?.products?.labs !== false))
      .catch(() => live && setOpen(true))
    return () => {
      live = false
    }
  }, [labs])
  return open
}

function Paused({ label }) {
  return (
    <main className="mx-auto grid min-h-[70vh] max-w-xl place-items-center px-6 text-center">
      <div>
        <p className="text-[12px] font-semibold tracking-[0.18em] text-cyan-300 uppercase">In development</p>
        <h1 className="mt-3 text-[28px] font-semibold text-white">{label} is paused for now</h1>
        <p className="mt-3 text-[15px] text-ink-300">
          It opens again once it keeps each person's data separate, like the four featured products. Until then, try one of those.
        </p>
        <Link to="/" className="mt-6 inline-block rounded-full bg-white/[0.08] px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-white/[0.14]">See the products</Link>
      </div>
    </main>
  )
}

function KeeperRoute() {
  useTitle('Tara · Personal assistant')
  return (
    <Suspense
      fallback={<AppSkeleton label={'Opening Tara'} />}
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

/** Development only: which backend this page talks to. `npm run dev` uses the DEPLOYED one, so backend changes made
 * on this machine are not in it; `npm run dev:local` (with the backend running) uses the local code. */
function DevBackend() {
  const local = /127\.0\.0\.1|localhost/.test(API_BASE)
  return (
    <p
      title={local ? 'Using the backend running on this machine.' : 'Backend changes on this machine are NOT used. Run the backend and `npm run dev:local` to try them.'}
      style={{ position: 'fixed', left: 8, bottom: 8, zIndex: 80, margin: 0, padding: '3px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, fontFamily: 'system-ui', background: local ? '#065f46' : '#92400e', color: '#fff', opacity: 0.9, pointerEvents: 'auto' }}
    >
      API: {local ? 'local backend' : 'deployed backend (local backend changes not used)'}
    </p>
  )
}
