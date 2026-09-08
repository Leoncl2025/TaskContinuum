export type SessionLink = {
  provider: 'github-copilot'
  sessionId: string
} | {
  provider: 'vscode-copilot'
  sessionId: string
  workspaceStorageId: string
  remoteMachineName?: string
}

export interface SessionLinksDocument {
  schemaVersion: 1
  bindings: Record<string, SessionLink>
}

export interface SessionLinksSnapshot {
  document: SessionLinksDocument
  revision: string | null
}

export interface UpdateSessionLink {
  workspaceId: string
  taskId: string
  sessionId: string | null
  vscodeWorkspaceStorageId?: string
  vscodeRemoteMachineName?: string
  expectedRevision: string | null
}

export interface MigrateSessionLinks {
  workspaceId: string
  bindings: Record<string, SessionLink>
}

export const sessionLinksPath = '.taskcontinuum/session-bindings.json'