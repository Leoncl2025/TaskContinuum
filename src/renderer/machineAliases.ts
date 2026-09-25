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

export const MachineAliasesContext = createContext<GitSyncContext | undefined>(undefined)
const noAliases: Readonly<Record<string, string>> = Object.freeze({})

export function useGitSyncStatus(enabled: boolean): GitSyncContext {
  const api = window.remoteVSCode?.gitSync
  const [state, setState] = useState<GitSyncState>({})
  const scope = useRef({ active: false, request: 0, pending: 0 })
  const refresh = useCallback(async () => {
    const current = scope.current
    if (!enabled || !api || !current.active) return
    const request = ++current.request
    current.pending++
    try {
      const status = await api.status()
      if (!current.active || request !== current.request) return
      setState({ status })
      return status
    } catch (failure) {
      if (current.active && request === current.request) {
        setState((previous) => ({ ...previous, error: failure instanceof Error ? failure.message : 'Workspace machine names and Git synchronization status are unavailable.' }))
      }
    } finally {
      current.pending--
    }
  }, [api, enabled])

  useEffect(() => {
    const current = { active: true, request: 0, pending: 0 }
    scope.current = current
    if (!enabled || !api) return () => { current.active = false }
    const update = () => { void refresh() }
    update()
    const timer = setInterval(() => { if (!current.pending) update() }, 2000)
    const unlisten = api.onBindingsChanged(update)
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
