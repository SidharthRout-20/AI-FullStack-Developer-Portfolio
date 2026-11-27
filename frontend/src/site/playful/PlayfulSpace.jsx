/**
 * Playful space (PREVIEW, hidden): a bright, condensed-type take on the personal space, inspired by the motion of
 * illustrator portfolios but built around this site's own products and skills. Not linked from anywhere, kept out
 * of search (robots.txt + noindex); open it at /preview/playful while it is being developed.
 *
 * Motion, all transform/opacity (cheap to draw), paused off-screen, and off with reduced motion or lite mode:
 *  - name and headings rise word by word; letters of the name spring when hovered
 *  - the hero deck of product cards shuffles itself: the front card is tossed and tucks in at the back; drag and
 *    fling the top card yourself, hover to fan the deck out, click to reshuffle; the deck leans toward the cursor
 *  - the role line fills in word by word as you scroll
 *  - featured products: a sideways strip you swipe or drag (snapping to each product, tilted at the sides, upright
 *    in the middle); the screen in the middle pans slowly like a screen recording
 *  - skill cards drop in with a bounce; tech names stream past (a CSS loop the compositor runs on its own)
 *  - products in development flip in, and fan out on hover
 *  - CONTACT stretches up out of the floor as you reach it; its letters squash and stretch under the cursor
 *  - the palette button recolours every card
 */
import { ArrowUp, Search } from 'lucide-react'
import {
  animate,
  AnimatePresence,
  motion,
  MotionConfig,
  useInView,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from 'motion/react'
import { useEffect, useReducer, useRef, useState } from 'react'
import { Link } from '@appcore/web/router'
import { API_BASE } from '../../lib/apiBase'
import { LITE } from '../../lib/lite'
import { track } from '../../lib/visits'
import { timeIn } from '../../theme/skin'
import { ThemeToggle } from '../../theme/ThemeToggle'
import { openPalette } from '../CommandPalette'
import { EXPERTISE, SITE, TIMELINE } from '../config'
import { FROZEN, PORTFOLIO, productHref, STATUSES } from '../products'
import { SkillsChat } from '../SkillsChat'

// Colours come from CSS variables so the page follows the site's light / dark theme (see THEME below).
const INK = 'var(--pl-ink)'
const MUTED = 'var(--pl-muted)'
const HEAD = { fontFamily: "'Oswald', 'Arial Narrow', sans-serif", fontWeight: 600, textTransform: 'uppercase', letterSpacing: '-0.02em' }
const PALETTES = [
  ['#d7f75b', '#1f6feb', '#f6c445', '#f9dde5'],
  ['#ffb4a2', '#7fd1c7', '#b8a8ff', '#ffe066'],
  ['#ff8fab', '#8ecae6', '#ffd166', '#b5e48c'],
]
const SHOTS = new Set(['careerpilot', 'codelens', 'documind', 'evolve', 'flowforge', 'jasoos', 'meetingmind', 'safarnaama', 'tara'])
const shot = (p) => (SHOTS.has(p.image ?? p.slug) ? `/projects/${p.image ?? p.slug}.webp` : null)
const SPRING = { type: 'spring', stiffness: 260, damping: 22 }
const THEME = `
  .pl-root { --pl-bg: #ffffff; --pl-ink: #363636; --pl-muted: #5f5f5f; --pl-faint: #d0d0d0; --pl-band: #ececec; --pl-line: #e0e0e0; --pl-chip: #f2f2f2 }
  html[data-theme="dark"] .pl-root { --pl-bg: #0f1012; --pl-ink: #ececec; --pl-muted: #a6a6a6; --pl-faint: #38383c; --pl-band: #17171a; --pl-line: #2b2b30; --pl-chip: #1d1d21 }
`

/** Text on a card colour: white on dark colours, near-black on light ones. */
function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.3 ? '#ffffff' : '#1f1f1f'
}

function useWidth() {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth))
  useEffect(() => {
    const on = () => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

// ── Type ─────────────────────────────────────────────────────────────────────
/** Words rise out of a mask one after another (on load, or when scrolled into view). */
function Rise({ text, as: Tag = 'h2', style, delay = 0, onView = true, letters = false }) {
  const words = text.split(' ')
  const M = motion[Tag]
  const show = { y: '0%', rotate: 0 }
  return (
    <M aria-label={text} style={{ margin: 0, ...style }} initial="hidden" {...(onView ? { whileInView: 'shown', viewport: { once: true, margin: '-12% 0px' } } : { animate: 'shown' })}>
      {words.map((w, i) => (
        <span key={i} aria-hidden="true" style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'top', paddingBottom: '0.06em', marginRight: i < words.length - 1 ? '0.24em' : 0 }}>
          <motion.span
            style={{ display: 'inline-block', transformOrigin: '0% 100%' }}
            variants={{ hidden: { y: '105%', rotate: 6 }, shown: { ...show, transition: { delay: delay + i * 0.08, duration: 0.8, ease: [0.2, 0.9, 0.2, 1] } } }}
          >
            {letters ? [...w].map((ch, k) => <Letter key={k}>{ch}</Letter>) : w}
          </motion.span>
        </span>
      ))}
    </M>
  )
}

/** One letter that springs up and tilts when the cursor passes over it. */
function Letter({ children }) {
  return (
    <motion.span style={{ display: 'inline-block' }} whileHover={{ y: '-0.12em', rotate: -6, scale: 1.06 }} transition={{ type: 'spring', stiffness: 500, damping: 12 }}>
      {children}
    </motion.span>
  )
}

/** Grey words that fill in dark, one by one, as the line scrolls through the viewport. */
function ScrollFill({ text, style }) {
  const ref = useRef(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 0.85', 'end 0.4'] })
  const words = text.split(' ')
  return (
    <h2 ref={ref} aria-label={text} style={{ margin: 0, ...style }}>
      {words.map((w, i) => (
        <FillWord key={i} progress={scrollYProgress} range={[i / words.length, (i + 1) / words.length]} last={i === words.length - 1}>
          {w}
        </FillWord>
      ))}
    </h2>
  )
}

function FillWord({ progress, range, last, children }) {
  const opacity = useTransform(progress, range, [0, 1])
  return (
    <span aria-hidden="true" style={{ position: 'relative', display: 'inline-block', marginRight: last ? 0 : '0.24em', color: 'var(--pl-faint)' }}>
      {children}
      <motion.span style={{ position: 'absolute', inset: 0, color: INK, opacity }}>{children}</motion.span>
    </span>
  )
}

// ── Hero deck ────────────────────────────────────────────────────────────────
function deck(state, action) {
  switch (action.type) {
    case 'toss':
      if (state.tossing != null) return state
      return { ...state, tossing: state.order.at(-1), dir: action.dir ?? -state.dir }
    case 'landed': // the tossed card tucks in at the back
      return { ...state, order: [state.tossing, ...state.order.filter((i) => i !== state.tossing)], tossing: null }
    case 'shuffle':
      return { ...state, order: [...state.order.slice(2), ...state.order.slice(0, 2)] }
    default:
      return state
  }
}

function Deck({ items, palette, still }) {
  const [state, dispatch] = useReducer(deck, { order: items.map((_, i) => i), tossing: null, dir: 1 })
  const [spread, setSpread] = useState(false)
  const [dragging, setDragging] = useState(false)
  const ref = useRef(null)
  const inView = useInView(ref, { margin: '-15% 0px' })
  const width = useWidth()
  const s = Math.min(1, width / 760) // scale the fan on small screens
  const card = Math.round(230 * Math.max(0.62, s))

  // The deck leans toward the cursor.
  const mx = useMotionValue(0)
  const my = useMotionValue(0)
  const rotateY = useSpring(useTransform(mx, [-1, 1], [-10, 10]), { stiffness: 120, damping: 18 })
  const rotateX = useSpring(useTransform(my, [-1, 1], [8, -8]), { stiffness: 120, damping: 18 })
  useEffect(() => {
    if (still) return
    const on = (e) => {
      mx.set((e.clientX / window.innerWidth) * 2 - 1)
      my.set((e.clientY / window.innerHeight) * 2 - 1)
    }
    window.addEventListener('pointermove', on)
    return () => window.removeEventListener('pointermove', on)
  }, [still, mx, my])

  // Shuffle by itself every few seconds while it is on screen and nobody is playing with it.
  useEffect(() => {
    if (still || !inView || spread || dragging) return
    const id = window.setInterval(() => !document.hidden && dispatch({ type: 'toss' }), 2600)
    return () => window.clearInterval(id)
  }, [still, inView, spread, dragging])

  const n = items.length
  const front = state.order.at(-1)
  return (
    <div ref={ref} aria-hidden="true" style={{ position: 'relative', height: card * 1.45, width: '100%', perspective: 1000, zIndex: 3 }}>
      <motion.div
        style={{ position: 'absolute', inset: 0, rotateX, rotateY, transformStyle: 'preserve-3d' }}
        onHoverStart={() => setSpread(true)}
        onHoverEnd={() => setSpread(false)}
        onTap={() => !dragging && dispatch({ type: 'shuffle' })}
      >
        {items.map((p, i) => {
          const pos = state.order.indexOf(i)
          const c = pos - (n - 1) / 2
          const tossed = state.tossing === i
          const color = palette[i % palette.length]
          const target = tossed
            ? { x: state.dir * 160 * s, y: 420 * s, rotate: state.dir * 32, scale: 0.9 }
            : { x: c * (spread ? 128 : 66) * s, y: Math.abs(c) * 10 * s - (spread ? 14 : 0), rotate: c * (spread ? 11 : 6.5), scale: 1 }
          return (
            <motion.div
              key={p.slug}
              initial={{ y: 260, opacity: 0, rotate: c * 20 }}
              animate={{ ...target, opacity: 1 }}
              transition={tossed ? { duration: 0.55, ease: [0.55, 0, 0.8, 0.4] } : SPRING}
              onAnimationComplete={() => tossed && dispatch({ type: 'landed' })}
              drag={i === front && !still}
              dragSnapToOrigin
              dragElastic={0.6}
              onDragStart={() => setDragging(true)}
              onDragEnd={(_, info) => {
                window.setTimeout(() => setDragging(false), 50)
                if (Math.hypot(info.offset.x, info.offset.y) > 90 || Math.hypot(info.velocity.x, info.velocity.y) > 600)
                  dispatch({ type: 'toss', dir: Math.sign(info.offset.x) || 1 })
              }}
              whileDrag={{ scale: 1.06, cursor: 'grabbing' }}
              style={{
                position: 'absolute', left: '50%', top: 0, marginLeft: -card / 2, width: card, height: card, zIndex: tossed ? 50 : pos + 1,
                borderRadius: 24, background: color, padding: 10, boxSizing: 'border-box', cursor: i === front ? 'grab' : 'pointer',
                boxShadow: '0 30px 60px -18px rgba(0,0,0,0.35)', touchAction: 'none', willChange: 'transform',
              }}
            >
              <img src={shot(p)} alt="" draggable="false" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'left top', borderRadius: 15, display: 'block', pointerEvents: 'none' }} />
            </motion.div>
          )
        })}
      </motion.div>
    </div>
  )
}

// ── Featured carousel ────────────────────────────────────────────────────────
/** A screenshot that pans slowly, like a screen recording, while it is visible. */
function LiveShot({ src, alt, play }) {
  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 16, width: '100%', height: '100%' }}>
      <motion.img
        src={src}
        alt={alt}
        draggable="false"
        animate={play ? { y: ['0%', '-16%'] } : { y: '0%' }}
        transition={play ? { duration: 9, repeat: Infinity, repeatType: 'mirror', ease: 'easeInOut' } : { duration: 0.4 }}
        style={{ width: '100%', height: '125%', objectFit: 'cover', objectPosition: 'left top', display: 'block', pointerEvents: 'none' }}
      />
    </div>
  )
}

/**
 * A sideways strip, like the reference: swipe (touch / trackpad), drag with the mouse, or Shift+wheel; each product
 * snaps to the centre. The browser does the scrolling (smooth on any device); the cards only read the scroll
 * position to tilt and settle, so nothing re-renders while you swipe.
 */
function Featured({ palette, still }) {
  const n = PORTFOLIO.length
  const track = useRef(null)
  const width = useWidth()
  const W = Math.round(Math.min(420, width * 0.72))
  const G = Math.round(W * 0.14) // gap between cards
  const step = W + G
  const { scrollX } = useScroll({ container: track })
  const [at, setAt] = useState(0)
  useMotionValueEvent(scrollX, 'change', (v) => setAt(Math.max(0, Math.min(n - 1, Math.round(v / step)))))
  const inView = useInView(track, { margin: '-15% 0px' })
  const drag = useRef(null)
  const moved = useRef(false)

  // Mouse drag-to-swipe (touch and trackpads scroll natively). Snapping pauses while dragging, then settles.
  const onDown = (e) => {
    if (e.pointerType !== 'mouse' || !track.current) return
    drag.current = { x: e.clientX, left: track.current.scrollLeft }
    moved.current = false
    track.current.style.scrollSnapType = 'none'
    track.current.setPointerCapture(e.pointerId)
  }
  const onMove = (e) => {
    if (!drag.current) return
    const dx = e.clientX - drag.current.x
    if (Math.abs(dx) > 4) moved.current = true
    track.current.scrollLeft = drag.current.left - dx
  }
  const onUp = () => {
    if (!drag.current) return
    const el = track.current
    const target = Math.round(el.scrollLeft / step) * step
    drag.current = null
    el.scrollTo({ left: target, behavior: still ? 'auto' : 'smooth' })
    window.setTimeout(() => (el.style.scrollSnapType = 'x mandatory'), 450)
  }

  const cur = PORTFOLIO[at]
  return (
    <section id="pl-work" aria-label="Featured work" style={{ marginTop: 170, textAlign: 'center', scrollMarginTop: 80 }}>
      <Rise text="Featured work" style={{ ...HEAD, fontSize: 'clamp(40px, 5.4vw, 76px)', lineHeight: 1, color: INK }} />
      <p style={{ margin: '10px 0 0', fontSize: 16, fontWeight: 500 }}>Four AI products, each solving one real problem end to end</p>
      <div
        ref={track}
        className="pl-track"
        tabIndex={0}
        role="region"
        aria-roledescription="carousel"
        aria-label={`Featured products, swipe sideways: ${cur.name}, ${at + 1} of ${n}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClickCapture={(e) => moved.current && e.preventDefault()}
        style={{
          display: 'flex', gap: G, overflowX: 'auto', overflowY: 'hidden', scrollSnapType: 'x mandatory', overscrollBehaviorX: 'contain',
          padding: `46px ${(width - W) / 2}px 70px`, marginTop: 10, cursor: 'grab', outline: 'none', WebkitOverflowScrolling: 'touch',
        }}
      >
        {PORTFOLIO.map((p, i) => (
          <FeaturedCard key={p.slug} p={p} i={i} scrollX={scrollX} step={step} W={W} color={palette[i % palette.length]} live={i === at && inView && !still} />
        ))}
      </div>
      <p style={{ margin: 0, fontSize: 12, letterSpacing: '0.14em', textTransform: 'uppercase', color: MUTED }}>Swipe or drag sideways</p>
      <Link to="/quality" style={{ ...HEAD, display: 'inline-block', marginTop: 16, fontSize: 14, letterSpacing: '0.08em', color: INK, textDecoration: 'underline', textUnderlineOffset: 6 }}>
        How each product is measured
      </Link>
    </section>
  )
}

/** One product card. Its tilt, drop and size follow how far it is from the centre of the strip (transform only). */
function FeaturedCard({ p, i, scrollX, step, W, color, live }) {
  const d = useTransform(scrollX, (v) => i - v / step) // cards from the centre: 0 = centred
  const rotate = useTransform(d, (v) => Math.max(-1.4, Math.min(1.4, v)) * 10)
  const y = useTransform(d, (v) => Math.min(Math.abs(v), 1) * 30)
  const scale = useTransform(d, (v) => 1 - Math.min(Math.abs(v), 1) * 0.12)
  return (
    <div style={{ flex: `0 0 ${W}px`, scrollSnapAlign: 'center', scrollSnapStop: 'always' }}>
      <motion.div
        style={{
          rotate, y, scale, willChange: 'transform', height: W * 1.22, borderRadius: 28, background: color, padding: 16, boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', gap: 14, boxShadow: '0 24px 44px -24px rgba(0,0,0,0.38)', textAlign: 'left', userSelect: 'none',
        }}
      >
        <div style={{ flex: '1 1 auto', minHeight: 0 }}>
          <LiveShot src={shot(p)} alt={`${p.name} screenshot`} play={live} />
        </div>
        <div style={{ color: inkOn(color), padding: '0 6px 4px' }}>
          <p style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
            <span style={{ ...HEAD, fontSize: 34, lineHeight: 1 }}>{p.name}</span>
            {STATUSES[p.status] && <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '3px 8px', borderRadius: 999, background: 'rgba(0,0,0,0.12)' }}>{STATUSES[p.status].label}</span>}
          </p>
          {p.problem && <p style={{ margin: '6px 0 0', fontSize: 14, fontWeight: 600, lineHeight: 1.35 }}>{p.problem}</p>}
          <p style={{ margin: '4px 0 0', fontSize: 13.5, lineHeight: 1.45, opacity: 0.85, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{p.outcome ?? p.tagline}</p>
          <p style={{ display: 'flex', gap: 16, margin: '10px 0 0' }}>
            {p.app?.route && <Link to={p.app.route} style={{ ...HEAD, fontSize: 14, letterSpacing: '0.06em', color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 5 }}>Try it</Link>}
            <Link to={productHref(p)} style={{ ...HEAD, fontSize: 14, letterSpacing: '0.06em', color: 'inherit', textDecoration: 'none', opacity: 0.8 }}>Details</Link>
          </p>
        </div>
      </motion.div>
    </div>
  )
}

// ── Skills ───────────────────────────────────────────────────────────────────
const TILT = [-3, 2.5, -1.5]

function Skills({ palette }) {
  return (
    <section id="pl-skills" aria-label="What I do" style={{ scrollMarginTop: 80, maxWidth: 1240, margin: '190px auto 0', padding: '0 20px', textAlign: 'center' }}>
      <Rise text="What I do" style={{ ...HEAD, fontSize: 'clamp(40px, 5.4vw, 76px)', lineHeight: 1, color: INK }} />
      <p style={{ margin: '10px 0 0', fontSize: 16, fontWeight: 500 }}>From interface to inference: {SITE.years}+ years, three disciplines</p>
      <div className="pl-skills" style={{ marginTop: 60, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 40, textAlign: 'left' }}>
        {EXPERTISE.map((x, i) => {
          const bg = [palette[0], palette[1], palette[3]][i] ?? palette[i % 4]
          const ink = inkOn(bg)
          return (
            <motion.article
              key={x.title}
              initial={{ y: -280, rotate: TILT[i] * 6, opacity: 0 }}
              whileInView={{ y: i === 1 ? 30 : 0, rotate: TILT[i], opacity: 1 }}
              viewport={{ once: true, margin: '-15% 0px' }}
              transition={{ type: 'spring', stiffness: 140, damping: 11, delay: i * 0.12 }}
              whileHover={{ rotate: 0, y: i === 1 ? 18 : -12, transition: SPRING }}
              style={{ background: bg, color: ink, borderRadius: 28, padding: 30, boxShadow: '0 30px 60px -24px rgba(0,0,0,0.3)', willChange: 'transform' }}
            >
              <h3 style={{ ...HEAD, margin: 0, fontSize: 34, lineHeight: 0.98 }}>{x.title}</h3>
              <p style={{ margin: '14px 0 0', fontSize: 14.5, lineHeight: 1.5 }}>{x.text}</p>
              <ul style={{ listStyle: 'none', margin: '20px 0 0', padding: 0, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {x.stack.map((t, k) => (
                  <motion.li
                    key={t}
                    initial={{ scale: 0, opacity: 0 }}
                    whileInView={{ scale: 1, opacity: 1 }}
                    viewport={{ once: true }}
                    transition={{ type: 'spring', stiffness: 400, damping: 18, delay: 0.5 + i * 0.12 + k * 0.04 }}
                    style={{ fontSize: 12.5, fontWeight: 600, padding: '6px 11px', borderRadius: 999, background: ink === '#ffffff' ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.08)' }}
                  >
                    {t}
                  </motion.li>
                ))}
              </ul>
            </motion.article>
          )
        })}
      </div>
    </section>
  )
}

const STREAM = ['React', 'Python', 'FastAPI', 'RAG', 'LangGraph', 'Claude', 'Groq', 'Whisper', 'Postgres', 'Docker', 'Tailwind', 'Motion']

function TechStream({ still }) {
  const row = STREAM.map((t) => (
    <span key={t} style={{ ...HEAD, fontSize: 'clamp(44px, 7vw, 104px)', lineHeight: 1, color: 'var(--pl-faint)', padding: '0 0.35em', whiteSpace: 'nowrap' }}>
      {t} <span style={{ color: 'var(--pl-line)' }}>✦</span>
    </span>
  ))
  return (
    <div aria-hidden="true" style={{ marginTop: 130, position: 'relative', overflow: 'hidden' }}>
      <div className={still ? '' : 'pl-stream'} style={{ display: 'flex', width: 'max-content', willChange: 'transform' }}>
        {row}
        {row}
      </div>
      <div style={{ position: 'absolute', inset: '0 auto 0 0', width: '12%', background: 'linear-gradient(90deg, var(--pl-bg), transparent)' }} />
      <div style={{ position: 'absolute', inset: '0 0 0 auto', width: '12%', background: 'linear-gradient(270deg, var(--pl-bg), transparent)' }} />
    </div>
  )
}

// ── More work ────────────────────────────────────────────────────────────────
function More({ palette, still }) {
  return (
    <section aria-label="More work" style={{ maxWidth: 1240, margin: '170px auto 0', padding: '0 20px', textAlign: 'center' }}>
      <Rise text="More work" style={{ ...HEAD, fontSize: 'clamp(40px, 5.4vw, 76px)', lineHeight: 1, color: INK }} />
      <p style={{ margin: '10px 0 0', fontSize: 16, fontWeight: 500 }}>In development: these open once the four above are finished</p>
      <div className="pl-more" style={{ marginTop: 64, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '72px 56px', perspective: 1200 }}>
        {FROZEN.map((p, i) => (
          <StackCard key={p.slug} p={p} color={palette[(i + 1) % palette.length]} index={i} still={still} />
        ))}
      </div>
    </section>
  )
}

function StackCard({ p, color, index, still }) {
  const [hover, setHover] = useState(false)
  const src = shot(p)
  return (
    <motion.div
      initial={{ rotateY: -80, opacity: 0, y: 40 }}
      whileInView={{ rotateY: 0, opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-10% 0px' }}
      transition={{ type: 'spring', stiffness: 120, damping: 16, delay: (index % 3) * 0.1 }}
      onHoverStart={() => setHover(true)}
      onHoverEnd={() => setHover(false)}
      style={{ position: 'relative', textAlign: 'left' }}
    >
      <div style={{ position: 'relative', aspectRatio: '1 / 1' }}>
        <motion.div animate={{ rotate: hover ? 9 : 4, x: hover ? 14 : 0, y: hover ? 6 : 0 }} transition={SPRING} style={{ position: 'absolute', inset: 0, borderRadius: 24, background: color }} />
        <motion.div animate={{ rotate: hover ? -3 : 0, y: hover ? -12 : 0 }} transition={SPRING} style={{ position: 'absolute', inset: 0, borderRadius: 24, overflow: 'hidden', background: 'var(--pl-chip)', boxShadow: '0 24px 50px -20px rgba(0,0,0,0.3)' }}>
          {src ? (
            <LiveShot src={src} alt={`${p.name} screenshot`} play={hover && !still} />
          ) : (
            <div style={{ ...HEAD, height: '100%', display: 'grid', placeItems: 'center', fontSize: 30, color: inkOn(color), background: color }}>{p.name}</div>
          )}
        </motion.div>
      </div>
      <p style={{ ...HEAD, margin: '20px 0 0', fontSize: 23 }}>{p.name}</p>
      <p style={{ margin: '4px 0 0', fontSize: 14, lineHeight: 1.45, color: MUTED }}>{p.tagline}</p>
    </motion.div>
  )
}

// ── Experience ───────────────────────────────────────────────────────────────
function Experience() {
  const jobs = TIMELINE.filter((t) => t.kind === 'work')
  const [open, setOpen] = useState(0)
  return (
    <section id="pl-exp" aria-label="Experience" style={{ maxWidth: 1040, margin: '180px auto 0', padding: '0 20px', scrollMarginTop: 80 }}>
      <div style={{ textAlign: 'center' }}>
        <Rise text="Experience" style={{ ...HEAD, fontSize: 'clamp(40px, 5.4vw, 76px)', lineHeight: 1, color: INK }} />
        <p style={{ margin: '10px 0 0', fontSize: 16, fontWeight: 500 }}>{SITE.current} · {SITE.years}+ years</p>
      </div>
      <ol style={{ listStyle: 'none', margin: '48px 0 0', padding: 0 }}>
        {jobs.map((j, i) => (
          <motion.li key={j.period} initial="off" whileInView="on" viewport={{ once: true, margin: '-10% 0px' }} style={{ position: 'relative' }}>
            <motion.span aria-hidden="true" variants={{ off: { scaleX: 0 }, on: { scaleX: 1, transition: { duration: 0.9, delay: i * 0.12, ease: [0.2, 0.9, 0.2, 1] } } }} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 1, background: 'var(--pl-line)', transformOrigin: '0 50%' }} />
            <motion.button
              type="button"
              aria-expanded={open === i}
              onClick={() => setOpen(open === i ? -1 : i)}
              variants={{ off: { y: 24, opacity: 0 }, on: { y: 0, opacity: 1, transition: { duration: 0.7, delay: 0.15 + i * 0.12 } } }}
              whileHover={{ x: 8 }}
              style={{ all: 'unset', boxSizing: 'border-box', width: '100%', cursor: 'pointer', padding: '24px 0', display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '6px 24px' }}
            >
              <span style={{ ...HEAD, flex: '1 1 300px', fontSize: 30, lineHeight: 1.05, color: INK }}>{j.org.split(' · ')[0]}</span>
              <span style={{ flex: '1 1 280px', fontSize: 15, fontWeight: 500, color: INK }}>{j.title} · {j.org.split(' · ').slice(1).join(' · ')}</span>
              <span style={{ fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase', color: MUTED }}>{j.period} {open === i ? '−' : '+'}</span>
            </motion.button>
            <AnimatePresence initial={false}>
              {open === i && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.35 }} style={{ overflow: 'hidden' }}>
                  <ul style={{ margin: '0 0 8px', paddingLeft: 18, color: INK, fontSize: 15, lineHeight: 1.6 }}>
                    {j.points.map((pt) => <li key={pt}>{pt}</li>)}
                  </ul>
                  <p style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '0 0 24px' }}>
                    {j.tags.map((t) => <span key={t} style={{ fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 999, background: 'var(--pl-chip)', color: INK }}>{t}</span>)}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.li>
        ))}
      </ol>
    </section>
  )
}

// ── Contact ──────────────────────────────────────────────────────────────────
function Contact({ still }) {
  const ref = useRef(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end end'] })
  const scaleY = useTransform(scrollYProgress, [0, 0.75], [0.08, 1])
  const links = [
    SITE.links.email && { href: `mailto:${SITE.links.email}`, label: SITE.links.email },
    SITE.links.linkedin && { href: SITE.links.linkedin, label: 'LinkedIn' },
    SITE.links.github && { href: SITE.links.github, label: 'GitHub' },
  ].filter(Boolean)
  return (
    <footer ref={ref} id="pl-contact" style={{ marginTop: 180, background: 'var(--pl-band)', scrollMarginTop: 80, padding: '110px 16px 44px', textAlign: 'center', overflow: 'hidden' }}>
      <motion.p aria-label="Contact" style={{ ...HEAD, fontWeight: 700, margin: 0, fontSize: 'clamp(84px, 25vw, 420px)', lineHeight: 0.8, letterSpacing: '-0.03em', color: INK, scaleY: still ? 1 : scaleY, transformOrigin: '50% 100%' }}>
        {[...'Contact'].map((ch, i) => (
          <motion.span key={i} aria-hidden="true" style={{ display: 'inline-block', transformOrigin: '50% 100%' }} whileHover={{ scaleY: 1.14, scaleX: 0.92, y: -6 }} transition={{ type: 'spring', stiffness: 420, damping: 10 }}>
            {ch}
          </motion.span>
        ))}
      </motion.p>
      <ContactForm />
      <ul style={{ listStyle: 'none', margin: '40px 0 0', padding: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        {links.map((l) => (
          <li key={l.href}>
            <motion.a href={l.href} target={l.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer" initial="off" whileHover="on" style={{ ...HEAD, letterSpacing: '0.02em', fontSize: 17, color: INK, textDecoration: 'none', position: 'relative', display: 'inline-block' }}>
              {l.label}
              <motion.span aria-hidden="true" variants={{ off: { scaleX: 0 }, on: { scaleX: 1 } }} transition={{ duration: 0.3 }} style={{ position: 'absolute', left: 0, right: 0, bottom: -3, height: 2, background: INK, transformOrigin: '0 50%' }} />
            </motion.a>
          </li>
        ))}
      </ul>
      <p style={{ margin: '40px 0 0', fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: MUTED }}>Built end to end by {SITE.owner}</p>
    </footer>
  )
}

/** The same contact endpoint as the rest of the site, in this page's look. */
function ContactForm() {
  const [form, setForm] = useState({ name: '', email: '', message: '', website: '' })
  const [state, setState] = useState('idle')
  const [error, setError] = useState('')
  const field = { width: '100%', boxSizing: 'border-box', borderRadius: 14, border: '1px solid var(--pl-line)', background: 'var(--pl-bg)', color: INK, padding: '12px 14px', fontSize: 15, fontFamily: 'inherit' }
  const submit = async (e) => {
    e.preventDefault()
    setState('sending')
    setError('')
    try {
      const res = await fetch(`${API_BASE}/api/contact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      if (!res.ok) throw new Error(res.status === 429 ? 'Too many messages. Please try again in a minute.' : res.status === 422 ? 'Please check your email address and write at least 10 characters.' : 'Something went wrong. Please email me directly instead.')
      setState('sent')
      track('contact')
      setForm({ name: '', email: '', message: '', website: '' })
    } catch (err) {
      setError(err.message)
      setState('error')
    }
  }
  if (state === 'sent') return <p style={{ ...HEAD, margin: '40px auto 0', fontSize: 22, color: INK }}>Thanks, message received. I'll reply soon.</p>
  return (
    <form onSubmit={(e) => void submit(e)} aria-label="Contact form" style={{ maxWidth: 560, margin: '44px auto 0', display: 'grid', gap: 10, textAlign: 'left' }}>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <label><span className="sr-only">Your name</span><input required placeholder="Your name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={field} /></label>
        <label><span className="sr-only">Your email</span><input required type="email" placeholder="Your email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} style={field} /></label>
      </div>
      <label><span className="sr-only">Message</span><textarea required minLength={10} rows={4} placeholder="What would you like to build?" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} style={{ ...field, resize: 'vertical' }} /></label>
      <input tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} style={{ position: 'absolute', left: -9999, width: 1, height: 1 }} />
      {error && <p role="alert" style={{ margin: 0, color: '#c0392b', fontSize: 14 }}>{error}</p>}
      <button type="submit" disabled={state === 'sending'} style={{ ...HEAD, justifySelf: 'center', marginTop: 6, padding: '12px 28px', borderRadius: 999, border: 0, background: INK, color: 'var(--pl-bg)', fontSize: 16, letterSpacing: '0.06em', cursor: 'pointer', opacity: state === 'sending' ? 0.6 : 1 }}>
        {state === 'sending' ? 'Sending…' : 'Send message'}
      </button>
    </form>
  )
}

/** Section links, search, the theme and Personal / Studio switch; a "preview" mark while this page is unreleased. */
function TopNav() {
  const links = [['pl-work', 'Work'], ['pl-skills', 'Skills'], ['pl-exp', 'Experience'], ['pl-contact', 'Contact']]
  return (
    <nav aria-label="Sections" style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 30, display: 'flex', alignItems: 'center', gap: 4, padding: 5, borderRadius: 999, background: 'color-mix(in srgb, var(--pl-bg) 82%, transparent)', backdropFilter: 'blur(12px)', boxShadow: '0 10px 30px rgba(0,0,0,0.12)', border: '1px solid var(--pl-line)', maxWidth: 'calc(100vw - 96px)' }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '5px 9px', borderRadius: 999, background: INK, color: 'var(--pl-bg)', whiteSpace: 'nowrap' }}>Preview</span>
      {links.map(([id, label]) => (
        <a key={id} href={`#${id}`} className="pl-navlink" style={{ ...HEAD, letterSpacing: '0.04em', fontSize: 13.5, color: INK, textDecoration: 'none', padding: '6px 10px', borderRadius: 999 }}>{label}</a>
      ))}
      <button type="button" onClick={openPalette} aria-label="Search the site (Ctrl K)" style={{ display: 'grid', placeItems: 'center', width: 32, height: 32, borderRadius: 999, border: 0, background: 'transparent', color: INK, cursor: 'pointer' }}>
        <Search size={16} />
      </button>
      <ThemeToggle compact />
    </nav>
  )
}

function useOwnerTime() {
  const [t, setT] = useState(() => timeIn(SITE.timeZone))
  useEffect(() => {
    const id = window.setInterval(() => setT(timeIn(SITE.timeZone)), 30_000)
    return () => window.clearInterval(id)
  }, [])
  return t
}

/** Reading progress along the top, and a way back up once you are far down. */
function ScrollAids({ still }) {
  const { scrollY, scrollYProgress } = useScroll()
  const [far, setFar] = useState(false)
  useMotionValueEvent(scrollY, 'change', (v) => setFar(v > 1400))
  return (
    <>
      <motion.div aria-hidden="true" style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 3, background: INK, transformOrigin: '0 50%', scaleX: scrollYProgress, zIndex: 40 }} />
      <AnimatePresence>
        {far && (
          <motion.button type="button" aria-label="Back to top" onClick={() => window.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' })}
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
            style={{ position: 'fixed', bottom: 76, right: 14, zIndex: 30, width: 50, height: 50, borderRadius: '50%', border: 0, background: 'var(--pl-chip)', color: INK, boxShadow: '0 12px 30px rgba(0,0,0,0.16)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
            <ArrowUp size={20} />
          </motion.button>
        )}
      </AnimatePresence>
    </>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export function PlayfulSpace() {
  const reduce = useReducedMotion()
  const still = Boolean(reduce || LITE)
  const [pal, setPal] = useState(0)
  const palette = PALETTES[pal % PALETTES.length]
  const spin = useMotionValue(0)
  const time = useOwnerTime()

  // This page only: the condensed headline font, and keep the preview out of search results.
  useEffect(() => {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&display=swap' })
    const robots = Object.assign(document.createElement('meta'), { name: 'robots', content: 'noindex, nofollow' })
    document.head.append(link, robots)
    return () => {
      link.remove()
      robots.remove()
    }
  }, [])

  const recolour = () => {
    setPal((v) => v + 1)
    if (!still) animate(spin, spin.get() + 360, { type: 'spring', stiffness: 120, damping: 14 })
  }

  return (
    <MotionConfig reducedMotion={still ? 'always' : 'never'}>
      <div className="pl-root" style={{ minHeight: '100vh', background: 'var(--pl-bg)', color: INK, fontFamily: 'Inter, system-ui, sans-serif', overflowX: 'clip', position: 'relative' }}>
        <style>{THEME}</style>
        <style>{`
          .pl-navlink:hover { background: var(--pl-chip) }
          @media (max-width: 720px) { .pl-navlink { display: none } }
          .pl-track { scrollbar-width: none } .pl-track::-webkit-scrollbar { display: none }
          .pl-stream { animation: pl-stream 38s linear infinite } .pl-stream:hover { animation-play-state: paused }
          @keyframes pl-stream { to { transform: translate3d(-50%, 0, 0) } }
          @media (max-width: 760px) { .pl-skills { grid-template-columns: minmax(0,1fr) !important } .pl-more { grid-template-columns: repeat(2, minmax(0,1fr)) !important } }
          @media (max-width: 480px) { .pl-more { grid-template-columns: minmax(0,1fr) !important } }
        `}</style>

        <a href="#pl-work" className="sr-only focus:not-sr-only" style={{ position: 'fixed', top: 8, left: 8, zIndex: 50, padding: '8px 14px', borderRadius: 999, background: INK, color: 'var(--pl-bg)' }}>Skip to the work</a>
        <ScrollAids still={still} />
        <TopNav />
        <Link to="/" aria-label="Back to the main site" style={{ position: 'fixed', top: 14, right: 14, zIndex: 30, width: 50, height: 50, borderRadius: '50%', overflow: 'hidden', background: 'var(--pl-chip)', boxShadow: '0 12px 30px rgba(0,0,0,0.16)', display: 'block' }}>
          <img src={SITE.avatarFace || SITE.avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        </Link>
        <motion.button type="button" onClick={recolour} aria-label="Change the colours" whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.9 }} style={{ position: 'fixed', bottom: 14, right: 14, zIndex: 30, width: 50, height: 50, borderRadius: '50%', border: 0, background: 'var(--pl-chip)', color: INK, boxShadow: '0 12px 30px rgba(0,0,0,0.16)', display: 'grid', placeItems: 'center', cursor: 'pointer', rotate: spin }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.5-1.1-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4.1-4-7.5-9-7.5Z" />
            <circle cx="7.5" cy="10.5" r="1.2" fill="currentColor" /><circle cx="10.5" cy="7" r="1.2" fill="currentColor" /><circle cx="15" cy="7.5" r="1.2" fill="currentColor" />
          </svg>
        </motion.button>

        <main>
          <header style={{ maxWidth: 1440, margin: '0 auto', padding: '92px 16px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
            <Rise as="p" onView={false} text={SITE.location} style={{ ...HEAD, letterSpacing: '0.09em', fontSize: 14 }} />
            <p style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '4px 14px', margin: '4px 0 0', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: MUTED }}>
              {time && <span>{time.text} here</span>}
              {SITE.links.email && <a href={`mailto:${SITE.links.email}`} style={{ color: MUTED, textDecoration: 'none' }}>{SITE.links.email}</a>}
              {SITE.links.github && <a href={SITE.links.github} target="_blank" rel="noreferrer" style={{ color: MUTED }}>GitHub</a>}
              {SITE.links.linkedin && <a href={SITE.links.linkedin} target="_blank" rel="noreferrer" style={{ color: MUTED }}>LinkedIn</a>}
              {SITE.resume && <a href={SITE.resume} target="_blank" rel="noreferrer" style={{ color: MUTED }}>Résumé</a>}
            </p>
            <Rise as="h1" onView={false} letters delay={0.15} text={SITE.owner} style={{ ...HEAD, marginTop: 70, fontSize: 'clamp(56px, 9.4vw, 136px)', lineHeight: 0.92, color: INK, position: 'relative', zIndex: 4 }} />
            <div style={{ width: 'min(760px, 100%)', marginTop: -6 }}>
              <Deck items={PORTFOLIO.filter(shot)} palette={palette} still={still} />
            </div>
            <ScrollFill text={`${SITE.role} & product builder`} style={{ ...HEAD, marginTop: 10, fontSize: 'clamp(42px, 7.4vw, 110px)', lineHeight: 0.96, maxWidth: 1200 }} />
            {SITE.availability && <p style={{ margin: '22px 0 0', fontSize: 15, fontWeight: 500, color: INK }}>{SITE.availability}</p>}
            <dl style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '18px 56px', margin: '48px 0 0' }}>
              {[[`${SITE.years}+`, 'years building software'], [`${PORTFOLIO.length}`, 'AI products, end to end'], [`${SITE.clientCount}`, 'enterprise clients served']].map(([n, label]) => (
                <div key={label}>
                  <dt style={{ ...HEAD, fontSize: 'clamp(40px, 5vw, 64px)', lineHeight: 1, color: INK }}>{n}</dt>
                  <dd style={{ margin: '4px 0 0', fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase', color: MUTED }}>{label}</dd>
                </div>
              ))}
            </dl>
            <Rise as="p" text="Industries include" style={{ ...HEAD, marginTop: 52, letterSpacing: '0.09em', fontSize: 14 }} />
            <p style={{ margin: '6px 0 0', fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: MUTED }}>{SITE.industries.join(', ')}</p>
            {SITE.now?.length > 0 && (
              <div style={{ marginTop: 52, maxWidth: 900 }}>
                <p style={{ ...HEAD, margin: 0, letterSpacing: '0.09em', fontSize: 14 }}>Right now</p>
                <ul style={{ listStyle: 'none', margin: '14px 0 0', padding: 0, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 12 }}>
                  {SITE.now.map((n, i) => (
                    <motion.li key={n} initial={{ opacity: 0, y: 16, rotate: 0 }} whileInView={{ opacity: 1, y: 0, rotate: [-2, 1.5, -1][i % 3] }} viewport={{ once: true }} transition={{ ...SPRING, delay: i * 0.08 }}
                      style={{ background: palette[(i + 1) % palette.length], color: inkOn(palette[(i + 1) % palette.length]), padding: '12px 16px', borderRadius: 16, fontSize: 14, fontWeight: 500, maxWidth: 280, textAlign: 'left', boxShadow: '0 14px 30px -18px rgba(0,0,0,0.35)' }}>
                      {n}
                    </motion.li>
                  ))}
                </ul>
              </div>
            )}
          </header>

          <Featured palette={palette} still={still} />
          <Skills palette={palette} />
          <TechStream still={still} />
          <More palette={palette} still={still} />
          <Experience />
        </main>
        <Contact still={still} />
        <SkillsChat />
      </div>
    </MotionConfig>
  )
}
