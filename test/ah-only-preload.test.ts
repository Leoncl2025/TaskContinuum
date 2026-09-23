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
    expect(window.workspace).not.toHaveProperty('useDemo')
    expect(window.remoteVSCode).toBeDefined()
    expect(Object.keys(window.remoteVSCode ?? {}).sort()).toEqual(['devTunnels', 'devices', 'gitSync'])
    for (const name of ['list', 'connect', 'disconnect', 'forget', 'share', 'grants', 'revoke', 'importInvitation', 'exportIdentity']) expect(window.remoteVSCode).not.toHaveProperty(name)
    expect(Object.keys(window.remoteVSCode?.devices ?? {}).sort()).toEqual(['connect', 'disconnect', 'forget', 'list'])
    for (const name of ['share', 'unshare', 'recipients', 'pair', 'workspace', 'adoptLinks', 'import', 'revoke']) expect(window.remoteVSCode?.devices).not.toHaveProperty(name)
    expect(ipc.invoke).not.toHaveBeenCalled()
  })

  it('forwards only explicit creation, browser, terminal planning and read-only verification operations', async () => {
    const bridge = window.workspace
    if (!bridge) throw new Error('Workspace preload API missing.')
    const create = { parentPath: 'Q:\\parent', name: 'real-tasks' }
    const push = { workspaceId: 'a'.repeat(64), remoteUrl: 'https://github.com/fixture_emu/real-tasks.git' }
    await bridge.chooseParentFolder()
    await bridge.createRepository(create)
    await bridge.getRepositoryStatus(push.workspaceId)
    await bridge.openRepositoryCreation(push.workspaceId)
    await bridge.getRepositoryPushPlan(push)
    await bridge.verifyRepositoryPublication(push)
    await bridge.closeWorkspace()
    expect(ipc.invoke.mock.calls).toEqual([
      ['workspace:choose-parent-folder'],
      ['workspace:create-repository', create],
      ['workspace:repository-status', push.workspaceId],
      ['workspace:open-repository-creation', push.workspaceId],
      ['workspace:repository-push-plan', push],
      ['workspace:verify-repository-publication', push],
      ['workspace:close'],
    ])
    expect(bridge).not.toHaveProperty('publishRepository')
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

  it('scopes terminal requests to a view and a single lease', async () => {
    const bridge = window.agentHost
    if (!bridge) throw new Error('Agent Host preload API missing.')
    const view = crypto.randomUUID()
    const lease = crypto.randomUUID()
    const resource = 'ahp-terminal:/existing'
    await bridge.terminal(view, resource, lease)
    await bridge.terminal(view, resource, lease, true)
    await bridge.releaseTerminal(view, resource, lease)
    expect(ipc.invoke.mock.calls).toEqual([
      ['agent-host:terminal', view, resource, lease, undefined],
      ['agent-host:terminal', view, resource, lease, true],
      ['agent-host:release-terminal', view, resource, lease],
    ])
  })

  it('exposes root-scoped local creation without caller-selected paths, tasks, or remote workers', async () => {
    const bridge = window.agentHost
    if (!bridge) throw new Error('Agent Host preload API missing.')
    const request = { operationId: crypto.randomUUID(), hostId: 'local-host-123' }
    await bridge.localCreationHosts()
    await bridge.localCreations()
    await bridge.createLocal(request)
    await bridge.localCreationStatus(request.operationId)
    expect(ipc.invoke.mock.calls).toEqual([
      ['agent-host:local-creation-hosts'],
      ['agent-host:local-creations'],
      ['agent-host:create-local', request],
      ['agent-host:local-creation-status', request.operationId],
    ])
  })

  it('exposes explicit task creation and agent instructions without opening or sending to Agent Host', async () => {
    const bridge = window.workspace
    if (!bridge) throw new Error('Workspace preload API missing.')
    const workspaceId = 'a'.repeat(64)
    const create = { workspaceId, draft: { title: 'First task' } }
    const agent = { workspaceId, goal: 'Create a sign-in task', parentId: null }
    await bridge.getTaskCreationContext(workspaceId)
    await bridge.createTask(create)
    await bridge.getTaskAgentInstructions(agent)
    expect(ipc.invoke.mock.calls).toEqual([
      ['workspace:task-creation-context', workspaceId],
      ['workspace:create-task', create],
      ['workspace:task-agent-instructions', agent],
    ])
  })

  it('retains device connections, automatic revocation, Dev Tunnel controls and binding notification cleanup', async () => {
    const bridge = window.remoteVSCode
    if (!bridge?.devices || !bridge.devTunnels || !bridge.gitSync) throw new Error('Remote device preload APIs missing.')
    await bridge.devices.list()
    await bridge.devices.connect('automatic-device')
    await bridge.devices.disconnect('automatic-device')
    await bridge.devices.forget('automatic-device')
    await bridge.gitSync.revokeDevice('automatic-device')
    await bridge.gitSync.disable()
    await bridge.devTunnels.status(true)
    expect(ipc.invoke.mock.calls).toEqual([
      ['remote-vscode:devices'],
      ['remote-vscode:device-connect', 'automatic-device'],
      ['remote-vscode:device-disconnect', 'automatic-device'],
      ['remote-vscode:device-forget', 'automatic-device'],
      ['remote-vscode:git-revoke', 'automatic-device'],
      ['remote-vscode:git-disable'],
      ['remote-vscode:tunnel-status', true],
    ])
    const stop = bridge.gitSync.onBindingsChanged(vi.fn())
    expect(ipc.on).toHaveBeenCalledWith('remote-vscode:git-bindings-changed', expect.any(Function))
    stop()
    expect(ipc.removeListener).toHaveBeenCalledWith('remote-vscode:git-bindings-changed', ipc.on.mock.calls[0][1])
  })
})
