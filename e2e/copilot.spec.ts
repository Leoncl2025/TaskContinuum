import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

let app: ElectronApplication
let page: Page
let environment: Record<string, string>
let sourceFile: string
let sourceText: string
const errors: string[] = []

async function launch(): Promise<void> {
  app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('heading', { level: 1, name: 'UI based on Electron' })).toBeVisible()
}

test.beforeAll(async () => {
  const root = resolve('.runtime', `copilot-e2e-${Date.now()}`)
  const codeRoot = join(root, 'vscode')
  const workspace = join(codeRoot, 'User', 'workspaceStorage', 'a'.repeat(32))
  await mkdir(join(workspace, 'chatSessions'), { recursive: true })
  await mkdir(resolve('artifacts'), { recursive: true })
  await writeFile(join(workspace, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(root).href }))
  sourceFile = join(workspace, 'chatSessions', 'handoff-fixture.jsonl')
  sourceText = JSON.stringify({ kind: 0, v: { customTitle: 'Task Continuum handoff fixture', requests: [{
    message: { text: 'The continuation marker is TASKCONTINUUM_IMPORT_OK.' },
    response: [{ value: 'The marker is recorded. No tools or file edits have been requested.' }],
  }] } }) + '\n'
  await writeFile(sourceFile, sourceText)
  environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_RENDERER_URL
  environment.TASKCONTINUUM_DATA_DIR = join(root, 'profile')
  environment.TASKCONTINUUM_VSCODE_USER_DATA_DIR = codeRoot
  await launch()
})

test.beforeEach(async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setMinimumSize(380, 600)
    window.setSize(1440, 940)
  })
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('UI based on Electron')
})

test.afterEach(async () => {
  expect(errors).toEqual([])
  expect(await readFile(sourceFile, 'utf8')).toBe(sourceText)
})

test.afterAll(async () => { await app?.close() })

test('exposes a restricted Copilot bridge without opening a runtime automatically', async () => {
  const surface = await page.evaluate(async () => ({
    state: (await window.copilot!.getStatus()).state,
    keys: Object.keys(window.copilot!).sort(),
    require: typeof Reflect.get(window, 'require'),
  }))
  expect(surface.state).toBe('disconnected')
  expect(surface.require).toBe('undefined')
  expect(surface.keys).toEqual(['abort', 'chooseDirectory', 'connect', 'createSession', 'disconnect', 'getStatus', 'importSession', 'listModels', 'listSessions', 'onEvent', 'previewImport', 'respond', 'resumeSession', 'send'].sort())
  const error = await page.evaluate(async () => {
    try { await window.copilot!.createSession({ workingDirectory: 'C:\\Windows' }); return '' } catch (failure) { return String(failure) }
  })
  expect(error).toContain('folder picker')
})

test('previews local VS Code history without changing the source or invoking a model', async () => {
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  const sidebar = page.getByRole('complementary', { name: 'Local sessions' })
  await expect(sidebar.getByRole('button', { name: 'Preview Task Continuum handoff fixture' })).toBeEnabled()
  await page.screenshot({ path: resolve('artifacts/copilot-sessions-desktop.png') })
  await sidebar.getByRole('button', { name: 'Preview Task Continuum handoff fixture' }).click()
  const preview = page.getByRole('dialog', { name: 'Continue VS Code conversation' })
  await expect(preview).toContainText('TASKCONTINUUM_IMPORT_OK')
  await expect(preview.getByRole('button', { name: 'Connect Copilot' })).toBeVisible()
  await expect(preview.getByRole('button', { name: 'Continue in new session' })).toBeHidden()
  await page.screenshot({ path: resolve('artifacts/copilot-import-preview.png') })
  await page.keyboard.press('Escape')
  expect((await page.evaluate(() => window.copilot!.getStatus())).state).toBe('disconnected')
})

test('keeps session controls and import text contained in narrow viewports', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(420, 760))
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await page.getByRole('button', { name: 'Preview Task Continuum handoff fixture' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  const fits = await page.evaluate(() => {
    const dialog = document.querySelector('dialog')!
    return document.documentElement.scrollWidth <= innerWidth && dialog.scrollWidth <= dialog.clientWidth
  })
  expect(fits).toBe(true)
  await page.screenshot({ path: resolve('artifacts/copilot-import-narrow.png') })
  await page.keyboard.press('Escape')
})

test('live Copilot resumes native history after restart and continues an imported conversation', async () => {
  test.skip(process.env.TASKCONTINUUM_LIVE_COPILOT !== '1', 'Opt in to three small authenticated model requests.')
  test.setTimeout(240000)
  const chat = () => page.getByRole('complementary', { name: 'Task chat' })
  const connect = async () => {
    await chat().getByRole('button', { name: 'Connect Copilot' }).click()
    await expect(page.getByText('Copilot connected', { exact: true })).toBeVisible({ timeout: 45000 })
    await expect(page.getByRole('status').filter({ hasText: /^Ready$/ })).toBeVisible({ timeout: 45000 })
  }
  const send = async (prompt: string, marker: string) => {
    await page.getByRole('textbox', { name: 'Message to Copilot' }).fill(prompt)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.getByRole('article', { name: 'Copilot response' }).last()).toContainText(marker, { timeout: 90000 })
    await expect(page.getByRole('button', { name: 'Stop response' })).toBeHidden({ timeout: 90000 })
    await expect(page.getByRole('alert')).toHaveCount(0)
  }
  await connect()
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await page.getByRole('complementary', { name: 'Local sessions' }).getByRole('button', { name: 'New Copilot session' }).click()
  await page.getByRole('button', { name: 'Create session', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  const originalId = await page.evaluate(() => JSON.parse(localStorage.getItem('taskcontinuum:session-bindings:v1')!)['T-0002'].id as string)
  await send('Reply with exactly TASKCONTINUUM_LIVE_OK. Do not call tools or change any files.', 'TASKCONTINUUM_LIVE_OK')
  await page.screenshot({ path: resolve('artifacts/copilot-live-chat.png') })
  await app.close()
  await launch()
  await connect()
  await expect(page.getByRole('log')).toContainText('TASKCONTINUUM_LIVE_OK')
  const restoredId = await page.evaluate(() => JSON.parse(localStorage.getItem('taskcontinuum:session-bindings:v1')!)['T-0002'].id as string)
  expect(restoredId).toBe(originalId)
  await send('Reply with exactly TASKCONTINUUM_RESUMED_OK. Do not call tools or change any files.', 'TASKCONTINUUM_RESUMED_OK')
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await page.getByRole('button', { name: 'Preview Task Continuum handoff fixture' }).click()
  await page.getByRole('button', { name: 'Continue in new session' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await send('Return only the continuation marker from the imported conversation. Do not call tools or change files.', 'TASKCONTINUUM_IMPORT_OK')
  await page.screenshot({ path: resolve('artifacts/copilot-live-import.png') })
})