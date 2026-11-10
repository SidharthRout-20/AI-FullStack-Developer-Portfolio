import {
  AudioLines,
  BriefcaseBusiness,
  Code2,
  Dna,
  FileSearch,
  HandHelping,
  Route,
  Workflow,
  type LucideIcon,
} from 'lucide-react'

export type ProductStatus = 'live' | 'building'

export interface Product {
  slug: string
  name: string
  tagline: string
  description: string
  status: ProductStatus
  category: string
  icon: LucideIcon
  /** Tailwind gradient stops for the product's accent, e.g. 'from-indigo-500 to-cyan-400'. */
  accent: string
  tags: string[]
  features: { title: string; text: string }[]
  stack: string[]
  /** Route of the running app (live products only). */
  route?: string
}

/** Single source of truth for the product library. Add a product = add an entry. */
export const PRODUCTS: Product[] = [
  {
    slug: 'documind',
    name: 'DocuMind',
    tagline: 'Agentic RAG over your documents, with every step visible.',
    description:
      'Ask questions about a document knowledge base and get cited answers, watch the LangGraph pipeline run live, ' +
      'inspect why each passage was retrieved, generate document briefs, and score requirement lists against your documents.',
    status: 'live',
    category: 'Knowledge & Search',
    icon: FileSearch,
    accent: 'from-indigo-500 via-violet-500 to-cyan-400',
    tags: ['RAG', 'LangGraph', 'Hybrid search', 'SSE streaming'],
    route: '/documind',
    features: [
      { title: 'Grounded chat', text: 'Hybrid vector + BM25 retrieval, inline citations, 4-turn memory, history.' },
      { title: 'Pipeline Studio', text: 'Live animated workflow graph, run replay and a retrieval explainer.' },
      { title: 'Library', text: 'AI document briefs: summary, highlights, topics, suggested questions.' },
      { title: 'Match Analyzer', text: 'Score a JD / RFP against documents with cited, per-requirement verdicts.' },
    ],
    stack: ['React 19', 'TypeScript', 'Tailwind v4', 'React Flow', 'FastAPI', 'LangGraph', 'ChromaDB', 'Groq / Claude'],
  },
  {
    slug: 'keeper',
    name: 'Keeper',
    tagline: 'A personal assistant that remembers the small stuff for you.',
    description:
      'Tell it, or show it, anything you need to remember: where you put something, who borrowed what, when a ' +
      'warranty runs out, what you need from the shop. An agent files it automatically, then answers questions ' +
      'and sends reminders on your phone, chat app or earbuds.',
    status: 'live',
    route: '/keeper',
    category: 'Personal Assistant',
    icon: HandHelping,
    accent: 'from-fuchsia-500 via-pink-500 to-orange-400',
    tags: ['Multi-agent routing', 'Vision', 'Voice', 'Proactive reminders'],
    features: [
      { title: 'Stash', text: '"Passport, top drawer": a photo or voice note saves where things are; ask for them later.' },
      { title: 'Lend & borrow', text: 'Tracks what you lent or borrowed, and nudges you to get it back.' },
      { title: 'Expiry radar', text: 'Snap a warranty, policy or ID; it reads the dates and reminds you before they run out.' },
      { title: 'Home & pantry', text: 'Appliance service schedules, groceries running low, and a shared shopping list.' },
      { title: 'Daily brief', text: 'A morning summary of what is due today, spoken or sent to your chat app.' },
    ],
    stack: ['React 19 PWA', 'Web Speech', 'FastAPI', 'LangGraph', 'Vision LLM', 'Notifications', 'SQLite', 'Telegram'],
  },
  {
    slug: 'careerpilot',
    name: 'CareerPilot',
    tagline: 'Your job hunt, with a copilot.',
    description:
      'Paste a job description to get a tailored resume and cover letter, a cited match score with gaps, and a ' +
      'voice mock interview that asks follow-up questions to weak answers and tracks your progress.',
    status: 'live',
    route: '/careerpilot',
    category: 'Career',
    icon: BriefcaseBusiness,
    accent: 'from-sky-500 via-blue-500 to-indigo-500',
    tags: ['Match engine', 'Structured outputs', 'Voice agent'],
    features: [
      { title: 'Match & gaps', text: 'DocuMind\'s Match engine scores your resume against the role, with citations.' },
      { title: 'Tailored documents', text: 'Resume bullets and cover letter rewritten for each role, exportable as Markdown.' },
      { title: 'Mock interview', text: 'Speak your answers; it asks follow-ups to weak answers and scores each one.' },
      { title: 'Application tracker', text: 'A pipeline board from "applied" to "offer", with reminders.' },
    ],
    stack: ['React 19', 'FastAPI', 'Match engine', 'Web Speech', 'Speech synthesis', 'SQLite'],
  },
  {
    slug: 'flowforge',
    name: 'FlowForge',
    tagline: 'Build your own AI automations by dragging steps onto a canvas.',
    description:
      'Drag AI, HTTP, condition and Keeper steps onto a canvas, validate the flow, watch every run animate live, and ' +
      'deploy it as a webhook API endpoint or a scheduled job.',
    status: 'live',
    route: '/flowforge',
    category: 'Automation',
    icon: Workflow,
    accent: 'from-violet-500 via-purple-500 to-fuchsia-500',
    tags: ['Visual builder', 'Agent runtime', 'Event triggers'],
    features: [
      { title: 'Canvas builder', text: 'React Flow editor with typed inputs and outputs, and checks before you save.' },
      { title: 'Triggers', text: 'Run manually, call it as a webhook, or put it on a schedule.' },
      { title: 'Live traces', text: 'Each run animates on the canvas, as in DocuMind\'s Pipeline Studio.' },
      { title: 'One-click deploy', text: 'Every saved flow gets its own secret webhook URL.' },
    ],
    stack: ['React 19', 'React Flow', 'FastAPI', 'DAG runtime', 'SSE', 'SQLite'],
  },
  {
    slug: 'tripweaver',
    name: 'TripWeaver',
    tagline: 'A trip planner that re-plans while you travel.',
    description:
      'Describe a trip; an agent builds a day-by-day plan on a map using weather, places and transport tools, ' +
      're-plans when a flight is delayed or it rains, and lets your group vote on changes from their phones.',
    status: 'live',
    route: '/tripweaver',
    category: 'Travel',
    icon: Route,
    accent: 'from-lime-500 via-emerald-500 to-teal-500',
    tags: ['Tool-calling agent', 'Maps', 'Real-time sync'],
    features: [
      { title: 'Agentic planning', text: 'Weather, places and routing tools combined into an itinerary.' },
      { title: 'Live re-planning', text: 'Delays and weather changes trigger a revised plan you can review.' },
      { title: 'Group mode', text: 'Share a link; travel companions vote on activities in real time.' },
      { title: 'Offline copy', text: 'The last-viewed itinerary stays readable without a connection.' },
    ],
    stack: ['React 19', 'Leaflet + OSM', 'FastAPI', 'Open-Meteo', 'Nominatim', 'SSE'],
  },
  {
    slug: 'meetingmind',
    name: 'MeetingMind',
    tagline: 'Meetings in, decisions and action items out.',
    description:
      'Record in the browser, upload audio or paste a transcript: Whisper transcribes it with timestamps, an LLM extracts ' +
      'decisions, owners and deadlines, and a Kanban board tracks the action items across a searchable meeting archive.',
    status: 'live',
    route: '/meetingmind',
    category: 'Productivity',
    icon: AudioLines,
    accent: 'from-emerald-500 via-teal-400 to-cyan-400',
    tags: ['Speech-to-text', 'Structured extraction', 'Task tracking'],
    features: [
      { title: 'Transcription', text: 'Record or upload; Groq-hosted Whisper returns timestamped segments.' },
      { title: 'Decision log', text: 'Decisions, risks and owners extracted as validated JSON.' },
      { title: 'Action board', text: 'Drag-and-drop Kanban synced to extracted action items.' },
      { title: 'Ask the archive', text: 'RAG over every past meeting, with timestamped citations.' },
    ],
    stack: ['React 19', 'MediaRecorder', 'FastAPI', 'Whisper (Groq)', 'FastEmbed', 'SQLite'],
  },
  {
    slug: 'evolve',
    name: 'Evolve',
    tagline: 'Prompts that learn from their own mistakes.',
    description:
      'Define a goal, a system prompt and validators. Every output is checked and judged; failures become lessons; ' +
      'the model rewrites its own prompt from them and the new version is promoted only after it beats the old one ' +
      'on a regression set. The system gets smarter the more it is used.',
    status: 'live',
    route: '/evolve',
    category: 'Self-improving AI',
    icon: Dna,
    accent: 'from-teal-500 via-emerald-500 to-lime-400',
    tags: ['Self-improvement', 'LLM-as-judge', 'Regression-gated'],
    features: [
      { title: 'Validate every run', text: 'Deterministic checks (must include / avoid, length, JSON keys) plus an LLM judge with your rubric.' },
      { title: 'Lessons', text: 'Failed runs and thumbs-down feedback are recorded with the reason they failed.' },
      { title: 'Reflection', text: 'The model proposes a revised prompt with a rationale and the general lessons learned.' },
      { title: 'Proof before promotion', text: 'Candidates are re-tested on recent inputs; versioned with scores, diffs and rollback.' },
    ],
    stack: ['React 19', 'FastAPI', 'LLM judge', 'Prompt versioning', 'SSE', 'SQLite'],
  },
  {
    slug: 'codelens',
    name: 'CodeLens',
    tagline: 'Understand any codebase in minutes.',
    description:
      'Point it at a GitHub repository: it parses and indexes the code, answers architecture questions with ' +
      'file-and-line citations, and renders interactive dependency graphs of modules and calls.',
    status: 'live',
    route: '/codelens',
    category: 'Developer Tools',
    icon: Code2,
    accent: 'from-amber-500 via-orange-500 to-rose-500',
    tags: ['Code RAG', 'AST parsing', 'Graph visualisation'],
    features: [
      { title: 'Repo indexing', text: 'Chunked by function / class (Python AST, symbol-aware for other languages).' },
      { title: 'Cited answers', text: 'Answers link to exact files and line ranges.' },
      { title: 'Dependency graph', text: 'Interactive module / call graph in React Flow.' },
      { title: 'Guided tour', text: 'An ordered reading path through the codebase for new engineers.' },
    ],
    stack: ['React 19', 'React Flow', 'FastAPI', 'Python ast', 'FastEmbed', 'BM25 + RRF'],
  },
]

export const productBySlug = (slug: string) => PRODUCTS.find((p) => p.slug === slug)
