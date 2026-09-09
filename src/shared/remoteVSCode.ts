import type { VSCodeChatIdentity, VSCodeChatParticipant, VSCodeExecutionIdentity } from './vscodeChat'
import type { DevTunnelBridge } from './devTunnel'

export interface VSCodeChatTarget extends VSCodeChatIdentity {
  remoteMachineName?: string
}

export interface RemoteVSCodeClientIdentity extends VSCodeChatParticipant {
  clientId: string
}

export interface RemoteVSCodeConnection {
  id: string
  deviceId?: string
  target: VSCodeChatTarget
  title: string
  hostAlias: string
  transport?: 'ssh' | 'dev-tunnel'
  tunnelId?: string
  participant: RemoteVSCodeClientIdentity
  execution: VSCodeExecutionIdentity
  canSend: boolean
  expiresAt: string
  state: 'disconnected' | 'connecting' | 'connected' | 'offline'
}

export interface RemoteVSCodeGrant {
  id: string
  participant: RemoteVSCodeClientIdentity
  canSend: boolean
  expiresAt: string
}

export interface RemoteVSCodeBridge {
  devices?: {
    list(): Promise<{ id: string; machineName: string; state: 'connected' | 'connecting' | 'offline'; enabled: boolean; expiresAt: string; error?: string }[]>
    recipients(): Promise<{ id: string; username: string; machineName: string; expiresAt: string }[]>
    pair(): Promise<boolean>
    import(): Promise<boolean>
    connect(id: string): Promise<void>
    disconnect(id: string): Promise<void>
    forget(id: string): Promise<void>
    revoke(id: string): Promise<void>
    share(id: string, identity: VSCodeChatIdentity, canSend: boolean): Promise<boolean>
    unshare(id: string, identity: VSCodeChatIdentity): Promise<void>
  }
  devTunnels?: DevTunnelBridge
  exportIdentity(managed?: boolean): Promise<boolean>
  importInvitation(hostAlias?: string): Promise<RemoteVSCodeConnection | null>
  list(): Promise<RemoteVSCodeConnection[]>
  connect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  forget(id: string): Promise<void>
  share(identity: VSCodeChatIdentity, canSend: boolean, managed?: boolean): Promise<boolean>
  grants(identity: VSCodeChatIdentity): Promise<RemoteVSCodeGrant[]>
  revoke(identity: VSCodeChatIdentity, grantId: string): Promise<void>
}