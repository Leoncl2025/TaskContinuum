import { compareSessionNames, moveSessionKey, orderSessionBindings, sessionBindingKey, sessionBindingTitle, sortSessionBindings } from './sessionBindings'
import type { SessionBinding, SessionSortOptions } from './sessionBindings'

export const DEFAULT_SESSION_GROUP_NAME = 'New group'
export const MAX_SESSION_GROUP_NAME = 80

export interface SessionGroup {
  id: string
  title: string
  collapsed: boolean
  memberKeys: readonly string[]
}

export interface SessionGroupLayout {
  order: readonly string[]
  groups: readonly SessionGroup[]
}

export type SessionTreeNode = { key: string; kind: 'session'; binding: SessionBinding }
export type SessionGroupNode = { key: string; kind: 'group'; group: SessionGroup; members: SessionTreeNode[] }
export type SessionListEntry = SessionTreeNode | SessionGroupNode
export type SessionDropTarget = { key: string; position: 'before' | 'after' | 'group' | 'into' }

export function layoutSessionKeys({ order, groups }: SessionGroupLayout): string[] {
  const members = new Map(groups.map((group) => [group.id, group.memberKeys]))
  return order.flatMap((key) => members.get(key) ?? [key])
}

function reconcileLayout(keys: readonly string[], saved?: SessionGroupLayout): SessionGroupLayout {
  if (!saved) return { order: keys, groups: [] }
  const linked = new Set(keys)
  const grouped = new Set<string>()
  const replacements = new Map<string, string>()
  const groups = saved.groups.flatMap((group) => {
    const memberKeys = group.memberKeys.filter((key) => linked.has(key) && !grouped.has(key))
    if (!memberKeys.length) return []
    if (memberKeys.length === 1 && group.title === DEFAULT_SESSION_GROUP_NAME) {
      replacements.set(group.id, memberKeys[0])
      return []
    }
    memberKeys.forEach((key) => grouped.add(key))
    return [{ ...group, memberKeys }]
  })
  const groupIds = new Set(groups.map((group) => group.id))
  const order = new Set([...saved.order, ...keys].map((key) => replacements.get(key) ?? key)
    .filter((key) => groupIds.has(key) || linked.has(key) && !grouped.has(key)))
  return { order: [...order], groups }
}

export function buildSessionTree(bindings: readonly SessionBinding[], options: SessionSortOptions, saved?: SessionGroupLayout) {
  const byKey = new Map(bindings.map((binding) => [sessionBindingKey(binding), binding]))
  const manual = reconcileLayout(orderSessionBindings(bindings, options.orderedKeys).map(sessionBindingKey), saved)
  const sessionNode = (key: string): SessionTreeNode => ({ key, kind: 'session', binding: byKey.get(key)! })
  const groups = new Map(manual.groups.map((group) => [group.id, group]))
  const sorted = options.mode === 'manual' ? undefined
    : new Map(sortSessionBindings(bindings, options).map((binding, index) => [sessionBindingKey(binding), index]))
  const rank = (key: string) => sorted?.get(key) ?? 0
  const entries = manual.order.map((key): SessionListEntry => {
    const group = groups.get(key)
    if (!group) return sessionNode(key)
    const members = group.memberKeys.map(sessionNode)
    if (sorted) members.sort((a, b) => rank(a.key) - rank(b.key))
    return { key, kind: 'group', group, members }
  })
  if (sorted) {
    const label = (entry: SessionListEntry) => entry.kind === 'group' ? entry.group.title : sessionBindingTitle(entry.binding, options.titles)
    const firstRank = (entry: SessionListEntry) => rank(entry.kind === 'group' ? entry.members[0].key : entry.key)
    entries.sort((a, b) => {
      if (options.mode === 'title-asc' || options.mode === 'title-desc') {
        const difference = compareSessionNames(label(a), label(b))
        if (difference) return options.mode === 'title-asc' ? difference : -difference
      }
      // The best-ranked member supplies a group's time or machine rank.
      return firstRank(a) - firstRank(b)
    })
  }
  return { entries, manual }
}

export function treeSessionBindings(entries: readonly SessionListEntry[]): SessionBinding[] {
  return entries.flatMap((entry) => entry.kind === 'group' ? entry.members.map((member) => member.binding) : [entry.binding])
}

export function visibleSessionLayout(entries: readonly SessionListEntry[]): SessionGroupLayout {
  return {
    order: entries.map((entry) => entry.key),
    groups: entries.flatMap((entry) => entry.kind === 'group'
      ? [{ ...entry.group, memberKeys: entry.members.map((member) => member.key) }] : []),
  }
}

export function moveSessionNode(layout: SessionGroupLayout, source: string, target: SessionDropTarget, groupId?: string): SessionGroupLayout | undefined {
  const parentOf = (key: string) => layout.groups.find((group) => group.memberKeys.includes(key))
  const sourceParent = parentOf(source)
  const targetParent = parentOf(target.key)
  const sourceGroup = layout.groups.find((group) => group.id === source)
  const targetGroup = layout.groups.find((group) => group.id === target.key)
  if (source === target.key || !sourceParent && !layout.order.includes(source)
    || !targetParent && !layout.order.includes(target.key)) return undefined

  let order = layout.order.filter((key) => key !== source)
  let groups = layout.groups.map((group) => group === sourceParent
    ? { ...group, memberKeys: group.memberKeys.filter((key) => key !== source) } : group)

  if (target.position === 'group') {
    if (sourceGroup || targetGroup || targetParent || !groupId || layout.order.includes(groupId)) return undefined
    order[order.indexOf(target.key)] = groupId
    groups.push({ id: groupId, title: DEFAULT_SESSION_GROUP_NAME, collapsed: false, memberKeys: [target.key, source] })
  } else {
    const destination = target.position === 'into' ? targetGroup ?? targetParent : targetParent
    if (destination && sourceGroup || target.position === 'into' && !destination) return undefined
    const siblings = destination?.memberKeys ?? layout.order
    const append = target.position === 'into' && destination === targetGroup
    const index = append ? siblings.length : siblings.indexOf(target.key) + (target.position === 'before' ? 0 : 1)
    const reordered = siblings.includes(source) ? moveSessionKey(siblings, source, index)
      : [...siblings.slice(0, index), source, ...siblings.slice(index)]
    if (!reordered) return undefined
    if (destination) groups = groups.map((group) => group.id === destination.id ? { ...group, memberKeys: reordered } : group)
    else order = reordered
  }
  return reconcileLayout(layoutSessionKeys(layout), { order, groups })
}

export function forgetSessionInLayout(layout: SessionGroupLayout, key: string): SessionGroupLayout {
  const keys = layoutSessionKeys(layout)
  return keys.includes(key) ? reconcileLayout(keys.filter((member) => member !== key), layout) : layout
}

export function ungroupSessions(layout: SessionGroupLayout, id: string): SessionGroupLayout {
  const group = layout.groups.find((item) => item.id === id)
  return group ? {
    order: layout.order.flatMap((key) => key === id ? group.memberKeys : [key]),
    groups: layout.groups.filter((item) => item.id !== id),
  } : layout
}
