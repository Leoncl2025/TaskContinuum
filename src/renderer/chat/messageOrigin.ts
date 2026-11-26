import type { Message, ResponsePart } from '@microsoft/agent-host-protocol'
import { agentHostKey } from '../../shared/agentHost'
import type { AgentHostTarget } from '../../shared/agentHost'
import { readNativeDelegationMeta, readTaskContinuumCollaborationMeta } from '../../shared/sessionCollaboration'
import { collaborationToolIds, collaborationToolMatches } from '../../shared/taskContinuumTools'
import { machineLabel } from '../machineAliases'
import type { SessionBinding } from './sessionBindings'

export interface LinkedSessionReference {
  taskId: string
  binding: SessionBinding
  label: string
}

export interface MessageOriginPresentation {
  kind: 'user' | 'agent' | 'collaboration' | 'tool' | 'automation' | 'systemNotification'
  isNonUserOrigin: boolean
  icon: string
  senderLabel: string
  machineBadge?: { label: string; title: string }
  provenance?: {
    label: string
    jumpTarget?: LinkedSessionReference
  }
}

function findNativeSourceSession(
  ownerClientId: string,
  sourceSession: string,
  sourceChat: string | undefined,
  currentTarget: AgentHostTarget,
  linkedSessions: readonly LinkedSessionReference[],
): LinkedSessionReference | undefined {
  const sameOwner = linkedSessions.filter((entry) => entry.binding.owner.clientId === ownerClientId
    && agentHostKey(entry.binding.agentHost) !== agentHostKey(currentTarget))
  if (sourceChat) {
    return sameOwner.find((entry) => entry.binding.agentHost.chatId === sourceChat)
  }
  const bySession = sameOwner.filter((entry) => entry.binding.agentHost.sessionId === sourceSession)
  return bySession.length === 1 ? bySession[0] : undefined
}

export function describeMessageOrigin(
  message: Message,
  currentTarget: AgentHostTarget,
  aliases: Readonly<Record<string, string>>,
  linkedSessions: readonly LinkedSessionReference[] = [],
): MessageOriginPresentation {
  const collaboration = readTaskContinuumCollaborationMeta(message._meta)
  if (collaboration) {
    const senderMachine = machineLabel(collaboration.senderDevice, aliases)
    const source = collaboration.sourceTarget ?? collaboration.relayedSourceTarget
    const matchedSource = source
      ? linkedSessions.find((entry) => agentHostKey(entry.binding.agentHost) === agentHostKey(source)
        && agentHostKey(entry.binding.agentHost) !== agentHostKey(currentTarget))
      : undefined
    return {
      kind: 'collaboration',
      isNonUserOrigin: true,
      icon: 'comment-discussion',
      senderLabel: matchedSource && !collaboration.relayedSourceTarget ? matchedSource.label : 'Agent collaboration',
      machineBadge: { label: senderMachine, title: collaboration.senderDevice.machineName },
      provenance: matchedSource
        ? {
            label: collaboration.relayedSourceTarget
              ? `Source session: ${matchedSource.label} · via ${senderMachine}`
              : `From ${matchedSource.label} · ${senderMachine}`,
            jumpTarget: matchedSource,
          }
        : { label: `Sent via Task Continuum collaboration · ${collaboration.taskId}` },
    }
  }

  const originKind = message.origin.kind
  if (originKind === 'agent') {
    const delegation = readNativeDelegationMeta(message._meta)
    if (delegation?.kind === 'session') {
      const matched = findNativeSourceSession(
        currentTarget.owner.clientId,
        delegation.sourceSession,
        delegation.sourceChat,
        currentTarget,
        linkedSessions,
      )
      if (matched) {
        const hostLabel = machineLabel(matched.binding.owner, aliases)
        return {
          kind: 'agent',
          isNonUserOrigin: true,
          icon: 'comment-discussion',
          senderLabel: matched.label,
          machineBadge: { label: hostLabel, title: matched.binding.owner.machineName },
          provenance: {
            label: delegation.sourceChat ? `Sent from ${matched.label}` : `Sent by ${matched.label}`,
            jumpTarget: matched,
          },
        }
      }
      return {
        kind: 'agent',
        isNonUserOrigin: true,
        icon: 'comment-discussion',
        senderLabel: 'Agent session',
        provenance: {
          label: delegation.sourceChat ? 'Sent from another chat' : 'Sent by another session',
        },
      }
    }
    return {
      kind: 'agent',
      isNonUserOrigin: true,
      icon: 'comment-discussion',
      senderLabel: 'Agent session',
      provenance: { label: 'Sent by another agent' },
    }
  }

  if (originKind === 'tool' || originKind === 'automation' || originKind === 'systemNotification') {
    const map = {
      tool: { icon: 'tools', senderLabel: 'Tool prompt', provenance: 'Started by tool delegation' },
      automation: { icon: 'run-all', senderLabel: 'Automation', provenance: 'Started by automation' },
      systemNotification: { icon: 'bell', senderLabel: 'System notification', provenance: 'System notification' },
    } as const
    const entry = map[originKind]
    return {
      kind: originKind,
      isNonUserOrigin: true,
      icon: entry.icon,
      senderLabel: entry.senderLabel,
      provenance: { label: entry.provenance },
    }
  }

  const actor = message._meta?.taskcontinuumActor as { username?: string; machineName?: string; clientId?: string } | undefined
  return {
    kind: 'user',
    isNonUserOrigin: false,
    icon: 'account',
    senderLabel: typeof actor?.username === 'string' ? actor.username : 'User',
    ...(typeof actor?.machineName === 'string' ? {
      machineBadge: {
        label: machineLabel({ machineName: actor.machineName, clientId: typeof actor.clientId === 'string' ? actor.clientId : undefined }, aliases),
        title: actor.machineName,
      },
    } : {}),
  }
}

type ToolCall = Extract<ResponsePart, { kind: 'toolCall' }>['toolCall']

const COLLABORATION_TOOL_NAMES = new Set([
  'send_message',
  'get_session_context',
  'list_sessions',
  'create_session',
])

export function summarizeCollaborationTool(tool: ToolCall): string | undefined {
  const tcTool = (Object.keys(collaborationToolIds) as (keyof typeof collaborationToolIds)[])
    .find((id) => collaborationToolMatches(tool.toolName, id))
  if (!tcTool && !COLLABORATION_TOOL_NAMES.has(tool.toolName)) return undefined
  if (!('content' in tool) || !tool.content?.length) return undefined
  const firstText = tool.content.find((item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text')?.text
  if (!firstText || firstText.length > 65_536) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(firstText) }
  catch { return undefined }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const payload = parsed as Record<string, unknown>

  // Native VS Code session server tools
  if (tool.toolName === 'send_message' && typeof payload.action === 'string') {
    if (payload.action === 'queued') return 'Queued in target session'
    if (payload.action === 'started') return 'Started in target session'
    if (payload.action === 'steered') return 'Steered active turn'
    if (payload.action === 'replaced') return 'Updated queued message'
    if (payload.action === 'cancelled') return 'Cancelled queued message'
    if (payload.action === 'rejected') return typeof payload.reason === 'string' ? `Rejected (${payload.reason})` : 'Rejected'
  }
  if (tool.toolName === 'get_session_context' && Array.isArray(payload.transcript)) {
    return `Read ${payload.transcript.length} turn${payload.transcript.length === 1 ? '' : 's'}`
  }

  // Both TaskContinuum tool transports return `{ result }` or `{ error }`.
  if (payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)) {
    const code = (payload.error as Record<string, unknown>).code
    if (typeof code === 'string') return `Error: ${code}`
  }
  const result = (payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result))
    ? payload.result as Record<string, unknown>
    : undefined
  if (!result) return undefined

  if (tcTool === 'listSessions' && Array.isArray(result.sessions)) {
    return `${result.sessions.length} linked session${result.sessions.length === 1 ? '' : 's'} in workspace search`
  }
  if (tcTool === 'readContext' && Array.isArray(result.turns)) {
    return `Read ${result.turns.length} recent turn${result.turns.length === 1 ? '' : 's'}`
  }
  if ((tcTool === 'sendMessage' || tcTool === 'messageStatus') && typeof result.state === 'string') {
    const taskSuffix = typeof result.taskId === 'string' ? ` (${result.taskId})` : ''
    if (result.state === 'queued') return `Queued for idle target${taskSuffix}`
    if (result.state === 'dispatching') return `Dispatching${taskSuffix}`
    if (result.state === 'delivered') {
      const turnInfo = typeof result.turnStatus === 'string' && result.turnStatus !== 'unknown' ? `, turn ${result.turnStatus}` : ''
      return `Delivered to target Host${taskSuffix}${turnInfo}`
    }
    if (result.state === 'blocked') return typeof result.reason === 'string' ? `Blocked: ${result.reason}` : `Blocked${taskSuffix}`
    if (result.state === 'uncertain') return `Uncertain delivery — manual check required${taskSuffix}`
    if (result.state === 'expired') return `Expired in queue${taskSuffix}`
    if (result.state === 'failed') return `Delivery failed${taskSuffix}`
  }
  return undefined
}
