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

for (const theme of ['light', 'dark'] as const) {
  test(`uses soft neutral surfaces and readable rounded controls in ${theme} mode`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: 1560, height: 1000 })
    await page.goto(`${url}?workbench&panes&theme=${theme}`)
    await expect(page.getByLabel('Chat header').getByText('Connected', { exact: true })).toBeVisible()
    const panel = page.getByRole('complementary', { name: 'Agent Host task chat' })
    await panel.getByRole('combobox', { name: 'Agent Host model' }).selectOption('gpt-6')
    const appearance = await page.locator('.workbench').evaluate((element) => {
      const style = (selector: string) => {
        const found = element.querySelector(selector)
        if (!found) throw new Error(`Missing appearance test element: ${selector}`)
        return getComputedStyle(found)
      }
      const probe = document.createElement('span')
      element.append(probe)
      const color = (name: string) => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color }
      const colors = Object.fromEntries(['--text', '--muted', '--subtle', '--accent', '--button-text', '--button-bg'].map((name) => [name, color(name)]))
      probe.remove()
      const luminance = (value: string) => {
        const channels = value.match(/[\d.]+/g)?.slice(0, 3).map((part) => {
          const channel = Number(part) / 255
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        })
        if (!channels || channels.length !== 3) throw new Error(`Invalid rendered color: ${value}`)
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
      }
      const contrast = (foreground: string, background: string) => {
        const a = luminance(foreground), b = luminance(background)
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      }
      const background = getComputedStyle(element).backgroundColor
      const selected = style('.tree-row.is-selected').backgroundColor
      return {
        background, selected, sidebar: style('.sidebar').backgroundColor, chat: style('.chat-panel').backgroundColor,
        bubble: style('.message-user').backgroundColor, composer: style('.composer').backgroundColor,
        radii: {
          selected: style('.tree-row.is-selected').borderRadius, composer: style('.composer').borderRadius,
          bubble: style('.message-user').borderRadius, button: style('.icon-button').borderRadius,
        },
        textContrast: ['--text', '--muted', '--subtle'].flatMap((name) =>
          [background, selected].map((surface) => contrast(colors[name], surface))),
        buttonContrast: contrast(colors['--button-text'], colors['--button-bg']),
        focusContrast: contrast(colors['--accent'], background),
        overflow: document.documentElement.scrollWidth > innerWidth,
      }
    })
    expect(appearance.background).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(28, 28, 28)')
    expect(appearance.sidebar).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(32, 32, 32)')
    expect(appearance.chat).toBe(appearance.background)
    expect(appearance.selected).toBe(theme === 'light' ? 'rgb(235, 235, 235)' : 'rgb(52, 52, 52)')
    expect(appearance.bubble).toBe(theme === 'light' ? 'rgb(245, 245, 245)' : 'rgb(42, 42, 42)')
    expect(appearance.composer).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(36, 36, 36)')
    expect(appearance.radii).toEqual({ selected: '12px', composer: '24px', bubble: '16px', button: '8px' })
    for (const ratio of appearance.textContrast) expect(ratio).toBeGreaterThanOrEqual(4.5)
    expect(appearance.buttonContrast).toBeGreaterThanOrEqual(4.5)
    expect(appearance.focusContrast).toBeGreaterThanOrEqual(3)
    expect(appearance.overflow).toBe(false)
    await page.screenshot({ path: testInfo.outputPath(`neutral-${theme}.png`) })
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    const preferences = page.getByRole('dialog', { name: 'Preferences' })
    await expect(preferences).toHaveCSS('border-radius', '16px')
    await expect(preferences.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark', exact: true })).toBeChecked()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    const row = page.locator('.session-tree-row.is-selected')
    await expect(row).toHaveCSS('border-radius', '12px')
    await expect(row).toHaveCSS('background-color', appearance.selected)
    await page.screenshot({ path: testInfo.outputPath(`neutral-${theme}-sessions.png`) })
    expect(errors).toEqual([])
  })
}

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

for (const scenario of [
  { name: 'wide', width: 1440, height: 900, zoom: 1, theme: 'light' },
  { name: 'narrow', width: 360, height: 740, zoom: 1, theme: 'light' },
  { name: 'dark', width: 768, height: 700, zoom: 1, theme: 'dark' },
  { name: 'zoomed', width: 1586, height: 1100, zoom: 2, theme: 'light' },
]) {
  test(`keeps workbench chrome compact and usable in ${scenario.name}`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: scenario.width, height: scenario.height })
    await page.goto(`${url}?workbench&theme=${scenario.theme}`)
    const tabs = page.getByRole('tablist', { name: 'Open tasks' })
    const first = tabs.getByRole('tab', { name: 'Fix Connection issues', exact: true })
    await expect(first).toBeVisible()
    const titlebar = page.locator('.titlebar')
    const header = titlebar.getByLabel('Chat header', { exact: true })
    await expect(header.getByText('Connected', { exact: true })).toBeVisible()
    await page.evaluate((zoom) => {
      document.body.style.zoom = String(zoom)
      document.querySelector<HTMLElement>('.workbench')!.style.height = `${innerHeight / zoom}px`
    }, scenario.zoom)
    const search = page.locator('.command-center')
    const geometry = await page.evaluate(() => ({
      titlebar: document.querySelector('.titlebar')!.getBoundingClientRect().height,
      search: document.querySelector('.command-center')!.getBoundingClientRect().height,
      searchWidth: document.querySelector('.command-center')!.getBoundingClientRect().width,
      tabs: document.querySelector('.editor-tabs')!.getBoundingClientRect().height,
      chatHeader: document.querySelector('.titlebar .ahp-chat-header')!.getBoundingClientRect().height,
      extraChatRow: document.querySelector('.ahp-panel .chat-log')!.getBoundingClientRect().top - document.querySelector('.editor-tabs')!.getBoundingClientRect().bottom,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }))
    console.log(JSON.stringify({ scenario: `workbench-${scenario.name}`, ...geometry }))
    await page.screenshot({ path: testInfo.outputPath(`workbench-${scenario.name}.png`) })
    expect(geometry.titlebar).toBe(32 * scenario.zoom)
    expect(geometry.search).toBe(24 * scenario.zoom)
    expect(geometry.searchWidth).toBeLessThanOrEqual(420 * scenario.zoom)
    expect(geometry.tabs).toBe(28 * scenario.zoom)
    expect(geometry.chatHeader).toBeLessThanOrEqual(32 * scenario.zoom)
    expect(geometry.extraChatRow).toBe(0)
    expect(geometry.overflow).toBe(false)
    await expect(header).toHaveCount(1)
    await expect(page.locator('.ahp-panel .ahp-chat-header')).toHaveCount(0)
    await expect(search).toBeInViewport()
    await expect(header.getByRole('button', { name: 'Chat details' })).toBeInViewport()
    for (const name of ['Minimize window', 'Maximize or restore window', 'Close window']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeInViewport()
    }

    const composer = page.getByRole('textbox', { name: 'Message Agent Host' })
    await composer.fill('Preserve this draft while switching tasks')
    await header.getByRole('button', { name: 'Chat details' }).click()
    const details = page.getByRole('dialog', { name: 'Chat details', exact: true })
    await expect(details.getByText('BUILD-WORKSTATION', { exact: true })).toBeVisible()
    for (const name of ['Manage devices', 'Reconnect Agent Host', 'Detach conversation', 'Hide chat panel']) {
      await expect(details.getByRole('button', { name, exact: true })).toBeVisible()
    }
    await details.getByRole('button', { name: 'Reconnect Agent Host', exact: true }).click()
    await expect(details).toHaveCount(0)
    await expect(header.getByText('Connected', { exact: true })).toBeVisible()
    await expect(composer).toHaveValue('Preserve this draft while switching tasks')
    await search.click()
    const quickOpen = page.getByRole('dialog', { name: 'Quick open' })
    await quickOpen.getByRole('textbox', { name: 'Find a task' }).fill('Sept-2026')
    await quickOpen.getByRole('button', { name: /Sept-2026 planning/ }).click()
    const second = tabs.getByRole('tab', { name: 'Sept-2026 planning and release coordination', exact: true })
    await expect(second).toHaveAttribute('aria-selected', 'true')
    await expect(header).toHaveCount(0)
    await expect(second).toHaveAttribute('title', 'Sept-2026 planning and release coordination')
    expect(await second.locator('span').last().evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(160 * scenario.zoom)
    await second.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await expect(header).toHaveCount(1)
    await expect(composer).toHaveValue('Preserve this draft while switching tasks')
    await page.screenshot({ path: testInfo.outputPath(`workbench-${scenario.name}-tabs.png`) })
    await page.keyboard.press('ControlOrMeta+p')
    await expect(quickOpen).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(quickOpen).toHaveCount(0)
    const close = tabs.getByRole('button', { name: 'Close Sept-2026 planning and release coordination', exact: true })
    await close.scrollIntoViewIfNeeded()
    const size = await close.boundingBox()
    expect(size?.width).toBeGreaterThanOrEqual(24 * scenario.zoom)
    expect(size?.height).toBeGreaterThanOrEqual(24 * scenario.zoom)
    const tabRow = await tabs.boundingBox()
    expect(tabRow?.height).toBe(28 * scenario.zoom)
    expect(size!.y).toBeGreaterThanOrEqual(tabRow!.y)
    expect(size!.y + size!.height).toBeLessThanOrEqual(tabRow!.y + tabRow!.height)
    await close.click()
    await expect(second).toHaveCount(0)
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await expect(composer).toHaveValue('Preserve this draft while switching tasks')
    expect(errors).toEqual([])
    await page.getByRole('button', { name: 'Toggle chat panel', exact: true }).click()
    await expect(header).toHaveCount(0)
    await page.getByRole('button', { name: 'Toggle chat panel', exact: true }).click()
    await expect(header.getByText('Connected', { exact: true })).toBeVisible()
    await expect(composer).toHaveValue('Preserve this draft while switching tasks')
    await page.evaluate(() => window.compactChatFixture.setState('offline', true))
    await expect(header.getByText('Offline history', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
  })
}
