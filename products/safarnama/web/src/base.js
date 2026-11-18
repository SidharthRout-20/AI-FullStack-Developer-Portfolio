/**
 * Where Safarnaama is mounted: '' when it runs as its own site, '/safarnaama' inside the portfolio. The App sets it
 * once from its `basePath` prop; every internal link goes through `appPath`.
 */
let base = ''

export function setBase(next) {
  base = String(next ?? '').replace(/\/+$/, '')
}

export const getBase = () => base

/** A path inside Safarnaama: appPath('/abc') → '/safarnaama/abc' (embedded) or '/abc' (own site); appPath() → home. */
export const appPath = (rest = '') => `${base}${rest}` || '/'
