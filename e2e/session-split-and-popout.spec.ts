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
  test(`supports right-click VS Code context menu, left/right & top/bottom split, Split & Move, and 4-way drag-to-split in ${theme} mode`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width: 1520, height: 920 }, deviceScaleFactor: 2 })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.goto(`${url}?workbench&panes&sessions&theme=${theme}`)
      await page.evaluate(async () => { await document.fonts.ready })

      await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
      const sidebar = page.getByRole('complementary', { name: 'Agent Host sessions', exact: true })
      const tree = sidebar.getByRole('tree', { name: 'Sessions for T-0002' })
      await expect(tree.getByRole('treeitem')).toHaveCount(4)

      // Hide right Task Details panel so split chat panes have generous space.
      await page.getByRole('button', { name: 'Toggle task details', exact: true }).click()

      const primaryInitialComposer = page.getByRole('textbox', { name: 'Message Agent Host' })
      await primaryInitialComposer.fill('Draft on release plan')

      // Right-click a session row in the sidebar -> verify VS Code context menu & Split & Move submenu!
      const secondRow = tree.getByRole('treeitem', { name: 'Investigate session creation', exact: true }).locator('.session-tree-row')
      await secondRow.click({ button: 'right' })
      const menu = page.getByRole('menu', { name: 'Session view actions', exact: true })
      await expect(menu).toBeVisible()
      for (const label of ['Split Right', 'Split Down', 'Split & Move', 'Move into New Window', 'Copy into New Window']) {
        await expect(menu.getByRole('menuitem', { name: new RegExp(`^${label}`) })).toBeVisible()
      }
      await menu.getByRole('menuitem', { name: /^Split & Move/ }).hover()
      const submenu = page.getByRole('menu', { name: 'Split and Move', exact: true })
      await expect(submenu).toBeVisible()
      for (const dir of ['Split Up', 'Split Down', 'Split Left', 'Split Right']) {
        await expect(submenu.getByRole('menuitem', { name: dir, exact: true })).toBeVisible()
      }
      await page.screenshot({
        path: testInfo.outputPath(`session-context-menu-${theme}.png`),
        animations: 'disabled',
      })

      // Click "Split Right" in the submenu to open side-by-side horizontal split.
      await submenu.getByRole('menuitem', { name: 'Split Right', exact: true }).click()
      await expect(menu).toHaveCount(0)

      const firstPane = page.getByRole('complementary', { name: 'Agent Host task chat', exact: true })
      const secondPane = page.getByRole('complementary', { name: 'Secondary split Agent Host task chat', exact: true })
      const sash = page.getByRole('separator', { name: 'Resize split chat panes', exact: true })
      await expect(firstPane).toBeVisible()
      await expect(secondPane).toBeVisible()
      await expect(sash).toHaveAttribute('aria-orientation', 'vertical')
      await expect(firstPane.getByLabel('Chat header')).toContainText('A focused release plan')
      await expect(secondPane.getByLabel('Chat header')).toContainText('Investigate session creation')
      await expect(secondPane).toHaveAttribute('data-pane-focused', 'true')

      await secondPane.getByRole('textbox', { name: 'Message Agent Host' }).fill('Draft on session creation')
      await page.mouse.move(1, 1)
      await page.screenshot({
        path: testInfo.outputPath(`session-split-${theme}.png`),
        animations: 'disabled',
      })

      // Right-click the second pane's Chat header -> choose Split & Move -> Split Up (vertical top/bottom split!).
      await secondPane.getByLabel('Chat header').click({ button: 'right' })
      const headerMenu = page.getByRole('menu', { name: 'Session view actions', exact: true })
      await headerMenu.getByRole('menuitem', { name: /^Split & Move/ }).hover()
      await page.getByRole('menu', { name: 'Split and Move', exact: true }).getByRole('menuitem', { name: 'Split Up', exact: true }).click()

      // Verify top/bottom vertical split geometry AND zero-remount draft preservation!
      await expect(page.locator('.chat-workspace')).toHaveAttribute('data-split-orientation', 'vertical')
      await expect(sash).toHaveAttribute('aria-orientation', 'horizontal')
      await expect(firstPane.getByLabel('Chat header')).toContainText('Investigate session creation')
      await expect(secondPane.getByLabel('Chat header')).toContainText('A focused release plan')
      await expect(firstPane.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Draft on session creation')
      await expect(secondPane.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Draft on release plan')
      const topBox = (await firstPane.boundingBox())!
      const bottomBox = (await secondPane.boundingBox())!
      expect(bottomBox.y).toBeGreaterThanOrEqual(topBox.y + topBox.height - 2)

      await page.mouse.move(1, 1)
      await page.screenshot({
        path: testInfo.outputPath(`session-split-vertical-${theme}.png`),
        animations: 'disabled',
      })

      // Resize vertical sash via ArrowDown and reset via Enter.
      await sash.focus()
      await page.keyboard.press('ArrowDown')
      await expect(sash).toHaveAttribute('aria-valuenow', '54')
      await page.keyboard.press('Enter')
      await expect(sash).toHaveAttribute('aria-valuenow', '50')

      // Close split with Ctrl+Shift+\, then drag a session to the bottom edge for 4-way drag-to-split ("Split Down")!
      await page.keyboard.press('Control+Shift+\\')
      await expect(secondPane).toHaveCount(0)

      const fourthRow = tree.getByRole('treeitem', { name: 'Verify the next release', exact: true }).locator('.session-tree-row')
      const workspaceBox = (await page.locator('.chat-workspace').boundingBox())!
      const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
      await fourthRow.dispatchEvent('dragstart', { dataTransfer })
      await page.locator('.chat-workspace').dispatchEvent('dragover', {
        dataTransfer,
        clientX: workspaceBox.x + workspaceBox.width * 0.5,
        clientY: workspaceBox.y + workspaceBox.height * 0.9,
      })
      await expect(page.locator('.chat-drop-overlay[data-zone="down"]')).toContainText('Split Down')
      await page.locator('.chat-workspace').dispatchEvent('drop', {
        dataTransfer,
        clientX: workspaceBox.x + workspaceBox.width * 0.5,
        clientY: workspaceBox.y + workspaceBox.height * 0.9,
      })
      await fourthRow.dispatchEvent('dragend', { dataTransfer })
      await expect(secondPane).toBeVisible()
      await expect(page.locator('.chat-workspace')).toHaveAttribute('data-split-orientation', 'vertical')
      await expect(secondPane.getByLabel('Chat header')).toContainText('Verify the next release')

      expect(errors).toEqual([])
    } finally {
      await context.close()
    }
  })
}

test('pops out an Agent Host session into a standalone Electron window and docks back with draft preserved', async ({ browserName }, testInfo) => {
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
  await mkdir(discovery)
  await mkdir(profile)
  await writeFile(join(workspace, '.agentdesk/config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Popout Workspace' }))
  await writeFile(join(workspace, 'tasks/T-0001-popout/task.json'), JSON.stringify({
    schemaVersion: '1.0', id: 'T-0001', title: 'Multi-window session workflow',
    type: 'feature', status: 'in-progress', priority: 'P1', relations: { level: 'task', parent: null },
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

    // First test "Copy into New Window" via right-click context menu: both main and standalone windows remain live!
    const mainComposer = mainPage.getByRole('textbox', { name: 'Message Agent Host' })
    await mainComposer.fill('Carry this draft into the standalone window')

    const copyWindowPromise = app.waitForEvent('window')
    await mainPage.getByLabel('Chat header').click({ button: 'right' })
    await mainPage.getByRole('menu', { name: 'Session view actions', exact: true })
      .getByRole('menuitem', { name: /^Copy into New Window/ }).click()
    const copyPage = await copyWindowPromise
    copyPage.on('pageerror', (error) => errors.push(error.message))
    await expect(copyPage.locator('.session-window')).toBeVisible()
    await expect(copyPage.getByLabel('Chat header').getByText('Connected', { exact: true })).toBeVisible()
    // Main window ALSO keeps its live composer visible in 'copy' mode!
    await expect(mainComposer).toBeVisible()
    await expect(mainComposer).toHaveValue('Carry this draft into the standalone window')
    const copyClosed = copyPage.waitForEvent('close')
    await copyPage.getByRole('button', { name: 'Close window', exact: true }).click()
    await copyClosed

    // Now test "Move into New Window" via right-click context menu -> moves out of main and carries draft!
    const popoutPromise = app.waitForEvent('window')
    await mainPage.getByLabel('Chat header').click({ button: 'right' })
    await mainPage.getByRole('menu', { name: 'Session view actions', exact: true })
      .getByRole('menuitem', { name: 'Move into New Window', exact: true }).click()
    const popoutPage = await popoutPromise
    popoutPage.on('pageerror', (error) => errors.push(error.message))

    // Verify standalone session window UI, task badge, live connection, and carried draft.
    await expect(popoutPage.locator('.session-window')).toBeVisible()
    await expect(popoutPage.locator('.session-window-task-pill')).toHaveText('T-0001')
    await expect(popoutPage.getByLabel('Chat header').getByText('Connected', { exact: true })).toBeVisible()
    const popoutComposer = popoutPage.getByRole('textbox', { name: 'Message Agent Host' })
    await expect(popoutComposer).toHaveValue('Carry this draft into the standalone window')

    // Verify main window shows the Popped-out placeholder card and sidebar "Window" badge.
    await expect(mainPage.getByRole('heading', { level: 2, name: 'Open in separate window' })).toBeVisible()
    await expect(mainPage.locator('.statusbar')).toContainText('1 window')
    await expect(picker.locator('.session-state-pill')).toContainText('Window')

    await popoutPage.screenshot({ path: testInfo.outputPath('session-popout-window-light.png'), animations: 'disabled' })
    await mainPage.screenshot({ path: testInfo.outputPath('session-popout-main-light.png'), animations: 'disabled' })

    // Edit draft inside the standalone window and click Dock to return to the main window.
    await popoutComposer.fill('Carry this draft into the standalone window — and back to main!')
    const closedPromise = popoutPage.waitForEvent('close')
    await popoutPage.getByRole('button', { name: 'Dock session to main window', exact: true }).click()
    await closedPromise

    // Main window immediately restores the live AgentHostPanel with the updated draft!
    await expect(mainPage.getByRole('heading', { level: 2, name: 'Open in separate window' })).toHaveCount(0)
    await expect(mainPage.getByRole('textbox', { name: 'Message Agent Host' }))
      .toHaveValue('Carry this draft into the standalone window — and back to main!')
    expect(errors).toEqual([])
  } finally {
    await app?.close()
    await fixture.close()
    await rm(root, { recursive: true, force: true })
  }
})
