import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import type { AgentHostSession, AgentHostTarget, AgentHostView } from '../src/shared/agentHost'
import type { SessionLinksSnapshot } from '../src/shared/sessionBindings'
import { agentHostKey } from '../src/shared/agentHost'

test('restores all open task tabs, their order and the exact selected chat across an actual desktop restart', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'continuum-selection-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  const discovery = join(root, 'discovery')
  const home = join(root, 'home')
  const callFile = join(profile, 'selection-fixture-calls.json')
  const owner = { clientId: randomUUID(), machineName: 'Owner-B' }
  const target = (name: string): AgentHostTarget => ({
    owner, sessionId: `copilotcli:/${name}`, chatId: `ahp-chat:/${name}/main`,
  })
  const initial = target('initial')
  const firstChat = target('remembered')
  const selectedChat = { ...firstChat, chatId: 'ahp-chat:/remembered/second' }
  const sessions: AgentHostSession[] = [
    { ...initial, title: 'Initial task chat', provider: 'copilotcli', canSend: false, updatedAt: '' },
    { ...firstChat, title: 'First remembered chat', provider: 'copilotcli', canSend: false, updatedAt: '' },
    { ...selectedChat, title: 'Selected remembered chat', provider: 'copilotcli', canSend: false, updatedAt: '' },
  ]
  const bindings: SessionLinksSnapshot = {
    document: { schemaVersion: '2.1', bindings: {
      'T-0001': [{ provider: 'agent-host', ...initial }],
      'T-0002': [{ provider: 'agent-host', ...firstChat }, { provider: 'agent-host', ...selectedChat }],
    } }, revision: 'a'.repeat(64), localOwner: { clientId: randomUUID(), machineName: 'Caller-A' },
  }
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_RENDERER_URL
  Object.assign(environment, {
    TASKCONTINUUM_WORKSPACE: workspace, TASKCONTINUUM_DATA_DIR: profile, TASKCONTINUUM_AGENT_HOST_DISCOVERY: discovery,
    HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
  })
  let app: ElectronApplication | undefined
  let page: Page
  const errors: string[] = []
  async function launch(): Promise<void> {
    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
    page = await app.firstWindow()
    await expect(page.getByRole('tablist', { name: 'Open tasks' })).toBeVisible()
    const workspaceId = (await page.evaluate(() => window.workspace!.getState())).current!.id
    await app.evaluate(({ ipcMain, session }, { bindings, sessions, workspaceId, callFile }) => {
      const filesystem = process.getBuiltinModule('fs')
      const record = (channel: string, target?: AgentHostTarget) => {
        const calls = JSON.parse(filesystem.readFileSync(callFile, 'utf8')) as { channel: string; target?: AgentHostTarget }[]
        calls.push({ channel, target })
        filesystem.writeFileSync(callFile, JSON.stringify(calls))
      }
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback({ cancel: /^(https?|wss?):/.test(details.url) }))
      ipcMain.removeHandler('workspace:session-links')
      ipcMain.handle('workspace:session-links', (_event, id: string) => {
        if (id !== workspaceId) throw new Error('Wrong workspace.')
        return bindings
      })
      ipcMain.removeHandler('agent-host:list')
      ipcMain.handle('agent-host:list', () => ({ sessions, warnings: [] }))
      ipcMain.removeHandler('agent-host:models')
      ipcMain.handle('agent-host:models', () => [])
      ipcMain.removeHandler('agent-host:unwatch')
      ipcMain.handle('agent-host:unwatch', () => {})
      ipcMain.removeHandler('agent-host:watch')
      ipcMain.handle('agent-host:watch', (event, target: AgentHostTarget) => {
        const selected = sessions.find((item) => item.sessionId === target.sessionId && item.chatId === target.chatId
          && item.owner.clientId === target.owner.clientId)
        if (!selected) throw new Error('Unknown chat identity.')
        record('watch', target)
        const id = `${target.sessionId}:${target.chatId}`
        const view: AgentHostView = {
          target, state: 'connected', canSend: false, readOnly: true, terminals: {}, protocolVersion: '0.10.0',
          chat: { resource: target.chatId, title: selected.title, status: 1, modifiedAt: '', turns: [] },
        }
        setTimeout(() => { if (!event.sender.isDestroyed()) event.sender.send('agent-host:view', { id, view }) }, 0)
        return id
      })
      for (const channel of ['agent-host:create', 'agent-host:create-local', 'agent-host:send', 'workspace:update-session-link']) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () => { record(channel); throw new Error('Restart must not create, send or rebind.') })
      }
    }, { bindings, sessions, workspaceId, callFile })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.reload()
    await expect(page.getByLabel('Chat header').getByText('Read only', { exact: true })).toBeVisible()
  }
  try {
    await Promise.all([join(workspace, '.agentdesk'), profile, discovery, environment.APPDATA, environment.LOCALAPPDATA].map((directory) => mkdir(directory, { recursive: true })))
    await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Selection fixture' }))
    for (const [id, title] of [['T-0001', 'Clean up codes'], ['T-0002', 'Fix Connection issues'], ['T-0003', 'Closed task']]) {
      await mkdir(join(workspace, 'tasks', id), { recursive: true })
      await writeFile(join(workspace, 'tasks', id, 'task.json'), JSON.stringify({
        schemaVersion: '1.0', id, title, type: 'feature', status: 'backlog', priority: 'P2', relations: { level: 'task', parent: null },
      }))
    }
    await writeFile(callFile, '[]')
    await launch()
    await expect(page!.getByRole('tab', { name: 'Clean up codes', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page!.getByRole('button', { name: 'Search tasks and jump back in', exact: true }).click()
    await page!.getByRole('dialog', { name: 'Quick open' }).getByRole('button', { name: /Fix Connection issues/ }).click()
    await page!.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    await page!.getByRole('button', { name: 'Open Selected remembered chat', exact: true }).click()
    await expect(page!.getByLabel('Chat header').getByText('Selected remembered chat', { exact: true })).toBeVisible()
    await page!.getByRole('button', { name: 'Search tasks and jump back in', exact: true }).click()
    await page!.getByRole('dialog', { name: 'Quick open' }).getByRole('button', { name: /Closed task/ }).click()
    await page!.getByRole('button', { name: 'Close Closed task', exact: true }).click()
    await expect(page!.getByRole('tab', { name: 'Fix Connection issues', exact: true })).toHaveAttribute('aria-selected', 'true')
    const workspaceId = (await page!.evaluate(() => window.workspace!.getState())).current!.id
    const saved = await page!.evaluate((key) => JSON.parse(localStorage.getItem(key)!), `taskcontinuum:workbench-selection:v2:${workspaceId}`)
    expect(saved).toMatchObject({ taskId: 'T-0002', openTaskIds: ['T-0001', 'T-0002'], sessions: { 'T-0002': `ahp:${agentHostKey(selectedChat)}` } })
    await app!.close()
    app = undefined
    await writeFile(callFile, '[]')
    await launch()
    await expect(page!.getByRole('tablist', { name: 'Open tasks' }).getByRole('tab')).toHaveText(['Clean up codes', 'Fix Connection issues'])
    await expect(page!.getByRole('tab', { name: 'Fix Connection issues', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page!.getByRole('tab', { name: 'Clean up codes', exact: true })).toHaveAttribute('aria-selected', 'false')
    await expect(page!.getByRole('tab', { name: 'Closed task', exact: true })).toHaveCount(0)
    await expect(page!.getByLabel('Chat header').getByText('Selected remembered chat', { exact: true })).toBeVisible()
    expect(JSON.parse(await readFile(callFile, 'utf8'))).toEqual([{ channel: 'watch', target: selectedChat }])
    await page!.getByLabel('Chat header').getByRole('button', { name: 'Chat details', exact: true }).click()
    const details = page!.getByRole('dialog', { name: 'Chat details', exact: true })
    await expect(details.getByText(selectedChat.chatId, { exact: true })).toBeVisible()
    await expect(details.getByText(owner.clientId, { exact: true })).toBeVisible()
    await details.getByRole('button', { name: 'Close Chat details', exact: true }).click()
    await expect(page!.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    expect(errors).toEqual([])
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
})
