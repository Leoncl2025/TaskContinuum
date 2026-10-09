import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

test('uses native full screen over the entire monitor, restores window state, and preserves the focused draft', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'continuum-fullscreen-'))
  const discovery = join(root, 'discovery')
  await mkdir(discovery)
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_RENDERER_URL
  delete environment.TASKCONTINUUM_WORKSPACE
  environment.TASKCONTINUUM_DATA_DIR = join(root, 'profile')
  environment.TASKCONTINUUM_AGENT_HOST_DISCOVERY = discovery
  let app: ElectronApplication | undefined
  const errors: string[] = []
  async function key(keyCode: string, modifiers: ('alt' | 'shift')[] = []): Promise<void> {
    await app!.evaluate(({ BrowserWindow }, { keyCode, modifiers }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.focus()
      window.webContents.focus()
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }, { keyCode, modifiers })
  }
  async function geometry() {
    return app!.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const bounds = window.getBounds()
      const display = screen.getDisplayMatching(bounds)
      return { fullScreen: window.isFullScreen(), maximized: window.isMaximized(), bounds, display: display.bounds, workArea: display.workArea }
    })
  }
  try {
    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('heading', { level: 1, name: 'Create your task repository' })).toBeVisible()
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true)
    const normal = await geometry()
    expect(normal.fullScreen).toBe(false)
    await page.getByRole('button', { name: 'Enter full screen', exact: true }).click()
    await expect.poll(async () => (await geometry()).fullScreen).toBe(true)
    await expect.poll(async () => { const state = await geometry(); return state.bounds }).toEqual((await geometry()).display)
    await expect(page.getByRole('button', { name: 'Exit full screen', exact: true })).toBeInViewport()
    expect(await page.evaluate(() => window.desktop!.getFullScreen())).toBe(true)
    const full = await geometry()
    expect(full.bounds.width).toBeGreaterThanOrEqual(full.workArea.width)
    expect(full.bounds.height).toBeGreaterThanOrEqual(full.workArea.height)
    await mkdir(resolve('artifacts'), { recursive: true })
    await page.screenshot({ path: resolve('artifacts', 'window-fullscreen.png') })
    await key('F11')
    await expect.poll(async () => (await geometry()).fullScreen).toBe(false)
    await expect.poll(async () => (await geometry()).bounds).toEqual(normal.bounds)
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Preferences' })).toBeVisible()
    await key('Enter', ['alt', 'shift'])
    await expect.poll(async () => (await geometry()).fullScreen).toBe(true)
    await expect(page.getByRole('dialog', { name: 'Preferences' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Preferences' })).toHaveCount(0)
    expect((await geometry()).fullScreen).toBe(true)
    await page.getByRole('button', { name: 'Exit full screen' }).click()
    await expect.poll(async () => (await geometry()).fullScreen).toBe(false)

    // An input remains mounted and unchanged while the native window changes mode.
    await page.getByRole('button', { name: 'Search tasks and jump back in' }).click()
    const input = page.getByRole('textbox', { name: 'Find a task' })
    await input.fill('Keep this unsent text')
    await key('F11')
    await expect.poll(async () => (await geometry()).fullScreen).toBe(true)
    await expect(input).toHaveValue('Keep this unsent text')
    await key('F11')
    await expect.poll(async () => (await geometry()).fullScreen).toBe(false)
    await expect(input).toHaveValue('Keep this unsent text')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Maximize or restore window' }).click()
    await expect.poll(async () => (await geometry()).maximized).toBe(true)
    await key('F11')
    await expect.poll(async () => (await geometry()).fullScreen).toBe(true)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Exit full screen' })).toBeVisible()
    await key('F11')
    await expect.poll(async () => (await geometry()).fullScreen).toBe(false)
    await expect.poll(async () => (await geometry()).maximized).toBe(true)
    await page.getByRole('button', { name: 'Maximize or restore window' }).click()
    await expect.poll(async () => (await geometry()).bounds).toEqual(normal.bounds)
    expect(errors).toEqual([])
  } finally { await app?.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) }
})
