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
    list(): Promise<{ id: string; machineName: string; state: 'connected' | 'connecting' | 'offline'; enabled: boolean; expiresAt: string; error?: string }[]>
    recipients(): Promise<{ id: string; username: string; machineName: string; expiresAt: string; linkedAccess?: 'none' | 'read' | 'send' }[]>
    pair(canSend?: boolean): Promise<boolean>
    workspace?(id: string, access: 'none' | 'read' | 'send'): Promise<boolean>
    adoptLinks?(): Promise<boolean>
    import(): Promise<boolean>
    connect(id: string): Promise<void>
    disconnect(id: string): Promise<void>
    forget(id: string): Promise<void>
    revoke(id: string): Promise<void>
  }
  devTunnels?: DevTunnelBridge
  exportIdentity(managed?: boolean): Promise<boolean>
}