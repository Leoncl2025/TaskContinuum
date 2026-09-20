import type { SessionOwner } from '../../shared/sessionBindings'
import { agentHostKey } from '../../shared/agentHost'
import type { AgentHostTarget } from '../../shared/agentHost'

export interface SessionBinding {
  id: string
  title: string
  owner: SessionOwner
  ownerIsRemote?: boolean
  agentHost: AgentHostTarget
}
export type SessionBindings = Record<string, SessionBinding[]>

export function sessionBindingKey(binding: Pick<SessionBinding, 'agentHost'>): string {
  return `ahp:${agentHostKey(binding.agentHost)}`
}
