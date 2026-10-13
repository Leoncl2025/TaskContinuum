import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'

const taskIdSchema = z.string().regex(/^T-[0-9]{4,}$/).max(128)
const sessionLimit = 1000
const sessionsSchema = z.unknown().refine((value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length <= sessionLimit && Object.keys(value).every((key) => taskIdSchema.safeParse(key).success), 'Invalid remembered task sessions.')
  .pipe(z.record(taskIdSchema, z.string().startsWith('ahp:').max(2048).nullable()))
const selectionSchema = z.object({
  version: z.literal(1),
  taskId: taskIdSchema.nullable(),
  sessions: sessionsSchema,
}).strict()
type Selection = z.infer<typeof selectionSchema>
type State = { workspaceId?: string; selection?: Selection; persisted?: boolean; error?: string }
const emptySessions: Readonly<Record<string, string | null>> = Object.freeze({})

function storageKey(workspaceId: string): string { return `taskcontinuum:workbench-selection:v1:${workspaceId}` }

function rememberSession(selection: Selection | undefined, taskId: string, key: string | null): Selection['sessions'] {
  const entries = Object.entries(selection?.sessions ?? {}).filter(([id]) => id !== taskId)
  entries.push([taskId, key])
  return Object.fromEntries(entries.slice(-sessionLimit))
}

function read(workspaceId: string | undefined): State {
  if (!workspaceId) return {}
  let stored: string | null
  try { stored = localStorage.getItem(storageKey(workspaceId)) }
  catch { return { workspaceId, error: 'The last opened task and session could not be read on this device. Your current selection still works.' } }
  if (stored === null) return { workspaceId }
  try {
    if (stored.length > 2 * 1024 * 1024) throw new Error('Oversized selection preference.')
    return { workspaceId, selection: selectionSchema.parse(JSON.parse(stored)), persisted: true }
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
    try { localStorage.setItem(storageKey(workspaceId), encoded) }
    catch { error = 'The current task and session could not be saved on this device. They will be remembered only until this workspace closes.' }
    const next: State = { workspaceId, selection: parsed.data, persisted: !error, error }
    current.current = next
    setState(next)
  }, [workspaceId])

  const selectTask = useCallback((taskId: string | null) => {
    update((selection) => ({ version: 1, taskId, sessions: selection?.sessions ?? {} }))
  }, [update])

  const selectSession = useCallback((taskId: string, key: string) => {
    update((selection) => ({ version: 1, taskId, sessions: rememberSession(selection, taskId, key) }))
  }, [update])

  const rememberDefaultSession = useCallback((taskId: string, key: string) => {
    update((selection) => selection && Object.hasOwn(selection.sessions, taskId) ? selection : {
      version: 1, taskId: selection ? selection.taskId : taskId, sessions: rememberSession(selection, taskId, key),
    }, true)
  }, [update])

  const clearSession = useCallback((taskId: string, expectedKey: string) => {
    update((selection) => selection && Object.hasOwn(selection.sessions, taskId) && selection.sessions[taskId] !== expectedKey
      ? selection : { version: 1, taskId: selection ? selection.taskId : taskId, sessions: rememberSession(selection, taskId, null) })
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
    taskId: saved?.selection?.taskId, sessions: saved?.selection?.sessions ?? emptySessions,
    error: saved?.error, selectTask, selectSession, rememberDefaultSession, clearSession, dismissError,
  }
}
