import {
  AudioLines,
  BriefcaseBusiness,
  Bug,
  Code2,
  Dna,
  FileSearch,
  HandHelping,
  Route,
  Workflow,
} from 'lucide-react'

/**
 * THE product registry: the single source of truth for every product identity, status and visibility on the site
 * (hub, product pages, command palette, counts). The backend has no product records; it only serves the apps.
 *
 * visibility: 'portfolio' = one of the four featured products, each working end to end · 'frozen' = in development,
 *             shown as a locked tile (its code and route stay, but the catalogue doesn't send people there)
 * problem:    the question the catalogue leads with ("Have this problem?"); outcome: what the product does about it
 * status:     see STATUSES. "live" only when the principal workflow works end to end, persists, is access-
 *             controlled where needed and is tested; approval is NOT completion.
 * meaning:    one line on what the product's name means (shown on the product page and the Studio home).
 * app:        a route that can be opened today. kind 'product' = the product itself; 'prototype' = an earlier app
 *             the product builds on (it does not provide the approved product's advertised workflow).
 */
export const STATUSES = {
  live: { label: 'Live', tone: 'good' },
  beta: { label: 'Beta', tone: 'good' },
  frozen: { label: 'In development', tone: 'neutral' },
  in_development: { label: 'In development', tone: 'info' },
  planned: { label: 'Planned', tone: 'neutral' },
  gated: { label: 'Gated', tone: 'warn' },
  labs: { label: 'Labs', tone: 'neutral' },
}

export const MODULE_STATUSES = {
  available: { label: 'Available', tone: 'good' },
  partial: { label: 'Partial', tone: 'info' },
  planned: { label: 'Planned', tone: 'neutral' },
}

const VERIFIED = '2026-11-14'

const REGISTRY = [
  // ── Entries in registry order; PORTFOLIO below sorts the four featured ones by priority ──
  {
    id: 'efi',
    problem: 'A build, test or deploy failed and the log is thousands of lines long?',
    outcome: 'Paste the log: Jasoos finds the failing step, the likely cause and a fix, quoting the exact lines it relied on.',
    slug: 'jasoos',
    aliases: ['efi'],
    name: 'Jasoos',
    meaning: 'Hindi for detective: it investigates why something failed, and shows its evidence.',
    fullName: 'Jasoos: the build-failure detective',
    visibility: 'portfolio',
    priority: 4,
    status: 'beta',
    lastVerified: VERIFIED,
    statusNote:
      'The full workflow is implemented and covered by automated tests with a mocked model. It is not yet verified with a ' +
      'live Groq call or in a browser, history is tied to one browser (no accounts yet), and the deployed backend is not ' +
      'yet connected to Postgres, so investigations would not persist there.',
    tagline: 'Find out why a build, test or deploy failed, with evidence.',
    description:
      'Upload CI logs, stack traces, git diffs and JUnit reports. Secrets are redacted, errors, stack frames, failed tests ' +
      'and changed lines are extracted with plain parsing, and an LLM proposes root-cause hypotheses that must cite that ' +
      'evidence. Unsupported claims are rejected, and you get a validation checklist for the fix.',
    category: 'Developer Tools',
    icon: Bug,
    accent: 'from-rose-500 via-red-500 to-orange-400',
    tags: ['Evidence-grounded AI', 'Log & diff parsing', 'Secret redaction'],
    app: { label: 'Open Jasoos', route: '/jasoos', kind: 'product' },
    available: [
      'Upload or paste logs, stack traces, diffs, JUnit XML, manifests and config (text only, size-capped)',
      'Secret redaction before storage or analysis',
      'Deterministic evidence with stable IDs, correlations and a failure timeline',
      'Bounded gpt-oss-120b analysis on Groq, with verified evidence citations',
      'Report, validation checklist, confirmed-root-cause feedback, history and deletion',
    ],
    planned: ['Accounts and team workspaces', 'Repository snapshot ingestion', 'Optional CI upload helper (GitHub Action / CLI)', 'Failure history per repository (flaky tests)'],
    stack: ['React 19', 'FastAPI', 'Groq gpt-oss-120b', 'Deterministic parsers', 'BM25', 'Neon Postgres'],
  },
  {
    id: 'keeper',
    problem: 'Want an assistant that actually gets things done, by voice or text?',
    outcome: 'Ask Tara on your laptop or phone: it checks the weather and news, answers questions, opens apps, plays music, sets timers, prepares calls and messages, and remembers and reminds, out loud.',
    slug: 'tara',
    aliases: ['keeper', 'tijori'],
    image: 'tara',
    name: 'Tara',
    meaning: 'Hindi for star: easy to call out (“Hey Tara”), and always there to guide you.',
    fullName: 'Tara: your voice-first personal assistant',
    visibility: 'portfolio',
    priority: 3,
    status: 'beta',
    lastVerified: VERIFIED,
    statusNote: 'Voice-first personal assistant you can wake with “Hey Tara” (opt-in, while the page is open): live weather, news, facts, rates and world time; opens apps, plays music, directions, timers and calendar events; prepares calls, messages and emails for you to confirm; reminders and where things are. Senses how you feel from your words and adapts its replies, with a safety response for distress. Routing and emotion reading are measured on the Quality page.',
    tagline: 'A voice-first personal assistant: answers, live info, actions on your device, and reminders.',
    description:
      'Photograph a bill or warranty card: Tara extracts the purchase facts with their source, tracks return and warranty ' +
      'deadlines (verified, confirmed by you, estimated or unknown, never guessed), and when something breaks, assembles the ' +
      'claim evidence and drafts the message for you to send.',
    category: 'Personal assistant',
    icon: HandHelping,
    accent: 'from-fuchsia-500 via-pink-500 to-orange-400',
    tags: ['Voice assistant', 'Live weather & news', 'Actions on your device'],
    app: { label: 'Open Tara', route: '/keeper', kind: 'product' },
    available: ['Prototype: natural-language memory (stash, loans, bills, care), photo scanning, timed reminders via ntfy / Telegram'],
    planned: [
      'Purchase capture with field-level provenance',
      'Return and warranty deadline management (verified / confirmed / estimated / unknown)',
      'Claim evidence packs and fact-checked claim drafts',
      'Claim status tracking and recovered-value records',
    ],
    stack: ['React 19 PWA', 'FastAPI', 'LangGraph', 'Vision LLM', 'Web Push'],
  },
  {
    id: 'documind-respond',
    slug: 'pramaan',
    aliases: ['documind-respond', 'documind'],
    image: 'documind',
    name: 'Pramaan',
    meaning: 'Sanskrit and Hindi for proof: every answer is backed by approved evidence.',
    fullName: 'Pramaan: questionnaires answered from evidence',
    visibility: 'frozen',
    priority: 4,
    status: 'frozen',
    lastVerified: VERIFIED,
    statusNote:
      'Approved, gated on validation: building starts only when two design partners commit to using it on live ' +
      'questionnaires. The DocuMind RAG Studio it builds on is available as a prototype.',
    tagline: 'Answer security and vendor questionnaires from your own approved evidence.',
    description:
      'Import an XLSX security or vendor questionnaire; every answer is drafted only from your approved, unexpired evidence, ' +
      'cited to the passage, and marked supported, partial, contradictory or missing, so certifications, dates and numbers ' +
      'are never invented. A reviewer approves each answer before export.',
    category: 'B2B compliance',
    icon: FileSearch,
    accent: 'from-indigo-500 via-violet-500 to-cyan-400',
    tags: ['Evidence-backed answers', 'Questionnaire automation', 'Human approval'],
    app: { label: 'Open the DocuMind RAG Studio prototype', route: '/documind', kind: 'prototype' },
    available: ['Prototype: cited RAG chat, Pipeline Studio, document briefs and the Match Analyzer over the indexed documents'],
    planned: [
      'Evidence library with owner approval and expiry',
      'XLSX questionnaire import and question confirmation',
      'Per-question retrieval and evidence-backed drafting with four evidence statuses',
      'Reviewer approval and export into the original workbook',
    ],
    stack: ['React 19', 'FastAPI', 'LangGraph', 'Hybrid retrieval', 'openpyxl'],
  },
  {
    id: 'follow-through',
    slug: 'vaada',
    aliases: ['follow-through', 'meetingmind'],
    image: 'meetingmind',
    name: 'Vaada',
    meaning: 'Hindi and Urdu for a promise: commitments made in a meeting are kept.',
    fullName: 'Vaada: every commitment, followed through',
    visibility: 'frozen',
    priority: 5,
    status: 'frozen',
    lastVerified: VERIFIED,
    statusNote:
      'Approved and deferred. Commitment normalisation, member identity, reliable notification delivery and escalation are ' +
      'not built yet. MeetingMind (transcripts to decisions and an action board) is available as a prototype.',
    tagline: 'Every commitment gets an owner, a date and a follow-up until it is done.',
    description:
      'Paste a transcript or notes: decisions and commitments are extracted, owners and deadlines are matched to your team and ' +
      'confirmed by you, then followed up through linked channels with tracked delivery, escalation and outcome reporting.',
    category: 'Team productivity',
    icon: AudioLines,
    accent: 'from-emerald-500 via-teal-400 to-cyan-400',
    tags: ['Commitment extraction', 'Human confirmation', 'Tracked follow-ups'],
    app: { label: 'Open the MeetingMind prototype', route: '/meetingmind', kind: 'prototype' },
    available: ['Prototype: transcripts or recordings to decisions, action items, a Kanban board and archive Q&A'],
    planned: [
      'Owner and deadline normalisation against workspace members',
      'Mandatory human confirmation of commitments',
      'Notification outbox with delivery tracking (Telegram, ntfy, Web Push)',
      'Follow-up and escalation rules, completion and outcome reports',
    ],
    stack: ['React 19', 'FastAPI', 'Structured extraction', 'Rules engine'],
  },
  {
    id: 'tripweaver',
    problem: 'Planning a trip means juggling a dozen tabs and apps?',
    outcome: 'Get a day-by-day plan with real places, weather and routes in four taps, then book, budget and keep your documents in one place.',
    slug: 'safarnaama',
    aliases: ['tripweaver', 'safarnama'],
    image: 'safarnaama',
    name: 'Safarnaama',
    meaning: 'Urdu and Hindi for a travelogue: the whole journey, from the first idea to the memories.',
    fullName: 'Safarnaama: your complete travel companion',
    visibility: 'portfolio',
    priority: 1,
    status: 'beta',
    lastVerified: VERIFIED,
    statusNote:
      'Implemented end to end and covered by automated tests: trips with several destinations, an editable itinerary with ' +
      'evidence-backed labels, discovery across food, shopping, experiences and services, saved places, bookings, budget ' +
      'and expenses, documents and checklists, and a travel companion routed through the central Groq router. Not live yet: ' +
      'the deployed backend still has no Postgres (trips would not persist there), the app has not been browser-verified, ' +
      'identity is per browser (no accounts), and ordering, booking, ratings and live transit need commercial providers.',
    tagline: 'One intelligent platform to plan, discover, experience, manage and remember every journey.',
    description:
      'Safarnaama owns the journey from planning to returning home. The itinerary is the organising object: food, shopping, ' +
      'experiences, weather, routes, bookings and expenses are all connected to the trip, its days, the next stop, the ' +
      'traveller\'s location, time and budget. Recommendations come from real provider data, never invented places, ratings ' +
      'or availability, and nothing is ordered, booked or paid by Safarnaama: external actions are confirmed hand-offs to the provider.',
    category: 'Travel',
    icon: Route,
    accent: 'from-lime-500 via-emerald-500 to-teal-500',
    tags: ['Itinerary-centred', 'Contextual discovery', 'Travel companion'],
    app: { label: 'Open Safarnaama', route: '/safarnaama', kind: 'product' },
    modules: [
      { id: 'planning', title: 'Trip planning & management', status: 'available', text: 'AI planner (free text, several cities) or manual trips with up to 5 destinations and 14 days, dates, party, travellers, budget, interests and pace; edit, archive, upcoming/active/past grouping; share link for collaborators (view, vote, shared expenses). Identity is per browser: no accounts yet.' },
      { id: 'itinerary', title: 'Intelligent itinerary engine', status: 'available', text: 'Day-wise morning/afternoon/evening plan with durations, route legs and travel times, best visiting order, edit/move/remove/reorder, pins kept on re-plan, regeneration of selected days, schedule checks (overlaps, closed at visit time) and evidence-backed labels: Must visit, Time sensitive, Weather dependent, Reservation recommended, Near your route, Traveller favourite; Local favourite and Hidden gem only as your own tags (no rating data exists).' },
      { id: 'discovery', title: 'Local discovery', status: 'available', text: 'Ten OpenStreetMap categories around a destination, a stop or your location (with permission): food, sights, experiences, shopping, nature, indoor, family, nightlife, transport, services; filters, saved places, add to the itinerary, map pins. No ratings or prices: free map data has none.' },
      { id: 'food', title: 'Food discovery & ordering', status: 'partial', text: 'Restaurants, cafés, street food and markets with cuisine, vegetarian, vegan and open-at-visit filters, meal slotting near your route, and menu/booking/phone hand-offs taken from the venue data. Ordering, delivery and table booking need commercial provider integrations: Safarnaama hands off and never simulates an order.' },
      { id: 'shopping', title: 'Local shopping & souvenirs', status: 'partial', text: 'Souvenir, craft, artisan, market and local-food shops from OpenStreetMap, plus AI-suggested local specialities (labelled) matched to real nearby shops. Stock and prices are not known.' },
      { id: 'experiences', title: 'Experiences & activities', status: 'partial', text: 'Museums, theatres, zoos, aquariums, parks, nature spots and family venues from OpenStreetMap, with venue-site hand-offs. Guided tours, events and ticket availability need a provider (integration pending).' },
      { id: 'weather', title: 'Weather & travel intelligence', status: 'available', text: 'Per-destination daily forecast, current conditions, hourly rain with the driest window, forecast-derived alerts (not official warnings), weather-dependent labels, indoor alternatives and re-planning; every forecast shows when it was fetched.' },
      { id: 'maps', title: 'Maps, navigation & local transport', status: 'partial', text: 'Interactive map with itinerary and discovery pins, day routes, driving times (OSRM, no live traffic), walking estimates, stations and airports with transfer times. Public-transport timetables and cycling routes are not integrated.' },
      { id: 'bookings', title: 'Booking & reservation management', status: 'available', text: 'Flights, hotels, trains, buses, cars, restaurants, activities, tours and tickets saved with references, times, cancellation terms and costs, linked to days and stops, with provider hand-offs. Direct booking needs provider APIs: Safarnaama never claims a booking it did not see confirmed.' },
      { id: 'budget', title: 'Budget & expenses', status: 'available', text: 'Trip and category budgets, actual spend kept separate from estimates, daily totals, group split and settle-up, dated reference exchange rates (Frankfurter) or your own rate, and receipt reading by a vision model as a draft you confirm.' },
      { id: 'companion', title: 'Travel companion', status: 'available', text: 'Uses your itinerary, local time, location (only when you allow it), stored forecast with its age, budget, bookings and real nearby places. Suggestions are checked against real data and applied only when you confirm; it never books, orders or pays.' },
      { id: 'documents', title: 'Travel documents & preparedness', status: 'available', text: 'Confirmations, tickets, insurance, emergency contacts and notes with small file attachments, visible only to the trip owner; checklists and a packing list built from the forecast, trip length and party.' },
      { id: 'post-trip', title: 'Post-trip experience', status: 'available', text: 'Trip summary (days, stops, distance, spend against budget, favourites, saved places), archive and travel history, and AI-suggested future destinations.' },
    ],
    roadmap: [
      { stage: 'Stage 1', title: 'Core travel foundation', text: 'Done: trip ownership (per browser), editable day-wise itinerary, saved places, map and weather, budget, local discovery. Remaining: real accounts.' },
      { stage: 'Stage 2', title: 'Contextual discovery', text: 'Done: food, attractions, souvenirs and services near the next stop or your location, with weather-, itinerary- and route-aware labels whose evidence is shown.' },
      { stage: 'Stage 3', title: 'Travel operations', text: 'Done: bookings, transport and airport information, documents, expenses and group splitting. Remaining: public-transport timetables.' },
      { stage: 'Stage 4', title: 'Travel commerce', text: 'Provider hand-offs only. Ordering and booking need real provider integrations with understood terms; no own payments.' },
      { stage: 'Stage 5', title: 'Intelligent travel companion', text: 'Done: context-aware companion with confirmable actions. Next: proactive disruption alerts.' },
    ],
    available: [
      'Trips with several destinations, dates, party, budget and preferences, by AI planner or by hand',
      'Editable day-wise itinerary with evidence-backed labels, pins, schedule checks and partial re-planning',
      'Discovery of real food, shops, experiences, nature and services, with saved places and add-to-day',
      'Bookings, budget and expenses (currency, group split), documents and checklists',
      'Travel companion with confirmable suggestions, plus a post-trip summary',
    ],
    planned: ['Accounts (identity is per browser today)', 'Ordering, booking and ticketing integrations (need commercial providers)', 'Public-transport timetables', 'Proactive disruption alerts'],
    stack: ['React 19', 'Leaflet + OSM', 'FastAPI', 'Open-Meteo', 'OSRM', 'Overpass / Nominatim', 'Frankfurter', 'Groq LLM router'],
  },

  // ── Earlier experiments (frozen: in development) ──
  {
    id: 'careerpilot',
    name: 'CareerPilot',
    visibility: 'frozen',
    status: 'frozen',
    lastVerified: VERIFIED,
    statusNote: 'Archived to Labs: replaced in the portfolio by Jasoos. Note: its match score uses the documents indexed in DocuMind, not the resume you save.',
    tagline: 'Job-hunt copilot: tailored resume and cover letter, voice mock interviews, application board.',
    category: 'Labs · Career',
    icon: BriefcaseBusiness,
    accent: 'from-sky-500 via-blue-500 to-indigo-500',
    tags: ['Structured outputs', 'Voice agent'],
    app: { label: 'Open CareerPilot', route: '/careerpilot', kind: 'labs' },
    stack: ['React 19', 'FastAPI', 'Web Speech'],
  },
  {
    id: 'flowforge',
    name: 'FlowForge',
    visibility: 'frozen',
    status: 'frozen',
    lastVerified: VERIFIED,
    statusNote: 'Labs. Its validated DAG runtime is the basis for future automation inside the portfolio products.',
    tagline: 'Drag AI, HTTP, condition and Keeper steps onto a canvas; run them live, as webhooks or on a schedule.',
    category: 'Labs · Automation',
    icon: Workflow,
    accent: 'from-violet-500 via-purple-500 to-fuchsia-500',
    tags: ['Visual builder', 'DAG runtime'],
    app: { label: 'Open FlowForge', route: '/flowforge', kind: 'labs' },
    stack: ['React Flow', 'FastAPI', 'SSE'],
  },
  {
    id: 'evolve',
    name: 'Evolve',
    visibility: 'frozen',
    status: 'frozen',
    lastVerified: VERIFIED,
    statusNote: 'Labs. Its checks, judge and regression gate are a reusable quality capability for the portfolio products.',
    tagline: 'Prompts that learn from their own mistakes, promoted only after beating the old version.',
    category: 'Labs · Self-improving AI',
    icon: Dna,
    accent: 'from-teal-500 via-emerald-500 to-lime-400',
    tags: ['LLM-as-judge', 'Regression-gated'],
    app: { label: 'Open Evolve', route: '/evolve', kind: 'labs' },
    stack: ['FastAPI', 'LLM judge', 'Prompt versioning'],
  },
  {
    id: 'codelens',
    meaning: 'A lens on a codebase: see what it does and where, before you change it.',
    description:
      'Point CodeLens at a GitHub repository. It reads the code, maps its modules and imports, and answers questions about it ' +
      'with the files and lines it relied on, so a new joiner can find their way around without waiting for a KT session.',
    problem: 'Joining a new codebase and waiting days for KT sessions?',
    outcome: 'Paste the GitHub repo: get an onboarding pack with what it does, how it fits together, what to read first and a week-one plan, then ask anything, with answers that cite the exact files and lines.',
    name: 'CodeLens',
    visibility: 'portfolio',
    priority: 2,
    status: 'beta',
    lastVerified: VERIFIED,
    statusNote: 'Builds an onboarding pack for any public GitHub repo (what it is, how it is organised, what to read first, a week-one plan with progress ticks, setup commands taken from the README) and answers questions with file-and-line citations. Every file path is checked against the repo. Not yet verified with a live model on the deployed backend.',
    tagline: 'An onboarding pack and a code-aware Q&A for any GitHub repo: new joiners productive in a week, no KT sessions.',
    category: 'Developer onboarding',
    icon: Code2,
    accent: 'from-amber-500 via-orange-500 to-rose-500',
    tags: ['Onboarding pack', 'Code Q&A with citations', 'Week-one plan'],
    app: { label: 'Open CodeLens', route: '/codelens', kind: 'product' },
    stack: ['React Flow', 'FastAPI', 'Python ast', 'BM25 + RRF'],
  },
].map((p) => ({ ...p, slug: p.slug ?? p.id, features: p.features ?? [], aliases: p.aliases ?? [] }))

/** The approved portfolio, in priority order. Its length is THE product count shown anywhere on the site. */
export const PORTFOLIO = REGISTRY.filter((p) => p.visibility === 'portfolio').sort((a, b) => a.priority - b.priority)
export const FROZEN = REGISTRY.filter((p) => p.visibility === 'frozen')
/** @deprecated the in-development tiles: use FROZEN */
export const LABS = FROZEN
/** Everything with an identity (featured first, then the frozen ones). */
export const PRODUCTS = [...PORTFOLIO, ...FROZEN]

export const LIVE_COUNT = PORTFOLIO.filter((p) => p.status === 'live').length

export const productBySlug = (slug) => PRODUCTS.find((p) => p.slug === slug || p.aliases.includes(slug))

/** Where a product link leads: its product page (frozen products have one too, saying they're in development). */
export const productHref = (p) => `/products/${p.slug}`

/** Fills {products} (portfolio size), {labs} and {live} placeholders in site copy from the registry. */
export const fillCounts = (text) =>
  text
    .replaceAll('{products}', String(PORTFOLIO.length))
    .replaceAll('{labs}', String(FROZEN.length))
    .replaceAll('{live}', String(LIVE_COUNT))
