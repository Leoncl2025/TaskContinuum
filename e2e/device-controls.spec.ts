import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron as electron, expect, test } from '@playwright/test'

test('device pairing and workspace permissions ignore inert legacy session bindings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuum-device-ui-'))
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
    await app.evaluate(({ ipcMain }) => {
      let connected = false
      let signedIn = false
      let paired = false
      let linkedAccess: 'none' | 'read' | 'send' = 'none'
      const handlers: Record<string, (...args: unknown[]) => unknown> = {
        'remote-vscode:tunnel-status': () => ({ installed: true, ...(signedIn ? { account: 'test@example.test' } : {}), state: paired ? 'hosting' : 'idle' }),
        'remote-vscode:tunnel-login': () => { signedIn = true },
        'remote-vscode:devices': () => [{ id: 'device-b', machineName: 'Machine-B', state: connected ? 'connected' : 'offline', enabled: connected, expiresAt: '2099-01-01T00:00:00Z' }],
        'remote-vscode:device-connect': (id) => { if (id !== 'device-b') throw new Error('Incorrect device'); connected = true },
        'remote-vscode:device-disconnect': (id) => { if (id !== 'device-b') throw new Error('Incorrect device'); connected = false },
        'remote-vscode:device-recipients': () => paired ? [{ id: 'device-a', username: 'Alice', machineName: 'Machine-A', expiresAt: '2099-01-01T00:00:00Z', linkedAccess }] : [],
        'remote-vscode:device-pair': (canSend) => {
          if (!signedIn || canSend !== true) throw new Error('Pairing requires an account and the selected linked read/send permission.')
          paired = true
          linkedAccess = 'send'
          return true
        },
        'remote-vscode:device-workspace': (id, mode) => {
          if (!paired || id !== 'device-a' || mode !== 'none' && mode !== 'read' && mode !== 'send') throw new Error('Incorrect workspace policy')
          linkedAccess = mode
          return true
        },
      }
      for (const [name, handler] of Object.entries(handlers)) { ipcMain.removeHandler(name); ipcMain.handle(name, (_event, ...args) => handler(...args)) }
    })
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Device UI task' })).toBeVisible()
    const surface = await page.evaluate(() => ({
      retiredBridges: ['copilot', 'vscodeChat', 'sharedSessions'].filter((name) => Reflect.has(window, name)),
      remote: Object.keys(window.remoteVSCode ?? {}).sort(),
    }))
    expect(surface).toEqual({ retiredBridges: [], remote: ['devTunnels', 'devices', 'exportIdentity', 'gitSync'] })
    await expect(page.getByRole('alert').filter({ hasText: /Enable Automatic workspace links[\s\S]*backend is not ready/ })).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'VS Code task chat', includeHidden: true })).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'Agent Host task chat', includeHidden: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Share original conversation remotely' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Remote devices', exact: true }).click()
    const connections = page.getByRole('dialog', { name: 'Remote devices', exact: true })
    const access = connections.getByRole('combobox', { name: 'Linked-session workspace access', exact: true })
    const device = connections.locator('.remote-vscode-row').filter({ hasText: 'Machine-B' })
    await expect(access).toHaveValue('send')
    await expect(connections.getByRole('button', { name: 'Pair device', exact: true })).toBeDisabled()
    await expect(connections.getByRole('button', { name: 'Enable linked sessions', exact: true })).toBeDisabled()
    await connections.getByRole('button', { name: 'Sign in with Microsoft', exact: true }).click()
    await expect(connections.getByText('Signed in', { exact: true })).toBeVisible()
    await expect(connections.getByRole('button', { name: 'Pair device', exact: true })).toBeEnabled()
    await connections.getByRole('button', { name: 'Pair device', exact: true }).click()
    await expect(connections).toContainText('Device invitation saved; linked-session workspace policy enabled.')
    await connections.getByLabel('Paired recipient device').selectOption('device-a')
    await expect(connections).toContainText('Workspace access: send')
    await connections.getByRole('button', { name: 'Disable linked sessions for this workspace', exact: true }).click()
    await expect(connections).toContainText('Workspace access: none')
    await access.selectOption('read')
    await connections.getByRole('button', { name: 'Enable linked sessions', exact: true }).click()
    await expect(connections).toContainText('Workspace access: read')
    await access.selectOption('send')
    await connections.getByRole('button', { name: 'Enable linked sessions', exact: true }).click()
    await expect(connections).toContainText('Workspace access: send')
    await expect(device.getByText('offline', { exact: true })).toBeVisible()
    await connections.getByRole('button', { name: 'Connect device Machine-B', exact: true }).click()
    await expect(device.getByText('connected', { exact: true })).toBeVisible()
    await expect(connections.getByRole('button', { name: 'Disconnect device Machine-B', exact: true })).toBeEnabled()
    await expect(connections.getByRole('button', { name: /^(Import invitation|Link to T-0001|Choose recipient)$/ })).toHaveCount(0)
    await expect(connections.getByRole('alert')).toHaveCount(0)
    await mkdir(resolve('artifacts'), { recursive: true })
    await page.screenshot({ path: resolve('artifacts/device-connections-desktop.png') })
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(380, 600); window.setSize(420, 760) })
    expect(await connections.evaluate((element) => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().left >= 0 && element.getBoundingClientRect().right <= innerWidth)).toBe(true)
    await page.screenshot({ path: resolve('artifacts/device-connections-narrow.png') })
    await connections.getByRole('button', { name: 'Disconnect device Machine-B', exact: true }).click()
    await expect(device.getByText('offline', { exact: true })).toBeVisible()
    await expect(connections.getByRole('button', { name: 'Connect device Machine-B', exact: true })).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(connections).toBeHidden()
    await expect(page.getByRole('complementary', { name: 'VS Code task chat', includeHidden: true })).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'Agent Host task chat', includeHidden: true })).toHaveCount(0)
    expect(await readFile(legacyFile, 'utf8')).toBe(legacyBindings)
    expect(await readFile(taskFile, 'utf8')).toBe(taskText)
    expect(errors).toEqual([])
  } finally { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }) }
})