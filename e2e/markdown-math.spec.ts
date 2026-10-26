import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import type { ViteDevServer } from 'vite'
import { expect, test } from '@playwright/test'
import { resolveRendererAsset } from '../src/main/security'

let server: ViteDevServer
let url: string
test.beforeAll(async () => {
  server = await createServer({ configFile: false, root: resolve('.'), plugins: [react()], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('No loopback fixture port.')
  url = `http://127.0.0.1:${address.port}/e2e/fixtures/math.html`
})
test.afterAll(async () => { await server?.close() })

for (const scenario of [
  { name: 'wide-light', width: 1280, height: 960, theme: 'light' },
  { name: 'narrow-light', width: 360, height: 780, theme: 'light' },
  { name: 'wide-dark', width: 1280, height: 960, theme: 'dark' },
]) {
  test(`renders BM25 and table formulas offline in ${scenario.name}`, async ({ page }, testInfo) => {
    const errors: string[] = []
    const remoteRequests: string[] = []
    const failedFonts: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('requestfailed', (request) => { if (request.resourceType() === 'font') failedFonts.push(request.url()) })
    await page.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin !== new URL(url).origin) {
        remoteRequests.push(route.request().url())
        await route.abort()
      } else await route.continue()
    })
    await page.setViewportSize({ width: scenario.width, height: scenario.height })
    await page.goto(`${url}?theme=${scenario.theme}`)
    for (const name of ['Chat formula', 'Task document formula']) {
      const section = page.getByRole('region', { name, exact: true })
      await expect(section.locator('.katex')).toHaveCount(9)
      await expect(section.getByRole('group', { name: 'Block formula' })).toHaveCount(1)
      await expect(section.locator('.katex-error')).toHaveCount(0)
      await expect(section.getByRole('row')).toHaveCount(9)
      const row = section.getByRole('row').nth(5)
      await expect(row.getByRole('cell')).toHaveCount(2)
      await expect(row.getByRole('cell').nth(1)).toHaveText('Document length')
      await expect(row.locator('annotation')).toHaveText('|D|')
      const formula = section.getByRole('group', { name: 'Block formula' })
      await formula.scrollIntoViewIfNeeded()
      const box = await formula.boundingBox()
      expect(box!.width).toBeLessThanOrEqual(scenario.width)
      if (scenario.width < 500) {
        expect(await formula.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
        await formula.focus()
        await page.keyboard.press('ArrowRight')
        await expect.poll(() => formula.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
      }
    }
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready
      return Array.from(document.fonts).filter((font) => font.family.startsWith('KaTeX') && font.status === 'loaded').length
    })
    expect(fonts).toBeGreaterThan(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('region', { name: 'Chat formula', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`math-${scenario.name}.png`), fullPage: true })
    await page.getByRole('button', { name: 'Start streaming' }).click()
    await expect(page.locator('.katex')).toHaveCount(0)
    await page.getByRole('button', { name: 'Finish streaming' }).click()
    await expect(page.locator('.katex')).toHaveCount(18)
    expect(errors).toEqual([])
    expect(remoteRequests).toEqual([])
    expect(failedFonts).toEqual([])
  })
}

test('packages math styles and fonts through the existing trusted asset route', async () => {
  const root = resolve('out', 'renderer')
  const files = await readdir(join(root, 'assets'))
  const fonts = files.filter((file) => /^KaTeX.*\.(woff2?|ttf)$/.test(file))
  expect(fonts.length).toBeGreaterThan(0)
  for (const font of fonts) {
    expect(resolveRendererAsset(`taskcontinuum://app/assets/${font}`, root)).toBe(join(root, 'assets', font))
  }
  const css = (await Promise.all(files.filter((file) => file.endsWith('.css')).map((file) => readFile(join(root, 'assets', file), 'utf8')))).join('\n')
  expect(css).toContain('KaTeX_Main')
  expect(css).not.toMatch(/url\(["']?https?:/)
})
