import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import type { AgentHostSession, AgentHostTarget } from '../src/shared/agentHost'
import type { AgentHostCreateRequest, AgentHostCreation, AgentHostWorker } from '../src/shared/agentHostCreation'
import type { SessionLinksSnapshot } from '../src/shared/sessionBindings'

interface MockLedger {
  workers: AgentHostWorker[]
  operations: AgentHostCreation[]
  calls: { channel: string; args: unknown[] }[]
}

interface MockFiles {
  ledger: string
  bindingSnapshot: string
}

async function installCreationMock(app: ElectronApplication, files: MockFiles, workspaceId: string): Promise<void> {
  await app.evaluate(({ ipcMain, dialog, session }, files) => {
    const fs = process.getBuiltinModule('fs')
    const read = (): MockLedger => JSON.parse(fs.readFileSync(files.ledger, 'utf8'))
    const save = (state: MockLedger) => {
      fs.writeFileSync(`${files.ledger}.next`, JSON.stringify(state))
      fs.renameSync(`${files.ledger}.next`, files.ledger)
    }
    const record = (channel: string, args: unknown[]) => {
      const state = read()
      state.calls.push({ channel, args })
      save(state)
      return state
    }
    // Leave the real local catalog consent route intact, and always decline it.
    dialog.showMessageBox = async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string; buttons?: string[] }
      record('native-dialog', [options.message, options.buttons])
      return { response: 0, checkboxChecked: false }
    }
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const external = /^(https?|wss?):/.test(details.url)
      if (external) record('external-request', [details.url])
      callback({ cancel: external })
    })
    const handlers: Record<string, (...args: unknown[]) => unknown> = {
      'workspace:session-links': (id) => {
        record('workspace:session-links', [id])
        if (id !== files.workspaceId) throw new Error('The binding snapshot belongs to a different fixture workspace.')
        return JSON.parse(fs.readFileSync(files.bindingSnapshot, 'utf8')) as SessionLinksSnapshot
      },
      'agent-host:creation-workers': (taskId) => record('agent-host:creation-workers', [taskId]).workers,
      'agent-host:creations': (taskId) => record('agent-host:creations', [taskId]).operations.filter((operation) => operation.taskId === taskId),
      'agent-host:create': (value) => {
        const request = value as AgentHostCreateRequest
        const state = record('agent-host:create', [request])
        const worker = state.workers.find((item) => item.id === request.workerId)
        const workspace = worker?.workspaces.find((item) => item.id === request.workspaceId)
        const host = worker?.hosts.find((item) => item.hostId === request.hostId)
        if (request.taskId !== 'T-0001' || worker?.state !== 'connected' || !workspace?.canSend || workspace.taskState !== 'available' || !host?.available || request.expectedRevision !== workspace.expectedRevision) throw new Error('The UI sent an ineligible or incorrectly scoped creation request.')
        if (Object.keys(request).sort().join(',') !== 'expectedRevision,hostId,operationId,taskId,workerId,workspaceId') throw new Error('Creation must not include a prompt, model, or guessed path.')
        if (state.operations.some((operation) => operation.taskId === request.taskId && operation.state !== 'failed')) throw new Error('A second creation was attempted while the original operation was unresolved.')
        const operation: AgentHostCreation = {
          operationId: request.operationId, taskId: request.taskId, workerId: request.workerId, workspaceId: request.workspaceId, hostId: request.hostId,
          state: 'uncertain', error: 'The acknowledgement was lost. Check this saved operation after reconnecting.',
        }
        state.operations.push(operation)
        save(state)
        return operation
      },
      'agent-host:creation-status': (id) => {
        const operation = record('agent-host:creation-status', [id]).operations.find((item) => item.operationId === id)
        if (!operation) throw new Error('Unknown saved creation operation.')
        return operation
      },
      'agent-host:bind-creation': (id) => {
        const state = record('agent-host:bind-creation', [id])
        const operation = state.operations.find((item) => item.operationId === id)
        if (operation?.state !== 'created-unbound' || !operation.session) throw new Error('Binding retry must use the already-created chat.')
        const { sessionId, chatId, owner } = operation.session
        const before = JSON.parse(fs.readFileSync(files.bindingSnapshot, 'utf8')) as SessionLinksSnapshot
        const bindings = before.document.bindings
        const members = bindings[operation.taskId] ?? []
        const document: SessionLinksSnapshot['document'] = {
          schemaVersion: '2.1',
          bindings: { ...bindings, [operation.taskId]: [...members, { provider: 'agent-host', sessionId, chatId, owner }] },
        }
        const revision = process.getBuiltinModule('crypto').createHash('sha256').update(JSON.stringify(document)).digest('hex')
        const snapshot: SessionLinksSnapshot = { ...before, document, revision }
        fs.writeFileSync(`${files.bindingSnapshot}.next`, JSON.stringify(snapshot))
        fs.renameSync(`${files.bindingSnapshot}.next`, files.bindingSnapshot)
        operation.state = 'ready'
        delete operation.error
        const workspace = state.workers.find((item) => item.id === operation.workerId)?.workspaces.find((item) => item.id === operation.workspaceId)
        if (workspace) workspace.taskState = 'bound'
        save(state)
        return operation
      },
      'agent-host:models': (target) => { record('agent-host:models', [target]); return [] },
      'agent-host:unwatch': (id) => { record('agent-host:unwatch', [id]) },
    }
    for (const channel of ['agent-host:send', 'agent-host:cancel', 'copilot:create', 'copilot:send', 'copilot:resume', 'copilot:import', 'workspace:update-session-link']) {
      handlers[channel] = (...args) => { record(channel, args); throw new Error('This mocked creation test must not send, create a CLI session, or attach a second time.') }
    }
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, ...args) => handler(...args))
    }
    let nextWatch = 0
    ipcMain.removeHandler('agent-host:watch')
    ipcMain.handle('agent-host:watch', (event, target: AgentHostTarget) => {
      record('agent-host:watch', [target])
      const id = `mock-creation-watch-${++nextWatch}`
      setTimeout(() => {
        if (!event.sender.isDestroyed()) event.sender.send('agent-host:view', { id, view: { target, state: 'connected', canSend: true, readOnly: false, terminals: {}, chat: { resource: target.chatId, title: 'Mock created chat', modifiedAt: '', status: 1, turns: [] } } })
      }, 0)
      return id
    })
  }, { ...files, workspaceId })
}

async function selectTarget(picker: Locator, worker: string, workspace: string, host: string): Promise<void> {
  await expect(picker.getByRole('combobox', { name: 'Remote worker', exact: true })).toBeEnabled()
  await picker.getByRole('combobox', { name: 'Remote worker', exact: true }).selectOption(worker)
  await picker.getByRole('combobox', { name: 'Shared worker workspace', exact: true }).selectOption(workspace)
  await picker.getByRole('combobox', { name: 'Exact Agent Host', exact: true }).selectOption(host)
}

test('creates explicitly through sandboxed IPC and recovers the same operation across remount and restart', async () => {
  test.setTimeout(120000)
  const root = resolve('.runtime', `agent-host-creation-e2e-${randomUUID()}`)
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  const discovery = join(root, 'empty-discovery')
  const home = join(root, 'home')
  const taskDirectory = join(workspace, 'tasks', 'T-0001-creation')
  // Both files are mock IPC fixture state, outside the workspace and its immutable records.
  const files: MockFiles = { ledger: join(profile, 'mock-creation-ledger.json'), bindingSnapshot: join(profile, 'mock-workspace-binding-snapshot.json') }
  const revision = 'd'.repeat(64)
  const workerOwner = { clientId: '00000000-0000-4000-8000-000000000017', machineName: 'Paired-send-worker' }
  const workers: AgentHostWorker[] = [
    { id: 'offline-worker', owner: { clientId: '00000000-0000-4000-8000-000000000018', machineName: 'Offline worker' }, state: 'offline', hosts: [{ hostId: 'offline-host', name: 'Offline Host', available: true }], workspaces: [{ id: 'offline-workspace', name: 'Offline project', canSend: true, taskState: 'available', expectedRevision: null }] },
    { id: 'read-only-worker', owner: { clientId: '00000000-0000-4000-8000-000000000019', machineName: 'Read-only worker' }, state: 'connected', hosts: [{ hostId: 'read-only-host', name: 'Read-only Host', available: true }], workspaces: [{ id: 'read-only-workspace', name: 'Read-only project', canSend: false, taskState: 'available', expectedRevision: null }] },
    { id: 'unsupported-worker', owner: { clientId: '00000000-0000-4000-8000-000000000020', machineName: 'Older worker' }, state: 'unsupported', hosts: [], workspaces: [], error: 'Remote creation is not supported by this worker version.' },
    { id: 'send-worker', owner: workerOwner, state: 'connected', hosts: [{ hostId: 'unselected-host', name: 'Other native Host', available: true }, { hostId: 'selected-exact-host', name: 'Exact native Host', available: true }], workspaces: [{ id: 'send-workspace', name: 'Shared send project', canSend: true, taskState: 'available', expectedRevision: revision }] },
  ]
  const taskFile = join(taskDirectory, 'task.json')
  const taskText = JSON.stringify({ schemaVersion: '1.0', id: 'T-0001', title: 'Remote creation lifecycle', type: 'feature', status: 'backlog', priority: 'P2', relations: { level: 'task', parent: null } })
  const failed: AgentHostCreation = { operationId: randomUUID(), taskId: 'T-0001', workerId: 'send-worker', workspaceId: 'send-workspace', hostId: 'selected-exact-host', state: 'failed', error: 'No native create request was dispatched.' }
  let app: ElectronApplication | undefined
  let page: Page
  const errors: string[] = []
  const externalRequests: string[] = []
  await Promise.all([taskDirectory, profile, discovery, join(workspace, '.agentdesk'), join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')].map((directory) => mkdir(directory, { recursive: true })))
  await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Mock remote creation workspace' }))
  await writeFile(taskFile, taskText)
  await writeFile(files.ledger, JSON.stringify({ workers, operations: [failed], calls: [] } satisfies MockLedger))
  await writeFile(files.bindingSnapshot, JSON.stringify({
    document: { schemaVersion: '2.1', bindings: {} }, revision: null,
    localOwner: { clientId: '00000000-0000-4000-8000-000000000021', machineName: 'Creation UI fixture' },
  } satisfies SessionLinksSnapshot))
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_RENDERER_URL
  environment.TASKCONTINUUM_WORKSPACE = workspace
  environment.TASKCONTINUUM_DATA_DIR = profile
  environment.TASKCONTINUUM_AGENT_HOST_DISCOVERY = discovery
  environment.TASKCONTINUUM_VSCODE_USER_DATA_DIR = join(root, 'empty-vscode')
  environment.HOME = home
  environment.USERPROFILE = home
  environment.APPDATA = join(home, 'AppData', 'Roaming')
  environment.LOCALAPPDATA = join(home, 'AppData', 'Local')
  const ledger = async (): Promise<MockLedger> => JSON.parse(await readFile(files.ledger, 'utf8'))
  const calls = async (channel: string) => (await ledger()).calls.filter((call) => call.channel === channel)
  async function launch(): Promise<void> {
    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => { if (/^(https?|wss?):/.test(request.url())) externalRequests.push(request.url()) })
    await expect(page.getByRole('heading', { level: 1, name: 'Remote creation lifecycle' })).toBeVisible()
    const workspaceId = (await page.evaluate(() => window.workspace!.getState())).current!.id
    await installCreationMock(app, files, workspaceId)
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Remote creation lifecycle' })).toBeVisible()
  }
  async function openPicker(): Promise<Locator> {
    await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    const picker = page.getByRole('complementary', { name: 'Agent Host sessions', exact: true })
    await picker.getByRole('tab', { name: 'Link', exact: true }).click()
    await expect(picker.getByText('Local Agent Host access is not enabled for this workspace.', { exact: true })).toBeVisible()
    await expect(picker.getByText('No available Agent Host sessions.', { exact: true })).toBeVisible()
    await picker.getByRole('tab', { name: 'Create', exact: true }).click()
    await expect(picker.getByRole('combobox', { name: 'Remote worker', exact: true })).toBeEnabled()
    return picker
  }
  try {
    await launch()
    const security = await page!.evaluate(async () => ({
      info: await window.desktop!.getInfo(), require: typeof Reflect.get(window, 'require'),
      retiredBridges: ['copilot', 'vscodeChat', 'sharedSessions'].filter((name) => Reflect.has(window, name)),
    }))
    expect(security.info.security).toEqual({ contextIsolated: true, sandboxed: true })
    expect(security.require).toBe('undefined')
    expect(security.retiredBridges).toEqual([])
    let picker = await openPicker()
    const create = () => picker.getByRole('button', { name: 'Create and assign to T-0001', exact: true })
    await expect(create()).toBeDisabled()
    await selectTarget(picker, 'offline-worker', 'offline-workspace', 'offline-host')
    await expect(picker.getByText(/This worker is offline/)).toBeVisible()
    await expect(create()).toBeDisabled()
    await selectTarget(picker, 'read-only-worker', 'read-only-workspace', 'read-only-host')
    await expect(picker.getByText(/This shared workspace is read only/)).toBeVisible()
    await expect(create()).toBeDisabled()
    await picker.getByRole('combobox', { name: 'Remote worker', exact: true }).selectOption('unsupported-worker')
    await expect(picker.getByText('Remote creation is not supported by this worker version.', { exact: true })).toBeVisible()
    await expect(create()).toBeDisabled()
    await selectTarget(picker, 'send-worker', 'send-workspace', '')
    await expect(create()).toBeDisabled()
    await picker.getByRole('combobox', { name: 'Exact Agent Host', exact: true }).selectOption('selected-exact-host')
    await expect(create()).toBeEnabled()
    await picker.getByRole('button', { name: 'Refresh workers and creation status', exact: true }).click()
    await expect(create()).toBeEnabled()
    expect(await calls('agent-host:create')).toEqual([])
    expect(await calls('agent-host:send')).toEqual([])
    const consentBeforeCreate = await calls('native-dialog')
    expect(consentBeforeCreate).toHaveLength(1)
    expect(consentBeforeCreate[0].args).toEqual(['Allow Agent Host access for this task workspace?', ['Cancel', 'Allow']])
    await picker.getByRole('button', { name: 'Hide session sidebar', exact: true }).click()
    picker = await openPicker()
    await expect(picker.getByRole('heading', { name: 'Creation failed · T-0001', exact: true })).toBeVisible()
    await expect(picker.getByText('Choose a remote worker to enable creation.', { exact: true })).toBeVisible()
    await expect(create()).toBeDisabled()
    const consentBeforeRecovery = (await calls('native-dialog')).length
    await picker.getByRole('button', { name: 'Use these choices again', exact: true }).click()
    await expect(picker.getByRole('combobox', { name: 'Remote worker', exact: true })).toHaveValue(failed.workerId)
    await expect(picker.getByRole('combobox', { name: 'Shared worker workspace', exact: true })).toHaveValue(failed.workspaceId)
    await expect(picker.getByRole('combobox', { name: 'Exact Agent Host', exact: true })).toHaveValue(failed.hostId)
    await expect(create()).toBeEnabled()
    expect(await calls('native-dialog')).toHaveLength(consentBeforeRecovery)
    expect(await calls('agent-host:create')).toEqual([])
    expect(await calls('agent-host:bind-creation')).toEqual([])
    await expect(picker.getByRole('checkbox')).toHaveCount(0)
    await mkdir(resolve('artifacts'), { recursive: true })
    await page!.screenshot({ path: resolve('artifacts', 'agent-host-creation-controls-desktop.png') })
    await create().click()
    await expect(picker.getByRole('heading', { name: 'Outcome uncertain · T-0001', exact: true })).toBeVisible()
    await expect(create()).toBeDisabled()
    expect(await calls('native-dialog')).toHaveLength(consentBeforeRecovery)
    const operation = (await ledger()).operations.find((item) => item.operationId !== failed.operationId)!
    expect(operation.operationId).toMatch(/^[0-9a-f-]{36}$/)
    expect((await ledger()).operations.find((item) => item.operationId === failed.operationId)).toEqual(failed)
    expect(await calls('agent-host:create')).toEqual([{ channel: 'agent-host:create', args: [{ operationId: operation.operationId, taskId: 'T-0001', workerId: 'send-worker', workspaceId: 'send-workspace', hostId: 'selected-exact-host', expectedRevision: revision }] }])
    const row = () => picker.getByRole('region', { name: `Creation ${operation.operationId}`, exact: true })
    await expect(row()).toContainText(workerOwner.machineName)
    await expect(row()).toContainText(workerOwner.clientId)
    await expect(row()).toContainText('selected-exact-host')
    await picker.getByRole('button', { name: 'Check status', exact: true }).click()
    const statusAfterClick = (await calls('agent-host:creation-status')).length
    expect(statusAfterClick).toBeGreaterThan(0)
    await expect.poll(async () => (await calls('agent-host:creation-status')).length, { timeout: 15000 }).toBeGreaterThan(statusAfterClick)
    const statusBeforeReconnect = (await calls('agent-host:creation-status')).length
    await page!.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect.poll(async () => (await calls('agent-host:creation-status')).length).toBeGreaterThan(statusBeforeReconnect)
    await picker.getByRole('button', { name: 'Hide session sidebar', exact: true }).click()
    picker = await openPicker()
    await expect(row()).toContainText('Outcome uncertain')
    await expect(create()).toBeDisabled()
    expect(await calls('agent-host:create')).toHaveLength(1)
    await page!.reload()
    await expect(page!.getByRole('heading', { level: 1, name: 'Remote creation lifecycle' })).toBeVisible()
    picker = await openPicker()
    await expect(row()).toContainText('Outcome uncertain')
    expect(await calls('agent-host:create')).toHaveLength(1)
    await app!.close()
    app = undefined
    await launch()
    picker = await openPicker()
    await expect(row()).toContainText('Outcome uncertain')
    await expect(create()).toBeDisabled()
    expect(await calls('agent-host:create')).toHaveLength(1)
    expect(await calls('agent-host:bind-creation')).toEqual([])
    const createdSession: AgentHostSession = { sessionId: `ahp-session:/${operation.operationId}`, chatId: `ahp-chat:/${operation.operationId}/main`, owner: workerOwner, title: 'Mock created chat', provider: 'copilotcli', updatedAt: '', canSend: true }
    await app!.evaluate((_, { file, operationId, session }) => {
      const fs = process.getBuiltinModule('fs')
      const state = JSON.parse(fs.readFileSync(file, 'utf8')) as MockLedger
      const operation = state.operations.find((item) => item.operationId === operationId)!
      operation.state = 'created-unbound'
      operation.session = session
      operation.error = 'The chat exists, but its caller task assignment still needs to be saved.'
      fs.writeFileSync(`${file}.next`, JSON.stringify(state))
      fs.renameSync(`${file}.next`, file)
    }, { file: files.ledger, operationId: operation.operationId, session: createdSession })
    await picker.getByRole('button', { name: 'Check status', exact: true }).click()
    await expect(picker.getByRole('heading', { name: 'Created, assignment incomplete · T-0001', exact: true })).toBeVisible()
    await expect(row()).toContainText(createdSession.sessionId)
    await expect(row()).toContainText(createdSession.chatId)
    await expect(create()).toBeDisabled()
    expect(await calls('agent-host:bind-creation')).toEqual([])
    const consentBeforeBinding = (await calls('native-dialog')).length
    await picker.getByRole('button', { name: 'Retry binding', exact: true }).click()
    await expect(picker.getByRole('tab', { name: 'Current' })).toHaveAttribute('aria-selected', 'true')
    await expect(page!.getByRole('dialog', { name: 'Agent Host sessions' })).toHaveCount(0)
    const panel = page!.getByRole('complementary', { name: 'Agent Host task chat', exact: true })
    await expect(panel).toBeVisible()
    await expect(panel.getByText('Connected', { exact: true })).toBeVisible()
    const target: AgentHostTarget = { sessionId: createdSession.sessionId, chatId: createdSession.chatId, owner: createdSession.owner }
    const snapshot = JSON.parse(await readFile(files.bindingSnapshot, 'utf8')) as SessionLinksSnapshot
    expect(snapshot.document).toEqual({ schemaVersion: '2.1', bindings: { 'T-0001': [{ provider: 'agent-host', ...target }] } })
    expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(await page!.evaluate(async () => window.workspace!.getSessionLinks((await window.workspace!.getState()).current!.id))).toEqual(snapshot)
    await expect(readFile(join(workspace, '.taskcontinuum', 'session-bindings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await calls('agent-host:watch')).toEqual([{ channel: 'agent-host:watch', args: [target] }])
    expect(await calls('agent-host:bind-creation')).toEqual([{ channel: 'agent-host:bind-creation', args: [operation.operationId] }])
    expect(await calls('agent-host:create')).toHaveLength(1)
    expect(await calls('native-dialog')).toHaveLength(consentBeforeBinding)
    expect((await calls('agent-host:creation-status')).every((call) => call.args.length === 1 && call.args[0] === operation.operationId)).toBe(true)
    for (const channel of ['agent-host:send', 'agent-host:cancel', 'copilot:create', 'copilot:send', 'copilot:resume', 'copilot:import', 'workspace:update-session-link', 'external-request']) expect(await calls(channel)).toEqual([])
    expect(await readFile(taskFile, 'utf8')).toBe(taskText)
    expect(errors).toEqual([])
    expect(externalRequests).toEqual([])
    await page!.screenshot({ path: resolve('artifacts', 'agent-host-creation-recovered-desktop.png') })
    await page!.reload()
    await expect(panel.getByText('Connected', { exact: true })).toBeVisible()
    expect(await calls('agent-host:create')).toHaveLength(1)
    expect(await calls('agent-host:bind-creation')).toHaveLength(1)
    expect(errors).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
