/**
 * Where Safarnama is mounted: '' when it runs as its own site, '/safarnama' inside the portfolio. The App sets it
 * once from its `basePath` prop; every internal link goes through `appPath`.
 */
let base = ''

export function setBase(next) {
  base = String(next ?? '').replace(/\/+$/, '')
}

export const getBase = () => base

/** A path inside Safarnama: appPath('/abc') → '/safarnama/abc' (embedded) or '/abc' (own site); appPath() → home. */
export const appPath = (rest = '') => `${base}${rest}` || '/'
