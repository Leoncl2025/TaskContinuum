export const taskStatuses = ['backlog', 'analyzing', 'designing', 'ready', 'in-progress', 'in-review', 'blocked', 'done', 'dropped'] as const
export type TaskStatus = typeof taskStatuses[number]
export type TaskFilter = 'all' | 'active' | 'done'

export interface AcceptanceItem {
  id: string
  title: string
  done: boolean
}

export interface TaskRecord {
  id: string
  title: string
  kind: string
  parentId?: string
  status: TaskStatus
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  owner: string
  summary: string
  goal: string
  nextAction: string
  requirements: string[]
  plan: string[]
  checklist: AcceptanceItem[]
  progress?: number
  documents?: { requirements: string | null; plan: string | null; checklist: string | null }
}

export const statusLabels: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  analyzing: 'Analyzing',
  designing: 'Designing',
  ready: 'Ready',
  'in-progress': 'In progress',
  'in-review': 'In review',
  blocked: 'Blocked',
  done: 'Done',
  dropped: 'Dropped',
}

export function taskProgress(task: TaskRecord): number {
  if (task.progress !== undefined) return task.progress
  if (!task.checklist.length) return 0
  return Math.round(task.checklist.filter((item) => item.done).length / task.checklist.length * 100)
}

export function filterTasks(tasks: TaskRecord[], query: string, filter: TaskFilter): TaskRecord[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return tasks.filter((task) => {
    if (filter === 'active' && ['backlog', 'done', 'dropped'].includes(task.status)) return false
    if (filter === 'done' && task.status !== 'done' && task.status !== 'dropped') return false
    const text = `${task.id} ${task.title} ${task.owner} ${task.summary}`.toLowerCase()
    return terms.every((term) => text.includes(term))
  })
}