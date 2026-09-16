import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { WorkspaceState } from '../src/shared/workspace'
import { registerWorkspaceBridge } from '../src/main/workspaceBridge'

const mocks = vi.hoisted(() => {
  const state: WorkspaceState = {
    current: { id: 'a'.repeat(64), name: 'tasks', title: 'Tasks', root: 'Q:\\parent\\tasks', tasks: [], warnings: [], loadedAt: '2026-09-16T00:00:00.000Z' },
    recent: [],
  }
  return {
    state,
    handlers: new Map<string, (event: unknown, value?: unknown) => Promise<unknown>>(),
    choose: vi.fn(async () => ({ canceled: false, filePaths: ['Q:\\chosen-parent'] })),
    constructor: vi.fn(),
    store: {
      getState: vi.fn(async () => state),
      openFolder: vi.fn(async () => state),
      openRecent: vi.fn(async () => state),
      refresh: vi.fn(async () => state),
      closeWorkspace: vi.fn(async () => ({ current: null, recent: state.recent })),
      createRepository: vi.fn(async () => state),
      getRepositoryStatus: vi.fn(async () => ({ workspaceId: state.current!.id })),
      publishRepository: vi.fn(async () => ({ url: 'https://github.com/owner/tasks' })),
      getSessionLinks: vi.fn(async () => ({ document: {}, revision: null })),
      updateSessionLink: vi.fn(async () => ({ document: {}, revision: null })),
    },
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => 'Q:\\profile' },
  ipcMain: { handle: (name: string, handler: (event: unknown, value?: unknown) => Promise<unknown>) => { mocks.handlers.set(name, handler) } },
  dialog: { showOpenDialog: mocks.choose },
}))
vi.mock('../src/main/workspaceStore', () => ({
  WorkspaceStore: class {
    constructor(...args: unknown[]) { mocks.constructor(...args); return mocks.store }
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.choose.mockResolvedValue({ canceled: false, filePaths: ['Q:\\chosen-parent'] })
})

function setup() {
  const window = {} as BrowserWindow
  const requireWindow = vi.fn(() => window)
  const authorize = vi.fn(async () => {})
  const verify = vi.fn(async () => { throw new Error('Not used by onboarding') })
  const bridge = registerWorkspaceBridge(requireWindow, verify, authorize)
  const invoke = async (name: string, value?: unknown) => {
    const action = mocks.handlers.get(`workspace:${name}`)
    if (!action) throw new Error(`Missing workspace handler: ${name}`)
    return action({}, value)
  }
  return { window, requireWindow, authorize, verify, bridge, invoke }
}

describe('workspace repository IPC boundary', () => {
  it('uses the trusted native parent picker without creating or selecting a directory', async () => {
    const { invoke, window, requireWindow, authorize } = setup()
    expect(await invoke('choose-parent-folder')).toBe('Q:\\chosen-parent')
    expect(mocks.choose).toHaveBeenCalledExactlyOnceWith(window, {
      title: 'Choose the parent folder for a new task repository', properties: ['openDirectory'], defaultPath: 'Q:\\parent',
    })
    expect(requireWindow).toHaveBeenCalledTimes(1)
    expect(mocks.store.createRepository).not.toHaveBeenCalled()
    expect(mocks.store.openFolder).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()
    mocks.choose.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await invoke('choose-parent-folder')).toBeNull()
  })

  it('passes exact creation/status/publish requests to the store and authorizes newly opened roots', async () => {
    const { invoke, authorize, verify } = setup()
    const create = { parentPath: 'Q:\\chosen-parent', name: 'tasks' }
    const publish = { workspaceId: mocks.state.current!.id, private: false }
    expect(await invoke('create-repository', create)).toBe(mocks.state)
    expect(mocks.store.createRepository).toHaveBeenCalledExactlyOnceWith(create)
    expect(authorize).toHaveBeenCalledExactlyOnceWith(mocks.state.current!.root)
    await invoke('repository-status', publish.workspaceId)
    await invoke('publish-repository', publish)
    expect(mocks.store.getRepositoryStatus).toHaveBeenCalledExactlyOnceWith(publish.workspaceId)
    expect(mocks.store.publishRepository).toHaveBeenCalledExactlyOnceWith(publish)
    expect(mocks.constructor.mock.calls[0]?.[2]).toBe(verify)
    expect(mocks.handlers.has('workspace:demo')).toBe(false)
    expect(await invoke('close')).toEqual({ current: null, recent: [] })
    expect(mocks.store.closeWorkspace).toHaveBeenCalledExactlyOnceWith()
  })

  it('rejects untrusted windows before any repository, chooser or authorization operation', async () => {
    const { invoke, requireWindow, authorize } = setup()
    requireWindow.mockImplementation(() => { throw new Error('Untrusted window') })
    for (const channel of ['choose-parent-folder', 'create-repository', 'repository-status', 'publish-repository', 'close', 'session-links', 'update-session-link']) await expect(invoke(channel, {})).rejects.toThrow('Untrusted window')
    expect(mocks.choose).not.toHaveBeenCalled()
    for (const method of Object.values(mocks.store)) expect(method).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()
  })

  it('preserves existing authorization before session-link access and surfaces native save failures', async () => {
    const { invoke, authorize, bridge } = setup()
    const id = mocks.state.current!.id
    const change = { workspaceId: id, taskId: 'T-0001', sessionId: null, expectedRevision: null }
    await invoke('session-links', id)
    await invoke('update-session-link', change)
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(mocks.store.getSessionLinks.mock.invocationCallOrder[0])
    expect(authorize.mock.invocationCallOrder[1]).toBeLessThan(mocks.store.updateSessionLink.mock.invocationCallOrder[0])
    expect(mocks.store.getSessionLinks).toHaveBeenCalledExactlyOnceWith(id)
    expect(mocks.store.updateSessionLink).toHaveBeenCalledExactlyOnceWith(change)
    expect(await bridge.currentRoot()).toBe(mocks.state.current!.root)
    mocks.store.createRepository.mockRejectedValueOnce(new Error('Workspace history could not be saved'))
    await expect(invoke('create-repository', { parentPath: 'Q:\\parent', name: 'new' })).rejects.toThrow('could not be saved')
    expect(authorize).toHaveBeenCalledTimes(2)
  })
})
