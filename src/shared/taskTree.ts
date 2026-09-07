import type { TaskRecord } from './tasks'

export interface TaskTreeNode {
  task: TaskRecord
  children: TaskTreeNode[]
  matches: boolean
}

export function buildTaskTree(tasks: TaskRecord[], matches?: ReadonlySet<string>): TaskTreeNode[] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const children = new Map<string, TaskRecord[]>()
  const roots: TaskRecord[] = []
  for (const task of byId.values()) {
    if (!task.parentId || task.parentId === task.id || !byId.has(task.parentId)) roots.push(task)
    else {
      const siblings = children.get(task.parentId) ?? []
      siblings.push(task)
      children.set(task.parentId, siblings)
    }
  }
  const visited = new Set<string>()
  function visit(task: TaskRecord): TaskTreeNode | null {
    if (visited.has(task.id)) return null
    visited.add(task.id)
    const descendants = (children.get(task.id) ?? []).map(visit).filter((node): node is TaskTreeNode => node !== null)
    const matched = !matches || matches.has(task.id)
    return matched || descendants.length ? { task, children: descendants, matches: matched } : null
  }
  const tree = roots.map(visit).filter((node): node is TaskTreeNode => node !== null)
  for (const task of byId.values()) {
    const node = visit(task)
    if (node) tree.push(node)
  }
  return tree
}