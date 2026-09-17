import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { enableAutomaticLinks, prepareAutomaticLinksRepository, readDesktopBindings } from './immutable-workspace-fixture'

let app: ElectronApplication
let page: Page
let firstRoot: string
let secondRoot: string
let environment: Record<string, string>
const errors: string[] = []
const externalRequests: string[] = []

async function launch(): Promise<void> {
  app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => { if (/^(https?|wss?):/.test(request.url())) externalRequests.push(request.url()) })
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
  await page.evaluate(async () => { await window.workspace!.closeWorkspace(); localStorage.clear() })
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Create your task repository' })).toBeVisible()
})

test.afterEach(() => { expect(errors).toEqual([]); expect(externalRequests).toEqual([]) })
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
  expect(keys).toEqual(['chooseParentFolder', 'closeWorkspace', 'createRepository', 'createTask', 'getRepositoryPushPlan', 'getRepositoryStatus', 'getSessionLinks', 'getState', 'getTaskAgentInstructions', 'getTaskCreationContext', 'openFolder', 'openRecent', 'openRepositoryCreation', 'refresh', 'updateSessionLink', 'verifyRepositoryPublication'])
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
  await expect(page.getByRole('alert').filter({ hasText: 'AgentDesk workspace' })).toContainText('AgentDesk workspace')
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

test('ignores legacy workspace files and browser bindings and requires Automatic enrollment', async () => {
  const linkPath = join(firstRoot, '.taskcontinuum', 'session-bindings.json')
  await selectFolder(firstRoot)
  const workspaceId = (await page.evaluate(() => window.workspace!.getState())).current!.id
  const taskFile = join(firstRoot, 'tasks', 'T-0002-shared-id', 'task.json')
  const originalTask = await readFile(taskFile, 'utf8')
  const storageKey = `taskcontinuum:session-bindings:v1:${encodeURIComponent(workspaceId)}`
  const browserBindings = JSON.stringify({ 'T-0002': { id: 'synthetic-copilot-session', title: 'Private fixture title' } })
  const legacy = JSON.stringify({ schemaVersion: 1, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'legacy-disk-session' } } }, null, 2) + '\n'
  const enrollmentRequired = /Enable Automatic workspace links[\s\S]*backend is not ready/
  await mkdir(join(firstRoot, '.taskcontinuum'), { recursive: true })
  try {
    await page.evaluate(({ storageKey, browserBindings }) => localStorage.setItem(storageKey, browserBindings), { storageKey, browserBindings })
    await page.reload()
    await expect(page.locator('.workbench')).toHaveAttribute('aria-busy', 'false')
    await expect(readFile(linkPath)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const content of [legacy, '{invalid legacy configuration\n']) {
      await writeFile(linkPath, content)
      await page.reload()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Real workspace task')
      await expect(page.getByRole('alert').filter({ hasText: enrollmentRequired })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Review links', exact: true })).toHaveCount(0)
      await expect(page.getByRole('dialog', { name: 'Save session links to workspace' })).toHaveCount(0)
      expect(await page.evaluate(() => 'migrateSessionLinks' in window.workspace!)).toBe(false)
      await expect(page.evaluate((id) => window.workspace!.getSessionLinks(id), workspaceId)).rejects.toThrow(enrollmentRequired)
      await expect(page.evaluate((workspaceId) => window.workspace!.updateSessionLink({
        workspaceId, taskId: 'T-0002', sessionId: null, expectedRevision: null,
      }), workspaceId)).rejects.toThrow(enrollmentRequired)
      await page.getByRole('button', { name: 'Reload session links', exact: true }).click()
      await expect(page.getByRole('alert').filter({ hasText: enrollmentRequired })).toBeVisible()
      await expect(page.getByText('legacy-disk-session', { exact: true })).toHaveCount(0)
      await expect(page.getByText('synthetic-copilot-session', { exact: true })).toHaveCount(0)
      expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(browserBindings)
      expect(await readFile(linkPath, 'utf8')).toBe(content)
    }
    expect(await readFile(taskFile, 'utf8')).toBe(originalTask)
    expect(await readdir(join(firstRoot, '.taskcontinuum'))).toEqual(['session-bindings.json'])
    await page.screenshot({ path: resolve('artifacts', 'legacy-session-config-rejected.png') })
  } finally {
    await rm(linkPath, { force: true })
    await page.evaluate((key) => localStorage.removeItem(key), storageKey)
  }
})

test('initializes Automatic enrollment without importing legacy workspace or browser bindings', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(resolve('.runtime'), 'enroll-'))
  const workspace = join(root, 'workspace')
  const taskDirectory = join(workspace, 'tasks', 'T-0002-immutable')
  const previousEnvironment = environment
  try {
    await mkdir(taskDirectory, { recursive: true })
    await mkdir(join(workspace, '.agentdesk'))
    await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Immutable enrollment fixture' }))
    const taskText = JSON.stringify({ schemaVersion: '1.0', id: 'T-0002', title: 'No legacy enrollment import', type: 'feature', status: 'backlog', priority: 'P2', relations: { level: 'task', parent: null } })
    await writeFile(join(taskDirectory, 'task.json'), taskText)
    const enrolled = await prepareAutomaticLinksRepository(workspace, join(root, 'fixture'))
    const legacyPath = join(workspace, '.taskcontinuum', 'session-bindings.json')
    const legacy = JSON.stringify({ schemaVersion: 1, bindings: { 'T-0002': {
      provider: 'agent-host', hostId: 'legacy-host', sessionId: 'copilotcli:/legacy', chatId: 'ahp-chat:/legacy',
      owner: { clientId: randomUUID(), machineName: 'Legacy owner' },
    } } }, null, 2) + '\n'
    await writeFile(legacyPath, legacy)
    await app.close()
    environment = {
      ...environment, ...enrolled.environment,
      TASKCONTINUUM_DATA_DIR: join(root, 'profile'), TASKCONTINUUM_WORKSPACE: workspace,
      TASKCONTINUUM_VSCODE_USER_DATA_DIR: join(root, 'vscode'),
    }
    await launch()
    const workspaceId = (await page.evaluate(() => window.workspace!.getState())).current!.id
    const key = `taskcontinuum:session-bindings:v1:${encodeURIComponent(workspaceId)}`
    const browserBindings = JSON.stringify({ 'T-0002': { id: 'browser-session', title: 'Do not import this binding' } })
    await page.evaluate(({ key, browserBindings }) => localStorage.setItem(key, browserBindings), { key, browserBindings })
    await page.reload()
    await enableAutomaticLinks(app, page, environment.TASKCONTINUUM_DATA_DIR)
    await expect(page.getByRole('alert').filter({ hasText: 'backend is not ready' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Review links', exact: true })).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'Agent Host task chat' })).toHaveCount(0)
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(browserBindings)
    expect(await readFile(legacyPath, 'utf8')).toBe(legacy)
    await app.close()
    await launch()
    expect((await readDesktopBindings(page)).document.bindings).toEqual({})
    expect(await readFile(legacyPath, 'utf8')).toBe(legacy)
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(browserBindings)
    expect(await readFile(join(taskDirectory, 'task.json'), 'utf8')).toBe(taskText)
  } finally {
    try {
      if (environment !== previousEnvironment) {
        await app.close()
        environment = previousEnvironment
        await launch()
      }
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }) }
  }
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

test('exposes only Agent Host session controls and preserves retired session data', async () => {
  const key = 'taskcontinuum:session-bindings:v1'
  const browserBindings = JSON.stringify({ 'T-0002': { id: 'retired-cli-session', title: 'Retired CLI session' } })
  const directory = join(environment.TASKCONTINUUM_VSCODE_USER_DATA_DIR, 'User', 'workspaceStorage', 'a'.repeat(32), 'chatSessions')
  const file = join(directory, `${randomUUID()}.jsonl`)
  const history = JSON.stringify({ kind: 0, v: { customTitle: 'Retired Companion session', requests: [{ message: 'Old question', response: [{ value: 'Old answer' }] }] } }) + '\n'
  await mkdir(directory, { recursive: true })
  await writeFile(file, history)
  try {
    await page.evaluate(({ key, browserBindings }) => localStorage.setItem(key, browserBindings), { key, browserBindings })
    await page.reload()
    await expect(page.locator('.workbench')).toHaveAttribute('aria-busy', 'false')
    expect(await page.evaluate(() => ['copilot', 'vscodeChat', 'sharedSessions'].filter((name) => Reflect.has(window, name)))).toEqual([])
    expect(await page.evaluate(() => typeof window.agentHost?.list)).toBe('function')
    await selectFolder(firstRoot)
    await expect(page.getByRole('button', { name: 'Agent Host sessions', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^(Connect Copilot|New Copilot session|Connect VS Code|Shared sessions|Link to current task)$/ })).toHaveCount(0)
    await expect(page.getByText('Retired CLI session', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Retired Companion session', { exact: true })).toHaveCount(0)
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(browserBindings)
    expect(await readFile(file, 'utf8')).toBe(history)
    await expect(readFile(join(firstRoot, '.taskcontinuum', 'session-bindings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await page.evaluate((key) => localStorage.removeItem(key), key)
    await rm(file, { force: true })
  }
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