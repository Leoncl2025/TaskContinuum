import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { startAgentHostCreationFixture } from '../test/agent-host-creation-fixture'
import { makeConfig } from '../test/taskDocuments/fixtures'
import { canonicalPolicyRoot } from '../src/main/linkedSessionPolicy'

const execute = promisify(execFile)

test('creates a local workspace conversation, chats natively, and resumes without task bindings', async () => {
  test.setTimeout(90000)
  await mkdir(resolve('.runtime'), { recursive: true })
  await mkdir(resolve('artifacts'), { recursive: true })
  const root = await mkdtemp(join(resolve('.runtime'), 'local-task-agent-'))
  const workspace = join(root, 'empty-tasks')
  const discovery = join(root, 'discovery')
  const profile = join(root, 'profile')
  const native = await startAgentHostCreationFixture()
  native.setModels([{ id: 'local-model', name: 'Local fixture model', provider: 'copilotcli' }])
  native.setLifecycle('creating')
  let app: ElectronApplication | undefined
  let page: Page
  const errors: string[] = []
  const network: string[] = []
  try {
    await mkdir(join(workspace, '.agentdesk'), { recursive: true })
    await mkdir(join(workspace, 'tasks'))
    await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify(makeConfig({ workspace: 'Local planning' })))
    await mkdir(discovery)
    await writeFile(join(discovery, 'host.json'), JSON.stringify(native.endpoint))
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    delete environment.ELECTRON_RUN_AS_NODE
    delete environment.ELECTRON_RENDERER_URL
    Object.assign(environment, {
      TASKCONTINUUM_WORKSPACE: workspace,
      TASKCONTINUUM_DATA_DIR: profile,
      TASKCONTINUUM_AGENT_HOST_DISCOVERY: discovery,
      TASKCONTINUUM_VSCODE_USER_DATA_DIR: join(root, 'no-vscode-profile'),
    })
    const launch = async () => {
      app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
      page = await app.firstWindow()
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('request', (request) => { if (/^(https?|wss?):/.test(request.url())) network.push(request.url()) })
      await expect(page.locator('.workbench')).toHaveAttribute('aria-busy', 'false')
    }
    const expectCreationActionsToFit = async () => {
      const buttons = page!.locator('.sidebar-repository-action, .sidebar-task-actions > button')
      await expect(buttons).toHaveCount(3)
      for (const button of await buttons.all()) await expect(button).toBeVisible()
      expect(await buttons.evaluateAll((elements) => elements.every((element) => {
        const bounds = element.getBoundingClientRect()
        const children = [...element.children].map((child) => child.getBoundingClientRect())
        return element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight
          && children.every((child) => child.left >= bounds.left && child.right <= bounds.right && child.top >= bounds.top && child.bottom <= bounds.bottom)
          && children[0].right <= children[1].left
          && (!element.closest('.sidebar-task-actions') || children[1].height <= Number.parseFloat(getComputedStyle(element).lineHeight))
      }))).toBe(true)
    }
    await launch()
    const explorerSash = page!.getByRole('separator', { name: 'Resize Explorer', exact: true })
    await explorerSash.press('Home')
    await expect(explorerSash).toHaveAttribute('aria-valuenow', '220')
    await expectCreationActionsToFit()
    await page!.screenshot({ path: resolve('artifacts', 'explorer-create-actions-narrow-dark.png') })
    await explorerSash.press('Enter')
    await expect(page!.getByRole('heading', { level: 1, name: 'No tasks in this workspace' })).toBeVisible()
    await page!.getByRole('button', { name: 'Create task with agent', exact: true }).click()
    const dialog = page!.getByRole('region', { name: 'Task creation', exact: true })
    const panel = dialog.getByRole('complementary', { name: 'Agent Host task creation chat' })
    await expect(panel.getByText('Connected', { exact: true })).toBeVisible()
    await expect(page!.getByRole('dialog')).toHaveCount(0)
    const taskBounds = await page!.getByRole('complementary', { name: 'Task details' }).boundingBox()
    const chatBounds = await dialog.boundingBox()
    expect(taskBounds).not.toBeNull()
    expect(chatBounds).not.toBeNull()
    expect(taskBounds!.x).toBeGreaterThanOrEqual(chatBounds!.x + chatBounds!.width)
    expect(await dialog.evaluate((element) => element.parentElement?.className)).toBe('active-task')
    expect(native.creations).toHaveLength(1)
    const sessionId = native.creations[0].channel
    expect(native.creations[0].workingDirectories).toEqual([pathToFileURL(await canonicalPolicyRoot(workspace)).href])
    expect(native.creations[0].config).toMatchObject({ isolation: 'folder', autoApprove: 'default', mode: 'interactive' })
    expect(native.calls.filter((call) => call.method === 'dispatchAction')).toEqual([])
    await expect(dialog.getByRole('button', { name: 'Copy agent instructions' })).toHaveCount(0)
    await panel.getByRole('combobox', { name: 'Agent Host model' }).selectOption('local-model')
    await panel.getByRole('textbox', { name: 'Message Agent Host' }).fill('Create a task for sign-in documentation.')
    await panel.getByRole('button', { name: 'Send to Agent Host' }).click()
    await expect.poll(() => native.sessions.get(sessionId)?.chat.activeTurn?.message.text).toContain('Create a task for sign-in documentation.')
    const turn = native.sessions.get(sessionId)!.chat.activeTurn!
    expect(turn.message.text).toContain('task-documents.mjs')
    expect(turn.message.text).toContain(JSON.stringify(workspace))
    expect(turn.message.model).toEqual({ id: 'local-model' })
    native.action(sessionId, { type: 'chat/responsePart', turnId: turn.id, part: { id: 'answer', kind: 'markdown', content: '' } })
    native.action(sessionId, { type: 'chat/delta', turnId: turn.id, partId: 'answer', content: '## Local planning reply\n\nI can create the documentation task in this repository.' })
    await expect(panel.getByRole('heading', { name: 'Local planning reply' })).toBeVisible()
    await page!.screenshot({ path: resolve('artifacts', 'local-task-agent-right-panel.png') })
    await panel.getByRole('button', { name: 'Stop Agent Host response' }).click()
    await expect(dialog.getByRole('button', { name: 'Refresh created tasks' })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Hide chat panel' }).click()
    await app!.close()
    app = undefined
    await launch()
    await page!.getByRole('button', { name: 'Create task with agent', exact: true }).click()
    const reopened = page!.getByRole('region', { name: 'Task creation', exact: true })
    await expect(reopened.getByRole('heading', { name: 'Local planning reply' })).toBeVisible()
    await expect(reopened.getByRole('combobox', { name: 'Agent Host model' })).toHaveValue('local-model')
    expect(native.creations).toHaveLength(1)

    // Simulate the native agent invoking the documented CLI, without a model account or external traffic.
    await execute(process.execPath, [resolve('scripts', 'task-documents.mjs'), 'create', '--root', workspace, '--title', 'Document sign-in', '--actor', 'copilot'], { cwd: resolve('.'), timeout: 30000 })
    await reopened.getByRole('button', { name: 'Refresh created tasks' }).click()
    await expect(page!.getByRole('heading', { level: 1, name: 'Document sign-in' })).toBeVisible()
    await expect(reopened.getByRole('heading', { name: 'Local planning reply' })).toBeVisible()
    await expect(page!.getByRole('dialog')).toHaveCount(0)
    await expect(page!.getByRole('alert')).toHaveCount(0)
    expect((await page!.evaluate(() => window.workspace!.getState())).current?.tasks).toHaveLength(1)
    await expect(readFile(join(workspace, '.taskcontinuum', 'session-bindings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(workspace, '.git', 'HEAD'))).rejects.toMatchObject({ code: 'ENOENT' })
    await page!.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page!.getByRole('radio', { name: 'Light', exact: true }).check()
    await page!.getByRole('button', { name: 'Close Preferences' }).click()
    await expectCreationActionsToFit()
    await page!.screenshot({ path: resolve('artifacts', 'local-task-agent-right-panel-light.png') })

    native.deleteSession(sessionId)
    await reopened.getByRole('button', { name: 'Reconnect Agent Host', exact: true }).click()
    await expect(reopened.getByText(/original local session was explicitly deleted/)).toBeVisible()
    await expect(reopened.getByText('Opened T-0001. You can keep chatting here.')).toHaveCount(0)
    await expect(reopened.getByRole('complementary', { name: 'Agent Host task creation chat' })).toHaveCount(0)
    await expect(reopened.getByRole('button', { name: 'Create local agent session', exact: true })).toBeEnabled()
    expect(native.creations).toHaveLength(1)
    await page!.screenshot({ path: resolve('artifacts', 'local-task-agent-deleted-session.png') })
    await reopened.getByRole('button', { name: 'Create local agent session', exact: true }).click()
    await expect(reopened.getByText('Connected', { exact: true })).toBeVisible()
    expect(native.creations).toHaveLength(2)
    const recoveredSessionId = native.creations[1].channel
    expect(recoveredSessionId).not.toBe(sessionId)
    expect(native.sessions.get(recoveredSessionId)!.chat.activeTurn).toBeUndefined()
    expect(native.sessions.get(recoveredSessionId)!.chat.turns).toEqual([])
    await expect(reopened.getByRole('combobox', { name: 'Agent Host model' })).toHaveValue('local-model')
    await reopened.getByRole('textbox', { name: 'Message Agent Host' }).fill('Plan the follow-up documentation task.')
    await reopened.getByRole('button', { name: 'Send to Agent Host' }).click()
    await expect.poll(() => native.sessions.get(recoveredSessionId)?.chat.activeTurn?.message.text).toContain('Plan the follow-up documentation task.')
    const recoveredTurn = native.sessions.get(recoveredSessionId)!.chat.activeTurn!
    expect(recoveredTurn.message.text).toContain(JSON.stringify(workspace))
    expect(recoveredTurn.message.model).toEqual({ id: 'local-model' })
    native.action(recoveredSessionId, { type: 'chat/responsePart', turnId: recoveredTurn.id, part: { id: 'recovered-answer', kind: 'markdown', content: '## Recovered planning reply\n\nThe new conversation is ready.' } })
    await expect(reopened.getByRole('heading', { name: 'Recovered planning reply' })).toBeVisible()
    await reopened.getByRole('button', { name: 'Stop Agent Host response' }).click()
    await expect(reopened.getByRole('button', { name: 'Refresh created tasks' })).toBeEnabled()
    await expect(page!.getByRole('alert')).toHaveCount(0)
    await page!.screenshot({ path: resolve('artifacts', 'local-task-agent-recovered-session.png') })
    await app!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(380, 600)
      window.setSize(620, 820)
    })
    await expect(page!.locator('.workbench')).toHaveAttribute('data-compact', 'true')
    if (!await reopened.isVisible()) await page!.getByRole('button', { name: 'Toggle chat panel', exact: true }).click()
    await expect(reopened.getByText('Connected', { exact: true })).toBeVisible()
    await expect(reopened.getByRole('heading', { name: 'Recovered planning reply' })).toBeVisible()
    await expect(reopened.getByRole('textbox', { name: 'Message Agent Host' })).toBeInViewport()
    expect(await page!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect(page!.getByRole('dialog')).toHaveCount(0)
    await page!.screenshot({ path: resolve('artifacts', 'local-task-agent-compact.png') })
    await page!.getByRole('button', { name: 'Tasks', exact: true }).click()
    await expectCreationActionsToFit()
    await page!.screenshot({ path: resolve('artifacts', 'explorer-create-actions-compact-light.png') })
    await page!.getByRole('button', { name: 'Toggle chat panel', exact: true }).click()
    await reopened.getByRole('button', { name: 'Hide chat panel', exact: true }).click()
    native.deleteSession(recoveredSessionId)
    await page!.getByRole('button', { name: 'Toggle chat panel', exact: true }).click()
    await expect(reopened.getByText(/original local session was explicitly deleted/)).toBeVisible()
    await expect(reopened.getByRole('complementary', { name: 'Agent Host task creation chat' })).toHaveCount(0)
    expect(native.creations).toHaveLength(2)
    expect(native.calls.filter((call) => call.method === 'dispatchAction' && (call.params?.action as { type?: string })?.type === 'chat/turnStarted')).toHaveLength(2)
    expect(errors).toEqual([])
    expect(network).toEqual([])
  } finally {
    await app?.close()
    await native.close()
    await rm(root, { recursive: true, force: true })
  }
})
