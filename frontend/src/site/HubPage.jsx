import {
  ArrowDown,
  ArrowUpRight,
  BrainCircuit,
  Briefcase,
  CircleCheck,
  GraduationCap,
  LoaderCircle,
  Mail,
  MapPin,
  Menu,
  PanelsTopLeft,
  Send,
  ServerCog,
  X,
} from 'lucide-react'
import { AnimatePresence, motion, useInView, useReducedMotion, useScroll, useSpring, useTransform } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../lib/apiBase'
import { Link } from '@appcore/web/router'
import { greeting, timeIn } from '../theme/skin'
import { originOf, setSkin, useSkin } from '../theme/theme'
import { ThemeToggle } from '../theme/ThemeToggle'
import { PaletteButton } from './CommandPalette'
import { EXPERTISE, SITE, TIMELINE } from './config'
import { fillCounts, LABS, PORTFOLIO, productHref } from './products'
import { MiniPortrait, Polaroid } from './Portrait'
import { ShowcaseHub, ShowcaseNav } from './ShowcaseHub'
import { StatusBadge } from './StatusBadge'
import {
  BackToTop,
  CountUp,
  Reveal,
  RevealWords,
  ScrollCue,
  ScrollProgressBar,
  ScrollRise,
  ScrollTextBand,
  TiltCard,
  VelocityMarquee,
} from './scrollFx'

const SECTIONS = [
  { id: 'about', label: 'About' },
  { id: 'expertise', label: 'Expertise' },
  { id: 'experience', label: 'Experience' },
  { id: 'projects', label: 'Projects' },
  { id: 'contact', label: 'Contact' },
]

// ── Small building blocks ──────────────────────────────────────────────────
function GitHubIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  )
}

function LinkedInIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13ZM7.12 20.45H3.56V9h3.56v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0Z" />
    </svg>
  )
}

const SOCIALS = [
  SITE.links.linkedin && { href: SITE.links.linkedin, label: 'LinkedIn', icon: LinkedInIcon },
  SITE.links.github && { href: SITE.links.github, label: 'GitHub', icon: GitHubIcon },
  SITE.links.email && { href: `mailto:${SITE.links.email}`, label: 'Email', icon: Mail },
].filter(Boolean)

function Socials({ size = 'md' }) {
  const box = size === 'lg' ? 'size-11' : 'size-9'
  return (
    <ul className="flex items-center gap-2">
      {SOCIALS.map(({ href, label, icon: Icon }) => (
        <li key={label}>
          <a
            href={href}
            target={href.startsWith('mailto:') ? undefined : '_blank'}
            rel="noopener noreferrer"
            aria-label={label}
            title={label}
            className={`grid ${box} place-items-center rounded-full border border-white/10 bg-white/[0.03] text-ink-300 transition hover:-translate-y-0.5 hover:border-brand-400/50 hover:text-white`}
          >
            <Icon className="size-4" />
          </a>
        </li>
      ))}
    </ul>
  )
}

function SectionTitle({ kicker, title, text }) {
  return (
    <div className="mb-10 max-w-2xl">
      <Reveal>
        <p className="flex items-center gap-3 text-[12px] font-semibold tracking-[0.2em] text-cyan-300 uppercase">
          <motion.span
            aria-hidden
            className="h-px w-8 origin-left bg-gradient-to-r from-cyan-400 to-transparent"
            initial={{ scaleX: 0 }}
            whileInView={{ scaleX: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.9, ease: [0.2, 0.8, 0.2, 1] }}
          />
          {kicker}
        </p>
      </Reveal>
      <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-5xl">
        <RevealWords text={title} />
      </h2>
      {text && (
        <Reveal delay={0.15}>
          <p className="mt-4 text-[15px] leading-relaxed text-ink-300">{text}</p>
        </Reveal>
      )}
    </div>
  )
}

/** A hand-drawn arrow (decorative). `dir` points where the note refers to. */
function HandArrow({ className = '', dir = 'down-left' }) {
  const d = {
    'down-left': 'M62 6 C 52 30, 34 42, 10 46 M10 46 l9 -9 M10 46 l12 4',
    'down-right': 'M6 6 C 16 30, 34 42, 58 46 M58 46 l-9 -9 M58 46 l-12 4',
    left: 'M64 22 C 46 10, 26 12, 8 24 M8 24 l11 -3 M8 24 l6 9',
  }[dir]
  return (
    <svg aria-hidden viewBox="0 0 70 52" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <motion.path d={d} initial={{ pathLength: 0 }} whileInView={{ pathLength: 1 }} viewport={{ once: true }} transition={{ duration: 1.1, ease: 'easeInOut', delay: 0.4 }} />
    </svg>
  )
}

/** A handwritten margin note: casual, decorative, personal space only. */
function HandNote({ children, className = '' }) {
  return <span aria-hidden className={`personal-only font-hand pointer-events-none text-[22px] leading-none text-amber-200/90 ${className}`}>{children}</span>
}

/** "9:41 pm here": the owner's local time, refreshed every minute. */
function useOwnerTime() {
  const [t, setT] = useState(() => timeIn(SITE.timeZone))
  useEffect(() => {
    const id = window.setInterval(() => setT(timeIn(SITE.timeZone)), 30_000)
    return () => window.clearInterval(id)
  }, [])
  return t
}

function Chip({ children }) {
  return (
    <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[12px] text-ink-200">{children}</span>
  )
}

// ── Navigation ─────────────────────────────────────────────────────────────
function useActiveSection(enabled) {
  const [active, setActive] = useState('about')
  useEffect(() => {
    if (!enabled) return
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
        if (visible) setActive(visible.target.id)
      },
      { rootMargin: '-40% 0px -55% 0px', threshold: [0, 0.25, 0.5] },
    )
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id)
      if (el) io.observe(el)
    })
    return () => io.disconnect()
  }, [enabled])
  return active
}

/** Sticky navigation. On the portfolio it scroll-spies sections; on other pages links go back to `/#section`. */
export function SiteHeader({ home = false }) {
  return useSkin() === 'showcase' ? <ShowcaseNav home={home} /> : <PersonalHeader home={home} />
}

function PersonalHeader({ home }) {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const active = useActiveSection(home)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const href = (id) => (home ? `#${id}` : `/#${id}`)

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 transition-all duration-300 ${
        scrolled || open ? 'border-b border-white/[0.06] bg-ink-950/75 backdrop-blur-xl' : 'border-b border-transparent'
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-5">
        <Link to="/" className="flex items-center gap-2.5" onClick={() => home && window.scrollTo({ top: 0, behavior: 'smooth' })}>
          <MiniPortrait square className="size-9 text-[30px] shadow-lg shadow-indigo-950/40" />
          <span className="hidden text-[15px] font-semibold tracking-tight text-white sm:block">{SITE.owner}</span>
        </Link>

        <nav aria-label="Sections" className="ml-auto hidden md:block">
          <ul className="flex items-center gap-1 rounded-full border border-white/[0.06] bg-ink-900/40 p-1 backdrop-blur">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a
                  href={href(s.id)}
                  className={`relative block rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                    home && active === s.id ? 'text-white' : 'text-ink-400 hover:text-white'
                  }`}
                >
                  {home && active === s.id && (
                    <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-full bg-white/[0.08] ring-1 ring-white/10" transition={{ type: 'spring', stiffness: 400, damping: 34 }} />
                  )}
                  <span className="relative">{s.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <PaletteButton />
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            className="grid size-9 place-items-center rounded-full border border-white/10 text-ink-200 md:hidden"
          >
            {open ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {open && (
          <motion.nav
            aria-label="Sections"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden md:hidden"
          >
            <ul className="space-y-1 px-5 pb-5">
              {SECTIONS.map((s, i) => (
                <motion.li key={s.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}>
                  <a href={href(s.id)} onClick={() => setOpen(false)} className="block rounded-xl px-3 py-2.5 text-[15px] text-ink-100 hover:bg-white/[0.05]">
                    {s.label}
                  </a>
                </motion.li>
              ))}
            </ul>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────
export function HubPage() {
  return useSkin() === 'showcase' ? <ShowcaseHub /> : <PersonalHub />
}

function PersonalHub() {
  return (
    // overflow-x-clip: cards that slide in from the side must not widen the page before they arrive
    <div className="min-h-full overflow-x-clip">
      <ScrollProgressBar />
      <SiteHeader home />
      <main>
        <Hero />
        <ExpertiseSection />
        <ScrollTextBand rows={['Generative AI  ·  RAG  ·  Agents', 'React  ·  JavaScript  ·  Python']} />
        <ExperienceSection />
        <ProjectsSection />
        <ScrollTextBand rows={["Let's build  ·  Ship it  ·  Iterate", 'Idea  ·  Prototype  ·  Product']} />
        <ContactSection />
      </main>
      <SiteFooter />
      <BackToTop />
    </div>
  )
}

// ── Hero ───────────────────────────────────────────────────────────────────
/** Site copy placeholders ({products}, {labs}, {live}) are filled from the product registry. */
const withCounts = fillCounts

const STATS = [
  { value: `${SITE.years}+`, label: 'years in software' },
  { value: `${PORTFOLIO.length}`, label: 'portfolio products' },
  { value: '4', label: 'enterprise clients' },
]

function Avatar() {
  return (
    <div className="relative mx-auto w-fit">
      <Polaroid />
      <FloatingBadge className="-top-4 -left-6 sm:-left-28" delay={0}>
        <BrainCircuit className="size-4 text-violet-300" /> Generative AI
      </FloatingBadge>
      <FloatingBadge className="top-[42%] -right-6 sm:-right-28" delay={1.2}>
        <PanelsTopLeft className="size-4 text-cyan-300" /> React UI/UX
      </FloatingBadge>
      <FloatingBadge className="bottom-16 -left-8 max-sm:hidden sm:-left-32" delay={2.4}>
        <ServerCog className="size-4 text-emerald-300" /> Python APIs
      </FloatingBadge>
    </div>
  )
}

function FloatingBadge({ children, className, delay }) {
  return (
    <motion.span
      className={`glass pointer-events-none absolute flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium whitespace-nowrap text-ink-100 ${className}`}
      animate={{ y: [0, -8, 0] }}
      transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut', delay }}
    >
      {children}
    </motion.span>
  )
}

/** What I'm on right now: one note at a time, gently rotating (from SITE.now in config.js). */
function NowNotes() {
  const [i, setI] = useState(0)
  const reduce = useReducedMotion()
  useEffect(() => {
    if (reduce || SITE.now.length < 2) return
    const id = window.setInterval(() => setI((x) => (x + 1) % SITE.now.length), 4200)
    return () => window.clearInterval(id)
  }, [reduce])
  return (
    <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }} className="mt-6 flex items-center gap-2.5 text-[13px] text-ink-400">
      <span className="font-hand text-[20px] text-amber-200/90">now</span>
      <span className="h-px w-5 bg-white/15" />
      <span className="relative h-5 min-w-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={i}
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -12, opacity: 0 }}
            transition={{ duration: 0.35 }}
            className="absolute inset-0 truncate text-ink-200"
          >
            {SITE.now[i]}
          </motion.span>
        </AnimatePresence>
      </span>
    </motion.p>
  )
}

function Hero() {
  const ref = useRef(null)
  const reduce = useReducedMotion()
  const ownerTime = useOwnerTime()
  const visitorGreeting = greeting(new Date().getHours())
  // As the hero scrolls away: text drifts up and fades, the avatar sinks and shrinks (depth parallax).
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] })
  const textY = useTransform(scrollYProgress, [0, 1], [0, -120])
  const textOpacity = useTransform(scrollYProgress, [0, 0.75], [1, 0])
  const avatarY = useTransform(scrollYProgress, [0, 1], [0, 140])
  const avatarScale = useTransform(scrollYProgress, [0, 1], [1, 0.82])
  const avatarRotate = useTransform(scrollYProgress, [0, 1], [0, -8])

  return (
    <section ref={ref} id="about" className="relative scroll-mt-20 px-5 pt-28 pb-10 sm:pt-36 lg:pb-16">
      <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1.15fr_0.85fr]">
        <motion.div style={reduce ? undefined : { y: textY, opacity: textOpacity }}>
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="inline-flex flex-wrap items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[12.5px] text-ink-300"
          >
            <span className="relative flex size-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/60" />
              <span className="relative size-2 rounded-full bg-emerald-400" />
            </span>
            {SITE.current}
            <span className="text-ink-600">·</span>
            <MapPin className="size-3.5" /> {SITE.location}
            {ownerTime && (
              <>
                <span className="text-ink-600">·</span>
                <span className="tabular-nums" title={`Local time in ${SITE.location}`}>{ownerTime.text} here</span>
              </>
            )}
          </motion.p>
          <HandNote className="mt-5 block -rotate-2 text-[24px] text-cyan-200/90">{visitorGreeting}, wherever you are ✦</HandNote>
          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05, duration: 0.6 }}
            className="mt-3 text-4xl leading-[1.05] font-semibold tracking-tight text-white sm:text-6xl"
          >
            Hi, I'm {SITE.owner.split(' ')[0]}.
            <span className="mt-2 block text-gradient animate-gradient bg-[length:200%_auto]">
              <RevealWords text={SITE.role} delay={0.25} />
            </span>
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12, duration: 0.6 }}
            className="mt-5 max-w-xl text-[16px] leading-relaxed text-ink-300"
          >
            <span className="text-ink-100">{SITE.headline}</span> {withCounts(SITE.intro)}
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.6 }}
            className="mt-8 flex flex-wrap items-center gap-3"
          >
            <span className="relative">
              <a href="#projects" className="group inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-[14px] font-semibold text-ink-950 transition hover:shadow-lg hover:shadow-indigo-500/20">
                See my work <ArrowDown className="size-4 transition group-hover:translate-y-0.5" />
              </a>
              <span aria-hidden className="personal-only pointer-events-none absolute top-full left-2 hidden items-start text-amber-200/90 sm:flex">
                <HandArrow dir="left" className="mt-1 h-6 w-9 -scale-y-100 rotate-[200deg]" />
                <span className="font-hand mt-4 -ml-1 -rotate-3 text-[21px] whitespace-nowrap">start here</span>
              </span>
            </span>
            <a href="#contact" className="inline-flex items-center gap-2 rounded-full border border-white/15 px-5 py-2.5 text-[14px] font-semibold text-white transition hover:border-white/30 hover:bg-white/[0.04]">
              Get in touch
            </a>
            <span className="mx-1 hidden h-6 w-px bg-white/10 sm:block" />
            <Socials />
          </motion.div>
          <motion.dl
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.35 }}
            className="mt-10 grid max-w-md grid-cols-3 gap-4 border-t border-white/[0.07] pt-6"
          >
            {STATS.map((s) => (
              <div key={s.label}>
                <dt className="font-mono text-2xl font-semibold text-white">
                  <CountUp value={s.value} />
                </dt>
                <dd className="mt-0.5 text-[12px] text-ink-400">{s.label}</dd>
              </div>
            ))}
          </motion.dl>
          {SITE.now?.length > 0 && <NowNotes />}
        </motion.div>
        <motion.div style={reduce ? undefined : { y: avatarY, scale: avatarScale, rotate: avatarRotate }}>
          <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.15, duration: 0.7 }}>
            <Avatar />
          </motion.div>
        </motion.div>
      </div>
      <motion.div style={reduce ? undefined : { opacity: textOpacity }}>
        <ScrollCue />
      </motion.div>
    </section>
  )
}

// ── Expertise ──────────────────────────────────────────────────────────────
const EXPERTISE_ICON = { ui: PanelsTopLeft, ai: BrainCircuit, api: ServerCog }
const EXPERTISE_TINT = {
  ui: 'from-cyan-500/20 to-sky-500/5 text-cyan-300',
  ai: 'from-violet-500/20 to-fuchsia-500/5 text-violet-300',
  api: 'from-emerald-500/20 to-teal-500/5 text-emerald-300',
}

function ExpertiseSection() {
  return (
    <section id="expertise" className="scroll-mt-20 px-5 py-20">
      <div className="mx-auto max-w-6xl">
        <SectionTitle kicker="Expertise" title="What I bring to a team" text="Frontend craft from enterprise delivery, with the AI and backend depth to ship a whole product." />
        <div className="grid gap-5 md:grid-cols-3">
          {EXPERTISE.map((x, i) => (
            <ScrollRise key={x.title} index={i}>
              <TiltCard>
                <ExpertiseCard x={x} />
              </TiltCard>
            </ScrollRise>
          ))}
        </div>
      </div>
    </section>
  )
}

function ExpertiseCard({ x }) {
  const Icon = EXPERTISE_ICON[x.icon]
  return (
    <article className="spotlight group relative h-full rounded-3xl border border-white/[0.07] bg-ink-900/60 p-6 transition-colors duration-300 hover:border-white/15 hover:shadow-2xl hover:shadow-indigo-950/20">
      <span className={`grid size-12 place-items-center rounded-2xl bg-gradient-to-br transition-transform duration-500 group-hover:scale-110 group-hover:-rotate-6 ${EXPERTISE_TINT[x.icon]}`}>
        <Icon className="size-6" />
      </span>
      <h3 className="mt-5 text-lg font-semibold text-white">{x.title}</h3>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-300">{withCounts(x.text)}</p>
      <p className="mt-5 text-[11px] font-semibold tracking-[0.16em] text-ink-500 uppercase">Tech stack</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {x.stack.map((s) => (
          <Chip key={s}>{s}</Chip>
        ))}
      </div>
    </article>
  )
}

// ── Experience timeline ────────────────────────────────────────────────────
function ExperienceSection() {
  const ref = useRef(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 75%', 'end 60%'] })
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30 })

  return (
    <section id="experience" className="scroll-mt-20 px-5 py-20">
      <div className="mx-auto max-w-6xl">
        <SectionTitle kicker="Experience" title="Career history" text="From mainframes to modern frontends to Generative AI: every step added a layer." />
        <ol ref={ref} className="relative">
          {/* the line: a faint track plus a gradient that draws as you scroll */}
          <span aria-hidden className="absolute top-2 bottom-2 left-[19px] w-px bg-white/[0.08] md:left-1/2" />
          <motion.span
            aria-hidden
            style={{ scaleY: progress }}
            className="absolute top-2 bottom-2 left-[19px] w-px origin-top bg-gradient-to-b from-indigo-400 via-cyan-400 to-emerald-400 md:left-1/2"
          />
          {TIMELINE.map((t, i) => {
            const Icon = t.kind === 'education' ? GraduationCap : Briefcase
            const right = i % 2 === 1
            return (
              <li key={t.title + t.period} className="relative mb-10 pl-14 last:mb-0 md:grid md:grid-cols-2 md:gap-14 md:pl-0">
                <TimelineNode icon={<Icon className="size-4.5" />} />
                <Reveal from={right ? 'right' : 'left'} className={right ? 'md:col-start-2' : 'md:col-start-1'}>
                  <article className="rounded-3xl border border-white/[0.07] bg-ink-900/60 p-5 transition duration-300 hover:-translate-y-0.5 hover:border-white/15 hover:shadow-xl hover:shadow-cyan-950/20 sm:p-6">
                    <p className="inline-flex rounded-full bg-cyan-500/10 px-2.5 py-0.5 font-mono text-[11.5px] text-cyan-300">{t.period}</p>
                    <h3 className="mt-2 text-lg font-semibold text-white">{t.title}</h3>
                    <p className="text-[13.5px] text-ink-300">
                      {t.org} <span className="text-ink-500">· {t.place}</span>
                    </p>
                    <ul className="mt-3 space-y-1.5">
                      {t.points.map((p) => (
                        <li key={p} className="flex gap-2 text-[13.5px] leading-relaxed text-ink-200">
                          <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-300/80" /> {p}
                        </li>
                      ))}
                    </ul>
                    {t.tags.length > 0 && (
                      <div className="mt-4 flex flex-wrap gap-1.5">
                        {t.tags.map((tag) => (
                          <Chip key={tag}>{tag}</Chip>
                        ))}
                      </div>
                    )}
                  </article>
                </Reveal>
              </li>
            )
          })}
        </ol>
      </div>
    </section>
  )
}

/** Timeline dot that lights up (pulse + glow) once the drawing line reaches it. */
function TimelineNode({ icon }) {
  const ref = useRef(null)
  const lit = useInView(ref, { margin: '0px 0px -40% 0px', once: true })
  return (
    <motion.span
      ref={ref}
      initial={false}
      animate={lit ? { scale: [0.6, 1.15, 1], opacity: 1 } : { scale: 0.85, opacity: 0.5 }}
      transition={{ duration: 0.6, ease: 'easeOut' }}
      className={`absolute top-1 left-0 z-10 grid size-10 place-items-center rounded-full border bg-ink-900 transition-[color,border-color,box-shadow] duration-500 md:left-1/2 md:-ml-5 ${
        lit ? 'border-cyan-400/50 text-cyan-300 shadow-[0_0_0_6px_rgb(34_211_238/0.08),0_0_28px_rgb(34_211_238/0.35)]' : 'border-white/10 text-ink-500'
      }`}
    >
      {icon}
    </motion.span>
  )
}

const PERSONAL = new Set(['tijori', 'safarnaama'])

function useBackendOnline() {
  const [online, setOnline] = useState(null)
  useEffect(() => {
    const ctrl = new AbortController()
    fetch(`${API_BASE}/api/health`, { signal: ctrl.signal })
      .then((r) => setOnline(r.ok))
      .catch(() => !ctrl.signal.aborted && setOnline(false))
    return () => ctrl.abort()
  }, [])
  return online
}

function ProjectsSection() {
  const [filter, setFilter] = useState('all')
  const online = useBackendOnline()
  const shown = useMemo(
    () => PORTFOLIO.filter((p) => filter === 'all' || (filter === 'personal') === PERSONAL.has(p.slug)),
    [filter],
  )
  return (
    <section id="projects" className="scroll-mt-20 px-5 py-20">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-end justify-between gap-x-4">
          <SectionTitle
            kicker="Projects"
            title={`${PORTFOLIO.length} products, built one at a time`}
            text="The approved portfolio, in priority order. Each card shows its real status: Safarnaama is being taken end to end first and Jasoos is in active development; the others are approved and scheduled, some with an earlier prototype you can already open."
          />
          <HandNote className="-mt-6 mb-10 hidden -rotate-3 lg:block">Safarnaama: on my desk right now ↓</HandNote>
          <Reveal className="mb-10">
            <div role="tablist" aria-label="Filter projects" className="inline-flex rounded-full border border-white/[0.07] bg-ink-900/50 p-1">
              {['all', 'personal', 'work'].map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className={`relative rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors ${filter === f ? 'text-white' : 'text-ink-400 hover:text-white'}`}
                >
                  {filter === f && <motion.span layoutId="project-filter" className="absolute inset-0 rounded-full bg-white/[0.08] ring-1 ring-white/10" />}
                  <span className="relative">{f === 'all' ? 'All' : f === 'personal' ? 'Personal life' : 'Work & dev'}</span>
                </button>
              ))}
            </div>
          </Reveal>
        </div>
        <motion.ul layout className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <AnimatePresence mode="popLayout">
            {shown.map((p, i) => (
              <motion.li
                key={p.slug}
                layout
                initial={{ opacity: 0, y: 60, scale: 0.94, filter: 'blur(10px)' }}
                whileInView={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, scale: 0.96 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ duration: 0.7, delay: (i % 3) * 0.1, ease: [0.2, 0.8, 0.2, 1] }}
              >
                <TiltCard max={5}>
                  <ProjectCard p={p} online={online} />
                </TiltCard>
              </motion.li>
            ))}
          </AnimatePresence>
        </motion.ul>
        <LabsSection />
        <Stack />
      </div>
    </section>
  )
}

function ProjectCard({ p, online }) {
  const Icon = p.icon
  const to = productHref(p)
  return (
    <article className="spotlight group relative flex h-full flex-col overflow-hidden rounded-3xl border border-white/[0.07] bg-ink-900/60 transition-colors duration-300 hover:border-white/15 hover:shadow-2xl hover:shadow-black/20">
      <Link to={to} className="relative block aspect-[16/10] overflow-hidden border-b border-white/[0.06] bg-ink-800" aria-label={`${p.name} product page`}>
        <ParallaxImage src={`/projects/${p.image ?? p.slug}.webp`} alt={`${p.name} screenshot`} fallback={<ShotFallback p={p} />} />
        <span className={`absolute inset-x-0 bottom-0 h-1 bg-gradient-to-r ${p.accent}`} />
        <span className="absolute top-3 left-3 flex items-center gap-1.5">
          <StatusBadge status={p.status} className="glass" />
          {p.app && online === false && <span className="glass rounded-md px-2 py-0.5 text-[11px] text-rose-200">Backend offline</span>}
        </span>
      </Link>
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-center gap-2.5">
          <span className={`grid size-9 place-items-center rounded-xl bg-gradient-to-br ${p.accent} text-on-accent shadow-md`}>
            <Icon className="size-4.5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-[16px] font-semibold text-white">{p.name}</h3>
            <p className="text-[11.5px] text-ink-400">{p.category}</p>
          </div>
        </div>
        <p className="mt-3 text-[13.5px] leading-relaxed text-ink-300">{p.tagline}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {p.tags.slice(0, 3).map((t) => (
            <Chip key={t}>{t}</Chip>
          ))}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-5">
          <Link to={to} className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-white">
            View product <ArrowUpRight className="size-4 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </Link>
          {p.app && (
            <Link to={p.app.route} className="text-[12.5px] text-ink-400 underline-offset-2 hover:text-white hover:underline">
              {p.app.kind === 'product' ? 'Open app' : 'Open prototype'}
            </Link>
          )}
        </div>
      </div>
    </article>
  )
}

/** Labs: experiments and reusable capabilities. Still usable, never counted as portfolio products. */
function LabsSection() {
  return (
    <div className="mt-16">
      <p className="text-[12px] font-semibold tracking-[0.18em] text-cyan-300 uppercase">Labs</p>
      <p className="mt-2 max-w-2xl text-[14px] text-ink-300">
        Earlier experiments, kept working and reused as capabilities by the portfolio products. They are not part of the approved portfolio.
      </p>
      <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {LABS.map((p) => {
          const Icon = p.icon
          return (
            <li key={p.slug}>
              <Link to={productHref(p)} className="glass flex h-full flex-col rounded-2xl p-4 transition hover:border-white/20">
                <span className="flex items-center gap-2">
                  <span className={`grid size-7 place-items-center rounded-lg bg-gradient-to-br ${p.accent} text-on-accent`}>
                    <Icon className="size-3.5" />
                  </span>
                  <span className="text-[14px] font-semibold text-white">{p.name}</span>
                  <StatusBadge status={p.status} className="ml-auto" />
                </span>
                <span className="mt-2 text-[12.5px] text-ink-300">{p.tagline}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Shown when a project has no screenshot yet: the product's gradient with its icon. */
function ShotFallback({ p }) {
  const Icon = p.icon
  return (
    <div className="relative grid size-full place-items-center overflow-hidden bg-ink-850">
      <div aria-hidden className={`absolute inset-0 bg-gradient-to-br opacity-25 ${p.accent}`} />
      <div aria-hidden className="bg-grid absolute inset-0 opacity-60" />
      <span className={`relative grid size-16 place-items-center rounded-2xl bg-gradient-to-br text-on-accent shadow-xl transition-transform duration-500 group-hover:scale-110 ${p.accent}`}>
        <Icon className="size-8" />
      </span>
    </div>
  )
}

/** Screenshot that drifts inside its frame as the card scrolls past. */
function ParallaxImage({ src, alt, fallback }) {
  const ref = useRef(null)
  const reduce = useReducedMotion()
  const [broken, setBroken] = useState(false)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] })
  const y = useTransform(scrollYProgress, [0, 1], ['-7%', '7%'])
  return (
    <div ref={ref} className="size-full">
      {broken ? (
        fallback
      ) : (
        <motion.img
          src={src}
          alt={alt}
          loading="lazy"
          width={960}
          height={600}
          onError={() => setBroken(true)}
          style={reduce ? undefined : { y, scale: 1.16 }}
          className="size-full object-cover object-top"
        />
      )}
      <span aria-hidden className="absolute inset-0 bg-gradient-to-t from-ink-950/40 via-transparent to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
    </div>
  )
}

const STACK = ['React 19', 'JavaScript (ES2023)', 'Tailwind v4', 'Motion', 'React Flow', 'Leaflet', 'Python', 'FastAPI', 'LangGraph', 'Claude', 'Groq', 'Whisper', 'FastEmbed', 'Postgres (Neon)', 'SQLite', 'Docker', 'GitHub Actions']

function Stack() {
  return (
    <Reveal className="mt-14">
      <p className="text-center text-[11px] font-semibold tracking-[0.2em] text-ink-500 uppercase">Built with</p>
      <div className="mt-4">
        <VelocityMarquee>
          {STACK.map((s) => (
            <span key={s} className="rounded-full border border-white/[0.07] px-3.5 py-1.5 font-mono text-[12px] whitespace-nowrap text-ink-300 transition-colors hover:border-cyan-400/40 hover:text-white">
              {s}
            </span>
          ))}
        </VelocityMarquee>
      </div>
    </Reveal>
  )
}

// ── Contact ────────────────────────────────────────────────────────────────
/** The contact form (shared by both skins): posts to /api/contact, with a honeypot field for bots. */
export function ContactForm() {
  const [form, setForm] = useState({ name: '', email: '', message: '', website: '' })
  const [state, setState] = useState('idle')
  const [error, setError] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setState('sending')
    setError('')
    try {
      const res = await fetch(`${API_BASE}/api/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        throw new Error(
          res.status === 429
            ? 'Too many messages. Please try again in a minute.'
            : res.status === 422
              ? 'Please check your email address and write at least 10 characters.'
              : 'Something went wrong. Please email me directly instead.',
        )
      }
      setState('sent')
      setForm({ name: '', email: '', message: '', website: '' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setState('error')
    }
  }

  const field = 'w-full rounded-2xl border border-white/10 bg-ink-950/40 px-4 py-3 text-[14.5px] text-white outline-none transition placeholder:text-ink-500 focus:border-brand-400/60'

  return (
    <form onSubmit={(e) => void submit(e)} className="glass relative overflow-hidden rounded-3xl p-6 sm:p-8" aria-label="Contact form">
      <AnimatePresence mode="wait">
        {state === 'sent' ? (
          <motion.div key="sent" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="grid min-h-80 place-items-center text-center">
            <div>
              <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 16 }} className="mx-auto grid size-16 place-items-center rounded-full bg-emerald-500/15 text-emerald-300">
                <CircleCheck className="size-8" />
              </motion.span>
              <h3 className="mt-4 text-xl font-semibold text-white">Message sent</h3>
              <p className="mt-1 text-[14px] text-ink-300">Thanks for reaching out, I'll reply soon.</p>
              <button type="button" onClick={() => setState('idle')} className="mt-5 text-[13px] text-cyan-300 hover:underline">Send another</button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="form" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-[12.5px] font-medium text-ink-300">Name</span>
                <input id="contact-name" required minLength={2} maxLength={80} className={`${field} mt-1.5`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Your name" autoComplete="name" />
              </label>
              <label className="block">
                <span className="text-[12.5px] font-medium text-ink-300">Email</span>
                <input id="contact-email" required type="email" maxLength={254} className={`${field} mt-1.5`} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@company.com" autoComplete="email" />
              </label>
            </div>
            <label className="block">
              <span className="text-[12.5px] font-medium text-ink-300">Message</span>
              <textarea id="contact-message" required minLength={10} maxLength={3000} rows={6} className={`${field} mt-1.5 resize-y`} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder="What would you like to build?" />
            </label>
            {/* honeypot: hidden from people, irresistible to bots */}
            <input tabIndex={-1} autoComplete="off" aria-hidden className="absolute -left-[9999px] size-px opacity-0" name="website" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
            {state === 'error' && <p role="alert" className="text-[13px] text-rose-300">{error}</p>}
            <button type="submit" disabled={state === 'sending'} className="btn-primary inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500 py-3 text-[14.5px] font-semibold text-on-accent shadow-lg shadow-indigo-950/30 transition hover:brightness-110 disabled:opacity-60">
              {state === 'sending' ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
              {state === 'sending' ? 'Sending…' : 'Send message'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </form>
  )
}

function ContactSection() {
  return (
    <section id="contact" className="scroll-mt-20 px-5 py-20">
      <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <SectionTitle kicker="Contact" title="Let's build something" text="Open to roles building AI products end to end, and to collaborations. Send a note and I'll get back to you." />
          <Reveal from="left" className="-mt-4 space-y-3">
            {SITE.links.email && (
              <a href={`mailto:${SITE.links.email}`} className="flex items-center gap-3 text-[15px] break-all text-ink-100 hover:text-white">
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-white/[0.05] text-cyan-300"><Mail className="size-4.5" /></span>
                {SITE.links.email}
              </a>
            )}
            <p className="flex items-center gap-3 text-[15px] text-ink-300">
              <span className="grid size-10 place-items-center rounded-2xl bg-white/[0.05] text-cyan-300"><MapPin className="size-4.5" /></span>
              {SITE.location}
            </p>
            <div className="pt-3"><Socials size="lg" /></div>
            <p aria-hidden className="personal-only font-hand pt-4 -rotate-2 text-[30px] text-ink-200">— {SITE.owner.split(' ')[0]}</p>
          </Reveal>
        </div>
        <Reveal from="right">
          <ContactForm />
        </Reveal>
      </div>
    </section>
  )
}

function SiteFooter() {
  return (
    <footer className="border-t border-white/[0.06] px-5 py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 text-center text-[13px] text-ink-400 sm:flex-row sm:text-left">
        <p>
          © {new Date().getFullYear()} {SITE.owner}. Designed & built with React 19, Tailwind v4 and FastAPI.
          <span className="mt-1 block text-ink-500">Made in {SITE.location.split(',')[0]} · built and hosted on free tiers</span>
        </p>
        <div className="flex items-center gap-4">
          <button type="button" onClick={(e) => setSkin('showcase', originOf(e))} className="text-ink-400 transition hover:text-white">Back to the Studio</button>
          <Socials />
          <a href="#about" className="text-ink-300 hover:text-white">Back to top ↑</a>
        </div>
      </div>
    </footer>
  )
}
