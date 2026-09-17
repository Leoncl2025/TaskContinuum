import type { AgentHostSession } from './agentHost'

export interface LocalAgentHostCreateRequest {
  operationId: string
  hostId: string
}

export interface LocalAgentHostCreation extends LocalAgentHostCreateRequest {
  state: 'creating' | 'uncertain' | 'failed' | 'ready'
  nativeLifecycle?: 'creating' | 'ready' | 'failed'
  session?: AgentHostSession
  error?: string
}
