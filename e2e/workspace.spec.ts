import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { hostname, userInfo } from 'node:os'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { startVSCodeChatCompanion } from '../src/main/vscodeChatCompanion'
import { vsCodeBridgeConnectUri, vsCodeChatResource } from '../src/shared/vscodeChat'
import { deliveryPrompt } from '../src/main/vscodeChatDelivery'

let app: ElectronApplication
let page: Page
let firstRoot: string
let secondRoot: string
let environment: Record<string, string>
const errors: string[] = []

async function launch(): Promise<void> {
  app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.locator('.workbench')).toHaveAttribute('aria-busy', 'false')
}

async function selectFolder(root: string | null): Promise<void> {
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: root === null, filePaths: root ? [root] : [] })
  }, root)
  await page.getByRole('button', { name: 'Open workspace folder', exact: true }).click()
  await expect(page.locator('.workbench')).toHaveAttribute('aria-busy', 'false')
}

test.beforeAll(async () => {
  const root = resolve('.runtime', `workspace-e2e-${Date.now()}`)
  firstRoot = join(root, 'TaskContinuum-ad')
  secondRoot = join(root, 'Another-ad')
  await mkdir(resolve('artifacts'), { recursive: true })
  for (const [folder, title, status] of [[firstRoot, 'Real workspace task', 'done'], [secondRoot, 'Other workspace task', 'blocked']]) {
    const directory = join(folder, 'tasks', 'T-0002-shared-id')
    await mkdir(directory, { recursive: true })
    await mkdir(join(folder, '.agentdesk'))
    await writeFile(join(folder, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Planning workspace' }))
    await writeFile(join(directory, 'task.json'), JSON.stringify({ schemaVersion: '1.0', id: 'T-0002', title, type: 'feature', status, priority: 'P2', owner: 'Local user', summary: 'Loaded from task.json', relations: { level: 'task', parent: null }, today: { nextAction: 'Review the on-disk plan' } }))
    await writeFile(join(directory, 'RequirementAnalysis.md'), '# Real requirements\n\n| ID | Requirement |\n|---|---|\n| FR-01 | Show this on-disk requirement. |\n')
    await writeFile(join(directory, 'Plan.md'), '# Real plan\n\n1. Read from the selected workspace.\n')
    await writeFile(join(directory, 'Checklist.md'), '# Acceptance\n\n- [x] `CL-001` First criterion\n- [ ] `CL-002` Second criterion\n')
  }
  environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_RENDERER_URL
  delete environment.TASKCONTINUUM_WORKSPACE
  environment.TASKCONTINUUM_DATA_DIR = join(root, 'profile')
  environment.TASKCONTINUUM_VSCODE_USER_DATA_DIR = join(root, 'vscode')
  await launch()
})

test.beforeEach(async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setMinimumSize(380, 600)
    window.setSize(1440, 940)
  })
  await page.evaluate(async () => { await window.workspace!.useDemo(); localStorage.clear() })
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'UI based on Electron' })).toBeVisible()
})

test.afterEach(() => { expect(errors).toEqual([]) })
test.afterAll(async () => { await app?.close() })

test('opens a real folder through the restricted native bridge and reads task documents', async () => {
  const original = await readFile(join(firstRoot, 'tasks', 'T-0002-shared-id', 'Checklist.md'), 'utf8')
  await selectFolder(firstRoot)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Real workspace task')
  await expect(page.getByRole('combobox', { name: 'Workspace' })).toHaveValue((await page.evaluate(() => window.workspace!.getState())).current!.id)
  await expect(page.getByRole('combobox', { name: 'Task status' })).toBeDisabled()
  await expect(page.getByRole('combobox', { name: 'Task status' })).toHaveValue('done')
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '50')
  await expect(page.getByText('Sample task', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Create demo task' })).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: /First criterion/ })).toBeDisabled()
  await page.getByRole('tab', { name: 'Requirements', exact: true }).click()
  await expect(page.getByRole('table')).toContainText('Show this on-disk requirement.')
  expect(await readFile(join(firstRoot, 'tasks', 'T-0002-shared-id', 'Checklist.md'), 'utf8')).toBe(original)
  const keys = await page.evaluate(() => Object.keys(window.workspace!).sort())
  expect(keys).toEqual(['getSessionLinks', 'getState', 'migrateSessionLinks', 'openFolder', 'openRecent', 'refresh', 'updateSessionLink', 'useDemo'])
  await page.screenshot({ path: resolve('artifacts/workspace-documents.png') })
})

test('switches recent folders with the same task ID and retains the workspace on cancellation or failure', async () => {
  await selectFolder(firstRoot)
  const firstId = (await page.evaluate(() => window.workspace!.getState())).current!.id
  await selectFolder(secondRoot)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Other workspace task')
  await expect(page.getByRole('combobox', { name: 'Task status' })).toHaveValue('blocked')
  await page.getByRole('combobox', { name: 'Workspace' }).selectOption(firstId)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Real workspace task')
  await expect(page.getByRole('tab', { name: 'Other workspace task', exact: true })).toHaveCount(0)
  await selectFolder(null)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Real workspace task')
  await selectFolder(join(secondRoot, 'tasks'))
  await expect(page.getByRole('alert')).toContainText('AgentDesk workspace')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Real workspace task')
  await page.getByRole('button', { name: 'Dismiss workspace error' }).click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(420, 760))
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Workspace' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open workspace folder', exact: true })).toBeInViewport()
  await expect(page.getByRole('button', { name: 'Refresh workspace', exact: true })).toBeInViewport()
  expect(await page.getByRole('complementary', { name: 'Task explorer' }).evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: resolve('artifacts/workspace-picker-narrow.png') })
})

test('restores the last selected workspace after a full desktop restart', async () => {
  await selectFolder(secondRoot)
  const selected = (await page.evaluate(() => window.workspace!.getState())).current!
  await app.close()
  await launch()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Other workspace task')
  await expect(page.getByRole('combobox', { name: 'Workspace' })).toHaveValue(selected.id)
  const restored = await page.evaluate(() => window.workspace!.getState())
  expect(restored.current?.root).toBe(secondRoot)
  expect(restored.recent.some((item) => item.id === selected.id)).toBe(true)
})

test('stores reviewed task/session links in Git-visible files independently of the desktop profile', async () => {
  const linkPath = join(firstRoot, '.taskcontinuum', 'session-bindings.json')
  await selectFolder(firstRoot)
  const workspaceId = (await page.evaluate(() => window.workspace!.getState())).current!.id
  const taskFile = join(firstRoot, 'tasks', 'T-0002-shared-id', 'task.json')
  const originalTask = await readFile(taskFile, 'utf8')
  await page.evaluate((workspaceId) => localStorage.setItem(`taskcontinuum:session-bindings:v1:${encodeURIComponent(workspaceId)}`, JSON.stringify({
    'T-0002': { id: 'synthetic-copilot-session', title: 'Private fixture title' },
  })), workspaceId)
  await page.reload()
  await page.getByRole('button', { name: 'Review links', exact: true }).click()
  const review = page.getByRole('dialog', { name: 'Save session links to workspace' })
  await expect(review).toContainText('synthetic-copilot-session')
  await expect(review).not.toContainText('Private fixture title')
  await expect(review).toContainText('.taskcontinuum/session-bindings.json')
  await page.screenshot({ path: resolve('artifacts/repository-session-link-review.png') })
  await review.getByRole('button', { name: 'Save links to workspace' }).click()
  await expect(review).toBeHidden()
  const content = await readFile(linkPath, 'utf8')
  expect(JSON.parse(content)).toEqual({ schemaVersion: 1, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'synthetic-copilot-session' } } })
  expect(content).not.toContain('Private fixture title')
  expect(content).not.toContain(firstRoot)
  execFileSync('git', ['init', '--quiet', firstRoot])
  const untracked = execFileSync('git', ['-C', firstRoot, 'ls-files', '--others', '--exclude-standard', '.taskcontinuum/session-bindings.json'], { encoding: 'utf8' })
  expect(untracked.trim()).toBe('.taskcontinuum/session-bindings.json')
  expect(execFileSync('git', ['-C', firstRoot, 'check-ignore', '.taskcontinuum/session-bindings.lock', '.taskcontinuum/session-bindings.scratch.tmp'], { encoding: 'utf8' }).trim().split(/\r?\n/)).toEqual(['.taskcontinuum/session-bindings.lock', '.taskcontinuum/session-bindings.scratch.tmp'])
  const originalProfile = environment.TASKCONTINUUM_DATA_DIR
  await app.close()
  environment.TASKCONTINUUM_DATA_DIR = resolve(firstRoot, '..', 'fresh-profile')
  environment.TASKCONTINUUM_WORKSPACE = firstRoot
  await launch()
  delete environment.TASKCONTINUUM_WORKSPACE
  await expect(page.getByText('synthetic-copilot-session', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review links', exact: true })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message to Copilot' })).toBeDisabled()
  const disk = await page.evaluate((id) => window.workspace!.getSessionLinks(id), workspaceId)
  expect(disk.document.bindings['T-0002'].sessionId).toBe('synthetic-copilot-session')
  const changed = JSON.stringify({ schemaVersion: 1, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'externally-changed-session' } } }, null, 2) + '\n'
  await writeFile(linkPath, changed)
  await page.getByRole('button', { name: 'Detach conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Detach session', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('changed on disk')
  expect(await readFile(linkPath, 'utf8')).toBe(changed)
  await page.getByRole('button', { name: 'Keep conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Reload session links' }).click()
  await expect(page.getByText('externally-changed-session', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Detach conversation', exact: true }).click()
  await page.getByRole('button', { name: 'Detach session', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  expect(JSON.parse(await readFile(linkPath, 'utf8')).bindings).toEqual({})
  expect(await readFile(taskFile, 'utf8')).toBe(originalTask)
  await app.close()
  await rm(join(firstRoot, '.taskcontinuum'), { recursive: true })
  environment.TASKCONTINUUM_DATA_DIR = originalProfile
  await launch()
})

test('renders a navigable multilevel task tree with independent folding and visible ancestor paths', async () => {
  const treeRoot = resolve(firstRoot, '..', 'Tree-ad')
  await mkdir(join(treeRoot, '.agentdesk'), { recursive: true })
  await writeFile(join(treeRoot, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Task hierarchy' }))
  for (const [id, title, parent] of [
    ['T-0001', 'Tree MVP', null],
    ['T-0002', 'Electron UI', 'T-0001'],
    ['T-0003', 'Backend service', 'T-0001'],
    ['T-0005', 'Design Task Continuum icon', 'T-0002'],
  ]) {
    const directory = join(treeRoot, 'tasks', `${id}-tree-fixture`)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'task.json'), JSON.stringify({ schemaVersion: '1.0', id, title, type: 'feature', status: 'backlog', priority: 'P2', owner: 'Local user', relations: { level: parent ? 'task' : 'epic', parent } }))
    for (const document of ['RequirementAnalysis.md', 'Plan.md', 'Checklist.md']) await writeFile(join(directory, document), '# Tree fixture\n')
  }
  await selectFolder(treeRoot)
  const tree = page.getByRole('tree', { name: 'Tasks' })
  const root = tree.getByRole('treeitem', { name: 'T-0001 Tree MVP', exact: true })
  const parent = tree.getByRole('treeitem', { name: 'T-0002 Electron UI', exact: true })
  const leaf = tree.getByRole('treeitem', { name: 'T-0005 Design Task Continuum icon', exact: true })
  await expect(leaf).toHaveAttribute('aria-level', '3')
  const order = await tree.getByRole('treeitem').evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')))
  expect(order).toEqual(['T-0001 Tree MVP', 'T-0002 Electron UI', 'T-0005 Design Task Continuum icon', 'T-0003 Backend service'])
  const boxes = await Promise.all([root, parent, leaf].map((item) => item.locator(':scope > .tree-row').boundingBox()))
  expect(boxes[1]!.x - boxes[0]!.x).toBeGreaterThanOrEqual(18)
  expect(boxes[2]!.x - boxes[1]!.x).toBeGreaterThanOrEqual(18)
  await page.screenshot({ path: resolve('artifacts/task-tree-desktop.png') })
  await tree.getByRole('button', { name: 'Collapse T-0002', exact: true }).click()
  await expect(leaf).toHaveCount(0)
  await expect(tree.getByRole('treeitem', { name: 'T-0003 Backend service', exact: true })).toBeVisible()
  await parent.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(leaf).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Design Task Continuum icon')
  await tree.getByRole('button', { name: 'Collapse T-0001', exact: true }).click()
  await page.getByRole('textbox', { name: 'Filter tasks' }).fill('icon')
  await expect(tree.getByRole('treeitem')).toHaveCount(3)
  await expect(leaf).toBeVisible()
  await page.getByRole('textbox', { name: 'Filter tasks' }).fill('')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(420, 760))
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(leaf).toBeInViewport()
  const fits = await tree.locator('.tree-row').evaluateAll((rows) => rows.every((row) => {
    const box = row.getBoundingClientRect()
    return box.left >= 0 && box.right <= innerWidth && row.scrollWidth <= row.clientWidth
  }))
  expect(fits).toBe(true)
  await page.screenshot({ path: resolve('artifacts/task-tree-narrow.png') })
})

test('links an original VS Code conversation with long history without import and keeps its repository identity after restart', async () => {
  const nativeSessionId = randomUUID()
  const workspaceStorageId = 'a'.repeat(32)
  const storageRoot = join(environment.TASKCONTINUUM_VSCODE_USER_DATA_DIR, 'User', 'workspaceStorage')
  const directory = join(storageRoot, workspaceStorageId, 'chatSessions')
  await mkdir(directory, { recursive: true })
  const sourceFile = join(directory, `${nativeSessionId}.jsonl`)
  const progress = JSON.stringify({ kind: 1, k: ['requests', 0, 'response'], v: [{ kind: 'toolInvocation', value: 'x'.repeat(256 * 1024) }] }) + '\n'
  const source = JSON.stringify({ kind: 0, v: { customTitle: 'Original VS Code link fixture', requests: [{ message: { text: 'Existing original question' }, response: [] }] } }) + '\n'
    + progress.repeat(132) + JSON.stringify({ kind: 1, k: ['requests', 0, 'response'], v: [{ value: 'Existing original answer' }] }) + '\n'
  expect(Buffer.byteLength(source)).toBeGreaterThan(32 * 1024 * 1024)
  await writeFile(sourceFile, source)
  let opened: string | undefined
  const companion = await startVSCodeChatCompanion({
    storageRoot, workspaceStorageId, discoveryDirectory: join(storageRoot, workspaceStorageId, 'taskcontinuum.vscode-bridge', 'bridges'),
    vscodeVersion: '1.136.1', open: async (resource) => { opened = resource },
  })
  const taskFile = join(firstRoot, 'tasks', 'T-0002-shared-id', 'task.json')
  const originalTask = await readFile(taskFile, 'utf8')
  const linkFile = join(firstRoot, '.taskcontinuum', 'session-bindings.json')
  try {
    await selectFolder(firstRoot)
    const surface = await page.evaluate(() => Object.keys(window.vscodeChat!).sort())
    expect(surface).toEqual(['connect', 'onChange', 'open', 'read', 'send', 'watch'])
    await page.getByRole('button', { name: 'Sessions', exact: true }).click()
    await page.getByRole('button', { name: 'Preview Original VS Code link fixture' }).click()
    await expect(page.getByRole('button', { name: 'Continue in new session' })).toBeHidden()
    await page.getByRole('button', { name: 'Link to current task' }).click()
    const panel = page.getByRole('complementary', { name: 'VS Code task chat' })
    await expect(panel.getByRole('log')).toContainText('Existing original answer')
    await expect(panel.getByRole('button', { name: 'Send to original VS Code session' })).toBeDisabled()
    const expected = { provider: 'vscode-copilot', sessionId: nativeSessionId, workspaceStorageId, owner: expect.objectContaining({ clientId: expect.any(String), machineName: expect.any(String) }) }
    expect(JSON.parse(await readFile(linkFile, 'utf8')).bindings['T-0002']).toEqual(expected)
    expect((await page.evaluate(() => window.copilot!.getStatus())).state).toBe('disconnected')
    await panel.getByRole('button', { name: 'Open in VS Code' }).click()
    await expect.poll(() => opened).toBe(vsCodeChatResource(nativeSessionId))
    await expect(page.getByRole('button', { name: 'Original session linked' })).toBeVisible()
    await page.screenshot({ path: resolve('artifacts/vscode-linked-desktop.png') })
    const appended = JSON.stringify({ kind: 2, k: ['requests', 0, 'response', 0, 'value'], v: ' updated in VS Code' }) + '\n'
    await writeFile(sourceFile, source + appended)
    await expect(panel.getByRole('log')).toContainText('Existing original answer updated in VS Code')
    await app.close()
    await launch()
    await expect(page.getByRole('complementary', { name: 'VS Code task chat' }).getByRole('log')).toContainText('Existing original answer updated in VS Code')
    expect(JSON.parse(await readFile(linkFile, 'utf8')).bindings['T-0002']).toEqual(expected)
    expect((await page.evaluate(() => window.copilot!.getStatus())).state).toBe('disconnected')
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(380, 600); window.setSize(420, 760) })
    await page.getByRole('button', { name: 'Toggle chat panel' }).click()
    const narrowPanel = page.getByRole('complementary', { name: 'VS Code task chat' })
    await expect(narrowPanel.getByRole('button', { name: 'Open in VS Code' })).toBeInViewport()
    expect(await narrowPanel.evaluate((element) => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().right <= innerWidth)).toBe(true)
    await page.screenshot({ path: resolve('artifacts/vscode-linked-narrow.png') })
    await narrowPanel.getByRole('button', { name: 'Detach conversation' }).click()
    await page.getByRole('button', { name: 'Detach session', exact: true }).click()
    await expect(narrowPanel).toBeHidden()
    expect(JSON.parse(await readFile(linkFile, 'utf8')).bindings).toEqual({})
    expect(await readFile(taskFile, 'utf8')).toBe(originalTask)
    expect(await readFile(sourceFile, 'utf8')).toBe(source + appended)
    expect((await readdir(directory)).filter((file) => /\.jsonl?$/.test(file))).toEqual([`${nativeSessionId}.jsonl`])
  } finally { await companion.close(); await rm(sourceFile, { force: true }) }
})

test('sends from the desktop with original-session identity and preserves user and Agent machine attribution', async () => {
  const nativeSessionId = randomUUID()
  const workspaceStorageId = 'b'.repeat(32)
  const storageRoot = join(environment.TASKCONTINUUM_VSCODE_USER_DATA_DIR, 'User', 'workspaceStorage')
  const directory = join(storageRoot, workspaceStorageId, 'chatSessions')
  await mkdir(directory, { recursive: true })
  const sourceFile = join(directory, `${nativeSessionId}.jsonl`)
  const previousRequestId = randomUUID()
  await writeFile(sourceFile, JSON.stringify({ kind: 0, v: {
    customTitle: 'Attributed original conversation', requesterUsername: 'Previous user', responderUsername: 'GitHub Copilot',
    inputState: { mode: { id: 'agent', kind: 'agent' }, inputText: '' },
    requests: [{ requestId: previousRequestId, message: { text: 'Earlier question' }, response: [{ value: 'Earlier answer' }], result: {} }],
  } }) + '\n')
  let requests = 0
  let acceptedRequestId = ''
  const startCompanion = () => startVSCodeChatCompanion({
    storageRoot, workspaceStorageId, discoveryDirectory: join(storageRoot, workspaceStorageId, 'taskcontinuum.vscode-bridge', 'bridges'),
    vscodeVersion: '1.136.1', open: async () => {},
    dispatch: async (identity, delivery) => {
      expect(identity).toEqual({ nativeSessionId, workspaceStorageId })
      expect(delivery.participant.username).toBe(userInfo().username)
      requests++
      acceptedRequestId = randomUUID()
      await appendFile(sourceFile, JSON.stringify({ kind: 2, k: ['requests'], v: [{
        requestId: acceptedRequestId, message: { text: deliveryPrompt(delivery) },
        agent: { name: 'copilot', fullName: 'GitHub Copilot' },
        response: [{ value: 'Desktop delivery confirmed in the original conversation.' }], result: {},
      }] }) + '\n')
      return { state: 'submitted', nativeRequestId: acceptedRequestId }
    },
  })
  let companion: Awaited<ReturnType<typeof startVSCodeChatCompanion>> | undefined
  const linkFile = join(firstRoot, '.taskcontinuum', 'session-bindings.json')
  try {
    await selectFolder(firstRoot)
    await page.getByRole('button', { name: 'Sessions', exact: true }).click()
    await page.getByRole('button', { name: 'Preview Attributed original conversation' }).click()
    await page.getByRole('button', { name: 'Link to current task' }).click()
    const panel = page.getByRole('complementary', { name: 'VS Code task chat' })
    await expect(panel.getByText('Not connected', { exact: true })).toBeVisible()
    await expect(panel.getByRole('log')).toContainText('Previous user')
    await panel.getByRole('textbox', { name: 'Message original VS Code Agent' }).fill('Continue the original session from the desktop')
    await expect(panel.getByRole('button', { name: 'Send to original VS Code session' })).toBeDisabled()
    await expect(panel.getByRole('button', { name: 'Send to original VS Code session' })).toHaveAccessibleDescription('The original VS Code workspace is not connected.')
    const connection = await app.evaluateHandle(({ shell }) => {
      const original = shell.openExternal
      const addresses: string[] = []
      shell.openExternal = async (uri) => { addresses.push(uri) }
      return { addresses, restore: () => { shell.openExternal = original } }
    })
    try {
      await expect(page.evaluate(async (workspaceStorageId) => window.vscodeChat!.connect!({ nativeSessionId: '../other', workspaceStorageId }), workspaceStorageId)).rejects.toThrow()
      await panel.getByRole('button', { name: 'Connect VS Code' }).click()
      await expect.poll(() => connection.evaluate((probe) => probe.addresses)).toEqual([vsCodeBridgeConnectUri({ nativeSessionId, workspaceStorageId })])
    } finally { await connection.evaluate((probe) => probe.restore()); await connection.dispose() }
    expect(requests).toBe(0)
    await expect(panel.getByRole('textbox', { name: 'Message original VS Code Agent' })).toHaveValue('Continue the original session from the desktop')
    await page.screenshot({ path: resolve('artifacts/vscode-connect-desktop.png') })
    companion = await startCompanion()
    await expect(panel.getByText(`GitHub Copilot @ ${hostname()}`, { exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Send to original VS Code session' })).toBeEnabled()
    await expect(panel.getByRole('textbox', { name: 'Message original VS Code Agent' })).toHaveValue('Continue the original session from the desktop')
    await panel.getByRole('button', { name: 'Send to original VS Code session' }).click()
    await expect(panel.getByRole('log')).toContainText('Desktop delivery confirmed in the original conversation.')
    const userMessage = panel.locator(`.message-user[data-request-id="${acceptedRequestId}"]`)
    const answer = panel.locator(`.message-assistant[data-request-id="${acceptedRequestId}"]`)
    await expect(userMessage.locator('header')).toContainText(userInfo().username)
    await expect(userMessage).toContainText('Continue the original session from the desktop')
    await expect(userMessage).not.toContainText('Task Continuum message ID:')
    await expect(answer.locator('header')).toContainText(`GitHub Copilot @ ${hostname()}`)
    expect(requests).toBe(1)
    expect((await page.evaluate(() => window.copilot!.getStatus())).state).toBe('disconnected')
    expect(JSON.parse(await readFile(linkFile, 'utf8')).bindings['T-0002']).toEqual({ provider: 'vscode-copilot', sessionId: nativeSessionId, workspaceStorageId, owner: expect.objectContaining({ clientId: expect.any(String), machineName: expect.any(String) }) })
    await page.screenshot({ path: resolve('artifacts/vscode-sending-desktop.png') })
    await app.close()
    await launch()
    const restoredPanel = page.getByRole('complementary', { name: 'VS Code task chat' })
    await expect(restoredPanel.locator(`.message-assistant[data-request-id="${acceptedRequestId}"] header`)).toContainText(`GitHub Copilot @ ${hostname()}`)
    await companion.close()
    companion = undefined
    await restoredPanel.getByRole('button', { name: 'Refresh original conversation' }).click()
    await expect(restoredPanel.getByRole('button', { name: 'Send to original VS Code session' })).toBeDisabled()
    await expect(restoredPanel.getByRole('log')).toContainText(userInfo().username)
    await expect(restoredPanel.getByRole('log')).toContainText(`GitHub Copilot @ ${hostname()}`)
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(380, 600); window.setSize(420, 760) })
    await page.getByRole('button', { name: 'Toggle chat panel' }).click()
    const compactPanel = page.getByRole('complementary', { name: 'VS Code task chat' })
    await expect(compactPanel.getByRole('button', { name: 'Connect VS Code' })).toBeInViewport()
    await expect(compactPanel.getByRole('button', { name: 'Open in VS Code' })).toBeInViewport()
    await expect(compactPanel.getByRole('textbox', { name: 'Message original VS Code Agent' })).toBeInViewport()
    await expect(compactPanel.getByRole('button', { name: 'Send to original VS Code session' })).toBeInViewport()
    expect(await compactPanel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: resolve('artifacts/vscode-sending-narrow.png') })
    await compactPanel.getByRole('button', { name: 'Detach conversation' }).click()
    await page.getByRole('button', { name: 'Detach session', exact: true }).click()
    await expect(compactPanel).toBeHidden()
    expect(requests).toBe(1)
    expect((await readFile(sourceFile, 'utf8')).includes('Desktop delivery confirmed in the original conversation.')).toBe(true)
  } finally { await companion?.close() }
})

test('opens the explicitly requested local planning repository without changing any source file', async () => {
  const root = process.env.TASKCONTINUUM_VERIFY_WORKSPACE
  test.skip(!root, 'Set TASKCONTINUUM_VERIFY_WORKSPACE for a read-only check of an existing workspace.')
  const directory = resolve(root!)
  const entries = await readdir(join(directory, 'tasks'), { withFileTypes: true })
  const files = [join(directory, '.agentdesk', 'config.json')]
  const expected: { id: string; title: string; status: string }[] = []
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const folder = join(directory, 'tasks', entry.name)
    expected.push(JSON.parse(await readFile(join(folder, 'task.json'), 'utf8')) as { id: string; title: string; status: string })
    files.push(...['task.json', 'RequirementAnalysis.md', 'Plan.md', 'Checklist.md'].map((name) => join(folder, name)))
  }
  const hash = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')
  const before = await Promise.all(files.map(hash))
  await selectFolder(directory)
  const state = await page.evaluate(() => window.workspace!.getState())
  expect(state.current?.name).toBe(basename(directory))
  expect(state.current?.warnings).toEqual([])
  expect(state.current?.tasks.map(({ id, title, status }) => ({ id, title, status })).sort((left, right) => left.id.localeCompare(right.id))).toEqual(expected.map(({ id, title, status }) => ({ id, title, status })).sort((left, right) => left.id.localeCompare(right.id)))
  const selected = expected.find((item) => item.id === 'T-0002') ?? expected[0]
  if (selected) {
    await page.getByRole('button', { name: `${selected.id} ${selected.title}`, exact: true }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(selected.title)
    await expect(page.getByRole('combobox', { name: 'Task status' })).toHaveValue(selected.status)
  }
  await page.screenshot({ path: resolve('artifacts/workspace-taskcontinuum-ad.png') })
  expect(await Promise.all(files.map(hash))).toEqual(before)
})