import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { persistedPaneTreeSchema } from '../../shared/paneTreeSchema'
import type { PersistedPaneTreeNode, PersistedPaneTreeState } from '../../shared/paneTreeSchema'
import { DEFAULT_SESSION_SORT_MODE, sessionSortModes } from './sessionBindings'
import type { SessionSortMode } from './sessionBindings'
import { forgetSessionInLayout, layoutSessionKeys, MAX_SESSION_GROUP_NAME } from './sessionGroups'
import type { SessionGroupLayout } from './sessionGroups'

const taskIdSchema = z.string().regex(/^T-[0-9]{4,}$/).max(128)
const sessionLimit = 1000
const sessionKeySchema = z.string().startsWith('ahp:').max(2048)
const sessionSortSchema = z.enum(sessionSortModes)
const sessionsSchema = z.unknown().refine((value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length <= sessionLimit && Object.keys(value).every((key) => taskIdSchema.safeParse(key).success), 'Invalid remembered task sessions.')
  .pipe(z.record(taskIdSchema, sessionKeySchema.nullable()))
const sessionOrderListSchema = z.array(sessionKeySchema).min(1).max(sessionLimit)
  .refine((keys) => new Set(keys).size === keys.length, 'Duplicate ordered sessions.')
const sessionOrdersSchema = z.unknown().refine((value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length <= sessionLimit && Object.keys(value).every((key) => taskIdSchema.safeParse(key).success), 'Invalid remembered session orders.')
  .pipe(z.record(taskIdSchema, sessionOrderListSchema))
const sessionSortsSchema = z.unknown().refine((value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length <= sessionLimit && Object.keys(value).every((key) => taskIdSchema.safeParse(key).success), 'Invalid remembered session sort modes.')
  .pipe(z.record(taskIdSchema, sessionSortSchema))
const groupIdSchema = z.templateLiteral(['grp:', z.uuid()])
const sessionGroupLayoutSchema = z.object({
  order: z.array(z.union([sessionKeySchema, groupIdSchema])).min(1).max(sessionLimit),
  groups: z.array(z.object({
    id: groupIdSchema, title: z.string().trim().min(1).max(MAX_SESSION_GROUP_NAME),
    collapsed: z.boolean(), memberKeys: sessionOrderListSchema,
  }).strict()).min(1).max(sessionLimit),
}).strict().refine((layout) => {
  const keys = new Set(layout.order)
  const ids = new Set<string>(layout.groups.map((group) => group.id))
  const sessionKeys = layoutSessionKeys(layout)
  return keys.size === layout.order.length && ids.size === layout.groups.length
    && layout.groups.every((group) => keys.has(group.id))
    && layout.order.every((key) => !key.startsWith('grp:') || ids.has(key))
    && sessionKeys.length <= sessionLimit && new Set(sessionKeys).size === sessionKeys.length
}, 'Invalid session group membership or order.')
const sessionGroupsSchema = z.unknown().refine((value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length <= sessionLimit && Object.keys(value).every((key) => taskIdSchema.safeParse(key).success), 'Invalid remembered session groups.')
  .pipe(z.record(taskIdSchema, sessionGroupLayoutSchema))
const legacySelectionSchema = z.object({
  version: z.literal(1),
  taskId: taskIdSchema.nullable(),
  sessions: sessionsSchema,
}).strict()
const selectionSchema = legacySelectionSchema.extend({
  version: z.literal(2),
  openTaskIds: z.array(taskIdSchema).refine((ids) => new Set(ids).size === ids.length, 'Duplicate open tasks.'),
  sessionOrders: sessionOrdersSchema.optional(),
  sessionSort: sessionSortSchema.optional(),
  sessionSorts: sessionSortsSchema.optional(),
  sessionGroups: sessionGroupsSchema.optional(),
  paneTree: persistedPaneTreeSchema.optional(),
}).refine((selection) => selection.taskId === null ? selection.openTaskIds.length === 0 : selection.openTaskIds.includes(selection.taskId), 'The active task must be open.')
type Selection = z.infer<typeof selectionSchema>
type SelectionInput = Omit<Selection, 'sessionGroups' | 'paneTree'> & {
  sessionGroups?: Record<string, SessionGroupLayout>
  paneTree?: PersistedPaneTreeState
}
type State = { workspaceId?: string; selection?: Selection; persisted?: boolean; error?: string }
const emptySessions: Readonly<Record<string, string | null>> = Object.freeze({})
const emptySessionOrders: Readonly<Record<string, readonly string[]>> = Object.freeze({})
const emptySessionSorts: Readonly<Record<string, SessionSortMode>> = Object.freeze({})
const emptySessionGroups: Readonly<Record<string, SessionGroupLayout>> = Object.freeze({})

function storageKey(workspaceId: string, version = 2): string { return `taskcontinuum:workbench-selection:v${version}:${workspaceId}` }

function openTasks(selection: Selection | undefined, taskId: string | null, shown?: readonly string[]): string[] {
  if (taskId === null) return []
  return [...new Set([...shown ?? selection?.openTaskIds ?? [], taskId])]
}

function rememberSession(selection: Selection | undefined, taskId: string, key: string | null): Selection['sessions'] {
  const entries = Object.entries(selection?.sessions ?? {}).filter(([id]) => id !== taskId)
  entries.push([taskId, key])
  return Object.fromEntries(entries.slice(-sessionLimit))
}

function rememberSessionOrder(selection: Selection | undefined, taskId: string, orderedKeys: readonly string[]): NonNullable<Selection['sessionOrders']> {
  const entries = Object.entries(selection?.sessionOrders ?? {}).filter(([id]) => id !== taskId)
  if (orderedKeys.length) entries.push([taskId, [...orderedKeys]])
  return Object.fromEntries(entries.slice(-sessionLimit))
}

function rememberSessionLayout(selection: Selection | undefined, taskId: string, layout: SessionGroupLayout): Pick<SelectionInput, 'sessionOrders' | 'sessionGroups'> {
  const groupEntries: [string, SessionGroupLayout][] = Object.entries(selection?.sessionGroups ?? {}).filter(([id]) => id !== taskId)
  if (layout.groups.length) groupEntries.push([taskId, layout])
  const orders = rememberSessionOrder(selection, taskId, layoutSessionKeys(layout))
  return {
    sessionOrders: Object.keys(orders).length ? orders : undefined,
    sessionGroups: groupEntries.length ? Object.fromEntries(groupEntries.slice(-sessionLimit)) : undefined,
  }
}

function rememberTaskSort(selection: Selection | undefined, taskId: string, mode: SessionSortMode | null, defaultSort: SessionSortMode): NonNullable<Selection['sessionSorts']> {
  const entries = Object.entries(selection?.sessionSorts ?? {}).filter(([id, item]) => id !== taskId && item !== defaultSort)
  if (mode !== null && mode !== defaultSort) entries.push([taskId, mode])
  return Object.fromEntries(entries.slice(-sessionLimit))
}

function preservedSessionLayout(selection: Selection | undefined): Pick<Selection, 'sessionOrders' | 'sessionSort' | 'sessionSorts' | 'sessionGroups' | 'paneTree'> {
  return {
    ...(selection?.sessionOrders && Object.keys(selection.sessionOrders).length ? { sessionOrders: selection.sessionOrders } : {}),
    ...(selection?.sessionSort && selection.sessionSort !== DEFAULT_SESSION_SORT_MODE ? { sessionSort: selection.sessionSort } : {}),
    ...(selection?.sessionSorts && Object.keys(selection.sessionSorts).length ? { sessionSorts: selection.sessionSorts } : {}),
    ...(selection?.sessionGroups && Object.keys(selection.sessionGroups).length ? { sessionGroups: selection.sessionGroups } : {}),
    ...(selection?.paneTree ? { paneTree: selection.paneTree } : {}),
  }
}

function clearSessionFromPersistedTree(tree: PersistedPaneTreeState | undefined, taskId: string, expectedKey: string): PersistedPaneTreeState | undefined {
  if (!tree) return undefined
  let changed = false
  function walk(node: PersistedPaneTreeNode): PersistedPaneTreeNode {
    if (node.kind === 'group') {
      if (node.sessions[taskId] !== expectedKey) return node
      changed = true
      const nextSessions = { ...node.sessions }
      delete nextSessions[taskId]
      return { ...node, sessions: nextSessions }
    }
    const first = walk(node.first)
    const second = walk(node.second)
    return first === node.first && second === node.second ? node : { ...node, first, second }
  }
  const root = walk(tree.root)
  return changed ? { ...tree, root } : tree
}

function revealSession(selection: Selection | undefined, taskId: string, key: string): Selection['sessionGroups'] {
  const groups = selection?.sessionGroups
  const layout = groups?.[taskId]
  const parent = layout?.groups.find((group) => group.collapsed && group.memberKeys.includes(key))
  if (!parent || !layout) return groups
  return { ...groups, [taskId]: { ...layout, groups: layout.groups.map((group) => group === parent ? { ...group, collapsed: false } : group) } }
}

function read(workspaceId: string | undefined): State {
  if (!workspaceId) return {}
  let stored: string | null
  let legacy = false
  try {
    stored = localStorage.getItem(storageKey(workspaceId))
    if (stored === null) { stored = localStorage.getItem(storageKey(workspaceId, 1)); legacy = stored !== null }
  }
  catch { return { workspaceId, error: 'The last opened task and session could not be read on this device. Your current selection still works.' } }
  if (stored === null) return { workspaceId }
  try {
    if (stored.length > 2 * 1024 * 1024) throw new Error('Oversized selection preference.')
    const value: unknown = JSON.parse(stored)
    if (legacy) {
      const selection = legacySelectionSchema.parse(value)
      return { workspaceId, selection: { ...selection, version: 2, openTaskIds: selection.taskId ? [selection.taskId] : [] }, persisted: false }
    }
    const parsed = selectionSchema.safeParse(value)
    if (parsed.success) return { workspaceId, selection: parsed.data, persisted: true }
    if (value && typeof value === 'object' && 'paneTree' in value) {
      const rest: Record<string, unknown> = { ...value }
      delete rest.paneTree
      const withoutPaneTree = selectionSchema.safeParse(rest)
      if (withoutPaneTree.success) return { workspaceId, selection: withoutPaneTree.data, error: 'Saved split pane layout is invalid. Your task and conversation selections are unchanged.' }
    }
    if (value && typeof value === 'object' && 'sessionGroups' in value) {
      const rest: Record<string, unknown> = { ...value }
      delete rest.sessionGroups
      delete rest.paneTree
      const withoutGroups = selectionSchema.safeParse(rest)
      if (withoutGroups.success) return { workspaceId, selection: withoutGroups.data, error: 'Saved session groups are invalid. Your task and conversation selections are unchanged.' }
    }
    throw parsed.error
  } catch {
    return { workspaceId, error: 'Saved task and session selections are invalid. Select a task or session to replace them; session access is unchanged.' }
  }
}

export function useWorkbenchSelection(workspaceId: string | undefined) {
  const [state, setState] = useState(() => read(workspaceId))
  const current = useRef(state)
  useEffect(() => {
    if (current.current.workspaceId === workspaceId) return
    const next = read(workspaceId)
    current.current = next
    setState(next)
  }, [workspaceId])

  const update = useCallback((change: (selection: Selection | undefined) => SelectionInput | undefined, implicit = false) => {
    if (!workspaceId) return
    const before = current.current.workspaceId === workspaceId ? current.current : read(workspaceId)
    if (implicit && before.error) return
    const candidate = change(before.selection)
    if (!candidate || candidate === before.selection) return
    const parsed = selectionSchema.safeParse(candidate)
    if (!parsed.success) {
      const next = { ...before, error: 'The task and session selection was not saved because its identifiers are invalid.' }
      current.current = next
      setState(next)
      return
    }
    const encoded = JSON.stringify(parsed.data)
    if (before.persisted && !before.error && encoded === JSON.stringify(before.selection)) return
    let error: string | undefined
    try {
      if (encoded.length > 2 * 1024 * 1024) throw new Error('Oversized selection preference.')
      localStorage.setItem(storageKey(workspaceId), encoded)
    }
    catch { error = 'The current task and session could not be saved on this device. They will be remembered only until this workspace closes.' }
    const next: State = { workspaceId, selection: parsed.data, persisted: !error, error }
    current.current = next
    setState(next)
  }, [workspaceId])

  const selectTask = useCallback((taskId: string | null, shown?: readonly string[]) => {
    update((selection) => ({ version: 2, taskId, openTaskIds: openTasks(selection, taskId, shown), sessions: selection?.sessions ?? {}, ...preservedSessionLayout(selection) }))
  }, [update])

  const closeTask = useCallback((taskId: string, shown: readonly string[], activeTaskId: string | null) => {
    const remaining = shown.filter((id) => id !== taskId)
    update((selection) => ({
      version: 2, taskId: activeTaskId === taskId ? remaining.at(-1) ?? null : activeTaskId,
      openTaskIds: remaining, sessions: selection?.sessions ?? {}, ...preservedSessionLayout(selection),
    }))
  }, [update])

  const selectSession = useCallback((taskId: string, key: string, shown?: readonly string[], nextPaneTree?: PersistedPaneTreeState | null) => {
    update((selection) => {
      const base = preservedSessionLayout(selection)
      const resolvedTree = nextPaneTree === undefined
        ? base.paneTree
        : nextPaneTree && nextPaneTree.root.kind === 'split'
          ? nextPaneTree
          : undefined
      const { paneTree: _ignored, ...restPreserved } = base
      void _ignored
      return {
        version: 2,
        taskId,
        openTaskIds: openTasks(selection, taskId, shown),
        sessions: rememberSession(selection, taskId, key),
        ...restPreserved,
        ...(resolvedTree ? { paneTree: resolvedTree } : {}),
        sessionGroups: revealSession(selection, taskId, key),
      }
    })
  }, [update])

  const syncPaneSelection = useCallback((
    taskId: string | null,
    openIds: readonly string[],
    sessionsPatch?: Readonly<Record<string, string | null>>,
    nextPaneTree?: PersistedPaneTreeState | null,
  ) => {
    update((selection) => {
      const nextOpen = taskId === null ? [] : [...new Set([...openIds, taskId])]
      const baseSessions = selection?.sessions ?? {}
      const mergedSessions = sessionsPatch
        ? Object.fromEntries(Object.entries({ ...baseSessions, ...sessionsPatch }).slice(-sessionLimit))
        : baseSessions
      const base = preservedSessionLayout(selection)
      const resolvedTree = nextPaneTree === undefined
        ? base.paneTree
        : nextPaneTree && nextPaneTree.root.kind === 'split'
          ? nextPaneTree
          : undefined
      const { paneTree: _ignored, ...restPreserved } = base
      void _ignored
      return {
        version: 2,
        taskId,
        openTaskIds: nextOpen,
        sessions: mergedSessions,
        ...restPreserved,
        ...(resolvedTree ? { paneTree: resolvedTree } : {}),
      }
    })
  }, [update])

  const revealSessionGroup = useCallback((taskId: string, key: string) => {
    update((selection) => {
      const sessionGroups = revealSession(selection, taskId, key)
      return selection && sessionGroups !== selection.sessionGroups ? { ...selection, sessionGroups } : selection
    })
  }, [update])

  const rememberDefaultSession = useCallback((taskId: string, key: string) => {
    update((selection) => selection && Object.hasOwn(selection.sessions, taskId) ? selection : {
      version: 2, taskId: selection ? selection.taskId : taskId, openTaskIds: selection?.openTaskIds ?? [taskId], sessions: rememberSession(selection, taskId, key), ...preservedSessionLayout(selection),
    }, true)
  }, [update])

  const clearSession = useCallback((taskId: string, expectedKey: string, clearSelection = true) => {
    update((selection) => {
      const saved = selection?.sessionGroups?.[taskId]
      const layout = saved && forgetSessionInLayout(saved, expectedKey)
      const nextTree = clearSessionFromPersistedTree(selection?.paneTree, taskId, expectedKey)
      const cleared = clearSelection && (!selection || !Object.hasOwn(selection.sessions, taskId) || selection.sessions[taskId] === expectedKey)
      if (!cleared && layout === saved && nextTree === selection?.paneTree) return selection
      const { paneTree: _ignored, ...restPreserved } = preservedSessionLayout(selection)
      void _ignored
      return {
        version: 2, taskId: selection ? selection.taskId : taskId, openTaskIds: selection?.openTaskIds ?? [taskId],
        sessions: cleared ? rememberSession(selection, taskId, null) : selection?.sessions ?? {},
        ...restPreserved,
        ...(nextTree ? { paneTree: nextTree } : {}),
        ...(layout && layout !== saved ? rememberSessionLayout(selection, taskId, layout) : {}),
      }
    })
  }, [update])

  const setSessionLayout = useCallback((taskId: string, layout: SessionGroupLayout, makeManual: boolean, activeTaskId?: string | null, shown?: readonly string[]) => {
    update((selection) => {
      const defaultSort = selection?.sessionSort ?? DEFAULT_SESSION_SORT_MODE
      const resolvedTaskId = activeTaskId !== undefined ? activeTaskId : selection ? selection.taskId : taskId
      const nextSorts = makeManual ? rememberTaskSort(selection, taskId, 'manual', defaultSort) : selection?.sessionSorts
      return {
        version: 2,
        taskId: resolvedTaskId,
        openTaskIds: openTasks(selection, resolvedTaskId, shown),
        sessions: selection?.sessions ?? {},
        ...rememberSessionLayout(selection, taskId, layout),
        ...(selection?.paneTree ? { paneTree: selection.paneTree } : {}),
        ...(defaultSort !== DEFAULT_SESSION_SORT_MODE ? { sessionSort: defaultSort } : {}),
        ...(nextSorts && Object.keys(nextSorts).length ? { sessionSorts: nextSorts } : {}),
      }
    })
  }, [update])

  const setSessionSort = useCallback((taskId: string, mode: SessionSortMode, activeTaskId?: string | null, shown?: readonly string[]) => {
    update((selection) => {
      const hasSavedManualLayout = Boolean(selection?.sessionGroups?.[taskId] || selection?.sessionOrders?.[taskId])
      const currentDefault = selection?.sessionSort ?? DEFAULT_SESSION_SORT_MODE
      const currentTaskSort = selection?.sessionSorts?.[taskId] ?? (selection?.sessionSort ?? (hasSavedManualLayout ? 'manual' : DEFAULT_SESSION_SORT_MODE))
      if (selection && currentDefault === mode && currentTaskSort === mode) return selection
      const resolvedTaskId = activeTaskId !== undefined ? activeTaskId : selection ? selection.taskId : taskId
      const baseSorts = rememberTaskSort(selection, taskId, null, mode)
      const nextSorts = hasSavedManualLayout && mode === DEFAULT_SESSION_SORT_MODE
        ? { ...baseSorts, [taskId]: mode }
        : baseSorts
      return {
        version: 2,
        taskId: resolvedTaskId,
        openTaskIds: openTasks(selection, resolvedTaskId, shown),
        sessions: selection?.sessions ?? {},
        ...preservedSessionLayout(selection),
        sessionSort: mode !== DEFAULT_SESSION_SORT_MODE ? mode : undefined,
        sessionSorts: Object.keys(nextSorts).length ? nextSorts : undefined,
      }
    })
  }, [update])

  const dismissError = useCallback(() => {
    const before = current.current
    if (before.workspaceId !== workspaceId || !before.error) return
    const next = { ...before, error: undefined }
    current.current = next
    setState(next)
  }, [workspaceId])

  const saved = state.workspaceId === workspaceId ? state : undefined
  const sessionSort: SessionSortMode = saved?.selection?.sessionSort ?? DEFAULT_SESSION_SORT_MODE
  const explicitGlobalSort = saved?.selection?.sessionSort
  const sessionSorts = saved?.selection?.sessionSorts ?? emptySessionSorts
  const sessionOrders = saved?.selection?.sessionOrders ?? emptySessionOrders
  const sessionGroups = saved?.selection?.sessionGroups ?? emptySessionGroups
  const taskSortMode = useCallback((taskId: string | null | undefined): SessionSortMode => {
    if (taskId && sessionSorts[taskId]) return sessionSorts[taskId]
    if (explicitGlobalSort) return explicitGlobalSort
    if (taskId && (sessionGroups[taskId] || sessionOrders[taskId])) return 'manual'
    return DEFAULT_SESSION_SORT_MODE
  }, [sessionSorts, explicitGlobalSort, sessionGroups, sessionOrders])

  const taskId = saved?.selection?.taskId
  const openTaskIds = saved?.selection?.openTaskIds
  const paneTree = saved?.selection?.paneTree
  const sessions = saved?.selection?.sessions ?? emptySessions
  const error = saved?.error

  return useMemo(() => ({
    taskId,
    openTaskIds,
    paneTree,
    sessions,
    sessionOrders,
    sessionGroups,
    sessionSort,
    sessionSorts,
    taskSortMode,
    error,
    selectTask,
    closeTask,
    selectSession,
    syncPaneSelection,
    rememberDefaultSession,
    clearSession,
    setSessionLayout,
    revealSessionGroup,
    setSessionSort,
    dismissError,
  }), [
    taskId,
    openTaskIds,
    paneTree,
    sessions,
    sessionOrders,
    sessionGroups,
    sessionSort,
    sessionSorts,
    taskSortMode,
    error,
    selectTask,
    closeTask,
    selectSession,
    syncPaneSelection,
    rememberDefaultSession,
    clearSession,
    setSessionLayout,
    revealSessionGroup,
    setSessionSort,
    dismissError,
  ])
}
