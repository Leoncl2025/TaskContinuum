import type { SessionSnapshot } from './sessions'
import type { VSCodeChatTarget } from './remoteVSCode'

export interface VSCodeChatIdentity {
  nativeSessionId: string
  workspaceStorageId: string
}

export interface VSCodeChatParticipant {
  clientId?: string
  username: string
  machineName: string
}

export interface VSCodeExecutionIdentity {
  agentName: string
  machineName: string
}

export interface VSCodeChatDelivery {
  id: string
  nativeSessionId: string
  text: string
  participant: VSCodeChatParticipant
  execution: VSCodeExecutionIdentity
  createdAt: string
  state: 'pending' | 'submitted' | 'failed' | 'uncertain'
  nativeRequestId?: string
  error?: string
}

export interface VSCodeChatView extends SessionSnapshot {
  participant?: VSCodeChatParticipant
  execution?: VSCodeExecutionIdentity
  connectionState?: 'offline' | 'connected' | 'unsupported'
  canSend?: boolean
  responding?: boolean
  bridgeError?: string
  deliveries?: VSCodeChatDelivery[]
}

const nativeIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/
const storageIdPattern = /^[a-f0-9]{32}$/i

export function checkedVSCodeIdentity(value: VSCodeChatIdentity): VSCodeChatIdentity {
  if (!nativeIdPattern.test(value.nativeSessionId) || !storageIdPattern.test(value.workspaceStorageId)) {
    throw new Error('Invalid existing VS Code chat identity.')
  }
  return { nativeSessionId: value.nativeSessionId, workspaceStorageId: value.workspaceStorageId.toLowerCase() }
}

export function identityFromVSCodeHistory(id: string): VSCodeChatIdentity {
  const match = /^vscode:\d+:([a-f0-9]{32}):([a-zA-Z0-9][a-zA-Z0-9_-]{0,199})\.jsonl?$/i.exec(id)
  if (!match) throw new Error('Choose an existing VS Code conversation from the session list.')
  return checkedVSCodeIdentity({ workspaceStorageId: match[1], nativeSessionId: match[2] })
}

export function vsCodeChatResource(nativeSessionId: string): string {
  if (!nativeIdPattern.test(nativeSessionId)) throw new Error('Invalid existing VS Code session ID.')
  const encoded = btoa(nativeSessionId).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  return `vscode-chat-session://local/${encoded}`
}

export function vsCodeBridgeConnectUri(value: VSCodeChatIdentity, scheme: 'vscode' | 'vscode-insiders' = 'vscode'): string {
  const identity = checkedVSCodeIdentity(value)
  if (scheme !== 'vscode' && scheme !== 'vscode-insiders') throw new Error('Unsupported VS Code connection scheme.')
  const uri = new URL(`${scheme}://taskcontinuum.vscode-bridge/connect`)
  uri.searchParams.set('workspaceStorageId', identity.workspaceStorageId)
  uri.searchParams.set('nativeSessionId', identity.nativeSessionId)
  return uri.toString()
}

export function identityFromVSCodeBridgeUri(value: string, scheme: string, workspaceStorageId: string): VSCodeChatIdentity {
  if (value.length > 1024) throw new Error('Invalid VS Code connection request.')
  const uri = new URL(value)
  if (!['vscode', 'vscode-insiders'].includes(scheme) || uri.protocol !== `${scheme}:` || uri.host !== 'taskcontinuum.vscode-bridge' || uri.pathname !== '/connect' || uri.username || uri.password || uri.hash || [...uri.searchParams].length !== 2 || uri.searchParams.getAll('workspaceStorageId').length !== 1 || uri.searchParams.getAll('nativeSessionId').length !== 1) throw new Error('Invalid VS Code connection request.')
  const identity = checkedVSCodeIdentity({ workspaceStorageId: uri.searchParams.get('workspaceStorageId') ?? '', nativeSessionId: uri.searchParams.get('nativeSessionId') ?? '' })
  if (identity.workspaceStorageId !== workspaceStorageId.toLowerCase()) throw new Error('This request belongs to a different VS Code workspace. Focus the original workspace window and reconnect from Task Continuum.')
  return identity
}

export interface VSCodeChatBridge {
  read(identity: VSCodeChatTarget): Promise<VSCodeChatView>
  connect?(identity: VSCodeChatTarget): Promise<void>
  open(identity: VSCodeChatTarget): Promise<void>
  send?(identity: VSCodeChatTarget, commandId: string, text: string): Promise<VSCodeChatDelivery>
  watch(identity: VSCodeChatTarget | null): Promise<void>
  onChange(listener: (identity: VSCodeChatTarget) => void): () => void
}