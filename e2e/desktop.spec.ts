import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

let app: ElectronApplication
let page: Page
const errors: string[] = []
const externalRequests: string[] = []

test.beforeAll(async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  delete env.TASKCONTINUUM_WORKSPACE
  env.TASKCONTINUUM_DATA_DIR = resolve('.runtime', `e2e-${Date.now()}`)
  mkdirSync(resolve('artifacts'), { recursive: true })
  app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('request', (request) => { if (/^(https?|wss?):/.test(request.url())) externalRequests.push(request.url()) })
  await expect(page.getByRole('heading', { level: 1, name: 'UI based on Electron' })).toBeVisible()
  await expect(page.locator('.workbench')).toHaveAttribute('aria-busy', 'false')
})

test.beforeEach(async () => {
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1440, 940) })
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'UI based on Electron' })).toBeVisible()
  await expect(page.getByText('Desktop · 0.1.0', { exact: true })).toBeVisible()
  await expect(page.locator('.workbench')).toHaveAttribute('aria-busy', 'false')
})

test.afterEach(() => {
  expect(errors).toEqual([])
  expect(externalRequests).toEqual([])
})

test.afterAll(async () => { await app?.close() })

test('launches the production workbench with a sandboxed renderer', async () => {
  expect(page.url()).toBe('taskcontinuum://app/index.html')
  const info = await page.evaluate(() => window.desktop!.getInfo())
  expect(info.security).toEqual({ contextIsolated: true, sandboxed: true })
  const surface = await page.evaluate(() => ({
    require: typeof Reflect.get(window, 'require'),
    process: typeof Reflect.get(window, 'process'),
    bridge: Object.keys(window.desktop ?? {}).sort(),
  }))
  expect(surface).toEqual({ require: 'undefined', process: 'undefined', bridge: ['close', 'getInfo', 'minimize', 'toggleMaximize'] })
  await expect(page.getByRole('complementary', { name: 'Task explorer' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Task chat' })).toBeVisible()
  await page.screenshot({ path: resolve('artifacts/workbench-dark.png') })
})

test('filters tasks, opens documents, and updates demo progress', async () => {
  await page.getByRole('textbox', { name: 'Filter tasks' }).fill('backend')
  await page.getByRole('button', { name: 'T-0003 Backend service', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Backend service')
  await page.getByRole('tab', { name: /^Checklist/ }).click()
  await page.getByRole('checkbox', { name: /Review the Session Host contract/ }).check()
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '50')
  await page.getByRole('tab', { name: 'Plan', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'A path forward' })).toBeVisible()
})

test('streams a task-scoped response and preserves a different draft', async () => {
  await page.getByRole('textbox', { name: 'Message to demo agent' }).fill('Suggest next steps')
  await page.getByRole('textbox', { name: 'Message to demo agent' }).press('Enter')
  await expect(page.getByRole('log')).toContainText('A next step for T-0002')
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeHidden()
  await page.screenshot({ path: resolve('artifacts/workbench-chat.png') })
  await page.getByRole('button', { name: 'T-0003 Backend service', exact: true }).click()
  await expect(page.getByRole('log')).not.toContainText('A next step for T-0002')
  await page.getByRole('textbox', { name: 'Message to demo agent' }).fill('A backend draft')
  await page.getByRole('button', { name: 'T-0002 UI based on Electron', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('A next step for T-0002')
  await page.getByRole('button', { name: 'T-0003 Backend service', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Message to demo agent' })).toHaveValue('A backend draft')
})

test('supports native dialogs, keyboard shortcuts, and light appearance', async () => {
  await page.keyboard.press('Control+b')
  await expect(page.getByRole('complementary', { name: 'Task explorer' })).toBeHidden()
  await page.keyboard.press('Control+Alt+b')
  await expect(page.getByRole('complementary', { name: 'Task chat' })).toBeHidden()
  await page.keyboard.press('Control+b')
  await page.keyboard.press('Control+Alt+b')
  await page.keyboard.press('Control+p')
  await expect(page.getByRole('dialog', { name: 'Quick open' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Find a task' }).fill('T-0004')
  await page.getByRole('dialog').getByRole('button', { name: /Technical design/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Technical design')
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  await page.getByRole('radio', { name: 'Light', exact: true }).check()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.locator('.workbench')).toHaveAttribute('data-theme', 'light')
  await page.screenshot({ path: resolve('artifacts/workbench-light.png') })
})

test('resizes Explorer and Chat independently and restores widths without losing layout space', async () => {
  const sidebar = page.getByRole('complementary', { name: 'Task explorer' })
  const chat = page.getByRole('complementary', { name: 'Task chat' })
  const sidebarSash = page.getByRole('separator', { name: 'Resize Explorer' })
  const chatSash = page.getByRole('separator', { name: 'Resize Chat' })
  const width = (panel: 'sidebar' | 'chat') => (panel === 'sidebar' ? sidebar : chat).evaluate((element) => element.getBoundingClientRect().width)
  const drag = async (panel: 'sidebar' | 'chat', delta: number, release = true) => {
    const sash = panel === 'sidebar' ? sidebarSash : chatSash
    const bounds = (await sash.boundingBox())!
    const position = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    await page.mouse.move(position.x, position.y)
    await page.mouse.down()
    await page.mouse.move(position.x + delta, position.y, { steps: 8 })
    if (release) await page.mouse.up()
  }
  await expect(sidebarSash).toHaveAttribute('aria-valuenow', '258')
  await expect(chatSash).toHaveAttribute('aria-valuenow', '355')
  await page.getByRole('textbox', { name: 'Message to demo agent' }).fill('Keep this draft while resizing')
  await drag('sidebar', 80)
  await expect(sidebarSash).toHaveAttribute('aria-valuenow', '338')
  expect(await width('chat')).toBe(355)
  await drag('chat', -120)
  await expect(chatSash).toHaveAttribute('aria-valuenow', '475')
  expect(await width('sidebar')).toBe(338)
  expect(await width('chat')).toBe(475)
  await expect(page.getByRole('textbox', { name: 'Message to demo agent' })).toHaveValue('Keep this draft while resizing')
  await drag('sidebar', 60, false)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(sidebarSash).toHaveAttribute('data-dragging', 'false')
  await expect(sidebarSash).toHaveAttribute('aria-valuenow', '338')
  await page.keyboard.press('Control+b')
  await expect(sidebarSash).toBeHidden()
  await page.keyboard.press('Control+b')
  expect(await width('sidebar')).toBe(338)
  await page.screenshot({ path: resolve('artifacts/workbench-resizable-panels.png') })
  await page.reload()
  await expect(sidebarSash).toHaveAttribute('aria-valuenow', '338')
  await expect(chatSash).toHaveAttribute('aria-valuenow', '475')
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1001, 820) })
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1001)
  await expect(page.locator('.workbench')).toHaveAttribute('data-compact', 'false')
  expect(await page.getByRole('main', { name: 'Task workspace' }).evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(400)
  expect(await width('sidebar')).toBeGreaterThanOrEqual(220)
  expect(await width('chat')).toBeGreaterThanOrEqual(310)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('taskcontinuum:layout:v1')!))).toMatchObject({ sidebarWidth: 338, chatWidth: 475 })
  await page.screenshot({ path: resolve('artifacts/workbench-resizable-constrained.png') })
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1440, 940) })
  await expect(sidebarSash).toHaveAttribute('aria-valuenow', '338')
  await expect(chatSash).toHaveAttribute('aria-valuenow', '475')
  await drag('chat', -2000)
  expect(await width('chat')).toBe(654)
  expect(await width('sidebar')).toBe(338)
  await chatSash.press('Home')
  expect(await width('chat')).toBe(310)
  await sidebarSash.dblclick()
  await chatSash.dblclick()
  expect(await width('sidebar')).toBe(258)
  expect(await width('chat')).toBe(355)
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(380, 600); window.setSize(420, 760) })
  await expect(page.locator('.workbench')).toHaveAttribute('data-compact', 'true')
  await expect(page.getByRole('separator')).toHaveCount(0)
  await page.getByRole('button', { name: 'Toggle chat panel' }).click()
  await expect(chat).toBeVisible()
  expect(await chat.evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
  await expect(page.getByRole('button', { name: 'Send message' })).toBeInViewport()
  await page.screenshot({ path: resolve('artifacts/workbench-resizable-compact.png') })
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1440, 940) })
  await expect(chatSash).toHaveAttribute('aria-valuenow', '355')
})

test('keeps the compact desktop usable without horizontal document overflow', async () => {
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(940, 700) })
  await expect(page.locator('.workbench')).toHaveAttribute('data-compact', 'true')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.getByRole('button', { name: 'T-0003 Backend service', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Backend service')
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
  expect(fits).toBe(true)
  await page.screenshot({ path: resolve('artifacts/workbench-compact.png') })
  await page.getByRole('button', { name: 'Toggle chat panel' }).click()
  await expect(page.getByRole('complementary', { name: 'Task chat' })).toBeVisible()
  await page.getByRole('button', { name: 'Summarize this task' }).click()
  await expect(page.getByRole('log')).toContainText('T-0003 · Backend service')
})

test('denies popup windows', async () => {
  await page.evaluate(() => { window.open('about:blank') })
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  expect(page.url()).toBe('taskcontinuum://app/index.html')
})