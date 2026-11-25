import type { TaskRecord } from './tasks'

export interface TaskTreeNode {
  task: TaskRecord
  children: TaskTreeNode[]
  matches: boolean
}

function indexTasks<T extends Pick<TaskRecord, 'id' | 'parentId'>>(tasks: readonly T[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const children = new Map<string, T[]>()
  const roots: T[] = []
  for (const task of byId.values()) {
    if (!task.parentId || task.parentId === task.id || !byId.has(task.parentId)) roots.push(task)
    else {
      const siblings = children.get(task.parentId) ?? []
      siblings.push(task)
      children.set(task.parentId, siblings)
    }
  }
  return { byId, children, roots }
}

export function* tasksInSearchOrder<T extends Pick<TaskRecord, 'id' | 'parentId'>>(tasks: readonly T[], start?: T): IterableIterator<T> {
  if (!start) {
    yield* tasks
    return
  }
  yield start
  const { byId, children } = indexTasks(tasks)
  const visited = new Set([start.id])
  const branch = [start]
  for (let i = 0; i < branch.length; i++) {
    for (const child of children.get(branch[i].id) ?? []) {
      if (visited.has(child.id)) continue
      visited.add(child.id)
      branch.push(child)
      yield child
    }
  }
  let parentId = start.parentId
  while (parentId && !visited.has(parentId)) {
    const parent = byId.get(parentId)
    if (!parent) break
    visited.add(parentId)
    yield parent
    parentId = parent.parentId
  }
  for (const task of byId.values()) {
    if (!visited.has(task.id)) yield task
  }
}

export function buildTaskTree(tasks: TaskRecord[], matches?: ReadonlySet<string>): TaskTreeNode[] {
  const { byId, children, roots } = indexTasks(tasks)
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