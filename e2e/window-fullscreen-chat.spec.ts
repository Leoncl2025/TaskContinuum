import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

test('keeps a long conversation responsive through fullscreen and resize without losing the draft or connection', async () => {
  test.setTimeout(120000)
  const root = await mkdtemp(join(tmpdir(), 'continuum-fullscreen-chat-'))
  const workspace = join(root, 'workspace')
  const discovery = join(root, 'discovery')
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  for (const key of Object.keys(environment)) if (/^(ELECTRON_|TASKCONTINUUM_)/.test(key)) delete environment[key]
  Object.assign(environment, {
    TASKCONTINUUM_DATA_DIR: join(root, 'profile'), TASKCONTINUUM_WORKSPACE: workspace,
    TASKCONTINUUM_AGENT_HOST_DISCOVERY: discovery,
  })
  let app: ElectronApplication | undefined
  const errors: string[] = []
  try {
    await Promise.all([join(workspace, '.agentdesk'), join(workspace, 'tasks', 'T-0001'), discovery].map((path) => mkdir(path, { recursive: true })))
    await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Fullscreen chat' }))
    await writeFile(join(workspace, 'tasks', 'T-0001', 'task.json'), JSON.stringify({
      schemaVersion: '1.0', id: 'T-0001', title: 'Keep the conversation responsive', type: 'feature',
      status: 'backlog', priority: 'P2', relations: { level: 'task', parent: null },
    }))
    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('heading', { name: 'Keep the conversation responsive', exact: true })).toBeVisible()
    await app.evaluate(({ ipcMain }, count) => {
      const owner = { clientId: '01000000-0000-4000-8000-000000000001', machineName: 'Fullscreen fixture' }
      const target = { owner, sessionId: 'copilotcli:/fullscreen', chatId: 'ahp-chat:/fullscreen' }
      const table = '| File | Result | Notes |\n| --- | --- | --- |\n'
        + Array.from({ length: 80 }, (_, index) => `| source-${index}.ts | Passed | The original result remains available when the window changes size. |`).join('\n')
      const turns = Array.from({ length: count }, (_, index) => ({
        id: `turn-${index}`, state: 'complete',
        message: { text: `Original question ${index}`, origin: { kind: 'user' } },
        responseParts: [
          { kind: 'reasoning', id: `reasoning-${index}`, content: `Reasoning for original question ${index}` },
          { kind: 'markdown', id: `answer-${index}`, content: `## Answer ${index}\n\n${table}` },
        ],
      }))
      const view = { target, state: 'connected', protocolVersion: '1.0.0', canSend: true, readOnly: false, terminals: {},
        chat: { resource: target.chatId, title: 'Long original conversation', status: 1, modifiedAt: '', turns } }
      Reflect.set(globalThis, 'fullscreenChatView', view)
      const calls = { watch: 0, unwatch: 0, send: 0 }
      Reflect.set(globalThis, 'fullscreenChatCalls', calls)
      const handlers: Record<string, (...args: unknown[]) => unknown> = {
        'workspace:session-links': () => ({ document: { schemaVersion: '2.1', bindings: { 'T-0001': [{ provider: 'agent-host', ...target }] } }, revision: 'a'.repeat(64) }),
        'agent-host:models': () => [{ id: 'fixture', name: 'Fixture', provider: 'copilotcli' }],
        'agent-host:unwatch': () => { calls.unwatch++ },
        'agent-host:send': () => { calls.send++; throw new Error('Fullscreen must not send a message.') },
      }
      for (const [channel, handler] of Object.entries(handlers)) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, (_event, ...args) => handler(...args))
      }
      ipcMain.removeHandler('agent-host:watch')
      ipcMain.handle('agent-host:watch', (event) => {
        calls.watch++
        const id = `fullscreen-watch-${calls.watch}`
        setTimeout(() => { if (!event.sender.isDestroyed()) event.sender.send('agent-host:view', { id, view }) }, 0)
        return id
      })
    }, 180)
    await page.reload()
    await expect(page.getByRole('status', { name: 'Connected', exact: true })).toBeVisible()
    const panel = page.locator('.ahp-panel')
    const log = panel.locator('.chat-log')
    const draft = panel.locator('#chat-composer')
    const toolbar = page.locator('.titlebar')
    await expect(log.locator('[data-turn-id]')).toHaveCount(180)
    await expect(log.locator('table').last().locator('tr').last()).toBeInViewport()
    await draft.fill('Keep this draft through fullscreen and resize')
    const originalDraft = await draft.elementHandle()
    const originalCalls = await app.evaluate(() => Reflect.get(globalThis, 'fullscreenChatCalls'))
    const client = await page.context().newCDPSession(page)
    await client.send('Performance.enable')
    const measurements: { fullScreen: boolean; elapsedMs: number; layoutMs: number; scriptMs: number }[] = []
    const metrics = async () => Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map((metric) => [metric.name, metric.value]))
    for (const [index, fullScreen] of [true, false, true, false, true, false, true, false].entries()) {
      if (index === 4) {
        await app.evaluate(({ BrowserWindow }) => {
          const view = Reflect.get(globalThis, 'fullscreenChatView')
          view.chat.activeTurn = { id: 'active-turn', message: { text: 'Continue the original conversation', origin: { kind: 'user' } },
            responseParts: [{ kind: 'markdown', id: 'live-answer', content: 'The original reply is still running.' }] }
          BrowserWindow.getAllWindows()[0].webContents.send('agent-host:view', { id: 'fullscreen-watch-1', view })
        })
        await expect(panel.locator('[data-turn-id="active-turn"]')).toContainText('The original reply is still running.')
      }
      const before = await metrics()
      const start = performance.now()
      await toolbar.getByRole('button', { name: fullScreen ? 'Enter full screen' : 'Exit full screen', exact: true }).click()
      // Check the native state without an ARIA snapshot of every historical cell
      // while the enter/leave event is still in flight.
      await page.waitForFunction((fullScreen) => document.querySelector('.window-controls button[aria-pressed]')?.getAttribute('aria-pressed') === String(fullScreen), fullScreen)
      await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(fullScreen)
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      await expect(draft).toHaveValue('Keep this draft through fullscreen and resize')
      const after = await metrics()
      measurements.push({ fullScreen, elapsedMs: performance.now() - start,
        layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000, scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000 })
    }
    for (const width of [1100, 960, 1440]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), width)
      await page.waitForFunction((width) => window.innerWidth === width, width)
      await expect(draft).toHaveValue('Keep this draft through fullscreen and resize')
      await expect(panel.locator('[data-turn-id="active-turn"]')).toBeInViewport()
    }
    const previous = log.locator('[data-turn-id="turn-0"]')
    await previous.scrollIntoViewIfNeeded()
    await expect(previous.getByRole('heading', { name: 'Answer 0', exact: true })).toBeVisible()
    await previous.locator('summary').click()
    await expect(previous.getByText('Reasoning for original question 0', { exact: true })).toBeVisible()
    await log.locator('[data-turn-id="turn-90"]').scrollIntoViewIfNeeded()
    await previous.scrollIntoViewIfNeeded()
    await expect(previous.locator('details')).toHaveAttribute('open')
    await toolbar.getByRole('button', { name: 'Enter full screen', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.window-controls button[aria-pressed]')?.getAttribute('aria-pressed') === 'true')
    await expect(previous).toBeInViewport()
    await expect(panel.locator('[data-turn-id="active-turn"]')).not.toBeInViewport()
    await toolbar.getByRole('button', { name: 'Exit full screen', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.window-controls button[aria-pressed]')?.getAttribute('aria-pressed') === 'false')
    await expect(previous).toBeInViewport()
    await expect(log.locator('[data-turn-id]')).toHaveCount(181)
    expect(await originalDraft!.evaluate((node) => node === document.getElementById('chat-composer'))).toBe(true)
    console.log('Fullscreen chat timings:', JSON.stringify(measurements))
    expect(measurements.every((measurement) => measurement.elapsedMs < 3000)).toBe(true)
    expect(measurements.every((measurement) => measurement.layoutMs < 100)).toBe(true)
    expect(await app.evaluate(() => Reflect.get(globalThis, 'fullscreenChatCalls'))).toEqual(originalCalls)
    expect(originalCalls).toEqual({ watch: 1, unwatch: 0, send: 0 })
    await expect(toolbar.getByRole('status', { name: 'Agent responding', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
})
