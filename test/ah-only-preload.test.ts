import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentHostTargetFixture } from './immutable-bindings-fixture'

const ipc = vi.hoisted(() => ({
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined),
  on: vi.fn(),
  removeListener: vi.fn(),
  expose: vi.fn((name: string, value: unknown) => { Reflect.set(window, name, value) }),
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: ipc.expose },
  ipcRenderer: { invoke: ipc.invoke, on: ipc.on, removeListener: ipc.removeListener },
}))

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  await import('../src/preload/index')
})
afterEach(() => {
  for (const name of ['desktop', 'workspace', 'agentHost', 'remoteVSCode', 'copilot', 'vscodeChat', 'sharedSessions']) Reflect.deleteProperty(window, name)
})

describe('native-only preload boundary', () => {
  it('exposes only native sessions, workspace metadata and retained desktop/device APIs', () => {
    expect(ipc.expose.mock.calls.map(([name]) => name).sort()).toEqual(['agentHost', 'desktop', 'remoteVSCode', 'workspace'])
    for (const name of ['copilot', 'vscodeChat', 'sharedSessions']) expect(Reflect.has(window, name)).toBe(false)
    expect(window.workspace).not.toHaveProperty('migrateSessionLinks')
    expect(window.remoteVSCode).toBeDefined()
    for (const name of ['list', 'connect', 'disconnect', 'forget', 'share', 'grants', 'revoke', 'importInvitation']) expect(window.remoteVSCode).not.toHaveProperty(name)
    expect(window.remoteVSCode?.devices).not.toHaveProperty('share')
    expect(window.remoteVSCode?.devices).not.toHaveProperty('unshare')
    expect(ipc.invoke).not.toHaveBeenCalled()
  })

  it('forwards explicit native send and cancel with the original target and model', async () => {
    const bridge = window.agentHost
    if (!bridge) throw new Error('Agent Host preload API missing.')
    const target = agentHostTargetFixture('original')
    await bridge.watch(target)
    await bridge.send(target, 'command-one', 'Explicit native request', undefined, { id: 'native-model' })
    await bridge.cancel(target, 'turn-one')
    expect(ipc.invoke.mock.calls).toEqual([
      ['agent-host:watch', target],
      ['agent-host:send', target, 'command-one', 'Explicit native request', undefined, { id: 'native-model' }],
      ['agent-host:cancel', target, 'turn-one'],
    ])
  })

  it('retains device/workspace permissions, Dev Tunnel controls and binding notification cleanup', async () => {
    const bridge = window.remoteVSCode
    if (!bridge?.devices?.workspace || !bridge.devTunnels || !bridge.gitSync) throw new Error('Remote device preload APIs missing.')
    await bridge.devices.workspace('recipient-device', 'read')
    await bridge.devTunnels.status(true)
    await bridge.exportIdentity(true)
    expect(ipc.invoke.mock.calls).toEqual([
      ['remote-vscode:device-workspace', 'recipient-device', 'read'],
      ['remote-vscode:tunnel-status', true],
      ['remote-vscode:export-identity', true],
    ])
    const stop = bridge.gitSync.onBindingsChanged(vi.fn())
    expect(ipc.on).toHaveBeenCalledWith('remote-vscode:git-bindings-changed', expect.any(Function))
    stop()
    expect(ipc.removeListener).toHaveBeenCalledWith('remote-vscode:git-bindings-changed', ipc.on.mock.calls[0][1])
  })
})
