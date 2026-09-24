import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import type { AgentHostSession, AgentHostTarget, AgentHostView } from '../src/shared/agentHost'
import type { SessionLinksSnapshot } from '../src/shared/sessionBindings'

test('keeps exact chat titles across partial discovery and desktop restart without granting access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuum-title-cache-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  const discovery = join(root, 'discovery')
  const home = join(root, 'home')
  const stateFile = join(profile, 'title-fixture.json')
  const owner = { clientId: randomUUID(), machineName: 'Owner-B' }
  const target: AgentHostTarget = { sessionId: `copilotcli:/${randomUUID()}`, chatId: `ahp-chat:/${randomUUID()}`, owner }
  const session: AgentHostSession = { ...target, title: 'Native conversation title', provider: 'copilotcli', canSend: false, updatedAt: '2026-09-24T14:00:00.000Z' }
  const view: AgentHostView = { target, state: 'connected', canSend: false, readOnly: true, terminals: {},
    chat: { resource: target.chatId, title: session.title, status: 1, modifiedAt: session.updatedAt, turns: [] } }
  const bindings: SessionLinksSnapshot = { document: { schemaVersion: '2.1', bindings: { 'T-0001': [{ provider: 'agent-host', ...target }] } }, revision: 'a'.repeat(64), localOwner: { clientId: randomUUID(), machineName: 'Caller-A' } }
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_RENDERER_URL
  Object.assign(environment, {
    TASKCONTINUUM_WORKSPACE: workspace, TASKCONTINUUM_DATA_DIR: profile, TASKCONTINUUM_AGENT_HOST_DISCOVERY: discovery,
    TASKCONTINUUM_VSCODE_USER_DATA_DIR: join(root, 'empty-vscode'), HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
  })
  let app: ElectronApplication | undefined
  let page: Page
  const errors: string[] = []
  async function saveState(sessions: AgentHostSession[], view: AgentHostView): Promise<void> {
    await writeFile(stateFile, JSON.stringify({ sessions, view }))
  }
  async function launch(): Promise<void> {
    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
    page = await app.firstWindow()
    await expect(page.getByRole('heading', { level: 1, name: 'Verify title persistence' })).toBeVisible()
    const workspaceId = (await page.evaluate(() => window.workspace!.getState())).current!.id
    await app.evaluate(({ ipcMain, session, dialog }, { stateFile, bindings, workspaceId, target }) => {
      const read = () => JSON.parse(process.getBuiltinModule('fs').readFileSync(stateFile, 'utf8')) as { sessions: AgentHostSession[]; view: AgentHostView }
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => callback({ cancel: /^(https?|wss?):/.test(details.url) }))
      for (const [channel, handler] of Object.entries({
        'workspace:session-links': (id: unknown) => { if (id !== workspaceId) throw new Error('Wrong workspace.'); return bindings },
        'agent-host:list': () => ({ sessions: read().sessions, warnings: [] }),
        'agent-host:models': () => [],
        'agent-host:unwatch': () => {},
      })) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, (_event, ...args: unknown[]) => handler(args[0]))
      }
      ipcMain.removeHandler('agent-host:watch')
      ipcMain.handle('agent-host:watch', (event, selected: AgentHostTarget) => {
        if (selected.sessionId !== target.sessionId || selected.chatId !== target.chatId || selected.owner.clientId !== target.owner.clientId) throw new Error('Wrong chat identity.')
        setTimeout(() => { if (!event.sender.isDestroyed()) event.sender.send('agent-host:view', { id: 'title-watch', view: read().view }) }, 0)
        return 'title-watch'
      })
    }, { stateFile, bindings, workspaceId, target })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Verify title persistence' })).toBeVisible()
  }
  try {
    await Promise.all([join(workspace, '.agentdesk'), join(workspace, 'tasks', 'T-0001'), profile, discovery, environment.APPDATA, environment.LOCALAPPDATA].map((path) => mkdir(path, { recursive: true })))
    await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Title-cache fixture' }))
    await writeFile(join(workspace, 'tasks', 'T-0001', 'task.json'), JSON.stringify({ schemaVersion: '1.0', id: 'T-0001', title: 'Verify title persistence', type: 'feature', status: 'backlog', priority: 'P2', relations: { level: 'task', parent: null } }))
    await saveState([session], view)
    await launch()
    await page!.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    const sidebar = () => page!.getByRole('complementary', { name: 'Agent Host sessions', exact: true })
    const panel = () => page!.getByRole('complementary', { name: 'Agent Host task chat', exact: true })
    await expect(sidebar().getByRole('treeitem', { name: session.title, exact: true })).toBeVisible()
    view.chat!.title = 'Renamed native conversation'
    view.chat!.modifiedAt = '2026-09-24T14:02:00.000Z'
    await app!.evaluate(({ BrowserWindow }, view) => {
      BrowserWindow.getAllWindows()[0].webContents.send('agent-host:view', { id: 'title-watch', view })
    }, view)
    await expect(sidebar().getByRole('treeitem', { name: view.chat!.title, exact: true })).toBeVisible()
    await expect(panel().getByText(view.chat!.title, { exact: true })).toBeVisible()
    await saveState([], { ...view, state: 'offline', chat: undefined })
    await sidebar().getByRole('button', { name: 'Refresh Agent Host sessions' }).click()
    await expect(sidebar().getByRole('treeitem', { name: view.chat!.title, exact: true })).toContainText('Not in discovery list')
    await app!.close()
    app = undefined
    await launch()
    await expect(panel().getByText(view.chat!.title, { exact: true })).toBeVisible()
    await expect(panel().getByText('Offline history', { exact: true })).toBeVisible()
    await expect(panel().getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    await page!.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    const restored = sidebar().getByRole('treeitem', { name: view.chat!.title, exact: true })
    await expect(restored).toContainText('Not in discovery list')
    await expect(restored.getByText(target.sessionId, { exact: true })).toBeVisible()
    await mkdir(resolve('artifacts'), { recursive: true })
    await page!.screenshot({ path: resolve('artifacts', 'agent-host-cached-title.png') })
    expect(errors).toEqual([])
  } finally { await app?.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) }
})
