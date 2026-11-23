import { createContext } from 'react'
import type { AgentHostTarget } from '../../shared/agentHost'

export type ChatLinkTargetContextValue = AgentHostTarget | { target?: AgentHostTarget; active?: boolean } | undefined

export function resolveChatLinkTarget(value: ChatLinkTargetContextValue): AgentHostTarget | undefined {
  if (!value) return undefined
  return 'owner' in value ? value : value.target
}

export const ChatLinkTargetContext = createContext<ChatLinkTargetContextValue>(undefined)
export const ChatLinkActiveContext = createContext<boolean>(true)


