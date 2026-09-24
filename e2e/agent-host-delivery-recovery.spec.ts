import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { startAgentHostFixture } from '../test/agent-host-fixture'
import { enableAutomaticLinks, prepareAutomaticLinksRepository } from './immutable-workspace-fixture'

test('requires an explicit original-chat review before unlocking an uncertain native send', async () => {
  test.setTimeout(90_000)
  const root = await mkdtemp(join(tmpdir(), 'continuum-ahp-review-desktop-'))
  const workspace = join(root, 'tasks')
  const profile = join(root, 'profile')
  const discovery = join(root, 'discovery')
  const fixture = await startAgentHostFixture()
  let app: ElectronApplication | undefined
  try {
    await Promise.all([mkdir(join(workspace, '.agentdesk'), { recursive: true }), mkdir(join(workspace, 'tasks', 'T-0001-ahp'), { recursive: true }), mkdir(discovery)])
    await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Delivery review' }))
    await writeFile(join(workspace, 'tasks', 'T-0001-ahp', 'task.json'), JSON.stringify({
      schemaVersion: '1.0', id: 'T-0001', title: 'Review interrupted delivery', type: 'feature',
      status: 'backlog', priority: 'P2', relations: { level: 'task', parent: null },
    }))
    await writeFile(join(discovery, 'host.json'), JSON.stringify(fixture.endpoint))
    const enrolled = await prepareAutomaticLinksRepository(workspace, join(root, 'immutable-fixture'))
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    Object.assign(env, enrolled.environment)
    env.TASKCONTINUUM_WORKSPACE = workspace
    env.TASKCONTINUUM_DATA_DIR = profile
    env.TASKCONTINUUM_AGENT_HOST_DISCOVERY = discovery
    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env })
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Review interrupted delivery', level: 1 })).toBeVisible()
    await enableAutomaticLinks(app, page, profile)
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    const sessions = page.getByRole('complementary', { name: 'Agent Host sessions' })
    await sessions.getByRole('tab', { name: 'Link', exact: true }).click()
    await sessions.getByRole('button', { name: 'Link Original Host chat to T-0001' }).click()
    const panel = page.getByRole('complementary', { name: 'Agent Host task chat' })
    await expect(panel.getByText('Connected', { exact: true })).toBeVisible()
    await panel.getByRole('combobox', { name: 'Agent Host model' }).selectOption('gpt-6')
    await panel.getByRole('textbox', { name: 'Message Agent Host' }).fill('A message without a native echo')
    fixture.loseNextSend()
    await panel.getByRole('button', { name: 'Send to Agent Host' }).click()
    const review = panel.getByRole('group', { name: 'Resolve uncertain delivery' })
    await expect(review).toBeVisible()
    expect(fixture.dispatches).toHaveLength(1)
    await expect(panel.getByRole('button', { name: 'Send to Agent Host' })).toBeDisabled()
    await expect(review.getByRole('button', { name: 'Check original chat for this turn' })).toBeEnabled()
    await review.getByRole('button', { name: 'Check original chat for this turn' }).click()
    await expect(review.getByText(/not in the current Host snapshot/)).toBeVisible()
    await expect(review.getByRole('button', { name: 'Abandon this attempt and unlock sending' })).toBeDisabled()
    expect(fixture.dispatches).toHaveLength(1)
    await review.getByRole('checkbox', { name: /I checked the original chat/ }).check()
    await review.getByRole('button', { name: 'Abandon this attempt and unlock sending' }).click()
    await expect(review).toHaveCount(0)
    await expect(panel.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('A message without a native echo')
    expect(fixture.dispatches).toHaveLength(1)
    await expect(panel.getByRole('button', { name: 'Send to Agent Host' })).toBeEnabled()
    await panel.getByRole('button', { name: 'Send to Agent Host' }).click()
    await expect.poll(() => fixture.dispatches.length).toBe(2)
    await expect(panel.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('')
  } finally {
    await app?.close()
    await fixture.close()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
