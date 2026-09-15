import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { startAgentHostFixture } from '../test/agent-host-fixture'
import { enableAutomaticLinks, prepareAutomaticLinksRepository, readDesktopBindings } from './immutable-workspace-fixture'

test('links and streams original AHP chats through immutable workspace bindings', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'continuum-ahp-desktop-'))
  const workspace = join(root, 'tasks')
  const discovery = join(root, 'discovery')
  const profile = join(root, 'profile')
  const fixture = await startAgentHostFixture()
  let app: ElectronApplication | undefined
  let page: Page
  const errors: string[] = []
  const network: string[] = []
  await mkdir(join(workspace, '.agentdesk'), { recursive: true })
  await mkdir(join(workspace, 'tasks', 'T-0001-ahp'), { recursive: true })
  await mkdir(discovery)
  await mkdir(resolve('artifacts'), { recursive: true })
  await writeFile(join(workspace, '.agentdesk/config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Agent Host verification' }))
  const taskFile = join(workspace, 'tasks/T-0001-ahp/task.json')
  const taskText = JSON.stringify({ schemaVersion: '1.0', id: 'T-0001', title: 'Verify original Agent Host integration', type: 'feature', status: 'backlog', priority: 'P2', relations: { level: 'task', parent: null } })
  await writeFile(taskFile, taskText)
  await writeFile(join(discovery, 'host.json'), JSON.stringify(fixture.endpoint))
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_RENDERER_URL
  environment.TASKCONTINUUM_WORKSPACE = workspace
  environment.TASKCONTINUUM_DATA_DIR = profile
  environment.TASKCONTINUUM_AGENT_HOST_DISCOVERY = discovery
  environment.TASKCONTINUUM_VSCODE_USER_DATA_DIR = join(root, 'no-legacy-sessions')
  async function launch() {
    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => { if (/^(https?|wss?):/.test(request.url())) network.push(request.url()) })
    await expect(page.getByRole('heading', { level: 1, name: 'Verify original Agent Host integration' })).toBeVisible()
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
  }
  try {
    const enrolled = await prepareAutomaticLinksRepository(workspace, join(root, 'immutable-fixture'))
    Object.assign(environment, enrolled.environment)
    await launch()
    await enableAutomaticLinks(app!, page!, profile)
    await expect(page!.getByRole('alert').filter({ hasText: 'backend is not ready' })).toHaveCount(0)
    await page!.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    const picker = page!.getByRole('dialog', { name: 'Agent Host sessions' })
    await expect(picker.getByRole('region', { name: 'Host session Original Host chat' })).toBeVisible()
    await picker.getByRole('button', { name: 'Link Original Host chat to T-0001' }).click()
    await expect(picker).toBeHidden()
    const panel = page!.getByRole('complementary', { name: 'Agent Host task chat' })
    await expect(panel.getByText('Connected', { exact: true })).toBeVisible()
    const saved = await readDesktopBindings(page!)
    expect(saved.document.bindings['T-0001']).toMatchObject({ provider: 'agent-host', hostId: fixture.hostId, sessionId: fixture.sessionId, chatId: fixture.chatId, owner: saved.localOwner })
    expect(saved.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(saved)).not.toContain(fixture.endpoint.connectionToken)
    expect(JSON.stringify(saved)).not.toContain(discovery)
    await expect(readFile(join(workspace, '.taskcontinuum', 'session-bindings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const target = await page!.evaluate(async () => {
      const state = await window.workspace!.getState()
      const link = (await window.workspace!.getSessionLinks(state.current!.id)).document.bindings['T-0001']
      if (link.provider !== 'agent-host') throw new Error('AHP link was not retained.')
      return { hostId: link.hostId, sessionId: link.sessionId, chatId: link.chatId, owner: link.owner }
    })
    const security = await page!.evaluate(async () => ({
      info: await window.desktop!.getInfo(), keys: Object.keys(window.agentHost!).sort(), require: typeof Reflect.get(window, 'require'),
      retiredBridges: ['copilot', 'vscodeChat', 'sharedSessions'].filter((name) => Reflect.has(window, name)),
    }))
    expect(security.info.security).toEqual({ contextIsolated: true, sandboxed: true })
    expect(security.keys).toEqual(['bindCreation', 'cancel', 'create', 'creationStatus', 'creationWorkers', 'creations', 'list', 'models', 'onView', 'send', 'unwatch', 'watch'])
    expect(security.require).toBe('undefined')
    expect(security.retiredBridges).toEqual([])
    expect(await page!.evaluate(async (value) => { try { await window.agentHost!.watch({ ...value, chatId: 'ahp-chat:/not-linked' }); return false } catch { return true } }, target)).toBe(true)
    expect(fixture.dispatches).toHaveLength(0)
    await panel.getByRole('textbox', { name: 'Message Agent Host' }).fill('A draft while B is responding')
    const ownerTurnId = randomUUID()
    fixture.action({ type: 'chat/turnStarted', turnId: ownerTurnId, startedAt: new Date().toISOString(), message: { text: 'Started in the owner editor', origin: { kind: 'user' } } })
    fixture.action({ type: 'chat/responsePart', turnId: ownerTurnId, part: { id: 'owner-answer', kind: 'markdown', content: '' } })
    fixture.action({ type: 'chat/delta', turnId: ownerTurnId, partId: 'owner-answer', content: '## Owner live reply\n\nVisible without a Task Continuum message.' })
    await expect(panel.getByRole('heading', { name: 'Owner live reply' })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Stop Agent Host response' })).toBeEnabled()
    fixture.action({ type: 'chat/delta', turnId: ownerTurnId, partId: 'owner-answer', content: '\n\nOwner second update.' })
    await expect(panel.getByText('Owner second update.')).toBeVisible()
    await expect(panel.getByRole('textbox')).toHaveValue('A draft while B is responding')
    expect(fixture.dispatches).toHaveLength(0)
    await page!.screenshot({ path: resolve('artifacts/agent-host-owner-stream.png') })
    fixture.action({ type: 'chat/turnComplete', turnId: ownerTurnId, duration: 1 })
    await expect(panel.getByRole('button', { name: 'Stop Agent Host response' })).toHaveCount(0)
    await panel.getByRole('textbox', { name: 'Message Agent Host' }).fill('Continue this exact original chat')
    await expect(panel.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    await expect(panel.getByRole('combobox', { name: 'Agent Host model' })).toBeInViewport()
    await expect(panel.getByText('Choose a model below to enable sending.')).toBeVisible()
    fixture.draft('', { model: { id: 'owner-model' } })
    await panel.getByRole('combobox', { name: 'Agent Host model' }).selectOption('gpt-6')
    await expect(panel.getByRole('combobox', { name: 'Thinking Level' })).toHaveValue('')
    await panel.getByRole('combobox', { name: 'Thinking Level' }).selectOption({ label: 'Max' })
    await panel.getByRole('combobox', { name: 'Context Size' }).selectOption({ label: '872K' })
    await panel.getByRole('button', { name: 'Send to Agent Host' }).click()
    await expect.poll(() => fixture.dispatches.length).toBe(1)
    expect(fixture.dispatches[0]).toMatchObject({ message: { model: { id: 'gpt-6', config: { thinkingLevel: 'max', contextSize: 872000 } } } })
    await expect(panel.getByText('Requested model: gpt-6')).toBeVisible()
    await expect(panel.getByText('Requested config: {"thinkingLevel":"max","contextSize":872000}', { exact: true })).toBeVisible()
    const turnId = (fixture.dispatches[0] as { turnId: string }).turnId
    fixture.action({ type: 'chat/responsePart', turnId, part: { id: 'answer', kind: 'markdown', content: '' } })
    fixture.action({ type: 'chat/delta', turnId, partId: 'answer', content: '## Live reply\n\n**Streaming before completion**\n\n```ts\nconst exactSession = true;\n```' })
    await expect(panel.getByRole('heading', { name: 'Live reply' })).toBeVisible()
    await expect(panel.getByText('Streaming before completion')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Stop Agent Host response' })).toBeEnabled()
    await panel.getByRole('textbox').fill('Next question stays while output arrives')
    fixture.action({ type: 'chat/delta', turnId, partId: 'answer', content: '\n\nSecond live update.' })
    await expect(panel.getByText('Second live update.')).toBeVisible()
    await expect(panel.getByRole('textbox')).toHaveValue('Next question stays while output arrives')
    await expect(panel.getByRole('combobox', { name: 'Agent Host model' })).toBeInViewport()
    await page!.screenshot({ path: resolve('artifacts/agent-host-desktop.png') })
    fixture.action({ type: 'chat/turnComplete', turnId, duration: 1 })
    await expect(panel.getByRole('button', { name: 'Stop Agent Host response' })).toHaveCount(0)
    fixture.drop()
    await expect(panel.getByText('Offline history', { exact: true })).toBeVisible()
    await expect(panel.getByText('Connected', { exact: true })).toBeVisible()
    expect(fixture.dispatches).toHaveLength(1)
    await app!.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(380, 600); window.setSize(420, 760) })
    if (!await panel.isVisible()) await page!.getByRole('button', { name: 'Toggle chat panel' }).click()
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('textbox')).toHaveValue('Next question stays while output arrives')
    await expect(panel.getByRole('button', { name: 'Send to Agent Host' })).toBeInViewport()
    await expect(panel.getByRole('combobox', { name: 'Agent Host model' })).toBeInViewport()
    await expect(panel.getByRole('button', { name: 'Retry loading models' })).toBeInViewport()
    await expect(panel.getByRole('combobox', { name: 'Thinking Level' })).toBeInViewport()
    await expect(panel.getByRole('combobox', { name: 'Context Size' })).toBeInViewport()
    expect(await page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await panel.evaluate((element) => element.getBoundingClientRect().right <= innerWidth + 1)).toBe(true)
    await page!.screenshot({ path: resolve('artifacts/agent-host-narrow.png') })
    await app!.close()
    app = undefined
    await launch()
    const restored = page!.getByRole('complementary', { name: 'Agent Host task chat' })
    await expect(restored).toBeVisible()
    expect((await readDesktopBindings(page!)).document).toEqual(saved.document)
    await expect(restored.getByRole('heading', { name: 'Owner live reply' })).toBeVisible()
    await expect(restored.getByText('Streaming before completion')).toBeVisible()
    expect(fixture.dispatches).toHaveLength(1)
    await restored.getByRole('button', { name: 'Detach conversation' }).click()
    await page!.getByRole('button', { name: 'Detach session', exact: true }).click()
    await expect(restored).toHaveCount(0)
    expect((await readDesktopBindings(page!)).document.bindings).toEqual({})
    await expect(readFile(join(workspace, '.taskcontinuum', 'session-bindings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(taskFile, 'utf8')).toBe(taskText)
    expect(fixture.dispatches).toHaveLength(1)
    expect(errors).toEqual([])
    expect(network).toEqual([])
  } finally { await app?.close(); await fixture.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }) }
})