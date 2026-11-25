# Sidharth Rout: products built in this portfolio

These are the AI products Sidharth Rout designed and built end to end (React 19 frontends, Python FastAPI backends, a shared core library, deployed on Vercel with Postgres on Neon). Each one is live on his portfolio site.

## Safarnaama: AI trip planner (structured LLM planning grounded in real data)
- Plans a day-by-day trip from a short request: real places geocoded on a map (OpenStreetMap), weather from Open-Meteo, routes and travel times, budgets and expenses, documents and checklists, and booking hand-offs to providers.
- The planner is an LLM pipeline with structured JSON output: it validates every plan with Pydantic schemas, salvages truncated model output, asks the model only for missing days, and rejects invented places, arrival times or repeated stops.
- Includes a travel companion chat that uses the itinerary, local time, forecast and nearby places, and optional Google or email-link sign-in through Neon Auth with Ed25519 token verification.

## CodeLens: onboarding onto any codebase (code RAG with citations)
- Indexes a public GitHub repository: Python files are chunked with the `ast` module by function and class, other languages by symbol boundaries; chunks are embedded locally with FastEmbed and searched with hybrid retrieval (dense vectors plus BM25, fused with Reciprocal Rank Fusion).
- Builds an onboarding pack for new joiners: what the project does, its architecture, code areas, an ordered reading path and a five-day plan, with every file path checked against the repository so nothing is invented.
- Answers questions about the code with file-and-line citations, replacing knowledge-transfer sessions.

## Tara (formerly Tijori; name changed so "Hey Tara" is easy to say): voice-first personal assistant (LangGraph agent with tools)
- A LangGraph agent (understand → act → respond) routes each request: saving and finding personal things, reminders and bills, or tools.
- Tools: live weather (Open-Meteo), news headlines (Google News), facts (DuckDuckGo Instant Answers), exchange rates (Frankfurter), world time, and device actions (open apps, play music, directions, timers, calendar events, and calls, messages or emails prepared for the user to confirm).
- Voice in and out: browser speech recognition with a Whisper fallback on the server, spoken replies with a choice of voice, a "Hey Tara" wake phrase, and replies that adapt to the user's mood.

## Jasoos: build-failure detective (evidence-grounded LLM analysis)
- Takes CI logs, stack traces, diffs and JUnit reports; redacts secrets; extracts errors, failed tests and changed lines by plain parsing into numbered evidence.
- The LLM proposes root-cause hypotheses that must cite evidence IDs; unsupported claims are removed or downgraded.

## Shared platform
- A central Groq LLM router picks a model per task (complexity, structured output, quotas), retries and falls back between models, and keeps free-tier quotas for the most important products.
- Quality is measured on a public Quality page: evaluation suites per product (routing accuracy, retrieval hit rate, parsing robustness) and application metrics.
