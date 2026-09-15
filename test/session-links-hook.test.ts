import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSessionLinks } from '../src/renderer/chat/useSessionLinks'
import { readSessionBindings, saveSessionBindings } from '../src/renderer/chat/sessionBindings'
import type { WorkspaceBridge, WorkspaceSnapshot } from '../src/shared/workspace'
import type { SessionLinksSnapshot } from '../src/shared/sessionBindings'
import { demoTasks } from '../src/renderer/data/tasks'
import { gitSyncUiFixture } from './remote-config-ui-fixture'

afterEach(() => { delete window.workspace; delete window.remoteVSCode })

function fixture() {
  const workspace: WorkspaceSnapshot = { id: 'workspace-one', name: 'TaskContinuum-ad', title: 'Task Continuum', root: 'Q:\\src\\Projects\\TaskContinuum-ad', tasks: [demoTasks[1]], warnings: [], loadedAt: '2026-09-06T00:00:00Z' }
  let snapshot: SessionLinksSnapshot = { document: { schemaVersion: 1, bindings: {} }, revision: null }
  const bridge: WorkspaceBridge = {
    getState: vi.fn(async () => ({ current: workspace, recent: [workspace] })),
    openFolder: vi.fn(async () => null), openRecent: vi.fn(async () => ({ current: workspace, recent: [workspace] })),
    refresh: vi.fn(async () => ({ current: workspace, recent: [workspace] })), useDemo: vi.fn(async () => ({ current: null, recent: [workspace] })),
    getSessionLinks: vi.fn(async () => snapshot),
    updateSessionLink: vi.fn(async (request) => {
      const bindings = { ...snapshot.document.bindings }
      if (request.sessionId === null) delete bindings[request.taskId]
      else bindings[request.taskId] = request.vscodeWorkspaceStorageId ? { provider: 'vscode-copilot', sessionId: request.sessionId, workspaceStorageId: request.vscodeWorkspaceStorageId } : { provider: 'github-copilot', sessionId: request.sessionId }
      snapshot = { document: { schemaVersion: 1, bindings }, revision: 'a'.repeat(64) }
      return snapshot
    }),
    migrateSessionLinks: vi.fn(async (request) => {
      snapshot = { document: { schemaVersion: 1, bindings: request.bindings }, revision: 'b'.repeat(64) }
      return snapshot
    }),
  }
  window.workspace = bridge
  return { workspace, bridge }
}

describe('repository-backed session binding state', () => {
  it('loads SSH provisional binding changes immediately and drains notifications received during a save', async () => {
    const { workspace, bridge } = fixture()
    const remote = gitSyncUiFixture()
    window.remoteVSCode = remote.remote
    const view = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    const synced: SessionLinksSnapshot = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'ssh-change' } } }, revision: 'c'.repeat(64) }
    vi.mocked(bridge.getSessionLinks).mockResolvedValue(synced)
    await act(async () => remote.notify())
    expect(view.result.current.bindings['T-0002'].id).toBe('ssh-change')
    let finish!: (value: SessionLinksSnapshot) => void
    vi.mocked(bridge.updateSessionLink).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    let saving!: Promise<void>
    act(() => { saving = view.result.current.attach('T-0003', { id: 'saving', title: 'Saving' }) })
    const final: SessionLinksSnapshot = { ...synced, revision: 'd'.repeat(64), document: { schemaVersion: 1, bindings: { ...synced.document.bindings, 'T-0004': { provider: 'github-copilot', sessionId: 'newer-ssh-change' } } } }
    vi.mocked(bridge.getSessionLinks).mockResolvedValue(final)
    act(() => remote.notify())
    await act(async () => { finish(synced); await saving })
    expect(view.result.current.bindings['T-0004'].id).toBe('newer-ssh-change')
    expect(bridge.updateSessionLink).toHaveBeenCalledOnce()
    view.unmount()
  })
  it('refreshes Git-pulled links without a second attach operation', async () => {
    const { workspace, bridge } = fixture()
    const view = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    view.unmount()
    const refreshed = renderHook(() => useSessionLinks(workspace))
    try {
      await act(async () => { await Promise.resolve() })
      vi.mocked(bridge.getSessionLinks).mockResolvedValue({ document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'vscode-copilot', sessionId: 'pulled', workspaceStorageId: 'a'.repeat(32), owner: { clientId: 'b', machineName: 'Machine-B' } } } }, revision: 'e'.repeat(64), localOwner: { clientId: 'a', machineName: 'Machine-A' } })
      await act(() => vi.advanceTimersByTimeAsync(5000))
      expect(refreshed.result.current.bindings['T-0002']).toMatchObject({ id: 'pulled', remoteMachineName: 'Machine-B' })
      expect(bridge.updateSessionLink).not.toHaveBeenCalled()
    } finally { refreshed.unmount(); vi.useRealTimers() }
  })

  it('interprets the same Git owner link locally on B and remotely on A without rewriting it', async () => {
    const { workspace, bridge } = fixture()
    const owner = { clientId: 'owner-b', machineName: 'Machine-B' }
    const snapshot: SessionLinksSnapshot = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'vscode-copilot', sessionId: 'original', workspaceStorageId: 'a'.repeat(32), owner } } }, revision: 'd'.repeat(64), localOwner: owner }
    vi.mocked(bridge.getSessionLinks).mockResolvedValue(snapshot)
    const view = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    expect(view.result.current.bindings['T-0002'].remoteMachineName).toBeUndefined()
    vi.mocked(bridge.getSessionLinks).mockResolvedValue({ ...snapshot, localOwner: { clientId: 'client-a', machineName: 'Machine-A' } })
    await act(() => view.result.current.reload())
    expect(view.result.current.bindings['T-0002']).toMatchObject({ owner, remoteMachineName: 'Machine-B' })
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
  })

  it('waits for a successful disk write before exposing the binding and never writes real links to localStorage', async () => {
    const { workspace, bridge } = fixture()
    const { result } = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(result.current.ready).toBe(true))
    let finish!: (snapshot: SessionLinksSnapshot) => void
    vi.mocked(bridge.updateSessionLink).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    let writing!: Promise<void>
    act(() => { writing = result.current.attach('T-0002', { id: 'session-one', title: 'Private title' }) })
    expect(result.current.bindings).toEqual({})
    expect(result.current.busy).toBe(true)
    await act(async () => { finish({ document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'session-one' } } }, revision: 'a'.repeat(64) }); await writing })
    expect(result.current.bindings['T-0002'].id).toBe('session-one')
    expect(bridge.updateSessionLink).toHaveBeenCalledWith({ workspaceId: workspace.id, taskId: 'T-0002', sessionId: 'session-one', expectedRevision: null })
    expect(readSessionBindings(workspace.id)).toEqual({})
  })

  it('does not auto-publish local cache data and migrates only on an explicit action', async () => {
    const { workspace, bridge } = fixture()
    saveSessionBindings({ 'T-0002': { id: 'legacy-session', title: 'Private local title' } }, workspace.id)
    const { result } = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(result.current.needsMigration).toBe(true))
    expect(result.current.bindings).toEqual({})
    expect(bridge.migrateSessionLinks).not.toHaveBeenCalled()
    await act(() => result.current.migrate())
    expect(result.current.bindings['T-0002'].id).toBe('legacy-session')
    expect(bridge.migrateSessionLinks).toHaveBeenCalledWith({ workspaceId: workspace.id, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'legacy-session' } } })
    expect(readSessionBindings(workspace.id)).toEqual({})
    expect(result.current.needsMigration).toBe(false)
  })

  it('keeps a VS Code link separate from native CLI execution and local-only caches', async () => {
    const { workspace, bridge } = fixture()
    const { result } = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(() => result.current.attach('T-0002', { id: 'original-chat', title: 'Private title', vscodeWorkspaceStorageId: 'a'.repeat(32) }))
    expect(result.current.bindings['T-0002']).toMatchObject({ id: 'original-chat', vscodeWorkspaceStorageId: 'a'.repeat(32) })
    expect(bridge.updateSessionLink).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'original-chat', vscodeWorkspaceStorageId: 'a'.repeat(32) }))
    expect(readSessionBindings(workspace.id)).toEqual({})
  })

  it('treats an existing repository file as authoritative even when a legacy cache disagrees', async () => {
    const { workspace, bridge } = fixture()
    saveSessionBindings({ 'T-0002': { id: 'stale-local-session', title: 'Old cache' } }, workspace.id)
    vi.mocked(bridge.getSessionLinks).mockResolvedValue({ document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'from-repository' } } }, revision: 'b'.repeat(64) })
    const { result } = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.bindings['T-0002'].id).toBe('from-repository')
    expect(result.current.needsMigration).toBe(false)
    expect(bridge.updateSessionLink).not.toHaveBeenCalled()
  })

  it('preserves the binding on write conflicts until the repository is explicitly reloaded', async () => {
    const { workspace, bridge } = fixture()
    const original: SessionLinksSnapshot = { document: { schemaVersion: 1, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'existing-session' } } }, revision: 'c'.repeat(64) }
    vi.mocked(bridge.getSessionLinks).mockResolvedValue(original)
    vi.mocked(bridge.updateSessionLink).mockRejectedValue(new Error('Session links changed on disk.'))
    const { result } = renderHook(() => useSessionLinks(workspace))
    await waitFor(() => expect(result.current.ready).toBe(true))
    await act(async () => { await expect(result.current.detach('T-0002')).rejects.toThrow('changed on disk') })
    expect(result.current.bindings['T-0002'].id).toBe('existing-session')
    expect(result.current.ready).toBe(false)
    vi.mocked(bridge.getSessionLinks).mockResolvedValue({ document: { schemaVersion: 1, bindings: {} }, revision: 'd'.repeat(64) })
    await act(() => result.current.reload())
    expect(result.current.ready).toBe(true)
    expect(result.current.bindings).toEqual({})
  })

  it('retains the local-only demo binding behavior', async () => {
    const { result } = renderHook(() => useSessionLinks(null))
    await act(() => result.current.attach('T-0002', { id: 'demo-session', title: 'Demo title' }))
    expect(readSessionBindings()['T-0002'].id).toBe('demo-session')
    await act(() => result.current.detach('T-0002'))
    expect(readSessionBindings()).toEqual({})
  })
})