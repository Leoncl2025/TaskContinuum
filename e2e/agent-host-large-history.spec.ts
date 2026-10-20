import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { startAgentHostFixture } from '../test/agent-host-fixture'
import { enableAutomaticLinks, prepareAutomaticLinksRepository } from './immutable-workspace-fixture'

test('restores a 42,045,143-byte history in the desktop and from offline cache without execution replay', async () => {
  test.setTimeout(120000)
  const root = await mkdtemp(join(tmpdir(), 'continuum-large-history-desktop-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  const discovery = join(root, 'discovery')
  const host = await startAgentHostFixture(undefined, '1.0.0')
  expect(host.historyBytes(42_045_143, 3, true)).toBe(42_045_143)
  const expectedPadding = Reflect.get(host.snapshot(host.chatId).state, '_meta')?.largeHistory?.length
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  for (const key of Object.keys(environment)) if (/^(ELECTRON_|TASKCONTINUUM_)/.test(key)) delete environment[key]
  Object.assign(environment, {
    TASKCONTINUUM_DATA_DIR: profile, TASKCONTINUUM_WORKSPACE: workspace,
    TASKCONTINUUM_AGENT_HOST_DISCOVERY: discovery, TASKCONTINUUM_VSCODE_USER_DATA_DIR: join(root, 'empty-vscode'),
  })
  let app: ElectronApplication | undefined
  const errors: string[] = []
  async function launch() {
    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('heading', { level: 1, name: 'Large original history' })).toBeVisible()
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    await page.evaluate(() => {
      window.agentHost!.onView(({ view }) => {
        const padding = view.chat?._meta?.largeHistory
        if (typeof padding === 'string') Reflect.set(window, 'largeHistoryVerification', {
          turns: view.chat?.turns.length, first: view.chat?.turns[0].id, last: view.chat?.turns.at(-1)?.id,
          padding: padding.length, state: view.state,
        })
      })
    })
    return page
  }
  try {
    await Promise.all([join(workspace, '.agentdesk'), join(workspace, 'tasks', 'T-0001'), profile, discovery].map((path) => mkdir(path, { recursive: true })))
    await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Large history verification' }))
    await writeFile(join(workspace, 'tasks', 'T-0001', 'task.json'), JSON.stringify({ schemaVersion: '1.0', id: 'T-0001', title: 'Large original history', type: 'feature', status: 'backlog', priority: 'P2', relations: { level: 'task', parent: null } }))
    await writeFile(join(discovery, 'host.json'), JSON.stringify(host.endpoint))
    const enrolled = await prepareAutomaticLinksRepository(workspace, join(root, 'immutable-fixture'))
    Object.assign(environment, enrolled.environment)
    let page = await launch()
    await enableAutomaticLinks(app!, page, profile)
    await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    const sidebar = page.getByRole('complementary', { name: 'Agent Host sessions', exact: true })
    await sidebar.getByRole('tab', { name: 'Link', exact: true }).click()
    await sidebar.getByRole('button', { name: 'Link Original Host chat to T-0001' }).click()
    let panel = page.getByRole('complementary', { name: 'Agent Host task chat', exact: true })
    await expect(page.getByRole('status', { name: 'Connected', exact: true })).toBeVisible()
    await expect(panel.locator('.message-user')).toHaveCount(32)
    await expect(panel.locator('.message-user').first().locator('.message-text')).toHaveText('Original question 0')
    await expect(panel.locator('.message-user').last().locator('.message-text')).toHaveText('Original question 31')
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'largeHistoryVerification'))).toMatchObject({
      turns: 32, first: 'large-history-0', last: 'large-history-31', padding: expectedPadding, state: 'connected',
    })
    await app!.close()
    app = undefined
    const cache = (await readdir(join(profile, 'agent-host'))).find((name) => name.endsWith('.cache.json'))
    expect(cache).toBeDefined()
    expect((await stat(join(profile, 'agent-host', cache!))).size).toBeGreaterThan(40 * 1024 * 1024)
    await rm(join(discovery, 'host.json'))
    page = await launch()
    panel = page.getByRole('complementary', { name: 'Agent Host task chat', exact: true })
    await expect(page.getByRole('status', { name: 'Offline history', exact: true })).toBeVisible()
    await expect(panel.locator('.message-user')).toHaveCount(32)
    await expect(panel.locator('.message-user').last().locator('.message-text')).toHaveText('Original question 31')
    expect(host.methods).not.toContain('createSession')
    expect(host.methods).not.toContain('dispatchAction')
    expect(host.dispatches).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await app?.close()
    await host.close()
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
})
