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
  test(`drags sessions to reorder manually and restores order on reload in ${theme} mode`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${url}?workbench&panes&sessions&theme=${theme}`)
    await expect(page.getByLabel('Chat header').getByText('Connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()

    const sidebar = page.getByRole('complementary', { name: 'Agent Host sessions', exact: true })
    const tree = sidebar.getByRole('tree', { name: 'Sessions for T-0002' })
    const titles = () => tree.getByRole('treeitem').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')))
    await expect.poll(titles).toEqual([
      'A focused release plan',
      'Investigate session creation',
      'A deliberately long conversation title that should remain on one compact line',
      'Verify the next release',
    ])

    // Drag the bottom session row up to the top by dragging its title button directly.
    const bottomButton = tree.getByRole('treeitem', { name: 'Verify the next release', exact: true }).getByRole('button', { name: 'Open Verify the next release', exact: true })
    const topItem = tree.getByRole('treeitem', { name: 'A focused release plan', exact: true })
    await bottomButton.dragTo(topItem.locator('.session-tree-row'), { targetPosition: { x: 90, y: 4 } })
    await expect.poll(titles).toEqual([
      'Verify the next release',
      'A focused release plan',
      'Investigate session creation',
      'A deliberately long conversation title that should remain on one compact line',
    ])
    // Dragging did not switch the active conversation away from 'A focused release plan'.
    await expect(topItem).toHaveAttribute('aria-selected', 'true')

    // Drag 'Investigate session creation' down to the bottom via its drag grip.
    const middleGrip = tree.getByRole('treeitem', { name: 'Investigate session creation', exact: true }).locator('.session-drag-grip')
    const lastItem = tree.getByRole('treeitem', { name: 'A deliberately long conversation title that should remain on one compact line', exact: true })
    await middleGrip.dragTo(lastItem.locator('.session-tree-row'), { targetPosition: { x: 90, y: 46 } })
    await expect.poll(titles).toEqual([
      'Verify the next release',
      'A focused release plan',
      'A deliberately long conversation title that should remain on one compact line',
      'Investigate session creation',
    ])

    // Smart sort: Last response, Created (newest), and Name (A–Z).
    const sortPicker = sidebar.getByRole('button', { name: 'Sort sessions', exact: true })
    await expect(sortPicker).toHaveText('Manual')
    await expect(sidebar.locator('.session-list-count')).toHaveText('4 sessions')

    const chooseSort = async (label: string, screenshotOpen?: boolean) => {
      await sortPicker.click()
      const menu = sidebar.getByRole('listbox', { name: 'Sort sessions by', exact: true })
      await expect(menu).toBeVisible()
      if (screenshotOpen) await sidebar.screenshot({ path: testInfo.outputPath(`session-sort-menu-${theme}.png`) })
      await menu.getByRole('option', { name: label }).click()
    }

    await chooseSort('Last response', true)
    await expect(sortPicker).toHaveText('Last response')
    await expect.poll(titles).toEqual([
      'Investigate session creation',
      'Verify the next release',
      'A deliberately long conversation title that should remain on one compact line',
      'A focused release plan',
    ])
    await sidebar.screenshot({ path: testInfo.outputPath(`session-smart-sort-${theme}.png`) })

    await chooseSort('Created (newest)')
    await expect.poll(titles).toEqual([
      'Verify the next release',
      'A deliberately long conversation title that should remain on one compact line',
      'Investigate session creation',
      'A focused release plan',
    ])

    await chooseSort('Name (A–Z)')
    await expect.poll(titles).toEqual([
      'A deliberately long conversation title that should remain on one compact line',
      'A focused release plan',
      'Investigate session creation',
      'Verify the next release',
    ])

    // Dragging while smart-sorted transitions smoothly back to Manual with the dropped order.
    await bottomButton.dragTo(tree.getByRole('treeitem').first().locator('.session-tree-row'), { targetPosition: { x: 90, y: 4 } })
    await expect(sortPicker).toHaveText('Manual')
    await expect.poll(titles).toEqual([
      'Verify the next release',
      'A deliberately long conversation title that should remain on one compact line',
      'A focused release plan',
      'Investigate session creation',
    ])
    await sidebar.screenshot({ path: testInfo.outputPath(`session-drag-reordered-${theme}.png`) })

    // Reloading the workbench restores the exact manual order instead of creation order.
    await page.reload()
    await expect(page.getByLabel('Chat header').getByText('Connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    await expect(sortPicker).toHaveText('Manual')
    await expect.poll(titles).toEqual([
      'Verify the next release',
      'A deliberately long conversation title that should remain on one compact line',
      'A focused release plan',
      'Investigate session creation',
    ])
    expect(errors).toEqual([])
  })
}

test.describe('session grouping', () => {
  test.use({ deviceScaleFactor: 2 })

  for (const theme of ['light', 'dark'] as const) {
    test(`groups linked sessions and restores the local layout in ${theme}`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.setViewportSize({ width: 1200, height: 850 })
      await page.goto(`${url}?workbench&panes&sessions&group-demo&theme=${theme}`)
      await expect(page.getByLabel('Chat header').getByText('Connected', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
      await page.evaluate(async () => { await document.fonts.ready })

      const sidebar = page.getByRole('complementary', { name: 'Agent Host sessions', exact: true })
      const tree = sidebar.getByRole('tree', { name: 'Sessions for T-0002' })
      const item = (name: string) => tree.getByRole('treeitem', { name, exact: true })
      const row = (name: string) => item(name).locator(':scope > :is(.session-tree-row, .session-group-row)')
      const grip = (name: string) => row(name).locator('.session-drag-grip')
      const captions = (group: string) => item(group).getByRole('treeitem').evaluateAll((items) => items.map((child) => child.getAttribute('aria-label')))
      const performance = '性能优化'
      const migration = '迁移调研'
      const snapshot = () => page.evaluate(() => localStorage.getItem('taskcontinuum:workbench-selection:v2:fixture'))
      const screenshot = async (scene: string) => {
        const bounds = (await sidebar.boundingBox())!
        const content = (await tree.boundingBox())!
        const height = Math.min(bounds.height, content.y + content.height - bounds.y + 16)
        await page.screenshot({ path: testInfo.outputPath(`${scene}-${theme}.png`), clip: { ...bounds, height }, animations: 'disabled' })
      }
      const dragOver = async (sourceName: string, targetName: string) => {
        const source = (await grip(sourceName).boundingBox())!
        const target = (await row(targetName).boundingBox())!
        await page.mouse.move(source.x + 5, source.y + 7)
        await page.mouse.down()
        await page.mouse.move(source.x + 18, source.y + 7, { steps: 4 })
        await page.mouse.move(target.x + 105, target.y + target.height / 2, { steps: 10 })
        await page.mouse.move(target.x + 108, target.y + target.height / 2)
      }

      await expect(item('Performance lead')).toHaveAttribute('aria-selected', 'true')
      const composer = page.getByRole('textbox', { name: 'Message Agent Host' })
      await composer.fill('Draft stays in the original conversation')
      const calls = await page.evaluate(() => ({ ...window.compactChatFixture.calls }))
      const before = await snapshot()

      await dragOver('Benchmark runner', 'Performance lead')
      await expect(item('Performance lead')).toHaveAttribute('data-drop', 'group')
      await expect(row('Performance lead').getByText('Create group')).toBeVisible()
      expect(await snapshot()).toBe(before)
      if (theme === 'light') await screenshot('drag-to-group')
      await page.mouse.up()

      const editor = sidebar.getByRole('textbox', { name: 'Group name', exact: true })
      await expect(editor).toHaveValue('New group')
      await expect(editor).toBeFocused()
      await editor.fill(performance)
      if (theme === 'light') await screenshot('rename-in-place')
      await editor.press('Enter')
      await expect(item(performance)).toHaveAttribute('aria-expanded', 'true')
      const header = row(performance)
      await grip('Local tests').dragTo(header, { targetPosition: { x: 100, y: 16 } })
      await grip('Local build').dragTo(row('Local tests'), { targetPosition: { x: 100, y: 25 } })
      await expect.poll(() => captions(performance)).toEqual(['Performance lead', 'Benchmark runner', 'Local tests', 'Local build'])
      await expect(item('Local build')).toHaveAttribute('aria-level', '2')

      await grip('Compatibility review').dragTo(row('Migration analysis'))
      await editor.fill(migration)
      await editor.press('Enter')
      await row(migration).getByRole('button', { name: `Collapse ${migration}`, exact: true }).click()
      await expect(sidebar.locator('.session-list-count')).toHaveText('8 sessions · 2 groups')
      await page.mouse.move(1, 1)
      await screenshot('groups-expanded')

      await header.getByRole('button', { name: `Collapse ${performance}`, exact: true }).click()
      await expect(item(performance)).toHaveAttribute('aria-description', /Contains current session/)
      await page.mouse.move(1, 1)
      if (theme === 'dark') await screenshot('groups-collapsed')
      await page.evaluate(() => window.compactChatFixture.setHistoryTransfer({ receivedBytes: 100, totalBytes: 1000 }))
      await expect(item(performance)).toHaveAttribute('aria-description', /1 syncing history/)
      await page.evaluate(() => window.compactChatFixture.setHistoryTransfer(undefined))
      await expect(composer).toHaveValue('Draft stays in the original conversation')
      expect(await page.evaluate(() => window.compactChatFixture.calls)).toEqual(calls)

      await page.reload()
      await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
      await expect(item(performance)).toHaveAttribute('aria-expanded', 'false')
      await expect(item(migration)).toHaveAttribute('aria-expanded', 'false')
      const collapsedLayout = await snapshot()
      await dragOver('Release notes', migration)
      await expect(item(migration)).toHaveAttribute('data-drop', 'into')
      await expect(item(migration)).toHaveAttribute('aria-expanded', 'true')
      expect(await snapshot()).toBe(collapsedLayout)
      await page.mouse.move(1, 1)
      await page.mouse.up()
      await expect(item(migration)).toHaveAttribute('aria-expanded', 'false')
      await header.getByRole('button', { name: `Expand ${performance}`, exact: true }).click()
      await expect.poll(() => captions(performance)).toEqual(['Performance lead', 'Benchmark runner', 'Local tests', 'Local build'])

      await grip('Local build').dragTo(row('Release notes'), { targetPosition: { x: 90, y: 4 } })
      await expect(item('Local build')).toHaveAttribute('aria-level', '1')
      await grip(migration).dragTo(header, { targetPosition: { x: 85, y: 4 } })
      await expect(tree.locator(':scope > li').first()).toHaveAttribute('aria-label', migration)
      await item(performance).focus()
      await page.keyboard.press('F2')
      await editor.fill('Discard this name')
      await editor.press('Escape')
      await expect(item(performance)).toBeFocused()
      await row(migration).hover()
      await row(migration).getByRole('button', { name: `Ungroup ${migration}`, exact: true }).click()
      await expect(item(migration)).toHaveCount(0)
      await expect(item('Migration analysis')).toHaveAttribute('aria-level', '1')
      await expect(item('Compatibility review')).toHaveAttribute('aria-level', '1')
      const sort = sidebar.getByRole('button', { name: 'Sort sessions', exact: true })
      await sort.click()
      await sidebar.getByRole('option', { name: 'Name (A–Z)', exact: true }).click()
      await item(performance).focus()
      await page.keyboard.press('F2')
      await editor.fill('Benchmarks')
      await editor.press('Enter')
      await expect(sort).toHaveText('Name (A–Z)')
      await expect.poll(() => captions('Benchmarks')).toEqual(['Benchmark runner', 'Local tests', 'Performance lead'])
      expect(errors).toEqual([])
    })
  }
})

test('session history transfer labels distinguish full sync, resume and recent paging', async ({ page }) => {
  await page.goto(`${url}?workbench&panes&sessions&theme=dark`)
  const header = page.getByLabel('Chat header')
  await expect(header.getByRole('status', { name: 'Connected' })).toBeVisible()
  await page.evaluate(() => {
    window.compactChatFixture.setState('connecting')
    window.compactChatFixture.setHistoryTransfer({ receivedBytes: 1024, totalBytes: 8192 })
  })
  await expect(header.getByRole('status', { name: 'Syncing history...' })).toBeVisible()
  await expect(header.getByRole('status', { name: 'Loading recent history...' })).toHaveCount(0)
  await page.evaluate(() => window.compactChatFixture.setHistoryTransfer({ receivedBytes: 4096, totalBytes: 8192, resumed: true }))
  await expect(header.getByRole('status', { name: 'Resuming history...' })).toBeVisible()
  await page.evaluate(() => window.compactChatFixture.setHistoryTransfer({ receivedBytes: 1024, totalBytes: 8192, kind: 'recent' }))
  await expect(header.getByRole('status', { name: 'Loading recent history...' })).toBeVisible()
  await page.evaluate(() => {
    window.compactChatFixture.setHistoryTransfer(undefined)
    window.compactChatFixture.setState('connected')
  })
  await expect(header.getByRole('status', { name: 'Connected' })).toBeVisible()
})

for (const scenario of [
  { name: 'wide-light', width: 1440, height: 900, theme: 'light', zoom: 1 },
  { name: 'wide-dark', width: 1440, height: 900, theme: 'dark', zoom: 1 },
  { name: 'narrow-light', width: 360, height: 740, theme: 'light', zoom: 1 },
  { name: 'zoomed-dark', width: 1440, height: 1100, theme: 'dark', zoom: 2 },
]) {
  test(`session history transfer stays on its interactive row in ${scenario.name}`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: scenario.width, height: scenario.height })
    await page.goto(`${url}?workbench&panes&sessions&theme=${scenario.theme}`)
    await expect(page.getByLabel('Chat header').getByText('Connected', { exact: true })).toBeVisible()
    if (scenario.zoom !== 1) await page.evaluate((zoom) => {
      document.body.style.zoom = String(zoom)
      document.querySelector<HTMLElement>('.workbench')!.style.height = `${innerHeight / zoom}px`
    }, scenario.zoom)
    await page.getByRole('button', { name: 'Agent Host linked', exact: true }).click()
    const sidebar = page.getByRole('complementary', { name: 'Agent Host sessions', exact: true })
    const row = sidebar.getByRole('treeitem', { name: 'A focused release plan', exact: true })
    const line = row.locator('.session-tree-row')
    const original = await line.boundingBox()
    await page.evaluate(() => {
      window.compactChatFixture.setState('connecting')
      window.compactChatFixture.setHistoryTransfer({ receivedBytes: 1024 * 1024, totalBytes: 117.1 * 1024 * 1024, kind: 'recent' })
    })
    const bar = row.getByRole('progressbar', { name: 'History transfer for A focused release plan' })
    await expect(bar).toBeVisible()
    await expect(bar).toHaveAttribute('aria-valuetext', 'Recent history: 0.8% (1.0 / 117.1 MiB)')
    await expect(row.getByText('0.8%', { exact: true })).toBeVisible()
    await expect(sidebar.getByRole('progressbar')).toHaveCount(1)
    const bounds = await bar.boundingBox()
    const current = await line.boundingBox()
    expect(Math.abs(current!.height - original!.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(bounds!.width - current!.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(bounds!.height - current!.height)).toBeLessThanOrEqual(1)
    expect(bounds!.x).toBeGreaterThanOrEqual(current!.x - 1)
    expect(await bar.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none')
    const calls = await page.evaluate(() => ({ ...window.compactChatFixture.calls }))
    await row.getByRole('button', { name: 'Show details for A focused release plan', exact: true }).click()
    const details = row.getByRole('group', { name: 'Details for A focused release plan', exact: true })
    await expect(details).toBeVisible()
    await expect(details.getByRole('button', { name: 'Unlink A focused release plan', exact: true })).toBeEnabled()
    await row.getByRole('button', { name: 'Hide details for A focused release plan', exact: true }).click()
    expect(await page.evaluate(() => window.compactChatFixture.calls)).toEqual(calls)
    await expect(row.getByRole('button', { name: 'Unlink A focused release plan', exact: true })).toHaveCount(0)
    await page.evaluate(() => window.compactChatFixture.setHistoryTransfer({
      receivedBytes: 106.8 * 1024 * 1024, totalBytes: 117.1 * 1024 * 1024, kind: 'recent', resumed: true,
    }))
    await expect(row.getByText('91.2%', { exact: true })).toBeVisible()
    await expect(bar).toHaveAttribute('aria-valuetext', /Resumed from saved progress/)
    expect(await row.locator('.session-transfer-status > span:not(.codicon)').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await expect(page.getByRole('log').getByRole('progressbar')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.mouse.move(1, 1)
    // Native progress pseudo-elements have a 160ms width transition.
    await page.waitForTimeout(200)
    await sidebar.screenshot({ path: testInfo.outputPath(`session-history-transfer-${scenario.name}.png`) })
    await page.evaluate(() => {
      window.compactChatFixture.setHistoryTransfer(undefined)
      window.compactChatFixture.setState('connected')
    })
    await expect(bar).toHaveCount(0)
    await expect(row.locator('.session-machine')).toBeVisible()
    expect(errors).toEqual([])
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`lazy history paging preserves the real visible scroll anchor in ${theme}`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: 1100, height: 740 })
    await page.goto(`${url}?lazy&theme=${theme}`)
    const log = page.getByRole('log')
    await expect(page.getByRole('button', { name: 'Load earlier messages', exact: true })).toBeVisible()
    await page.evaluate(async () => { await document.fonts.ready })
    const input = page.getByRole('textbox', { name: 'Message Agent Host' })
    await input.fill('Keep this draft while browsing older messages')
    await log.evaluate((element) => { element.scrollTop = 80; element.dispatchEvent(new Event('scroll', { bubbles: true })) })
    await expect(page.getByRole('button', { name: 'Loading earlier messages...', exact: true })).toBeDisabled()
    const anchor = log.locator('[data-turn-id="turn-0"]')
    const before = await anchor.boundingBox()
    await page.evaluate(() => window.compactChatFixture.completeHistoryLoad())
    await expect(log.locator('[data-turn-id]')).toHaveCount(8)
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const after = await anchor.boundingBox()
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(2)
    expect(await page.evaluate(() => window.compactChatFixture.historyLoads)).toBe(1)
    await expect(input).toHaveValue('Keep this draft while browsing older messages')
    await expect(log.getByRole('progressbar')).toHaveCount(0)
    expect(errors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`lazy-history-anchor-${theme}.png`) })
  })
}

for (const scenario of [
  { method: 'Enter', width: 1440, height: 900 },
  { method: 'Enter', width: 360, height: 740 },
  { method: 'send button', width: 1440, height: 900 },
]) {
  test(`follows the latest output immediately on ${scenario.method} at ${scenario.width}px while delivery is pending`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: scenario.width, height: scenario.height })
    await page.goto(url)
    const panel = page.getByRole('complementary', { name: 'Agent Host task chat' })
    await expect(panel.getByText('Connected', { exact: true })).toBeVisible()
    await panel.getByRole('combobox', { name: 'Agent Host model' }).selectOption('gpt-6')
    await page.evaluate(async () => {
      await document.fonts.ready
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      window.agentHost!.send = async () => {
        window.compactChatFixture.calls.send++
        await new Promise<void>(() => undefined)
      }
    })
    const input = panel.getByRole('textbox', { name: 'Message Agent Host' })
    const log = panel.getByRole('log')
    const distanceFromBottom = () => log.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
    await input.fill('Show the latest output')
    expect(await log.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(300)
    await log.evaluate((element) => { element.scrollTop = 100; element.dispatchEvent(new Event('scroll', { bubbles: true })) })
    await page.evaluate(() => window.compactChatFixture.setState('connected'))
    await expect.poll(distanceFromBottom).toBeGreaterThan(300)
    await input.press('Shift+Enter')
    await expect(input).toHaveValue('Show the latest output\n')
    expect(await distanceFromBottom()).toBeGreaterThan(300)
    expect(await page.evaluate(() => window.compactChatFixture.calls.send)).toBe(0)
    if (scenario.method === 'Enter') await input.press('Enter')
    else await panel.getByRole('button', { name: 'Send to Agent Host', exact: true }).click()
    expect(await page.evaluate(() => window.compactChatFixture.calls.send)).toBe(1)
    await expect.poll(distanceFromBottom).toBeLessThanOrEqual(1)
    await expect(panel.getByRole('button', { name: 'Send to Agent Host', exact: true })).toBeDisabled()
    await expect(input).toHaveValue('Show the latest output\n')
    await page.evaluate(() => window.compactChatFixture.setState('connected'))
    await expect.poll(distanceFromBottom).toBeLessThanOrEqual(1)
    expect(errors).toEqual([])
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`keeps linked sessions compact with independent detail disclosure in ${theme} mode`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${url}?workbench&panes&sessions&theme=${theme}`)
    await expect(page.getByLabel('Chat header').getByText('Connected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    const sidebar = page.getByRole('complementary', { name: 'Agent Host sessions', exact: true })
    const tree = sidebar.getByRole('tree', { name: 'Sessions for T-0002' })
    await expect(tree.getByRole('treeitem')).toHaveCount(4)
    await expect(sidebar.locator('.session-task-context strong')).toHaveText('T-0002 - Fix Connection issues')
    for (const removed of ['AGENT HOST SESSIONS', 'Current task']) await expect(sidebar.getByText(removed, { exact: true })).toHaveCount(0)
    for (const removed of ['Back to tasks', 'Link existing', 'Create new']) await expect(sidebar.getByRole('button', { name: removed, exact: true })).toHaveCount(0)
    for (const tab of ['Current', 'Link', 'Create']) await expect(sidebar.getByRole('tab', { name: tab, exact: true })).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Refresh Agent Host sessions', exact: true })).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'Hide session sidebar', exact: true })).toBeVisible()
    expect((await sidebar.locator('.session-task-context').boundingBox())!.height).toBeLessThanOrEqual(44)
    await expect(tree.getByText('Fix Connection issues', { exact: true })).toHaveCount(0)
    await expect(tree.locator('.session-details')).toHaveCount(0)
    for (const row of await tree.getByRole('treeitem').all()) {
      await expect(row).toHaveAttribute('aria-level', '1')
      await expect(row).toHaveAttribute('aria-expanded', 'false')
      const bounds = await row.boundingBox()
      expect(bounds!.height).toBeLessThanOrEqual(52)
      expect(bounds!.height).toBeGreaterThanOrEqual(44)
      const disclosure = row.getByRole('button', { name: /^Show details for / })
      const disclosureBounds = await disclosure.boundingBox()
      expect(disclosureBounds!.width).toBeGreaterThanOrEqual(24)
      expect(disclosureBounds!.width).toBeLessThanOrEqual(28)
      expect(disclosureBounds!.height).toBeGreaterThanOrEqual(24)
      expect(disclosureBounds!.height).toBeLessThanOrEqual(28)
      await expect(row.getByRole('button', { name: /^Open / }).locator('.session-machine')).toBeVisible()
      await expect(row.getByRole('button', { name: /^Unlink / })).toHaveCount(0)
    }
    await expect(tree.getByText('Read and send', { exact: true })).toHaveCount(0)
    await expect(tree.getByText('Current session', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`compact-sessions-${theme}.png`) })
    const calls = await page.evaluate(() => ({ ...window.compactChatFixture.calls }))
    const first = tree.getByRole('treeitem', { name: 'A focused release plan', exact: true })
    await first.getByRole('button', { name: 'Show details for A focused release plan', exact: true }).click()
    await expect(first).toHaveAttribute('aria-expanded', 'true')
    const details = first.getByRole('group', { name: 'Details for A focused release plan', exact: true })
    await expect(details.getByText('Read and send', { exact: true })).toBeVisible()
    await expect(details.getByText('Remote', { exact: true })).toBeVisible()
    await expect(details.getByText(`copilotcli:/${'s'.repeat(120)}`, { exact: true })).toBeVisible()
    const firstUnlink = details.getByRole('button', { name: 'Unlink A focused release plan', exact: true })
    await expect(firstUnlink).toBeInViewport()
    const unlinkBounds = await firstUnlink.boundingBox()
    expect(unlinkBounds!.width).toBeGreaterThanOrEqual(24)
    expect(unlinkBounds!.height).toBeGreaterThanOrEqual(24)
    expect(await details.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.evaluate(() => window.compactChatFixture.calls)).toEqual(calls)
    const second = tree.getByRole('treeitem', { name: 'Investigate session creation', exact: true })
    await second.getByRole('button', { name: 'Show details for Investigate session creation', exact: true }).click()
    await second.getByRole('group', { name: 'Details for Investigate session creation', exact: true }).getByRole('button', { name: 'Unlink Investigate session creation', exact: true }).click()
    const confirmation = sidebar.getByRole('region', { name: 'Detach conversation', exact: true })
    await expect(confirmation).toBeVisible()
    await expect(first).toHaveAttribute('aria-selected', 'true')
    expect(await page.evaluate(() => window.compactChatFixture.calls)).toEqual(calls)
    await confirmation.getByRole('button', { name: 'Keep conversation', exact: true }).click()
    await second.getByRole('button', { name: 'Hide details for Investigate session creation', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath(`compact-sessions-${theme}-expanded.png`) })
    await first.getByRole('button', { name: 'Hide details for A focused release plan', exact: true }).click()
    await expect(details).toHaveCount(0)
    expect(await page.evaluate(() => window.compactChatFixture.calls)).toEqual(calls)
    await page.setViewportSize({ width: 360, height: 740 })
    await expect(sidebar).toBeVisible()
    await expect(tree.getByRole('treeitem')).toHaveCount(4)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await first.getByRole('button', { name: 'Show details for A focused release plan', exact: true }).click()
    await expect(details).toBeVisible()
    expect(await details.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`compact-sessions-${theme}-narrow.png`) })
    await page.setViewportSize({ width: 1440, height: 1100 })
    await page.evaluate(() => { document.body.style.zoom = '2' })
    await expect(details).toBeVisible()
    expect(await details.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await first.getByRole('button', { name: 'Hide details for A focused release plan', exact: true }).click()
    const zoomedBounds = await first.boundingBox()
    expect(zoomedBounds!.height).toBeLessThanOrEqual(104)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
  })
}

for (const scenario of [
  { name: 'wide-light', width: 1440, height: 900, theme: 'light', zoom: 1 },
  { name: 'narrow-light', width: 360, height: 740, theme: 'light', zoom: 1 },
  { name: 'zoomed-dark', width: 1440, height: 1100, theme: 'dark', zoom: 2 },
]) {
  test(`keeps Markdown lists compact and authored breaks intact in ${scenario.name}`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const source = 'First line\nSecond line\n\n1. **First:** Keep the existing behavior.\n\n2. **Second:** Use the selected conversation.\n\n3. **Third:** Validate the visible output.\n\n4. **Fourth:** Retain the selected model.\n\n## Nested list\n\n- **Parent line**\n  Parent continuation\n  - Nested first\n  - Nested second\n\n## Checklist\n\n- [x] Complete\n- [ ] Pending\n\n```text\nalpha\n\nbeta\n```'
    await page.setViewportSize({ width: scenario.width, height: scenario.height })
    await page.goto(`${url}?theme=${scenario.theme}&markdown=${encodeURIComponent(source)}`)
    await expect(page.locator('.workbench')).toBeVisible()
    await page.evaluate((zoom) => {
      document.body.style.zoom = String(zoom)
      document.querySelector<HTMLElement>('.workbench')!.style.height = `${innerHeight / zoom}px`
    }, scenario.zoom)
    const markdown = page.getByRole('log').locator('.message-markdown')
    await expect(markdown).toBeVisible()
    await page.evaluate(async () => { await document.fonts.ready })
    const ordered = markdown.locator('ol')
    await expect(ordered.locator(':scope > li')).toHaveCount(4)
    const metrics = await ordered.evaluate((element) => {
      const items = Array.from(element.children).map((item) => {
        const paragraph = item.querySelector('p')
        if (!paragraph) throw new Error('Expected each loose list item to retain its paragraph.')
        const bounds = item.getBoundingClientRect()
        const paragraphBounds = paragraph.getBoundingClientRect()
        return { height: bounds.height, paragraphHeight: paragraphBounds.height, paragraphOffset: paragraphBounds.top - bounds.top, whiteSpace: getComputedStyle(item).whiteSpace }
      })
      return { listHeight: element.getBoundingClientRect().height, items }
    })
    for (const item of metrics.items) {
      expect(item.whiteSpace).toBe('normal')
      expect(Math.abs(item.paragraphOffset)).toBeLessThanOrEqual(0.5 * scenario.zoom)
      expect(item.height - item.paragraphHeight).toBeLessThanOrEqual(1 * scenario.zoom)
    }
    const paragraphHeight = metrics.items.reduce((height, item) => height + item.paragraphHeight, 0)
    expect(metrics.listHeight - paragraphHeight).toBeLessThanOrEqual(24 * scenario.zoom)
    const intro = markdown.locator(':scope > p').first()
    await expect(intro.locator('br')).toHaveCount(1)
    const introMetrics = await intro.evaluate((element) => ({ height: element.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight) }))
    expect(introMetrics.height / (introMetrics.lineHeight * scenario.zoom)).toBeGreaterThanOrEqual(1.95)
    expect(introMetrics.height / (introMetrics.lineHeight * scenario.zoom)).toBeLessThanOrEqual(2.05)
    const nested = markdown.locator('ul').first().locator(':scope > li').first()
    await expect(nested.locator('br')).toHaveCount(1)
    await expect(nested.locator('ul > li')).toHaveCount(2)
    const checkboxes = markdown.getByRole('checkbox')
    await expect(checkboxes).toHaveCount(2)
    await expect(checkboxes.nth(0)).toBeChecked()
    await expect(checkboxes.nth(1)).not.toBeChecked()
    for (const checkbox of await checkboxes.all()) await expect(checkbox).toBeDisabled()
    expect(await markdown.getByLabel('Code block').textContent()).toBe('alpha\n\nbeta\n')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await intro.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`markdown-lists-${scenario.name}.png`) })
    console.log(JSON.stringify({ scenario: scenario.name, ...metrics, intro: introMetrics }))
    expect(errors).toEqual([])
  })
}

test.describe('expandable markdown blocks', () => {
  test.use({ deviceScaleFactor: 2 })

  const sampleMarkdown = [
    '如果你们同时还想保护 `TTOL` (Time To OnLoad) 指标不被 `WeatherMapV2` 推迟，直接复用同一个 `afterWindowLoad` 门控即可。',
    '',
    '### 三种方案怎么选？',
    '',
    '| 候选方案 | 触发时机 | 最适合的目标 |',
    '| --- | --- | --- |',
    '| **方案 1** (`renderRootElement` + 双 `rAF`) | 首屏 React 外壳真正画上屏幕后的下一帧 | 代码最少（5 行），不改架构，自动适配快慢网。 |',
    '| **方案 2** (`PerformanceObserver` 监听 FCP) | 浏览器记录 `first-contentful-paint` 的精确瞬间 | 改动完全封装在 `earlyLoadWeatherMapBundle` 内，与 PAS 的 **FCP** 指标严格对齐，且最大化提前量保 **TTVR**。 |',
    '| **方案 3** (`window.load` 之后) | 文档 `load` 事件完成后 | 如果除了 FCP 还严格卡 **TTOL** 指标，选这个最稳。 |',
    '',
    '```ts',
    'export function scheduleAfterFirstPaint(loadBundle: () => Promise<void>, options = { protectTtol: false }): void {',
    '  if (options.protectTtol && document.readyState !== "complete") {',
    '    window.addEventListener("load", () => requestAnimationFrame(() => void loadBundle()), { once: true });',
    '    return;',
    '  }',
    '  requestAnimationFrame(() => requestAnimationFrame(() => void loadBundle()));',
    '}',
    '```',
  ].join('\n')

  for (const theme of ['light', 'dark'] as const) {
    test(`expands Markdown tables and code blocks to full width cleanly in ${theme} mode`, async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.setViewportSize({ width: 1440, height: 920 })
      await page.goto(`${url}?theme=${theme}&markdown=${encodeURIComponent(sampleMarkdown)}`)
      await page.evaluate(async () => { await document.fonts.ready })

      const log = page.getByRole('log')
      const turn = log.locator('[data-turn-id]').first()
      await expect(turn).toBeVisible()
      // Keep a single clean turn on screen for exact layout and visual verification.
      await page.evaluate(() => {
        const turns = Array.from(document.querySelectorAll('[data-turn-id]'))
        for (const extra of turns.slice(1)) extra.remove()
      })

      const tableCard = turn.locator('.markdown-table-card')
      const codeCard = turn.locator('.message-code-block')
      const heading = turn.getByRole('heading', { name: '三种方案怎么选？' })

      const compactTableBox = (await tableCard.boundingBox())!
      const compactCodeBox = (await codeCard.boundingBox())!
      expect(compactTableBox.width).toBeLessThanOrEqual(770)
      expect(compactCodeBox.width).toBeLessThanOrEqual(770)

      await page.mouse.move(1, 1)
      const logBox = (await log.boundingBox())!
      await page.screenshot({
        path: testInfo.outputPath(`markdown-blocks-compact-${theme}.png`),
        clip: { x: logBox.x, y: logBox.y, width: logBox.width, height: Math.min(logBox.height, 640) },
        animations: 'disabled',
      })

      await tableCard.getByRole('button', { name: 'Expand table width', exact: true }).click()
      await codeCard.getByRole('button', { name: 'Expand code width', exact: true }).click()

      await expect(tableCard.getByRole('button', { name: 'Restore table width', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(codeCard.getByRole('button', { name: 'Restore code width', exact: true })).toHaveAttribute('aria-pressed', 'true')

      const expandedTableBox = (await tableCard.boundingBox())!
      const expandedCodeBox = (await codeCard.boundingBox())!
      const headingBox = (await heading.boundingBox())!
      const logClientWidth = await log.evaluate((el) => el.clientWidth)

      expect(expandedTableBox.width).toBeGreaterThanOrEqual(logClientWidth - 52)
      expect(expandedCodeBox.width).toBeGreaterThanOrEqual(logClientWidth - 52)
      // Surrounding prose heading stays comfortably at the 800px reading column.
      expect(headingBox.width).toBeLessThanOrEqual(770)
      // All 3 columns fit horizontally without clipping once expanded.
      expect(await tableCard.locator('.markdown-table-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      expect(await log.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

      await page.mouse.move(1, 1)
      await page.screenshot({
        path: testInfo.outputPath(`markdown-blocks-expanded-${theme}.png`),
        clip: { x: logBox.x, y: logBox.y, width: logBox.width, height: Math.min(logBox.height, 640) },
        animations: 'disabled',
      })

      // Restoring returns to compact width, and on a narrow viewport the expand button opens the full-window dialog.
      await tableCard.getByRole('button', { name: 'Restore table width', exact: true }).click()
      await codeCard.getByRole('button', { name: 'Restore code width', exact: true }).click()
      await page.setViewportSize({ width: 720, height: 820 })
      await tableCard.getByRole('button', { name: 'Expand table width', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Table', exact: true })
      await expect(dialog).toBeVisible()
      const dialogBox = (await dialog.boundingBox())!
      expect(dialogBox.width).toBeGreaterThanOrEqual(720 - 52)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      expect(errors).toEqual([])
    })
  }
})

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
      const colors = Object.fromEntries(['--text', '--muted', '--subtle', '--accent', '--link', '--selected', '--selection', '--raised'].map((name) => [name, color(name)]))
      probe.remove()
      const primary = document.createElement('button')
      primary.className = 'primary-button'
      element.append(primary)
      const primaryStyle = getComputedStyle(primary)
      const primaryAppearance = { background: primaryStyle.backgroundColor, color: primaryStyle.color, radius: primaryStyle.borderRadius }
      primary.remove()
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
        primary: primaryAppearance,
        neutralSelected: colors['--selected'],
        controlFill: colors['--raised'],
        feature: { background: style('.workspace-mark').backgroundColor, color: style('.workspace-mark').color },
        status: { background: style('.status-select.status-in-progress').backgroundColor, color: style('.status-select.status-in-progress').color },
        note: style('.next-action').backgroundColor,
        surfaceContrast: [
          contrast(colors['--text'], style('.message-user').backgroundColor),
          contrast(colors['--text'], style('.next-action').backgroundColor),
          contrast(style('.workspace-mark').color, style('.workspace-mark').backgroundColor),
          contrast(style('.status-select.status-in-progress').color, style('.status-select.status-in-progress').backgroundColor),
        ],
        buttonContrast: contrast(primaryAppearance.color, primaryAppearance.background),
        focusContrast: contrast(colors['--accent'], background),
        linkColor: colors['--link'],
        linkContrast: [background, selected, style('.message-user').backgroundColor].map((surface) => contrast(colors['--link'], surface)),
        neutralColors: [colors['--accent'], colors['--selected'], colors['--selection']],
        overflow: document.documentElement.scrollWidth > innerWidth,
      }
    })
    expect(appearance.background).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(31, 31, 31)')
    expect(appearance.sidebar).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(24, 24, 24)')
    expect(appearance.chat).toBe(appearance.background)
    expect(appearance.selected).toBe(theme === 'light' ? 'rgb(255, 243, 186)' : 'rgb(26, 44, 61)')
    expect(appearance.neutralSelected).toBe(theme === 'light' ? 'rgb(235, 235, 235)' : 'rgb(49, 49, 49)')
    expect(appearance.primary).toEqual({ background: theme === 'light' ? 'rgb(0, 103, 192)' : 'rgb(0, 120, 212)', color: 'rgb(255, 255, 255)', radius: '12px' })
    expect(appearance.feature).toEqual(theme === 'light'
      ? { background: 'rgb(239, 231, 255)', color: 'rgb(101, 65, 165)' }
      : { background: 'rgb(38, 38, 38)', color: 'rgb(157, 157, 157)' })
    expect(appearance.status).toEqual(theme === 'light'
      ? { background: 'rgb(255, 232, 214)', color: 'rgb(138, 74, 25)' }
      : { background: 'rgb(38, 38, 38)', color: 'rgb(176, 176, 176)' })
    expect(appearance.note).toBe(theme === 'light' ? 'rgb(255, 234, 220)' : 'rgb(36, 37, 38)')
    await expect(page.locator('.editor-tab.selected')).toHaveCSS('background-color', theme === 'light' ? appearance.feature.background : appearance.neutralSelected)
    await expect(page.locator('.filter-bar button[aria-pressed="true"]')).toHaveCSS('background-color', theme === 'light' ? appearance.selected : appearance.neutralSelected)
    await expect(page.locator('.task-eyebrow > span').first()).toHaveCSS('background-color', appearance.feature.background)
    expect(appearance.bubble).toBe(theme === 'light' ? 'rgb(230, 244, 255)' : 'rgb(33, 45, 58)')
    expect(appearance.composer).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(37, 37, 38)')
    expect(appearance.radii).toEqual({ selected: '12px', composer: '24px', bubble: '16px', button: '8px' })
    for (const ratio of appearance.textContrast) expect(ratio).toBeGreaterThanOrEqual(4.5)
    for (const ratio of appearance.surfaceContrast) expect(ratio).toBeGreaterThanOrEqual(4.5)
    expect(appearance.buttonContrast).toBeGreaterThanOrEqual(4.5)
    expect(appearance.focusContrast).toBeGreaterThanOrEqual(3)
    expect(appearance.linkColor).toBe(theme === 'light' ? 'rgb(9, 105, 184)' : 'rgb(77, 170, 252)')
    for (const ratio of appearance.linkContrast) expect(ratio).toBeGreaterThanOrEqual(4.5)
    for (const color of appearance.neutralColors) {
      const channels = color.match(/\d+/g)
      expect(channels).toHaveLength(3)
      expect(new Set(channels).size).toBe(1)
    }
    expect(appearance.overflow).toBe(false)
    const webLink = panel.getByRole('link', { name: 'Release notes', exact: true }).last()
    const fileLink = panel.getByRole('link', { name: 'plan.md', exact: true }).last()
    await expect(webLink).toHaveCSS('color', appearance.linkColor)
    await expect(webLink.locator('strong')).toHaveCSS('color', appearance.linkColor)
    await expect(fileLink).toHaveCSS('color', appearance.linkColor)
    await expect(fileLink.locator('code')).toHaveCSS('color', appearance.linkColor)
    await webLink.hover()
    await expect(webLink).toHaveCSS('text-decoration-line', 'underline')
    await panel.locator('.message-assistant').last().screenshot({ path: testInfo.outputPath(`links-${theme}.png`) })
    const taskDetails = page.getByRole('complementary', { name: 'Task details' })
    await taskDetails.getByRole('tab', { name: 'Requirements', exact: true }).click()
    await expect(taskDetails.getByRole('link', { name: 'Documentation', exact: true }).locator('strong')).toHaveCSS('color', appearance.linkColor)
    await expect(taskDetails.getByRole('link', { name: 'plan.md', exact: true }).locator('code')).toHaveCSS('color', appearance.linkColor)
    await taskDetails.getByRole('tab', { name: 'Overview', exact: true }).click()
    const composer = panel.locator('.composer')
    const input = panel.getByRole('textbox', { name: 'Message Agent Host' })
    const send = panel.getByRole('button', { name: 'Send to Agent Host', exact: true })
    await expect(send).toBeDisabled()
    await expect(send).toHaveCSS('background-color', appearance.controlFill)
    await page.getByRole('tab', { name: 'Fix Connection issues', exact: true }).focus()
    const resting = await composer.evaluate((element) => {
      const style = getComputedStyle(element)
      return { border: style.borderColor, width: style.borderWidth, shadow: style.boxShadow }
    })
    await expect(input).not.toBeFocused()
    await input.focus()
    await expect(input).toBeFocused()
    const focused = await composer.evaluate((element) => {
      const style = getComputedStyle(element)
      return { border: style.borderColor, width: style.borderWidth, shadow: style.boxShadow }
    })
    expect(resting.width).toBe('1px')
    expect(focused.width).toBe('1px')
    expect(resting.border).toBe(theme === 'light' ? 'rgb(229, 229, 229)' : 'rgb(43, 43, 43)')
    expect(focused.border).toBe(theme === 'light' ? 'rgb(206, 206, 206)' : 'rgb(71, 71, 71)')
    expect(focused.border).not.toBe(resting.border)
    expect(focused.shadow).toBe(resting.shadow)
    await expect(input).toHaveCSS('outline-width', '0px')
    await panel.locator('.composer-area').screenshot({ path: testInfo.outputPath(`composer-${theme}-focused.png`) })
    await input.fill('Keep the composer simple, quiet and neutral.')
    await expect(send).toBeEnabled()
    await expect(send).toHaveCSS('background-color', appearance.primary.background)
    await expect(send).toHaveCSS('color', 'rgb(255, 255, 255)')
    await expect(send).toHaveCSS('border-radius', '50%')
    await input.press('ControlOrMeta+a')
    expect(await input.evaluate((element) => getComputedStyle(element, '::selection').backgroundColor))
      .toBe(theme === 'light' ? 'rgb(227, 227, 227)' : 'rgb(58, 58, 58)')
    await panel.locator('.composer-area').screenshot({ path: testInfo.outputPath(`composer-${theme}-selection.png`) })
    await input.fill('')
    await page.screenshot({ path: testInfo.outputPath(`neutral-${theme}.png`) })
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    const preferences = page.getByRole('dialog', { name: 'Preferences' })
    await expect(preferences).toHaveCSS('border-radius', '16px')
    await expect(preferences.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark', exact: true })).toBeChecked()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    const row = page.locator('.session-tree-row.is-selected')
    await expect(row).toHaveCSS('border-radius', '12px')
    await expect(row).toHaveCSS('background-color', appearance.neutralSelected)
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
    await expect(page.locator('.workbench')).toBeVisible()
    await page.evaluate((zoom) => {
      document.body.style.zoom = String(zoom)
      // CSS zoom leaves viewport units unchanged, unlike Electron's page zoom.
      document.querySelector<HTMLElement>('.workbench')!.style.height = `${innerHeight / zoom}px`
    }, scenario.zoom)
    const panel = page.getByRole('complementary', { name: 'Agent Host task chat' })
    await expect(panel.getByText('Connected', { exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Attach images', exact: true })).toHaveCount(0)
    await panel.getByRole('combobox', { name: 'Agent Host model' }).selectOption('gpt-6')
    const composer = panel.getByRole('textbox', { name: 'Message Agent Host' })
    const send = panel.getByRole('button', { name: 'Send to Agent Host', exact: true })
    for (const draft of ['', 'Keep the send arrow centered.']) {
      await composer.fill(draft)
      if (draft) await expect(send).toBeEnabled()
      else await expect(send).toBeDisabled()
      const alignment = await send.evaluate((element) => {
        const button = element.getBoundingClientRect()
        const icon = element.querySelector('.codicon')!.getBoundingClientRect()
        const refresh = element.parentElement!.querySelector('[aria-label="Retry loading models"]')!.getBoundingClientRect()
        return {
          horizontalOffset: icon.x + icon.width / 2 - button.x - button.width / 2,
          verticalOffset: icon.y + icon.height / 2 - button.y - button.height / 2,
          toolbarOffset: button.y + button.height / 2 - refresh.y - refresh.height / 2,
          width: button.width, height: button.height,
        }
      })
      console.log(JSON.stringify({ scenario: scenario.name, enabled: Boolean(draft), alignment }))
      expect(Math.abs(alignment.horizontalOffset)).toBeLessThanOrEqual(0.25 * scenario.zoom)
      expect(Math.abs(alignment.verticalOffset)).toBeLessThanOrEqual(0.25 * scenario.zoom)
      expect(Math.abs(alignment.toolbarOffset)).toBeLessThanOrEqual(0.25 * scenario.zoom)
      expect(alignment.width).toBe(26 * scenario.zoom)
      expect(alignment.height).toBe(26 * scenario.zoom)
    }
    await panel.locator('.composer-area').screenshot({ path: testInfo.outputPath(`send-alignment-${scenario.name}.png`) })
    await composer.fill('')
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
    const watchesBeforeF5 = await page.evaluate(() => window.compactChatFixture.calls.watch)
    await page.keyboard.press('F5')
    await expect.poll(() => page.evaluate(() => window.compactChatFixture.calls.watch)).toBe(watchesBeforeF5 + 1)
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
