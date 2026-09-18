import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { makeConfig } from '../test/taskDocuments/fixtures'

const execute = promisify(execFile)

test('runs the packaged desktop and standalone task CLI without the source checkout', async () => {
  test.setTimeout(90_000)
  const executablePath = resolve(process.env.TASKCONTINUUM_PACKAGED_EXECUTABLE ?? join('dist', 'win-unpacked', 'TaskContinuum.exe'))
  const manifest: { version: string } = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
  const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-packaged-'))
  const workspace = join(root, 'task workspace')
  const errors: string[] = []
  const network: string[] = []
  let app: ElectronApplication | undefined
  let page: Page
  try {
    await mkdir(join(workspace, '.agentdesk'), { recursive: true })
    await mkdir(join(workspace, 'tasks'))
    await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify(makeConfig({ workspace: 'Packaged release workspace' })))
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    for (const key of Object.keys(environment)) {
      if (/^(?:ELECTRON_|TASKCONTINUUM_)/.test(key)) delete environment[key]
    }
    environment.TASKCONTINUUM_DATA_DIR = join(root, 'profile')
    environment.TASKCONTINUUM_WORKSPACE = workspace
    const launch = async () => {
      app = await electron.launch({ executablePath, cwd: dirname(executablePath), env: environment })
      page = await app.firstWindow()
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
      page.on('request', (request) => { if (/^(https?|wss?):/.test(request.url())) network.push(request.url()) })
      await expect(page.locator('.workbench')).toHaveAttribute('aria-busy', 'false')
    }
    await launch()
    expect(await app!.evaluate(({ app }) => app.isPackaged)).toBe(true)
    expect(await app!.evaluate(({ nativeImage }) => {
      const path = process.getBuiltinModule('path')
      const image = nativeImage.createFromPath(path.join(process.resourcesPath, 'icon.png'))
      return !image.isEmpty() && image.getSize().width >= 256
    })).toBe(true)
    expect(page!.url()).toBe('taskcontinuum://app/index.html')
    await expect(page!.locator('.brand-mark img')).toBeVisible()
    expect(await page!.locator('.brand-mark img').evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth >= 256)).toBe(true)
    expect(await page!.evaluate(() => window.desktop!.getInfo())).toMatchObject({
      name: 'Task Continuum', version: manifest.version, security: { contextIsolated: true, sandboxed: true },
    })
    await expect(page!.getByRole('heading', { level: 1, name: 'No tasks in this workspace' })).toBeVisible()
    const cliPath = join(dirname(executablePath), 'resources', 'cli', 'task-documents.cjs')
    const instructions = await page!.evaluate(async () => {
      const state = await window.workspace!.getState()
      return window.workspace!.getTaskAgentInstructions({ workspaceId: state.current!.id, goal: 'Create a packaged smoke task' })
    })
    expect(instructions).toContain(JSON.stringify(cliPath))
    const help = await execute(process.execPath, [cliPath, '--help'], { cwd: root, timeout: 30_000 })
    expect(help.stdout).toContain('task-documents create')
    const created = await execute(process.execPath, [cliPath, 'create', '--root', workspace, '--title', 'Packaged smoke task', '--actor', 'release-smoke'], { cwd: root, timeout: 30_000 })
    expect(JSON.parse(created.stdout)).toMatchObject({ taskId: 'T-0001' })
    await page!.getByRole('button', { name: 'Refresh workspace', exact: true }).click()
    await page!.getByRole('button', { name: 'T-0001 Packaged smoke task', exact: true }).click()
    await expect(page!.getByRole('heading', { level: 1, name: 'Packaged smoke task' })).toBeVisible()
    await app!.close()
    app = undefined
    delete environment.TASKCONTINUUM_WORKSPACE
    await launch()
    await expect(page!.getByRole('button', { name: 'T-0001 Packaged smoke task', exact: true })).toBeVisible()
    const checked = await execute(process.execPath, [cliPath, 'validate', '--root', workspace], { cwd: root, timeout: 30_000 })
    expect(checked.stdout).toContain('0 error(s)')
    expect(errors).toEqual([])
    expect(network).toEqual([])
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})
