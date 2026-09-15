import { vi } from 'vitest'
import type { RemoteVSCodeBridge } from '../src/shared/remoteVSCode'
import type { WorkspaceGitSyncBridge, WorkspaceGitSyncStatus } from '../src/shared/gitSync'

export function gitSyncUiFixture() {
  let status: WorkspaceGitSyncStatus = { enabled: false, state: 'disabled', intervalMs: 15000, pending: 0, provisionalTasks: [], conflicts: [], peers: [], revision: null }
  const listeners = new Set<() => void>()
  const api: WorkspaceGitSyncBridge = {
    status: vi.fn(async () => status),
    enable: vi.fn(async () => { status = { ...status, enabled: true, state: 'idle' }; return true }),
    disable: vi.fn(async () => { status = { ...status, enabled: false, state: 'disabled' } }),
    syncNow: vi.fn(async () => {}),
    revokeDevice: vi.fn(async () => {}),
    setSetting: vi.fn(async () => {}),
    openSettings: vi.fn(async () => {}),
    onBindingsChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const remote: RemoteVSCodeBridge = {
    gitSync: api,
    list: vi.fn(async () => []), connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), forget: vi.fn(async () => {}),
    exportIdentity: vi.fn(async () => true), importInvitation: vi.fn(async () => null),
    share: vi.fn(async () => true), grants: vi.fn(async () => []), revoke: vi.fn(async () => {}),
  }
  return { api, remote, notify: () => { for (const listener of listeners) listener() }, setStatus: (value: WorkspaceGitSyncStatus) => { status = value } }
}
