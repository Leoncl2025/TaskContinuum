import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { hostname, tmpdir, userInfo } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { VSCodeSessionStore } from '../src/main/vscodeSessions'
import { connectOriginalVSCode, grantRemoteVSCode, openOriginalVSCode, readOriginalVSCode, sendOriginalVSCode } from '../src/main/vscodeChatClient'
import { identityFromVSCodeHistory, vsCodeChatResource } from '../src/shared/vscodeChat'
import { RemoteVSCodeManager } from '../src/main/vscodeRemoteClient'
import { openSshTunnel } from '../src/main/shared/ssh'
import { startSshFixture } from '../test/ssh-fixture'

test('connects from the desktop and sends to the original sidebar conversation without moving its layout in installed VS Code', async () => {
  test.skip(!process.env.TASKCONTINUUM_VERIFY_VSCODE, 'Set the local Code executable path to verify the companion without model requests.')
  test.setTimeout(240000)
  const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-vscode-e2e-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  const storageRoot = join(profile, 'User', 'workspaceStorage')
  const extensions = join(root, '.vscode', 'extensions')
  const manifest = JSON.parse(await readFile(resolve('vscode-bridge/package.json'), 'utf8')) as { version: string }
  const installedExtension = join(extensions, `taskcontinuum.vscode-bridge-${manifest.version}`)
  await mkdir(workspace, { recursive: true })
  await mkdir(join(profile, 'User'), { recursive: true })
  await writeFile(join(profile, 'User', 'settings.json'), JSON.stringify({ 'window.dialogStyle': 'custom', 'telemetry.telemetryLevel': 'off', 'files.watcherExclude': { '**': true } }))
  await cp(resolve('vscode-bridge'), installedExtension, { recursive: true })
  await mkdir(resolve('artifacts'), { recursive: true })
  await writeFile(join(workspace, 'fixture.txt'), 'Task Continuum original conversation fixture.\n')
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.VSCODE_IPC_HOOK_CLI
  const verifyingSend = process.env.TASKCONTINUUM_VERIFY_VSCODE_SEND === '1'
  if (verifyingSend) await cp(resolve('e2e/fixtures/vscode-model'), join(extensions, 'taskcontinuum.vscode-model-test'), { recursive: true })
  let app: ElectronApplication | undefined
  let page: Page | undefined
  let mainPid: number | undefined
  let remote: RemoteVSCodeManager | undefined
  let ssh: Awaited<ReturnType<typeof startSshFixture>> | undefined
  try {
    app = await electron.launch({
      executablePath: process.env.TASKCONTINUUM_VERIFY_VSCODE,
      args: ['--user-data-dir', profile, '--extensions-dir', extensions, ...(verifyingSend ? ['--log', 'trace'] : []), ...['MAI-EngineeringSystems.mai-mcpservers', 'MAI-EngineeringSystems.mai-ai-telemetry', 'MAI-EngineeringSystems.mai-papyrusproxy', 'DevCenter.ms-devbox', 'Anthropic.claude-code'].flatMap((id) => ['--disable-extension', id]), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-telemetry', '--new-window', workspace],
      env: environment, timeout: 45000,
    })
    mainPid = app.process().pid
    page = await app.firstWindow()
    await page.locator('.monaco-workbench').waitFor({ timeout: 30000 })
    if (verifyingSend) await expect(page.getByRole('button', { name: 'Test model ready', exact: true })).toBeVisible({ timeout: 20000 })
    const command = page.locator('.quick-input-widget input').first()
    let workspaceStorageId = ''
    await expect.poll(async () => {
      const workspaces = await readdir(storageRoot, { withFileTypes: true }).catch(() => [])
      for (const entry of workspaces.filter((item) => item.isDirectory() && /^[a-f0-9]{32}$/.test(item.name))) {
        const metadata = JSON.parse(await readFile(join(storageRoot, entry.name, 'workspace.json'), 'utf8')) as { folder?: string }
        if (!metadata.folder || resolve(fileURLToPath(metadata.folder)).toLowerCase() !== resolve(workspace).toLowerCase()) continue
        workspaceStorageId = entry.name
        return true
      }
      return false
    }, { timeout: 15000 }).toBe(true)
    const nativeSessionId = randomUUID()
    const directory = join(storageRoot, workspaceStorageId, 'chatSessions')
    await mkdir(directory, { recursive: true })
    const originalQuestion = 'Original bridge question'
    const sourceData = {
      version: 3, sessionId: nativeSessionId, creationDate: Date.now(), initialLocation: 'panel',
      customTitle: 'Original bridge fixture', requesterUsername: 'Fixture user', responderUsername: 'GitHub Copilot',
      inputState: { mode: { id: 'agent', kind: 'agent' }, inputText: '', attachments: [], selections: [], contrib: {}, ...(verifyingSend ? { selectedModel: { identifier: 'taskcontinuum-test/deterministic', metadata: { id: 'deterministic', name: 'Task Continuum Deterministic', vendor: 'taskcontinuum-test', family: 'taskcontinuum-test', version: '1', maxInputTokens: 128000, maxOutputTokens: 4096, isUserSelectable: true, capabilities: { toolCalling: true, agentMode: true } } } } : {}) },
      requests: [{ requestId: randomUUID(), responseId: randomUUID(), message: { text: originalQuestion, parts: [{ kind: 'text', text: originalQuestion, range: { start: 0, endExclusive: originalQuestion.length }, editorRange: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: originalQuestion.length + 1 } }] }, response: [{ kind: 'markdownContent', content: { value: 'Original bridge answer' } }], result: {}, variableData: { variables: [] }, isCanceled: false }],
    }
    const source = JSON.stringify({ kind: 0, v: sourceData }) + '\n'
    const sourceFile = join(directory, `${nativeSessionId}.jsonl`)
    await writeFile(sourceFile, source)
    const identity = { nativeSessionId, workspaceStorageId }
    const sourceStore = new VSCodeSessionStore([storageRoot])
    expect(await readOriginalVSCode(sourceStore, identity)).toMatchObject({ connectionState: 'offline', canSend: false })
    await connectOriginalVSCode(sourceStore, identity, async (uri) => {
      await promisify(execFile)(process.env.TASKCONTINUUM_VERIFY_VSCODE!, ['--user-data-dir', profile, '--open-url', uri], { env: environment, timeout: 15000 })
    })
    const connectDialog = page.getByRole('dialog').filter({ hasText: 'Connect Task Continuum to this VS Code workspace?' })
    const uriPermission = page.getByRole('dialog').filter({ hasText: "Allow 'Task Continuum Bridge' extension to open this URI?" })
    await expect(connectDialog.or(uriPermission)).toBeVisible({ timeout: 30000 })
    if (await uriPermission.isVisible()) await uriPermission.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(connectDialog).toContainText(nativeSessionId, { timeout: 30000 })
    await connectDialog.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByRole('button', { name: /Original-chat bridge is running/ })).toBeVisible({ timeout: 30000 })
    await expect.poll(async () => (await readOriginalVSCode(sourceStore, identity)).connectionState).toBe('connected')
    expect(await readFile(sourceFile, 'utf8')).toBe(source)
    await openOriginalVSCode(sourceStore, identity)
    const editor = page.locator('[data-bound-chat-resource]').filter({ has: page.getByText('Original bridge answer', { exact: true }) })
    await expect(editor).toHaveAttribute('data-bound-chat-resource', vsCodeChatResource(nativeSessionId))
    await expect(editor.getByText('Original bridge question', { exact: true })).toBeVisible()
    if (verifyingSend) await expect(editor.getByRole('button', { name: 'Models, Task Continuum Deterministic', exact: true })).toBeVisible()
    expect((await readdir(directory)).filter((file) => /\.jsonl?$/.test(file))).toEqual([`${nativeSessionId}.jsonl`])
    expect(await readFile(sourceFile, 'utf8')).toBe(source)
    await page.screenshot({ path: resolve('artifacts/vscode-original-session.png') })
    if (verifyingSend) {
      await page.keyboard.press('Control+Shift+P')
      await command.fill('>Chat: Move Chat into Side Bar')
      await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Move Chat into Side Bar' }).first().click()
      const originalSidebar = page.locator('[id="workbench.parts.auxiliarybar"]')
      await expect(originalSidebar.getByText(originalQuestion, { exact: true })).toBeVisible()
      await expect(originalSidebar.getByRole('button', { name: 'Pick Agent Session', exact: true })).toHaveText('Original bridge fixture')
      await expect(page.locator(`.part.editor [data-bound-chat-resource="${vsCodeChatResource(nativeSessionId)}"]`)).toHaveCount(0)
      const otherId = randomUUID()
      const otherSource = JSON.stringify({ kind: 0, v: { ...sourceData, sessionId: otherId, customTitle: 'Untouched bridge fixture' } }) + '\n'
      const otherFile = join(directory, `${otherId}.jsonl`)
      await writeFile(otherFile, otherSource)
      const store = new VSCodeSessionStore([storageRoot])
      await openOriginalVSCode(store, { nativeSessionId: otherId, workspaceStorageId })
      const otherEditor = page.locator(`.part.editor [data-bound-chat-resource="${vsCodeChatResource(otherId)}"]`)
      await expect(otherEditor).toBeVisible()
      const layout = () => page!.evaluate(() => ({
        groups: document.querySelectorAll('.editor-group-container').length,
        editorTabs: [...document.querySelectorAll('.part.editor .tab[role="tab"]')].map((tab) => ({ label: tab.getAttribute('aria-label'), selected: tab.getAttribute('aria-selected') })),
        parts: [...document.querySelectorAll('.part.editor, .part.sidebar, .part.auxiliarybar')].map((part) => {
          const bounds = part.getBoundingClientRect()
          return { id: part.id, x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) }
        }),
      }))
      const originalLayout = await layout()
      await page.screenshot({ path: resolve('artifacts/vscode-layout-before-send.png') })
      const commandId = randomUUID()
      const prompt = '@continuum_test Reply with exactly TASKCONTINUUM_ORIGINAL_SEND_OK. Do not call tools or change files.'
      const delivery = await sendOriginalVSCode(store, identity, commandId, prompt)
      expect(delivery).toMatchObject({ state: 'pending', participant: { username: userInfo().username }, execution: { machineName: hostname() } })
      const confirmation = page.getByRole('dialog').filter({ hasText: 'Send to original Copilot conversation' })
      await expect(confirmation).toContainText(nativeSessionId)
      await expect(confirmation).toContainText(userInfo().username)
      await test.step('Confirm the original session submission', async () => {
        await confirmation.getByRole('button', { name: 'Send to original session', exact: true }).click()
      }, { timeout: 10000 })
      await test.step('Verify the original sidebar received the request without moving either conversation', async () => {
        await expect(originalSidebar).toContainText(commandId, { timeout: 20000 })
        await expect(originalSidebar.getByText('TASKCONTINUUM_ORIGINAL_SEND_OK', { exact: true })).toBeVisible({ timeout: 15000 })
        await expect(otherEditor).toBeVisible()
        await expect(otherEditor).not.toContainText(commandId)
        await expect(page!.locator(`.part.editor [data-bound-chat-resource="${vsCodeChatResource(nativeSessionId)}"]`)).toHaveCount(0)
        expect(await layout()).toEqual(originalLayout)
        await page!.screenshot({ path: resolve('artifacts/vscode-layout-after-send.png') })
      }, { timeout: 40000 })
      await test.step('Observe the persisted original request', async () => { await expect.poll(async () => {
        const view = await readOriginalVSCode(store, identity)
        const record = view.deliveries?.find((entry) => entry.id === commandId)
        if (record?.state === 'failed' || record?.state === 'uncertain') throw new Error(record.error)
        return { state: record?.state, error: record?.error }
      }, { timeout: 110000 }).toEqual({ state: 'submitted', error: undefined }) }, { timeout: 120000 })
      const submitted = await readOriginalVSCode(store, identity)
      const record = submitted.deliveries!.find((entry) => entry.id === commandId)!
      expect(submitted.messages.find((message) => message.nativeRequestId === record.nativeRequestId && message.role === 'user')).toMatchObject({ text: prompt, author: { name: userInfo().username, machineName: hostname() } })
      await expect.poll(async () => {
        const view = await readOriginalVSCode(store, identity)
        return view.messages.find((message) => message.nativeRequestId === record.nativeRequestId && message.role === 'assistant')
      }, { timeout: 30000 }).toMatchObject({ text: 'TASKCONTINUUM_ORIGINAL_SEND_OK', status: 'complete', author: { machineName: hostname() } })
      expect((await store.locateOriginal(identity)).state.turns).toHaveLength(2)
      const other = await store.locateOriginal({ nativeSessionId: otherId, workspaceStorageId })
      expect(other.state.turns).toHaveLength(1)
      expect(other.state.turns[0]).toMatchObject({ id: sourceData.requests[0].requestId, prompt: originalQuestion, complete: true })
      expect(other.snapshot.messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: 'user', text: originalQuestion }, { role: 'assistant', text: 'Original bridge answer' },
      ])
      expect((await readFile(otherFile, 'utf8')).includes(commandId)).toBe(false)
      const listed = await store.list()
      expect(new Set(listed.sessions.map((session) => identityFromVSCodeHistory(session.id).nativeSessionId))).toEqual(new Set([nativeSessionId, otherId]))
      await sendOriginalVSCode(store, identity, commandId, prompt)
      expect((await store.locateOriginal(identity)).state.turns).toHaveLength(2)
      await expect(confirmation).toBeHidden()
      expect(await layout()).toEqual(originalLayout)
      await expect(originalSidebar).toContainText('TASKCONTINUUM_ORIGINAL_SEND_OK')
      await expect(otherEditor).toBeVisible()
      await page.screenshot({ path: resolve('artifacts/vscode-original-send.png') })
      await page.getByRole('button', { name: 'Test model ready', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Delivery confirmation disabled', exact: true })).toBeVisible()
      const secondCommandId = randomUUID()
      const secondPrompt = '@continuum_test Second distinct message. Reply with exactly TASKCONTINUUM_ORIGINAL_SEND_OK. Do not call tools or change files.'
      const remoteParticipant = { clientId: randomUUID(), username: 'Remote test user', machineName: 'Machine-A' }
      const invitation = await grantRemoteVSCode(store, identity, remoteParticipant, true)
      const forwarding = await startSshFixture(join(root, 'ssh'), invitation.port)
      ssh = forwarding
      remote = new RemoteVSCodeManager(join(root, 'remote-client'), { identity: async () => remoteParticipant, tunnel: (host, port, signal) => openSshTunnel(host, port, forwarding.config, signal) })
      const enrollment = await remote.importInvitation(workspace, invitation, 'owner-machine')
      await remote.connect(workspace, enrollment.id)
      await expect.poll(async () => {
        const view = await readOriginalVSCode(store, identity)
        return { canSend: view.canSend, reason: view.bridgeError }
      }).toEqual({ canSend: true, reason: undefined })
      expect(await remote.send(workspace, enrollment.target, secondCommandId, secondPrompt)).toMatchObject({ state: 'pending', id: secondCommandId, participant: remoteParticipant, execution: { machineName: hostname() } })
      await expect(confirmation).toBeHidden()
      await expect(originalSidebar).toContainText(secondCommandId, { timeout: 20000 })
      await expect(confirmation).toBeHidden()
      await expect.poll(async () => {
        const view = await readOriginalVSCode(store, identity)
        const secondDelivery = view.deliveries?.find((entry) => entry.id === secondCommandId)
        expect(secondDelivery?.state, secondDelivery?.error).not.toBe('failed')
        expect(secondDelivery?.state, secondDelivery?.error).not.toBe('uncertain')
        const reply = view.messages.find((message) => message.role === 'assistant' && message.nativeRequestId === secondDelivery?.nativeRequestId)
        return { state: secondDelivery?.state, reply: reply?.text, complete: reply?.status }
      }, { timeout: 110000 }).toEqual({ state: 'submitted', reply: 'TASKCONTINUUM_ORIGINAL_SEND_OK', complete: 'complete' })
      const finalView = await readOriginalVSCode(store, identity)
      const secondDelivery = finalView.deliveries!.find((entry) => entry.id === secondCommandId)!
      expect(secondDelivery.nativeRequestId).not.toBe(record.nativeRequestId)
      const remoteView = await remote.read(workspace, enrollment.target)
      expect(remoteView.messages.find((message) => message.role === 'user' && message.nativeRequestId === secondDelivery.nativeRequestId)).toMatchObject({ author: { name: remoteParticipant.username, machineName: remoteParticipant.machineName } })
      expect(forwarding.forwardedConnections()).toBeGreaterThan(0)
      expect(finalView.messages.find((message) => message.role === 'user' && message.nativeRequestId === secondDelivery.nativeRequestId)?.text).toBe(secondPrompt)
      expect((await store.locateOriginal(identity)).state.turns).toHaveLength(3)
      expect((await store.locateOriginal({ nativeSessionId: otherId, workspaceStorageId })).state.turns).toHaveLength(1)
      await expect(originalSidebar).toContainText(secondCommandId)
      await expect(otherEditor).not.toContainText(secondCommandId)
      await expect(confirmation).toBeHidden()
      expect(await layout()).toEqual(originalLayout)
      expect(await readFile(join(installedExtension, 'out', 'delivery.agent.md'), 'utf8')).toBe(await readFile(resolve('vscode-bridge/delivery.agent.md'), 'utf8'))
      await page.screenshot({ path: resolve('artifacts/vscode-template-repeat-send.png') })
    }
    await test.step('Explicitly open a different saved original over SSH without creating or sending implicitly', async () => {
      const switchId = randomUUID()
      const switchFile = join(directory, `${switchId}.jsonl`)
      await writeFile(switchFile, JSON.stringify({ kind: 0, v: { ...sourceData, sessionId: switchId, customTitle: 'Remote switch fixture' } }) + '\n')
      const switchIdentity = { nativeSessionId: switchId, workspaceStorageId }
      const participant = { clientId: randomUUID(), username: 'Switch user', machineName: 'Machine-C' }
      const invitation = await grantRemoteVSCode(sourceStore, switchIdentity, participant, true)
      if (!ssh) ssh = await startSshFixture(join(root, 'switch-ssh'), invitation.port)
      const forwarding = ssh
      if (!remote) remote = new RemoteVSCodeManager(join(root, 'switch-client'), { identity: async () => participant, tunnel: (host, port, signal) => openSshTunnel(host, port, forwarding.config, signal) })
      const switchRemote = new RemoteVSCodeManager(join(root, 'switch-only-client'), { identity: async () => participant, tunnel: (host, port, signal) => openSshTunnel(host, port, forwarding.config, signal) })
      try {
        const enrolled = await switchRemote.importInvitation(workspace, invitation, 'owner-machine')
        await switchRemote.connect(workspace, enrolled.id)
        const before = (await sourceStore.locateOriginal(identity)).state.turns.length
        const switched = page!.locator(`.part.editor [data-bound-chat-resource="${vsCodeChatResource(switchId)}"]`)
        await expect(switched).toHaveCount(0)
        await switchRemote.open(workspace, enrolled.target)
        await expect(switched).toBeVisible()
        await expect(switched.getByText(originalQuestion, { exact: true })).toBeVisible()
        expect((await sourceStore.locateOriginal(switchIdentity)).state.turns).toHaveLength(1)
        expect((await sourceStore.locateOriginal(identity)).state.turns).toHaveLength(before)
        if (verifyingSend) {
          const commandId = randomUUID()
          const prompt = '@continuum_test Reply with exactly TASKCONTINUUM_ORIGINAL_SEND_OK. Do not call tools or change files.'
          await switchRemote.send(workspace, enrolled.target, commandId, prompt)
          await expect(switched).toContainText(commandId, { timeout: 20000 })
          await expect.poll(async () => {
            const view = await switchRemote.read(workspace, enrolled.target)
            const receipt = view.deliveries?.find((item) => item.id === commandId)
            const reply = view.messages.find((message) => message.role === 'assistant' && message.nativeRequestId === receipt?.nativeRequestId)
            return { state: receipt?.state, reply: reply?.text, complete: reply?.status }
          }, { timeout: 110000 }).toEqual({ state: 'submitted', reply: 'TASKCONTINUUM_ORIGINAL_SEND_OK', complete: 'complete' })
          expect((await sourceStore.locateOriginal(identity)).state.turns).toHaveLength(before)
        }
        await page!.screenshot({ path: resolve('artifacts/vscode-explicit-remote-switch.png') })
      } finally { switchRemote.close() }
    }, { timeout: 140000 })
    const bridgeDirectory = join(storageRoot, workspaceStorageId, 'taskcontinuum.vscode-bridge', 'bridges')
    const priorDescriptors = await readdir(bridgeDirectory)
    await page.keyboard.press('Control+Shift+P')
    await command.fill('>Developer: Reload Window')
    await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Developer: Reload Window' }).first().click()
    await expect.poll(async () => {
      const descriptors = await readdir(bridgeDirectory).catch(() => [])
      return descriptors.some((file) => !priorDescriptors.includes(file))
    }, { timeout: 60000 }).toBe(true)
    await expect.poll(async () => (await readOriginalVSCode(sourceStore, identity)).connectionState).toBe('connected')
    await expect(page.getByRole('dialog').filter({ hasText: 'Connect Task Continuum to this VS Code workspace?' })).toHaveCount(0)
    await page.getByRole('button', { name: /Original-chat bridge is running/ }).click()
    await expect.poll(() => readdir(bridgeDirectory)).toEqual([])
    await page.keyboard.press('Control+Shift+P')
    await command.fill('>Developer: Reload Window')
    await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Developer: Reload Window' }).first().click()
    await expect(page.locator('.monaco-workbench')).toBeVisible()
    await expect.poll(async () => (await readOriginalVSCode(sourceStore, identity)).connectionState).toBe('offline')
  } finally {
    remote?.close()
    await ssh?.close()
    if (page && !page.isClosed()) await page.screenshot({ path: resolve('artifacts/vscode-send-final-state.png'), timeout: 3000 }).catch(() => undefined)
    let cleanup: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([app?.close().catch(() => undefined), new Promise<void>((finish) => {
        cleanup = setTimeout(() => { if (mainPid) { try { process.kill(mainPid) } catch { finish(); return } } finish() }, 8000)
      })])
    } finally {
      clearTimeout(cleanup)
      await rm(root, { recursive: true, force: true, maxRetries: 3 })
    }
  }
})
