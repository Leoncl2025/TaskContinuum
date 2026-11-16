import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { sessionSortModes } from './sessionBindings'
import type { SessionSortMode } from './sessionBindings'

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
}).refine((selection) => selection.taskId === null ? selection.openTaskIds.length === 0 : selection.openTaskIds.includes(selection.taskId), 'The active task must be open.')
type Selection = z.infer<typeof selectionSchema>
type State = { workspaceId?: string; selection?: Selection; persisted?: boolean; error?: string }
const emptySessions: Readonly<Record<string, string | null>> = Object.freeze({})
const emptySessionOrders: Readonly<Record<string, readonly string[]>> = Object.freeze({})
const emptySessionSorts: Readonly<Record<string, SessionSortMode>> = Object.freeze({})

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
  entries.push([taskId, [...orderedKeys]])
  return Object.fromEntries(entries.slice(-sessionLimit))
}

function rememberTaskSort(selection: Selection | undefined, taskId: string, mode: SessionSortMode | null, defaultSort: SessionSortMode): NonNullable<Selection['sessionSorts']> {
  const entries = Object.entries(selection?.sessionSorts ?? {}).filter(([id, item]) => id !== taskId && item !== defaultSort)
  if (mode !== null && mode !== defaultSort) entries.push([taskId, mode])
  return Object.fromEntries(entries.slice(-sessionLimit))
}

function preservedSessionOrders(selection: Selection | undefined): Pick<Selection, 'sessionOrders' | 'sessionSort' | 'sessionSorts'> {
  return {
    ...(selection?.sessionOrders && Object.keys(selection.sessionOrders).length ? { sessionOrders: selection.sessionOrders } : {}),
    ...(selection?.sessionSort && selection.sessionSort !== 'manual' ? { sessionSort: selection.sessionSort } : {}),
    ...(selection?.sessionSorts && Object.keys(selection.sessionSorts).length ? { sessionSorts: selection.sessionSorts } : {}),
  }
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
    return { workspaceId, selection: selectionSchema.parse(value), persisted: true }
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

  const update = useCallback((change: (selection: Selection | undefined) => Selection, implicit = false) => {
    if (!workspaceId) return
    const before = current.current.workspaceId === workspaceId ? current.current : read(workspaceId)
    if (implicit && before.error) return
    const candidate = change(before.selection)
    if (candidate === before.selection) return
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
    update((selection) => ({ version: 2, taskId, openTaskIds: openTasks(selection, taskId, shown), sessions: selection?.sessions ?? {}, ...preservedSessionOrders(selection) }))
  }, [update])

  const closeTask = useCallback((taskId: string, shown: readonly string[], activeTaskId: string | null) => {
    const remaining = shown.filter((id) => id !== taskId)
    update((selection) => ({
      version: 2, taskId: activeTaskId === taskId ? remaining.at(-1) ?? null : activeTaskId,
      openTaskIds: remaining, sessions: selection?.sessions ?? {}, ...preservedSessionOrders(selection),
    }))
  }, [update])

  const selectSession = useCallback((taskId: string, key: string, shown?: readonly string[]) => {
    update((selection) => ({ version: 2, taskId, openTaskIds: openTasks(selection, taskId, shown), sessions: rememberSession(selection, taskId, key), ...preservedSessionOrders(selection) }))
  }, [update])

  const rememberDefaultSession = useCallback((taskId: string, key: string) => {
    update((selection) => selection && Object.hasOwn(selection.sessions, taskId) ? selection : {
      version: 2, taskId: selection ? selection.taskId : taskId, openTaskIds: selection?.openTaskIds ?? [taskId], sessions: rememberSession(selection, taskId, key), ...preservedSessionOrders(selection),
    }, true)
  }, [update])

  const clearSession = useCallback((taskId: string, expectedKey: string) => {
    update((selection) => selection && Object.hasOwn(selection.sessions, taskId) && selection.sessions[taskId] !== expectedKey
      ? selection : { version: 2, taskId: selection ? selection.taskId : taskId, openTaskIds: selection?.openTaskIds ?? [taskId], sessions: rememberSession(selection, taskId, null), ...preservedSessionOrders(selection) })
  }, [update])

  const reorderSessions = useCallback((taskId: string, orderedKeys: readonly string[], activeTaskId?: string | null, shown?: readonly string[]) => {
    update((selection) => {
      const defaultSort = selection?.sessionSort ?? 'manual'
      const currentSort = selection?.sessionSorts?.[taskId] ?? defaultSort
      const currentOrder = selection?.sessionOrders?.[taskId]
      if (selection && currentSort === 'manual' && currentOrder && currentOrder.length === orderedKeys.length
        && currentOrder.every((key, index) => key === orderedKeys[index])) {
        return selection
      }
      const resolvedTaskId = activeTaskId !== undefined ? activeTaskId : selection ? selection.taskId : taskId
      const nextSorts = rememberTaskSort(selection, taskId, 'manual', defaultSort)
      return {
        version: 2,
        taskId: resolvedTaskId,
        openTaskIds: openTasks(selection, resolvedTaskId, shown),
        sessions: selection?.sessions ?? {},
        sessionOrders: rememberSessionOrder(selection, taskId, orderedKeys),
        ...(defaultSort !== 'manual' ? { sessionSort: defaultSort } : {}),
        ...(Object.keys(nextSorts).length ? { sessionSorts: nextSorts } : {}),
      }
    })
  }, [update])

  const setSessionSort = useCallback((taskId: string, mode: SessionSortMode, activeTaskId?: string | null, shown?: readonly string[]) => {
    update((selection) => {
      const currentDefault = selection?.sessionSort ?? 'manual'
      const currentTaskSort = selection?.sessionSorts?.[taskId] ?? currentDefault
      if (selection && currentDefault === mode && currentTaskSort === mode) return selection
      const resolvedTaskId = activeTaskId !== undefined ? activeTaskId : selection ? selection.taskId : taskId
      const nextSorts = rememberTaskSort(selection, taskId, null, mode)
      return {
        version: 2,
        taskId: resolvedTaskId,
        openTaskIds: openTasks(selection, resolvedTaskId, shown),
        sessions: selection?.sessions ?? {},
        ...(selection?.sessionOrders && Object.keys(selection.sessionOrders).length ? { sessionOrders: selection.sessionOrders } : {}),
        ...(mode !== 'manual' ? { sessionSort: mode } : {}),
        ...(Object.keys(nextSorts).length ? { sessionSorts: nextSorts } : {}),
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
  const sessionSort: SessionSortMode = saved?.selection?.sessionSort ?? 'manual'
  const sessionSorts = saved?.selection?.sessionSorts ?? emptySessionSorts
  const taskSortMode = useCallback((taskId: string | null | undefined): SessionSortMode => {
    return (taskId ? sessionSorts[taskId] : undefined) ?? sessionSort
  }, [sessionSort, sessionSorts])

  return {
    taskId: saved?.selection?.taskId, openTaskIds: saved?.selection?.openTaskIds,
    sessions: saved?.selection?.sessions ?? emptySessions,
    sessionOrders: saved?.selection?.sessionOrders ?? emptySessionOrders,
    sessionSort, sessionSorts, taskSortMode,
    error: saved?.error, selectTask, closeTask, selectSession, rememberDefaultSession, clearSession, reorderSessions, setSessionSort, dismissError,
  }
}
