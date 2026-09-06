import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_URL, PRODUCTION_CSP, isTrustedRendererUrl, rendererSecurityPreferences, resolveRendererAsset, validateDevUrl } from '../src/main/security'

describe('Electron trust boundary', () => {
  const root = resolve('out/renderer')
  it('keeps the BrowserWindow security configuration locked down', () => {
    expect(rendererSecurityPreferences).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false })
    expect(Object.isFrozen(rendererSecurityPreferences)).toBe(true)
  })
  it('serves only the renderer entry and compiled asset paths', () => {
    expect(resolveRendererAsset(APP_URL, root)).toBe(resolve(root, 'index.html'))
    expect(resolveRendererAsset('taskcontinuum://app/assets/main-123.js', root)).toBe(resolve(root, 'assets/main-123.js'))
    expect(resolveRendererAsset('taskcontinuum://app/assets/codicon.ttf', root)).toBe(resolve(root, 'assets/codicon.ttf'))
  })
  it.each([
    'file:///etc/passwd', 'https://app/index.html', 'taskcontinuum://evil/index.html',
    'taskcontinuum://user@app/index.html', 'taskcontinuum://app/package.json',
    'taskcontinuum://app/assets/%2e%2e/%2e%2e/private.js', 'taskcontinuum://app/assets/..%5cprivate.js',
    'taskcontinuum://app/assets/%00.js', 'taskcontinuum://app/assets/%zz.js',
  ])('rejects an untrusted resource: %s', (url) => expect(resolveRendererAsset(url, root)).toBeUndefined())
  it('validates the exact IPC document rather than any custom-scheme URL', () => {
    expect(isTrustedRendererUrl(APP_URL)).toBe(true)
    expect(isTrustedRendererUrl(`${APP_URL}?unsafe=1`)).toBe(false)
    expect(isTrustedRendererUrl('taskcontinuum://app/assets/main.js')).toBe(false)
    expect(isTrustedRendererUrl('not-a-url')).toBe(false)
  })
  it('allows only a loopback development server and its exact origin', () => {
    const dev = validateDevUrl('http://127.0.0.1:5177/')
    expect(isTrustedRendererUrl(dev!, dev)).toBe(true)
    expect(isTrustedRendererUrl('http://127.0.0.1:5178/', dev)).toBe(false)
    expect(() => validateDevUrl('https://example.com/')).toThrow()
    expect(() => validateDevUrl('http://127.0.0.1.attacker.test/')).toThrow()
    expect(validateDevUrl(undefined)).toBeUndefined()
  })
  it('blocks network calls, frames, and inline scripts in production', () => {
    expect(PRODUCTION_CSP).toContain("connect-src 'none'")
    expect(PRODUCTION_CSP).toContain("frame-src 'none'")
    expect(PRODUCTION_CSP.split('; ').find((part) => part.startsWith('script-src'))).toBe("script-src 'self'")
  })
})