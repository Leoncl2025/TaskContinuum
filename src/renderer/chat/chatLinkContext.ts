import { createContext } from 'react'
import type { AgentHostTarget } from '../../shared/agentHost'

export const ChatLinkTargetContext = createContext<{ target: AgentHostTarget; active: boolean } | undefined>(undefined)
