import { isAbsolute, relative, resolve, sep } from 'node:path'

export const APP_URL = 'taskcontinuum://app/index.html'
export const rendererSecurityPreferences = Object.freeze({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  allowRunningInsecureContent: false,
})
export const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join('; ')

export function validateDevUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('The development renderer must use the loopback HTTP server.')
  }
  return url.href
}

export function isTrustedRendererUrl(value: string, devUrl?: string): boolean {
  try {
    const actual = new URL(value)
    const expected = new URL(devUrl ?? APP_URL)
    return actual.protocol === expected.protocol && actual.host === expected.host
      && actual.pathname === expected.pathname && !actual.username && !actual.password
      && !actual.search && !actual.hash
  } catch {
    return false
  }
}

export function resolveRendererAsset(value: string, root: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'taskcontinuum:' || url.host !== 'app' || url.username || url.password) return undefined
    const path = decodeURIComponent(url.pathname)
    if (path.includes('\\') || path.includes('\0')) return undefined
    if (path !== '/index.html' && !/^\/assets\/[a-zA-Z0-9_./-]+\.(js|css|ttf|woff2?|svg|png)$/.test(path)) return undefined
    const file = resolve(root, `.${path}`)
    const local = relative(root, file)
    if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return undefined
    return file
  } catch {
    return undefined
  }
}