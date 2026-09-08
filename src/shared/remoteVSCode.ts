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