import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChatToolCallCompleteAction, ChatTurnStartedAction, SessionActiveClientSetAction } from '@microsoft/agent-host-protocol'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { COLLABORATION_MCP_DESCRIPTOR } from '../src/shared/sessionCollaboration'
import { startAgentHostFixture } from '../test/agent-host-fixture'
import { enableAutomaticLinks, prepareAutomaticLinksRepository } from './immutable-workspace-fixture'

test('opens the desktop and runs native collaboration when the optional MCP descriptor cannot be written', async () => {
  test.setTimeout(60_000)
  const root = await mkdtemp(join(tmpdir(), 'continuum-collab-startup-'))
  const workspace = join(root, 'tasks')
  const profile = join(root, 'profile')
  const discovery = join(root, 'discovery')
  const fixture = await startAgentHostFixture(undefined, '1.0.0')
  let app: ElectronApplication | undefined
  try {
    await Promise.all([join(workspace, '.agentdesk'), join(workspace, 'tasks', 'T-0001'), discovery,
      join(profile, COLLABORATION_MCP_DESCRIPTOR)].map((path) => mkdir(path, { recursive: true })))
    await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Optional MCP fixture' }))
    await writeFile(join(workspace, 'tasks', 'T-0001', 'task.json'), JSON.stringify({
      schemaVersion: '1.0', id: 'T-0001', title: 'Verify desktop startup', type: 'feature', status: 'backlog', priority: 'P2',
      relations: { level: 'task', parent: null },
    }))
    await writeFile(join(discovery, 'fixture.json'), JSON.stringify(fixture.endpoint))
    const enrolled = await prepareAutomaticLinksRepository(workspace, join(root, 'immutable-fixture'))
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    delete environment.ELECTRON_RUN_AS_NODE
    delete environment.ELECTRON_RENDERER_URL
    Object.assign(environment, enrolled.environment, {
      TASKCONTINUUM_WORKSPACE: workspace, TASKCONTINUUM_DATA_DIR: profile, TASKCONTINUUM_AGENT_HOST_DISCOVERY: discovery,
      TASKCONTINUUM_VSCODE_USER_DATA_DIR: join(root, 'empty-vscode'),
    })
    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { level: 1, name: 'Verify desktop startup' })).toBeVisible()
    await enableAutomaticLinks(app, page, profile)
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    const picker = page.getByRole('complementary', { name: 'Agent Host sessions' })
    await picker.getByRole('tab', { name: 'Link', exact: true }).click()
    await picker.getByRole('button', { name: 'Link Original Host chat to T-0001' }).click()
    await expect(page.getByLabel('Chat header').getByText('Connected', { exact: true })).toBeVisible()

    const actions = () => fixture.dispatches as (ChatToolCallCompleteAction | ChatTurnStartedAction | SessionActiveClientSetAction)[]
    const registration = () => actions().find((action) => action.type === 'session/activeClientSet')
    await expect.poll(registration).toMatchObject({ activeClient: { tools: expect.arrayContaining([
      expect.objectContaining({ name: 'taskcontinuum_collaboration_list_sessions' }),
    ]) } })
    await page.getByRole('combobox', { name: 'Agent Host model' }).selectOption('owner-model')
    await page.getByRole('textbox', { name: 'Message Agent Host' }).fill('List linked sessions')
    await page.getByRole('button', { name: 'Send to Agent Host' }).click()
    const sent = () => actions().find((action) => action.type === 'chat/turnStarted')
    await expect.poll(sent).toMatchObject({ message: { text: 'List linked sessions' } })
    const clientId = registration()!.activeClient.clientId
    const toolCallId = randomUUID()
    fixture.sessionAction({ type: 'session/inputNeededSet', request: {
      kind: 'toolClientExecution', id: toolCallId, turnId: sent()!.turnId, clientId, chat: fixture.chatId,
      toolCall: {
        status: 'running', toolCallId, toolName: 'taskcontinuum_collaboration_list_sessions', toolInput: '{}',
        contributor: { kind: 'client', clientId },
      },
    } })
    await expect.poll(() => actions().find((action) => action.type === 'chat/toolCallComplete' && action.toolCallId === toolCallId))
      .toMatchObject({ result: { success: true, structuredContent: { result: { sessions: expect.arrayContaining([
        expect.objectContaining({ taskId: 'T-0001', chatId: fixture.chatId }),
      ]) } } } })
  } finally {
    try { await app?.close() }
    finally {
      await fixture.close()
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }
})
