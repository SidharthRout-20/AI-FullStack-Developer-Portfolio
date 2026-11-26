// Every server request goes to the deployed backend (in dev too). The backend allows http://localhost:5173 and
// every Vercel domain of the frontend project (e.g. ai-full-stack-developer-portfolio-p-ruby.vercel.app) via CORS.
// VITE_API_BASE_URL can point the app at another backend (e.g. http://127.0.0.1:8000 for local work).
const DEPLOYED_API = 'https://ai-full-stack-developer-portfolio-b.vercel.app'

// `npm run dev:local` talks to a backend running on this machine, so unmerged backend changes can be tried.
const LOCAL_API = 'http://127.0.0.1:8000'

export const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.MODE === 'localapi' ? LOCAL_API : DEPLOYED_API)).replace(/\/$/, '')

/** Absolute URL for a backend path; for places that show a full URL (e.g. webhook links). */
export const apiUrl = (path) => `${API_BASE}${path}`
