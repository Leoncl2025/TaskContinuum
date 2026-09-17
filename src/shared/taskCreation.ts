import { z } from 'zod/v3'
import { Level, MemberId, Priority, Slug, TaskId, TaskType } from './taskDocuments/common'
import type { Task } from './taskDocuments/task'
import type { WorkspaceState } from './workspace'

export const taskCreationDraftSchema = z.object({
  title: z.string().trim().min(1, 'Enter a task title.').max(120),
  description: z.string().max(8000).optional(),
  parentId: TaskId.nullable().optional(),
  owner: MemberId.optional(),
  level: Level.optional(),
  type: TaskType.optional(),
  priority: Priority.optional(),
  slug: Slug.optional(),
  acceptance: z.array(z.string().trim().min(1).max(500).refine((value) => !/[\r\n]/.test(value), 'Each acceptance criterion must be a single line.')).max(30).optional(),
}).strict()

export type TaskCreationDraft = z.infer<typeof taskCreationDraftSchema>

export interface TaskCreationContext {
  root: string
  members: Array<{ id: string; name: string }>
  levels: Array<{ id: Task['relations']['level']; title: string; rank: number }>
  parents: Array<{ id: string; title: string; level: Task['relations']['level'] }>
  types: Task['type'][]
  priorities: Task['priority'][]
  defaults: {
    owner: string
    level: Task['relations']['level']
    type: Task['type']
    priority: Task['priority']
  }
}

export interface WorkspaceTaskCreationContext extends TaskCreationContext {
  workspaceId: string
}

export interface CreateWorkspaceTaskRequest {
  workspaceId: string
  draft: TaskCreationDraft
}

export interface CreateWorkspaceTaskResult {
  state: WorkspaceState
  taskId: string
}

export interface TaskAgentInstructionsRequest {
  workspaceId: string
  goal: string
  parentId?: string | null
}
