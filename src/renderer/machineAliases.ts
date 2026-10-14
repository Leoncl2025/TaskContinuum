import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceGitSyncStatus } from '../shared/gitSync'
import { machineDisplayName } from '../shared/machineAliases'

interface GitSyncState {
  status?: WorkspaceGitSyncStatus
  error?: string
}

interface GitSyncContext extends GitSyncState {
  refresh(): Promise<WorkspaceGitSyncStatus | undefined>
}

interface RefreshScope {
  active: boolean
  pending?: Promise<WorkspaceGitSyncStatus | undefined>
  requested: boolean
}

export const MachineAliasesContext = createContext<GitSyncContext | undefined>(undefined)
const noAliases: Readonly<Record<string, string>> = Object.freeze({})

export function useGitSyncStatus(enabled: boolean): GitSyncContext {
  const api = window.remoteVSCode?.gitSync
  const [state, setState] = useState<GitSyncState>({})
  const scope = useRef<RefreshScope>({ active: false, requested: false })
  const refresh = useCallback((): Promise<WorkspaceGitSyncStatus | undefined> => {
    const current = scope.current
    if (!enabled || !api || !current.active) return Promise.resolve(undefined)
    if (current.pending) { current.requested = true; return current.pending }
    current.requested = false
    const work = Promise.resolve().then(async () => {
      let latest: WorkspaceGitSyncStatus | undefined
      do {
        if (!current.active) return
        try {
          const status = await api.status()
          if (!current.active) return
          latest = status
          if (!current.requested) setState({ status })
        } catch (failure) {
          latest = undefined
          if (current.active && !current.requested) {
            setState((previous) => ({ ...previous, error: failure instanceof Error ? failure.message : 'Workspace machine names and Git synchronization status are unavailable.' }))
          }
        }
        if (!current.requested) return latest
        current.requested = false
      } while (current.active)
      return latest
    }).finally(() => {
      if (current.pending === work) current.pending = undefined
    })
    current.pending = work
    return work
  }, [api, enabled])

  useEffect(() => {
    const current: RefreshScope = { active: true, requested: false }
    scope.current = current
    if (!enabled || !api) return () => { current.active = false }
    const update = () => { void refresh() }
    update()
    const timer = setInterval(() => { if (!current.pending) update() }, 2000)
    const unlisten = api.onStatusChanged(update)
    return () => { current.active = false; clearInterval(timer); unlisten() }
  }, [api, enabled, refresh])

  return useMemo(() => ({ ...(enabled && api ? state : {}), refresh }), [api, enabled, state, refresh])
}

export function useMachineAliases(): Readonly<Record<string, string>> {
  return useContext(MachineAliasesContext)?.status?.machineAliases ?? noAliases
}

export function useWorkspaceGitSync(): GitSyncContext {
  const shared = useContext(MachineAliasesContext)
  const standalone = useGitSyncStatus(shared === undefined)
  return shared ?? standalone
}

export function machineLabel(owner: { clientId?: string; machineName: string }, aliases: Readonly<Record<string, string>>): string {
  const name = machineDisplayName(owner, aliases)
  return name === owner.machineName ? name : `${name} (${owner.machineName})`
}
