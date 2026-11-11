// Every server request goes to the deployed backend (in dev too), so the backend's CORS_ORIGINS must list
// each origin the frontend runs on (e.g. http://localhost:5173 and the deployed frontend URL).
// VITE_API_BASE_URL can point the app at another backend (e.g. http://127.0.0.1:8000 for local work).
const DEPLOYED_API = 'https://ai-full-stack-developer-portfolio-j.vercel.app'

export const API_BASE = (import.meta.env.VITE_API_BASE_URL || DEPLOYED_API).replace(/\/$/, '')

/** Absolute URL for a backend path; for places that show a full URL (e.g. webhook links). */
export const apiUrl = (path: string) => `${API_BASE}${path}`
