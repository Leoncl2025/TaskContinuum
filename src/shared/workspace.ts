import type { TaskRecord } from './tasks'
import type { SessionLinksSnapshot, UpdateSessionLink } from './sessionBindings'
import type { Issue } from './taskDocuments/common'

export interface WorkspaceDescriptor {
  id: string
  name: string
  title: string
  root: string
}

export interface WorkspaceSnapshot extends WorkspaceDescriptor {
  tasks: TaskRecord[]
  warnings: string[]
  diagnostics?: Array<Omit<Issue, 'code'> & { code: string; line?: number }>
  loadedAt: string
}

export interface WorkspaceState {
  current: WorkspaceSnapshot | null
  recent: WorkspaceDescriptor[]
  warning?: string
}

export const workspaceRepositoryNameLimit = 60

export interface CreateWorkspaceRepositoryRequest {
  parentPath: string
  name: string
}

export interface RepositoryPushRequest {
  workspaceId: string
  remoteUrl: string
}

export type RepositoryCredentialHelper = 'gcm' | 'configured' | 'none'

export interface WorkspaceRepositoryPushPlan {
  workspaceId: string
  branch: string
  head: string
  remoteUrl: string
  repositoryUrl: string
  shell: 'powershell' | 'posix'
  commands: string
}

export interface WorkspaceRepositoryStatus {
  workspaceId: string
  name: string
  branch: string | null
  remoteUrl: string | null
  credentialHelper: RepositoryCredentialHelper
}

export interface WorkspaceBridge {
  getState(): Promise<WorkspaceState>
  openFolder(): Promise<WorkspaceState | null>
  chooseParentFolder(): Promise<string | null>
  createRepository(request: CreateWorkspaceRepositoryRequest): Promise<WorkspaceState>
  getRepositoryStatus(workspaceId: string): Promise<WorkspaceRepositoryStatus>
  openRepositoryCreation(workspaceId: string): Promise<void>
  getRepositoryPushPlan(request: RepositoryPushRequest): Promise<WorkspaceRepositoryPushPlan>
  verifyRepositoryPublication(request: RepositoryPushRequest): Promise<{ url: string }>
  openRecent(id: string): Promise<WorkspaceState>
  refresh(): Promise<WorkspaceState>
  closeWorkspace(): Promise<WorkspaceState>
  getSessionLinks(workspaceId: string): Promise<SessionLinksSnapshot>
  updateSessionLink(request: UpdateSessionLink): Promise<SessionLinksSnapshot>
}