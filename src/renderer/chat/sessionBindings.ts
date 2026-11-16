import type { SessionOwner } from '../../shared/sessionBindings'
import { agentHostKey } from '../../shared/agentHost'
import type { AgentHostTarget } from '../../shared/agentHost'

export interface SessionBinding {
  id: string
  title: string
  owner: SessionOwner
  ownerIsRemote?: boolean
  agentHost: AgentHostTarget
}
export type SessionBindings = Record<string, SessionBinding[]>

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
