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
  test(`splits sessions side by side, resizes sash, swaps panes without losing drafts, and supports drag-to-split in ${theme} mode`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width: 1520, height: 920 }, deviceScaleFactor: 2 })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.goto(`${url}?workbench&panes&sessions&theme=${theme}`)
      await page.evaluate(async () => { await document.fonts.ready })

      // Open Agent Host sessions sidebar so linked sessions and badges are visible alongside the split view.
      await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
      const sidebar = page.getByRole('complementary', { name: 'Agent Host sessions', exact: true })
      const tree = sidebar.getByRole('tree', { name: 'Sessions for T-0002' })
      await expect(tree.getByRole('treeitem')).toHaveCount(4)

      // Hide right Task Details panel so both split chat panes have generous side-by-side space.
      await page.getByRole('button', { name: 'Toggle task details', exact: true }).click()

      const primaryInitialComposer = page.getByRole('textbox', { name: 'Message Agent Host' })
      await primaryInitialComposer.fill('Draft on release plan')

      // Click "Split chat right" in the unified titlebar chat header.
      await page.locator('.titlebar').getByRole('button', { name: 'Split chat right', exact: true }).click()

      const leftPane = page.getByRole('complementary', { name: 'Agent Host task chat', exact: true })
      const rightPane = page.getByRole('complementary', { name: 'Secondary split Agent Host task chat', exact: true })
      const sash = page.getByRole('separator', { name: 'Resize split chat panes', exact: true })
      await expect(leftPane).toBeVisible()
      await expect(rightPane).toBeVisible()
      await expect(sash).toBeVisible()

      await expect(leftPane.getByLabel('Chat header')).toContainText('A focused release plan')
      await expect(rightPane.getByLabel('Chat header')).toContainText('Investigate session creation')
      await expect(rightPane).toHaveAttribute('data-pane-focused', 'true')
      await expect(tree.locator('.session-state-pill')).toContainText('Split')

      // Type a distinct draft in the right split pane and capture 2x preview screenshot.
      await rightPane.getByRole('textbox', { name: 'Message Agent Host' }).fill('Draft on session creation')
      await page.mouse.move(1, 1)
      await page.screenshot({
        path: testInfo.outputPath(`session-split-${theme}.png`),
        animations: 'disabled',
      })

      // Swap split panes: zero remount -> both drafts swap sides intact!
      await rightPane.getByRole('button', { name: 'Swap split panes', exact: true }).click()
      await expect(leftPane.getByLabel('Chat header')).toContainText('Investigate session creation')
      await expect(rightPane.getByLabel('Chat header')).toContainText('A focused release plan')
      await expect(leftPane.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Draft on session creation')
      await expect(rightPane.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Draft on release plan')

      // Resize sash via keyboard and reset via Enter.
      await sash.focus()
      await page.keyboard.press('ArrowRight')
      await expect(sash).toHaveAttribute('aria-valuenow', '54')
      await page.keyboard.press('Enter')
      await expect(sash).toHaveAttribute('aria-valuenow', '50')

      // Ctrl+\ switches focus between primary and secondary; Ctrl+Shift+\ closes split while preserving primary draft.
      await expect(rightPane).toHaveAttribute('data-pane-focused', 'true')
      await page.keyboard.press('Control+\\')
      await expect(leftPane).toHaveAttribute('data-pane-focused', 'true')
      await page.keyboard.press('Control+Shift+\\')
      await expect(rightPane).toHaveCount(0)
      await expect(leftPane.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Draft on session creation')

      // Drag a session from the sidebar onto the right half of .chat-workspace to re-open Split View.
      const fourthRow = tree.getByRole('treeitem', { name: 'Verify the next release', exact: true }).locator('.session-tree-row')
      const workspaceBox = (await page.locator('.chat-workspace').boundingBox())!
      const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
      await fourthRow.dispatchEvent('dragstart', { dataTransfer })
      await page.locator('.chat-workspace').dispatchEvent('dragover', {
        dataTransfer,
        clientX: workspaceBox.x + workspaceBox.width * 0.8,
        clientY: workspaceBox.y + workspaceBox.height * 0.4,
      })
      await expect(page.locator('.chat-drop-overlay[data-zone="secondary"]')).toContainText('Split right')
      await page.locator('.chat-workspace').dispatchEvent('drop', {
        dataTransfer,
        clientX: workspaceBox.x + workspaceBox.width * 0.8,
        clientY: workspaceBox.y + workspaceBox.height * 0.4,
      })
      await fourthRow.dispatchEvent('dragend', { dataTransfer })
      await expect(rightPane).toBeVisible()
      await expect(rightPane.getByLabel('Chat header')).toContainText('Verify the next release')

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

    // Type an unsent draft in the main window, then pop the session out into a standalone window.
    const mainComposer = mainPage.getByRole('textbox', { name: 'Message Agent Host' })
    await mainComposer.fill('Carry this draft into the standalone window')

    const popoutPromise = app.waitForEvent('window')
    await mainPage.locator('.titlebar').getByRole('button', { name: 'Open session in new window', exact: true }).click()
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
