import { clampSplitRatio, defaultLayout } from './layout'
import type { SplitDirection, SplitOrientation } from './layout'
import { sessionBindingKey } from './chat/sessionBindings'
import type { SessionBinding } from './chat/sessionBindings'

export const MAX_PANE_GROUPS = 8
export const ROOT_PANE_GROUP_ID = 'pane-group-root'
export const TASK_PAGE_DRAG_MIME = 'application/x-taskcontinuum-task-page'

export interface PaneGroup {
  readonly kind: 'group'
  readonly id: string
  readonly openTaskIds: readonly string[]
  readonly activeTaskId: string | null
  readonly sessions: Readonly<Record<string, string | null>>
}

export interface PaneSplit {
  readonly kind: 'split'
  readonly id: string
  readonly orientation: SplitOrientation
  readonly ratio: number
  readonly first: PaneTreeNode
  readonly second: PaneTreeNode
}

export type PaneTreeNode = PaneGroup | PaneSplit

export interface PaneTreeState {
  readonly root: PaneTreeNode
  readonly activeGroupId: string
}

export interface SplitPaneOptions {
  readonly taskId?: string | null
  readonly sessionKey?: string | null
  readonly moveTaskPage?: boolean
  readonly newGroupId?: string
  readonly newSplitId?: string
}

export interface TaskPageDragPayload {
  readonly sourceGroupId: string
  readonly taskId: string
  readonly sessionKey?: string | null
  readonly copy?: boolean
}

export interface TaskPageDropTarget {
  readonly targetGroupId: string
  readonly zone: 'tab' | 'center' | SplitDirection
  readonly insertIndex?: number
}

function nextId(prefix: 'pane-group' | 'pane-split'): string {
  return `${prefix}:${crypto.randomUUID()}`
}

export function createInitialPaneTree(
  openTaskIds: readonly string[],
  activeTaskId: string | null,
  sessions: Readonly<Record<string, string | null>> = {},
  id: string = ROOT_PANE_GROUP_ID,
): PaneTreeState {
  const uniqueTasks = [...new Set(openTaskIds)]
  const resolvedActive = activeTaskId && uniqueTasks.includes(activeTaskId)
    ? activeTaskId
    : uniqueTasks[0] ?? (activeTaskId ?? null)
  const finalOpen = resolvedActive && !uniqueTasks.includes(resolvedActive)
    ? [...uniqueTasks, resolvedActive]
    : uniqueTasks
  return {
    root: {
      kind: 'group',
      id,
      openTaskIds: finalOpen,
      activeTaskId: finalOpen.length ? resolvedActive : null,
      sessions: { ...sessions },
    },
    activeGroupId: id,
  }
}

export function listPaneGroups(node: PaneTreeNode): PaneGroup[] {
  if (node.kind === 'group') return [node]
  return [...listPaneGroups(node.first), ...listPaneGroups(node.second)]
}

export function findPaneGroup(node: PaneTreeNode, groupId: string): PaneGroup | undefined {
  if (node.kind === 'group') return node.id === groupId ? node : undefined
  return findPaneGroup(node.first, groupId) ?? findPaneGroup(node.second, groupId)
}

export function activePaneGroup(state: PaneTreeState): PaneGroup {
  return findPaneGroup(state.root, state.activeGroupId) ?? listPaneGroups(state.root)[0]
}

function mapPaneGroup(node: PaneTreeNode, groupId: string, updater: (group: PaneGroup) => PaneGroup): PaneTreeNode {
  if (node.kind === 'group') return node.id === groupId ? updater(node) : node
  const first = mapPaneGroup(node.first, groupId, updater)
  const second = mapPaneGroup(node.second, groupId, updater)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

function replaceGroupWithNode(node: PaneTreeNode, groupId: string, replacement: (group: PaneGroup) => PaneTreeNode): PaneTreeNode {
  if (node.kind === 'group') return node.id === groupId ? replacement(node) : node
  const first = replaceGroupWithNode(node.first, groupId, replacement)
  const second = replaceGroupWithNode(node.second, groupId, replacement)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

function pruneGroupFromNode(node: PaneTreeNode, groupId: string): { node: PaneTreeNode | null; fallbackGroupId?: string } {
  if (node.kind === 'group') {
    return node.id === groupId ? { node: null } : { node }
  }
  const firstResult = pruneGroupFromNode(node.first, groupId)
  if (firstResult.node === null) {
    const firstFallback = listPaneGroups(node.second)[0]?.id
    return { node: node.second, fallbackGroupId: firstFallback }
  }
  const secondResult = pruneGroupFromNode(node.second, groupId)
  if (secondResult.node === null) {
    const secondFallback = listPaneGroups(node.first).at(-1)?.id
    return { node: node.first, fallbackGroupId: secondFallback }
  }
  if (firstResult.node === node.first && secondResult.node === node.second) return { node }
  return {
    node: { ...node, first: firstResult.node, second: secondResult.node },
    fallbackGroupId: firstResult.fallbackGroupId ?? secondResult.fallbackGroupId,
  }
}

export function focusPaneGroup(state: PaneTreeState, groupId: string): PaneTreeState {
  if (state.activeGroupId === groupId || !findPaneGroup(state.root, groupId)) return state
  return { ...state, activeGroupId: groupId }
}

export function openTaskPageInGroup(
  state: PaneTreeState,
  groupId: string,
  taskId: string,
  preferredSessionKey?: string | null,
): PaneTreeState {
  const target = findPaneGroup(state.root, groupId) ?? activePaneGroup(state)
  const root = mapPaneGroup(state.root, target.id, (group) => {
    const openTaskIds = group.openTaskIds.includes(taskId) ? group.openTaskIds : [...group.openTaskIds, taskId]
    const sessions = preferredSessionKey !== undefined
      ? { ...group.sessions, [taskId]: preferredSessionKey }
      : group.sessions
    if (openTaskIds === group.openTaskIds && group.activeTaskId === taskId && sessions === group.sessions) return group
    return { ...group, openTaskIds, activeTaskId: taskId, sessions }
  })
  return root === state.root && state.activeGroupId === target.id
    ? state
    : { root, activeGroupId: target.id }
}

export function selectSessionInGroup(
  state: PaneTreeState,
  groupId: string,
  taskId: string,
  sessionKey: string | null,
  preserveOtherDefaultKey?: string,
): PaneTreeState {
  const target = findPaneGroup(state.root, groupId) ?? activePaneGroup(state)
  let workingRoot = state.root
  if (preserveOtherDefaultKey !== undefined) {
    for (const other of listPaneGroups(workingRoot)) {
      if (other.id !== target.id && other.openTaskIds.includes(taskId) && !Object.hasOwn(other.sessions, taskId)) {
        workingRoot = mapPaneGroup(workingRoot, other.id, (current) => ({
          ...current,
          sessions: { ...current.sessions, [taskId]: preserveOtherDefaultKey },
        }))
      }
    }
  }
  const root = mapPaneGroup(workingRoot, target.id, (group) => {
    const openTaskIds = group.openTaskIds.includes(taskId) ? group.openTaskIds : [...group.openTaskIds, taskId]
    if (openTaskIds === group.openTaskIds && group.activeTaskId === taskId && group.sessions[taskId] === sessionKey) {
      return group
    }
    return {
      ...group,
      openTaskIds,
      activeTaskId: taskId,
      sessions: { ...group.sessions, [taskId]: sessionKey },
    }
  })
  return root === state.root && state.activeGroupId === target.id
    ? state
    : { root, activeGroupId: target.id }
}

export function rememberDefaultSessionInGroup(
  state: PaneTreeState,
  groupId: string,
  taskId: string,
  sessionKey: string,
): PaneTreeState {
  const target = findPaneGroup(state.root, groupId)
  if (!target || Object.hasOwn(target.sessions, taskId)) return state
  const root = mapPaneGroup(state.root, groupId, (group) => ({
    ...group,
    sessions: { ...group.sessions, [taskId]: sessionKey },
  }))
  return root === state.root ? state : { ...state, root }
}

export function clearDetachedSessionFromTree(state: PaneTreeState, taskId: string, sessionKey: string): PaneTreeState {
  const groups = listPaneGroups(state.root)
  let root = state.root
  for (const group of groups) {
    if (group.sessions[taskId] === sessionKey) {
      root = mapPaneGroup(root, group.id, (current) => {
        const nextSessions = { ...current.sessions }
        delete nextSessions[taskId]
        return { ...current, sessions: nextSessions }
      })
    }
  }
  return root === state.root ? state : { ...state, root }
}

export function removePaneGroup(state: PaneTreeState, groupId: string): PaneTreeState {
  const groups = listPaneGroups(state.root)
  if (groups.length <= 1) {
    const sole = groups[0]
    if (!sole || sole.id !== groupId || sole.openTaskIds.length === 0) return state
    return {
      root: { ...sole, openTaskIds: [], activeTaskId: null },
      activeGroupId: sole.id,
    }
  }
  const pruned = pruneGroupFromNode(state.root, groupId)
  if (!pruned.node || pruned.node === state.root) return state
  const survivingIds = new Set(listPaneGroups(pruned.node).map((item) => item.id))
  const nextActive = state.activeGroupId !== groupId && survivingIds.has(state.activeGroupId)
    ? state.activeGroupId
    : pruned.fallbackGroupId ?? listPaneGroups(pruned.node)[0].id
  return { root: pruned.node, activeGroupId: nextActive }
}

export function closeTaskPageInGroup(state: PaneTreeState, groupId: string, taskId: string): PaneTreeState {
  const group = findPaneGroup(state.root, groupId)
  if (!group || !group.openTaskIds.includes(taskId)) return state
  const remaining = group.openTaskIds.filter((id) => id !== taskId)
  if (remaining.length === 0 && listPaneGroups(state.root).length > 1) {
    return removePaneGroup(state, groupId)
  }
  const currentIndex = group.openTaskIds.indexOf(taskId)
  const nextActiveTask = group.activeTaskId === taskId
    ? remaining[Math.min(currentIndex, remaining.length - 1)] ?? null
    : group.activeTaskId
  const root = mapPaneGroup(state.root, groupId, (current) => ({
    ...current,
    openTaskIds: remaining,
    activeTaskId: nextActiveTask,
  }))
  return { root, activeGroupId: state.activeGroupId }
}

export function splitPaneGroup(
  state: PaneTreeState,
  groupId: string,
  direction: SplitDirection,
  options: SplitPaneOptions = {},
): PaneTreeState {
  const allGroups = listPaneGroups(state.root)
  if (allGroups.length >= MAX_PANE_GROUPS) return state
  const source = findPaneGroup(state.root, groupId) ?? activePaneGroup(state)
  const clonedTaskId = options.taskId !== undefined ? options.taskId : source.activeTaskId
  const resolvedSessionKey = options.sessionKey !== undefined
    ? options.sessionKey
    : clonedTaskId && Object.hasOwn(source.sessions, clonedTaskId)
      ? source.sessions[clonedTaskId]
      : undefined

  const shouldMove = Boolean(options.moveTaskPage && clonedTaskId && source.openTaskIds.includes(clonedTaskId) && source.openTaskIds.length > 1)
  const pinnedSource: PaneGroup = !shouldMove && clonedTaskId && clonedTaskId === source.activeTaskId && resolvedSessionKey !== undefined && !Object.hasOwn(source.sessions, clonedTaskId)
    ? { ...source, sessions: { ...source.sessions, [clonedTaskId]: resolvedSessionKey } }
    : source
  const updatedSource: PaneGroup = shouldMove && clonedTaskId ? (() => {
    const remaining = source.openTaskIds.filter((id) => id !== clonedTaskId)
    const idx = source.openTaskIds.indexOf(clonedTaskId)
    return {
      ...source,
      openTaskIds: remaining,
      activeTaskId: source.activeTaskId === clonedTaskId ? remaining[Math.min(idx, remaining.length - 1)] ?? null : source.activeTaskId,
    }
  })() : pinnedSource

  const newGroupId = options.newGroupId ?? nextId('pane-group')
  const newSplitId = options.newSplitId ?? nextId('pane-split')
  const clonedGroup: PaneGroup = {
    kind: 'group',
    id: newGroupId,
    openTaskIds: clonedTaskId ? [clonedTaskId] : [],
    activeTaskId: clonedTaskId ?? null,
    sessions: clonedTaskId && resolvedSessionKey !== undefined ? { [clonedTaskId]: resolvedSessionKey } : {},
  }

  const orientation: SplitOrientation = direction === 'up' || direction === 'down' ? 'vertical' : 'horizontal'
  const newFirst = direction === 'left' || direction === 'up'

  const root = replaceGroupWithNode(state.root, source.id, () => ({
    kind: 'split',
    id: newSplitId,
    orientation,
    ratio: defaultLayout.splitRatio,
    first: newFirst ? clonedGroup : updatedSource,
    second: newFirst ? updatedSource : clonedGroup,
  }))

  return { root, activeGroupId: newGroupId }
}

export function toggleParentSplitOrientation(state: PaneTreeState, groupId: string): PaneTreeState {
  function toggle(node: PaneTreeNode): { node: PaneTreeNode; toggled: boolean } {
    if (node.kind === 'group') return { node, toggled: false }
    const directChild = (node.first.kind === 'group' && node.first.id === groupId)
      || (node.second.kind === 'group' && node.second.id === groupId)
    if (directChild) {
      return {
        node: { ...node, orientation: node.orientation === 'vertical' ? 'horizontal' : 'vertical' },
        toggled: true,
      }
    }
    const left = toggle(node.first)
    if (left.toggled) return { node: { ...node, first: left.node }, toggled: true }
    const right = toggle(node.second)
    if (right.toggled) return { node: { ...node, second: right.node }, toggled: true }
    return { node, toggled: false }
  }
  const result = toggle(state.root)
  return result.toggled ? { ...state, root: result.node } : state
}

export function swapParentSplitChildren(state: PaneTreeState, groupId: string): PaneTreeState {
  function swap(node: PaneTreeNode): { node: PaneTreeNode; swapped: boolean } {
    if (node.kind === 'group') return { node, swapped: false }
    const directChild = (node.first.kind === 'group' && node.first.id === groupId)
      || (node.second.kind === 'group' && node.second.id === groupId)
    if (directChild) {
      return {
        node: { ...node, first: node.second, second: node.first, ratio: clampSplitRatio(1 - node.ratio) },
        swapped: true,
      }
    }
    const left = swap(node.first)
    if (left.swapped) return { node: { ...node, first: left.node }, swapped: true }
    const right = swap(node.second)
    if (right.swapped) return { node: { ...node, second: right.node }, swapped: true }
    return { node, swapped: false }
  }
  const result = swap(state.root)
  return result.swapped ? { ...state, root: result.node } : state
}

export function resizePaneSplit(state: PaneTreeState, splitId: string, ratio: number): PaneTreeState {
  const clamped = clampSplitRatio(ratio)
  function update(node: PaneTreeNode): PaneTreeNode {
    if (node.kind === 'group') return node
    if (node.id === splitId) return node.ratio === clamped ? node : { ...node, ratio: clamped }
    const first = update(node.first)
    const second = update(node.second)
    return first === node.first && second === node.second ? node : { ...node, first, second }
  }
  const root = update(state.root)
  return root === state.root ? state : { ...state, root }
}

export function moveOrDropTaskPage(
  state: PaneTreeState,
  payload: TaskPageDragPayload,
  target: TaskPageDropTarget,
  ids?: { newGroupId?: string; newSplitId?: string },
): PaneTreeState {
  const sourceGroup = findPaneGroup(state.root, payload.sourceGroupId)
  const targetGroup = findPaneGroup(state.root, target.targetGroupId)
  if (!sourceGroup || !targetGroup) return state
  const carriedSession = payload.sessionKey !== undefined
    ? payload.sessionKey
    : Object.hasOwn(sourceGroup.sessions, payload.taskId)
      ? sourceGroup.sessions[payload.taskId]
      : undefined

  // Case 1: Reorder or drop inside the SAME group.
  if (sourceGroup.id === targetGroup.id) {
    if (target.zone === 'center') {
      return openTaskPageInGroup(state, targetGroup.id, payload.taskId, carriedSession)
    }
    if (target.zone === 'tab') {
      const fromIndex = sourceGroup.openTaskIds.indexOf(payload.taskId)
      if (fromIndex < 0) return openTaskPageInGroup(state, targetGroup.id, payload.taskId, carriedSession)
      const insertAt = Math.max(0, Math.min(sourceGroup.openTaskIds.length, target.insertIndex ?? sourceGroup.openTaskIds.length))
      if (insertAt === fromIndex || insertAt === fromIndex + 1) {
        return openTaskPageInGroup(state, targetGroup.id, payload.taskId)
      }
      const without = sourceGroup.openTaskIds.filter((id) => id !== payload.taskId)
      const adjusted = insertAt > fromIndex ? insertAt - 1 : insertAt
      without.splice(adjusted, 0, payload.taskId)
      const root = mapPaneGroup(state.root, targetGroup.id, (current) => ({
        ...current,
        openTaskIds: without,
        activeTaskId: payload.taskId,
      }))
      return { root, activeGroupId: targetGroup.id }
    }
    // Directional edge drop on the same group -> split (moves if >1 tabs and !copy, else clones!).
    return splitPaneGroup(state, targetGroup.id, target.zone, {
      taskId: payload.taskId,
      sessionKey: carriedSession,
      moveTaskPage: !payload.copy && sourceGroup.openTaskIds.length > 1,
      ...ids,
    })
  }

  // Case 2: Drop onto ANOTHER group (either tab/center to merge into targetGroup, or edge to split targetGroup).
  if (target.zone === 'tab' || target.zone === 'center') {
    let nextState = state
    // Add/move into targetGroup first so targetGroup always survives even if sourceGroup collapses.
    const rootWithTarget = mapPaneGroup(nextState.root, targetGroup.id, (current) => {
      const without = current.openTaskIds.filter((id) => id !== payload.taskId)
      const insertAt = target.zone === 'tab' && target.insertIndex !== undefined
        ? Math.max(0, Math.min(without.length, target.insertIndex))
        : without.length
      without.splice(insertAt, 0, payload.taskId)
      const nextSessions = carriedSession !== undefined && !Object.hasOwn(current.sessions, payload.taskId)
        ? { ...current.sessions, [payload.taskId]: carriedSession }
        : current.sessions
      return {
        ...current,
        openTaskIds: without,
        activeTaskId: payload.taskId,
        sessions: nextSessions,
      }
    })
    nextState = { root: rootWithTarget, activeGroupId: targetGroup.id }
    if (!payload.copy) {
      nextState = closeTaskPageInGroup(nextState, sourceGroup.id, payload.taskId)
      nextState = { ...nextState, activeGroupId: targetGroup.id }
    }
    return nextState
  }

  // Directional edge drop onto ANOTHER group -> split targetGroup, then remove from sourceGroup unless copy.
  if (listPaneGroups(state.root).length >= MAX_PANE_GROUPS && (payload.copy || sourceGroup.openTaskIds.length > 1)) {
    return state
  }
  // If we're at MAX_PANE_GROUPS and sourceGroup only has 1 tab, remove sourceGroup first to free 1 slot!
  let working = state
  const willRemoveSource = !payload.copy && sourceGroup.openTaskIds.includes(payload.taskId)
  if (willRemoveSource && listPaneGroups(working.root).length >= MAX_PANE_GROUPS && sourceGroup.openTaskIds.length === 1) {
    working = closeTaskPageInGroup(working, sourceGroup.id, payload.taskId)
    return splitPaneGroup(working, targetGroup.id, target.zone, {
      taskId: payload.taskId,
      sessionKey: carriedSession,
      ...ids,
    })
  }
  const afterSplit = splitPaneGroup(working, targetGroup.id, target.zone, {
    taskId: payload.taskId,
    sessionKey: carriedSession,
    ...ids,
  })
  if (afterSplit === working) return state
  const createdGroupId = afterSplit.activeGroupId
  if (!willRemoveSource) return afterSplit
  const afterSourceClose = closeTaskPageInGroup(afterSplit, sourceGroup.id, payload.taskId)
  return { ...afterSourceClose, activeGroupId: createdGroupId }
}

export function resolveGroupActiveBinding(
  group: PaneGroup,
  taskId: string | null,
  orderedTaskBindings: readonly SessionBinding[],
  rememberedSessions?: Readonly<Record<string, string | null>>,
): {
  readonly sessionKey: string | undefined
  readonly binding: SessionBinding | undefined
  readonly missingSelectedSession: boolean
} {
  if (!taskId) return { sessionKey: undefined, binding: undefined, missingSelectedSession: false }
  const hasGroupExplicit = Object.hasOwn(group.sessions, taskId)
  const hasRemembered = !hasGroupExplicit && Boolean(rememberedSessions && Object.hasOwn(rememberedSessions, taskId))
  const explicit = hasGroupExplicit
    ? group.sessions[taskId]
    : hasRemembered
      ? rememberedSessions![taskId]
      : undefined
  const sessionKey = hasGroupExplicit || hasRemembered
    ? explicit ?? undefined
    : orderedTaskBindings[0]
      ? sessionBindingKey(orderedTaskBindings[0])
      : undefined
  const binding = sessionKey
    ? orderedTaskBindings.find((entry) => sessionBindingKey(entry) === sessionKey)
    : undefined
  const missingSelectedSession = Boolean((hasGroupExplicit || hasRemembered) && explicit && !binding && orderedTaskBindings.length === 0)
  return { sessionKey, binding, missingSelectedSession }
}

export function findParentSplit(root: PaneTreeNode, groupId: string): PaneSplit | undefined {
  if (root.kind === 'group') return undefined
  if ((root.first.kind === 'group' && root.first.id === groupId)
    || (root.second.kind === 'group' && root.second.id === groupId)) {
    return root
  }
  return findParentSplit(root.first, groupId) ?? findParentSplit(root.second, groupId)
}

export function cyclePaneGroupFocus(state: PaneTreeState, step: 1 | -1 = 1): PaneTreeState {
  const groups = listPaneGroups(state.root)
  if (groups.length <= 1) return state
  const index = groups.findIndex((group) => group.id === state.activeGroupId)
  const next = groups[(index < 0 ? 0 : index + step + groups.length) % groups.length]
  return next.id === state.activeGroupId ? state : { ...state, activeGroupId: next.id }
}

export function reconcilePaneTreeWithTasks(
  state: PaneTreeState,
  validTaskIds: ReadonlySet<string>,
  fallbackTaskId: string | null,
): PaneTreeState {
  const groups = listPaneGroups(state.root)
  let next = state
  for (const group of groups) {
    if (group.openTaskIds.length === 0) {
      if (groups.length > 1) {
        next = removePaneGroup(next, group.id)
      } else if (fallbackTaskId && validTaskIds.has(fallbackTaskId)) {
        next = {
          ...next,
          root: mapPaneGroup(next.root, group.id, (current) => ({
            ...current,
            openTaskIds: [fallbackTaskId],
            activeTaskId: fallbackTaskId,
          })),
        }
      }
      continue
    }
    const validOpen = group.openTaskIds.filter((id) => validTaskIds.has(id))
    if (validOpen.length === group.openTaskIds.length) continue
    if (validOpen.length === 0 && listPaneGroups(next.root).length > 1) {
      next = removePaneGroup(next, group.id)
      continue
    }
    const replacementOpen = validOpen.length ? validOpen : fallbackTaskId ? [fallbackTaskId] : []
    const replacementActive = group.activeTaskId && replacementOpen.includes(group.activeTaskId)
      ? group.activeTaskId
      : replacementOpen[0] ?? null
    next = {
      ...next,
      root: mapPaneGroup(next.root, group.id, (current) => ({
        ...current,
        openTaskIds: replacementOpen,
        activeTaskId: replacementActive,
      })),
    }
  }
  if (!findPaneGroup(next.root, next.activeGroupId)) {
    next = { ...next, activeGroupId: listPaneGroups(next.root)[0].id }
  }
  return next
}
