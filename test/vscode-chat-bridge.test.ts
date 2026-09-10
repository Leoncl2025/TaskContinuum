// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { RemoteVSCodeManager } from '../src/main/vscodeRemoteClient'
import type { VSCodeChatTarget } from '../src/shared/remoteVSCode'
import { registerVSCodeChatBridge } from '../src/main/vscodeChatBridge'

const native = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(), confirm: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => native.handlers.set(name, handler) },
  dialog: { showMessageBox: native.confirm }, shell: { openExternal: vi.fn() },
}))
let close: (() => void) | undefined
afterEach(() => { close?.(); native.handlers.clear(); vi.clearAllMocks() })

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