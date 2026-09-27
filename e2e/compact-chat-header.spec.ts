import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import type { ViteDevServer } from 'vite'
import { expect, test } from '@playwright/test'

let server: ViteDevServer
let url: string

test.beforeAll(async () => {
  server = await createServer({
    configFile: false, root: resolve('.'), plugins: [react()],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('The layout fixture did not open a local port.')
  url = `http://127.0.0.1:${address.port}/e2e/fixtures/compact-chat.html`
})
test.afterAll(async () => { await server?.close() })

for (const scenario of [
  { name: 'wide-light', width: 1440, height: 900, theme: 'light', long: false, zoom: 1 },
  { name: 'narrow-light', width: 360, height: 740, theme: 'light', long: true, zoom: 1 },
  { name: 'short-narrow', width: 320, height: 600, theme: 'light', long: true, zoom: 1 },
  { name: 'compact-dark', width: 768, height: 640, theme: 'dark', long: true, zoom: 1 },
  { name: 'zoomed-light', width: 1586, height: 1100, theme: 'light', long: true, zoom: 2 },
]) {
  test(`maximizes conversation space in ${scenario.name}`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: scenario.width, height: scenario.height })
    await page.goto(`${url}?theme=${scenario.theme}${scenario.long ? '&long' : ''}`)
    await page.evaluate((zoom) => {
      document.body.style.zoom = String(zoom)
      // CSS zoom leaves viewport units unchanged, unlike Electron's page zoom.
      document.querySelector<HTMLElement>('.workbench')!.style.height = `${innerHeight / zoom}px`
    }, scenario.zoom)
    const panel = page.getByRole('complementary', { name: 'Agent Host task chat' })
    await expect(panel.getByText('Connected', { exact: true })).toBeVisible()
    await panel.getByRole('combobox', { name: 'Agent Host model' }).selectOption('gpt-6')
    const geometry = await panel.evaluate((element) => {
      const log = element.querySelector<HTMLElement>('.chat-log')!
      return {
        headerHeight: log.getBoundingClientRect().top - element.getBoundingClientRect().top,
        chatHeight: log.clientHeight,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      }
    })
    console.log(JSON.stringify({ scenario: scenario.name, ...geometry }))
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}.png`) })
    expect(geometry.headerHeight).toBe((scenario.width / scenario.zoom >= 640 ? 32 : 48) * scenario.zoom)
    expect(geometry.chatHeight).toBeGreaterThanOrEqual(scenario.height / scenario.zoom * 0.65)
    expect(geometry.horizontalOverflow).toBe(false)
    await expect(panel.getByRole('textbox', { name: 'Message Agent Host' })).toBeInViewport()
    await expect(panel.getByRole('button', { name: 'Send to Agent Host' })).toBeInViewport()
    for (const name of ['Chat details', 'Manage devices', 'Reconnect Agent Host', 'Detach conversation', 'Hide chat panel']) {
      await expect(panel.getByRole('button', { name, exact: true })).toBeInViewport()
      const size = await panel.getByRole('button', { name, exact: true }).boundingBox()
      expect(size?.width).toBeGreaterThanOrEqual(24 * scenario.zoom)
      expect(size?.height).toBeGreaterThanOrEqual(24 * scenario.zoom)
    }

    const trigger = panel.getByRole('button', { name: 'Chat details', exact: true })
    await trigger.click()
    const details = page.getByRole('dialog', { name: 'Chat details', exact: true })
    await expect(details).toBeVisible()
    await expect(details.getByText('BUILD-WORKSTATION', { exact: true })).toBeVisible()
    await expect(details.getByText(`copilotcli:/${'s'.repeat(120)}`, { exact: true })).toBeVisible()
    await expect(details.getByText(`ahp-chat:/${'c'.repeat(120)}`, { exact: true })).toBeVisible()
    expect(await details.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-details.png`) })
    await page.keyboard.press('Escape')
    await expect(details).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(await panel.locator('.chat-log').evaluate((element) => element.clientHeight)).toBe(geometry.chatHeight)

    await page.evaluate(() => window.compactChatFixture.setState('offline', true))
    await expect(panel.getByText('Offline history', { exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    await page.evaluate(() => window.compactChatFixture.setState('connected', true))
    await expect(panel.getByText('Read only', { exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    if (scenario.name === 'wide-light') {
      await page.locator('.workbench').evaluate((element) => { element.style.width = '360px' })
      expect(await panel.getByLabel('Chat header').evaluate((element) => element.getBoundingClientRect().height)).toBe(48)
      for (const name of ['Chat details', 'Manage devices', 'Reconnect Agent Host', 'Detach conversation', 'Hide chat panel']) {
        await expect(panel.getByRole('button', { name, exact: true })).toBeInViewport()
      }
    }
    expect(errors).toEqual([])
  })
}
