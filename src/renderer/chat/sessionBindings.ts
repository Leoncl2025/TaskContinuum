import type { SessionOwner } from '../../shared/sessionBindings'
import { agentHostKey } from '../../shared/agentHost'
import type { AgentHostTarget } from '../../shared/agentHost'
import { machineLabel } from '../machineAliases'
import type { SessionTimestamps } from './useSessionTitles'

export interface SessionBinding {
  id: string
  title: string
  owner: SessionOwner
  ownerIsRemote?: boolean
  agentHost: AgentHostTarget
}
export type SessionBindings = Record<string, SessionBinding[]>

export const sessionSortModes = ['manual', 'updated-desc', 'created-desc', 'created-asc', 'title-asc', 'title-desc', 'machine-asc'] as const
export type SessionSortMode = typeof sessionSortModes[number]
export const DEFAULT_SESSION_SORT_MODE: SessionSortMode = 'updated-desc'

export interface SessionSortOptions {
  mode: SessionSortMode
  orderedKeys?: readonly string[]
  titles?: Readonly<Record<string, string>>
  timestamps?: Readonly<Record<string, SessionTimestamps>>
  aliases?: Readonly<Record<string, string>>
}

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function compareSessionNames(left: string, right: string): number { return naturalCollator.compare(left, right) }

export function sessionBindingTitle(binding: SessionBinding, titles?: SessionSortOptions['titles']): string {
  return titles?.[agentHostKey(binding.agentHost)] || (binding.title !== 'Agent Host' ? binding.title : binding.id)
}

export function sessionBindingKey(binding: Pick<SessionBinding, 'agentHost'>): string {
  return `ahp:${agentHostKey(binding.agentHost)}`
}

export function moveSessionKey(keys: readonly string[], draggedKey: string, insertIndex: number): string[] | undefined {
  const fromIndex = keys.indexOf(draggedKey)
  if (fromIndex < 0 || keys.length <= 1) return undefined
  const clamped = Math.max(0, Math.min(keys.length, insertIndex))
  if (clamped === fromIndex || clamped === fromIndex + 1) return undefined
  const next = keys.filter((_, index) => index !== fromIndex)
  next.splice(clamped > fromIndex ? clamped - 1 : clamped, 0, draggedKey)
  return next
}

export function orderSessionBindings(bindings: readonly SessionBinding[], orderedKeys: readonly string[] | undefined): SessionBinding[] {
  if (!orderedKeys?.length || bindings.length <= 1) return [...bindings]
  const byKey = new Map(bindings.map((binding) => [sessionBindingKey(binding), binding]))
  const seen = new Set<string>()
  const ordered: SessionBinding[] = []
  for (const key of orderedKeys) {
    const binding = byKey.get(key)
    if (binding && !seen.has(key)) {
      seen.add(key)
      ordered.push(binding)
    }
  }
  for (const binding of bindings) {
    const key = sessionBindingKey(binding)
    if (!seen.has(key)) {
      seen.add(key)
      ordered.push(binding)
    }
  }
  return ordered
}

export function orderWorkspaceSessionBindings(
  bindings: SessionBindings,
  sessionOrders: Readonly<Record<string, readonly string[]>>,
): SessionBindings {
  if (!Object.keys(sessionOrders).length) return bindings
  return Object.fromEntries(Object.entries(bindings).map(([taskId, taskBindings]) => [
    taskId,
    orderSessionBindings(taskBindings, sessionOrders[taskId]),
  ]))
}

export function sortSessionBindings(bindings: readonly SessionBinding[], options: SessionSortOptions): SessionBinding[] {
  if (bindings.length <= 1) return [...bindings]
  const { mode } = options
  if (mode === 'manual') return orderSessionBindings(bindings, options.orderedKeys)

  const decorated = bindings.map((binding, index) => {
    const key = agentHostKey(binding.agentHost)
    const label = sessionBindingTitle(binding, options.titles)
    const machine = machineLabel(binding.owner, options.aliases ?? {})
    const time = options.timestamps?.[key]
    return { binding, index, label, machine, updatedAt: time?.updatedAt, createdAt: time?.createdAt }
  })

  const compareUpdatedDesc = (left: typeof decorated[number], right: typeof decorated[number]): number => {
    const leftMissing = left.updatedAt === undefined ? 1 : 0
    const rightMissing = right.updatedAt === undefined ? 1 : 0
    if (leftMissing !== rightMissing) return leftMissing - rightMissing
    if (left.updatedAt !== undefined && right.updatedAt !== undefined && left.updatedAt !== right.updatedAt) {
      return right.updatedAt - left.updatedAt
    }
    return left.index - right.index
  }

  decorated.sort((left, right) => {
    switch (mode) {
      case 'updated-desc':
        return compareUpdatedDesc(left, right)
      case 'created-desc': {
        const leftMissing = left.createdAt === undefined ? 1 : 0
        const rightMissing = right.createdAt === undefined ? 1 : 0
        if (leftMissing !== rightMissing) return leftMissing - rightMissing
        if (left.createdAt !== undefined && right.createdAt !== undefined && left.createdAt !== right.createdAt) {
          return right.createdAt - left.createdAt
        }
        return right.index - left.index
      }
      case 'created-asc': {
        const leftMissing = left.createdAt === undefined ? 1 : 0
        const rightMissing = right.createdAt === undefined ? 1 : 0
        if (leftMissing !== rightMissing) return leftMissing - rightMissing
        if (left.createdAt !== undefined && right.createdAt !== undefined && left.createdAt !== right.createdAt) {
          return left.createdAt - right.createdAt
        }
        return left.index - right.index
      }
      case 'title-asc': {
        const diff = compareSessionNames(left.label, right.label)
        return diff !== 0 ? diff : left.index - right.index
      }
      case 'title-desc': {
        const diff = compareSessionNames(right.label, left.label)
        return diff !== 0 ? diff : left.index - right.index
      }
      case 'machine-asc': {
        const diff = naturalCollator.compare(left.machine, right.machine)
        return diff !== 0 ? diff : compareUpdatedDesc(left, right)
      }
    }
  })

  return decorated.map((item) => item.binding)
}
