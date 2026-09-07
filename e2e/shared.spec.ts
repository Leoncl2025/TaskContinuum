import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import type { CopilotEvent } from '../src/shared/sessions'
import type { SharedEnrollment, SharedGrant, SharedSessionDescriptor, SharedView } from '../src/shared/sharedSessions'
import { SharedSessionHost } from '../src/main/shared/host'
import { SharedJournal } from '../src/main/shared/journal'
import { startSharedServer } from '../src/main/shared/server'
import { createSharedCheckpoint } from '../src/main/shared/checkpoint'
import { registerSharedRoute } from '../src/main/shared/storage'

let app: ElectronApplication
let page: Page
let environment: Record<string, string>
let root: string
let workspace: string
let host: SharedSessionHost
let server: Awaited<ReturnType<typeof startSharedServer>> | undefined
let descriptor: SharedSessionDescriptor
let aborts = 0
const errors: string[] = []

async function closeDesktop(): Promise<void> {
  await test.step('Close only the desktop client', async () => {
    const mainPid = await test.step('Read desktop process identity', () => app.evaluate(() => process.pid), { timeout: 5000 })
    const windowClosed = page.waitForEvent('close')
    await page.getByRole('button', { name: 'Close window', exact: true }).click()
    await windowClosed
    await expect.poll(() => {
      try { process.kill(mainPid, 0); return false } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
        throw error
      }
    }, { timeout: 12000, message: 'The desktop main process must exit without stopping the detached Host.' }).toBe(true)
  }, { timeout: 20000 })
}

async function launch(): Promise<void> {
  app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('heading', { level: 1, name: 'Shared task' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Shared sessions', exact: true })).toBeEnabled()
}

async function showShared(): Promise<void> {
  await page.getByRole('button', { name: 'Shared sessions', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Shared session chat' })).toBeVisible()
}

test.beforeAll(async () => {
  root = resolve('.runtime', `shared-e2e-${Date.now()}`)
  workspace = join(root, 'planning')
  await mkdir(join(workspace, '.agentdesk'), { recursive: true })
  await mkdir(join(workspace, 'tasks', 'T-0001-shared'), { recursive: true })
  await mkdir(resolve('artifacts'), { recursive: true })
  await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Shared test workspace' }))
  await writeFile(join(workspace, 'tasks', 'T-0001-shared', 'task.json'), JSON.stringify({ schemaVersion: '1.0', id: 'T-0001', title: 'Shared task', type: 'feature', status: 'backlog', priority: 'P2', relations: { level: 'task' } }))
  for (const file of ['RequirementAnalysis.md', 'Plan.md', 'Checklist.md']) await writeFile(join(workspace, 'tasks', 'T-0001-shared', file), '# Shared test\n')
  environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_RENDERER_URL
  environment.TASKCONTINUUM_DATA_DIR = join(root, 'profile-A')
  environment.TASKCONTINUUM_WORKSPACE = workspace
  await launch()
  const actor = await page.evaluate(() => window.sharedSessions!.identity())
  const token = randomBytes(32).toString('base64url')
  const grant: SharedGrant = { id: randomUUID(), actor: { ...actor, name: 'Alice', machineName: 'Machine A' }, permissions: ['read', 'send', 'approve', 'stop', 'checkpoint'], tokenHash: createHash('sha256').update(token).digest('hex') }
  descriptor = { schemaVersion: 1, id: randomUUID(), workspaceId: randomUUID(), taskId: 'T-0001', mode: 'checkpoint', createdAt: new Date().toISOString(), owner: { machineId: 'machine-B', machineName: 'Machine B', agentId: 'agent-B', nativeSessionId: 'native-B', epoch: 1 } }
  const listeners = new Set<(event: CopilotEvent) => void>()
  host = new SharedSessionHost(descriptor, new SharedJournal(join(root, 'host-events.jsonl'), descriptor), {
    send: async (request) => { for (const listener of listeners) listener({ type: 'delta', ...request, text: 'Reply from the only Agent on B.' }) },
    abort: async () => { aborts++ }, respond: () => {}, onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  })
  await host.start()
  server = await startSharedServer({ host, getGrants: async () => [grant] })
  await registerSharedRoute(workspace, descriptor, true)
  const enrollment: SharedEnrollment = { schemaVersion: 1, session: descriptor, actor: grant.actor, permissions: grant.permissions, token, endpoint: { kind: 'local', port: server.port } }
  await writeFile(join(environment.TASKCONTINUUM_DATA_DIR, 'shared-enrollments.json'), JSON.stringify([{ enrollment }]))
})

test.afterEach(() => { expect(errors).toEqual([]) })
test.afterAll(async () => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([app?.close(), new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000) })]) } finally { clearTimeout(timer) }
  await server?.close()
  await host?.close()
})

test('routes desktop messages to B and restores the live view after the panel closes', async () => {
  await showShared()
  await page.getByRole('button', { name: 'Connect shared session', exact: true }).click()
  await expect(page.getByText('Live on Machine B', { exact: true })).toBeVisible()
  await expect(page.getByText('Alice @ Machine A', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Message shared Agent' }).fill('A asks B to continue')
  await page.getByRole('button', { name: 'Send shared message' }).click()
  await expect(page.getByRole('log', { name: 'Shared conversation' })).toContainText('Reply from the only Agent on B.')
  await expect(page.getByText('Event 4', { exact: true })).toBeVisible()
  await page.screenshot({ path: resolve('artifacts/shared-session-live.png') })
  await page.getByRole('button', { name: 'Hide shared chat' }).click()
  expect(aborts).toBe(0)
  await showShared()
  await page.getByRole('button', { name: 'Connect shared session', exact: true }).click()
  await expect(page.getByRole('log', { name: 'Shared conversation' })).toContainText('A asks B to continue')
  expect(host.journal.lastSeq).toBe(4)
})

test('retains cached events when B stops and lets a fresh C keep a verified checkpoint', async () => {
  const checkpoint = createSharedCheckpoint(descriptor, host.journal.snapshot(), { commit: 'a'.repeat(40), branch: 'main', clean: true })
  const file = join(root, 'downloaded-checkpoint.json')
  await writeFile(file, JSON.stringify(checkpoint))
  await server!.close()
  server = undefined
  await expect(page.getByText('Offline / 4 cached events', { exact: true })).toBeVisible()
  await expect(page.getByRole('log', { name: 'Shared conversation' })).toContainText('Reply from the only Agent on B.')
  await page.getByRole('textbox', { name: 'Message shared Agent' }).fill('Offline draft')
  await expect(page.getByRole('button', { name: 'Send shared message' })).toBeDisabled()
  await app.close()
  environment.TASKCONTINUUM_DATA_DIR = join(root, 'profile-C')
  await launch()
  await showShared()
  await expect(page.getByText('No shared conversation loaded', { exact: true })).toBeVisible()
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, file)
  await page.getByRole('button', { name: 'Open checkpoint', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Checkpoint continuation' })).toContainText('Reply from the only Agent on B.')
  await page.getByRole('button', { name: 'Keep offline copy', exact: true }).click()
  await expect(page.getByText('Checkpoint / 4 events', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send shared message' })).toBeDisabled()
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(380, 600); window.setSize(420, 760) })
  await page.getByRole('button', { name: 'Shared sessions', exact: true }).click()
  await page.getByRole('button', { name: 'Shared sessions', exact: true }).click()
  await page.getByRole('button', { name: 'Connect shared session', exact: true }).click()
  await expect(page.getByText('Checkpoint / 4 events', { exact: true })).toBeVisible()
  expect(await page.getByRole('complementary', { name: 'Shared session chat' }).evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
  await page.screenshot({ path: resolve('artifacts/shared-session-checkpoint-narrow.png') })
})

test('independent Host starts and survives desktop restart without invoking a model', async () => {
  test.skip(process.env.TASKCONTINUUM_HOST_LIFECYCLE !== '1', 'Opt in to local runtime startup without model requests.')
  test.setTimeout(90000)
  await app.close()
  const planning = join(root, 'lifecycle-planning')
  await mkdir(join(planning, '.agentdesk'), { recursive: true })
  await mkdir(join(planning, 'tasks', 'T-0001-shared'), { recursive: true })
  await writeFile(join(planning, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Lifecycle fixture' }))
  await writeFile(join(planning, 'tasks', 'T-0001-shared', 'task.json'), await readFile(join(workspace, 'tasks', 'T-0001-shared', 'task.json')))
  environment.TASKCONTINUUM_DATA_DIR = join(root, 'lifecycle-profile')
  environment.TASKCONTINUUM_WORKSPACE = planning
  await launch()
  await showShared()
  await page.getByRole('button', { name: 'Publish shared session', exact: true }).click()
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 45000 })
  const id = await page.getByRole('combobox', { name: 'Shared session' }).inputValue()
  const entries = JSON.parse(await readFile(join(environment.TASKCONTINUUM_DATA_DIR, 'shared-enrollments.json'), 'utf8')) as { enrollment: SharedEnrollment; hostDirectory: string }[]
  const enrollment = entries.find((entry) => entry.enrollment.session.id === id)!.enrollment
  if (enrollment.endpoint.kind !== 'local') throw new Error('Local Host expected')
  const port = enrollment.endpoint.port
  try {
    await expect(page.getByRole('button', { name: 'Disconnect shared view' })).toBeVisible()
    await closeDesktop()
    const response = await fetch(`http://127.0.0.1:${port}/session`, { headers: { Authorization: `Bearer ${enrollment.token}` }, signal: AbortSignal.timeout(5000) })
    expect(response.ok).toBe(true)
    await launch()
    await showShared()
    await page.getByRole('button', { name: 'Connect shared session', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Disconnect shared view' })).toBeVisible()
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await page.getByRole('button', { name: 'Stop shared Host', exact: true }).click()
    const hostDirectory = entries.find((entry) => entry.enrollment.session.id === id)!.hostDirectory
    await expect.poll(async () => { try { await access(join(hostDirectory, 'host.lock')); return false } catch { return true } }).toBe(true)
    await page.getByRole('button', { name: 'Restart local shared Host', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Disconnect shared view' })).toBeVisible({ timeout: 45000 })
    const resumed = await page.evaluate((id) => window.sharedSessions!.cached(id), id)
    expect(resumed.session.owner.nativeSessionId).toBe(enrollment.session.owner.nativeSessionId)
    expect(resumed.session.owner.machineId).toBe(enrollment.session.owner.machineId)
    expect(resumed.events).toEqual([])
  } finally {
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${enrollment.token}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) }).catch(() => undefined)
  }
})

test('live independent Copilot Host survives desktop restart and a reviewed checkpoint creates a new native fork', async () => {
  test.skip(process.env.TASKCONTINUUM_LIVE_SHARED !== '1', 'Opt in to two synthetic model calls through independent Hosts.')
  test.setTimeout(240000)
  await app.close()
  environment.TASKCONTINUUM_DATA_DIR = join(root, 'profile-live-B')
  const livePlanning = join(root, 'live-planning')
  await mkdir(join(livePlanning, '.agentdesk'), { recursive: true })
  await mkdir(join(livePlanning, 'tasks', 'T-0001-shared'), { recursive: true })
  await writeFile(join(livePlanning, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Live shared test' }))
  await writeFile(join(livePlanning, 'tasks', 'T-0001-shared', 'task.json'), await readFile(join(workspace, 'tasks', 'T-0001-shared', 'task.json')))
  environment.TASKCONTINUUM_WORKSPACE = livePlanning
  const code = join(root, 'execution-B')
  const clone = join(root, 'execution-C')
  await mkdir(code)
  execFileSync('git', ['init', '--quiet', code])
  await writeFile(join(code, 'README.md'), '# Synthetic shared-session test\n')
  execFileSync('git', ['-C', code, 'add', 'README.md'])
  execFileSync('git', ['-C', code, '-c', 'user.name=Task Continuum Test', '-c', 'user.email=taskcontinuum@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Create synthetic execution fixture'])
  execFileSync('git', ['clone', '--quiet', code, clone])
  await launch()
  await showShared()
  await page.getByRole('button', { name: 'Publish shared session', exact: true }).click()
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, code)
  await page.getByRole('button', { name: 'Choose shared execution directory' }).click()
  await page.getByRole('combobox', { name: 'Shared persistence mode' }).selectOption('checkpoint')
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60000 })
  await expect(page.getByRole('button', { name: 'Disconnect shared view' })).toBeVisible()
  const sourceId = await page.getByRole('combobox', { name: 'Shared session' }).inputValue()
  const source: SharedView = await page.evaluate((id) => window.sharedSessions!.cached(id), sourceId)
  const send = async (prompt: string, marker: string) => {
    const sessionId = await page.getByRole('combobox', { name: 'Shared session' }).inputValue()
    const before = (await page.evaluate((id) => window.sharedSessions!.cached(id), sessionId)).events.at(-1)?.seq ?? 0
    await page.getByRole('textbox', { name: 'Message shared Agent' }).fill(prompt)
    await page.getByRole('button', { name: 'Send shared message' }).click()
    let commandId: string | undefined
    await expect.poll(async () => {
      const view = await page.evaluate((id) => window.sharedSessions!.cached(id), sessionId)
      commandId = view.events.find((event) => event.seq > before && event.type === 'message' && event.text === prompt)?.commandId
      return Boolean(commandId)
    }).toBe(true)
    await expect.poll(async () => {
      const view = await page.evaluate((id) => window.sharedSessions!.cached(id), sessionId)
      return view.events.find((event) => event.commandId === commandId && ['completed', 'failed', 'interrupted'].includes(event.type))?.type
    }, { timeout: 90000 }).toBe('completed')
    await expect(page.getByRole('log', { name: 'Shared conversation' }).locator(`.message-assistant[data-command-id="${commandId}"]`)).toContainText(marker)
    await expect(page.getByRole('button', { name: 'Stop shared response' })).toHaveCount(0)
  }
  const activeHosts: { profile: string; id: string }[] = [{ profile: environment.TASKCONTINUUM_DATA_DIR, id: sourceId }]
  try {
    await test.step('Receive the owner Agent reply', () => send('Reply with exactly SHARED_CHECKPOINT_MARKER_X1. Do not use tools or edit any files.', 'SHARED_CHECKPOINT_MARKER_X1'), { timeout: 100000 })
    await closeDesktop()
    await test.step('Reopen desktop and reconnect to the existing Host', async () => {
      await launch()
      await showShared()
      await page.getByRole('button', { name: 'Connect shared session', exact: true }).click()
      await expect(page.getByRole('log', { name: 'Shared conversation' })).toContainText('SHARED_CHECKPOINT_MARKER_X1')
    }, { timeout: 30000 })
    const savedFile = join(root, 'live-checkpoint.json')
    await app.evaluate(({ dialog }, file) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    }, savedFile)
    await page.getByRole('button', { name: 'Export checkpoint', exact: true }).click()
    await expect(page.getByText(/Checkpoint exported to/)).toBeVisible()
    await page.screenshot({ path: resolve('artifacts/shared-live-host.png') })
    await page.getByRole('button', { name: 'Stop shared Host', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Connect shared session', exact: true })).toBeVisible()
    await closeDesktop()
    environment.TASKCONTINUUM_DATA_DIR = join(root, 'profile-live-C')
    await launch()
    await showShared()
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, savedFile)
    await page.getByRole('button', { name: 'Open checkpoint', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Checkpoint continuation' })).toContainText('SHARED_CHECKPOINT_MARKER_X1')
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }) }, clone)
    await page.getByRole('button', { name: 'Choose fork directory' }).click()
    await page.getByRole('button', { name: 'Create semantic fork', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60000 })
    const forkId = await page.getByRole('combobox', { name: 'Shared session' }).inputValue()
    activeHosts.push({ profile: environment.TASKCONTINUUM_DATA_DIR, id: forkId })
    const fork = await page.evaluate((id) => window.sharedSessions!.cached(id), forkId)
    expect(fork.session.parent?.sessionId).toBe(sourceId)
    expect(fork.session.owner.nativeSessionId).not.toBe(source.session.owner.nativeSessionId)
    expect(fork.session.owner.machineId).not.toBe(source.session.owner.machineId)
    await send('Return only the exact marker from the checkpoint history. Do not use tools or change files.', 'SHARED_CHECKPOINT_MARKER_X1')
    await page.screenshot({ path: resolve('artifacts/shared-live-semantic-fork.png') })
  } finally {
    for (const owner of activeHosts) {
      const entries = JSON.parse(await readFile(join(owner.profile, 'shared-enrollments.json'), 'utf8')) as { enrollment: SharedEnrollment }[]
      const enrollment = entries.find((entry) => entry.enrollment.session.id === owner.id)?.enrollment
      if (enrollment?.endpoint.kind === 'local') {
        await fetch(`http://127.0.0.1:${enrollment.endpoint.port}/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${enrollment.token}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) }).catch(() => undefined)
      }
    }
  }
})