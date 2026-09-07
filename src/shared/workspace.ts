import type { TaskRecord } from './tasks'
import type { MigrateSessionLinks, SessionLinksSnapshot, UpdateSessionLink } from './sessionBindings'

export interface WorkspaceDescriptor {
  id: string
  name: string
  title: string
  root: string
}

export interface WorkspaceSnapshot extends WorkspaceDescriptor {
  tasks: TaskRecord[]
  warnings: string[]
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
  migrateSessionLinks(request: MigrateSessionLinks): Promise<SessionLinksSnapshot>
}