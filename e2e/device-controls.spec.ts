import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('trusted automatic device links need no pairing or permission grants and ignore inert legacy bindings', async () => {
  await mkdir(resolve('artifacts'), { recursive: true })
  const root = await mkdtemp(join(resolve('artifacts'), 'continuum-device-ui-'))
  const tasks = join(root, 'tasks-root')
  const task = join(tasks, 'tasks', 'T-0001-original')
  await mkdir(task, { recursive: true })
  await mkdir(join(tasks, '.agentdesk'), { recursive: true })
  await writeFile(join(tasks, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Device UI fixture' }))
  const taskFile = join(task, 'task.json')
  const taskText = JSON.stringify({ schemaVersion: '1.0', id: 'T-0001', title: 'Device UI task', type: 'feature', status: 'backlog', priority: 'P2', relations: { level: 'task' } })
  await writeFile(taskFile, taskText)
  const legacyFile = join(tasks, '.taskcontinuum', 'session-bindings.json')
  const legacyBindings = JSON.stringify({ schemaVersion: 1, bindings: { 'T-0001': {
    provider: 'vscode-copilot', sessionId: 'original', workspaceStorageId: 'a'.repeat(32),
    owner: { clientId: '00000000-0000-4000-8000-000000000003', machineName: 'Machine-B' },
  } } }, null, 2) + '\n'
  await mkdir(join(tasks, '.taskcontinuum'))
  await writeFile(legacyFile, legacyBindings)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  env.TASKCONTINUUM_DATA_DIR = join(root, 'profile')
  env.TASKCONTINUUM_WORKSPACE = tasks
  env.TASKCONTINUUM_VSCODE_USER_DATA_DIR = join(root, 'empty-code')
  const app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('heading', { level: 1, name: 'Device UI task' })).toBeVisible()
    await app.evaluate(({ ipcMain, app }) => {
      let connected = true
      let signedIn = false
      let published = false
      let automatic = true
      let revoked = false
      const actions: string[] = []
      Reflect.set(app, 'deviceUiActions', actions)
      const handlers: Record<string, (...args: unknown[]) => unknown> = {
        'remote-vscode:tunnel-status': () => ({ installed: true, ...(signedIn ? { account: 'test@example.test' } : {}), state: published ? 'hosting' : 'idle' }),
        'remote-vscode:tunnel-login': () => { signedIn = true },
        'remote-vscode:tunnel-publish': () => { if (!signedIn) throw new Error('Sign in before publishing.'); published = true },
        'remote-vscode:tunnel-stop': () => { published = false },
        'remote-vscode:devices': () => [{ id: 'device-b', machineName: 'Machine-B', state: connected ? 'connected' : 'offline', enabled: connected, expiresAt: '2099-01-01T00:00:00Z' }],
        'remote-vscode:device-connect': (id) => { if (id !== 'device-b' || revoked || !automatic) throw new Error('Device unavailable'); connected = true },
        'remote-vscode:device-disconnect': (id) => { if (id !== 'device-b') throw new Error('Incorrect device'); connected = false },
        'remote-vscode:git-status': () => ({
          enabled: automatic, state: automatic ? 'idle' : 'disabled', intervalMs: 15000, pending: 0,
          provisionalTasks: [], conflicts: [], revision: null,
          peers: [{ deviceId: 'device-b', machineName: 'Machine-B', state: revoked ? 'blocked' : automatic ? 'linked' : 'offline' }],
        }),
        'remote-vscode:git-revoke': (id) => { if (id !== 'device-b') throw new Error('Incorrect peer'); revoked = true; connected = false },
        'remote-vscode:git-disable': () => { automatic = false; connected = false },
        'agent-host:send': () => { throw new Error('Requests must not be sent by device controls.') },
        'agent-host:create': () => { throw new Error('Sessions must not be created by device controls.') },
      }
      for (const [name, handler] of Object.entries(handlers)) {
        ipcMain.removeHandler(name)
        ipcMain.handle(name, (_event, ...args) => {
          if (!['remote-vscode:tunnel-status', 'remote-vscode:devices', 'remote-vscode:git-status'].includes(name)) actions.push(name)
          return handler(...args)
        })
      }
    })
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Device UI task' })).toBeVisible()
    const surface = await page.evaluate(() => ({
      retiredBridges: ['copilot', 'vscodeChat', 'sharedSessions'].filter((name) => Reflect.has(window, name)),
      remote: Object.keys(window.remoteVSCode ?? {}).sort(),
      devices: Object.keys(window.remoteVSCode?.devices ?? {}).sort(),
    }))
    expect(surface).toEqual({ retiredBridges: [], remote: ['devTunnels', 'devices', 'gitSync'], devices: ['connect', 'disconnect', 'forget', 'list'] })
    await expect(page.getByRole('complementary', { name: 'VS Code task chat', includeHidden: true })).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'Agent Host task chat', includeHidden: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Share original conversation remotely' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Remote devices', exact: true }).click()
    const connections = page.getByRole('dialog', { name: 'Remote devices', exact: true })
    const links = connections.getByRole('region', { name: 'Workspace Git synchronization' })
    const device = connections.locator('.remote-vscode-row').filter({ has: page.getByRole('button', { name: 'Reconnect device Machine-B', exact: true }) })
    await expect(links.getByText('linked', { exact: true })).toBeVisible()
    await expect(device.getByText('connected', { exact: true })).toBeVisible()
    await expect(links).toContainText('Trusted automatically linked devices can read and send to linked sessions, associate sessions with tasks, and explicitly create new sessions in this shared workspace.')
    await expect(links).toContainText('No separate per-device enable step is needed.')
    await expect(links).toContainText('This does not grant arbitrary operating-system permissions; native session approvals still apply.')
    await expect(links).toContainText('Requests are never sent and sessions are never created automatically.')
    for (const name of ['Pair device', 'Import device invitation', 'Export device identity', 'Confirm existing Agent Host links', 'Enable linked sessions', 'Disable linked sessions for this workspace', 'Revoke paired device']) {
      await expect(connections.getByRole('button', { name, exact: true })).toHaveCount(0)
    }
    await expect(connections.getByLabel('Paired recipient device')).toHaveCount(0)
    await expect(connections.getByLabel('Linked-session workspace access')).toHaveCount(0)
    await expect(connections.getByRole('option', { name: /Read only|Read and send/ })).toHaveCount(0)
    expect(await app.evaluate(({ app }) => Reflect.get(app, 'deviceUiActions'))).toEqual([])
    await connections.getByRole('button', { name: 'Sign in with Microsoft', exact: true }).click()
    await expect(connections.getByText('Signed in', { exact: true })).toBeVisible()
    await connections.getByRole('button', { name: 'Publish this machine', exact: true }).click()
    await expect(connections.getByText('Hosting', { exact: true })).toBeVisible()
    await connections.getByRole('button', { name: 'Stop publication', exact: true }).click()
    await expect(connections.getByText('Signed in', { exact: true })).toBeVisible()
    await connections.getByRole('button', { name: 'Disconnect device Machine-B', exact: true }).click()
    await expect(device.getByText('offline', { exact: true })).toBeVisible()
    await connections.getByRole('button', { name: 'Connect device Machine-B', exact: true }).click()
    await expect(device.getByText('connected', { exact: true })).toBeVisible()
    await expect(connections.getByRole('button', { name: 'Disconnect device Machine-B', exact: true })).toBeEnabled()
    await expect(connections.getByRole('button', { name: /^(Import invitation|Link to T-0001|Choose recipient)$/ })).toHaveCount(0)
    await expect(connections.getByRole('alert')).toHaveCount(0)
    await page.screenshot({ path: resolve('artifacts/device-connections-desktop.png') })
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(380, 600); window.setSize(420, 760) })
    expect(await connections.evaluate((element) => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().left >= 0 && element.getBoundingClientRect().right <= innerWidth)).toBe(true)
    await page.screenshot({ path: resolve('artifacts/device-connections-narrow.png') })
    await links.getByRole('button', { name: 'Revoke automatic link', exact: true }).click()
    await expect(links.getByText('blocked', { exact: true })).toBeVisible()
    await expect(links.getByRole('button', { name: 'Revoke automatic link', exact: true })).toBeDisabled()
    await expect(device.getByText('offline', { exact: true })).toBeVisible()
    await expect(connections.getByRole('button', { name: 'Connect device Machine-B', exact: true })).toBeEnabled()
    await links.getByRole('button', { name: 'Pause automatic links', exact: true }).click()
    await expect(links.getByRole('button', { name: 'Enable automatic links', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(connections).toBeHidden()
    await expect(page.getByRole('complementary', { name: 'VS Code task chat', includeHidden: true })).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'Agent Host task chat', includeHidden: true })).toHaveCount(0)
    expect(await readFile(legacyFile, 'utf8')).toBe(legacyBindings)
    expect(await readFile(taskFile, 'utf8')).toBe(taskText)
    expect(await app.evaluate(({ app }) => Reflect.get(app, 'deviceUiActions'))).toEqual([
      'remote-vscode:tunnel-login', 'remote-vscode:tunnel-publish', 'remote-vscode:tunnel-stop',
      'remote-vscode:device-disconnect', 'remote-vscode:device-connect', 'remote-vscode:git-revoke', 'remote-vscode:git-disable',
    ])
    expect(errors).toEqual([])
  } finally { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }) }
})