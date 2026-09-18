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
    isPackaged: false,
    appPath: 'Q:\\TaskContinuum',
    handlers: new Map<string, (event: unknown, value?: unknown) => Promise<unknown>>(),
    choose: vi.fn(async () => ({ canceled: false, filePaths: ['Q:\\chosen-parent'] })),
    openExternal: vi.fn<(url: string) => Promise<void>>(async () => {}),
    constructor: vi.fn(),
    store: {
      getState: vi.fn(async () => state),
      openFolder: vi.fn(async () => state),
      openRecent: vi.fn(async () => state),
      refresh: vi.fn(async () => state),
      closeWorkspace: vi.fn(async () => ({ current: null, recent: state.recent })),
      createRepository: vi.fn(async () => state),
      getTaskCreationContext: vi.fn(async () => ({ workspaceId: state.current!.id })),
      createTask: vi.fn(async () => ({ state, taskId: 'T-0001' })),
      getTaskAgentInstructions: vi.fn(async () => 'Task creation instructions'),
      getRepositoryStatus: vi.fn(async () => ({ workspaceId: state.current!.id })),
      getRepositoryCreationUrl: vi.fn(async () => 'https://github.com/new?name=tasks'),
      getRepositoryPushPlan: vi.fn(async () => ({ commands: 'git push' })),
      verifyRepositoryPublication: vi.fn(async () => ({ url: 'https://github.com/fixture_emu/tasks' })),
      getSessionLinks: vi.fn(async () => ({ document: {}, revision: null })),
      updateSessionLink: vi.fn(async () => ({ document: {}, revision: null })),
    },
  }
})

vi.mock('electron', () => ({
  app: { get isPackaged() { return mocks.isPackaged }, getPath: () => 'Q:\\profile', getAppPath: () => mocks.appPath },
  ipcMain: { handle: (name: string, handler: (event: unknown, value?: unknown) => Promise<unknown>) => { mocks.handlers.set(name, handler) } },
  dialog: { showOpenDialog: mocks.choose },
  shell: { openExternal: mocks.openExternal },
}))
vi.mock('../src/main/workspaceStore', () => ({
  WorkspaceStore: class {
    constructor(...args: unknown[]) { mocks.constructor(...args); return mocks.store }
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.isPackaged = false
  mocks.appPath = 'Q:\\TaskContinuum'
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

  it('uses only the server-generated browser URL and forwards exact terminal planning and verification requests', async () => {
    const { invoke, authorize, verify } = setup()
    const create = { parentPath: 'Q:\\chosen-parent', name: 'tasks' }
    const push = { workspaceId: mocks.state.current!.id, remoteUrl: 'https://github.com/fixture_emu/tasks.git' }
    expect(await invoke('create-repository', create)).toBe(mocks.state)
    expect(mocks.store.createRepository).toHaveBeenCalledExactlyOnceWith(create)
    expect(authorize).toHaveBeenCalledExactlyOnceWith(mocks.state.current!.root)
    await invoke('repository-status', push.workspaceId)
    await invoke('open-repository-creation', push.workspaceId)
    await invoke('repository-push-plan', push)
    await invoke('verify-repository-publication', push)
    expect(mocks.store.getRepositoryStatus).toHaveBeenCalledExactlyOnceWith(push.workspaceId)
    expect(mocks.store.getRepositoryCreationUrl).toHaveBeenCalledExactlyOnceWith(push.workspaceId)
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith('https://github.com/new?name=tasks')
    expect(mocks.store.getRepositoryPushPlan).toHaveBeenCalledExactlyOnceWith(push)
    expect(mocks.store.verifyRepositoryPublication).toHaveBeenCalledExactlyOnceWith(push)
    expect(mocks.handlers.has('workspace:publish-repository')).toBe(false)
    expect(mocks.constructor.mock.calls[0]?.[2]).toBe(verify)
    expect(mocks.handlers.has('workspace:demo')).toBe(false)
    expect(await invoke('close')).toEqual({ current: null, recent: [] })
    expect(mocks.store.closeWorkspace).toHaveBeenCalledExactlyOnceWith()
  })

  it('rejects untrusted windows before any repository, chooser or authorization operation', async () => {
    const { invoke, requireWindow, authorize } = setup()
    requireWindow.mockImplementation(() => { throw new Error('Untrusted window') })
    for (const channel of ['choose-parent-folder', 'create-repository', 'task-creation-context', 'create-task', 'task-agent-instructions', 'repository-status', 'open-repository-creation', 'repository-push-plan', 'verify-repository-publication', 'close', 'session-links', 'update-session-link']) await expect(invoke(channel, {})).rejects.toThrow('Untrusted window')
    expect(mocks.choose).not.toHaveBeenCalled()
    expect(mocks.openExternal).not.toHaveBeenCalled()
    for (const method of Object.values(mocks.store)) expect(method).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()
  })

  it('forwards task creation and agent handoff without opening a browser or authorizing a session', async () => {
    const { invoke, authorize } = setup()
    const workspaceId = mocks.state.current!.id
    const create = { workspaceId, draft: { title: 'First task' } }
    const agent = { workspaceId, goal: 'Plan sign-in', parentId: null }
    await invoke('task-creation-context', workspaceId)
    await invoke('create-task', create)
    await invoke('task-agent-instructions', agent)
    expect(mocks.store.getTaskCreationContext).toHaveBeenCalledExactlyOnceWith(workspaceId)
    expect(mocks.store.createTask).toHaveBeenCalledExactlyOnceWith(create)
    expect(mocks.store.getTaskAgentInstructions).toHaveBeenCalledExactlyOnceWith(agent, 'Q:\\TaskContinuum\\scripts\\task-documents.mjs')
    expect(mocks.openExternal).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()
  })

  it('exposes the standalone CLI outside the application archive in packaged builds', async () => {
    mocks.isPackaged = true
    mocks.appPath = 'Q:\\TaskContinuum\\resources\\app.asar'
    const { invoke } = setup()
    const request = { workspaceId: mocks.state.current!.id, goal: 'Create a packaged task' }
    await invoke('task-agent-instructions', request)
    expect(mocks.store.getTaskAgentInstructions).toHaveBeenCalledExactlyOnceWith(request, 'Q:\\TaskContinuum\\resources\\cli\\task-documents.cjs')
  })

  it('does not open a browser for rejected workspace IDs and surfaces native browser errors', async () => {
    const { invoke } = setup()
    mocks.store.getRepositoryCreationUrl.mockRejectedValueOnce(new Error('The active workspace changed.'))
    await expect(invoke('open-repository-creation', 'https://untrusted.invalid')).rejects.toThrow('active workspace changed')
    expect(mocks.openExternal).not.toHaveBeenCalled()
    mocks.openExternal.mockRejectedValueOnce(new Error('No browser is available.'))
    await expect(invoke('open-repository-creation', mocks.state.current!.id)).rejects.toThrow('No browser')
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
