// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { RemoteVSCodeManager } from '../src/main/vscodeRemoteClient'
import type { VSCodeChatTarget } from '../src/shared/remoteVSCode'
import { registerVSCodeChatBridge } from '../src/main/vscodeChatBridge'
import { registerAgentHostBridge } from '../src/main/agentHostBridge'
import type { AgentHostManager } from '../src/main/agentHostManager'

const native = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(), confirm: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => native.handlers.set(name, handler) },
  dialog: { showMessageBox: native.confirm }, shell: { openExternal: vi.fn() },
  app: { getPath: () => 'isolated-profile' },
}))
vi.mock('../src/main/clientIdentity', () => ({ readClientIdentity: async () => ({ clientId: '00000000-0000-4000-8000-000000000001', machineName: 'Client-A', username: 'Alice' }) }))
let close: (() => void) | undefined
afterEach(() => { close?.(); native.handlers.clear(); vi.clearAllMocks() })

describe('trusted AHP desktop operations', () => {
  function ahpFixture() {
    const target = { hostId: 'host-instance-123', sessionId: 'ahp-session:/original', chatId: 'ahp-chat:/original/main', owner: { clientId: crypto.randomUUID(), machineName: 'Owner-B' } }
    let root = 'workspace-a'
    let trusted = true
    let authorized = true
    let preparing = async () => {}
    const window = { isDestroyed: () => !trusted, webContents: { isDestroyed: () => !trusted, send: vi.fn() } } as unknown as BrowserWindow
    const executed = vi.fn()
    const connection = { models: vi.fn(async () => { await preparing(); return [{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli' }] }), send: vi.fn(async (_id: string, _text: string, _images: unknown, authorize: () => Promise<void>) => { await preparing(); await authorize(); executed() }) }
    const manager = { authorize: vi.fn(async () => { if (!authorized) throw new Error('Session authorization changed.') }), connection: vi.fn(async () => connection), hasConsent: vi.fn(async () => true) }
    close = registerAgentHostBridge(() => { if (!trusted) throw new Error('Untrusted IPC request.'); return window }, async () => root, manager as unknown as AgentHostManager).close
    return { target, manager, executed, connection, prepare: (action: () => Promise<void>) => { preparing = action }, move: () => { root = 'workspace-b' }, revoke: () => { authorized = false }, destroy: () => { trusted = false }, send: (value: unknown = target) => native.handlers.get('agent-host:send')!({}, value, crypto.randomUUID(), 'One explicit request') }
  }

  it('checks renderer identity and rejects malformed targets before connection', async () => {
    const setup = ahpFixture()
    await expect(setup.send({ ...setup.target, endpoint: 'ws://untrusted' })).rejects.toThrow()
    expect(setup.manager.connection).not.toHaveBeenCalled()
    setup.destroy()
    await expect(setup.send()).rejects.toThrow('Untrusted')
    expect(setup.manager.connection).not.toHaveBeenCalled()
  })

  it('forwards explicit models and rejects malformed selections before connecting', async () => {
    const setup = ahpFixture()
    const send = native.handlers.get('agent-host:send')!
    await expect(send({}, setup.target, crypto.randomUUID(), 'Use GPT-6', undefined, { id: '' })).rejects.toThrow()
    expect(setup.manager.connection).not.toHaveBeenCalled()
    await expect(send({}, setup.target, crypto.randomUUID(), 'Use GPT-6', undefined, { id: 'gpt-6', config: { contextSize: [872000] } })).rejects.toThrow()
    expect(setup.manager.connection).not.toHaveBeenCalled()
    const model = { id: 'gpt-6', config: { thinkingLevel: 'max', contextSize: 872000 } }
    await send({}, setup.target, crypto.randomUUID(), 'Use GPT-6', undefined, model)
    expect(setup.connection.send).toHaveBeenCalledWith(expect.any(String), 'Use GPT-6', undefined, expect.any(Function), expect.objectContaining({ username: 'Alice' }), model)
  })

  it('authorizes catalog reads again before returning model information', async () => {
    const setup = ahpFixture()
    const models = native.handlers.get('agent-host:models')!
    expect(await models({}, setup.target)).toEqual([{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli' }])
    setup.prepare(async () => setup.revoke())
    await expect(models({}, setup.target)).rejects.toThrow('authorization changed')
  })

  it.each(['workspace', 'authorization', 'window'])('fences a changed %s before dispatch without replay', async (change) => {
    const setup = ahpFixture()
    setup.prepare(async () => { if (change === 'workspace') setup.move(); else if (change === 'authorization') setup.revoke(); else setup.destroy() })
    await expect(setup.send()).rejects.toThrow('changed')
    expect(setup.executed).not.toHaveBeenCalled()
    expect(setup.connection.send).toHaveBeenCalledOnce()
  })

  it('submits once and carries the local participant without a second confirmation', async () => {
    const setup = ahpFixture()
    await setup.send()
    expect(setup.executed).toHaveBeenCalledOnce()
    expect(setup.connection.send).toHaveBeenCalledWith(expect.any(String), 'One explicit request', undefined, expect.any(Function), { clientId: '00000000-0000-4000-8000-000000000001', machineName: 'Client-A', username: 'Alice' }, undefined)
    expect(native.confirm).not.toHaveBeenCalled()
  })
})

function fixture() {
  const target: VSCodeChatTarget = { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32), remoteMachineName: 'Machine-B' }
  let root = 'workspace-a'
  let destroyed = false
  const window = { isDestroyed: () => destroyed, webContents: { isDestroyed: () => destroyed } } as unknown as BrowserWindow
  const order: string[] = []
  const remote = {
    resolveTarget: vi.fn(async (_root: string, value: VSCodeChatTarget) => value),
    connectTarget: vi.fn(async () => { order.push('connect') }),
    send: vi.fn(async () => { order.push('send'); return { state: 'pending' } }),
  }
  close = registerVSCodeChatBridge(() => window, () => window, remote as unknown as RemoteVSCodeManager, async () => root).close
  const commandId = crypto.randomUUID()
  return { target, commandId, remote, order, changeRoot: () => { root = 'workspace-b' }, destroy: () => { destroyed = true },
    send: () => native.handlers.get('vscode-chat:send')!({}, target, commandId, 'One explicit message'),
  }
}

describe('single-action original-session submission', () => {
  it('validates image-only payloads before connecting and forwards bytes to the captured target', async () => {
    const setup = fixture()
    const image = { id: crypto.randomUUID(), name: 'Screenshot.png', mimeType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
    const send = native.handlers.get('vscode-chat:send')!
    await expect(send({}, setup.target, setup.commandId, '', [{ ...image, data: 'invalid' }])).rejects.toThrow()
    expect(setup.remote.connectTarget).not.toHaveBeenCalled()
    await send({}, setup.target, setup.commandId, '', [image])
    expect(setup.remote.send).toHaveBeenCalledExactlyOnceWith('workspace-a', setup.target, setup.commandId, '', [image])
  })

  it('connects the captured remote before one send without an extra open confirmation', async () => {
    const setup = fixture()
    expect(await setup.send()).toEqual({ state: 'pending' })
    expect(setup.order).toEqual(['connect', 'send'])
    expect(setup.remote.connectTarget).toHaveBeenCalledExactlyOnceWith('workspace-a', setup.target)
    expect(setup.remote.send).toHaveBeenCalledExactlyOnceWith('workspace-a', setup.target, setup.commandId, 'One explicit message')
    expect(native.confirm).not.toHaveBeenCalled()
  })

  it.each(['workspace', 'owner', 'window'])('rejects a changed %s after connection without sending', async (changed) => {
    const setup = fixture()
    setup.remote.connectTarget.mockImplementation(async () => {
      if (changed === 'workspace') setup.changeRoot()
      if (changed === 'owner') setup.remote.resolveTarget.mockResolvedValue({ ...setup.target, remoteMachineName: 'Machine-C' })
      if (changed === 'window') setup.destroy()
    })
    await expect(setup.send()).rejects.toThrow('changed while preparing')
    expect(setup.remote.send).not.toHaveBeenCalled()
    expect(native.confirm).not.toHaveBeenCalled()
  })

  it('does not retry a failed connection or enqueue the message', async () => {
    const setup = fixture()
    setup.remote.connectTarget.mockRejectedValue(new Error('The owner is offline.'))
    await expect(setup.send()).rejects.toThrow('owner is offline')
    expect(setup.remote.connectTarget).toHaveBeenCalledOnce()
    expect(setup.remote.send).not.toHaveBeenCalled()
  })
})