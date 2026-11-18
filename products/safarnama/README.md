# Safarnaama

> The product is **Safarnaama** (address `/safarnaama`). Code identifiers keep the earlier spelling `safarnama`
> (this folder, the Python package, `@safarnama/web`) so imports and history stay stable.

*Safarnaama* is Urdu and Hindi for a travelogue. The product covers the whole journey: plan a trip in four taps, see
real places, weather and routes, book through the providers, and keep bookings, budget and documents with the trip.

| | |
| --- | --- |
| **Status** | In development. It runs inside the portfolio today (`/safarnaama`) and is being moved to its own deployment. |
| **API** | [`api/`](api): FastAPI, Python package `safarnama` |
| **Web** | [`web/`](web): React 19 + Vite, package `@safarnama/web` |
| **Builds on** | [`packages/py-core`](../../packages/py-core) (`appcore`) and [`packages/web-core`](../../packages/web-core) (`@appcore/web`) |

## What it does

- **Quick planner:** where → when → who → plan. Destinations are suggested by season (with credited Wikimedia
  Commons photos), dates are one-tap choices, interests come pre-selected. The AI planner then builds a day-by-day
  itinerary from real map data, with weather, routes, meal stops and wellbeing checks.
- **Itinerary:** edit, move, pin, optimise a day, re-plan selected days, add stops and destinations, check the
  forecast, vote with a shared link.
- **Explore:** food, sights, experiences, shopping and services from OpenStreetMap near a destination, a stop or you.
- **Book:** pre-filled searches on Google Hotels / Flights / Maps, Airbnb, Booking.com, MakeMyTrip, GetYourGuide, IRCTC
  and redBus, then one tap to save the confirmation with the trip. Safarnaama never books or pays for anything.
- **Budget, documents, companion and summary:** expenses in the local currency, a booking's cost follows its status,
  documents and checklists, an AI companion that uses the trip's real data, and ideas for the next trip.

Free providers only (no keys): Open-Meteo, Photon / Nominatim / Overpass (OpenStreetMap), OSRM, Frankfurter. The model
calls go through `appcore`'s central Groq router (tasks `tripweaver.*`, registered in
[`api/src/safarnama/tasks.py`](api/src/safarnama/tasks.py); the prefix keeps Safarnaama's former name so quota history
stays continuous).

## Layout

```
products/safarnama/
├── api/
│   ├── src/safarnama/
│   │   ├── api.py         # HTTP routes (/api/trips) and access control (owner token, share links)
│   │   ├── service.py     # planner, re-planner, map / weather / route providers (Tools)
│   │   ├── ecosystem.py   # trips, places, bookings, expenses, documents, companion, summary
│   │   ├── logic.py       # pure rules: labels, schedules, budget, currency, titles (unit-tested)
│   │   ├── travel.py      # routes, rush hour, pacing and wellbeing checks
│   │   ├── tasks.py       # LLM tasks registered with the shared router
│   │   ├── settings.py    # SafarnamaSettings (appcore's CoreSettings + Safarnaama's own)
│   │   └── main.py        # standalone app: create_app()
│   └── tests/             # API journeys and rules with a scripted model and fake providers (no network)
└── web/
    ├── src/
    │   ├── App.jsx        # SafarnamaApp({ basePath }): '' on its own site, '/safarnaama' inside the portfolio
    │   ├── QuickPlan.jsx, choices.js, Visuals.jsx, photos.js   # the four-tap planner and destination imagery
    │   ├── BookPanel.jsx, booking.js                           # booking hand-offs
    │   ├── api.js, config.js, base.js                          # API client, API address, mount path
    │   └── styles/        # Safarnaama's theme (saffron accent, travelogue serif, contour backdrop)
    └── *.test.js next to the code they test
```

## Run it locally

API (from `products/safarnama/api`, Python 3.12):

```bash
python -m venv .venv && .venv/Scripts/activate        # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt                   # installs packages/py-core and this package in place
cp .env.example .env                                  # add GROQ_API_KEY for planning (free: console.groq.com)
uvicorn safarnama.main:create_app --factory --reload --port 8100
pytest && ruff check . && ruff format --check .
```

Web (from `products/safarnama/web`, Node 22.12+):

```bash
npm install
echo VITE_SAFARNAMA_API_URL=http://127.0.0.1:8100 > .env.local   # omit to use the deployed API
npm run dev        # http://localhost:5175
npm run lint && npm test && npm run build
```

## Data

Trips are stored in the `tripweaver` store: a Postgres schema of that name when `DATABASE_URL` is set (Neon in
production), otherwise `data/tripweaver.sqlite3`. The schema and tables are created automatically on first start.
Identity is a per-browser owner token (stored hashed); accounts (Google and email sign-in) are next.
