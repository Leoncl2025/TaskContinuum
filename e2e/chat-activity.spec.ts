import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { startAgentHostFixture } from '../test/agent-host-fixture'
import { enableAutomaticLinks, prepareAutomaticLinksRepository } from './immutable-workspace-fixture'

test('keeps tool-heavy replies compact, accessible and readable at desktop and narrow widths', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'continuum-chat-activity-'))
  const workspace = join(root, 'tasks')
  const profile = join(root, 'profile')
  const discovery = join(root, 'discovery')
  const fixture = await startAgentHostFixture()
  let app: ElectronApplication | undefined
  const errors: string[] = []
  try {
    await mkdir(join(workspace, '.agentdesk'), { recursive: true })
    await mkdir(join(workspace, 'tasks', 'T-0001-chat'), { recursive: true })
    await mkdir(discovery)
    await mkdir(resolve('artifacts'), { recursive: true })
    await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Compact chat verification' }))
    await writeFile(join(workspace, 'tasks', 'T-0001-chat', 'task.json'), JSON.stringify({
      schemaVersion: '1.0', id: 'T-0001', title: 'Compact conversation', type: 'feature',
      status: 'backlog', priority: 'P2', relations: { level: 'task', parent: null },
    }))
    await writeFile(join(discovery, 'host.json'), JSON.stringify(fixture.endpoint))
    const enrolled = await prepareAutomaticLinksRepository(workspace, join(root, 'immutable-fixture'))
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    delete environment.ELECTRON_RUN_AS_NODE
    delete environment.ELECTRON_RENDERER_URL
    Object.assign(environment, enrolled.environment, {
      TASKCONTINUUM_WORKSPACE: workspace, TASKCONTINUUM_DATA_DIR: profile,
      TASKCONTINUUM_AGENT_HOST_DISCOVERY: discovery,
      TASKCONTINUUM_VSCODE_USER_DATA_DIR: join(root, 'no-legacy-sessions'),
    })
    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await app.evaluate(({ BrowserWindow, dialog }) => {
      BrowserWindow.getAllWindows()[0].setSize(1440, 1000)
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    await expect(page.getByRole('heading', { level: 1, name: 'Compact conversation' })).toBeVisible()
    await enableAutomaticLinks(app, page, profile)
    await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    const picker = page.getByRole('complementary', { name: 'Agent Host sessions' })
    await picker.getByRole('tab', { name: 'Link', exact: true }).click()
    await picker.getByRole('button', { name: 'Link Original Host chat to T-0001' }).click()
    const panel = page.getByRole('complementary', { name: 'Agent Host task chat' })
    await expect(panel.getByText('Connected', { exact: true })).toBeVisible()
    await expect(panel.getByRole('option', { name: 'GPT-6', exact: true })).toBeAttached()
    await panel.getByRole('combobox', { name: 'Agent Host model' }).selectOption('gpt-6')
    await panel.getByRole('textbox').fill('Review the startup flow and summarize the changes.')
    await panel.getByRole('button', { name: 'Send to Agent Host' }).click()
    await expect.poll(() => fixture.dispatches.length).toBe(1)
    const turnId = (fixture.dispatches[0] as { turnId: string }).turnId
    fixture.action({ type: 'chat/responsePart', turnId, part: { kind: 'reasoning', id: 'reasoning', content: 'Inspect the relevant startup modules before making changes.' } })
    fixture.action({ type: 'chat/responsePart', turnId, part: { kind: 'markdown', id: 'intro', content: 'I will check the existing startup flow and keep the changes focused.' } })
    for (let index = 0; index < 12; index++) {
      const name = index < 8 ? 'Read' : index < 10 ? 'Search' : 'Run Shell Command'
      fixture.action({ type: 'chat/responsePart', turnId, part: { kind: 'toolCall', toolCall: {
        toolCallId: `compact-${index}`, toolName: name, displayName: name, status: 'completed',
        confirmed: 'not-needed', invocationMessage: `Inspect startup module ${index}`, success: true,
        pastTenseMessage: `Inspected startup module ${index}`, content: [{ type: 'text', text: `Details for module ${index}` }],
      } } })
    }
    fixture.action({ type: 'chat/responsePart', turnId, part: { id: 'conclusion', kind: 'markdown', content: '## Summary\n\nStartup checks run in the background without interrupting the conversation.\n\n- Keep the current chat open.\n- Show a restart action when the update is ready.\n- Preserve verification and rollback.' } })
    const activity = panel.locator('.ahp-activity')
    const summary = panel.getByLabel('12 tool calls, completed')
    await expect(activity).toHaveCount(1)
    await expect(activity).not.toHaveAttribute('open')
    await expect(summary).toContainText('Read (8), Search (2), Run Shell Command (2)')
    await expect(panel.locator('.ahp-tool-entry')).toHaveCount(0)
    await expect(panel.getByRole('heading', { name: 'Summary', exact: true })).toBeVisible()
    const collapsedHeight = await activity.evaluate((element) => element.getBoundingClientRect().height)
    expect(collapsedHeight).toBeLessThanOrEqual(36)
    await page.screenshot({ path: resolve('artifacts', 'chat-compact-dark.png') })
    await summary.focus()
    await page.keyboard.press('Enter')
    await expect(activity).toHaveAttribute('open')
    await expect(activity.locator('.ahp-tool-entry')).toHaveCount(12)
    const expandedHeight = await activity.evaluate((element) => element.getBoundingClientRect().height)
    expect(collapsedHeight).toBeLessThan(expandedHeight * 0.2)
    await activity.getByText('Read', { exact: true }).first().click()
    await expect(activity.getByText('Details for module 0', { exact: true })).toBeVisible()
    await page.screenshot({ path: resolve('artifacts', 'chat-compact-expanded.png') })
    await summary.focus()
    await page.keyboard.press('Space')
    await expect(activity).not.toHaveAttribute('open')
    await expect(panel.locator('.ahp-tool-entry')).toHaveCount(0)
    fixture.action({ type: 'chat/responsePart', turnId, part: { kind: 'toolCall', toolCall: {
      toolCallId: 'approval', toolName: 'shell', displayName: 'Run deployment', status: 'pending-confirmation',
      invocationMessage: 'Deploy the verified changes to the chosen environment',
    } } })
    await expect(panel.getByText(/Awaiting confirmation on/)).toBeVisible()
    await panel.getByText('Run deployment', { exact: true }).click()
    await expect(panel.getByText(/Awaiting confirmation on/)).toBeVisible()
    fixture.action({ type: 'chat/responsePart', turnId, part: { kind: 'toolCall', toolCall: {
      toolCallId: 'failure', toolName: 'shell', displayName: 'Verify deployment', status: 'completed',
      confirmed: 'not-needed', invocationMessage: 'Check deployment status', success: false,
      pastTenseMessage: 'Deployment verification failed', error: { message: 'The deployment could not be verified.' },
    } } })
    await expect(panel.getByRole('alert')).toHaveText('The deployment could not be verified.')
    expect(await panel.getByText('Verify deployment', { exact: true }).evaluate((element) => element.closest('.ahp-activity'))).toBeNull()
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(380, 600)
      window.setSize(420, 900)
    })
    if (!await panel.isVisible()) await page.getByRole('button', { name: 'Toggle chat panel' }).click()
    for (const theme of ['dark', 'light']) {
      await page.locator('.workbench').evaluate((element, theme) => element.setAttribute('data-theme', theme), theme)
      await expect(panel).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await activity.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await activity.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(36)
      await expect(panel.getByRole('alert')).toBeVisible()
      await expect(panel.getByText(/Awaiting confirmation on/)).toBeVisible()
    }
    await page.screenshot({ path: resolve('artifacts', 'chat-compact-narrow-light.png') })
    expect(fixture.dispatches).toHaveLength(1)
    expect(errors).toEqual([])
    console.log(JSON.stringify({ collapsedHeight, expandedHeight, toolCalls: 12, narrowWidth: 420 }))
  } finally {
    await app?.close()
    await fixture.close()
    await rm(root, { recursive: true, force: true })
  }
})
