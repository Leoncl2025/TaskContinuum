import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { startAgentHostFixture } from '../test/agent-host-fixture'
import { enableAutomaticLinks, prepareAutomaticLinksRepository } from './immutable-workspace-fixture'

test('opens links on the client and copies their original addresses without navigation or chat sends', async () => {
  test.setTimeout(120000)
  const root = await mkdtemp(join(tmpdir(), 'continuum-link-click-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  const discovery = join(root, 'discovery')
  const file = join(root, 'report.txt')
  const note = join(workspace, 'tasks', 'T-0001', 'note.txt')
  const image = join(root, 'chart.png')
  const privateFile = join(profile, 'private-state.txt')
  const copied = join(root, 'saved-report.txt')
  const openedFile = join(root, 'opened-urls.json')
  const openedCopies = join(root, 'opened-local-copies.json')
  const fixture = await startAgentHostFixture()
  let app: ElectronApplication | undefined
  try {
    await Promise.all([join(workspace, '.agentdesk'), join(workspace, 'tasks', 'T-0001'), profile, discovery].map((folder) => mkdir(folder, { recursive: true })))
    await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Link click fixture' }))
    await writeFile(join(workspace, 'tasks', 'T-0001', 'task.json'), JSON.stringify({
      schemaVersion: '1.0', id: 'T-0001', title: 'Verify seamless links', type: 'feature', status: 'backlog', priority: 'P2',
      relations: { level: 'task', parent: null },
    }))
    await writeFile(file, 'Source artifact <script>never executed</script>\n')
    await writeFile(note, 'First line\nSecond line is selected\n')
    await writeFile(privateFile, 'Private application state must not be exported')
    await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMpoAAAAASUVORK5CYII=', 'base64'))
    await writeFile(openedFile, '[]')
    await writeFile(openedCopies, '[]')
    const source = [
      '## Explicit link actions',
      '[PR](https://example.com/pull/42)',
      `[Report](${pathToFileURL(file).href})`,
      '[Relative note](./tasks/T-0001/note.txt:2)',
      `![Chart](${pathToFileURL(image).href})`,
      `[Private state](${pathToFileURL(privateFile).href})`,
      '[Unsafe command](command:workbench.action.closeWindow)',
      String.raw`Formula: \(\frac{1}{2}\).`,
    ].join('\n\n')
    fixture.historyText(1, source)
    fixture.setWorkingDirectories([pathToFileURL(workspace).href])
    await writeFile(join(discovery, 'host.json'), JSON.stringify(fixture.endpoint))
    const repository = await prepareAutomaticLinksRepository(workspace, join(root, 'immutable-fixture'))
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    delete environment.ELECTRON_RUN_AS_NODE
    delete environment.ELECTRON_RENDERER_URL
    Object.assign(environment, repository.environment, {
      TASKCONTINUUM_WORKSPACE: workspace, TASKCONTINUUM_DATA_DIR: profile, TASKCONTINUUM_AGENT_HOST_DISCOVERY: discovery,
    })
    app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env: environment })
    const page = await app.firstWindow()
    const errors: string[] = []
    const network: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => { if (/^(https?|wss?):/.test(request.url())) network.push(request.url()) })
    await expect(page.getByRole('heading', { name: 'Verify seamless links', level: 1 })).toBeVisible()
    await enableAutomaticLinks(app, page, profile)
    await app.evaluate(({ dialog, shell }, { openedFile, copied, openedCopies }) => {
      const filesystem = process.getBuiltinModule('fs')
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: copied })
      shell.openExternal = async (url: string) => {
        const values = JSON.parse(filesystem.readFileSync(openedFile, 'utf8')) as string[]
        values.push(url)
        filesystem.writeFileSync(openedFile, JSON.stringify(values))
      }
      shell.openPath = async (file: string) => {
        const values = JSON.parse(filesystem.readFileSync(openedCopies, 'utf8')) as { file: string; content: string }[]
        values.push({ file, content: filesystem.readFileSync(file, 'utf8') })
        filesystem.writeFileSync(openedCopies, JSON.stringify(values))
        return ''
      }
    }, { openedFile, copied, openedCopies })
    await page.getByRole('button', { name: 'Agent Host sessions', exact: true }).click()
    const sidebar = page.getByRole('complementary', { name: 'Agent Host sessions' })
    await sidebar.getByRole('tab', { name: 'Link', exact: true }).click()
    await sidebar.getByRole('button', { name: 'Link Original Host chat to T-0001', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Agent Host task chat' })
    await expect(panel.getByRole('link', { name: 'PR', exact: true })).toBeVisible()
    const originalUrl = page.url()
    expect(JSON.parse(await readFile(openedFile, 'utf8'))).toEqual([])
    expect(JSON.parse(await readFile(openedCopies, 'utf8'))).toEqual([])
    await expect(panel.getByRole('link', { name: 'Unsafe command', exact: true })).toHaveCount(0)
    await expect(page.locator('.chat-file-image')).toHaveCount(0)
    await expect(panel.locator('.katex')).toHaveCount(1)
    const copiedLinks = await panel.locator('.message-markdown').evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      const data = new DataTransfer()
      const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data })
      element.dispatchEvent(event)
      selection.removeAllRanges()
      return { text: data.getData('text/plain'), html: data.getData('text/html'), handled: event.defaultPrevented }
    })
    expect(copiedLinks.handled).toBe(true)
    expect(copiedLinks.text).toContain('[PR](<https://example.com/pull/42>)')
    expect(copiedLinks.text).toContain(`[Report](<${pathToFileURL(file).href}>)`)
    expect(copiedLinks.text).toContain(String.raw`\(\frac{1}{2}\)`)
    expect(copiedLinks.text).not.toContain('file-transfer-inbox')
    expect(copiedLinks.html).toContain('href="https://example.com/pull/42"')
    await panel.getByRole('textbox', { name: 'Message Agent Host' }).fill('Keep my question while opening files')
    await panel.getByRole('link', { name: 'PR', exact: true }).click()
    await expect.poll(async () => JSON.parse(await readFile(openedFile, 'utf8'))).toEqual(['https://example.com/pull/42'])
    expect(page.url()).toBe(originalUrl)
    await panel.getByRole('link', { name: 'Report', exact: true }).click()
    const report = page.getByRole('dialog', { name: 'report.txt', exact: true })
    await expect(report.getByLabel('Received file content')).toHaveText('Source artifact <script>never executed</script>\n')
    await expect(report.locator('script')).toHaveCount(0)
    await report.getByRole('button', { name: 'Save local copy', exact: true }).click()
    await expect(report.getByText('Local copy saved.', { exact: true })).toBeVisible()
    expect(await readFile(copied, 'utf8')).toBe(await readFile(file, 'utf8'))
    await report.getByRole('button', { name: 'Save and open locally', exact: true }).click()
    await expect(report.getByText('Local copy opened on this device.', { exact: true })).toBeVisible()
    expect(JSON.parse(await readFile(openedCopies, 'utf8'))).toEqual([{ file: copied, content: await readFile(file, 'utf8') }])
    await page.keyboard.press('Escape')
    await expect(report).toHaveCount(0)
    await expect(panel.getByRole('link', { name: 'Report', exact: true })).toBeFocused()
    await panel.getByRole('link', { name: 'Relative note', exact: true }).click()
    const relative = page.getByRole('dialog', { name: 'note.txt', exact: true })
    await expect(relative.locator('.chat-file-line-target')).toHaveText('Second line is selected\n')
    await page.keyboard.press('Escape')
    await panel.getByRole('link', { name: 'Chart', exact: true }).click()
    const picture = page.getByRole('dialog', { name: 'chart.png', exact: true })
    await expect(picture.getByRole('img', { name: 'chart.png' })).toBeVisible()
    await page.keyboard.press('Escape')
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(320, 500)
      window.setSize(420, 760)
    })
    await panel.getByRole('link', { name: 'Report', exact: true }).click()
    await expect(report.getByLabel('Received file content')).toBeVisible()
    await expect(report.getByRole('button', { name: 'Save local copy' })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await mkdir(resolve('artifacts'), { recursive: true })
    await page.screenshot({ path: resolve('artifacts', 'chat-file-link-narrow.png') })
    await page.keyboard.press('Escape')
    await panel.getByRole('link', { name: 'Private state', exact: true }).click()
    const denied = page.getByRole('dialog')
    await expect(denied.getByRole('alert')).toContainText('denied')
    await expect(denied.getByRole('button', { name: 'Save local copy' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(panel.getByRole('textbox', { name: 'Message Agent Host' })).toHaveValue('Keep my question while opening files')
    expect(fixture.dispatches).toEqual([])
    expect(page.url()).toBe(originalUrl)
    expect(network).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await app?.close()
    await fixture.close()
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
})
