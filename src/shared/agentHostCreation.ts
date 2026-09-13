import type { AgentHostSession } from './agentHost'
import type { SessionOwner } from './sessionBindings'

export interface AgentHostCreationHost {
  hostId: string
  name: string
  available: boolean
  error?: string
}

export interface AgentHostCreationWorkspace {
  id: string
  name: string
  canSend: boolean
  taskState: 'available' | 'missing' | 'bound' | 'unavailable'
  expectedRevision: string | null
  error?: string
}

export interface AgentHostWorker {
  id: string
  owner: SessionOwner
  state: 'connected' | 'offline' | 'unsupported'
  hosts: AgentHostCreationHost[]
  workspaces: AgentHostCreationWorkspace[]
  error?: string
}

export interface AgentHostCreateRequest {
  operationId: string
  taskId: string
  workerId: string
  workspaceId: string
  hostId: string
  expectedRevision: string | null
}

export interface AgentHostCreation {
  operationId: string
  taskId: string
  workerId: string
  workspaceId: string
  hostId: string
  state: 'creating' | 'uncertain' | 'failed' | 'created-unbound' | 'ready'
  nativeLifecycle?: 'creating' | 'ready' | 'failed'
  session?: AgentHostSession
  error?: string
}

export type AgentHostCreationResult = Omit<AgentHostCreation, 'workerId'>
