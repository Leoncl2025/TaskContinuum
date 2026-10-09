import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

test('exposes safe update settings and preserves the opt-out across an actual desktop restart', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'taskcontinuum-update-desktop-'))
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  for (const key of Object.keys(environment)) if (/^(?:ELECTRON_|TASKCONTINUUM_)/.test(key)) delete environment[key]
  environment.TASKCONTINUUM_DATA_DIR = profile
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
    let page = await app.firstWindow()
    await expect(page.locator('.workbench')).toHaveAttribute('aria-busy', 'false')
    const info = await page.evaluate(() => window.desktop!.getInfo())
    expect(await page.evaluate(() => window.updates!.getState())).toMatchObject({
      currentVersion: info.version, distribution: 'development', canInstall: false,
    })
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Application updates', exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('update-settings.png') })
    await expect(page.getByRole('button', { name: 'Download update', exact: true })).toHaveCount(0)
    await page.evaluate(() => window.updates!.setAutoCheck(false))
    await app.close()
    app = undefined
    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
    page = await app.firstWindow()
    await expect(page.locator('.workbench')).toHaveAttribute('aria-busy', 'false')
    expect(await page.evaluate(() => window.updates!.getState())).toMatchObject({ autoCheck: false, phase: 'idle' })
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Application updates', exact: true })).toBeVisible()
  } finally {
    await app?.close()
    await rm(profile, { recursive: true, force: true })
  }
})
