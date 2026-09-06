export type TaskStatus = 'backlog' | 'in-progress' | 'done'
export type TaskFilter = 'all' | 'active' | 'done'

export interface AcceptanceItem {
  id: string
  title: string
  done: boolean
}

export interface TaskRecord {
  id: string
  title: string
  kind: 'epic' | 'feature' | 'spike'
  parentId?: string
  status: TaskStatus
  priority: 'P1' | 'P2' | 'P3'
  owner: string
  summary: string
  goal: string
  nextAction: string
  requirements: string[]
  plan: string[]
  checklist: AcceptanceItem[]
}

export const statusLabels: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  'in-progress': 'In progress',
  done: 'Done',
}

export function taskProgress(task: TaskRecord): number {
  if (!task.checklist.length) return 0
  return Math.round(task.checklist.filter((item) => item.done).length / task.checklist.length * 100)
}

export function filterTasks(tasks: TaskRecord[], query: string, filter: TaskFilter): TaskRecord[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return tasks.filter((task) => {
    if (filter === 'active' && task.status !== 'in-progress') return false
    if (filter === 'done' && task.status !== 'done') return false
    const text = `${task.id} ${task.title} ${task.owner} ${task.summary}`.toLowerCase()
    return terms.every((term) => text.includes(term))
  })
}