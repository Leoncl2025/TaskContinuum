// @vitest-environment node
import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAgentHostBridge } from '../src/main/agentHostBridge'
import type { AgentHostManager } from '../src/main/agentHostManager'
import type { AgentHostEvent } from '../src/main/agentHostConnection'
import type { ActionEnvelope } from '@microsoft/agent-host-protocol'
import type { LocalAgentHostCreateRequest, LocalAgentHostCreation } from '../src/shared/localAgentHostCreation'
import type { AgentHostCreateRequest, AgentHostCreationLocation, AgentHostWorker } from '../src/shared/agentHostCreation'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => Promise<unknown>>(),
  dialog: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => 'Q:\\profile' },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => Promise<unknown>) => { ipc.handlers.set(channel, handler) } },
  dialog: { showMessageBox: ipc.dialog },
}))
beforeEach(() => { vi.clearAllMocks(); ipc.handlers.clear() })

function fixture() {
  let root = 'Q:\\workspace'
  let destroyed = false, webDestroyed = false, wrongWindow = false
  const window = { isDestroyed: () => destroyed, webContents: { isDestroyed: () => webDestroyed, send: vi.fn() } } as unknown as BrowserWindow
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
  const manager = { localCreations, allow: vi.fn(), creations: {
    workers: vi.fn<(root: string, taskId: string, location: AgentHostCreationLocation) => Promise<AgentHostWorker[]>>(async () => []),
    create: vi.fn(async (_root: string, request: AgentHostCreateRequest, authorize: () => Promise<void>) => { await authorize(); return { ...request, state: 'creating' as const } }),
  } }
  registerAgentHostBridge(requireWindow, currentRoot, manager as unknown as AgentHostManager)
  const invoke = (channel: string, ...values: unknown[]) => ipc.handlers.get(`agent-host:${channel}`)!({} as IpcMainInvokeEvent, ...values)
  return { request, result, localCreations, manager, currentRoot, invoke, window,
    change: (what: 'root' | 'window' | 'webContents' | 'identity') => {
      if (what === 'root') root = 'Q:\\different-workspace'
      if (what === 'window') destroyed = true
      if (what === 'webContents') webDestroyed = true
      if (what === 'identity') wrongWindow = true
    } }
}

function terminalFixture() {
  const setup = fixture()
  const target = { sessionId: 'copilotcli:/original', chatId: 'ahp-chat:/original', owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
  const connection = {
    view: { target, state: 'connected' },
    open: vi.fn(async () => {}),
    listen: vi.fn<(listener: (event: AgentHostEvent) => void) => () => void>(() => () => {}),
    retainTerminal: vi.fn(),
    terminal: vi.fn(async () => {}),
    releaseTerminal: vi.fn(),
    resolveDelivery: vi.fn(async (_id: string, _action: 'check' | 'abandon', authorize: () => Promise<void>) => { await authorize(); return 'not-found' as const }),
  }
  const manager = Object.assign(setup.manager, {
    authorize: vi.fn(async () => {}),
    connection: vi.fn(async () => connection),
  })
  return { ...setup, target, connection, manager }
}

describe('timely Agent Host view publication', () => {
  it('publishes turn boundaries without the text debounce and preserves updates during a publication', async () => {
    vi.useFakeTimers()
    const setup = terminalFixture()
    let id: unknown
    try {
      id = await setup.invoke('watch', setup.target)
      await vi.advanceTimersByTimeAsync(25)
      const publish = vi.mocked(setup.window.webContents.send)
      publish.mockClear()
      const notify = setup.connection.listen.mock.calls[0][0]
      publish.mockImplementationOnce(() => {
        setup.connection.view = { ...setup.connection.view, state: 'offline' }
        notify({ type: 'state' })
      })
      notify({ type: 'action', envelope: { channel: setup.target.chatId, serverSeq: 1, action: { type: 'chat/turnStarted' } } as ActionEnvelope })
      await vi.advanceTimersByTimeAsync(0)
      expect(publish).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(25)
      expect(publish).toHaveBeenCalledTimes(2)
      expect(publish.mock.calls[1][1]).toMatchObject({ id, view: { state: 'offline' } })
      publish.mockClear()
      setup.manager.authorize.mockRejectedValueOnce(new Error('Revoked.'))
      notify({ type: 'action', envelope: { channel: setup.target.chatId, serverSeq: 2, action: { type: 'chat/turnComplete' } } as ActionEnvelope })
      await vi.advanceTimersByTimeAsync(0)
      expect(publish).not.toHaveBeenCalled()
    } finally {
      if (id) await setup.invoke('unwatch', id)
      vi.useRealTimers()
    }
  })
})

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

  describe('on-demand terminal IPC', () => {
    it('checks the linked watch, validates resources and balances leases across collapse and unwatch', async () => {
      const setup = terminalFixture()
      const id = await setup.invoke('watch', setup.target) as string
      const resource = 'ahp-terminal:/original'
      const first = randomUUID(), second = randomUUID()
      await expect(setup.invoke('terminal', id, 'ahp-chat:/private-other', first)).rejects.toThrow()
      expect(setup.connection.retainTerminal).not.toHaveBeenCalled()
      await setup.invoke('terminal', id, resource, first)
      await setup.invoke('terminal', id, resource, first)
      await setup.invoke('terminal', id, resource, second)
      expect(setup.connection.retainTerminal).toHaveBeenCalledTimes(2)
      await setup.invoke('release-terminal', id, resource, first)
      await setup.invoke('release-terminal', id, resource, first)
      expect(setup.connection.releaseTerminal).toHaveBeenCalledOnce()
      await setup.invoke('unwatch', id)
      expect(setup.connection.releaseTerminal).toHaveBeenCalledTimes(2)
      await expect(setup.invoke('terminal', id, resource, first)).rejects.toThrow('no longer active')
      expect(setup.connection.terminal).toHaveBeenCalledTimes(3)
    })

    describe('manual delivery review IPC', () => {
      it('accepts only the exact target, UUID and explicit abandonment acknowledgement', async () => {
        const setup = terminalFixture()
        const id = randomUUID()
        const review = (turnId: unknown, action: unknown, confirmed?: unknown) => setup.invoke('resolve-delivery', setup.target, turnId, action, confirmed)
        await expect(review('not-a-uuid', 'check')).rejects.toThrow()
        await expect(review(id, 'abandon')).rejects.toThrow()
        await expect(review(id, 'abandon', false)).rejects.toThrow()
        await expect(review(id, 'check', true)).rejects.toThrow()
        expect(setup.connection.resolveDelivery).not.toHaveBeenCalled()
        expect(await review(id, 'check')).toBe('not-found')
        expect(setup.connection.resolveDelivery).toHaveBeenCalledWith(id, 'check', expect.any(Function))
        expect(await review(id, 'abandon', true)).toBe('not-found')
        expect(setup.connection.resolveDelivery).toHaveBeenCalledTimes(2)
        expect(setup.manager.connection).toHaveBeenCalledWith('Q:\\workspace', setup.target)
      })

      it('refuses to report a delivery review result after the workspace changes', async () => {
        const setup = terminalFixture()
        const id = randomUUID()
        setup.connection.resolveDelivery.mockImplementationOnce(async (_turn, _action, authorize) => {
          setup.change('root')
          await expect(authorize()).rejects.toThrow('changed')
          return 'not-found'
        })
        await expect(setup.invoke('resolve-delivery', setup.target, id, 'check')).rejects.toThrow('changed')
      })
    })

    it('revokes a pending terminal result and releases its lease when authorization changes', async () => {
      const setup = terminalFixture()
      const id = await setup.invoke('watch', setup.target) as string
      const resource = 'ahp-terminal:/original'
      let finish!: () => void
      let entered!: () => void
      const started = new Promise<void>((resolve) => { entered = resolve })
      setup.connection.terminal.mockImplementationOnce(async () => {
        entered()
        await new Promise<void>((resolve) => { finish = resolve })
      })
      const pending = setup.invoke('terminal', id, resource, randomUUID())
      await started
      setup.manager.authorize.mockRejectedValue(new Error('Access revoked.'))
      finish()
      await expect(pending).rejects.toThrow('Access revoked.')
      expect(setup.connection.releaseTerminal).toHaveBeenCalledOnce()
      expect(setup.connection.terminal).toHaveBeenCalledOnce()
    })
  })

  describe('task-local creation IPC', () => {
    it('selects only the requested location while resolving the workspace in main', async () => {
      const setup = fixture()
      await setup.invoke('creation-workers', 'T-0007', 'local')
      expect(setup.manager.creations.workers).toHaveBeenLastCalledWith('Q:\\workspace', 'T-0007', 'local')
      await setup.invoke('creation-workers', 'T-0007')
      expect(setup.manager.creations.workers).toHaveBeenLastCalledWith('Q:\\workspace', 'T-0007', 'remote')
      for (const location of ['other', { location: 'local', root: 'Q:\\other' }]) {
        await expect(setup.invoke('creation-workers', 'T-0007', location)).rejects.toThrow()
      }
      expect(setup.manager.creations.workers).toHaveBeenCalledTimes(2)
      expect(setup.localCreations.hosts).not.toHaveBeenCalled()
    })

    it('uses the durable task creation route, not the workspace assistant, and rejects injected fields', async () => {
      const setup = fixture()
      const request: AgentHostCreateRequest = { ...setup.request, taskId: 'T-0007', workerId: randomUUID(), workspaceId: 'a'.repeat(64), expectedRevision: null }
      expect(await setup.invoke('create', request)).toMatchObject({ ...request, state: 'creating' })
      expect(setup.manager.creations.create).toHaveBeenCalledExactlyOnceWith('Q:\\workspace', request, expect.any(Function))
      for (const extra of [{ local: true }, { root: 'Q:\\other' }, { location: 'local' }]) {
        await expect(setup.invoke('create', { ...request, ...extra })).rejects.toThrow()
      }
      expect(setup.manager.creations.create).toHaveBeenCalledOnce()
      expect(setup.localCreations.create).not.toHaveBeenCalled()
      expect(setup.manager.allow).not.toHaveBeenCalled()
    })

    it('does not return a local catalog after switching the task workspace', async () => {
      const setup = fixture()
      setup.manager.creations.workers.mockImplementationOnce(async () => { setup.change('root'); return [] })
      await expect(setup.invoke('creation-workers', 'T-0007', 'local')).rejects.toThrow('changed')
    })
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
