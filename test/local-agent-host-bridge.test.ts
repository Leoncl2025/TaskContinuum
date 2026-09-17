// @vitest-environment node
import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAgentHostBridge } from '../src/main/agentHostBridge'
import type { AgentHostManager } from '../src/main/agentHostManager'
import type { LocalAgentHostCreateRequest, LocalAgentHostCreation } from '../src/shared/localAgentHostCreation'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, value?: unknown) => Promise<unknown>>(),
  dialog: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => 'Q:\\profile' },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, value?: unknown) => Promise<unknown>) => { ipc.handlers.set(channel, handler) } },
  dialog: { showMessageBox: ipc.dialog },
}))
beforeEach(() => { vi.clearAllMocks(); ipc.handlers.clear() })

function fixture() {
  let root = 'Q:\\workspace'
  let destroyed = false, webDestroyed = false, wrongWindow = false
  const window = { isDestroyed: () => destroyed, webContents: { isDestroyed: () => webDestroyed } } as BrowserWindow
  const requireWindow = vi.fn(() => wrongWindow ? {} as BrowserWindow : window)
  const currentRoot = vi.fn(async () => root)
  const request = { operationId: randomUUID(), hostId: 'local-host-123' }
  const result: LocalAgentHostCreation = { ...request, state: 'creating' }
  const localCreations = {
    hosts: vi.fn(async (_root: string, authorize: () => Promise<void>) => { await authorize(); return [{ hostId: request.hostId, name: 'Local Host', available: true }] }),
    list: vi.fn(async (_root: string, authorize: () => Promise<void>) => { await authorize(); return [] as LocalAgentHostCreation[] }),
    create: vi.fn(async (_root: string, _request: LocalAgentHostCreateRequest, authorize: () => Promise<void>) => { await authorize(); return result }),
    status: vi.fn(async (_root: string, _id: string, authorize: () => Promise<void>) => { await authorize(); return result }),
  }
  const manager = { localCreations, allow: vi.fn(), creations: { create: vi.fn() } }
  registerAgentHostBridge(requireWindow, currentRoot, manager as unknown as AgentHostManager)
  const invoke = (channel: string, value?: unknown) => ipc.handlers.get(`agent-host:${channel}`)!({} as IpcMainInvokeEvent, value)
  return { request, result, localCreations, manager, currentRoot, invoke,
    change: (what: 'root' | 'window' | 'webContents' | 'identity') => {
      if (what === 'root') root = 'Q:\\different-workspace'
      if (what === 'window') destroyed = true
      if (what === 'webContents') webDestroyed = true
      if (what === 'identity') wrongWindow = true
    } }
}

describe('local planning creation IPC', () => {
  it('derives the current root in main and forwards only the exact local creation contract', async () => {
    const setup = fixture()
    expect(await setup.invoke('local-creation-hosts')).toMatchObject([{ hostId: setup.request.hostId }])
    expect(await setup.invoke('local-creations')).toEqual([])
    expect(await setup.invoke('create-local', setup.request)).toEqual(setup.result)
    expect(await setup.invoke('local-creation-status', setup.request.operationId)).toEqual(setup.result)
    expect(setup.localCreations.create).toHaveBeenCalledExactlyOnceWith('Q:\\workspace', setup.request, expect.any(Function))
    expect(setup.localCreations.status).toHaveBeenCalledExactlyOnceWith('Q:\\workspace', setup.request.operationId, expect.any(Function))
    expect(setup.manager.creations.create).not.toHaveBeenCalled()
    expect(setup.manager.allow).not.toHaveBeenCalled()
    expect(ipc.dialog).not.toHaveBeenCalled()
  })

  it('rejects task, worker, workspace and arbitrary target injection before reservation', async () => {
    const setup = fixture()
    for (const extra of [{ workspaceId: 'a'.repeat(64) }, { root: 'Q:\\arbitrary' }, { taskId: 'T-0001' }, { workerId: randomUUID() }, { sessionId: 'copilotcli:/arbitrary' }]) {
      await expect(setup.invoke('create-local', { ...setup.request, ...extra })).rejects.toThrow()
    }
    await expect(setup.invoke('create-local', { ...setup.request, operationId: 'not-an-id' })).rejects.toThrow()
    await expect(setup.invoke('local-creation-status', { operationId: setup.request.operationId })).rejects.toThrow()
    expect(setup.localCreations.create).not.toHaveBeenCalled()
    expect(setup.localCreations.status).not.toHaveBeenCalled()
  })

  it.each(['root', 'window', 'webContents', 'identity'] as const)('checks %s before service side effects', async (what) => {
    const setup = fixture()
    setup.currentRoot.mockImplementationOnce(async () => { setup.change(what); return 'Q:\\workspace' })
    await expect(setup.invoke('create-local', setup.request)).rejects.toThrow('changed')
    expect(setup.localCreations.create).not.toHaveBeenCalled()
  })

  it.each(['root', 'window', 'webContents', 'identity'] as const)('checks %s before returning a result and provides a live pre-dispatch guard', async (what) => {
    const setup = fixture()
    setup.localCreations.create.mockImplementationOnce(async (_root, _request, authorize) => {
      setup.change(what)
      await expect(authorize()).rejects.toThrow('changed')
      return setup.result
    })
    await expect(setup.invoke('create-local', setup.request)).rejects.toThrow('changed')
  })

  it.each(['local-creation-hosts', 'local-creations', 'local-creation-status'] as const)('does not return stale %s results after changing roots', async (channel) => {
    const setup = fixture()
    if (channel === 'local-creation-hosts') setup.localCreations.hosts.mockImplementationOnce(async () => { setup.change('root'); return [] })
    if (channel === 'local-creations') setup.localCreations.list.mockImplementationOnce(async () => { setup.change('root'); return [] })
    if (channel === 'local-creation-status') setup.localCreations.status.mockImplementationOnce(async () => { setup.change('root'); return setup.result })
    await expect(setup.invoke(channel, setup.request.operationId)).rejects.toThrow('changed')
  })
})
