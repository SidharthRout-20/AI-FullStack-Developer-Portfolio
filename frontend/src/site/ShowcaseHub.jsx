/**
 * The Studio: the landing page most visitors (and recruiters) see first. Product-first and calm, in the style of a
 * premium product site: system type, big headlines, whitespace, one blue accent, and scroll-driven motion
 * (an expanding hero stage, a scroll-lit statement, a sticky product story, a drawn timeline).
 *
 * Same content as Off the clock: config.js and the product registry. Every effect is decorative, and with
 * prefers-reduced-motion the page renders static (scroll-linked styles are skipped, sticky stages collapse).
 */
import { BrainCircuit, ChevronLeft, ChevronRight, Download, Lock, Mail, Menu, PanelsTopLeft, Search, ServerCog, X } from 'lucide-react'
import { AnimatePresence, motion, useInView, useReducedMotion, useScroll, useSpring, useTransform } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { Link } from '@appcore/web/router'
import { SKIN_NAMES } from '../theme/skin'
import { originOf, setSkin } from '../theme/theme'
import { ThemeToggle } from '../theme/ThemeToggle'
import { openPalette } from './CommandPalette'
import { EXPERTISE, SITE, TIMELINE } from './config'
import { ContactForm } from './HubPage'
import { MiniPortrait } from './Portrait'
import { FROZEN, PORTFOLIO, productHref, STATUSES } from './products'
import { CountUp, Reveal } from './scrollFx'

const EASE = [0.25, 0.1, 0.25, 1]
const NAV = [
  { id: 'overview', label: 'Overview' },
  { id: 'projects', label: 'Products' },
  { id: 'labs', label: 'In development' },
  { id: 'expertise', label: 'Skills' },
  { id: 'experience', label: 'Experience' },
]
/** Screenshots that exist in public/projects (the others get an icon tile). */
const SHOTS = new Set(['careerpilot', 'codelens', 'documind', 'evolve', 'flowforge', 'jasoos', 'keeper', 'meetingmind', 'safarnaama', 'tara', 'tripweaver'])
const shotOf = (p) => {
  const key = p.image ?? p.slug
  return SHOTS.has(key) ? `/projects/${key}.webp` : null
}
const EXPERTISE_ICON = { ui: PanelsTopLeft, ai: BrainCircuit, api: ServerCog }
const NUMBER_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
const inWords = (n) => NUMBER_WORDS[n] ?? String(n)

// ── Navigation ───────────────────────────────────────────────────────────────
function useActiveSection(enabled) {
  const [active, setActive] = useState(null)
  useEffect(() => {
    if (!enabled) return
    const els = NAV.map((n) => document.getElementById(n.id)).filter(Boolean)
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setActive(e.target.id)),
      { rootMargin: '-45% 0px -50% 0px' },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [enabled])
  return active
}

export function ShowcaseNav({ home = false }) {
  const [open, setOpen] = useState(false)
  const active = useActiveSection(home)
  const href = (id) => (home ? `#${id}` : `/#${id}`)
  useEffect(() => {
    if (!open) return
    const close = (e) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])
  return (
    <header className="sc-nav fixed inset-x-0 top-0 z-40">
      <a href={href('projects')} className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:rounded-full focus:bg-[color:var(--sc-blue)] focus:px-3 focus:py-1.5 focus:text-[13px] focus:text-white">
        Skip to the products
      </a>
      <div className="mx-auto flex h-12 max-w-6xl items-center gap-6 px-5">
        <Link to="/" className="text-[15px] font-semibold tracking-tight text-white" onClick={() => home && window.scrollTo({ top: 0, behavior: 'smooth' })}>
          {SITE.owner}
        </Link>
        <nav aria-label="Sections" className="mx-auto hidden lg:block">
          <ul className="flex items-center gap-7">
            {NAV.map((n) => (
              <li key={n.id}>
                <a
                  href={href(n.id)}
                  aria-current={active === n.id ? 'true' : undefined}
                  className={`relative text-[12.5px] transition-colors ${active === n.id ? 'text-white' : 'text-ink-400 hover:text-white'}`}
                >
                  {n.label}
                  {active === n.id && <motion.span layoutId="sc-nav-dot" className="absolute -bottom-[15px] left-0 h-[2px] w-full rounded-full bg-[color:var(--sc-blue)]" />}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-1.5 lg:ml-0">
          <button type="button" onClick={openPalette} aria-label="Search products and actions" className="grid size-8 place-items-center rounded-full text-ink-300 transition hover:text-white">
            <Search className="size-4" />
          </button>
          <ThemeToggle compact className="hidden sm:flex" />
          <a href={href('contact')} className="sc-pill hidden !px-3.5 !py-1 !text-[12.5px] md:inline-flex">Get in touch</a>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} className="grid size-8 place-items-center text-ink-200 lg:hidden">
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </div>
      <AnimatePresence>
        {open && (
          <motion.nav
            aria-label="Sections"
            initial={{ height: 0 }}
            animate={{ height: '100svh' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="overflow-hidden lg:hidden"
          >
            <ul className="px-8 pt-6 pb-10">
              {[...NAV, { id: 'contact', label: 'Contact' }].map((n, i) => (
                <motion.li key={n.id} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 + i * 0.035 }}>
                  <a href={href(n.id)} onClick={() => setOpen(false)} className="block py-2 text-[28px] font-semibold tracking-tight text-white">{n.label}</a>
                </motion.li>
              ))}
              <motion.li initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.35 }} className="mt-8 flex items-center gap-3 sm:hidden">
                <ThemeToggle />
              </motion.li>
            </ul>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export function ShowcaseHub() {
  return (
    <div className="sc-page min-h-full overflow-x-clip">
      <ShowcaseNav home />
      <main>
        <Hero />
        <Statement />
        <Glance />
        <Products />
        <Labs />
        <Skills />
        <Experience />
        <Contact />
      </main>
      <Footer />
    </div>
  )
}

function SectionHead({ eyebrow, title, text, center = false, className = '' }) {
  return (
    <Reveal className={`mx-auto max-w-6xl px-5 ${center ? 'text-center' : ''} ${className}`}>
      {eyebrow && <p className="sc-eyebrow text-ink-500">{eyebrow}</p>}
      <h2 className="sc-headline mt-1 text-[40px] text-white sm:text-[56px] lg:text-[64px]">{title}</h2>
      {text && <p className={`mt-4 max-w-2xl text-[19px] leading-snug text-ink-400 sm:text-[21px] ${center ? 'mx-auto' : ''}`}>{text}</p>}
    </Reveal>
  )
}

/** A screen in a slim bezel, like a display. */
function Screen({ src, alt = '', className = '', children }) {
  return (
    <div className={`sc-screen ${className}`}>
      {src ? <img src={src} alt={alt} className="block aspect-[16/10] w-full rounded-[10px] object-cover object-top" /> : children}
    </div>
  )
}

// ── Hero: headline, then a stage of screens that grows to fill the view as you scroll ──
function Hero() {
  const ref = useRef(null)
  const reduce = useReducedMotion()
  const { scrollYProgress: p } = useScroll({ target: ref, offset: ['start start', 'end end'] })
  const textOpacity = useTransform(p, [0, 0.3], [1, 0])
  const textY = useTransform(p, [0, 0.3], [0, -60])
  const roomy = useMediaQuery('(min-width: 768px)')
  const stageScale = useTransform(p, [0, 0.65], [roomy ? 0.66 : 0.9, 1])
  // The stage rises by the height of the headline block, so it ends up just under the nav at any screen size.
  const textRef = useRef(null)
  const [textH, setTextH] = useState(400)
  useEffect(() => {
    const el = textRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setTextH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const stageY = useTransform(p, [0, 0.65], [0, -textH])
  const sideOut = useTransform(p, [0.1, 0.75], ['0%', '58%'])
  const sideOutL = useTransform(sideOut, (v) => `-${v}`)
  const sideTilt = useTransform(p, [0.1, 0.75], [0, 5])
  const sideTiltL = useTransform(sideTilt, (v) => -v)
  const sideOpacity = useTransform(p, [0.05, 0.3], [0, 1])
  const s = (styles) => (reduce ? undefined : styles)

  return (
    <section ref={ref} id="overview" className={`relative scroll-mt-12 ${reduce ? '' : 'h-[175svh]'}`}>
      <div className={`${reduce ? '' : 'sticky top-0 h-[100svh]'} flex flex-col items-center overflow-hidden px-5 pt-24 text-center sm:pt-28`}>
        <motion.div ref={textRef} style={s({ opacity: textOpacity, y: textY })}>
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE }}
            className="inline-flex items-center gap-2 rounded-full bg-[color:var(--sc-chip)] py-1 pr-3.5 pl-1 text-[13px] font-medium text-ink-200"
          >
            <MiniPortrait className="size-6 text-[22px]" />
            {SITE.owner} · {SITE.role}
          </motion.p>
          <h1 className="sc-headline mx-auto mt-5 max-w-4xl text-[48px] text-white sm:text-[80px] lg:text-[96px]">
            <MaskLine delay={0.1}>AI products.</MaskLine>
            <MaskLine delay={0.22} className="text-gradient">Built end to end.</MaskLine>
          </h1>
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45, duration: 0.7, ease: EASE }}
            className="mx-auto mt-5 max-w-2xl text-[19px] leading-snug text-ink-400 sm:text-[23px]"
          >
            {SITE.headline}
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.55, duration: 0.7, ease: EASE }}
            className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-3"
          >
            <a href="#projects" className="sc-pill">See the products</a>
            <a href="#contact" className="sc-link inline-flex items-center text-[17px]">Get in touch <ChevronRight className="size-4" /></a>
            {SITE.resume && (
              <a href={SITE.resume} target="_blank" rel="noreferrer" className="sc-link inline-flex items-center gap-1 text-[17px]">Résumé <Download className="size-4" /></a>
            )}
          </motion.div>
          {SITE.availability && (
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.75 }} className="mt-5 text-[13px] text-ink-500">
              <span className="mr-2 inline-block size-1.5 rounded-full bg-[#30d158] align-middle" />
              {SITE.availability} · {SITE.location}
            </motion.p>
          )}
        </motion.div>

        <motion.div
          aria-hidden
          initial={{ opacity: 0, y: 60 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35, duration: 1.1, ease: EASE }}
          className="relative mt-10 w-full max-w-5xl shrink-0 sm:mt-14"
        >
          <motion.div style={s({ scale: stageScale, y: stageY })} className="relative origin-top">
            <motion.div style={s({ x: sideOutL, rotate: sideTiltL, opacity: sideOpacity })} className="absolute top-[8%] left-[18%] w-[62%]">
              <Screen src="/projects/documind.webp" />
            </motion.div>
            <motion.div style={s({ x: sideOut, rotate: sideTilt, opacity: sideOpacity })} className="absolute top-[8%] right-[18%] w-[62%]">
              <Screen src="/projects/keeper.webp" />
            </motion.div>
            <Screen src="/projects/tripweaver.webp" className="relative mx-auto w-[78%] shadow-[0_50px_100px_-40px_rgb(0_0_0/0.55)]" />
          </motion.div>
        </motion.div>
      </div>
    </section>
  )
}

/** One line of the hero headline, rising from behind a mask. */
function MaskLine({ children, delay = 0, className = '' }) {
  return (
    <span className="block overflow-hidden pb-[0.08em]">
      <motion.span
        className={`block ${className}`}
        initial={{ y: '105%' }}
        animate={{ y: '0%' }}
        transition={{ delay, duration: 0.9, ease: [0.2, 0.8, 0.2, 1] }}
      >
        {children}
      </motion.span>
    </span>
  )
}

// ── Statement: words light up as you read down ──────────────────────────────
function Statement() {
  const ref = useRef(null)
  const reduce = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 0.85', 'end 0.4'] })
  const words = SITE.statement.split(' ')
  if (!SITE.statement) return null
  return (
    <section className="px-5 py-24 sm:py-36">
      <p ref={ref} className="sc-headline mx-auto max-w-4xl text-[30px] leading-[1.15] text-white sm:text-[44px] lg:text-[52px]">
        {words.map((w, i) => (
          <LitWord key={i} progress={scrollYProgress} range={[i / words.length, (i + 1) / words.length]} still={reduce}>
            {w}
          </LitWord>
        ))}
      </p>
    </section>
  )
}

function LitWord({ children, progress, range, still }) {
  const opacity = useTransform(progress, range, [0.16, 1])
  return (
    <motion.span style={still ? undefined : { opacity }}>
      {children}{' '}
    </motion.span>
  )
}

// ── The short version: numbers and facts for a quick read ──────────────────
function Glance() {
  const stats = [
    { value: `${SITE.years}+`, label: 'years building software' },
    { value: `${PORTFOLIO.length}`, label: 'AI products in the portfolio' },
    { value: `${SITE.clientCount}`, label: 'enterprise clients served' },
  ]
  const facts = [
    { k: 'Role', v: SITE.role },
    { k: 'Currently', v: SITE.current },
    { k: 'Based in', v: SITE.location },
    { k: 'Industries', v: SITE.industries.join(', ') },
    { k: 'Focus', v: 'Generative AI, RAG and agents · React · Python APIs' },
  ]
  return (
    <section className="sc-band py-24 sm:py-32">
      <SectionHead eyebrow="At a glance" title="The short version." />
      <dl className="mx-auto mt-14 grid max-w-6xl gap-10 px-5 sm:grid-cols-3">
        {stats.map((s, i) => (
          <Reveal key={s.label} delay={i * 0.08}>
            <dt className="sc-headline text-[64px] text-white sm:text-[80px]"><CountUp value={s.value} /></dt>
            <dd className="mt-1 text-[17px] text-ink-400">{s.label}</dd>
          </Reveal>
        ))}
      </dl>
      <div className="mx-auto mt-16 grid max-w-6xl gap-4 px-5 md:grid-cols-[1.4fr_1fr]">
        <Reveal className="sc-tile p-7 sm:p-9">
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            {facts.map((f) => (
              <div key={f.k}>
                <dt className="text-[13px] font-semibold text-ink-500">{f.k}</dt>
                <dd className="mt-0.5 text-[17px] leading-snug text-white">{f.v}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
        <Reveal delay={0.08} className="sc-tile sc-on-dark flex flex-col justify-between gap-8 p-7 sm:p-9">
          <div>
            <p className="text-[13px] font-semibold text-[#a1a1a6]">Hiring, or have an idea?</p>
            <p className="sc-headline mt-1 text-[32px] text-[#f5f5f7]">Let's talk.</p>
          </div>
          <div className="flex flex-col items-start gap-3">
            <a href="#contact" className="sc-pill">Get in touch</a>
            {SITE.resume && <a href={SITE.resume} target="_blank" rel="noreferrer" className="sc-link inline-flex items-center gap-1 text-[17px]">Download résumé <Download className="size-4" /></a>}
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[15px]">
              {SITE.links.linkedin && <a href={SITE.links.linkedin} target="_blank" rel="noreferrer" className="sc-link inline-flex items-center">LinkedIn <ChevronRight className="size-4" /></a>}
              {SITE.links.github && <a href={SITE.links.github} target="_blank" rel="noreferrer" className="sc-link inline-flex items-center">GitHub <ChevronRight className="size-4" /></a>}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

// ── Products: a sticky screen that changes as you read through each product ─
function Products() {
  const [active, setActive] = useState(0)
  const wide = useMediaQuery('(min-width: 1024px)')
  const p = PORTFOLIO[active]
  return (
    <section id="projects" className="scroll-mt-12 py-24 sm:py-32">
      <SectionHead
        eyebrow="The products"
        title="Got one of these problems?"
        text={`${inWords(PORTFOLIO.length)} products, each solving one problem end to end. Find yours, then try it: no sign-up needed.`}
      />
      <p className="mt-3 text-center"><Link to="/quality" className="sc-link inline-flex items-center text-[16px]">See how each product is measured <ChevronRight className="size-4" /></Link></p>
      <div className="mx-auto mt-10 grid max-w-6xl gap-x-16 px-5 lg:mt-4 lg:grid-cols-[0.95fr_1.05fr]">
        <ol>
          {PORTFOLIO.map((x, i) => (
            <Chapter key={x.slug} p={x} index={i} wide={wide} onActive={setActive} active={active === i} />
          ))}
        </ol>
        <div className="hidden lg:block">
          <div className="sticky top-[calc(50svh-200px)]">
            <div className="relative">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div
                  key={p.slug}
                  initial={{ opacity: 0, scale: 1.04, filter: 'blur(8px)' }}
                  animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, scale: 0.97, filter: 'blur(6px)' }}
                  transition={{ duration: 0.55, ease: EASE }}
                >
                  <ProductVisual p={p} />
                </motion.div>
              </AnimatePresence>
            </div>
            <div className="mt-6 flex items-center justify-center gap-2" aria-hidden>
              {PORTFOLIO.map((x, i) => (
                <motion.span key={x.slug} animate={{ width: i === active ? 24 : 8 }} className={`h-2 rounded-full ${i === active ? 'bg-ink-100' : 'bg-ink-600'}`} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function ProductVisual({ p, small = false }) {
  const shot = shotOf(p)
  const Icon = p.icon
  if (shot) return <Screen src={shot} alt={`${p.name} screenshot`} />
  return (
    <div className="sc-screen">
      <div className={`relative grid aspect-[16/10] w-full place-items-center overflow-hidden rounded-[10px] bg-gradient-to-br ${p.accent}`}>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgb(255_255_255/0.35),transparent_55%)]" />
        <span className={`relative grid place-items-center rounded-[28%] bg-black/20 text-on-accent backdrop-blur ${small ? 'size-20' : 'size-28'}`}>
          <Icon className={small ? 'size-10' : 'size-14'} strokeWidth={1.6} />
        </span>
      </div>
    </div>
  )
}

function Chapter({ p, index, wide, onActive, active }) {
  const ref = useRef(null)
  const inView = useInView(ref, { margin: '-45% 0px -45% 0px' })
  useEffect(() => {
    if (inView) onActive(index)
  }, [inView, index, onActive])
  const status = STATUSES[p.status]?.label ?? p.status
  const isNew = p.status === 'beta'
  return (
    <li ref={ref} className="flex flex-col justify-center border-t border-[color:var(--hairline)] py-12 first:border-t-0 lg:min-h-[72svh] lg:border-t-0 lg:py-0">
      <motion.div animate={{ opacity: !wide || active ? 1 : 0.28 }} transition={{ duration: 0.4 }}>
        <p className="flex items-center gap-3 text-[13px] font-semibold">
          <span className="text-ink-500 tabular-nums">0{index + 1}</span>
          <span className={isNew ? 'sc-new' : 'text-ink-500'}>{status}</span>
        </p>
        <p className="mt-3 text-[24px] leading-snug font-semibold text-white sm:text-[30px]">{p.problem}</p>
        <p className="mt-4 text-[17px] leading-relaxed text-ink-400">{p.outcome}</p>
        <h3 className="mt-5 text-[15px] font-semibold text-ink-200">That's <span className="text-white">{p.name}</span>{p.meaning && <span className="font-normal text-ink-500 italic"> · {p.meaning}</span>}</h3>
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-[17px]">
          {p.app && (
            <Link to={p.app.route} className="sc-link inline-flex items-center">Try {p.name} <ChevronRight className="size-4" /></Link>
          )}
          <Link to={productHref(p)} className="sc-link inline-flex items-center">How it works <ChevronRight className="size-4" /></Link>
        </div>
        <div className="mt-8 lg:hidden">
          <ProductVisual p={p} small />
        </div>
      </motion.div>
    </li>
  )
}

// ── Labs shelf ───────────────────────────────────────────────────────────────
function Labs() {
  const shelf = useRef(null)
  const page = (dir) => {
    const el = shelf.current
    const tile = el?.querySelector('li')
    if (el && tile) el.scrollBy({ left: dir * (tile.getBoundingClientRect().width + 20), behavior: 'smooth' })
  }
  return (
    <section id="labs" className="sc-band scroll-mt-12 py-24 sm:py-32">
      <SectionHead eyebrow="In development" title="Frozen for now." text="These open once the four above are finished and they work end to end." />
      <ul ref={shelf} className="sc-shelf mt-12 flex gap-5 overflow-x-auto px-5 pb-4 sm:px-[max(1.25rem,calc((100vw-72rem)/2+1.25rem))]">
        {FROZEN.map((p, i) => {
          const shot = shotOf(p)
          return (
            <motion.li
              key={p.slug}
              initial={{ opacity: 0, x: 40 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ delay: i * 0.07, duration: 0.6, ease: EASE }}
              className="w-[280px] shrink-0 sm:w-[360px]"
            >
              <div aria-disabled="true" className="sc-tile group flex h-full flex-col overflow-hidden opacity-70 grayscale">
                <div className="px-7 pt-7">
                  <p className="text-[12px] font-semibold text-ink-500">{p.category.replace('Labs · ', '')}</p>
                  <h3 className="mt-1 text-[24px] font-semibold tracking-tight text-white">{p.name}</h3>
                  {/* Two lines, always: a longer tagline must never push its screenshot lower than its neighbours'. */}
                  <p className="mt-1 line-clamp-2 min-h-[2.75em] text-[15px] leading-snug text-ink-400" title={p.tagline}>{p.tagline}</p>
                  <span className="mt-3 inline-flex items-center gap-1 text-[14px] text-ink-500"><Lock className="size-3.5" /> In development</span>
                </div>
                {shot && (
                  <div className="mt-auto pt-6">
                    <div className="ml-7 overflow-hidden rounded-tl-[12px]">
                      <img src={shot} alt="" loading="lazy" className="aspect-[16/10] w-full object-cover object-left-top transition duration-700 ease-out group-hover:scale-[1.04]" />
                    </div>
                  </div>
                )}
              </div>
            </motion.li>
          )
        })}
      </ul>
      <div className="mx-auto mt-4 flex max-w-6xl justify-end gap-3 px-5">
        <button type="button" onClick={() => page(-1)} aria-label="Previous products in development" className="sc-paddle"><ChevronLeft className="size-5" /></button>
        <button type="button" onClick={() => page(1)} aria-label="Next products in development" className="sc-paddle"><ChevronRight className="size-5" /></button>
      </div>
    </section>
  )
}

// ── Skills ───────────────────────────────────────────────────────────────────
function Skills() {
  return (
    <section id="expertise" className="scroll-mt-12 py-24 sm:py-32">
      <SectionHead eyebrow="Skills" title="From interface to inference." text="The three things I do every day." />
      <div className="mx-auto mt-14 grid max-w-6xl gap-5 px-5 md:grid-cols-3">
        {EXPERTISE.map((x, i) => {
          const Icon = EXPERTISE_ICON[x.icon] ?? BrainCircuit
          return (
            <Reveal key={x.title} delay={i * 0.08} from="scale">
              <div className="sc-tile sc-band sc-lift flex h-full flex-col p-8">
                <Icon className="size-9 text-[color:var(--sc-blue)]" strokeWidth={1.5} />
                <h3 className="mt-6 text-[26px] leading-tight font-semibold tracking-tight text-white">{x.title}</h3>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-400">{x.text}</p>
                <ul className="mt-6 flex flex-wrap gap-1.5">
                  {x.stack.map((s) => <li key={s} className="rounded-full bg-[color:var(--sc-chip)] px-2.5 py-1 text-[12px] text-ink-300">{s}</li>)}
                </ul>
              </div>
            </Reveal>
          )
        })}
      </div>
    </section>
  )
}

// ── Experience: a timeline whose line draws itself as you scroll ───────────
function Experience() {
  const ref = useRef(null)
  const reduce = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 0.75', 'end 0.6'] })
  const draw = useSpring(scrollYProgress, { stiffness: 140, damping: 30 })
  return (
    <section id="experience" className="sc-band scroll-mt-12 py-24 sm:py-32">
      <SectionHead eyebrow="Experience" title={`${SITE.years} years, from mainframes to model calls.`} />
      <ol ref={ref} className="relative mx-auto mt-14 max-w-6xl px-5">
        <span aria-hidden className="absolute top-2 bottom-2 left-[27px] w-px bg-[color:var(--hairline)] md:left-[calc(1.25rem+247px)]" />
        <motion.span aria-hidden style={reduce ? undefined : { scaleY: draw }} className="absolute top-2 bottom-2 left-[27px] w-px origin-top bg-[color:var(--sc-blue)] md:left-[calc(1.25rem+247px)]" />
        {TIMELINE.map((t, i) => (
          <motion.li
            key={t.title + t.period}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6, delay: i * 0.03, ease: EASE }}
            className="relative grid gap-2 pb-12 pl-10 last:pb-0 md:grid-cols-[240px_1fr] md:gap-14 md:pl-0"
          >
            <span aria-hidden className="absolute top-[5px] left-[3px] size-[9px] rounded-full bg-[color:var(--sc-blue)] ring-4 ring-[color:var(--sc-band-bg)] md:left-[243px]" />
            <div className="md:text-right">
              <p className="text-[15px] font-semibold text-white">{t.period}</p>
              <p className="mt-0.5 text-[13px] text-ink-500">{t.place}</p>
            </div>
            <div className="md:pl-2">
              <h3 className="text-[22px] font-semibold tracking-tight text-white">{t.title}</h3>
              <p className="text-[15px] text-ink-400">{t.org}</p>
              <ul className="mt-3 space-y-1.5 text-[15px] leading-relaxed text-ink-300">
                {t.points.map((pt) => <li key={pt}>{pt}</li>)}
              </ul>
              {t.tags.length > 0 && <p className="mt-3 text-[13px] text-ink-500">{t.tags.join(' · ')}</p>}
            </div>
          </motion.li>
        ))}
      </ol>
    </section>
  )
}

// ── Contact ──────────────────────────────────────────────────────────────────
function Contact() {
  return (
    <section id="contact" className="scroll-mt-12 py-24 text-center sm:py-36">
      <Reveal className="mx-auto max-w-3xl px-5">
        <h2 className="sc-headline text-[44px] text-white sm:text-[72px]">
          Let's build <span className="text-gradient">something.</span>
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-[19px] leading-snug text-ink-400 sm:text-[21px]">
          {SITE.availability ? `${SITE.availability}. Say hello.` : 'Say hello.'}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
          {SITE.links.email && (
            <a href={`mailto:${SITE.links.email}`} className="sc-pill"><Mail className="size-4" /> Email me</a>
          )}
          {SITE.links.linkedin && <a href={SITE.links.linkedin} target="_blank" rel="noreferrer" className="sc-link inline-flex items-center text-[17px]">LinkedIn <ChevronRight className="size-4" /></a>}
          {SITE.resume && <a href={SITE.resume} target="_blank" rel="noreferrer" className="sc-link inline-flex items-center gap-1 text-[17px]">Résumé <Download className="size-4" /></a>}
        </div>
      </Reveal>
      <Reveal className="mx-auto mt-14 max-w-xl px-5 text-left">
        <ContactForm />
      </Reveal>
    </section>
  )
}

// ── Footer ───────────────────────────────────────────────────────────────────
function Footer() {
  const year = new Date().getFullYear()
  const col = 'space-y-2'
  const link = 'text-ink-400 transition hover:text-white hover:underline underline-offset-2'
  return (
    <footer className="sc-band px-5 pt-10 pb-12 text-[12px] text-ink-500">
      <div className="mx-auto max-w-6xl">
        <p className="border-b border-[color:var(--hairline)] pb-4 leading-relaxed">
          Product statuses reflect what is actually built. Prototypes are labelled as prototypes, and nothing is shown as
          live before it is.
        </p>
        <div className="grid grid-cols-2 gap-8 py-8 sm:grid-cols-4">
          <div className={col}>
            <p className="font-semibold text-ink-200">Products</p>
            {PORTFOLIO.map((p) => <Link key={p.slug} to={productHref(p)} className={`block ${link}`}>{p.name}</Link>)}
          </div>
          <div className={col}>
            <p className="font-semibold text-ink-200">In development</p>
            {FROZEN.map((p) => <span key={p.slug} className="block text-ink-500">{p.name}</span>)}
          </div>
          <div className={col}>
            <p className="font-semibold text-ink-200">Elsewhere</p>
            {SITE.links.github && <a href={SITE.links.github} target="_blank" rel="noreferrer" className={`block ${link}`}>GitHub</a>}
            {SITE.links.linkedin && <a href={SITE.links.linkedin} target="_blank" rel="noreferrer" className={`block ${link}`}>LinkedIn</a>}
            {SITE.links.email && <a href={`mailto:${SITE.links.email}`} className={`block ${link}`}>Email</a>}
            {SITE.resume && <a href={SITE.resume} target="_blank" rel="noreferrer" className={`block ${link}`}>Résumé</a>}
          </div>
          <div className={col}>
            <p className="font-semibold text-ink-200">This site</p>
            <button type="button" onClick={(e) => setSkin('personal', originOf(e))} className={`block text-left ${link}`}>
              {SKIN_NAMES.personal.name} ✦
            </button>
            <a href="#overview" className={`block ${link}`}>Back to top</a>
          </div>
        </div>
        <div className="flex flex-col gap-2 border-t border-[color:var(--hairline)] pt-4 sm:flex-row sm:justify-between">
          <p>© {year} {SITE.owner}. Built with React, FastAPI and free-tier infrastructure.</p>
          <p>{SITE.location}</p>
        </div>
      </div>
    </footer>
  )
}
