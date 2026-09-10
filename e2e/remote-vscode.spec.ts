import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { hostname, tmpdir, userInfo } from 'node:os'
import { randomUUID } from 'node:crypto'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { startVSCodeChatCompanion } from '../src/main/vscodeChatCompanion'
import { deliveryPrompt } from '../src/main/vscodeChatDelivery'
import { remoteIdentityFileSchema, remoteInvitationFileSchema } from '../src/main/vscodeRemoteProtocol'
import { DevTunnelCli } from '../src/main/devTunnel/cli'
import { updateRepositorySessionLink } from '../src/main/repositorySessionLinks'
import { startSshFixture } from '../test/ssh-fixture'

for (const managed of [false, true]) test(`authorizes an original VS Code conversation through two isolated desktops and ${managed ? 'managed Dev Tunnel + SSH' : 'an SSH alias'}`, async () => {
  test.skip(managed && process.env.TASKCONTINUUM_LIVE_DEV_TUNNEL !== '1', 'Requires an explicitly enabled Microsoft Dev Tunnel account.')
  const verifySignIn = managed && process.env.TASKCONTINUUM_VERIFY_DEV_TUNNEL_LOGIN === '1'
  test.setTimeout(verifySignIn ? 360000 : managed ? 180000 : 120000)
  const root = await mkdtemp(join(tmpdir(), 'continuum-remote-desktop-'))
  const identity = { nativeSessionId: randomUUID(), workspaceStorageId: 'a'.repeat(32) }
  const ownerCode = join(root, 'owner-code')
  const storageRoot = join(ownerCode, 'User', 'workspaceStorage')
  const history = join(storageRoot, identity.workspaceStorageId, 'chatSessions')
  await mkdir(history, { recursive: true })
  const sourceFile = join(history, `${identity.nativeSessionId}.json`)
  const otherFile = join(history, 'untouched.json')
  const source = { customTitle: 'Original remote work', inputState: { mode: { id: 'agent', kind: 'agent' } }, requests: [{ requestId: 'old', message: 'Owner question', response: [{ value: 'Owner answer' }], result: {} }] }
  await writeFile(sourceFile, JSON.stringify(source))
  await writeFile(otherFile, JSON.stringify(source))
  let dispatched = 0
  const opened: string[] = []
  const owner = await startVSCodeChatCompanion({ storageRoot, workspaceStorageId: identity.workspaceStorageId, discoveryDirectory: join(storageRoot, identity.workspaceStorageId, 'taskcontinuum.vscode-bridge', 'bridges'), vscodeVersion: '1.136.1', open: async (resource) => { opened.push(resource) }, dispatch: async (_identity, delivery) => {
    dispatched++
    const requestId = `remote-${delivery.id}`
    await writeFile(sourceFile, JSON.stringify({ ...source, requests: [...source.requests, { requestId, message: deliveryPrompt(delivery), response: [{ value: 'Reply from the original execution Agent.' }], result: {} }] }))
    return { state: 'submitted', nativeRequestId: requestId }
  } })
  const ssh = managed ? undefined : await startSshFixture(join(root, 'ssh'), owner.descriptor.port)
  const desktops = new Set<ElectronApplication>()
  const errors: string[] = []
  const participantFile = join(root, 'client-identity.json')
  const invitationFile = join(root, 'private-invitation.json')
  const receiverProfile = join(root, 'profile-A')
  const ownerProfile = join(root, 'profile-B')
  const artifact = managed ? 'managed-remote-vscode' : 'remote-vscode'
  const receiverWorkspace = join(root, 'tasks-A')
  const ownerWorkspace = join(root, 'tasks-B')
  async function workspace(directory: string): Promise<void> {
    await mkdir(join(directory, '.agentdesk'), { recursive: true })
    const task = join(directory, 'tasks', 'T-0001-original')
    await mkdir(task, { recursive: true })
    await writeFile(join(directory, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Remote original workspace' }))
    await writeFile(join(task, 'task.json'), JSON.stringify({ schemaVersion: '1.0', id: 'T-0001', title: 'Remote original task', type: 'feature', status: 'backlog', priority: 'P2', relations: { level: 'task' } }))
    for (const name of ['RequirementAnalysis.md', 'Plan.md', 'Checklist.md']) await writeFile(join(task, name), '# Remote original fixture\n')
  }
  async function launch(profile: string, tasks: string, code: string, config?: string): Promise<{ app: ElectronApplication; page: Page }> {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    env.TASKCONTINUUM_DATA_DIR = profile
    env.TASKCONTINUUM_WORKSPACE = tasks
    env.TASKCONTINUUM_VSCODE_USER_DATA_DIR = code
    const app = await electron.launch({ args: [resolve('.')], cwd: resolve('.'), env })
    desktops.add(app)
    if (config) await app.evaluate((_electron, file) => {
      const subprocess = process.getBuiltinModule('child_process') as typeof import('node:child_process')
      const spawn = subprocess.spawn
      subprocess.spawn = ((command: string, args: readonly string[] = [], options: import('node:child_process').SpawnOptions = {}) => spawn(command, command === 'ssh' ? ['-F', file, ...args] : args, options)) as typeof subprocess.spawn
    }, config)
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('heading', { level: 1, name: 'Remote original task' })).toBeVisible()
    return { app, page }
  }
  async function dialogs(app: ElectronApplication, input: string, output: string): Promise<void> {
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [files.input] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: files.output })
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    }, { input, output })
  }
  async function remoteDialog(page: Page, requireSignIn = true) {
    await page.getByRole('button', { name: 'Remote VS Code sessions', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Remote VS Code sessions', exact: true })
    if (!managed) await dialog.getByRole('radio', { name: 'SSH alias', exact: true }).click()
    else if (requireSignIn) await expect(dialog.getByText('Signed in', { exact: true })).toBeVisible({ timeout: 30000 })
    return dialog
  }
  async function removePublication(): Promise<void> {
    if (!managed) return
    let content: string
    try { content = await readFile(join(ownerProfile, 'dev-tunnel-publication.json'), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const publication = JSON.parse(content) as { tunnelId: string }
    await new DevTunnelCli().remove(publication.tunnelId, AbortSignal.timeout(30000))
  }
  try {
    await Promise.all([workspace(receiverWorkspace), workspace(ownerWorkspace), mkdir(resolve('artifacts'), { recursive: true })])
    await updateRepositorySessionLink(ownerWorkspace, 'T-0001', identity.nativeSessionId, null, identity.workspaceStorageId)
    let client = await launch(receiverProfile, receiverWorkspace, join(root, 'empty-code-A'), ssh?.config)
    await dialogs(client.app, invitationFile, participantFile)
    let manager = await remoteDialog(client.page, !verifySignIn)
    if (verifySignIn) {
      await manager.getByRole('button', { name: /^Sign in (with Microsoft|again)$/ }).click()
      await expect(manager.getByRole('button', { name: 'Sign in again', exact: true })).toBeEnabled({ timeout: 180000 })
      await expect(manager.getByRole('alert')).toHaveCount(0)
      await expect(manager.getByText('Signed in', { exact: true })).toBeVisible()
      expect(await client.page.evaluate(() => window.remoteVSCode!.devTunnels!.status(true))).toMatchObject({ installed: true, state: 'idle', account: expect.any(String) })
    }
    await manager.getByRole('button', { name: 'Export client identity', exact: true }).click()
    await expect(manager).toContainText('Client identity exported.')
    const exported = remoteIdentityFileSchema.parse(JSON.parse(await readFile(participantFile, 'utf8')))
    expect(exported.participant).toMatchObject({ username: userInfo().username, machineName: hostname() })
    if (managed) {
      expect(exported.sshPublicKey).toMatch(/^ssh-ed25519 /)
      const persisted = JSON.parse(await readFile(join(receiverProfile, 'dev-tunnel-client-identity.json'), 'utf8')) as { encryptedPrivateKey: string }
      expect(Buffer.from(persisted.encryptedPrivateKey, 'base64').toString()).not.toContain('PRIVATE KEY')
      expect(await client.app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())).toBe(true)
    }
    const execution = await launch(ownerProfile, ownerWorkspace, ownerCode)
    await expect(execution.page.getByRole('button', { name: 'Share original conversation remotely' })).toBeEnabled()
    await dialogs(execution.app, participantFile, invitationFile)
    await execution.page.getByRole('button', { name: 'Share original conversation remotely' }).click()
    const access = execution.page.getByRole('dialog', { name: 'Remote access to original conversation' })
    if (managed) {
      await access.getByRole('button', { name: 'Publish this machine', exact: true }).click()
      await expect(access.getByText('Hosting', { exact: true })).toBeVisible({ timeout: 60000 })
      await expect(access.getByLabel('SSH host fingerprint')).toContainText('SHA256:')
      await execution.page.screenshot({ path: resolve(`artifacts/${artifact}-publication.png`) })
      await execution.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(380, 600); window.setSize(420, 760) })
      expect(await access.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
      await execution.page.screenshot({ path: resolve(`artifacts/${artifact}-publication-narrow.png`) })
    } else await access.getByRole('radio', { name: 'SSH alias', exact: true }).click()
    await access.getByRole('combobox', { name: 'Remote invitation access' }).selectOption('send')
    await access.getByRole('button', { name: 'Choose recipient', exact: true }).click()
    await expect(access).toContainText('Private invitation saved.')
    const invitation = remoteInvitationFileSchema.parse(JSON.parse(await readFile(invitationFile, 'utf8')))
    expect(invitation.grant.participant).toEqual(exported.participant)
    expect(invitation.grant.canSend).toBe(true)
    if (managed) expect(invitation.devTunnel?.clientPublicKey).toBe(exported.sshPublicKey)
    else await manager.getByRole('textbox', { name: 'SSH host alias' }).fill('owner-machine')
    if (managed) await manager.getByText('Legacy session invitation', { exact: true }).click()
    await manager.getByRole('button', { name: 'Import invitation', exact: true }).click()
    await expect(manager).toContainText('Invitation imported for')
    if (ssh) expect(ssh.forwardedConnections()).toBe(0)
    expect((await readdir(receiverWorkspace)).includes('.taskcontinuum')).toBe(false)
    const summaries = await client.page.evaluate(() => window.remoteVSCode!.list())
    expect(Object.keys(summaries[0])).not.toContain('token')
    expect(summaries[0]).toMatchObject({ state: 'disconnected', transport: managed ? 'dev-tunnel' : 'ssh' })
    await manager.getByRole('button', { name: `Connect ${hostname()}`, exact: true }).click()
    await expect(manager.getByText('connected', { exact: true })).toBeVisible({ timeout: 60000 })
    if (ssh) expect(ssh.forwardedConnections()).toBeGreaterThan(0)
    await manager.getByRole('button', { name: 'Link to T-0001', exact: true }).click()
    await expect(manager).toBeHidden()
    await expect(client.page.getByRole('log', { name: 'Original conversation for T-0001' })).toContainText('Owner answer')
    expect(opened).toEqual([])
    await dialogs(client.app, invitationFile, participantFile)
    await client.page.getByRole('textbox', { name: 'Message original VS Code Agent' }).fill('Draft before remote switch')
    await client.app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
    await client.page.getByRole('button', { name: `Open session on ${hostname()}` }).click()
    expect(opened).toEqual([])
    await dialogs(client.app, invitationFile, participantFile)
    await client.page.getByRole('button', { name: `Open session on ${hostname()}` }).click()
    await expect.poll(() => opened.length).toBe(1)
    expect(opened[0]).toBe(`vscode-chat-session://local/${Buffer.from(identity.nativeSessionId).toString('base64url')}`)
    expect(dispatched).toBe(0)
    await expect(client.page.getByRole('textbox', { name: 'Message original VS Code Agent' })).toHaveValue('Draft before remote switch')
    expect(await client.page.evaluate(() => window.copilot!.getStatus())).toMatchObject({ state: 'disconnected' })
    const bindingFile = join(receiverWorkspace, '.taskcontinuum', 'session-bindings.json')
    const binding = JSON.parse(await readFile(bindingFile, 'utf8'))
    expect(binding.bindings['T-0001']).toEqual({ provider: 'vscode-copilot', sessionId: identity.nativeSessionId, workspaceStorageId: identity.workspaceStorageId, remoteMachineName: hostname() })
    expect(JSON.stringify(binding)).not.toMatch(/token|port|hostAlias|clientId|devTunnel|sshPublicKey/)
    await client.page.getByRole('textbox', { name: 'Message original VS Code Agent' }).fill('Continue the original work from A')
    await client.page.getByRole('button', { name: 'Send to original VS Code session' }).click()
    await expect(client.page.getByRole('log')).toContainText('Reply from the original execution Agent.')
    await expect(client.page.getByRole('textbox', { name: 'Message original VS Code Agent' })).toHaveValue('')
    expect(dispatched).toBe(1)
    await client.page.screenshot({ path: resolve(`artifacts/${artifact}-desktop.png`) })
    const cached = await client.page.evaluate((target) => window.vscodeChat!.read(target), summaries[0].target)
    expect(cached.messages.at(-2)).toMatchObject({ text: 'Continue the original work from A', author: { name: exported.participant.username, machineName: exported.participant.machineName } })
    expect(cached.messages.at(-1)).toMatchObject({ author: { machineName: hostname() } })
    await client.app.close()
    desktops.delete(client.app)
    const beforeRestart = ssh?.forwardedConnections()
    client = await launch(receiverProfile, receiverWorkspace, join(root, 'empty-code-A'), ssh?.config)
    await expect(client.page.getByRole('log')).toContainText('Reply from the original execution Agent.')
    await expect(client.page.getByRole('button', { name: 'Connect SSH' })).toBeVisible()
    await expect(client.page.getByRole('button', { name: 'Send to original VS Code session' })).toBeDisabled()
    if (ssh) expect(ssh.forwardedConnections()).toBe(beforeRestart)
    expect((await client.page.evaluate(() => window.remoteVSCode!.list()))[0].state).toBe('disconnected')
    await client.page.getByRole('button', { name: 'Connect SSH' }).click()
    await expect(client.page.getByRole('button', { name: 'Connect SSH' })).toBeHidden({ timeout: 60000 })
    await client.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(380, 600); window.setSize(420, 760) })
    await client.page.getByRole('button', { name: 'Toggle chat panel' }).click()
    await expect(client.page.getByRole('complementary', { name: 'VS Code task chat' })).toBeVisible()
    const panel = client.page.getByRole('complementary', { name: 'VS Code task chat' })
    expect(await panel.evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
    await client.page.screenshot({ path: resolve(`artifacts/${artifact}-narrow.png`) })
    manager = await remoteDialog(client.page)
    const bounds = await manager.boundingBox()
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(420)
    await client.page.screenshot({ path: resolve(`artifacts/${artifact}-connections-narrow.png`) })
    await manager.getByRole('button', { name: `Disconnect ${hostname()}`, exact: true }).click()
    await expect(manager.getByRole('button', { name: `Connect ${hostname()}`, exact: true })).toBeEnabled()
    expect(dispatched).toBe(1)
    await client.page.keyboard.press('Escape')
    await expect(client.page.getByRole('button', { name: 'Connect SSH' })).toBeVisible()
    await client.page.getByRole('button', { name: 'Connect SSH' }).click()
    await access.getByRole('button', { name: `Revoke ${userInfo().username} on ${hostname()}` }).click()
    await expect(access).toContainText('No active invitations.')
    await expect(client.page.getByRole('button', { name: 'Connect SSH' })).toBeVisible()
    await expect(client.page.getByRole('button', { name: 'Send to original VS Code session' })).toBeDisabled()
    await expect(client.page.getByRole('log')).toContainText('Reply from the original execution Agent.')
    expect(dispatched).toBe(1)
    expect(await readFile(otherFile, 'utf8')).toBe(JSON.stringify(source))
    expect(await readFile(bindingFile, 'utf8')).toBe(JSON.stringify(binding, null, 2) + '\n')
    if (managed) {
      await access.getByRole('button', { name: 'Stop publication', exact: true }).click()
      await expect(access.getByRole('button', { name: 'Publish this machine', exact: true })).toBeEnabled()
      expect((await fetch(`http://127.0.0.1:${owner.descriptor.port}/identity`, { headers: { Authorization: `Bearer ${owner.descriptor.token}` } })).ok).toBe(true)
    }
    expect(errors).toEqual([])
  } finally {
    for (const desktop of desktops) await desktop.close().catch(() => undefined)
    try { await removePublication() } finally {
      await ssh?.close()
      await owner.close()
      await rm(root, { recursive: true, force: true, maxRetries: 3 })
    }
  }
})