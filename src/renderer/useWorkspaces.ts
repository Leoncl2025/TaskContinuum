import { useEffect, useRef, useState } from 'react'
import type { CreateWorkspaceRepositoryRequest, WorkspaceState } from '../shared/workspace'

export function useWorkspaces() {
  const bridge = window.workspace
  const [state, setState] = useState<WorkspaceState>({ current: null, recent: [] })
  const [busy, setBusy] = useState(Boolean(bridge))
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  const pending = useRef(Boolean(bridge))

  useEffect(() => {
    mounted.current = true
    void bridge?.getState().then((value) => {
      if (mounted.current) { setState(value); setError(value.warning ?? null) }
    }).catch((failure: unknown) => {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'The workspace could not be loaded.')
    }).finally(() => {
      pending.current = false
      if (mounted.current) setBusy(false)
    })
    return () => { mounted.current = false }
  }, [bridge])

  async function change<Result extends WorkspaceState | null>(action: () => Promise<Result>): Promise<Result> {
    if (pending.current) throw new Error('Another workspace operation is still in progress.')
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      const value = await action()
      if (mounted.current && value) { setState(value); setError(value.warning ?? null) }
      return value
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function run(action: () => Promise<WorkspaceState | null>): Promise<void> {
    try { await change(action) } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'The workspace could not be opened.')
    }
  }

  function nativeBridge() {
    if (!bridge) throw new Error('Open Task Continuum in the desktop app to manage local repositories.')
    return bridge
  }

  return {
    state, busy, error, setError, available: Boolean(bridge),
    openFolder: () => run(() => nativeBridge().openFolder()),
    openRecent: (id: string) => run(() => nativeBridge().openRecent(id)),
    refresh: () => run(() => nativeBridge().refresh()),
    closeWorkspace: () => run(() => nativeBridge().closeWorkspace()),
    createRepository: (request: CreateWorkspaceRepositoryRequest) => change(() => nativeBridge().createRepository(request)),
  }
}