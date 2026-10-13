import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'

const taskIdSchema = z.string().regex(/^T-[0-9]{4,}$/).max(128)
const sessionLimit = 1000
const sessionsSchema = z.unknown().refine((value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length <= sessionLimit && Object.keys(value).every((key) => taskIdSchema.safeParse(key).success), 'Invalid remembered task sessions.')
  .pipe(z.record(taskIdSchema, z.string().startsWith('ahp:').max(2048).nullable()))
const legacySelectionSchema = z.object({
  version: z.literal(1),
  taskId: taskIdSchema.nullable(),
  sessions: sessionsSchema,
}).strict()
const selectionSchema = legacySelectionSchema.extend({
  version: z.literal(2),
  openTaskIds: z.array(taskIdSchema).refine((ids) => new Set(ids).size === ids.length, 'Duplicate open tasks.'),
}).refine((selection) => selection.taskId === null ? selection.openTaskIds.length === 0 : selection.openTaskIds.includes(selection.taskId), 'The active task must be open.')
type Selection = z.infer<typeof selectionSchema>
type State = { workspaceId?: string; selection?: Selection; persisted?: boolean; error?: string }
const emptySessions: Readonly<Record<string, string | null>> = Object.freeze({})

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
    update((selection) => ({ version: 2, taskId, openTaskIds: openTasks(selection, taskId, shown), sessions: selection?.sessions ?? {} }))
  }, [update])

  const closeTask = useCallback((taskId: string, shown: readonly string[], activeTaskId: string | null) => {
    const remaining = shown.filter((id) => id !== taskId)
    update((selection) => ({
      version: 2, taskId: activeTaskId === taskId ? remaining.at(-1) ?? null : activeTaskId,
      openTaskIds: remaining, sessions: selection?.sessions ?? {},
    }))
  }, [update])

  const selectSession = useCallback((taskId: string, key: string, shown?: readonly string[]) => {
    update((selection) => ({ version: 2, taskId, openTaskIds: openTasks(selection, taskId, shown), sessions: rememberSession(selection, taskId, key) }))
  }, [update])

  const rememberDefaultSession = useCallback((taskId: string, key: string) => {
    update((selection) => selection && Object.hasOwn(selection.sessions, taskId) ? selection : {
      version: 2, taskId: selection ? selection.taskId : taskId, openTaskIds: selection?.openTaskIds ?? [taskId], sessions: rememberSession(selection, taskId, key),
    }, true)
  }, [update])

  const clearSession = useCallback((taskId: string, expectedKey: string) => {
    update((selection) => selection && Object.hasOwn(selection.sessions, taskId) && selection.sessions[taskId] !== expectedKey
      ? selection : { version: 2, taskId: selection ? selection.taskId : taskId, openTaskIds: selection?.openTaskIds ?? [taskId], sessions: rememberSession(selection, taskId, null) })
  }, [update])

  const dismissError = useCallback(() => {
    const before = current.current
    if (before.workspaceId !== workspaceId || !before.error) return
    const next = { ...before, error: undefined }
    current.current = next
    setState(next)
  }, [workspaceId])

  const saved = state.workspaceId === workspaceId ? state : undefined
  return {
    taskId: saved?.selection?.taskId, openTaskIds: saved?.selection?.openTaskIds, sessions: saved?.selection?.sessions ?? emptySessions,
    error: saved?.error, selectTask, closeTask, selectSession, rememberDefaultSession, clearSession, dismissError,
  }
}
