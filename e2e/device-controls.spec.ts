import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron as electron, expect, test } from '@playwright/test'
import { updateRepositorySessionLink } from '../src/main/repositorySessionLinks'

test('Git owner links open the remote task and pairing/workspace controls need no session dialog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuum-device-ui-'))
  const tasks = join(root, 'tasks-root')
  const task = join(tasks, 'tasks', 'T-0001-original')
  await mkdir(task, { recursive: true })
  await mkdir(join(tasks, '.agentdesk'), { recursive: true })
  await writeFile(join(tasks, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Device UI fixture' }))
  await writeFile(join(task, 'task.json'), JSON.stringify({ schemaVersion: '1.0', id: 'T-0001', title: 'Device UI task', type: 'feature', status: 'backlog', priority: 'P2', relations: { level: 'task' } }))
  await updateRepositorySessionLink(tasks, 'T-0001', 'original', null, 'a'.repeat(32), undefined, { clientId: '00000000-0000-4000-8000-000000000003', machineName: 'Machine-B' })
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  env.TASKCONTINUUM_DATA_DIR = join(root, 'profile')
  env.TASKCONTINUUM_WORKSPACE = tasks
  env.TASKCONTINUUM_VSCODE_USER_DATA_DIR = join(root, 'empty-code')
  const app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { level: 1, name: 'Device UI task' })).toBeVisible()
    await app.evaluate(({ ipcMain }) => {
      let connected = false
      let shared = false
      let paired = false
      const participant = { clientId: '00000000-0000-4000-8000-000000000002', username: 'Alice', machineName: 'Machine-A' }
      const execution = { agentName: 'GitHub Copilot', machineName: 'Machine-B' }
      const target = { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32), remoteMachineName: 'Machine-B' }
      const handlers: Record<string, (...args: unknown[]) => unknown> = {
        'remote-vscode:tunnel-status': () => ({ installed: true, account: 'test@example.test', state: paired ? 'hosting' : 'idle' }),
        'remote-vscode:devices': () => [{ id: 'device-b', machineName: 'Machine-B', state: connected ? 'connected' : 'offline', enabled: connected, expiresAt: '2099-01-01T00:00:00Z' }],
        'remote-vscode:device-connect': () => { connected = true },
        'remote-vscode:device-disconnect': () => { connected = false },
        'remote-vscode:device-recipients': () => [{ id: 'device-a', username: 'Alice', machineName: 'Machine-A', expiresAt: '2099-01-01T00:00:00Z', linkedAccess: shared ? 'send' : 'none' }],
        'remote-vscode:device-pair': (canSend) => { if (canSend !== true) throw new Error('Expected linked read/send permission'); paired = true; return true },
        'remote-vscode:device-workspace': (id, mode) => { if (id !== 'device-a' || mode !== 'send') throw new Error('Incorrect workspace policy'); shared = true; return true },
        'remote-vscode:device-share': (_id, identity, canSend) => { if (JSON.stringify(identity) !== JSON.stringify({ nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32) }) || canSend !== true) throw new Error('Incorrect session policy'); shared = true; return true },
        'remote-vscode:grants': () => shared ? [{ id: 'grant', participant, canSend: true, expiresAt: '2099-01-01T00:00:00Z' }] : [],
        'remote-vscode:list': () => connected ? ['First original', 'Second original'].map((title, index) => ({ id: `session-${index}`, deviceId: 'device-b', title, target: { ...target, nativeSessionId: `original-${index}` }, hostAlias: '', transport: 'dev-tunnel', participant, execution, canSend: index === 0, state: 'connected', expiresAt: '2099-01-01T00:00:00Z' })) : [],
        'vscode-chat:read': (value) => {
          if ((value as { remoteMachineName?: string }).remoteMachineName !== 'Machine-B') throw new Error('Git owner was not interpreted remotely.')
          return { session: { id: 'original', source: 'vscode', title: 'Original on B from Git', updatedAt: new Date().toISOString() }, messages: [], deliveries: [], participant, execution, canSend: true, responding: false, connectionState: 'connected' }
        },
      }
      for (const [name, handler] of Object.entries(handlers)) { ipcMain.removeHandler(name); ipcMain.handle(name, (_event, ...args) => handler(...args)) }
    })
    await page.reload()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('heading', { level: 1, name: 'Device UI task' })).toBeVisible()
    await expect(page.getByText('Original on B from Git', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Share original conversation remotely' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Remote VS Code sessions', exact: true }).click()
    const connections = page.getByRole('dialog', { name: 'Remote VS Code sessions', exact: true })
    await connections.getByRole('button', { name: 'Pair device', exact: true }).click()
    await expect(connections).toContainText('Device invitation saved; linked-session workspace policy enabled.')
    await connections.getByLabel('Paired recipient device').selectOption('device-a')
    await connections.getByRole('button', { name: 'Enable linked sessions', exact: true }).click()
    await expect(connections).toContainText('Workspace access: send')
    await connections.getByRole('button', { name: 'Connect device Machine-B', exact: true }).click()
    await expect(connections.getByRole('region', { name: 'Remote First original' })).toBeVisible()
    await expect(connections.getByRole('region', { name: 'Remote Second original' })).toBeVisible()
    await expect(connections.getByRole('button', { name: 'Connect Machine-B', exact: true })).toHaveCount(0)
    await mkdir(resolve('artifacts'), { recursive: true })
    await page.screenshot({ path: resolve('artifacts/device-connections-desktop.png') })
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(380, 600); window.setSize(420, 760) })
    expect(await connections.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: resolve('artifacts/device-connections-narrow.png') })
    expect(errors).toEqual([])
  } finally { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }) }
})