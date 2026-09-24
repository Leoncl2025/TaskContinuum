import type { ChatState, ModelSelection, SessionModelInfo, TerminalState } from '@microsoft/agent-host-protocol'
import type { ChatImageAttachment } from './chatAttachments'
import type { SessionOwner } from './sessionBindings'
import type { AgentHostCreateRequest, AgentHostCreation, AgentHostCreationHost, AgentHostCreationLocation, AgentHostWorker } from './agentHostCreation'
import type { LocalAgentHostCreateRequest, LocalAgentHostCreation } from './localAgentHostCreation'

export interface AgentHostTarget {
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
  terminalStatus?: Record<string, { state: 'loading' | 'error'; error?: string }>
  canSend: boolean
  readOnly: boolean
  error?: string
  pendingTurn?: { id: string; state: 'pending' | 'uncertain' }
}

export interface AgentHostBridge {
  list(): Promise<{ sessions: AgentHostSession[]; warnings: string[] }>
  localCreationHosts(): Promise<AgentHostCreationHost[]>
  localCreations(): Promise<LocalAgentHostCreation[]>
  createLocal(request: LocalAgentHostCreateRequest): Promise<LocalAgentHostCreation>
  localCreationStatus(operationId: string): Promise<LocalAgentHostCreation>
  creationWorkers(taskId: string, location?: AgentHostCreationLocation): Promise<AgentHostWorker[]>
  creations(taskId: string): Promise<AgentHostCreation[]>
  create(request: AgentHostCreateRequest): Promise<AgentHostCreation>
  creationStatus(operationId: string): Promise<AgentHostCreation>
  bindCreation(operationId: string): Promise<AgentHostCreation>
  models(target: AgentHostTarget): Promise<Pick<SessionModelInfo, 'id' | 'name' | 'provider' | 'configSchema'>[]>
  watch(target: AgentHostTarget): Promise<string>
  unwatch(id: string): Promise<void>
  terminal(watchId: string, resource: string, leaseId: string, retry?: boolean): Promise<void>
  releaseTerminal(watchId: string, resource: string, leaseId: string): Promise<void>
  send(target: AgentHostTarget, id: string, text: string, images?: ChatImageAttachment[], model?: ModelSelection): Promise<void>
  resolveDelivery(target: AgentHostTarget, turnId: string, action: 'check' | 'abandon', acknowledged?: boolean): Promise<'confirmed' | 'not-found' | 'abandoned'>
  cancel(target: AgentHostTarget, turnId: string): Promise<void>
  onView(listener: (event: { id: string; view: AgentHostView }) => void): () => void
}

export function agentHostKey(target: { sessionId: string; chatId: string; owner?: { clientId: string } }): string {
  return JSON.stringify([target.owner?.clientId, target.sessionId, target.chatId])
}