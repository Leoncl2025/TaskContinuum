import type { AgentHostSession } from './agentHost'
import type { SessionOwner } from './sessionBindings'

export type AgentHostCreationLocation = 'local' | 'remote'

export const agentHostCreationErrorCodes = ['creation-records-unavailable', 'link-receipts-unavailable'] as const
export type AgentHostCreationErrorCode = typeof agentHostCreationErrorCodes[number]
export const agentHostCreationErrorMessages: Record<AgentHostCreationErrorCode, string> = {
  'creation-records-unavailable': 'Creation is blocked: the worker\'s private creation records are unreadable or are not schema v2. On the worker, close Task Continuum and back up its creation records before explicitly initializing fresh v2 state. Status checks cannot repair these records. No records were migrated and no creation was replayed.',
  'link-receipts-unavailable': 'Local Agent Host link receipts are invalid or unreadable. Schema v2 logical session receipts are required: local-session-link-receipts.json must contain {"schemaVersion":2,"receipts":[]} or valid existing receipts, not a bare array. On the execution device, close Task Continuum and back up the file before explicitly repairing it. No receipts were migrated or reset. If the session was already created, retry binding that same operation after repair; do not create another session.',
}

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
  local?: true
  state: 'connected' | 'offline' | 'unsupported' | 'blocked'
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
  state: 'creating' | 'uncertain' | 'failed' | 'created-unbound' | 'ready' | 'abandoned'
  nativeLifecycle?: 'creating' | 'ready' | 'failed'
  session?: AgentHostSession
  error?: string
}

export type AgentHostCreationResult = Omit<AgentHostCreation, 'workerId'>
