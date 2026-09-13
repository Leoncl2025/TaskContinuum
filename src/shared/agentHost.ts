import type { ChatState, ModelSelection, SessionModelInfo, TerminalState } from '@microsoft/agent-host-protocol'
import type { ChatImageAttachment } from './chatAttachments'
import type { SessionOwner } from './sessionBindings'

export interface AgentHostTarget {
  hostId: string
  sessionId: string
  chatId: string
  owner: SessionOwner
}

export interface AgentHostSession extends AgentHostTarget {
  title: string
  provider: string
  updatedAt: string
  canSend: boolean
}

export interface AgentHostView {
  target: AgentHostTarget
  state: 'connecting' | 'connected' | 'offline'
  chat?: ChatState
  terminals: Record<string, TerminalState>
  canSend: boolean
  readOnly: boolean
  error?: string
  pendingTurn?: { id: string; state: 'pending' | 'uncertain' }
}

export interface AgentHostBridge {
  list(): Promise<{ sessions: AgentHostSession[]; warnings: string[] }>
  models(target: AgentHostTarget): Promise<Pick<SessionModelInfo, 'id' | 'name' | 'provider' | 'configSchema'>[]>
  watch(target: AgentHostTarget): Promise<string>
  unwatch(id: string): Promise<void>
  send(target: AgentHostTarget, id: string, text: string, images?: ChatImageAttachment[], model?: ModelSelection): Promise<void>
  cancel(target: AgentHostTarget, turnId: string): Promise<void>
  onView(listener: (event: { id: string; view: AgentHostView }) => void): () => void
}

export function agentHostKey(target: { hostId: string; sessionId: string; chatId: string; owner?: { clientId: string } }): string {
  return JSON.stringify([target.owner?.clientId, target.hostId, target.sessionId, target.chatId])
}