/** The portfolio's HTTP client: @appcore/web's helpers bound to the portfolio backend (lib/apiBase). */
import { createClient } from '@appcore/web/http'
import { API_BASE } from '../../lib/apiBase'

export { ApiError, download, errorText, sessionError } from '@appcore/web/http'
export const { http, get, post, put, patch, del, streamPost } = createClient(API_BASE)
