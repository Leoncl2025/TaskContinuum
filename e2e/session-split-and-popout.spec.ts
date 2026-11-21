import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import type { ViteDevServer } from 'vite'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { startAgentHostFixture } from '../test/agent-host-fixture'
import { enableAutomaticLinks, prepareAutomaticLinksRepository } from './immutable-workspace-fixture'

let server: ViteDevServer
let url: string
test.beforeAll(async () => {
  server = await createServer({ configFile: false, root: resolve('.'), plugins: [react()], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('No loopback fixture port.')
  url = `http://127.0.0.1:${address.port}/e2e/fixtures/compact-chat.html`
})
test.afterAll(async () => { await server?.close() })

for (const theme of ['light', 'dark'] as const) {
  test(`supports Task-Page clone split with duplicate sessions, focus-driven sidebar sync, recursive nested splits, and cross-pane Task Page drag in ${theme} mode`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width: 1560, height: 940 }, deviceScaleFactor: 2 })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.goto(`${url}?workbench&panes&sessions&theme=${theme}`)
      await page.evaluate(async () => { await document.fonts.ready })

      // Open the second task (T-0003) as a second Task Page tab, then switch back to T-0002.
      await page.getByRole('button', { name: 'Search tasks and jump back in', exact: true }).click()
      await page.getByRole('dialog', { name: 'Quick open' }).getByRole('button', { name: /Sept-2026 planning/ }).click()
      await page.getByRole('tablist', { name: 'Open tasks' }).getByRole('tab', { name: 'Fix Connection issues', exact: true }).click()

      // Switch left sidebar to Agent Host sessions and hide right Task Details so split panes have generous space.
      await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
      const sidebar = page.getByRole('complementary', { name: 'Agent Host sessions', exact: true })
      await expect(sidebar.getByRole('tree', { name: 'Sessions for T-0002' }).getByRole('treeitem')).toHaveCount(4)
      await page.getByRole('button', { name: 'Toggle task details', exact: true }).click()

      const initialComposer = page.getByRole('textbox', { name: 'Message Agent Host' })
      await initialComposer.fill('Draft preserved in Pane 1')

      // Right-click the Task Page tab -> verify VS Code context menu & Split Right (clones Task Page + same session!).
      const firstTab = page.getByRole('tablist', { name: 'Open tasks' }).getByRole('tab', { name: 'Fix Connection issues', exact: true })
      await firstTab.click({ button: 'right' })
      const menu = page.getByRole('menu', { name: 'Session view actions', exact: true })
      await expect(menu).toBeVisible()
      for (const label of ['Split Right', 'Split Down', 'Split Up', 'Split Left', 'Split & Move', 'Move into New Window', 'Copy into New Window']) {
        await expect(menu.getByRole('menuitem', { name: new RegExp(`^${label}`) })).toBeVisible()
      }
      await page.screenshot({
        path: testInfo.outputPath(`task-page-context-menu-${theme}.png`),
        animations: 'disabled',
      })
      await menu.getByRole('menuitem', { name: /^Split Right/ }).click()

      const pane1 = page.getByRole('region', { name: 'Screen pane 1', exact: true })
      const pane2 = page.getByRole('region', { name: 'Screen pane 2', exact: true })
      await expect(pane1).toBeVisible()
      await expect(pane2).toBeVisible()
      await expect(pane2).toHaveAttribute('data-pane-focused', 'true')

      // Original Pane 1 stays in its original position with its tabs + draft; Pane 2 clones the Task Page with the SAME session!
      await expect(pane1.getByRole('tablist').getByRole('tab')).toHaveText([
        'Fix Connection issues',
        'Sept-2026 planning and release coordination',
      ])
      await expect(pane2.getByRole('tablist').getByRole('tab')).toHaveText(['Fix Connection issues'])
      await expect(pane1.getByLabel('Chat header')).toContainText('A focused release plan')
      await expect(pane2.getByLabel('Chat header')).toContainText('A focused release plan')
      await expect(pane1.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Draft preserved in Pane 1')

      // Focusing a different Task Page in Pane 1 switches the left Agent Host sessions sidebar automatically!
      await pane1.getByRole('tablist').getByRole('tab', { name: 'Sept-2026 planning and release coordination', exact: true }).click()
      await expect(pane1).toHaveAttribute('data-pane-focused', 'true')
      await expect(sidebar).toContainText('T-0003')
      await expect(sidebar.getByRole('tree', { name: 'Sessions for T-0002' })).toHaveCount(0)

      // Focusing Pane 2 (T-0002) switches the left Agent Host sessions sidebar right back to T-0002!
      await pane2.getByLabel('Chat header').click()
      await expect(pane2).toHaveAttribute('data-pane-focused', 'true')
      await expect(sidebar.getByRole('tree', { name: 'Sessions for T-0002' })).toBeVisible()

      // Switch Pane 1 back to T-0002 so both Pane 1 & Pane 2 display the exact same session, then nested-split Pane 2 DOWN!
      await pane1.getByRole('tablist').getByRole('tab', { name: 'Fix Connection issues', exact: true }).click()
      await pane2.getByLabel('Chat header').click({ button: 'right' })
      await page.getByRole('menu', { name: 'Session view actions', exact: true })
        .getByRole('menuitem', { name: /^Split Down/ }).click()

      // Now we have a 3-pane nested layout: Left = Pane 1, Right-Top = Pane 2, Right-Bottom = Pane 3!
      const pane3 = page.getByRole('region', { name: 'Screen pane 3', exact: true })
      await expect(pane3).toBeVisible()
      await expect(pane3).toHaveAttribute('data-pane-focused', 'true')

      // Select a different concrete session in Pane 3 via the left sidebar while Pane 1 & Pane 2 keep "A focused release plan"!
      await sidebar.getByRole('tree', { name: 'Sessions for T-0002' })
        .getByRole('treeitem', { name: 'Investigate session creation', exact: true })
        .locator('.session-tree-row').click()
      await expect(pane1.getByLabel('Chat header')).toContainText('A focused release plan')
      await expect(pane2.getByLabel('Chat header')).toContainText('A focused release plan')
      await expect(pane3.getByLabel('Chat header')).toContainText('Investigate session creation')

      // Verify nested Left/Right + child Top/Bottom geometry!
      const box1 = (await pane1.boundingBox())!
      const box2 = (await pane2.boundingBox())!
      const box3 = (await pane3.boundingBox())!
      expect(box2.x).toBeGreaterThanOrEqual(box1.x + box1.width - 2)
      expect(box3.x).toBeGreaterThanOrEqual(box1.x + box1.width - 2)
      expect(box3.y).toBeGreaterThanOrEqual(box2.y + box2.height - 2)

      await page.mouse.move(1, 1)
      await page.screenshot({
        path: testInfo.outputPath(`task-page-nested-split-${theme}.png`),
        animations: 'disabled',
      })

      // Drag the T-0003 Task Page tab from Pane 1's tab bar into Pane 3's tab bar!
      const sourceTab = pane1.locator('.editor-tab[data-task-id="T-0003"]')
      const targetTabBar = pane3.getByRole('tablist')
      const targetBox = (await targetTabBar.boundingBox())!
      const dt = await page.evaluateHandle(() => new DataTransfer())
      await sourceTab.dispatchEvent('dragstart', { dataTransfer: dt })
      await targetTabBar.dispatchEvent('dragover', {
        dataTransfer: dt,
        clientX: targetBox.x + targetBox.width - 12,
        clientY: targetBox.y + targetBox.height / 2,
      })
      await targetTabBar.dispatchEvent('drop', {
        dataTransfer: dt,
        clientX: targetBox.x + targetBox.width - 12,
        clientY: targetBox.y + targetBox.height / 2,
      })

      // T-0003 moved out of Pane 1 and into Pane 3!
      await expect(pane1.getByRole('tablist').getByRole('tab')).toHaveText(['Fix Connection issues'])
      await expect(pane3.getByRole('tablist').getByRole('tab')).toHaveText([
        'Fix Connection issues',
        'Sept-2026 planning and release coordination',
      ])
      await expect(pane3).toHaveAttribute('data-pane-focused', 'true')
      await expect(sidebar).toContainText('T-0003')

      // Focus Pane 1 (T-0002) and right-click a session in the left sidebar -> Rename Session...
      await pane1.getByLabel('Chat header').click()
      const targetSessionRow = sidebar.getByRole('tree', { name: 'Sessions for T-0002' })
        .getByRole('treeitem', { name: 'A focused release plan', exact: true })
        .locator('.session-tree-row')
      await targetSessionRow.click({ button: 'right' })
      const renameMenu = page.getByRole('menu', { name: 'Session view actions', exact: true })
      await expect(renameMenu.getByRole('menuitem', { name: /^Rename Session/ })).toBeVisible()
      await renameMenu.getByRole('menuitem', { name: /^Rename Session/ }).click()

      const renameInput = sidebar.getByRole('textbox', { name: 'Session name', exact: true })
      await expect(renameInput).toBeFocused()
      await expect(renameInput).toHaveValue('A focused release plan')
      await page.screenshot({
        path: testInfo.outputPath(`session-rename-inline-${theme}.png`),
        animations: 'disabled',
      })
      await renameInput.fill('测试新session · 线上排障')
      await renameInput.press('Enter')

      // Both the left sidebar row AND BOTH split panes (Pane 1 & Pane 2) immediately reflect the renamed session!
      await expect(sidebar.getByRole('tree', { name: 'Sessions for T-0002' })
        .getByRole('treeitem', { name: '测试新session · 线上排障', exact: true })).toBeVisible()
      await expect(pane1.getByLabel('Chat header')).toContainText('测试新session · 线上排障')
      await expect(pane2.getByLabel('Chat header')).toContainText('测试新session · 线上排障')

      // Right-click -> Reset Session Name restores the original Host title!
      await sidebar.getByRole('tree', { name: 'Sessions for T-0002' })
        .getByRole('treeitem', { name: '测试新session · 线上排障', exact: true })
        .locator('.session-tree-row')
        .click({ button: 'right' })
      await page.getByRole('menu', { name: 'Session view actions', exact: true })
        .getByRole('menuitem', { name: 'Reset Session Name', exact: true }).click()
      await expect(pane1.getByLabel('Chat header')).toContainText('A focused release plan')

      expect(errors).toEqual([])
    } finally {
      await context.close()
    }
  })
}

test('opens a sidebar-less Task-Page Popup Window, supports nested splits and Task Page drag inside the popup, and docks back', async ({ browserName }, testInfo) => {
  void browserName
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'continuum-popout-desktop-'))
  const workspace = join(root, 'tasks')
  const discovery = join(root, 'discovery')
  const profile = join(root, 'profile')
  const fixture = await startAgentHostFixture()
  let app: ElectronApplication | undefined
  const errors: string[] = []

  await mkdir(join(workspace, '.agentdesk'), { recursive: true })
  await mkdir(join(workspace, 'tasks', 'T-0001-popout'), { recursive: true })
  await mkdir(join(workspace, 'tasks', 'T-0002-companion'), { recursive: true })
  await mkdir(discovery)
  await mkdir(profile)
  await writeFile(join(workspace, '.agentdesk/config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Popout Workspace' }))
  await writeFile(join(workspace, 'tasks/T-0001-popout/task.json'), JSON.stringify({
    schemaVersion: '1.0', id: 'T-0001', title: 'Multi-window session workflow',
    type: 'feature', status: 'in-progress', priority: 'P1', relations: { level: 'task', parent: null },
  }))
  await writeFile(join(workspace, 'tasks/T-0002-companion/task.json'), JSON.stringify({
    schemaVersion: '1.0', id: 'T-0002', title: 'Nested popup companion task',
    type: 'feature', status: 'in-progress', priority: 'P2', relations: { level: 'task', parent: null },
  }))
  await writeFile(join(discovery, 'host.json'), JSON.stringify(fixture.endpoint))

  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_RENDERER_URL
  environment.TASKCONTINUUM_WORKSPACE = workspace
  environment.TASKCONTINUUM_DATA_DIR = profile
  environment.TASKCONTINUUM_AGENT_HOST_DISCOVERY = discovery
  environment.TASKCONTINUUM_VSCODE_USER_DATA_DIR = join(root, 'no-legacy-sessions')

  try {
    const enrolled = await prepareAutomaticLinksRepository(workspace, join(root, 'immutable-fixture'))
    Object.assign(environment, enrolled.environment)

    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
    const mainPage: Page = await app.firstWindow()
    mainPage.on('pageerror', (error) => errors.push(error.message))
    await expect(mainPage.getByRole('heading', { level: 1, name: 'Multi-window session workflow' })).toBeVisible()
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await enableAutomaticLinks(app, mainPage, profile)
    await expect.poll(() => mainPage.evaluate(async () => (await window.remoteVSCode!.gitSync!.status()).state), { timeout: 25_000 }).toBe('idle')

    // Link the live AHP session to T-0001.
    await mainPage.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    const picker = mainPage.getByRole('complementary', { name: 'Agent Host sessions' })
    await picker.getByRole('tab', { name: 'Link', exact: true }).click()
    await expect(picker.getByRole('region', { name: 'Host session Original Host chat' })).toBeVisible()
    await picker.getByRole('button', { name: 'Link Original Host chat to T-0001' }).click()
    await expect(picker.getByRole('tab', { name: 'Current' })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(async () => {
      const header = mainPage.getByLabel('Chat header')
      if (await header.getByText('Connected', { exact: true }).isVisible()) return 'connected'
      const syncState = await mainPage.evaluate(async () => (await window.remoteVSCode!.gitSync!.status()).state)
      if (syncState === 'idle' && await header.getByText('Connection failed', { exact: true }).isVisible()) {
        await mainPage.keyboard.press('F5')
      }
      return syncState
    }, { timeout: 25_000 }).toBe('connected')

    const mainComposer = mainPage.getByRole('textbox', { name: 'Message Agent Host' })
    await mainComposer.fill('Main window stays live alongside popup')

    // Open Popup Window via "Copy into New Window": BOTH Main Window and Popup Window run the same session simultaneously!
    const popoutPromise = app.waitForEvent('window')
    await mainPage.getByLabel('Chat header').click({ button: 'right' })
    await mainPage.getByRole('menu', { name: 'Session view actions', exact: true })
      .getByRole('menuitem', { name: /^Copy into New Window/ }).click()
    const popoutPage = await popoutPromise
    popoutPage.on('pageerror', (error) => errors.push(error.message))
    await popoutPage.setViewportSize({ width: 1180, height: 780 })

    // Verify Popup Window is Task-Page based and has NO left sidebar!
    await expect(popoutPage.locator('.session-window')).toBeVisible()
    await expect(popoutPage.locator('.activity-bar')).toHaveCount(0)
    await expect(popoutPage.locator('.sidebar')).toHaveCount(0)
    await expect(popoutPage.getByRole('tablist', { name: 'Open tasks' }).getByRole('tab', { name: 'Multi-window session workflow', exact: true })).toBeVisible()
    await expect(popoutPage.getByLabel('Chat header').getByText('Connected', { exact: true })).toBeVisible()
    await expect(mainComposer).toHaveValue('Main window stays live alongside popup')

    // Perform recursive nested splits INSIDE the Popup Window: Split Right, then Split Down on Pane 2!
    await popoutPage.keyboard.press('Control+\\')
    const popPane1 = popoutPage.getByRole('region', { name: 'Screen pane 1', exact: true })
    const popPane2 = popoutPage.getByRole('region', { name: 'Screen pane 2', exact: true })
    await expect(popPane1).toBeVisible()
    await expect(popPane2).toBeVisible()

    // Both panes in the Popup Window show the cloned Task Page and live session!
    await expect(popPane1.getByLabel('Chat header').getByText('Connected', { exact: true })).toBeVisible()
    await expect(popPane2.getByLabel('Chat header').getByText('Connected', { exact: true })).toBeVisible()

    // Nested vertical split inside Popup Pane 2 (Right-click -> Split Down)!
    await popPane2.getByLabel('Chat header').click({ button: 'right' })
    await popoutPage.getByRole('menu', { name: 'Session view actions', exact: true })
      .getByRole('menuitem', { name: /^Split Down/ }).click()
    const popPane3 = popoutPage.getByRole('region', { name: 'Screen pane 3', exact: true })
    await expect(popPane3).toBeVisible()

    // Open T-0002 into Popup Pane 3 via the "+" Open task page button!
    await popPane3.getByRole('button', { name: 'Open task page', exact: true }).click()
    await popoutPage.getByRole('menu', { name: 'Open task page', exact: true })
      .getByRole('menuitem', { name: /Nested popup companion task/ }).click()
    await expect(popPane3.getByRole('tablist').getByRole('tab')).toHaveText([
      'Multi-window session workflow',
      'Nested popup companion task',
    ])

    await popoutPage.screenshot({ path: testInfo.outputPath('popup-window-nested-split.png'), animations: 'disabled' })

    // Switch back to T-0001 in Popup Pane 1, enter a draft, and Dock back to Main Window!
    await popPane1.getByRole('textbox', { name: 'Message Agent Host' }).fill('Docked from nested popup window!')
    const closedPromise = popoutPage.waitForEvent('close')
    await popoutPage.getByRole('button', { name: 'Dock session to main window', exact: true }).click()
    await closedPromise

    // Both T-0001 and T-0002 Task Pages (plus the updated draft!) are docked into the Main Window!
    await expect(mainPage.getByRole('tablist', { name: 'Open tasks' }).getByRole('tab')).toHaveText([
      'Multi-window session workflow',
      'Nested popup companion task',
    ])
    await expect(mainPage.getByRole('textbox', { name: 'Message Agent Host' }))
      .toHaveValue('Docked from nested popup window!')
    expect(errors).toEqual([])
  } finally {
    await app?.close()
    await fixture.close()
    await rm(root, { recursive: true, force: true })
  }
})

