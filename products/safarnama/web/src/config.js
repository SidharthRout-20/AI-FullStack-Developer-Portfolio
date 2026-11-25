/**
 * Safarnaama's API address. Set VITE_SAFARNAMA_API_URL (e.g. http://127.0.0.1:8100 for a local API); otherwise the
 * deployed backend that serves /api/trips today (the portfolio backend, until Safarnaama's own API is deployed).
 * VITE_API_BASE_URL is honoured too, so the portfolio's local setup keeps working when Safarnaama runs inside it.
 */
const DEPLOYED_API = 'https://ai-full-stack-developer-portfolio-b.vercel.app'

export const API_BASE = (import.meta.env.VITE_SAFARNAMA_API_URL || import.meta.env.VITE_API_BASE_URL || DEPLOYED_API).replace(/\/$/, '')

/**
 * Neon Auth for sign-in (Google or an emailed link). Not a secret: the backend checks sign-ins against the public keys
 * this publishes. Set VITE_NEON_AUTH_URL to use another project; sign-in only shows once the API says it's on.
 */
const DEPLOYED_AUTH = 'https://ep-flat-unit-bb9fi63x.neonauth.c-15.us-east-1.aws.neon.tech/neondb/auth'

export const NEON_AUTH_URL = (import.meta.env.VITE_NEON_AUTH_URL || DEPLOYED_AUTH).replace(/\/$/, '')
