export interface SharedActor {
  kind: 'user' | 'agent' | 'host'
  id: string
  name: string
  machineId: string
  machineName: string
}

export type SharedPermission = 'read' | 'send' | 'approve' | 'stop' | 'checkpoint' | 'manage'

export interface SharedSessionDescriptor {
  schemaVersion: 1
  id: string
  workspaceId: string
  taskId: string
  mode: 'live' | 'checkpoint'
  owner: { machineId: string; machineName: string; agentId: string; nativeSessionId: string; epoch: number }
  createdAt: string
  parent?: { sessionId: string; checkpointId: string; mode: 'semantic' }
}

export interface SharedEvent {
  sessionId: string
  epoch: number
  seq: number
  at: string
  actor: SharedActor
  type: 'history' | 'message' | 'started' | 'delta' | 'activity' | 'completed' | 'failed' | 'interrupted' | 'permission' | 'question' | 'resolved'
  commandId?: string
  text?: string
  role?: 'user' | 'assistant'
  interactionId?: string
  permissionKind?: string
  choices?: string[]
  allowFreeform?: boolean
}

export interface SharedGrant {
  id: string
  actor: SharedActor
  permissions: SharedPermission[]
  tokenHash: string
}

export interface SharedEnrollment {
  schemaVersion: 1
  session: SharedSessionDescriptor
  actor: SharedActor
  permissions: SharedPermission[]
  token: string
  endpoint: { kind: 'local'; port: number } | { kind: 'ssh'; host: string; remotePort: number }
}

export interface SharedView {
  session: SharedSessionDescriptor
  events: SharedEvent[]
  online: boolean
  lastSyncedAt?: string
  error?: string
  actor: SharedActor
  permissions: SharedPermission[]
  checkpoint?: { id: string; commit: string; createdAt: string }
}

export interface SharedConnectionSummary {
  id: string
  taskId: string
  workspaceId: string
  owner: string
  machine: string
  mode: 'live' | 'checkpoint'
  parentSessionId?: string
}

export interface SharedPublishOptions {
  taskId: string
  mode: 'live' | 'checkpoint'
  workingDirectory: string
  model?: string
}

export interface SharedCheckpointPreview {
  token: string
  checkpointId: string
  sessionId: string
  taskId: string
  lastSeq: number
  commit: string
  context: string
  createdAt: string
}

export interface SharedDesktopUpdate {
  sessionId: string
  event?: SharedEvent
  online?: boolean
  error?: string
  lastSyncedAt?: string
}

export interface SharedDesktopBridge {
  identity(): Promise<SharedActor>
  exportIdentity(): Promise<boolean>
  list(workspaceRoot: string): Promise<SharedConnectionSummary[]>
  publish(options: SharedPublishOptions): Promise<SharedView>
  join(): Promise<SharedView | null>
  open(id: string): Promise<SharedView>
  cached(id: string): Promise<SharedView>
  disconnect(id: string): Promise<void>
  send(id: string, commandId: string, text: string): Promise<void>
  stop(id: string, commandId: string): Promise<void>
  respond(id: string, interactionId: string, answer: boolean | string): Promise<void>
  invite(id: string, host: string, role: 'reader' | 'contributor' | 'operator'): Promise<boolean>
  exportCheckpoint(id: string): Promise<string | null>
  previewCheckpoint(): Promise<SharedCheckpointPreview | null>
  keepCheckpoint(token: string): Promise<SharedView>
  fork(token: string, workingDirectory: string): Promise<SharedView>
  stopHost(id: string): Promise<void>
  restartHost(id: string): Promise<SharedView>
  onUpdate(listener: (update: SharedDesktopUpdate) => void): () => void
}