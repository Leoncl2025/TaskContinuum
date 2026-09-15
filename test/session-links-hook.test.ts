import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSessionLinks } from '../src/renderer/chat/useSessionLinks'
import type { SessionBinding } from '../src/renderer/chat/sessionBindings'
import type { WorkspaceBridge, WorkspaceSnapshot } from '../src/shared/workspace'
import type { SessionLink, SessionLinksSnapshot, SessionOwner } from '../src/shared/sessionBindings'
import { demoTasks } from '../src/renderer/data/tasks'
import { gitSyncUiFixture } from './remote-config-ui-fixture'
import { agentHostTargetFixture } from './immutable-bindings-fixture'

const localOwner: SessionOwner = { clientId: '00000000-0000-4000-8000-000000000002', machineName: 'Machine-A' }
const remoteOwner: SessionOwner = { clientId: '00000000-0000-4000-8000-000000000003', machineName: 'Machine-B' }
const demoKey = 'taskcontinuum:session-bindings:v1'
afterEach(() => { delete window.workspace; delete window.remoteVSCode })

function link(session: string, owner = localOwner): SessionLink {
  return { provider: 'agent-host', ...agentHostTargetFixture(session, owner) }
}
function attachment(session: string, owner = localOwner): SessionBinding {
  const target = agentHostTargetFixture(session, owner)
  return { id: target.sessionId, title: 'Private title', owner, agentHost: target }
}
function linksSnapshot(bindings: Record<string, SessionLink> = {}, revision: string | null = null): SessionLinksSnapshot {
  return { document: { schemaVersion: 1, bindings }, revision, localOwner }
}
function fixture() {
  const workspace: WorkspaceSnapshot = { id: 'workspace-one', name: 'TaskContinuum-ad', title: 'Task Continuum', root: 'Q:\\src\\Projects\\TaskContinuum-ad', tasks: [demoTasks[1]], warnings: [], loadedAt: '2026-09-06T00:00:00Z' }
  let snapshot = linksSnapshot()
  let version = 0
  const bridge: WorkspaceBridge = {
    getState: vi.fn(async () => ({ current: workspace, recent: [workspace] })),
    openFolder: vi.fn(async () => null), openRecent: vi.fn(async () => ({ current: workspace, recent: [workspace] })),
    refresh: vi.fn(async () => ({ current: workspace, recent: [workspace] })), useDemo: vi.fn(async () => ({ current: null, recent: [workspace] })),
    getSessionLinks: vi.fn(async () => snapshot),
    updateSessionLink: vi.fn(async (request) => {
      if (request.expectedRevision !== snapshot.revision) throw new Error('Session links changed on disk.')
      const bindings = { ...snapshot.document.bindings }
      if (request.sessionId === null) delete bindings[request.taskId]
      else {
        if (!request.agentHost || !request.owner) throw new Error('An owned Agent Host target is required.')
        bindings[request.taskId] = { provider: 'agent-host', ...request.agentHost, sessionId: request.sessionId, owner: request.owner }
      }
      snapshot = linksSnapshot(bindings, (++version).toString(16).padStart(64, '0'))
      return snapshot
    }),
  }
  window.workspace = bridge
  return { workspace, bridge }
}

describe('repository-backed Agent Host binding state', () => {
  it('loads SSH changes immediately and drains notifications received during a save', async () => {
    const { workspace, bridge } = fixture()
    const remote = gitSyncUiFixture()
    window.remoteVSCode = remote.remote
    const view = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    const synced = linksSnapshot({ 'T-0002': link('ssh-change') }, 'c'.repeat(64))
    vi.mocked(bridge.getSessionLinks).mockResolvedValue(synced)
    await act(async () => remote.notify())
    expect(view.result.current.bindings['T-0002'].agentHost).toEqual(agentHostTargetFixture('ssh-change', localOwner))
    let finish!: (value: SessionLinksSnapshot) => void
    vi.mocked(bridge.updateSessionLink).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    let saving!: Promise<void>
    act(() => { saving = view.result.current.attach('T-0003', attachment('saving')) })
    const final = linksSnapshot({ ...synced.document.bindings, 'T-0004': link('newer-ssh-change') }, 'd'.repeat(64))
    vi.mocked(bridge.getSessionLinks).mockResolvedValue(final)
    act(() => remote.notify())
    await act(async () => { finish(synced); await saving })
    expect(view.result.current.bindings['T-0004'].id).toBe('copilotcli:/newer-ssh-change')
    expect(bridge.updateSessionLink).toHaveBeenCalledOnce()
    view.unmount()
  })

  it('refreshes Git-pulled Agent Host links without a second attach operation', async () => {
    const { workspace, bridge } = fixture()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const view = renderHook(() => useSessionLinks(workspace))
    try {
      await act(async () => { await Promise.resolve() })
      expect(view.result.current.ready).toBe(true)
      vi.mocked(bridge.getSessionLinks).mockResolvedValue(linksSnapshot({ 'T-0002': link('pulled', remoteOwner) }, 'e'.repeat(64)))
      await act(() => vi.advanceTimersByTimeAsync(5000))
      expect(view.result.current.bindings['T-0002']).toMatchObject({ id: 'copilotcli:/pulled', title: 'Agent Host', owner: remoteOwner, ownerIsRemote: true })
      expect(view.result.current.bindings['T-0002']).not.toHaveProperty('vscodeWorkspaceStorageId')
      expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    } finally { view.unmount(); vi.useRealTimers() }
  })

  it('interprets the same owned target locally on B and remotely on A without rewriting it', async () => {
    const { workspace, bridge } = fixture()
    const snapshot = { ...linksSnapshot({ 'T-0002': link('original', remoteOwner) }, 'd'.repeat(64)), localOwner: remoteOwner }
    vi.mocked(bridge.getSessionLinks).mockResolvedValue(snapshot)
    const view = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    expect(view.result.current.bindings['T-0002'].ownerIsRemote).toBe(false)
    vi.mocked(bridge.getSessionLinks).mockResolvedValue({ ...snapshot, localOwner })
    await act(() => view.result.current.reload())
    expect(view.result.current.bindings['T-0002']).toMatchObject({ owner: remoteOwner, ownerIsRemote: true, agentHost: agentHostTargetFixture('original', remoteOwner) })
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
  })

  it('waits for a successful immutable write without reading or writing browser bindings', async () => {
    const { workspace, bridge } = fixture()
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem')
    const { result } = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(result.current.ready).toBe(true))
    let finish!: (snapshot: SessionLinksSnapshot) => void
    vi.mocked(bridge.updateSessionLink).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    let writing!: Promise<void>
    act(() => { writing = result.current.attach('T-0002', attachment('session-one')) })
    expect(result.current.bindings).toEqual({})
    expect(result.current.busy).toBe(true)
    await act(async () => { finish(linksSnapshot({ 'T-0002': link('session-one') }, 'a'.repeat(64))); await writing })
    expect(result.current.bindings['T-0002'].id).toBe('copilotcli:/session-one')
    expect(bridge.updateSessionLink).toHaveBeenCalledWith({ workspaceId: workspace.id, taskId: 'T-0002', sessionId: 'copilotcli:/session-one', agentHost: { hostId: 'host-main', chatId: 'ahp-chat:/session-one' }, owner: localOwner, expectedRevision: null })
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
  })

  it.each([
    JSON.stringify({ 'T-0002': { id: 'legacy-session', title: 'Private local title' } }),
    JSON.stringify({ 'T-0002': { id: 'original-chat', title: 'Private local title', vscodeWorkspaceStorageId: 'a'.repeat(32) } }),
    JSON.stringify({ 'T-0002': attachment('old-cached-host') }),
    '{malformed old cache',
  ])('never discovers or migrates workspace-keyed browser data: %s', async (content) => {
    const { workspace, bridge } = fixture()
    const key = `${demoKey}:${encodeURIComponent(workspace.id)}`
    localStorage.setItem(key, content)
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem')
    const { result } = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(() => result.current.reload())
    expect(result.current.bindings).toEqual({})
    for (const property of ['legacy', 'migrate', 'needsMigration']) expect(result.current).not.toHaveProperty(property)
    expect(bridge).not.toHaveProperty('migrateSessionLinks')
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
    expect(localStorage.getItem(key)).toBe(content)
  })

  const unsupportedAttachments: Array<[string, unknown]> = [
    ['SDK session', { id: 'native-session', title: 'Old SDK session' }],
    ['VS Code journal', { id: 'original-chat', title: 'Old VS Code journal', vscodeWorkspaceStorageId: 'a'.repeat(32) }],
    ['remote VS Code journal', { id: 'original-chat', title: 'Old remote journal', vscodeWorkspaceStorageId: 'a'.repeat(32), remoteMachineName: 'Machine-B' }],
    ['mixed target', { ...attachment('mixed'), vscodeWorkspaceStorageId: 'a'.repeat(32) }],
    ['ownerless target', { ...attachment('ownerless'), agentHost: { ...agentHostTargetFixture('ownerless'), owner: undefined } }],
    ['mismatched session', { ...attachment('original'), id: 'copilotcli:/different' }],
    ['mismatched owner', { ...attachment('original'), owner: remoteOwner }],
  ]
  it.each(unsupportedAttachments)('rejects a %s before calling the workspace bridge', async (_label, binding) => {
    const { workspace, bridge } = fixture()
    const { result } = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => { await expect(result.current.attach('T-0002', binding as SessionBinding)).rejects.toThrow(/Agent Host/) })
    expect(result.current.error).toMatch(/Agent Host/)
    expect(result.current.ready).toBe(false)
    expect(result.current.bindings).toEqual({})
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
  })

  it('uses only the immutable backend even when a workspace browser cache disagrees', async () => {
    const { workspace, bridge } = fixture()
    const key = `${demoKey}:${encodeURIComponent(workspace.id)}`
    const content = JSON.stringify({ 'T-0002': { id: 'stale-local-session', title: 'Old cache' } })
    localStorage.setItem(key, content)
    vi.mocked(bridge.getSessionLinks).mockResolvedValue(linksSnapshot({ 'T-0002': link('from-repository') }, 'b'.repeat(64)))
    const { result } = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.bindings['T-0002'].id).toBe('copilotcli:/from-repository')
    expect(localStorage.getItem(key)).toBe(content)
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
  })

  it('surfaces an unavailable backend instead of a successful empty read and recovers on notification', async () => {
    const { workspace, bridge } = fixture()
    const remote = gitSyncUiFixture()
    window.remoteVSCode = remote.remote
    vi.mocked(bridge.getSessionLinks).mockRejectedValue(new Error('Enable Automatic workspace links before accessing session bindings.'))
    const { result } = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(result.current.busy).toBe(false))
    expect(result.current.ready).toBe(false)
    expect(result.current.error).toContain('Enable Automatic workspace links')
    await expect(result.current.attach('T-0002', attachment('blocked'))).rejects.toThrow('Reload repository session links')
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    vi.mocked(bridge.getSessionLinks).mockResolvedValue(linksSnapshot({ 'T-0002': link('restored') }, 'c'.repeat(64)))
    await act(async () => remote.notify())
    expect(result.current.ready).toBe(true)
    expect(result.current.error).toBeNull()
    expect(result.current.bindings['T-0002'].id).toBe('copilotcli:/restored')
  })

  it('applies a previously empty revision when it becomes authoritative again after a save', async () => {
    const { workspace, bridge } = fixture()
    const remote = gitSyncUiFixture()
    window.remoteVSCode = remote.remote
    const { result } = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(() => result.current.attach('T-0002', attachment('saved')))
    expect(result.current.bindings['T-0002'].id).toBe('copilotcli:/saved')
    vi.mocked(bridge.getSessionLinks).mockResolvedValue(linksSnapshot())
    await act(async () => remote.notify())
    expect(result.current.bindings).toEqual({})
    expect(result.current.ready).toBe(true)
  })

  it('does not overwrite a completed save with an empty read started before that save', async () => {
    const { workspace, bridge } = fixture()
    const remote = gitSyncUiFixture()
    window.remoteVSCode = remote.remote
    const { result } = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(result.current.ready).toBe(true))
    let finish!: (value: SessionLinksSnapshot) => void
    vi.mocked(bridge.getSessionLinks).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    act(() => remote.notify())
    await act(() => result.current.attach('T-0002', attachment('saved')))
    await act(async () => { finish(linksSnapshot()) })
    expect(result.current.bindings['T-0002'].id).toBe('copilotcli:/saved')
    expect(bridge.getSessionLinks).toHaveBeenCalledTimes(3)
    expect(bridge.updateSessionLink).toHaveBeenCalledOnce()
  })

  it('preserves a binding on write conflicts until the repository is reloaded', async () => {
    const { workspace, bridge } = fixture()
    vi.mocked(bridge.getSessionLinks).mockResolvedValue(linksSnapshot({ 'T-0002': link('existing-session') }, 'c'.repeat(64)))
    vi.mocked(bridge.updateSessionLink).mockRejectedValue(new Error('Session links changed on disk.'))
    const { result } = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => { await expect(result.current.detach('T-0002')).rejects.toThrow('changed on disk') })
    expect(result.current.bindings['T-0002'].id).toBe('copilotcli:/existing-session')
    expect(result.current.ready).toBe(false)
    vi.mocked(bridge.getSessionLinks).mockResolvedValue(linksSnapshot({}, 'd'.repeat(64)))
    await act(() => result.current.reload())
    expect(result.current.ready).toBe(true)
    expect(result.current.bindings).toEqual({})
  })

  it('does not consume, alter or activate old demo or workspace bindings without a task workspace', async () => {
    const key = `${demoKey}:workspace-one`
    const content = JSON.stringify({ 'T-0002': { id: 'old-workspace-session', title: 'Old workspace data' } })
    localStorage.setItem(key, content)
    localStorage.setItem(demoKey, content)
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem')
    const { result } = renderHook(() => useSessionLinks(null))
    expect(result.current.bindings).toEqual({})
    expect(result.current.ready).toBe(false)
    await expect(result.current.attach('T-0002', attachment('not-created'))).rejects.toThrow('Open a task workspace')
    await expect(result.current.detach('T-0002')).rejects.toThrow('Open a task workspace')
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
    expect(localStorage.getItem(key)).toBe(content)
    expect(localStorage.getItem(demoKey)).toBe(content)
  })
})
