export interface GitSyncPeer {
  deviceId: string
  machineName: string
  state: 'discovered' | 'awaiting-trust' | 'connecting' | 'linked' | 'blocked' | 'offline'
  error?: string
}

export interface WorkspaceGitSyncStatus {
  enabled: boolean
  workspaceId?: string
  intervalMs: 15000
  state: 'disabled' | 'starting' | 'syncing' | 'idle' | 'error'
  lastSyncedAt?: string
  error?: string
  pending: number
  provisionalTasks: string[]
  conflicts: string[]
  peers: GitSyncPeer[]
  settingsFile?: string
  revision: string | null
  settings?: RemoteSettings
}

export interface WorkspaceGitSyncBridge {
  status(): Promise<WorkspaceGitSyncStatus>
  enable(): Promise<boolean>
  disable(): Promise<void>
  syncNow(): Promise<void>
  revokeDevice(deviceId: string): Promise<void>
  setSetting(key: 'autoLink' | 'tunnelEnabled' | 'connectTimeoutMs', value: boolean | number | null, expectedRevision: string | null): Promise<void>
  openSettings(): Promise<void>
  onBindingsChanged(listener: () => void): () => void
}
import type { RemoteSettings } from './remoteConfig'
