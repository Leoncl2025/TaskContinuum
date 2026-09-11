// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'
import type { startVSCodeChatCompanion } from '../src/main/vscodeChatCompanion'
import type { dispatchVSCodeMessage } from '../src/main/vscodeChatDispatch'

const fixture = vi.hoisted(() => ({
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  settings: new Map<string, boolean>(),
  handler: undefined as { handleUri(uri: unknown): Promise<void> } | undefined,
  trusted: true, remote: undefined as string | undefined, version: '1.136.1',
  start: vi.fn(), close: vi.fn(), probe: vi.fn(), confirm: vi.fn(), error: vi.fn(), execute: vi.fn(), warning: vi.fn(), dispatch: vi.fn(),
}))
vi.mock('vscode', () => ({
  get version() { return fixture.version }, StatusBarAlignment: { Right: 2 },
  Uri: { parse: (value: string) => value, joinPath: () => ({ fsPath: 'template' }) },
  env: { get remoteName() { return fixture.remote }, uriScheme: 'vscode' },
  workspace: { get isTrusted() { return fixture.trusted }, workspaceFolders: [{ uri: { scheme: 'file' } }], fs: { writeFile: vi.fn() }, getConfiguration: () => ({ get: (key: string, fallback: boolean) => fixture.settings.get(key) ?? fallback }) },
  window: { createStatusBarItem: () => ({ show: vi.fn(), hide: vi.fn(), dispose: vi.fn() }), showInformationMessage: fixture.confirm, showWarningMessage: fixture.warning, showErrorMessage: fixture.error, registerUriHandler: (handler: typeof fixture.handler) => { fixture.handler = handler; return { dispose() {} } } },
  commands: { registerCommand: (id: string, action: (...args: unknown[]) => unknown) => { fixture.commands.set(id, action); return { dispose() {} } }, getCommands: async () => ['workbench.action.chat.openSessionInEditorGroup', 'workbench.action.chat.executeHandoff', 'workbench.action.chat.getHandoffs'], executeCommand: fixture.execute },
}))
vi.mock('../src/main/vscodeChatCompanion', () => ({ startVSCodeChatCompanion: fixture.start }))
vi.mock('../src/main/vscodeChatDispatch', () => ({ verifyVSCodeDeliveryTemplate: fixture.probe, dispatchVSCodeMessage: fixture.dispatch }))
vi.mock('../src/main/vscodeSessions', () => ({ VSCodeSessionStore: class { async locateOriginal() { return { snapshot: { session: { title: 'Original' } } } } } }))
import { activate, deactivate } from '../src/main/vscodeChatExtension'

function context(enabled = false) {
  const values = new Map<string, unknown>([['taskcontinuum.bridgeEnabled', enabled]])
  const workspaceState = { get: (key: string, fallback: unknown) => values.get(key) ?? fallback, update: vi.fn(async (key: string, value: unknown) => { values.set(key, value) }) }
  return { subscriptions: [], storageUri: { scheme: 'file', fsPath: '/storage/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bridge' }, extensionUri: { fsPath: '/extension' }, extension: { id: 'taskcontinuum.vscode-bridge' }, workspaceState } as unknown as vscode.ExtensionContext
}
beforeEach(() => {
  fixture.commands.clear(); fixture.settings.clear(); fixture.trusted = true; fixture.remote = undefined; fixture.version = '1.136.1'
  vi.clearAllMocks()
  fixture.start.mockResolvedValue({ close: fixture.close })
  fixture.close.mockResolvedValue(undefined); fixture.probe.mockResolvedValue(undefined)
  fixture.confirm.mockResolvedValue('Connect')
  fixture.warning.mockResolvedValue('Send to original session')
})
afterEach(async () => { await deactivate(); vi.useRealTimers() })

it('declares direct sending as the machine default', async () => {
  const manifest = JSON.parse(await readFile(new URL('../vscode-bridge/package.json', import.meta.url), 'utf8'))
  expect(manifest.contributes.configuration.properties['taskcontinuum.confirmOriginalSessionSend']).toMatchObject({ default: false, scope: 'machine' })
})

it('sends directly by default while honoring confirmation changes and workspace trust', async () => {
  activate(context())
  await fixture.commands.get('taskcontinuum.startBridge')!()
  const options = fixture.start.mock.calls[0][0] as Parameters<typeof startVSCodeChatCompanion>[0]
  const identity = { workspaceStorageId: 'a'.repeat(32), nativeSessionId: 'original' }
  const delivery = { id: crypto.randomUUID(), nativeSessionId: identity.nativeSessionId, text: 'Continue once',
    participant: { username: 'Alice', machineName: 'A' }, execution: { agentName: 'GitHub Copilot', machineName: 'B' },
    createdAt: new Date().toISOString(), state: 'pending' as const }
  await options.dispatch!(identity, delivery, new AbortController().signal)
  const { commands } = fixture.dispatch.mock.calls[0][0] as Parameters<typeof dispatchVSCodeMessage>[0]

  await expect(commands.confirm(identity, delivery, 'Original')).resolves.toBe(true)
  expect(fixture.warning).not.toHaveBeenCalled()
  fixture.settings.set('confirmOriginalSessionSend', false)
  await expect(commands.confirm(identity, delivery, 'Original')).resolves.toBe(true)
  expect(fixture.warning).not.toHaveBeenCalled()

  fixture.settings.set('confirmOriginalSessionSend', true)
  await expect(commands.confirm(identity, delivery, 'Original')).resolves.toBe(true)
  expect(fixture.warning).toHaveBeenCalledWith('Send to original Copilot conversation "Original"?', expect.objectContaining({ modal: true }), 'Send to original session')
  fixture.warning.mockResolvedValueOnce(undefined)
  await expect(commands.confirm(identity, delivery, 'Original')).resolves.toBe(false)

  fixture.settings.set('confirmOriginalSessionSend', false)
  fixture.trusted = false
  fixture.warning.mockClear()
  await expect(commands.confirm(identity, delivery, 'Original')).resolves.toBe(false)
  expect(fixture.warning).not.toHaveBeenCalled()
})

it('does not start an unapproved workspace; explicit start persists and restores after restart', async () => {
  const state = context()
  activate(state)
  expect(fixture.start).not.toHaveBeenCalled()
  await fixture.commands.get('taskcontinuum.startBridge')!()
  expect(fixture.start).toHaveBeenCalledOnce()
  expect(state.workspaceState.get('taskcontinuum.bridgeEnabled')).toBe(true)
  await deactivate()
  activate(state)
  await vi.waitFor(() => expect(fixture.start).toHaveBeenCalledTimes(2))
  expect(fixture.confirm).not.toHaveBeenCalled()
  expect(fixture.execute.mock.calls.every(([command]) => command === 'setContext')).toBe(true)
  await fixture.commands.get('taskcontinuum.stopBridge')!()
  expect(state.workspaceState.get('taskcontinuum.bridgeEnabled')).toBe(false)
  await deactivate(); activate(state)
  expect(fixture.start).toHaveBeenCalledTimes(2)
})

it('bounds startup retries and cancels them when explicitly stopped', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  fixture.probe.mockRejectedValue(new Error('Commands not ready'))
  activate(context(true))
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.probe).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(30000)
  expect(fixture.probe).toHaveBeenCalledTimes(4)
  expect(fixture.error).toHaveBeenCalledOnce()
  await fixture.commands.get('taskcontinuum.stopBridge')!()
  await vi.advanceTimersByTimeAsync(60000)
  expect(fixture.probe).toHaveBeenCalledTimes(4)
  expect(fixture.start).not.toHaveBeenCalled()
})

it('does not auto-start untrusted or remote workspaces even with saved consent', () => {
  fixture.trusted = false
  activate(context(true))
  expect(fixture.start).not.toHaveBeenCalled()
  fixture.trusted = true; fixture.remote = 'ssh-remote'
  activate(context(true))
  expect(fixture.start).not.toHaveBeenCalled()
})

it('restores on 1.137 but keeps unsupported versions closed', async () => {
  fixture.version = '1.137.0'
  activate(context(true))
  await vi.waitFor(() => expect(fixture.start).toHaveBeenCalledOnce())
  expect(fixture.start.mock.calls[0][0].vscodeVersion).toBe('1.137.0')
  await deactivate()
  fixture.version = '1.138.0'
  activate(context(true))
  expect(fixture.start).toHaveBeenCalledOnce()
  await fixture.commands.get('taskcontinuum.startBridge')!()
  expect(fixture.error).toHaveBeenLastCalledWith(expect.stringContaining('not verified'))
  expect(fixture.start).toHaveBeenCalledOnce()
})

it('does not finish starting after Stop was requested during readiness', async () => {
  let finish!: () => void
  fixture.probe.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
  const state = context()
  activate(state)
  const starting = fixture.commands.get('taskcontinuum.startBridge')!()
  await vi.waitFor(() => expect(fixture.probe).toHaveBeenCalledOnce())
  await fixture.commands.get('taskcontinuum.stopBridge')!()
  finish()
  await starting
  expect(fixture.start).not.toHaveBeenCalled()
  expect(state.workspaceState.get('taskcontinuum.bridgeEnabled')).toBe(false)
})