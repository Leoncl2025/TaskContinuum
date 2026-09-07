export interface SessionLink {
  provider: 'github-copilot'
  sessionId: string
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
  expectedRevision: string | null
}

export interface MigrateSessionLinks {
  workspaceId: string
  bindings: Record<string, SessionLink>
}

export const sessionLinksPath = '.taskcontinuum/session-bindings.json'