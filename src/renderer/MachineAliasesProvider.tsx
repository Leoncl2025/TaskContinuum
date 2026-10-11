import type { ReactNode } from 'react'
import { MachineAliasesContext, useGitSyncStatus } from './machineAliases'

function WorkspaceMachineAliases({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const value = useGitSyncStatus(enabled)
  return <MachineAliasesContext.Provider value={value}>{children}</MachineAliasesContext.Provider>
}

export function MachineAliasesProvider({ workspaceId, children }: { workspaceId: string | null; children: ReactNode }) {
  return <WorkspaceMachineAliases key={workspaceId === null ? 'no-workspace' : `workspace:${workspaceId}`} enabled={workspaceId !== null}>{children}</WorkspaceMachineAliases>
}
