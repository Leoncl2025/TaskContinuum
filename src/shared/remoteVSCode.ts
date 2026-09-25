import type { DevTunnelBridge } from './devTunnel'
import type { WorkspaceGitSyncBridge } from './gitSync'

export interface RemoteVSCodeClientIdentity {
  clientId: string
  username: string
  machineName: string
}

export interface RemoteVSCodeBridge {
  gitSync?: WorkspaceGitSyncBridge
  devices?: {
    list(): Promise<{ id: string; ownerClientId?: string; machineName: string; state: 'connected' | 'connecting' | 'offline'; enabled: boolean; expiresAt: string; error?: string }[]>
    connect(id: string): Promise<void>
    disconnect(id: string): Promise<void>
    forget(id: string): Promise<void>
  }
  devTunnels?: DevTunnelBridge
}