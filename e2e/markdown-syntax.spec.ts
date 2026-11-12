import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import type { ViteDevServer } from 'vite'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

let server: ViteDevServer
let url: string
test.beforeAll(async () => {
  server = await createServer({ configFile: false, root: resolve('.'), plugins: [react()], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('No loopback fixture port.')
  url = `http://127.0.0.1:${address.port}/e2e/fixtures/syntax.html`
})
test.afterAll(async () => { await server?.close() })

for (const scenario of [
  { name: 'wide-light', width: 1280, height: 960, theme: 'light' },
  { name: 'narrow-light', width: 360, height: 780, theme: 'light' },
  { name: 'wide-dark', width: 1280, height: 960, theme: 'dark' },
]) {
  test(`highlights code offline with readable tokens and intact copying in ${scenario.name}`, async ({ page }, testInfo) => {
    const errors: string[] = []
    const remoteRequests: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin !== new URL(url).origin) {
        remoteRequests.push(route.request().url())
        await route.abort()
      } else await route.continue()
    })
    await page.setViewportSize({ width: scenario.width, height: scenario.height })
    await page.goto(`${url}?theme=${scenario.theme}`)

    for (const name of ['Chat code', 'Task document code']) {
      const section = page.getByRole('region', { name, exact: true })
      await expect(section.locator('pre code.hljs')).toHaveCount(4)
      await expect(section.locator('.language-js .hljs-keyword').first()).toHaveText('const')
      await expect(section.locator('pre code.language-not-a-real-language')).not.toHaveClass(/hljs/)
      await expect(section.locator('.katex')).toHaveCount(1)
      await expect(section.getByRole('link', { name: 'Docs', exact: true })).toBeVisible()
      const tokenContrast = await section.locator('pre code.hljs').evaluateAll((blocks) => {
        const rgb = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number)
        const luminance = (color: number[]) => color.map((value) => {
          const s = value / 255
          return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4
        }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
        return blocks.flatMap((code) => {
          const background = luminance(rgb(getComputedStyle(code.closest('pre')!).backgroundColor))
          return Array.from(code.querySelectorAll('span')).map((span) => {
            const color = luminance(rgb(getComputedStyle(span).color))
            return (Math.max(color, background) + .05) / (Math.min(color, background) + .05)
          })
        })
      })
      expect(tokenContrast.length).toBeGreaterThan(0)
      for (const contrast of tokenContrast) expect(contrast).toBeGreaterThanOrEqual(4.5)

      const longCode = section.locator('pre').last()
      if (scenario.width < 500) {
        expect(await longCode.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
      }

    }

    const chat = page.getByRole('region', { name: 'Chat code', exact: true })
    const code = chat.locator('pre code.language-js').first()
    const source = await code.textContent()
    await page.evaluate(() => {
      window.desktop = { ...window.desktop!, copyText: async (text: string) => {
        document.documentElement.dataset.copiedCode = text
      } }
    })
    await chat.getByRole('button', { name: 'Copy code', exact: true }).first().click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.copiedCode)).toBe(source)
    await expect(chat.getByRole('button', { name: 'Code copied' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`syntax-${scenario.name}.png`), fullPage: true })

    const token = code.locator('.hljs-keyword').first()
    const beforeTheme = await token.evaluate((element) => getComputedStyle(element).color)
    await page.getByRole('button', { name: 'Toggle theme' }).click()
    await expect.poll(() => token.evaluate((element) => getComputedStyle(element).color)).not.toBe(beforeTheme)
    await expect(code).toHaveText(source!)
    await page.getByRole('button', { name: 'Start streaming' }).click()
    await expect(chat.locator('pre code.hljs')).toHaveCount(1)
    await expect(chat.locator('pre code')).toHaveText('const partial = "still streaming\n')
    await page.getByRole('button', { name: 'Finish streaming' }).click()
    await expect(chat.locator('pre code.hljs')).toHaveCount(4)
    expect(errors).toEqual([])
    expect(remoteRequests).toEqual([])
  })
}

test('highlights code and copies its exact source through the actual Electron preload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuum-syntax-desktop-'))
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.TASKCONTINUUM_WORKSPACE
  Object.assign(environment, {
    ELECTRON_RENDERER_URL: url,
    TASKCONTINUUM_DATA_DIR: join(root, 'profile'),
    TASKCONTINUUM_AGENT_HOST_DISCOVERY: join(root, 'no-hosts'),
    TASKCONTINUUM_VSCODE_USER_DATA_DIR: join(root, 'no-sessions'),
  })
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const chat = page.getByRole('region', { name: 'Chat code', exact: true })
    const code = chat.locator('pre code.language-js').first()
    await expect(code).toHaveClass('language-js hljs')
    await expect(code.locator('.hljs-keyword')).toHaveText('const')
    const source = await code.textContent()
    await chat.getByRole('button', { name: 'Copy code', exact: true }).first().click()
    await expect(chat.getByRole('button', { name: 'Code copied' })).toBeVisible()
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(source)
    const beforeTheme = await code.locator('.hljs-keyword').evaluate((element) => getComputedStyle(element).color)
    await page.getByRole('button', { name: 'Toggle theme' }).click()
    await expect.poll(() => code.locator('.hljs-keyword').evaluate((element) => getComputedStyle(element).color)).not.toBe(beforeTheme)
    await expect(code).toHaveText(source!)
    expect(errors).toEqual([])
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})
