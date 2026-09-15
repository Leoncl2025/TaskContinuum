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

export interface WorkspaceBridge {
  getState(): Promise<WorkspaceState>
  openFolder(): Promise<WorkspaceState | null>
  openRecent(id: string): Promise<WorkspaceState>
  refresh(): Promise<WorkspaceState>
  useDemo(): Promise<WorkspaceState>
  getSessionLinks(workspaceId: string): Promise<SessionLinksSnapshot>
  updateSessionLink(request: UpdateSessionLink): Promise<SessionLinksSnapshot>
}