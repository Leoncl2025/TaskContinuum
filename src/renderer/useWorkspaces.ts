import { useEffect, useRef, useState } from 'react'
import type { WorkspaceState } from '../shared/workspace'

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

  async function run(action: () => Promise<WorkspaceState | null>): Promise<void> {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      const value = await action()
      if (mounted.current && value) { setState(value); setError(value.warning ?? null) }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'The workspace could not be opened.')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return {
    state, busy, error, setError, available: Boolean(bridge),
    openFolder: () => bridge ? run(() => bridge.openFolder()) : Promise.resolve(),
    openRecent: (id: string) => bridge ? run(() => bridge.openRecent(id)) : Promise.resolve(),
    refresh: () => bridge ? run(() => bridge.refresh()) : Promise.resolve(),
    useDemo: () => bridge ? run(() => bridge.useDemo()) : Promise.resolve(),
  }
}