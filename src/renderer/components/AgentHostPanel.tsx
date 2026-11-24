import { memo, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import stripAnsi from 'strip-ansi'
import type { ResponsePart, TerminalState, Turn } from '@microsoft/agent-host-protocol'
import { agentHostKey, MAX_SESSION_TITLE_LENGTH } from '../../shared/agentHost'
import type { AgentHostBridge, AgentHostHistoryTransfer, AgentHostTarget, AgentHostView } from '../../shared/agentHost'
import type { TaskRecord } from '../../shared/tasks'
import type { WorkspaceSnapshot } from '../../shared/workspace'
import { MAX_CHAT_TEXT_LENGTH } from '../../shared/chatAttachments'
import type { ChatImageAttachment } from '../../shared/chatAttachments'
import { ChatMarkdown } from './ChatMarkdown'
import { ChatLinkActiveContext, ChatLinkTargetContext } from '../chat/chatLinkContext'
import { copyMarkdownSelection } from '../chat/copyMarkdownSelection'
import { ChatImages, ChatImageStatus } from './ChatImages'
import { messageImages as imagesFor } from '../chat/messageImages'
import { formatRequestedModelSummary } from '../chat/turnModelSummary'
import { formatTurnTimestamps } from '../chat/turnTime'
import { useChatImageInput } from '../chat/useChatImageInput'
import { readModelPreference, saveModelPreference } from '../chat/modelPreferences'
import { Dialog, Icon, IconButton } from './Primitives'
import { AgentHostModelOptions } from './AgentHostModelConfig'
import { modelConfigErrors } from '../../shared/agentHostModelConfig'
import type { ModelConfig } from '../../shared/agentHostModelConfig'
import { sessionTitle } from '../chat/useSessionTitles'
import type { SessionTitleUpdate } from '../chat/useSessionTitles'
import { machineDisplayName } from '../../shared/machineAliases'
import { machineLabel, useMachineAliases } from '../machineAliases'
import { resolveTurnActorName, useUserProfile } from '../userProfile'
import type { TurnActorMetadata, UserProfileValue } from '../userProfile'

function terminalText(state: TerminalState | undefined): string {
  return state ? stripAnsi(state.content.map((part) => part.type === 'command' ? part.output : part.value).join('')) : ''
}

const EMPTY_TERMINALS: Record<string, TerminalState> = Object.freeze({})
const EMPTY_TERMINAL_STATUS: NonNullable<AgentHostView['terminalStatus']> = Object.freeze({})

function turnPartsEquivalent(left: Turn, right: Turn): boolean {
  if (left === right) return true
  if (left.id !== right.id || left.state !== 'complete' || right.state !== 'complete') return false
  if (left.startedAt !== right.startedAt || left.duration !== right.duration || left.message.text !== right.message.text) return false
  if (left.responseParts.length !== right.responseParts.length) return false
  for (let index = 0; index < left.responseParts.length; index++) {
    const lp = left.responseParts[index]
    const rp = right.responseParts[index]
    if (lp.kind !== rp.kind) return false
    if ((lp.kind === 'markdown' || lp.kind === 'reasoning') && rp.kind === lp.kind) {
      if (lp.content !== rp.content) return false
    } else if (lp.kind === 'toolCall' && rp.kind === 'toolCall') {
      if (lp.toolCall.toolCallId !== rp.toolCall.toolCallId
        || lp.toolCall.status !== rp.toolCall.status
        || lp.toolCall.invocationMessage !== rp.toolCall.invocationMessage
        || ('success' in lp.toolCall ? lp.toolCall.success : undefined) !== ('success' in rp.toolCall ? rp.toolCall.success : undefined)
        || ('error' in lp.toolCall ? lp.toolCall.error?.message : undefined) !== ('error' in rp.toolCall ? rp.toolCall.error?.message : undefined)) {
        return false
      }
      const lc = 'content' in lp.toolCall ? lp.toolCall.content?.length ?? 0 : 0
      const rc = 'content' in rp.toolCall ? rp.toolCall.content?.length ?? 0 : 0
      if (lc !== rc) return false
    }
  }
  return true
}

type DisplayedTurn = Turn | NonNullable<NonNullable<AgentHostView['chat']>['activeTurn']>

function turnReferencesTerminal(turn: DisplayedTurn): boolean {
  for (const part of turn.responseParts) {
    if (part.kind === 'toolCall' && 'content' in part.toolCall && part.toolCall.content?.some((item) => item.type === 'terminal')) {
      return true
    }
  }
  return false
}

function retainChatHistory(previous: AgentHostView | undefined, value: AgentHostView): AgentHostView {
  if (value.chat === undefined && previous?.chat) return { ...value, chat: previous.chat }
  if (value.chat && previous?.chat && previous.chat.turns.length > 0 && value.chat.turns.length > 0) {
    const prevById = new Map<string, Turn>()
    for (const turn of previous.chat.turns) prevById.set(turn.id, turn)
    let reusedAny = false
    let allIdentical = value.chat.turns.length === previous.chat.turns.length
    const mergedTurns = value.chat.turns.map((turn, idx) => {
      const prior = prevById.get(turn.id)
      if (prior && turnPartsEquivalent(prior, turn)) {
        reusedAny = true
        if (previous.chat!.turns[idx] !== prior) allIdentical = false
        return prior
      }
      allIdentical = false
      return turn
    })
    if (allIdentical
      && !value.chat.activeTurn && !previous.chat.activeTurn
      && value.chat.title === previous.chat.title
      && value.chat.modifiedAt === previous.chat.modifiedAt
      && value.chat.turnsNextCursor === previous.chat.turnsNextCursor
      && value.chat.draft?.text === previous.chat.draft?.text
      && (value.chat.queuedMessages?.length ?? 0) === (previous.chat.queuedMessages?.length ?? 0)) {
      return { ...value, chat: previous.chat }
    }
    if (reusedAny) {
      return { ...value, chat: { ...value.chat, turns: mergedTurns } }
    }
  }
  return value
}

function historyTransferLabel(progress: AgentHostHistoryTransfer): string {
  return progress.kind === 'recent' ? 'Loading recent history...' : progress.kind === 'earlier' ? 'Loading earlier history...'
    : progress.resumed ? 'Resuming history...' : 'Syncing history...'
}

function chatActivityTimestamps(chat: NonNullable<AgentHostView['chat']>, hasMoreHistory?: boolean): { updatedAt: string; createdAt?: string } {
  let latest = Date.parse(chat.modifiedAt)
  if (!Number.isFinite(latest)) latest = -1
  const activeStart = chat.activeTurn?.startedAt ? Date.parse(chat.activeTurn.startedAt) : -1
  if (Number.isFinite(activeStart) && activeStart > latest) latest = activeStart
  const lastTurn = chat.turns.at(-1)
  if (lastTurn?.startedAt) {
    const ended = Date.parse(lastTurn.startedAt) + (lastTurn.duration ?? 0)
    if (Number.isFinite(ended) && ended > latest) latest = ended
  }
  const firstStart = !hasMoreHistory ? chat.turns[0]?.startedAt : undefined
  return {
    updatedAt: latest >= 0 && chat.modifiedAt !== '' || latest > 0 ? new Date(latest).toISOString() : chat.modifiedAt,
    ...(firstStart && Number.isFinite(Date.parse(firstStart)) ? { createdAt: firstStart } : {}),
  }
}

type TerminalStatus = NonNullable<AgentHostView['terminalStatus']>
type ToolPart = Extract<ResponsePart, { kind: 'toolCall' }>
type ResponseContext = {
  terminals: Record<string, TerminalState>
  terminalStatus: TerminalStatus
  owner: string
  bridge: AgentHostBridge | undefined
  watchId: string | undefined
}

function toolFailed(tool: ToolPart['toolCall']): boolean {
  return 'success' in tool && tool.success === false || 'error' in tool && Boolean(tool.error)
}

function toolDescription(tool: ToolPart['toolCall']): string {
  const message = 'pastTenseMessage' in tool ? tool.pastTenseMessage : 'invocationMessage' in tool ? tool.invocationMessage : undefined
  return (typeof message === 'string' ? message : message?.markdown) || tool.intention || ''
}

function routineTool(tool: ToolPart['toolCall']): boolean {
  return !toolFailed(tool) && (tool.status === 'completed' || tool.status === 'running' || tool.status === 'streaming')
}

function ToolActivity({ parts, ...context }: ResponseContext & { parts: ToolPart[] }) {
  const [expanded, setExpanded] = useState(false)
  const running = parts.filter((part) => part.toolCall.status !== 'completed')
  const current = running.at(-1)?.toolCall
  const counts = new Map<string, number>()
  for (const { toolCall } of parts) {
    const name = toolCall.displayName || toolCall.toolName
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const description = current ? `Running: ${toolDescription(current) || current.displayName || current.toolName}`
    : [...counts].map(([name, count]) => count > 1 ? `${name} (${count})` : name).join(', ')
  return <details className="ahp-activity" open={expanded} data-running={Boolean(current)}>
    <summary aria-label={`${parts.length} tool calls, ${current ? `${running.length} running` : 'completed'}`} onClick={(event) => { event.preventDefault(); setExpanded(!expanded) }}>
      <Icon name={current ? 'loading' : 'check'} className={current ? 'codicon-modifier-spin' : ''} />
      <span className="ahp-activity-label">{parts.length} tool calls</span>
      <span className="ahp-activity-description" title={description}>{description}</span>
      <Icon name="chevron-right" className="ahp-disclosure" />
    </summary>
    {expanded && <div className="ahp-activity-details">{parts.map((part) => <ToolResponse key={part.toolCall.toolCallId} part={part} {...context} />)}</div>}
  </details>
}

function ToolResponse({ part, terminals, terminalStatus, owner, bridge, watchId }: ResponseContext & { part: ToolPart }) {
  const tool = part.toolCall
  const content = 'content' in tool ? tool.content ?? [] : []
  const pending = tool.status === 'pending-confirmation' || tool.status === 'pending-result-confirmation' || tool.status === 'auth-required'
  const failed = toolFailed(tool)
  const name = tool.displayName || tool.toolName
  const description = toolDescription(tool)
  const status = failed ? 'failed' : tool.status.replaceAll('-', ' ')
  const [openChoice, setOpenChoice] = useState<boolean>()
  const expanded = openChoice ?? (tool.status === 'running' || pending || failed)
  const [requests, setRequests] = useState<Record<string, { state: 'loading' | 'ready' | 'error'; error?: string }>>({})
  const [leaseId] = useState(() => crypto.randomUUID())
  const resources = [...new Set(content.flatMap((item) => item.type === 'terminal' ? [item.resource] : []))]
  const resourcesKey = JSON.stringify(resources)

  useEffect(() => {
    if (!expanded || !bridge || !watchId) return
    const resources = JSON.parse(resourcesKey) as string[]
    let cancelled = false
    for (const resource of resources) {
      void bridge.terminal(watchId, resource, leaseId).then(() => {
        if (!cancelled) setRequests((current) => ({ ...current, [resource]: { state: 'ready' } }))
      }).catch((failure: unknown) => {
        if (!cancelled) setRequests((current) => ({ ...current, [resource]: { state: 'error', error: failure instanceof Error ? failure.message : 'Terminal output is unavailable.' } }))
      })
    }
    return () => {
      cancelled = true
      for (const resource of resources) void bridge.releaseTerminal(watchId, resource, leaseId).catch(() => { console.error('Could not release Agent Host terminal output.') })
    }
  }, [bridge, watchId, expanded, resourcesKey, leaseId])

  const retry = (resource: string) => {
    if (!bridge || !watchId) return
    setRequests((current) => ({ ...current, [resource]: { state: 'loading' } }))
    void bridge.terminal(watchId, resource, leaseId, true).then(() => {
      setRequests((current) => ({ ...current, [resource]: { state: 'ready' } }))
    }).catch((failure: unknown) => {
      setRequests((current) => ({ ...current, [resource]: { state: 'error', error: failure instanceof Error ? failure.message : 'Terminal output is unavailable.' } }))
    })
  }

  return <div className={`ahp-tool-entry${pending || failed ? ' ahp-tool-attention' : ''}`}>
    <details className="ahp-tool" open={expanded}>
      <summary aria-label={`${name}, ${status}`} onClick={(event) => {
        event.preventDefault()
        if (!expanded) setRequests((current) => Object.fromEntries(resources.map((resource) => [resource, current[resource]?.state === 'error' ? current[resource] : { state: 'loading' as const }])))
        setOpenChoice(!expanded)
      }}>
        <Icon name={failed ? 'error' : pending ? 'shield' : tool.status === 'completed' ? 'check' : tool.status === 'cancelled' ? 'circle-slash' : 'tools'} />
        <strong title={name}>{name}</strong>
        {description && description !== name && <span className="ahp-tool-description" title={description}>{description}</span>}
        {tool.status !== 'completed' || failed ? <span className="ahp-tool-status">{status}</span> : null}
        <Icon name="chevron-right" className="ahp-disclosure" />
      </summary>
      {expanded && <div className="ahp-tool-content">{content.map((item, index) => {
        if (item.type === 'text') return <ChatMarkdown key={index} source={item.text} />
        if (item.type !== 'terminal') return <p key={index} className="message-notice">{item.type}</p>
        const state = terminals[item.resource]
        const status = terminalStatus[item.resource]
        const request = requests[item.resource]
        const preview = stripAnsi(item.result?.preview ?? '')
        const failure = status?.state === 'error' ? status.error : request?.state === 'error' ? request.error : undefined
        const loading = status?.state === 'loading' || request?.state === 'loading' && !state || !state && !failure && !request && expanded && Boolean(watchId)
        const needsRetry = !state && request?.state === 'ready' && !loading
        return <div key={`${item.resource}:${index}`} className="ahp-terminal-output">
          <pre className="ahp-terminal" aria-label={`${item.title || 'Terminal output'} on ${owner}`} title={`Terminal on ${owner}`}>{terminalText(state) || preview || (state ? 'No terminal output yet.' : 'No terminal output loaded.')}</pre>
          {!state && preview && <p className="message-notice">Preview only - full terminal output has not loaded.</p>}
          {loading && <p className="message-notice" role="status">Loading terminal output...</p>}
          {failure && <p className="message-notice error" role="alert">{failure}</p>}
          {needsRetry && !failure && <p className="message-notice" role="status">Terminal output was not restored after reconnect.</p>}
          {(failure || needsRetry) && <button type="button" className="text-button" disabled={!watchId || loading} onClick={() => retry(item.resource)}>Retry terminal output</button>}
        </div>
      })}</div>}
    </details>
    {pending && <p className="message-notice" role="status">{tool.status === 'auth-required' ? 'Authentication required' : 'Awaiting confirmation'} on {owner}</p>}
    {failed && <p className="message-notice error" role="alert">{'error' in tool && tool.error ? tool.error.message : 'The tool reported a failure. Review its output for details.'}</p>}
    {tool.status === 'cancelled' && tool.reasonMessage && <p className="message-notice">{typeof tool.reasonMessage === 'string' ? tool.reasonMessage : tool.reasonMessage.markdown}</p>}
  </div>
}

function Response({ part, ...context }: ResponseContext & { part: ResponsePart }) {
  if (part.kind === 'markdown') return <ChatMarkdown source={part.content} />
  if (part.kind === 'reasoning') return <details className="ahp-tool ahp-reasoning"><summary><Icon name="lightbulb" /><span>Reasoning</span><Icon name="chevron-right" className="ahp-disclosure" /></summary><ChatMarkdown source={part.content} /></details>
  if (part.kind === 'error') return <p className="message-notice error" role="alert">{part.error.message}</p>
  if (part.kind === 'inputRequest') return <div className={`ahp-input-request${part.response ? '' : ' ahp-tool-attention'}`}><strong>{part.response ? 'Input completed' : `Input required on ${context.owner}`}</strong>{typeof part.request.message === 'string' && <p>{part.request.message}</p>}</div>
  if (part.kind === 'systemNotification') return <p className="message-notice">{typeof part.content === 'string' ? part.content : part.content.markdown}</p>
  if (part.kind !== 'toolCall') return <p className="message-notice">Referenced output</p>
  return <ToolResponse part={part} {...context} />
}

function Responses({ parts, ...context }: ResponseContext & { parts: ResponsePart[] }) {
  const blocks: ({ key: string; tools: ToolPart[] } | { key: string; part: ResponsePart })[] = []
  for (const [index, part] of parts.entries()) {
    if (part.kind === 'toolCall' && routineTool(part.toolCall)) {
      const previous = blocks.at(-1)
      if (previous && 'tools' in previous) previous.tools.push(part)
      else blocks.push({ key: `tool:${part.toolCall.toolCallId}`, tools: [part] })
    } else {
      blocks.push({ key: part.kind === 'toolCall' ? `tool:${part.toolCall.toolCallId}` : `part:${index}`, part })
    }
  }
  return blocks.map((block) => 'tools' in block && block.tools.length > 1
    ? <ToolActivity key={block.key} parts={block.tools} {...context} />
    : <Response key={block.key} part={'tools' in block ? block.tools[0] : block.part} {...context} />)
}

const ChatTurnItem = memo(function ChatTurnItem({
  turn,
  isResponding,
  machineName,
  ownerDisplay,
  aliases,
  models,
  userProfile,
  terminals,
  terminalStatus,
  owner,
  bridge,
  watchId,
}: ResponseContext & {
  turn: DisplayedTurn
  isResponding: boolean
  machineName: string
  ownerDisplay: string
  aliases: Readonly<Record<string, string>>
  models: readonly Awaited<ReturnType<AgentHostBridge['models']>>[number][]
  userProfile: UserProfileValue
}) {
  const actor = turn.message._meta?.taskcontinuumActor as TurnActorMetadata | undefined
  const resolvedActor = useMemo(() => resolveTurnActorName(actor, userProfile), [actor, userProfile])
  const actorMachineDisplay = typeof actor?.machineName === 'string' && actor.machineName
    ? machineDisplayName({ machineName: actor.machineName, clientId: typeof actor.clientId === 'string' ? actor.clientId : undefined }, aliases)
    : undefined
  const modelSummary = useMemo(() => formatRequestedModelSummary(turn.message.model, models), [turn.message.model, models])
  const images = useMemo(() => imagesFor(turn), [turn])
  const times = useMemo(() => formatTurnTimestamps(turn, isResponding), [turn, isResponding])
  return <div data-turn-id={turn.id}>
    <article className="message message-user">
      <header className="turn-header turn-header-user">
        <div className="turn-header-identity">
          <span className="turn-actor-avatar is-user" aria-hidden="true">
            {resolvedActor.initial ?? <Icon name="account" />}
          </span>
          <strong className="turn-actor-name" title={resolvedActor.rawUsername}>{resolvedActor.name}</strong>
          {actorMachineDisplay && (
            <span className="turn-machine-badge" title={actor?.machineName}>{actorMachineDisplay}</span>
          )}
        </div>
        {modelSummary && (
          <span className="turn-model-pill" title={modelSummary.tooltip}>
            <span className="turn-model-name">{modelSummary.modelLabel}</span>
            {modelSummary.optionsLabel && (
              <>
                <span className="turn-model-sep" aria-hidden="true">·</span>
                <span className="turn-model-opts">{modelSummary.optionsLabel}</span>
              </>
            )}
          </span>
        )}
      </header>
      <div className="message-text">{turn.message.text}</div>
      <ChatImages images={images} />
    </article>
    {times.user && (
      <div className="message-turn-meta message-turn-meta-user">
        <time dateTime={times.user.iso} title={times.user.tooltip}>{times.user.short}</time>
      </div>
    )}
    <article className="message message-assistant">
      <header className="turn-header turn-header-assistant">
        <span className="turn-actor-avatar is-assistant" aria-hidden="true">
          <Icon name="copilot" />
        </span>
        <strong className="turn-actor-name">Copilot</strong>
        <span className="turn-machine-badge is-assistant" title={machineName}>{ownerDisplay}</span>
      </header>
      <Responses parts={turn.responseParts} terminals={terminals} terminalStatus={terminalStatus} owner={owner} bridge={bridge} watchId={watchId} />
      {isResponding && <p className="message-notice" role="status">Responding...</p>}
    </article>
    {times.assistant && (
      <div className="message-turn-meta message-turn-meta-assistant">
        <time dateTime={times.assistant.iso} title={times.assistant.tooltip}>{times.assistant.short}</time>
        {times.assistant.duration && <span className="message-turn-duration" title={times.assistant.tooltip}>· {times.assistant.duration}</span>}
      </div>
    )}
  </div>
}, (prev, next) => {
  if (prev.turn !== next.turn
    || prev.isResponding !== next.isResponding
    || prev.owner !== next.owner
    || prev.ownerDisplay !== next.ownerDisplay
    || prev.machineName !== next.machineName
    || prev.aliases !== next.aliases
    || prev.models !== next.models
    || prev.userProfile !== next.userProfile
    || prev.bridge !== next.bridge) {
    return false
  }
  if (!turnReferencesTerminal(next.turn)) return true
  return prev.watchId === next.watchId
    && prev.terminals === next.terminals
    && prev.terminalStatus === next.terminalStatus
})

const ChatTranscript = memo(function ChatTranscript({ view, machineName, ownerDisplay, aliases, models, userProfile, ...context }: Pick<ResponseContext, 'owner' | 'bridge' | 'watchId'> & {
  view: AgentHostView | undefined
  machineName: string
  ownerDisplay: string
  aliases: Readonly<Record<string, string>>
  models: readonly Awaited<ReturnType<AgentHostBridge['models']>>[number][]
  userProfile: UserProfileValue
}) {
  const activeTurn = view?.chat?.activeTurn
  const turns = [...view?.chat?.turns ?? [], ...activeTurn ? [activeTurn] : []]
  const terminals = view?.terminals && Object.keys(view.terminals).length > 0 ? view.terminals : EMPTY_TERMINALS
  const terminalStatus = view?.terminalStatus && Object.keys(view.terminalStatus).length > 0 ? view.terminalStatus : EMPTY_TERMINAL_STATUS
  return <>
    {!turns.length && <p className="ahp-chat-placeholder muted">{view?.state === 'connected' ? 'No messages.' : view?.historyTransfer ? historyTransferLabel(view.historyTransfer) : 'Waiting for original history...'}</p>}
    {turns.map((turn) => (
      <ChatTurnItem
        key={turn.id}
        turn={turn}
        isResponding={activeTurn?.id === turn.id}
        machineName={machineName}
        ownerDisplay={ownerDisplay}
        aliases={aliases}
        models={models}
        userProfile={userProfile}
        terminals={terminals}
        terminalStatus={terminalStatus}
        {...context}
      />
    ))}
  </>
})

type AgentHostPanelProps = {
  target: AgentHostTarget
  connectionRevision?: number
  active?: boolean
  visible?: boolean
  paneSlot?: 'single' | 'primary' | 'secondary'
  splitOrientation?: 'horizontal' | 'vertical'
  showTaskBadge?: boolean
  minimalHeader?: boolean
  closeLabel?: string
  hideClose?: boolean
  initialDraft?: string
  restoredDraft?: { readonly nonce: number; readonly text: string }
  headerTarget?: HTMLElement | null
  sessionSwitcher?: ReactNode
  cachedTitle?: string
  customTitle?: string
  onTitles?(sessions: readonly SessionTitleUpdate[]): void
  onRenameTitle?(nextName: string | null): void
  onDraftChange?(draft: string): void
  onActivatePane?(): void
  onSplitRight?(): void
  onSplitDown?(): void
  onToggleSplitOrientation?(): void
  onSwapSplit?(): void
  onPopOut?(draft: string): Promise<boolean> | boolean | void
  onHeaderContextMenu?(anchor: { x: number; y: number }, getDraft: () => string, clearDraft: (snapshot: string) => void, beginRename?: () => void): void
  onClose(): void
  onDevices?(): void
  onSessions?(): void
  onBusy?(busy: boolean, panelKey?: string): void
  panelKey?: string
  beforeReconnect?(): Promise<void>
  prepareFirstMessage?(text: string): Promise<string>
} & ({ task: TaskRecord; workspace?: never; onDetach(): void } | { task?: never; workspace: Pick<WorkspaceSnapshot, 'id' | 'name'>; onDetach?: never })

function HeaderTitleInput({ value, onFinish }: { value: string; onFinish(next: string | undefined): void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const finishedRef = useRef(false)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  function finish(next: string | undefined): void {
    if (finishedRef.current) return
    finishedRef.current = true
    onFinish(next)
  }
  return <input
    ref={inputRef}
    type="text"
    className="ahp-chat-title-input"
    aria-label="Session name"
    maxLength={MAX_SESSION_TITLE_LENGTH}
    defaultValue={value}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => event.stopPropagation()}
    onBlur={(event) => finish(event.currentTarget.value)}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        finish(event.currentTarget.value)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish(undefined)
      }
    }}
  />
}

export const AgentHostPanel = memo(function AgentHostPanel({ task, workspace, target, connectionRevision = 0, active = true, visible = true, paneSlot, splitOrientation = 'horizontal', showTaskBadge = false, minimalHeader = false, closeLabel = 'Hide chat panel', hideClose = false, initialDraft, restoredDraft, headerTarget, sessionSwitcher, cachedTitle, customTitle, onTitles, onRenameTitle, onDraftChange, onActivatePane, onSplitRight, onSplitDown, onToggleSplitOrientation, onSwapSplit, onPopOut, onHeaderContextMenu, onDetach, onClose, onDevices, onSessions, onBusy, panelKey, beforeReconnect, prepareFirstMessage }: AgentHostPanelProps) {
  const bridge = window.agentHost
  const { sessionId, chatId } = target
  const { clientId, machineName } = target.owner
  const aliases = useMachineAliases()
  const userProfile = useUserProfile()
  const ownerLabel = machineLabel(target.owner, aliases)
  const ownerDisplay = machineDisplayName(target.owner, aliases)
  const key = agentHostKey(target)
  const stableTarget = useMemo(
    () => ({ sessionId, chatId, owner: { clientId, machineName } }),
    [sessionId, chatId, clientId, machineName],
  )
  const contextId = task ? task.id : workspace.id
  const contextLabel = task ? task.id : workspace.name
  const viewKey = `${contextId}:${key}`
  const [savedView, setView] = useState<{ key: string; value: AgentHostView }>()
  const view = savedView?.key === viewKey ? savedView.value : undefined
  const [watch, setWatch] = useState<{ key: string; id: string }>()
  const [error, setError] = useState<string>()
  const [historyLoadError, setHistoryLoadError] = useState<{ key: string; message: string }>()
  const [deliveryReview, setDeliveryReview] = useState<{ id: string; status: 'checking' | 'not-found' | 'abandoning' | 'failed'; acknowledged: boolean; error?: string }>()
  const [draft, setDraft] = useState(() => restoredDraft?.text ?? initialDraft ?? '')
  const draftSnapshotRef = useRef(draft)
  const [seenDraftNonce, setSeenDraftNonce] = useState(restoredDraft?.nonce)
  if (restoredDraft && restoredDraft.nonce !== seenDraftNonce) {
    setSeenDraftNonce(restoredDraft.nonce)
    setDraft(restoredDraft.text)
  }
  const [images, setImages] = useState<ChatImageAttachment[]>([])
  const [busy, setBusy] = useState(false)
  const [detailsKey, setDetailsKey] = useState<string>()
  const [editingTitleKey, setEditingTitleKey] = useState<string>()
  const [revision, setRevision] = useState(0)
  const catalogKey = `${key}:${revision}:${connectionRevision}`
  const watchKey = `${contextId}:${catalogKey}`
  const [catalog, setCatalog] = useState<{ key: string; models: Awaited<ReturnType<AgentHostBridge['models']>>; error?: string }>()
  const [selection, setSelection] = useState<{ key: string; provider: string; id: string; config?: ModelConfig; preferenceError?: string }>()
  const currentCatalog = catalog?.key === catalogKey ? catalog : undefined
  const loadedCatalogKeyRef = useRef<string | undefined>(undefined)
  const watchId = watch?.key === watchKey ? watch.id : undefined
  const models = currentCatalog?.models ?? []
  const modelId = selection?.key === key ? selection.id : ''
  const selectedModel = models.find((model) => model.id === modelId && model.provider === selection?.provider)
  const modelReady = Boolean(selectedModel)
  const config = selection?.key === key ? selection.config ?? {} : {}
  const configErrors = selectedModel ? modelConfigErrors(selectedModel.configSchema, config) : []
  const preferenceError = selection?.key === key ? selection.preferenceError : undefined
  const operating = useRef(false)
  const mounted = useRef(false)
  const following = useRef(true)
  const panel = useRef<HTMLElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const log = useRef<HTMLDivElement>(null)
  const logSize = useRef({ width: 0, height: 0 })
  const lastScrollTop = useRef(0)
  const historyRequest = useRef<string | undefined>(undefined)
  const historyAnchor = useRef<{ key: string; turnId?: string; offset: number; top: number; height: number; count: number } | undefined>(undefined)
  const attempted = useRef<{ id: string; text: string; draft: string; images: ChatImageAttachment[] } | undefined>(undefined)
  const firstMessageSent = useRef(false)
  const imageInput = useChatImageInput(`${contextId}:${key}`, images, setImages, busy)
  const notifyDraftChange = useEffectEvent((value: string) => { onDraftChange?.(value) })
  useEffect(() => { draftSnapshotRef.current = draft; notifyDraftChange(draft) }, [draft])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (active && !document.querySelector('dialog[open]')) composer.current?.focus({ preventScroll: true })
  }, [active, contextId, key])
  useEffect(() => {
    let active = true
    let watchId: string | undefined
    let connected = false
    let connectionGeneration = 0
    let loadingModels = false
    let loadedModels = loadedCatalogKeyRef.current === catalogKey
    const pendingViews = new Map<string, AgentHostView>()
    const selected = { sessionId, chatId, owner: { clientId, machineName } }
    if (!bridge) return
    const loadModels = () => {
      if (!active || loadingModels) return
      loadingModels = true
      setCatalog((current) => current?.key === catalogKey && current.error ? undefined : current)
      const generation = connectionGeneration
      let failed = false
      void bridge.models(selected).then((models) => {
        loadedModels = true
        if (active) {
          if (models.length > 0) loadedCatalogKeyRef.current = catalogKey
          else if (loadedCatalogKeyRef.current === catalogKey) loadedCatalogKeyRef.current = undefined
          setCatalog({ key: catalogKey, models, ...(!models.length ? { error: 'No available models. Check model access on the owner device, then reconnect.' } : {}) })
          const provider = models[0]?.provider
          if (provider) {
            const saved = readModelPreference(clientId, provider)
            setSelection((current) => current?.key === key && current.provider === provider ? current : {
              key, provider, id: saved.model?.id ?? '', config: saved.model?.config, preferenceError: saved.error,
            })
          }
        }
      }).catch((failure: unknown) => {
        failed = true
        loadedModels = false
        if (loadedCatalogKeyRef.current === catalogKey) loadedCatalogKeyRef.current = undefined
        if (active) setCatalog({ key: catalogKey, models: [], error: failure instanceof Error ? failure.message : 'The owner model catalog is unavailable. Reconnect to retry.' })
      }).finally(() => {
        loadingModels = false
        if (connected && connectionGeneration !== generation && (failed || generation > 0)) loadModels()
      })
    }
    const applyView = (value: AgentHostView) => {
      const recovered = value.state === 'connected' && !connected
      connected = value.state === 'connected'
      setView((previous) => ({
        key: viewKey,
        value: retainChatHistory(previous?.key === viewKey ? previous.value : undefined, value),
      }))
      if (connected && value.chat?.resource === chatId) {
        onTitles?.([{ ...selected, title: value.chat.title, ...chatActivityTimestamps(value.chat, value.history?.hasMore) }])
      }
      if (recovered) {
        setHistoryLoadError(undefined)
        connectionGeneration++
        if (!loadedModels || connectionGeneration > 1) loadModels()
      }
    }
    const unlisten = bridge.onView((event) => {
      if (!active || agentHostKey(event.view.target) !== agentHostKey(selected)) return
      if (!watchId) { pendingViews.set(event.id, retainChatHistory(pendingViews.get(event.id), event.view)); return }
      if (event.id === watchId) applyView(event.view)
    })
    if (!loadedModels) loadModels()
    void bridge.watch(selected).then((id) => {
      if (!active) { void bridge.unwatch(id).catch(() => undefined); return }
      watchId = id
      setWatch({ key: watchKey, id })
      setError(undefined)
      const value = pendingViews.get(id)
      pendingViews.clear()
      if (value) applyView(value)
    }).catch((failure: unknown) => {
      pendingViews.clear()
      if (active) {
        setWatch(undefined)
        setView((previous) => previous?.key === viewKey ? { key: viewKey, value: { ...previous.value, state: 'offline', canSend: false } } : previous)
        setError(failure instanceof Error ? failure.message : 'Agent Host access is unavailable.')
      }
    })
    return () => { active = false; pendingViews.clear(); unlisten(); if (watchId) void bridge.unwatch(watchId).catch(() => undefined) }
  }, [bridge, sessionId, chatId, clientId, machineName, catalogKey, watchKey, viewKey, key, onTitles])
  const activeTurn = view?.chat?.activeTurn
  const responding = Boolean(activeTurn)
  const pending = Boolean(view?.pendingTurn)
  const historyBusy = Boolean(view?.historyTransfer || view?.history?.loading)
  const panelBusy = busy || pending || responding
  const notifyBusy = useEffectEvent((value: boolean) => { onBusy?.(value, panelKey) })
  useEffect(() => { notifyBusy(panelBusy) }, [panelBusy])
  useEffect(() => () => { notifyBusy(false) }, [])
  useEffect(() => {
    if (following.current && log.current) {
      log.current.scrollTop = log.current.scrollHeight
      lastScrollTop.current = log.current.scrollTop
    }
  }, [view])
  useLayoutEffect(() => {
    const anchor = historyAnchor.current
    const element = log.current
    if (!anchor || !element) return
    if (anchor.key !== watchKey) { historyAnchor.current = undefined; return }
    if (view?.history?.loading) return
    if ((view?.chat?.turns.length ?? 0) > anchor.count) {
      const turn = [...element.querySelectorAll<HTMLElement>('[data-turn-id]')].find((item) => item.dataset.turnId === anchor.turnId)
      if (turn && turn.getBoundingClientRect().height > 0) element.scrollTop += turn.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset
      else element.scrollTop = anchor.top + element.scrollHeight - anchor.height
      lastScrollTop.current = element.scrollTop
    }
    historyAnchor.current = undefined
  }, [view, watchKey])
  useEffect(() => {
    const element = log.current
    if (!element) return
    let frame: number | undefined
    const resize = () => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        logSize.current = { width: element.clientWidth, height: element.clientHeight }
        if (following.current) element.scrollTop = element.scrollHeight
        lastScrollTop.current = element.scrollTop
      })
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : undefined
    observer?.observe(element)
    window.addEventListener('resize', resize)
    resize()
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [])
  async function loadEarlierHistory(): Promise<void> {
    if (!bridge || !watchId || view?.state !== 'connected' || !view.history?.hasMore || view.history.loading || historyRequest.current === watchId) return
    const element = log.current
    const top = element?.getBoundingClientRect().top ?? 0
    const anchor = element && [...element.querySelectorAll<HTMLElement>('[data-turn-id]')].find((item) => item.getBoundingClientRect().bottom > top)
    if (element) historyAnchor.current = {
      key: watchKey, turnId: anchor?.dataset.turnId, offset: (anchor?.getBoundingClientRect().top ?? top) - top,
      top: element.scrollTop, height: element.scrollHeight, count: view.chat?.turns.length ?? 0,
    }
    following.current = false
    historyRequest.current = watchId
    setHistoryLoadError(undefined)
    try { await bridge.loadHistory(watchId) }
    catch (failure) {
      if (mounted.current) setHistoryLoadError({ key: watchKey, message: failure instanceof Error ? failure.message : 'Earlier history could not be loaded. Retry when the owner is available.' })
    } finally {
      if (historyRequest.current === watchId) historyRequest.current = undefined
    }
  }
  function confirm(command: { id: string; text: string; draft: string; images: ChatImageAttachment[] }): void {
    if (attempted.current?.id !== command.id) return
    firstMessageSent.current = true
    setDraft((current) => current.trim() === command.draft ? '' : current)
    setImages((current) => current.filter((image) => !command.images.some((sent) => sent.id === image.id)))
    attempted.current = undefined
    setError(undefined)
  }
  const confirmed = useEffectEvent(() => { if (attempted.current) confirm(attempted.current) })
  useEffect(() => {
    const command = attempted.current
    if (command && (view?.chat?.activeTurn?.id === command.id || view?.chat?.turns.some((turn) => turn.id === command.id))) confirmed()
  }, [view])
  const canSend = Boolean(bridge && watchId && modelReady && !configErrors.length && !busy && !pending && !activeTurn && !view?.readOnly && (view?.canSend || view?.state === 'offline'))
  function chooseModel(id: string, config?: ModelConfig): void {
    const provider = models[0]?.provider
    if (!provider) {
      setError('Reload the model catalog before changing the model selection.')
      return
    }
    const preferenceError = saveModelPreference(clientId, provider, id ? { id, ...(config ? { config } : {}) } : undefined)
    setSelection({ key, provider, id, config, preferenceError })
  }
  async function send(): Promise<void> {
    if (!canSend || !bridge || operating.current || imageInput.isReading() || !draft.trim() && !images.length) return
    operating.current = true
    following.current = true
    if (log.current) log.current.scrollTop = log.current.scrollHeight
    setBusy(true)
    setError(undefined)
    const command = { id: crypto.randomUUID(), text: draft.trim(), draft: draft.trim(), images }
    attempted.current = command
    try {
      if (prepareFirstMessage && !firstMessageSent.current && !view?.chat?.turns.length) command.text = await prepareFirstMessage(command.draft)
      if (!mounted.current) return
      await bridge.send(target, command.id, command.text, command.images.length ? command.images : undefined, { id: modelId, ...(Object.keys(config).length ? { config } : {}) })
      confirm(command)
    } catch (failure) { if (attempted.current?.id === command.id) setError(failure instanceof Error ? failure.message : 'Delivery was not confirmed. Inspect the original before retrying.') }
    // Hidden Activities retain state even while their effects are paused.
    finally { operating.current = false; setBusy(false) }
  }
  async function cancel(): Promise<void> {
    if (!bridge || !activeTurn || view?.readOnly || operating.current) return
    operating.current = true
    setBusy(true)
    try { await bridge.cancel(target, activeTurn.id) } catch (failure) { setError(failure instanceof Error ? failure.message : 'The original turn could not be cancelled.') }
    finally { operating.current = false; setBusy(false) }
  }
  async function reviewDelivery(action: 'check' | 'abandon'): Promise<void> {
    const id = view?.pendingTurn?.id
    if (!bridge || !id || view?.state !== 'connected' || operating.current
      || action === 'abandon' && (deliveryReview?.id !== id || deliveryReview.status !== 'not-found' || !deliveryReview.acknowledged)) return
    operating.current = true
    setBusy(true)
    setDeliveryReview({ id, status: action === 'check' ? 'checking' : 'abandoning', acknowledged: action === 'abandon' })
    try {
      const result = await bridge.resolveDelivery(target, id, action, action === 'abandon' ? true : undefined)
      if (!mounted.current) return
      if (result === 'not-found') setDeliveryReview({ id, status: 'not-found', acknowledged: false })
      else {
        if (result === 'abandoned' && attempted.current?.id === id) attempted.current = undefined
        setDeliveryReview(undefined)
        setError(undefined)
      }
    } catch (failure) {
      if (mounted.current) setDeliveryReview({ id, status: 'failed', acknowledged: false,
        error: failure instanceof Error ? failure.message : 'The delivery check failed. The original attempt remains blocked.' })
    } finally { operating.current = false; setBusy(false) }
  }
  async function reconnect(): Promise<void> {
    if (operating.current) return
    operating.current = true
    setBusy(true)
    setError(undefined)
    try {
      await beforeReconnect?.()
      setRevision((value) => value + 1)
    } catch (failure) {
      setCatalog({ key: catalogKey, models: [], error: failure instanceof Error ? failure.message : 'The original session could not be verified. Reconnect to retry.' })
    } finally { operating.current = false; setBusy(false) }
  }
  const reconnectFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.repeat
      || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
      || event.key !== 'F5' || !active || document.querySelector('dialog[open]')
      || panel.current?.closest('[inert]')) return
    event.preventDefault()
    if (!bridge || busy) return
    void reconnect()
  })
  useEffect(() => {
    if (!active) return
    const handle = (event: KeyboardEvent) => reconnectFromShortcut(event)
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [active])
  const connectionError = error ?? view?.error
  const catalogError = currentCatalog?.error !== connectionError ? currentCatalog?.error : undefined
  const historyFailure = view?.history?.error ?? (historyLoadError?.key === watchKey ? historyLoadError.message : undefined)
  const stateLabel = !bridge ? 'Desktop update required' : !view && (error || currentCatalog?.error) ? 'Connection failed' : !view || view.state === 'connecting' ? view?.historyTransfer ? historyTransferLabel(view.historyTransfer) : 'Connecting...' : view.state === 'offline' ? 'Offline history' : pending ? 'Delivery pending' : activeTurn ? 'Agent responding' : historyBusy ? 'Loading earlier history...' : view.readOnly ? 'Read only' : 'Connected'
  const modelStatus = !bridge ? 'Desktop update required.' : view?.state !== 'connected' ? undefined : !currentCatalog ? 'Loading models from the owner Host...' : currentCatalog.error ? undefined : !modelId ? 'Choose a model below to enable sending.' : !modelReady ? 'The selected model is unavailable. Choose another model or retry loading models.' : undefined
  const liveHostTitle = view?.target && agentHostKey(view.target) === key ? (view.chat?.title || view.sessionTitle) : undefined
  const displayTitle = customTitle || sessionTitle(target, liveHostTitle) || cachedTitle || 'Original Host chat'
  const editingTitle = editingTitleKey === key
  const detailsOpen = active && detailsKey === key
  const updateBlocker = busy || activeTurn || pending || imageInput.reading
    ? 'Wait for Agent Host work and image processing to finish before updating.'
    : draft.length || images.length ? 'Send or clear unsent chat text and images before updating. Drafts are not discarded by an update.' : undefined
  const chatActions = <>
    {onSplitRight && <IconButton icon="split-horizontal" label="Split chat right" title="Split chat right (Ctrl+\) · Alt+Click to split down" aria-keyshortcuts="Control+Backslash" onClick={(event) => { setDetailsKey(undefined); if (event.altKey && onSplitDown) onSplitDown(); else onSplitRight() }} />}
    {onToggleSplitOrientation && <IconButton icon={splitOrientation === 'vertical' ? 'split-horizontal' : 'split-vertical'} label={splitOrientation === 'vertical' ? 'Switch to left/right split' : 'Switch to top/bottom split'} title={splitOrientation === 'vertical' ? 'Switch to left/right split' : 'Switch to top/bottom split'} onClick={() => { setDetailsKey(undefined); onToggleSplitOrientation() }} />}
    {onSwapSplit && <IconButton icon="arrow-swap" label="Swap split panes" title="Swap split panes" onClick={() => { setDetailsKey(undefined); onSwapSplit() }} />}
    {onPopOut && <IconButton icon="empty-window" label="Open session in new window" title="Open session in new window (right-click header for Move / Copy)" onClick={() => {
      setDetailsKey(undefined)
      const snapshot = draft
      void Promise.resolve(onPopOut(snapshot)).then((transferred) => {
        if (transferred) setDraft((current) => current === snapshot ? '' : current)
      })
    }} />}
    {onDevices && <IconButton icon="remote" label="Manage devices" onClick={() => { setDetailsKey(undefined); onDevices() }} />}
    <IconButton icon="refresh" label="Reconnect Agent Host" title="Reconnect Agent Host (F5)" aria-keyshortcuts="F5" disabled={busy} onClick={() => { setDetailsKey(undefined); void reconnect() }} />
    {onDetach && <IconButton icon="debug-disconnect" label="Detach conversation" disabled={busy || pending} onClick={() => { setDetailsKey(undefined); onDetach() }} />}
    {!workspace && !hideClose && <IconButton icon="close" label={closeLabel} onClick={() => { setDetailsKey(undefined); onClose() }} />}
  </>
  const HeaderTag = headerTarget ? 'div' : 'header'
  const header = <HeaderTag className="ahp-chat-header" aria-label="Chat header" role={headerTarget ? 'group' : undefined} onContextMenu={onHeaderContextMenu ? (event) => {
    event.preventDefault()
    event.stopPropagation()
    onActivatePane?.()
    onHeaderContextMenu(
      { x: event.clientX, y: event.clientY },
      () => draftSnapshotRef.current,
      (snapshot) => setDraft((current) => current === snapshot ? '' : current),
      onRenameTitle ? () => setEditingTitleKey(key) : undefined,
    )
  } : undefined}>
    <div className="ahp-chat-title">
      {!minimalHeader && <Icon name="copilot" />}
      {showTaskBadge && task && <span className="ahp-chat-task-badge" title={task.title}>{task.id}</span>}
      {editingTitle && onRenameTitle ? (
        <HeaderTitleInput
          value={displayTitle}
          onFinish={(next) => {
            setEditingTitleKey(undefined)
            if (next !== undefined) {
              const trimmed = next.trim()
              if (trimmed !== displayTitle) onRenameTitle(trimmed ? trimmed : null)
            }
          }}
        />
      ) : (
        <strong
          title={displayTitle}
          onDoubleClick={onRenameTitle ? (event) => {
            event.stopPropagation()
            setEditingTitleKey(key)
          } : undefined}
        >{displayTitle}</strong>
      )}
      {sessionSwitcher}
    </div>
    <div className="ahp-chat-meta">
      <span className="ahp-chat-status" role="status" data-state={stateLabel} title={stateLabel}><span aria-hidden="true" /><span className="ahp-chat-state-label">{stateLabel}</span></span>
      <span className="ahp-chat-machine" title={machineName}>{!minimalHeader && <Icon name="server" />}<span>{minimalHeader ? ownerLabel : `Copilot @ ${ownerLabel}`}</span></span>
    </div>
    <div className="ahp-chat-actions">
      <IconButton icon={headerTarget || minimalHeader ? 'ellipsis' : 'info'} label="Chat details" title={headerTarget || minimalHeader ? 'Chat details and actions' : 'Chat details'} aria-haspopup="dialog" aria-expanded={detailsOpen} onClick={() => setDetailsKey(key)} />
      {minimalHeader
        ? (!workspace && !hideClose && <IconButton icon="close" label={closeLabel} onClick={() => { setDetailsKey(undefined); onClose() }} />)
        : <div className="ahp-chat-secondary-actions">{chatActions}</div>}
    </div>
  </HeaderTag>
  return <ChatLinkTargetContext.Provider value={stableTarget}><ChatLinkActiveContext.Provider value={active}><aside ref={panel} className="chat-panel ahp-panel" data-pane-slot={paneSlot} data-pane-focused={paneSlot && paneSlot !== 'single' ? active || undefined : undefined} aria-label={workspace ? 'Agent Host task creation chat' : paneSlot === 'secondary' ? 'Secondary split Agent Host task chat' : 'Agent Host task chat'} aria-keyshortcuts="F5" data-update-blocker={updateBlocker} onPointerDownCapture={onActivatePane ? () => onActivatePane() : undefined} onFocusCapture={onActivatePane ? () => onActivatePane() : undefined}>
    {headerTarget ? active && createPortal(header, headerTarget) : visible && header}
    {detailsOpen && <Dialog title="Chat details" className="ahp-chat-details" onClose={() => setDetailsKey(undefined)}>
      <dl>
        <dt>Conversation</dt><dd>{displayTitle}</dd>
        <dt>{workspace ? 'Workspace' : 'Task'}</dt><dd>{contextLabel}</dd>
        <dt>Machine</dt><dd>{ownerLabel}</dd>
        <dt>Hostname</dt><dd>{machineName}</dd>
        <dt>Owner ID</dt><dd><code>{clientId}</code></dd>
        <dt>Session ID</dt><dd><code>{sessionId}</code></dd>
        <dt>Chat ID</dt><dd><code>{chatId}</code></dd>
        <dt>Protocol</dt><dd>{view?.protocolVersion ? `AHP ${view.protocolVersion}` : 'Not negotiated'}</dd>
      </dl>
      {(headerTarget || minimalHeader) && <div className="dialog-actions" role="group" aria-label="Chat actions">{chatActions}</div>}
    </Dialog>}
    <div className="chat-log" ref={log} role="log" aria-label={`Agent Host conversation for ${contextLabel}`} aria-live="polite" onCopy={(event) => {
      try { copyMarkdownSelection(event) }
      catch { event.preventDefault(); setError('The selected chat links could not be copied. Try a smaller selection or copy a link address.') }
    }} onScroll={(event) => {
      const element = event.currentTarget
      // Reflow scroll events are not a user leaving the bottom of the chat.
      if (element.clientWidth !== logSize.current.width || element.clientHeight !== logSize.current.height) return
      const upward = element.scrollTop < lastScrollTop.current
      lastScrollTop.current = element.scrollTop
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60
      if (upward && element.scrollTop < 120) void loadEarlierHistory()
    }}>
      {(view?.history?.hasMore || historyFailure) && <div className="ahp-history-pagination">
        {view?.history?.hasMore && <button type="button" className="text-button" disabled={!watchId || view.state !== 'connected' || view.history.loading} onClick={() => { void loadEarlierHistory() }}>
          <Icon name={view.history.loading ? 'loading' : 'chevron-up'} className={view.history.loading ? 'codicon-modifier-spin' : ''} />
          {view.history.loading ? 'Loading earlier messages...' : 'Load earlier messages'}
        </button>}
        {view?.state === 'offline' && <p className="muted">Only previously loaded history is available offline.</p>}
        {historyFailure && <p className="copilot-error" role="alert">{historyFailure}</p>}
      </div>}
      <ChatTranscript view={view} machineName={machineName} ownerDisplay={ownerDisplay} aliases={aliases} models={models} userProfile={userProfile} owner={ownerLabel} bridge={bridge} watchId={watchId} />
    </div>
    <form className="composer-area" onSubmit={(event) => { event.preventDefault(); void send() }}>
      <ChatImageStatus input={imageInput} />
      {connectionError && <p className="copilot-error vscode-chat-notice" role="alert">{connectionError}</p>}
      {view?.pendingTurn?.state === 'uncertain' && <div className="vscode-chat-notice" role="group" aria-label="Resolve uncertain delivery">
        <p role="status">Delivery outcome unknown. The previous message was not replayed. Check the original chat on {machineName} before another send.</p>
        <button type="button" className="text-button" disabled={busy || view.state !== 'connected'} onClick={() => { void reviewDelivery('check') }}>Check original chat for this turn</button>
        {view.state !== 'connected' && <p>Reconnect Agent Host before checking delivery.</p>}
        {deliveryReview?.id === view.pendingTurn.id && deliveryReview.status === 'not-found' && <>
          <p>This turn is not in the current Host snapshot. It may still arrive later. Only continue after checking the original chat yourself.</p>
          <label><input type="checkbox" checked={deliveryReview.acknowledged} onChange={(event) => setDeliveryReview((current) => current && current.id === view.pendingTurn?.id ? { ...current, acknowledged: event.target.checked } : current)} /> I checked the original chat and accept the risk of a later duplicate.</label>
          <button type="button" className="text-button" disabled={busy || !deliveryReview.acknowledged} onClick={() => { void reviewDelivery('abandon') }}>Abandon this attempt and unlock sending</button>
        </>}
        {deliveryReview?.id === view.pendingTurn.id && deliveryReview.error && <p className="copilot-error" role="alert">{deliveryReview.error}</p>}
      </div>}
      {view?.chat?.draft?.text && <p className="vscode-chat-notice muted">The owner has an unsent draft.</p>}
      {catalogError && <p className="copilot-error vscode-chat-notice" role="alert">{catalogError}</p>}
      {onSessions && !view && (error || currentCatalog?.error) && <button type="button" className="text-button" disabled={busy} onClick={onSessions}><Icon name="link" />Review session link</button>}
      {modelStatus && <p className="message-notice" role="status">{modelStatus}</p>}
      {preferenceError && <p className="copilot-error message-notice" role="alert">{preferenceError}</p>}
      {configErrors.map((message) => <p key={message} className="copilot-error message-notice" role="alert">{message}</p>)}
      <div className="composer">
        <ChatImages images={images} onRemove={imageInput.remove} disabled={busy} />
        <textarea ref={composer} id={active ? 'chat-composer' : undefined} aria-label="Message Agent Host" placeholder="Message original Agent" rows={3} maxLength={MAX_CHAT_TEXT_LENGTH} value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={imageInput.paste} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
        <div className="composer-toolbar">
          <div className="ahp-model-controls">
            <label title={selectedModel?.name ?? 'Your model and options are remembered on this device for this Agent Host provider.'}><Icon name="copilot" /><select aria-label="Agent Host model" value={modelId} disabled={busy || pending || responding || view?.readOnly || !models.length} onChange={(event) => chooseModel(event.target.value)}><option value="">{!currentCatalog ? 'Loading models...' : !models.length ? 'Models unavailable' : 'Choose a model'}</option>{modelId && !modelReady && <option value={modelId} disabled>{modelId} (unavailable)</option>}{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
          </div>
          {selectedModel && <AgentHostModelOptions key={`${key}:${selectedModel.provider}:${modelId}`} schema={selectedModel.configSchema} config={config} disabled={busy || pending || responding || Boolean(view?.readOnly)} onChange={(config) => chooseModel(modelId, config)} />}
          <IconButton icon="refresh" label="Retry loading models" title="Retry loading models (F5)" aria-keyshortcuts="F5" disabled={!bridge || busy || !currentCatalog} onClick={() => { void reconnect() }} />
          {activeTurn ? <IconButton icon="debug-stop" label="Stop Agent Host response" disabled={busy || view?.readOnly || view?.state !== 'connected'} onClick={() => { void cancel() }} /> : <button className="send-button" type="submit" aria-label="Send to Agent Host" title="Send to Agent Host" disabled={!canSend || imageInput.reading || !draft.trim() && !images.length}><Icon name="arrow-up" /></button>}
        </div>
      </div>
    </form>
  </aside></ChatLinkActiveContext.Provider></ChatLinkTargetContext.Provider>
})