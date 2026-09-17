import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

const execute = promisify(execFile)
let app: ElectronApplication
let page: Page
let runtime: string
let parent: string
let environment: Record<string, string>
const errors: string[] = []
const externalRequests: string[] = []

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execute('git', ['--no-pager', ...args], { cwd: root, env: environment, windowsHide: true, timeout: 15_000 })
  return result.stdout.trim()
}

async function launch(): Promise<void> {
  app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => { if (/^(https?|wss?):/.test(request.url())) externalRequests.push(request.url()) })
  await expect(page.locator('.workbench')).toHaveAttribute('aria-busy', 'false')
  // Exercise real local status and command planning without opening browsers or contacting GitHub.
  await app.evaluate(({ ipcMain, shell, clipboard }) => {
    const urls: string[] = []
    const copied: string[] = []
    Reflect.set(globalThis, 'onboardingOpenedUrls', urls)
    Reflect.set(globalThis, 'onboardingCopiedCommands', copied)
    shell.openExternal = async (url: string) => { urls.push(url) }
    clipboard.writeText = async (text: string) => { copied.push(text) }
    ipcMain.removeHandler('workspace:verify-repository-publication')
    ipcMain.handle('workspace:verify-repository-publication', () => { throw new Error('Finish git push in your terminal, then check again. Offline fixture did not contact GitHub.') })
  })
}

async function chooseParent(): Promise<void> {
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
  }, parent)
  await page.getByRole('button', { name: 'Browse', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Parent directory' })).toHaveValue(parent)
}

test.beforeEach(async () => {
  errors.length = 0
  externalRequests.length = 0
  await mkdir(resolve('.runtime'), { recursive: true })
  await mkdir(resolve('artifacts'), { recursive: true })
  runtime = await mkdtemp(join(resolve('.runtime'), 'repository-onboarding-'))
  parent = join(runtime, 'projects')
  const home = join(runtime, 'home')
  await mkdir(parent)
  await mkdir(home)
  await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Onboarding test\n\temail = onboarding@example.test\n[commit]\n\tgpgsign = false\n')
  environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  for (const key of Object.keys(environment)) {
    if (/^(?:GH_|GITHUB_|GIT_)/.test(key) || ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'TASKCONTINUUM_WORKSPACE'].includes(key)) delete environment[key]
  }
  Object.assign(environment, {
    HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Onboarding test', GIT_AUTHOR_EMAIL: 'onboarding@example.test',
    GIT_COMMITTER_NAME: 'Onboarding test', GIT_COMMITTER_EMAIL: 'onboarding@example.test',
    TASKCONTINUUM_DATA_DIR: join(runtime, 'profile'), TASKCONTINUUM_VSCODE_USER_DATA_DIR: join(runtime, 'vscode'),
  })
  await launch()
})

test.afterEach(async () => {
  await app?.close()
  await rm(runtime, { recursive: true, force: true })
  expect(errors).toEqual([])
  expect(externalRequests).toEqual([])
})

test('starts empty, creates a separate task Git repository, and restores it after restart and clone', async () => {
  test.setTimeout(90_000)
  await git(parent, 'init', '--initial-branch=parent-branch')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create your task repository')
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.getByRole('contentinfo', { name: 'Workbench status' })).toContainText('0 tasks')
  await page.getByRole('button', { name: 'Create task repository', exact: true }).click()
  await chooseParent()
  await page.getByRole('textbox', { name: 'Repository name' }).fill('task-notes')
  await page.screenshot({ path: resolve('artifacts', 'repository-create.png') })
  await page.getByRole('button', { name: 'Create repository', exact: true }).click()
  const publishing = page.getByRole('dialog', { name: 'Publish task repository' })
  await expect(publishing).toBeVisible()
  await expect(publishing.getByText(/No GitHub CLI or separate app sign-in is needed/)).toBeVisible()
  await expect(publishing.getByText(/Personal EMU repositories must be private/)).toBeVisible()
  await expect(publishing.getByRole('button', { name: 'Get push commands', exact: true })).toBeDisabled()
  await expect(publishing.getByRole('radio')).toHaveCount(0)
  await page.screenshot({ path: resolve('artifacts', 'repository-publish.png') })
  await publishing.getByRole('button', { name: 'Keep local for now' }).click()

  const root = join(parent, 'task-notes')
  const state = await page.evaluate(() => window.workspace!.getState())
  expect(state.current?.root.toLowerCase()).toBe(root.toLowerCase())
  expect(state.current?.tasks).toEqual([])
  expect(state.current?.warnings).toEqual([])
  expect(await git(root, 'branch', '--show-current')).toBe('main')
  expect(resolve(await git(root, 'rev-parse', '--show-toplevel')).toLowerCase()).toBe(root.toLowerCase())
  expect(await git(root, 'rev-list', '--count', 'HEAD')).toBe('1')
  expect(await git(root, 'status', '--porcelain')).toBe('')
  expect(await git(root, 'remote')).toBe('')
  expect(await git(parent, 'branch', '--show-current')).toBe('parent-branch')
  expect(await readdir(join(root, 'tasks'))).toEqual(['.gitkeep'])
  const config = await readFile(join(root, '.agentdesk', 'config.json'), 'utf8')
  expect(JSON.parse(config).workspace).toBe('task-notes')

  await app.close()
  await launch()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('No tasks in this workspace')
  await expect(page.getByRole('combobox', { name: 'Workspace' })).toHaveValue(state.current!.id)
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)

  const clone = join(runtime, 'cloned-task-notes')
  await git(runtime, 'clone', '--no-hardlinks', '--', root, clone)
  expect(await readFile(join(clone, '.agentdesk', 'config.json'), 'utf8')).toBe(config)
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
  }, clone)
  await page.getByRole('button', { name: 'Open workspace folder', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('No tasks in this workspace')
  const cloned = await page.evaluate(() => window.workspace!.getState())
  expect(cloned.current?.root.toLowerCase()).toBe(clone.toLowerCase())
  expect(cloned.current?.tasks).toEqual([])
  expect(cloned.current?.warnings).toEqual([])
})

test('rejects unsafe names and existing folders without replacing files or selecting a workspace', async () => {
  const existing = join(parent, 'existing')
  await mkdir(existing)
  await writeFile(join(existing, 'keep.txt'), 'Keep the original bytes.')
  await page.getByRole('button', { name: 'Create task repository', exact: true }).click()
  await chooseParent()
  for (const name of ['..\\escape', 'CON', 'existing']) {
    await page.getByRole('textbox', { name: 'Repository name' }).fill(name)
    await page.getByRole('button', { name: 'Create repository', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Create task repository' }).getByRole('alert')).toBeVisible()
    expect((await page.evaluate(() => window.workspace!.getState())).current).toBeNull()
  }
  expect(await readdir(parent)).toEqual(['existing'])
  expect(await readFile(join(existing, 'keep.txt'), 'utf8')).toBe('Keep the original bytes.')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create your task repository')
})

test('guides an EMU user through browser creation and terminal commands without invoking gh or pushing', async () => {
  test.setTimeout(90_000)
  await page.getByRole('button', { name: 'Create task repository', exact: true }).click()
  await chooseParent()
  await page.getByRole('textbox', { name: 'Repository name' }).fill('task-notes')
  await page.getByRole('button', { name: 'Create repository', exact: true }).click()
  const publishing = page.getByRole('dialog', { name: 'Publish task repository' })
  await expect(publishing.getByText(/No GitHub CLI or separate app sign-in/)).toBeVisible()
  await publishing.getByRole('button', { name: 'Create on GitHub', exact: true }).click()
  expect(await app.evaluate(() => Reflect.get(globalThis, 'onboardingOpenedUrls'))).toEqual(['https://github.com/new?name=task-notes'])
  await publishing.getByRole('textbox', { name: 'GitHub repository URL' }).fill('https://github.com/fixture_emu/task-notes.git')
  await publishing.getByRole('button', { name: 'Get push commands' }).click()
  const commands = publishing.getByLabel('Git push commands')
  await expect(commands).toContainText('https://github.com/fixture_emu/task-notes.git')
  await expect(commands).toContainText('push')
  await publishing.getByRole('button', { name: 'Copy commands' }).click()
  await expect(publishing.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
  expect(await app.evaluate(() => Reflect.get(globalThis, 'onboardingCopiedCommands'))).toEqual([await commands.textContent()])
  await expect(publishing.getByRole('alert')).toHaveCount(0)
  await expect(publishing.getByText(/Task Continuum does not run them or push files for you/)).toBeVisible()
  const root = join(parent, 'task-notes')
  expect(await git(root, 'remote')).toBe('')
  expect(await git(root, 'rev-list', '--count', 'HEAD')).toBe('1')
  expect(await git(root, 'status', '--porcelain')).toBe('')
  await publishing.getByRole('button', { name: "I've pushed - Check" }).click()
  await expect(publishing.getByRole('alert')).toContainText('Finish git push in your terminal')
  await expect(publishing.getByRole('heading', { name: 'Repository is on GitHub' })).toHaveCount(0)
  await expect(commands).toContainText('push')
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setMinimumSize(380, 600)
    window.setSize(420, 760)
  })
  await commands.scrollIntoViewIfNeeded()
  expect(await publishing.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: resolve('artifacts', 'repository-gcm-terminal-narrow.png') })
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('workspace:verify-repository-publication')
    ipcMain.handle('workspace:verify-repository-publication', () => ({ url: 'https://github.com/fixture_emu/task-notes' }))
  })
  await publishing.getByRole('button', { name: "I've pushed - Check" }).click()
  await expect(publishing.getByRole('heading', { name: 'Repository is on GitHub' })).toBeVisible()
  await publishing.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('No tasks in this workspace')
})
