/** The portfolio's HTTP client: @appcore/web's helpers bound to the portfolio backend (lib/apiBase). */
import { createClient } from '@appcore/web/http'
import { identityHeaders } from '@appcore/web/identity'
import { API_BASE } from '../../lib/apiBase'

export { ApiError, download, errorText, sessionError } from '@appcore/web/http'
// Every call says who is calling (this browser, or the signed-in account), so each person's data stays theirs.
export const { http, get, post, put, patch, del, streamPost } = createClient(API_BASE, { headers: identityHeaders })
