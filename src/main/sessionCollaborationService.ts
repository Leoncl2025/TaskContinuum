import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { ChatState, ResponsePart, Turn, TurnState } from '@microsoft/agent-host-protocol'
import { agentHostKey } from '../shared/agentHost'
import type { AgentHostSession, AgentHostTarget } from '../shared/agentHost'
import { taskSessionLinks } from '../shared/sessionBindings'
import type { SessionLink, SessionLinksSnapshot } from '../shared/sessionBindings'
import { tasksInSearchOrder } from '../shared/taskTree'
import {
  COLLABORATION_LIMITS, CollaborationError, collaborationContextRequestSchema, collaborationContextResultSchema,
  collaborationMessageLookupSchema, collaborationMessageStatusSchema, collaborationSendRequestSchema,
  collaborationSessionsListRequestSchema, collaborationSessionsListResultSchema,
  collaborationTargetSchema, formatCollaborationTargetRef, parseCollaborationTargetRef, readTaskContinuumCollaborationMeta,
} from '../shared/sessionCollaboration'
import type {
  CollaborationContextRequest, CollaborationContextResult, CollaborationContextTurn, CollaborationMessageStatus,
  CollaborationSendRequest, CollaborationSessionEntry, CollaborationSessionsListRequest, CollaborationSessionsListResult,
  CollaborationTurnStatus, SessionCollaborationApi, TaskContinuumCollaborationMeta,
} from '../shared/sessionCollaboration'
import type { AgentHostConnection } from './agentHostConnection'
import { AgentHostTurnNotDispatchedError } from './agentHostDelivery'
import type { AgentHostManager } from './agentHostManager'
import { canonicalPolicyRoot } from './linkedSessionPolicy'
import { readRepositorySessionLinksForAuthorization } from './repositorySessionLinks'
import { JsonFileSizeError, readJsonBounded, writeTextAtomic } from './shared/storage'
import type { VSCodeDeviceClient } from './vscodeDeviceClient'
import { readTaskWorkspaceMetadata } from './workspaceReader'
import type { WorkspaceTaskMetadata } from './workspaceReader'

const MAX_LEDGER_BYTES = 4 * 1024 * 1024
// The old writer capped record count but not bytes. Bound recovery of those v1 files too.
const MAX_LEGACY_LEDGER_BYTES = 24 * 1024 * 1024
// Enough for the worst-case JSON escaping of a 512-character reason and the final receipt fields.
const PENDING_STATUS_RESERVE_BYTES = 4096

const savedMessageSchema = z.object({
  root: z.string().min(1).max(4096),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceTarget: collaborationTargetSchema.optional(),
  text: z.string().max(COLLABORATION_LIMITS.maxMessageLength).optional(),
  status: collaborationMessageStatusSchema,
}).strict()
type SavedMessage = z.infer<typeof savedMessageSchema>

const messagesDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  messages: z.array(savedMessageSchema).max(COLLABORATION_LIMITS.maxRetainedMessages),
}).strict()

export interface SessionCollaborationDependencies {
  directory: string
  agentHosts: Pick<AgentHostManager, 'authorize' | 'connection' | 'hasConsent'> & {
    local: Pick<AgentHostManager['local'], 'list'>
  }
  devices: Pick<VSCodeDeviceClient, 'list'>
  identity: () => Promise<{ clientId: string; machineName: string; username?: string }>
  readLinks?: (root: string) => Promise<SessionLinksSnapshot>
  readWorkspace?: (root: string) => Promise<{ tasks: readonly WorkspaceTaskMetadata[] }>
  now?: () => number
}

interface NativeCollaborationSource {
  target: AgentHostTarget
  beforeAccept(): Promise<void>
}

function pendingMessage({ status }: SavedMessage): boolean {
  return status.state === 'queued' || status.state === 'dispatching'
}

function expiredMessage(record: SavedMessage, now: number): SavedMessage {
  if (record.status.state !== 'queued' || !record.status.expiresAt || now < Date.parse(record.status.expiresAt)) return record
  return {
    ...record, text: undefined,
    status: {
      ...record.status, state: 'expired', updatedAt: new Date(now).toISOString(),
      reason: 'Queued collaboration message expired before the target session became idle.',
    },
  }
}

function messageTargetKey({ root, status }: SavedMessage): string {
  return collaborationTargetKey(root, parseCollaborationTargetRef(status.targetRef))
}

function collaborationTargetKey(root: string, { sessionId, chatId, ownerClientId }: ReturnType<typeof parseCollaborationTargetRef>): string {
  return `${root}:${agentHostKey({ sessionId, chatId, owner: { clientId: ownerClientId } })}`
}

function targetFromLink({ sessionId, chatId, owner }: SessionLink): AgentHostTarget {
  return { sessionId, chatId, owner }
}

function clipText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false }
  return { text: `${value.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true }
}

function turnOrigin(message: Turn['message']): CollaborationContextTurn['origin'] {
  if (readTaskContinuumCollaborationMeta(message._meta)) return 'collaboration'
  const kind = message.origin.kind
  if (kind === 'agent' || kind === 'tool' || kind === 'automation' || kind === 'systemNotification') return kind
  return 'user'
}

function summarizeParts(parts: readonly ResponsePart[], maxChars: number): { responseText: string; toolSummary: string[]; runningTools: string[]; truncated: boolean } {
  const markdownChunks: string[] = []
  const toolSummary: string[] = []
  const runningTools: string[] = []
  for (const part of parts) {
    if (part.kind === 'markdown') markdownChunks.push(part.content)
    else if (part.kind === 'error') markdownChunks.push(`Error: ${part.error.message}`)
    else if (part.kind === 'toolCall') {
      const name = part.toolCall.displayName || part.toolCall.toolName
      const status = ('success' in part.toolCall && part.toolCall.success === false) || ('error' in part.toolCall && Boolean(part.toolCall.error))
        ? 'failed'
        : part.toolCall.status
      if (toolSummary.length < 64) toolSummary.push(`${name} (${status})`)
      if (part.toolCall.status !== 'completed' && part.toolCall.status !== 'cancelled' && runningTools.length < 32) {
        runningTools.push(name)
      }
    }
  }
  const clipped = clipText(markdownChunks.join('\n\n').trim(), maxChars)
  return { responseText: clipped.text, toolSummary, runningTools, truncated: clipped.truncated }
}

function resolveTurnStatus(chat: ChatState | undefined, turnId: string | undefined): CollaborationTurnStatus | undefined {
  if (!turnId || !chat) return undefined
  if (chat.activeTurn?.id === turnId) return 'in-progress'
  const completed = chat.turns.find((turn) => turn.id === turnId)
  if (!completed) return 'unknown'
  if (completed.state === ('cancelled' as TurnState)) return 'cancelled'
  if (completed.state === ('error' as TurnState)) return 'error'
  return 'completed'
}

export class SessionCollaborationService {
  private readonly messagesFile: string
  private readonly readLinks: (root: string) => Promise<SessionLinksSnapshot>
  private readonly readWorkspace: (root: string) => Promise<{ tasks: readonly WorkspaceTaskMetadata[] }>
  private readonly now: () => number
  private messages: SavedMessage[] = []
  private loading?: Promise<void>
  private writing: Promise<void> = Promise.resolve()
  private activeOperations = 0
  private readonly inFlightMessages = new Map<string, { taskId: string; requestHash: string; completion: Promise<CollaborationMessageStatus> }>()
  private readonly targetOperations = new Map<string, Promise<void>>()
  private readonly scheduledDrains = new Set<string>()
  private readonly watchers = new Map<string, { root: string; target: AgentHostTarget; connection: AgentHostConnection; unlisten: () => void }>()
  private readonly loadedConnections = new Map<string, AgentHostConnection>()
  private readonly expiryTimer: ReturnType<typeof setInterval>
  private closed = false

  constructor(private readonly deps: SessionCollaborationDependencies) {
    this.messagesFile = join(deps.directory, 'session-collaboration-messages.json')
    this.readLinks = deps.readLinks ?? readRepositorySessionLinksForAuthorization
    this.readWorkspace = deps.readWorkspace ?? readTaskWorkspaceMetadata
    this.now = deps.now ?? Date.now
    this.expiryTimer = setInterval(() => {
      void this.expireQueuedMessages().catch(() => {})
    }, 15_000)
    this.expiryTimer.unref()
  }

  get hasActiveWork(): boolean {
    return this.activeOperations > 0 || this.targetOperations.size > 0
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString()
  }

  private async initialize(): Promise<void> {
    this.loading ??= (async () => {
      let recovered = false
      try {
        const document = await readJsonBounded(this.messagesFile, MAX_LEDGER_BYTES).catch((error: unknown) => {
          if (!(error instanceof JsonFileSizeError)) throw error
          return readJsonBounded(this.messagesFile, MAX_LEGACY_LEDGER_BYTES)
        })
        const parsed = messagesDocumentSchema.parse(document)
        const timestamp = this.isoNow()
        this.messages = parsed.messages.map((entry) => {
          if (entry.status.state === 'queued') {
            recovered = true
            return {
              ...entry,
              text: undefined,
              status: {
                ...entry.status,
                state: 'blocked',
                updatedAt: timestamp,
                reason: 'Paused on application restart; queued collaboration messages are not replayed automatically.',
              },
            }
          }
          if (entry.status.state === 'dispatching') {
            recovered = true
            return {
              ...entry,
              text: undefined,
              status: {
                ...entry.status,
                state: 'uncertain',
                updatedAt: timestamp,
                reason: 'Application stopped before delivery confirmation; inspect the target session before sending again.',
              },
            }
          }
          return entry
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new CollaborationError('UNAVAILABLE', 'Session collaboration message ledger is unreadable.')
        }
      }
      if (recovered) await this.writeMessages(this.messages)
    })()
    return this.loading
  }

  private async writeMessages(messages: SavedMessage[], reservePending = false): Promise<void> {
    const payload = messagesDocumentSchema.parse({ schemaVersion: 1, messages })
    const text = JSON.stringify(payload, null, 2) + '\n'
    const reserve = reservePending ? messages.filter(pendingMessage).length * PENDING_STATUS_RESERVE_BYTES : 0
    if (Buffer.byteLength(text) + reserve > MAX_LEDGER_BYTES) {
      throw new CollaborationError('BUSY', 'The collaboration ledger is full. Existing pending messages were kept.')
    }
    try { await writeTextAtomic(this.messagesFile, text) }
    catch {
      throw new CollaborationError('UNAVAILABLE', 'Could not save the collaboration ledger. Check the original message before retrying.')
    }
  }

  private updateMessages<T>(update: (messages: SavedMessage[]) => T, reservePending = false): Promise<T> {
    const operation = this.writing.then(async () => {
      const next = [...this.messages]
      const result = update(next)
      if (next.length !== this.messages.length || next.some((entry, index) => entry !== this.messages[index])) {
        await this.writeMessages(next, reservePending)
        this.messages = next
      }
      return result
    })
    this.writing = operation.then(() => undefined, () => undefined)
    return operation
  }

  private admitMessage(record: SavedMessage): Promise<void> {
    return this.updateMessages((messages) => {
      if (this.closed) throw new CollaborationError('UNAVAILABLE', 'Session collaboration service is closed.')
      if (this.queuedCount(record.root, record.status.taskId) >= COLLABORATION_LIMITS.maxQueuedPerTask) {
        throw new CollaborationError('BUSY', `Too many pending collaboration messages for ${record.status.taskId}. Retry when some finish.`)
      }
      if (messages.length >= COLLABORATION_LIMITS.maxRetainedMessages) {
        const removable = messages.findIndex((entry) => !pendingMessage(entry))
        if (removable < 0) throw new CollaborationError('BUSY', 'The collaboration ledger has too many pending messages.')
        messages.splice(removable, 1)
      }
      messages.push(record)
    }, true)
  }

  private replaceMessage(previous: SavedMessage, next: SavedMessage): Promise<boolean> {
    return this.updateMessages((messages) => {
      const index = messages.indexOf(previous)
      if (index < 0) return false
      messages[index] = next
      return true
    })
  }

  private onTarget<T>(key: string, action: () => Promise<T>): Promise<T> {
    const operation = (this.targetOperations.get(key) ?? Promise.resolve()).then(action)
    const complete = operation.then(() => undefined, () => undefined)
    this.targetOperations.set(key, complete)
    void complete.then(() => {
      if (this.targetOperations.get(key) === complete) this.targetOperations.delete(key)
    })
    return operation
  }

  private async canonicalRoot(root: string): Promise<string> {
    try { return await canonicalPolicyRoot(root) }
    catch { throw new CollaborationError('ACCESS_DENIED', 'The configured workspace is unavailable.') }
  }

  private queuedCount(canonicalRoot: string, taskId?: string): number {
    return this.messages.filter((item) => item.root === canonicalRoot && (taskId === undefined || item.status.taskId === taskId)
      && pendingMessage(item)).length
  }

  private async readWorkspaceTasks(canonicalRoot: string): Promise<readonly WorkspaceTaskMetadata[]> {
    try { return (await this.readWorkspace(canonicalRoot)).tasks }
    catch { throw new CollaborationError('ACCESS_DENIED', 'The task workspace could not be read.') }
  }

  private async readWorkspaceLinks(canonicalRoot: string): Promise<SessionLinksSnapshot['document']['bindings']> {
    try { return (await this.readLinks(canonicalRoot)).document.bindings }
    catch { throw new CollaborationError('ACCESS_DENIED', 'Workspace session bindings are unavailable or Automatic workspace links is disabled.') }
  }

  private async readTaskLinks(canonicalRoot: string, taskId: string): Promise<SessionLink[]> {
    const tasks = await this.readWorkspaceTasks(canonicalRoot)
    if (!tasks.some((task) => task.id === taskId)) {
      throw new CollaborationError('NOT_FOUND', `Task ${taskId} does not exist in this workspace.`)
    }
    return taskSessionLinks(await this.readWorkspaceLinks(canonicalRoot), taskId)
  }

  forWorkspace(root: string, source?: NativeCollaborationSource): SessionCollaborationApi {
    return {
      listSessions: (request) => this.withCapacity(() => this.listSessions(root, collaborationSessionsListRequestSchema.parse(request))),
      readContext: (request) => this.withCapacity(() => this.readContext(root, collaborationContextRequestSchema.parse(request))),
      sendMessage: (request) => this.withCapacity(() => this.sendMessage(root, collaborationSendRequestSchema.parse(request), source)),
      messageStatus: (messageId) => this.withCapacity(() => this.messageStatus(root, collaborationMessageLookupSchema.parse({ messageId }).messageId)),
    }
  }

  private async withCapacity<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) throw new CollaborationError('UNAVAILABLE', 'Session collaboration service is closed.')
    if (this.activeOperations >= COLLABORATION_LIMITS.maxConcurrentOperations) {
      throw new CollaborationError('BUSY', 'Session collaboration capacity is busy. Retry shortly.')
    }
    this.activeOperations++
    try { return await action() }
    finally { this.activeOperations-- }
  }

  private async resolveTargetLink(canonicalRoot: string, targetRef: string, expectedTaskId?: string): Promise<{ taskId: string; link: AgentHostTarget }> {
    const parsed = parseCollaborationTargetRef(targetRef)
    if (expectedTaskId !== undefined && expectedTaskId !== parsed.taskId) {
      throw new CollaborationError('INVALID_REQUEST', 'The targetRef belongs to a different task.')
    }
    const links = await this.readTaskLinks(canonicalRoot, parsed.taskId)
    const binding = links.find((candidate) => candidate.owner.clientId === parsed.ownerClientId
      && candidate.sessionId === parsed.sessionId && candidate.chatId === parsed.chatId)
    if (!binding) throw new CollaborationError('NOT_FOUND', 'The target session is not currently linked to this task.')
    const link = targetFromLink(binding)
    try { await this.deps.agentHosts.authorize(canonicalRoot, link) }
    catch { throw new CollaborationError('ACCESS_DENIED', 'The target session is not authorized on this device.') }
    return { taskId: parsed.taskId, link }
  }

  private async listSessions(root: string, request: CollaborationSessionsListRequest): Promise<CollaborationSessionsListResult> {
    await this.initialize()
    const canonical = await this.canonicalRoot(root)
    await this.expireQueuedMessages()
    const [tasks, bindings] = await Promise.all([this.readWorkspaceTasks(canonical), this.readWorkspaceLinks(canonical)])
    const start = request.taskId ? tasks.find((task) => task.id === request.taskId) : undefined
    if (request.taskId && !start) throw new CollaborationError('NOT_FOUND', `Task ${request.taskId} does not exist in this workspace.`)

    const [me, remoteDevices] = await Promise.all([
      this.deps.identity(),
      this.deps.devices.list(canonical, false).catch(() => []),
    ])
    const peers = new Map(remoteDevices.map((device) => [device.ownerClientId, device]))
    let localCatalog: Map<string, AgentHostSession> | undefined
    let localConsented = false
    const terms = request.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
    const limit = request.limit ?? COLLABORATION_LIMITS.maxSessionPageSize
    const offset = request.offset ?? 0
    let position = 0
    let nextOffset: number | undefined
    const sessions: CollaborationSessionEntry[] = []
    search: for (const task of tasksInSearchOrder(tasks, start)) {
      for (const link of taskSessionLinks(bindings, task.id)) {
        const index = position++
        if (index < offset) continue
        if (sessions.length >= limit) {
          nextOffset = index
          break search
        }
        const key = agentHostKey(link)
        const cached = this.getLoadedConnection(`${canonical}:${key}`)
        const isLocal = link.owner.clientId === me.clientId
        if (isLocal && !cached?.title && !localCatalog) {
          localConsented = await this.deps.agentHosts.hasConsent(canonical).catch(() => false)
          const localSessions = localConsented
            ? (await this.deps.agentHosts.local.list().catch(() => ({ sessions: [] }))).sessions
            : []
          localCatalog = new Map(localSessions.map((session) => [agentHostKey(session), session]))
        }
        const discovered = isLocal ? localCatalog?.get(key) : undefined
        const title = cached?.title || discovered?.title || link.sessionId
        if (terms.length) {
          const text = `${title} ${task.id} ${task.title} ${link.owner.machineName} ${link.sessionId} ${link.chatId}`.toLowerCase()
          if (!terms.every((term) => text.includes(term))) continue
        }
        try { await this.deps.agentHosts.authorize(canonical, targetFromLink(link)) }
        catch { continue }
        const peer = isLocal ? undefined : peers.get(link.owner.clientId)
        sessions.push({
          targetRef: formatCollaborationTargetRef(task.id, link),
          taskId: task.id,
          sessionId: link.sessionId,
          chatId: link.chatId,
          title: title.slice(0, COLLABORATION_LIMITS.maxSessionListTitleLength),
          owner: link.owner,
          location: isLocal ? 'local' : 'remote',
          state: cached?.state === 'connected' || discovered ? 'connected' : (peer?.state ?? (isLocal ? 'available' : 'offline')),
          canSend: cached ? !cached.readOnly : (discovered?.canSend ?? (isLocal ? localConsented : Boolean(peer?.enabled))),
        })
      }
    }

    return collaborationSessionsListResultSchema.parse({
      ...(request.taskId ? { taskId: request.taskId } : {}),
      collaboration: { queuedCount: this.queuedCount(canonical) },
      sessions,
      ...(nextOffset === undefined ? {} : { nextOffset }),
    })
  }

  private getLoadedConnection(key: string): AgentHostConnection | undefined {
    const cached = this.loadedConnections.get(key)
    if (cached?.isClosed) {
      this.loadedConnections.delete(key)
      return undefined
    }
    return cached
  }

  private async acquireAuthorizedConnection(canonicalRoot: string, link: AgentHostTarget): Promise<{ connection: AgentHostConnection; release: () => void }> {
    const key = `${canonicalRoot}:${agentHostKey(link)}`
    for (let attempt = 0; attempt < 2; attempt++) {
      let release: (() => void) | undefined
      try {
        const connection = await this.deps.agentHosts.connection(canonicalRoot, link)
        if (connection.isClosed) {
          this.loadedConnections.delete(key)
          if (attempt === 0) continue
        }
        release = connection.retain()
        this.loadedConnections.set(key, connection)
        await connection.open()
        if (this.closed) {
          release()
          throw new CollaborationError('UNAVAILABLE', 'Session collaboration service is closed.')
        }
        return { connection, release }
      } catch (error) {
        release?.()
        if (error instanceof CollaborationError && this.closed) throw error
        throw new CollaborationError('UNAVAILABLE', 'Could not connect to the target Agent Host session.')
      }
    }
    throw new CollaborationError('UNAVAILABLE', 'Could not connect to the target Agent Host session.')
  }

  private async readContext(root: string, request: CollaborationContextRequest): Promise<CollaborationContextResult> {
    await this.initialize()
    const canonical = await this.canonicalRoot(root)
    const { taskId, link } = await this.resolveTargetLink(canonical, request.targetRef)
    const { connection, release } = await this.acquireAuthorizedConnection(canonical, link)
    try {
      await this.resolveTargetLink(canonical, request.targetRef, taskId)

      let view = connection.view
      if (!view.chat) throw new CollaborationError('UNAVAILABLE', 'Target session history is not available yet.')
      if (request.cursor !== undefined) {
        let existingIndex = view.chat.turns.findIndex((turn) => turn.id === request.cursor)
        while ((existingIndex < 0 || existingIndex < request.limit) && view.history?.hasMore) {
          try { await connection.loadHistory() }
          catch { throw new CollaborationError('UNAVAILABLE', 'Could not load earlier history for the requested cursor.') }
          await this.resolveTargetLink(canonical, request.targetRef, taskId)
          view = connection.view
          if (!view.chat) break
          const updatedIndex = view.chat.turns.findIndex((turn) => turn.id === request.cursor)
          if (updatedIndex === existingIndex) break
          existingIndex = updatedIndex
        }
      }
      const chat = view.chat!
      let end = chat.turns.length
      if (request.cursor !== undefined) {
        end = chat.turns.findIndex((turn) => turn.id === request.cursor)
        if (end < 0) throw new CollaborationError('INVALID_REQUEST', 'The requested context cursor was not found in the target session.')
      }
      const start = Math.max(0, end - request.limit)
      const selectedTurns = chat.turns.slice(start, end)
      const messageLimit = request.detail === 'full' ? 8_000 : 1_200
      const responseLimit = request.detail === 'full' ? 16_000 : 2_400

      const serializedTurns: CollaborationContextTurn[] = []
      let usedBytes = 0
      let overallTruncated = false
      for (let index = selectedTurns.length - 1; index >= 0; index--) {
        const turn = selectedTurns[index]
        const clippedMessage = clipText(turn.message.text, messageLimit)
        const summary = summarizeParts(turn.responseParts, responseLimit)
        const candidate: CollaborationContextTurn = {
          turnId: turn.id,
          origin: turnOrigin(turn.message),
          messageText: clippedMessage.text,
          responseText: summary.responseText,
          toolSummary: summary.toolSummary,
          truncated: clippedMessage.truncated || summary.truncated,
        }
        const bytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8')
        if (serializedTurns.length > 0 && usedBytes + bytes > COLLABORATION_LIMITS.maxContextBytes - 4096) {
          overallTruncated = true
          break
        }
        usedBytes += bytes
        overallTruncated ||= candidate.truncated
        serializedTurns.unshift(candidate)
      }

      const effectiveStart = end - serializedTurns.length
      const hasMoreHistory = effectiveStart > 0 || Boolean(view.history?.hasMore)
      const hasDraft = Boolean(chat.draft?.text || chat.draft?.attachments?.length)
      const chatStatus = view.pendingTurn?.state === 'uncertain' ? 'uncertainDelivery'
        : hasDraft ? 'hasDraft'
          : (chat.activeTurn || view.pendingTurn) ? 'inProgress' : 'idle'

      let activeTurnSummary: CollaborationContextResult['activeTurn']
      if (chat.activeTurn) {
        const clippedMsg = clipText(chat.activeTurn.message.text, 1_200)
        const activeParts = summarizeParts(chat.activeTurn.responseParts, 2_400)
        overallTruncated ||= clippedMsg.truncated || activeParts.truncated
        activeTurnSummary = {
          turnId: chat.activeTurn.id,
          origin: turnOrigin(chat.activeTurn.message),
          messagePreview: clippedMsg.text,
          responsePreview: activeParts.responseText,
          runningTools: activeParts.runningTools,
        }
      }

      const nativePending = (chat.queuedMessages?.length ?? 0) + (chat.steeringMessage ? 1 : 0)
      const tcPending = this.messages.filter((item) => item.root === canonical && item.status.targetRef === request.targetRef
        && (item.status.state === 'queued' || item.status.state === 'dispatching')).length

      return collaborationContextResultSchema.parse({
        taskId,
        targetRef: request.targetRef,
        title: chat.title || link.sessionId,
        state: view.state,
        canSend: view.state === 'connected' && !view.readOnly,
        readOnly: view.readOnly,
        chatStatus,
        ...(activeTurnSummary ? { activeTurn: activeTurnSummary } : {}),
        pendingCount: nativePending + tcPending,
        turns: serializedTurns,
        hasMoreHistory,
        ...(hasMoreHistory && serializedTurns.length > 0 ? { nextCursor: serializedTurns[0].turnId } : {}),
        truncated: overallTruncated,
      })
    } finally { release() }
  }

  private enrichStatus(record: SavedMessage): CollaborationMessageStatus {
    if ((record.status.state === 'delivered' || record.status.state === 'uncertain') && record.status.turnId) {
      const connection = this.getLoadedConnection(messageTargetKey(record))
      const liveTurnStatus = resolveTurnStatus(connection?.view.chat, record.status.turnId)
      if (liveTurnStatus && liveTurnStatus !== record.status.turnStatus) {
        return collaborationMessageStatusSchema.parse({ ...record.status, turnStatus: liveTurnStatus })
      }
    }
    return collaborationMessageStatusSchema.parse(record.status)
  }

  private async sendMessage(root: string, request: CollaborationSendRequest, source?: NativeCollaborationSource): Promise<CollaborationMessageStatus> {
    await this.initialize()
    const canonical = await this.canonicalRoot(root)
    const parsedTarget = parseCollaborationTargetRef(request.targetRef)
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ taskId: parsedTarget.taskId, targetRef: request.targetRef, text: request.text }))
      .digest('hex')
    const key = `${canonical}:${request.messageId}`
    const inFlight = this.inFlightMessages.get(key)
    const existing = this.messages.find((item) => item.root === canonical && item.status.messageId === request.messageId)
    if (inFlight) {
      await this.readTaskLinks(canonical, inFlight.taskId)
      await source?.beforeAccept()
      if (inFlight.requestHash !== requestHash) throw new CollaborationError('CONFLICT', 'This messageId already belongs to different collaboration content or target.')
      return inFlight.completion
    }
    if (existing) {
      await this.readTaskLinks(canonical, existing.status.taskId)
      await source?.beforeAccept()
      if (existing.requestHash !== requestHash) {
        throw new CollaborationError('CONFLICT', 'This messageId already belongs to different collaboration content or target.')
      }
      await this.expireQueuedMessages()
      return this.enrichStatus(this.messages.find((item) => item.root === canonical && item.status.messageId === request.messageId) ?? existing)
    }

    const targetKey = collaborationTargetKey(canonical, parsedTarget)
    const completion = this.onTarget(targetKey, () => this.sendToTarget(canonical, targetKey, request, requestHash, source))
    this.inFlightMessages.set(key, { taskId: parsedTarget.taskId, requestHash, completion })
    try { return await completion }
    finally { this.inFlightMessages.delete(key) }
  }

  private async sendToTarget(canonical: string, targetKey: string, request: CollaborationSendRequest, requestHash: string,
    source?: NativeCollaborationSource): Promise<CollaborationMessageStatus> {
    if (this.closed) throw new CollaborationError('UNAVAILABLE', 'Session collaboration service is closed.')
    await this.expireQueuedMessages()
    const { taskId, link } = await this.resolveTargetLink(canonical, request.targetRef)
    if (this.queuedCount(canonical, taskId) >= COLLABORATION_LIMITS.maxQueuedPerTask) {
      throw new CollaborationError('BUSY', `Too many pending collaboration messages for ${taskId}. Retry when some finish.`)
    }

    const { connection, release } = await this.acquireAuthorizedConnection(canonical, link)
    try {
      await this.resolveTargetLink(canonical, request.targetRef, taskId)

      await source?.beforeAccept()
      const view = connection.view
      if (view.readOnly) {
        throw new CollaborationError('ACCESS_DENIED', 'The target session is read-only or does not allow sending.')
      }
      const sourceTarget = source && collaborationTargetSchema.parse(source.target)
      const createdAt = this.isoNow()
      const blockedReason = view.chat?.draft?.text || view.chat?.draft?.attachments?.length
        ? 'Target session has an unsent human draft; collaboration message was not sent.'
        : view.pendingTurn?.state === 'uncertain' ? 'Target session has an uncertain delivery awaiting manual review.' : undefined
      const hasQueuedAhead = this.messages.some((item) => item.status.state === 'queued' && messageTargetKey(item) === targetKey)
      const targetBusy = hasQueuedAhead
        || Boolean(view.chat?.activeTurn) || Boolean(view.pendingTurn) || Boolean(view.chat?.queuedMessages?.length)
      const queued = !blockedReason && targetBusy
      const record: SavedMessage = {
        root: canonical,
        requestHash,
        sourceTarget,
        ...(queued ? { text: request.text } : {}),
        status: {
          messageId: request.messageId,
          taskId,
          targetRef: request.targetRef,
          state: blockedReason ? 'blocked' : queued ? 'queued' : 'dispatching',
          createdAt,
          updatedAt: createdAt,
          ...(queued ? {
            expiresAt: new Date(this.now() + COLLABORATION_LIMITS.messageTtlMs).toISOString(),
            reason: 'Target session is currently busy; message is queued until the current turn finishes.',
          } : { reason: blockedReason }),
        },
      }
      await this.admitMessage(record)
      if (queued) {
        this.watchTargetForQueue(targetKey, canonical, link, connection)
        this.scheduleDrainTarget(targetKey)
      }
      if (record.status.state !== 'dispatching') return this.enrichStatus(record)
      return this.enrichStatus(await this.dispatchNow(canonical, record, request.text, link, connection, source?.beforeAccept))
    } finally { release() }
  }

  private async authorizeSource(root: string, source: AgentHostTarget): Promise<void> {
    try {
      await this.deps.agentHosts.authorize(root, source)
    } catch {
      throw new CollaborationError('ACCESS_DENIED', 'The originating chat is no longer authorized for this workspace.')
    }
  }

  private async dispatchNow(canonicalRoot: string, record: SavedMessage, messageText: string, link: AgentHostTarget, connection: AgentHostConnection,
    beforeDispatch?: () => Promise<void>): Promise<SavedMessage> {
    let status: CollaborationMessageStatus
    try {
      const actor = await this.deps.identity()
      const source = record.sourceTarget
      const nativeSourceSupported = link.owner.clientId === actor.clientId || connection.supportsNativeCollaborationSource
      const collaborationMeta: TaskContinuumCollaborationMeta = {
        version: 1,
        taskId: record.status.taskId,
        messageId: record.status.messageId,
        senderDevice: {
          clientId: actor.clientId,
          machineName: actor.machineName,
          ...(actor.username ? { username: actor.username } : {}),
        },
        sourceKind: source && nativeSourceSupported ? 'agent-host-client' : 'mcp-client',
        ...(source?.owner.clientId === actor.clientId ? { sourceTarget: source } : {}),
        ...(source && source.owner.clientId !== actor.clientId && nativeSourceSupported ? {
          relayedSourceTarget: { sessionId: source.sessionId, chatId: source.chatId, owner: { clientId: source.owner.clientId } },
        } : {}),
      }
      await connection.send(
        record.status.messageId,
        messageText,
        undefined,
        async () => {
          await this.resolveTargetLink(canonicalRoot, record.status.targetRef, record.status.taskId)
          if (record.sourceTarget) await this.authorizeSource(canonicalRoot, record.sourceTarget)
          await beforeDispatch?.()
          if (this.closed) throw new CollaborationError('UNAVAILABLE', 'Session collaboration service is closed.')
        },
        actor,
        undefined,
        collaborationMeta,
      )
      const deliveredAt = this.isoNow()
      status = {
        ...record.status,
        state: 'delivered',
        updatedAt: deliveredAt,
        deliveredAt,
        turnId: record.status.messageId,
        turnStatus: resolveTurnStatus(connection.view.chat, record.status.messageId) ?? 'in-progress',
        reason: undefined,
      }
    } catch (error) {
      const timestamp = this.isoNow()
      const pendingTurn = connection.view.pendingTurn
      if (pendingTurn?.id === record.status.messageId && pendingTurn.state === 'uncertain') {
        status = {
          ...record.status,
          state: 'uncertain',
          updatedAt: timestamp,
          turnId: record.status.messageId,
          turnStatus: 'unknown',
          reason: 'Delivery confirmation was interrupted; inspect the target session before retrying.',
        }
      } else {
        status = {
          ...record.status,
          state: 'failed',
          updatedAt: timestamp,
          reason: error instanceof CollaborationError || error instanceof AgentHostTurnNotDispatchedError
            ? error.message.slice(0, 512) : 'Target session rejected or could not start the collaboration message.',
        }
      }
    }
    const finished = { ...record, text: undefined, status }
    if (!await this.replaceMessage(record, finished)) {
      throw new CollaborationError('UNAVAILABLE', 'The original collaboration delivery record is no longer available.')
    }
    return finished
  }

  private watchTargetForQueue(key: string, root: string, target: AgentHostTarget, connection: AgentHostConnection): void {
    const existing = this.watchers.get(key)
    if (existing?.connection === connection) return
    existing?.unlisten()
    const unlisten = connection.listen(() => {
      this.scheduleDrainTarget(key)
    })
    this.watchers.set(key, { root, target, connection, unlisten })
  }

  private scheduleDrainTarget(key: string): void {
    if (this.closed || this.scheduledDrains.has(key) || !this.watchers.has(key)) return
    this.scheduledDrains.add(key)
    void this.onTarget(key, async () => {
      this.scheduledDrains.delete(key)
      await this.drainTargetQueue(key)
    }).catch(() => console.error('Could not update the queued collaboration delivery. Check its message status before retrying.'))
  }

  private finishQueuedMessage(record: SavedMessage, state: 'blocked' | 'failed', reason: string): Promise<boolean> {
    return this.replaceMessage(record, {
      ...record, text: undefined,
      status: { ...record.status, state, reason, updatedAt: this.isoNow() },
    })
  }

  private async drainTargetQueue(key: string): Promise<void> {
    while (!this.closed) {
      const watcher = this.watchers.get(key)
      if (!watcher) return
      const next = this.messages.find((item) => item.status.state === 'queued' && messageTargetKey(item) === key)
      if (!next) {
        this.cleanupIdleWatchers()
        return
      }
      const expired = expiredMessage(next, this.now())
      if (expired !== next) {
        await this.replaceMessage(next, expired)
        continue
      }

      const { root, target } = watcher
      try { await this.resolveTargetLink(root, next.status.targetRef, next.status.taskId) }
      catch {
        await this.finishQueuedMessage(next, 'failed', 'Target session is no longer linked or authorized for this task.')
        continue
      }
      if (this.closed) return
      let { connection } = watcher
      let release: (() => void) | undefined
      if (connection.isClosed || connection.state === 'offline') {
        let fresh
        try { fresh = await this.acquireAuthorizedConnection(root, target) }
        catch { return } // Keep the accepted message queued until reconnect or expiry.
        connection = fresh.connection
        release = fresh.release
        this.watchTargetForQueue(key, root, target, connection)
      }
      try {
        const view = connection.view
        if (view.state !== 'connected' || !view.chat) return
        const blockedReason = view.readOnly ? 'Target session became read-only before queued delivery.'
          : view.chat.draft?.text || view.chat.draft?.attachments?.length ? 'Target session acquired an unsent human draft before queued delivery.'
          : view.pendingTurn?.state === 'uncertain' ? 'Target session has an uncertain delivery awaiting manual review.' : undefined
        if (blockedReason) {
          await this.finishQueuedMessage(next, 'blocked', blockedReason)
          continue
        }
        if (view.chat.activeTurn || view.pendingTurn || view.chat.queuedMessages?.length) return
        if (!next.text) {
          await this.finishQueuedMessage(next, 'failed', 'Queued message text was unavailable.')
          continue
        }
        release ??= connection.retain()
        const dispatching: SavedMessage = {
          ...next, text: undefined,
          status: { ...next.status, state: 'dispatching', updatedAt: this.isoNow(), reason: undefined },
        }
        const claimed = await this.updateMessages((messages) => {
          const index = messages.indexOf(next)
          if (index < 0 || this.closed) return false
          const expired = expiredMessage(next, this.now())
          messages[index] = expired === next ? dispatching : expired
          return expired === next
        })
        if (claimed) await this.dispatchNow(root, dispatching, next.text, target, connection)
      } finally {
        release?.()
      }
    }
  }

  private async messageStatus(root: string, messageId: string): Promise<CollaborationMessageStatus> {
    await this.initialize()
    const canonical = await this.canonicalRoot(root)
    await this.expireQueuedMessages()
    const record = this.messages.find((item) => item.root === canonical && item.status.messageId === messageId)
    if (!record) throw new CollaborationError('NOT_FOUND', 'Collaboration message was not found.')
    await this.readTaskLinks(canonical, record.status.taskId)
    return this.enrichStatus(record)
  }

  async expireQueuedMessages(): Promise<void> {
    if (this.closed) return
    await this.initialize()
    const changed = await this.updateMessages((messages) => {
      const now = this.now()
      let expired = false
      for (let index = 0; index < messages.length; index++) {
        const previous = messages[index]
        messages[index] = expiredMessage(previous, now)
        expired ||= messages[index] !== previous
      }
      return expired
    })
    if (changed) this.cleanupIdleWatchers()
  }

  private cleanupIdleWatchers(): void {
    for (const [key, watcher] of this.watchers) {
      const hasQueued = this.messages.some((item) => item.status.state === 'queued' && messageTargetKey(item) === key)
      if (!hasQueued) {
        watcher.unlisten()
        this.watchers.delete(key)
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.expiryTimer)
    for (const watcher of this.watchers.values()) watcher.unlisten()
    this.watchers.clear()
    await Promise.all(this.targetOperations.values())
    await this.writing
  }
}
