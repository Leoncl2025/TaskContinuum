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

export interface CreateWorkspaceRepositoryRequest {
  parentPath: string
  name: string
}

export interface PublishWorkspaceRepositoryRequest {
  workspaceId: string
  private: boolean
}

export interface WorkspaceRepositoryStatus {
  workspaceId: string
  name: string
  branch: string | null
  remoteUrl: string | null
  published: boolean
  github: { installed: boolean; authenticated: boolean; login?: string }
}

export interface WorkspaceBridge {
  getState(): Promise<WorkspaceState>
  openFolder(): Promise<WorkspaceState | null>
  chooseParentFolder(): Promise<string | null>
  createRepository(request: CreateWorkspaceRepositoryRequest): Promise<WorkspaceState>
  getRepositoryStatus(workspaceId: string): Promise<WorkspaceRepositoryStatus>
  publishRepository(request: PublishWorkspaceRepositoryRequest): Promise<{ url: string }>
  openRecent(id: string): Promise<WorkspaceState>
  refresh(): Promise<WorkspaceState>
  closeWorkspace(): Promise<WorkspaceState>
  getSessionLinks(workspaceId: string): Promise<SessionLinksSnapshot>
  updateSessionLink(request: UpdateSessionLink): Promise<SessionLinksSnapshot>
}