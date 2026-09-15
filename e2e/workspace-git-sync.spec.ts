import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { makeConfig, makeTask } from '../test/taskDocuments/fixtures'

test('exposes automatic workspace links and requires native enrollment consent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskcon-git-ui-'))
  const workspace = join(root, 'workspace')
  const data = join(root, 'profile')
  const task = join(workspace, 'tasks', 'T-0001-t-0001')
  await mkdir(task, { recursive: true })
  await mkdir(join(workspace, '.agentdesk'))
  await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify(makeConfig()))
  await writeFile(join(task, 'task.json'), JSON.stringify(makeTask({ id: 'T-0001' })))
  for (const [file, doc] of [['RequirementAnalysis.md', 'requirement-analysis'], ['Plan.md', 'plan'], ['Checklist.md', 'checklist']]) {
    await writeFile(join(task, file), `---\ndoc: ${doc}\nupdated: "2026-09-14"\n---\n`)
  }
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  env.TASKCONTINUUM_DATA_DIR = data
  env.TASKCONTINUUM_WORKSPACE = workspace
  env.TASKCONTINUUM_VSCODE_USER_DATA_DIR = join(root, 'vscode')
  const app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.locator('.workbench')).toHaveAttribute('aria-busy', 'false')
    await app.evaluate(({ ipcMain, dialog }) => {
      ipcMain.removeHandler('remote-vscode:tunnel-status')
      ipcMain.handle('remote-vscode:tunnel-status', () => ({ installed: false, state: 'idle' }))
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    await page.getByRole('button', { name: 'Remote VS Code sessions', exact: true }).click()
    const section = page.getByRole('region', { name: 'Workspace Git synchronization' })
    await expect(section).toBeVisible()
    await expect(section).toContainText('Pull/rebase every 15 seconds')
    await expect(section.getByRole('status')).toContainText('disabled')
    await section.getByRole('button', { name: 'Enable automatic links' }).click()
    await expect(section.getByRole('button', { name: 'Enable automatic links' })).toBeEnabled()
    await expect(section.getByRole('status')).toContainText('disabled')
    await expect(readFile(join(data, 'git-workspace-enrollments.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(workspace, '.taskcontinuum', 'workspace.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(errors).toEqual([])
    await mkdir(resolve('artifacts'), { recursive: true })
    await page.screenshot({ path: resolve('artifacts', 'workspace-git-sync.png') })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})
