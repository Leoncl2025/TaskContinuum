import type { AgentHostTarget } from './agentHost'

export interface SessionOwner { clientId: string; machineName: string }

export type SessionLink = ({
  provider: 'github-copilot'
  sessionId: string
} | {
  provider: 'vscode-copilot'
  sessionId: string
  workspaceStorageId: string
  remoteMachineName?: string
} | (AgentHostTarget & { provider: 'agent-host' })) & { owner?: SessionOwner }

export interface SessionLinksDocument {
  schemaVersion: 1
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
  vscodeWorkspaceStorageId?: string
  vscodeRemoteMachineName?: string
  agentHost?: { hostId: string; chatId: string }
  owner?: SessionOwner
  expectedRevision: string | null
}

export interface MigrateSessionLinks {
  workspaceId: string
  bindings: Record<string, SessionLink>
}

export const sessionLinksPath = '.taskcontinuum/session-bindings.json'