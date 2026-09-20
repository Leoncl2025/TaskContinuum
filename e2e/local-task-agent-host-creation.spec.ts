import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import type { AgentHostCreateRequest, AgentHostCreation, AgentHostWorker } from '../src/shared/agentHostCreation'
import type { SessionLinksSnapshot } from '../src/shared/sessionBindings'

interface LocalCreationLedger {
  worker: AgentHostWorker
  snapshot: SessionLinksSnapshot
  operations: AgentHostCreation[]
  calls: { channel: string; args: unknown[] }[]
}

async function installLocalCreationMock(app: ElectronApplication, ledgerFile: string, workspaceId: string): Promise<void> {
  await app.evaluate(({ ipcMain, dialog, session }, { ledgerFile, workspaceId }) => {
    const fs = process.getBuiltinModule('fs')
    const read = (): LocalCreationLedger => JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
    const save = (state: LocalCreationLedger) => {
      fs.writeFileSync(`${ledgerFile}.next`, JSON.stringify(state))
      fs.renameSync(`${ledgerFile}.next`, ledgerFile)
    }
    const record = (channel: string, args: unknown[]) => {
      const state = read()
      state.calls.push({ channel, args })
      save(state)
      return state
    }
    dialog.showMessageBox = async (...args: unknown[]) => {
      record('native-dialog', args.slice(-1))
      return { response: 0, checkboxChecked: false }
    }
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const external = /^(https?|wss?):/.test(details.url)
      if (external) record('external-request', [details.url])
      callback({ cancel: external })
    })
    const handlers: Record<string, (...args: unknown[]) => unknown> = {
      'agent-host:list': () => {
        const state = record('agent-host:list', [])
        return { sessions: state.operations.flatMap((operation) => operation.session ? [operation.session] : []), warnings: [] }
      },
      'workspace:session-links': (id) => {
        const state = record('workspace:session-links', [id])
        if (id !== workspaceId) throw new Error('The binding snapshot belongs to another fixture workspace.')
        return state.snapshot
      },
      'agent-host:creation-workers': (...args) => {
        const state = record('agent-host:creation-workers', args)
        if (args[0] !== 'T-0001') throw new Error('Discovery must target the selected task.')
        if (args.length === 1) return []
        if (args.length !== 2 || args[1] !== 'local') throw new Error('The real preload must forward the local execution location.')
        return [state.worker]
      },
      'agent-host:creations': (taskId) => record('agent-host:creations', [taskId]).operations.filter((item) => item.taskId === taskId),
      'agent-host:create': (value) => {
        const request = value as AgentHostCreateRequest
        const state = record('agent-host:create', [request])
        const workspace = state.worker.workspaces[0]
        if (request.taskId !== 'T-0001' || request.workerId !== state.worker.owner.clientId || request.workspaceId !== workspace.id || request.hostId !== 'exact-local-host' || request.expectedRevision !== workspace.expectedRevision) throw new Error('Creation did not use the local owner, current workspace, exact Host, and binding revision.')
        if (Object.keys(request).sort().join(',') !== 'expectedRevision,hostId,operationId,taskId,workerId,workspaceId') throw new Error('Creation must not include a prompt, model, or renderer-supplied path.')
        if (state.operations.length >= 2) throw new Error('More than two native creations were attempted.')
        const ordinal = state.operations.length + 1
        const target = { sessionId: `ahp-session:/${request.operationId}`, chatId: `ahp-chat:/${request.operationId}/main`, owner: state.worker.owner }
        const operation: AgentHostCreation = {
          ...request, state: 'ready', nativeLifecycle: 'creating',
          session: { ...target, title: `Created local task chat ${ordinal}`, provider: 'copilotcli', canSend: true, updatedAt: '' },
        }
        const existing = state.snapshot.document.bindings[request.taskId]
        const members = existing ? Array.isArray(existing) ? existing : [existing] : []
        state.snapshot.document = { schemaVersion: '2.1', bindings: { ...state.snapshot.document.bindings, [request.taskId]: [...members, { provider: 'agent-host', ...target }] } }
        state.snapshot.revision = process.getBuiltinModule('crypto').createHash('sha256').update(JSON.stringify(state.snapshot.document)).digest('hex')
        state.operations.push(operation)
        // This is a binding IPC fixture, not authority for a real Host connection.
        save(state)
        return operation
      },
      'agent-host:creation-status': (id) => {
        const operation = record('agent-host:creation-status', [id]).operations.find((item) => item.operationId === id)
        if (!operation) throw new Error('Unknown local creation operation.')
        return operation
      },
    }
    // Fail-fast guards prevent accidental side effects; watch/models keep their real authorization.
    for (const channel of [
      'agent-host:send', 'agent-host:cancel', 'agent-host:bind-creation',
      'agent-host:create-local', 'agent-host:local-creations', 'agent-host:local-creation-hosts', 'agent-host:local-creation-status',
      'workspace:update-session-link', 'remote-vscode:device-connect', 'remote-vscode:tunnel-login', 'remote-vscode:tunnel-publish',
      'remote-vscode:git-enable', 'copilot:create', 'copilot:send', 'copilot:resume', 'copilot:import',
    ]) handlers[channel] = (...args) => { record(channel, args); throw new Error('Unexpected side effect in the isolated local task creation test.') }
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, ...args) => handler(...args))
    }
  }, { ledgerFile, workspaceId })
}

test('creates a task-local chat through the real preload without remote creation or the workspace assistant', async () => {
  const root = resolve('.runtime', `local-task-agent-host-creation-${randomUUID()}`)
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  const discovery = join(root, 'empty-discovery')
  const home = join(root, 'home')
  const taskDirectory = join(workspace, 'tasks', 'T-0001-local-creation')
  const taskFile = join(taskDirectory, 'task.json')
  const taskText = JSON.stringify({ schemaVersion: '1.0', id: 'T-0001', title: 'Local task creation', type: 'feature', status: 'backlog', priority: 'P2', relations: { level: 'task', parent: null } })
  const ledgerFile = join(profile, 'mock-local-task-creation.json')
  const owner = { clientId: '00000000-0000-4000-8000-000000000031', machineName: 'This-computer-fixture' }
  const revision = 'e'.repeat(64)
  const worker: AgentHostWorker = {
    id: owner.clientId, owner, local: true, state: 'connected',
    hosts: [{ hostId: 'other-local-host', name: 'Other local Host', available: true }, { hostId: 'exact-local-host', name: 'Exact local Host', available: true }],
    workspaces: [{ id: 'current-canonical-task-workspace', name: 'Current local task workspace', canSend: true, taskState: 'available', expectedRevision: revision }],
  }
  let app: ElectronApplication | undefined
  const errors: string[] = []
  const externalRequests: string[] = []
  const ledger = async (): Promise<LocalCreationLedger> => JSON.parse(await readFile(ledgerFile, 'utf8'))
  const calls = async (channel: string) => (await ledger()).calls.filter((item) => item.channel === channel)
  try {
    await Promise.all([taskDirectory, profile, discovery, join(root, 'empty-vscode'), join(workspace, '.agentdesk'), join(home, 'AppData', 'Roaming'), join(home, 'AppData', 'Local')].map((directory) => mkdir(directory, { recursive: true })))
    await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Isolated local task creation' }))
    await writeFile(taskFile, taskText)
    await writeFile(ledgerFile, JSON.stringify({
      worker, snapshot: { document: { schemaVersion: '2.1', bindings: {} }, revision: null, localOwner: owner }, operations: [], calls: [],
    } satisfies LocalCreationLedger))
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    delete environment.ELECTRON_RUN_AS_NODE
    delete environment.ELECTRON_RENDERER_URL
    Object.assign(environment, {
      TASKCONTINUUM_WORKSPACE: workspace, TASKCONTINUUM_DATA_DIR: profile,
      TASKCONTINUUM_AGENT_HOST_DISCOVERY: discovery, TASKCONTINUUM_VSCODE_USER_DATA_DIR: join(root, 'empty-vscode'),
      HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    })
    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
    let page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => { if (/^(https?|wss?):/.test(request.url())) externalRequests.push(request.url()) })
    await expect(page.getByRole('heading', { level: 1, name: 'Local task creation' })).toBeVisible()
    const workspaceId = (await page.evaluate(() => window.workspace!.getState())).current!.id
    await installLocalCreationMock(app, ledgerFile, workspaceId)
    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Local task creation' })).toBeVisible()
    const security = await page.evaluate(async () => ({ info: await window.desktop!.getInfo(), require: typeof Reflect.get(window, 'require') }))
    expect(security.info.security).toEqual({ contextIsolated: true, sandboxed: true })
    expect(security.require).toBe('undefined')
    await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    const picker = page.getByRole('complementary', { name: 'Agent Host sessions', exact: true })
    await expect(page.getByRole('dialog', { name: 'Agent Host sessions' })).toHaveCount(0)
    await picker.getByRole('tab', { name: 'Create', exact: true }).click()
    const location = picker.getByRole('combobox', { name: 'Execution location', exact: true })
    await expect(location).toBeEnabled()
    await expect(location).toHaveValue('remote')
    await location.selectOption('local')
    await expect(picker.getByRole('heading', { name: 'Create on this computer', exact: true })).toBeVisible()
    await expect(picker.getByText(owner.machineName, { exact: true })).toBeVisible()
    await expect(picker.getByText('Current local task workspace', { exact: true })).toBeVisible()
    await expect(picker.getByRole('combobox', { name: 'Remote worker', exact: true })).toHaveCount(0)
    await expect(picker.getByRole('combobox', { name: 'Shared worker workspace', exact: true })).toHaveCount(0)
    const create = picker.getByRole('button', { name: 'Create and assign to T-0001', exact: true })
    await expect(create).toBeDisabled()
    await picker.getByRole('combobox', { name: 'Exact Agent Host', exact: true }).selectOption('exact-local-host')
    await expect(create).toBeEnabled()
    expect(await calls('agent-host:creation-workers')).toContainEqual({ channel: 'agent-host:creation-workers', args: ['T-0001', 'local'] })
    expect(await calls('agent-host:create')).toEqual([])
    await mkdir(resolve('artifacts'), { recursive: true })
    await page.screenshot({ path: resolve('artifacts', 'local-task-agent-host-creation-picker.png') })
    await page.screenshot({ path: resolve('artifacts', 'local-task-create-sidebar.png') })
    await create.click()
    await expect(picker.getByRole('tab', { name: 'Current' })).toHaveAttribute('aria-selected', 'true')
    const panel = page.getByRole('complementary', { name: 'Agent Host task chat', exact: true })
    await expect(panel).toBeVisible()
    const firstOperation = (await ledger()).operations[0]
    expect(firstOperation.operationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(firstOperation.session).toBeDefined()
    const firstTarget = { sessionId: firstOperation.session!.sessionId, chatId: firstOperation.session!.chatId, owner }
    await expect(panel.getByText(firstTarget.sessionId, { exact: true })).toBeVisible()
    await expect(panel.getByText(`Copilot @ ${owner.machineName}`, { exact: true })).toBeVisible()
    await expect(panel.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('')

    await picker.getByRole('tab', { name: 'Create', exact: true }).click()
    await expect(location).toBeEnabled()
    await location.selectOption('local')
    await picker.getByRole('combobox', { name: 'Exact Agent Host', exact: true }).selectOption('exact-local-host')
    await expect(create).toBeEnabled()
    await create.click()
    await expect(picker.getByRole('tab', { name: 'Current' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tree', { name: 'Sessions for T-0001' }).getByRole('treeitem')).toHaveCount(3)
    await expect(page.getByRole('dialog', { name: 'Agent Host sessions' })).toHaveCount(0)
    await page.screenshot({ path: resolve('artifacts', 'multi-session-tree.png') })
    const secondOperation = (await ledger()).operations[1]
    expect(secondOperation.operationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(secondOperation.operationId).not.toBe(firstOperation.operationId)
    const secondTarget = { sessionId: secondOperation.session!.sessionId, chatId: secondOperation.session!.chatId, owner }
    await expect(panel.getByText(secondTarget.sessionId, { exact: true })).toBeVisible()
    expect(await calls('agent-host:create')).toEqual([
      { channel: 'agent-host:create', args: [{ operationId: firstOperation.operationId, taskId: 'T-0001', workerId: owner.clientId, workspaceId: worker.workspaces[0].id, hostId: 'exact-local-host', expectedRevision: revision }] },
      { channel: 'agent-host:create', args: [{ operationId: secondOperation.operationId, taskId: 'T-0001', workerId: owner.clientId, workspaceId: worker.workspaces[0].id, hostId: 'exact-local-host', expectedRevision: revision }] },
    ])
    const snapshot = (await ledger()).snapshot
    expect(snapshot.document).toEqual({ schemaVersion: '2.1', bindings: { 'T-0001': [{ provider: 'agent-host', ...firstTarget }, { provider: 'agent-host', ...secondTarget }] } })
    expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(await page.evaluate(async () => window.workspace!.getSessionLinks((await window.workspace!.getState()).current!.id))).toEqual(snapshot)
    // Opening a bound panel is distinct from connecting: the real authorization rejects fixture-only bindings.
    await expect(panel.getByRole('alert').first()).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    await page.reload()
    await expect(panel.getByText(firstTarget.sessionId, { exact: true })).toBeVisible()
    expect(await calls('agent-host:create')).toHaveLength(2)
    await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    await expect(page.getByRole('tree', { name: 'Sessions for T-0001' }).getByRole('treeitem')).toHaveCount(3)
    await expect(page.getByRole('dialog', { name: 'Agent Host sessions' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Open Created local task chat 2' }).click()
    await expect(panel.getByText(secondTarget.sessionId, { exact: true })).toBeVisible()
    await app.close()
    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => { if (/^(https?|wss?):/.test(request.url())) externalRequests.push(request.url()) })
    await expect(page.getByRole('heading', { level: 1, name: 'Local task creation' })).toBeVisible()
    const restartedWorkspaceId = (await page.evaluate(() => window.workspace!.getState())).current!.id
    await installLocalCreationMock(app, ledgerFile, restartedWorkspaceId)
    await page.reload()
    const restoredPanel = page.getByRole('complementary', { name: 'Agent Host task chat', exact: true })
    await expect(restoredPanel.getByText(firstTarget.sessionId, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Agent Host sessions' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Open Created local task chat 2' }).click()
    await expect(restoredPanel.getByText(secondTarget.sessionId, { exact: true })).toBeVisible()
    expect((await ledger()).snapshot).toEqual(snapshot)
    const allowedChannels = new Set(['agent-host:list', 'agent-host:creation-workers', 'agent-host:creations', 'agent-host:create', 'agent-host:creation-status', 'workspace:session-links'])
    expect((await ledger()).calls.filter((item) => !allowedChannels.has(item.channel))).toEqual([])
    expect((await calls('agent-host:creation-workers')).every((item) => item.args[0] === 'T-0001' && (item.args.length === 1 || item.args.length === 2 && item.args[1] === 'local'))).toBe(true)
    await expect(readFile(join(workspace, '.taskcontinuum', 'session-bindings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(taskFile, 'utf8')).toBe(taskText)
    expect(errors).toEqual([])
    expect(externalRequests).toEqual([])
  } finally {
    try { await app?.close() } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
  }
})
