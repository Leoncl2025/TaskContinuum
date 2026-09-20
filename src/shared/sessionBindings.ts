import type { AgentHostTarget } from './agentHost'

export interface SessionOwner { clientId: string; machineName: string }

export type SessionLink = AgentHostTarget & { provider: 'agent-host' }

export interface SessionLinksDocument {
  schemaVersion: '2.1'
  bindings: Record<string, SessionLink[]>
}

export function taskSessionLinks(bindings: SessionLinksDocument['bindings'], taskId: string): SessionLink[] {
  return bindings[taskId] ?? []
}

export function sessionLinkEntries(bindings: SessionLinksDocument['bindings']): Array<[string, SessionLink]> {
  return Object.keys(bindings).flatMap((taskId) => taskSessionLinks(bindings, taskId).map((link): [string, SessionLink] => [taskId, link]))
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
  detachTarget?: AgentHostTarget
  expectedRevision: string | null
}
