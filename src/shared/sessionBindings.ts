import type { AgentHostTarget } from './agentHost'

export interface SessionOwner { clientId: string; machineName: string }

export type SessionLink = AgentHostTarget & { provider: 'agent-host' }

export interface SessionLinksDocument {
  schemaVersion: 2
  bindings: Record<string, SessionLink>
}

export interface SessionLinksSnapshot {
  document: SessionLinksDocument
  revision: string | null
  localOwner?: SessionOwner
}

export interface UpdateSessionLink {
  workspaceId: string
  taskId: string
  sessionId: string | null
  agentHost?: { chatId: string }
  owner?: SessionOwner
  expectedRevision: string | null
}
