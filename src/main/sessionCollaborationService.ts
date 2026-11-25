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
  formatCollaborationTargetRef, parseCollaborationTargetRef, readTaskContinuumCollaborationMeta,
} from '../shared/sessionCollaboration'
import type {
  CollaborationContextRequest, CollaborationContextResult, CollaborationContextTurn, CollaborationMessageStatus,
  CollaborationSendRequest, CollaborationSessionEntry, CollaborationSessionsListRequest, CollaborationSessionsListResult,
  CollaborationTurnStatus, SessionCollaborationApi, TaskContinuumCollaborationMeta,
} from '../shared/sessionCollaboration'
import type { AgentHostConnection } from './agentHostConnection'
import type { AgentHostManager } from './agentHostManager'
import { canonicalPolicyRoot } from './linkedSessionPolicy'
import { readRepositorySessionLinksForAuthorization } from './repositorySessionLinks'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import type { VSCodeDeviceClient } from './vscodeDeviceClient'
import { readTaskWorkspaceMetadata } from './workspaceReader'
import type { WorkspaceTaskMetadata } from './workspaceReader'

const savedMessageSchema = z.object({
  root: z.string().min(1).max(4096),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
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
  private readonly dispatchingTargets = new Set<string>()
  private readonly watchers = new Map<string, { connection: AgentHostConnection; unlisten: () => void }>()
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
    return this.activeOperations > 0 || this.dispatchingTargets.size > 0
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString()
  }

  private async initialize(): Promise<void> {
    this.loading ??= (async () => {
      let recovered = false
      try {
        const parsed = messagesDocumentSchema.parse(await readJsonBounded(this.messagesFile, 4 * 1024 * 1024))
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
      if (recovered) await this.persistMessages()
    })()
    return this.loading
  }

  private async persistMessages(): Promise<void> {
    if (this.messages.length > COLLABORATION_LIMITS.maxRetainedMessages) {
      const removable = this.messages.filter((item) => item.status.state !== 'queued' && item.status.state !== 'dispatching')
      while (this.messages.length > COLLABORATION_LIMITS.maxRetainedMessages && removable.length > 0) {
        const victim = removable.shift()!
        const index = this.messages.indexOf(victim)
        if (index >= 0) this.messages.splice(index, 1)
      }
    }
    const payload = messagesDocumentSchema.parse({ schemaVersion: 1, messages: this.messages })
    const operation = this.writing.then(() => writeJsonAtomic(this.messagesFile, payload))
    this.writing = operation.catch(() => undefined)
    await operation
  }

  private async canonicalRoot(root: string): Promise<string> {
    try { return await canonicalPolicyRoot(root) }
    catch { throw new CollaborationError('ACCESS_DENIED', 'The configured workspace is unavailable.') }
  }

  private queuedCount(canonicalRoot: string, taskId?: string): number {
    return this.messages.filter((item) => item.root === canonicalRoot && (taskId === undefined || item.status.taskId === taskId)
      && (item.status.state === 'queued' || item.status.state === 'dispatching')).length
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

  forWorkspace(root: string): SessionCollaborationApi {
    return {
      listSessions: (request) => this.withCapacity(() => this.listSessions(root, collaborationSessionsListRequestSchema.parse(request))),
      readContext: (request) => this.withCapacity(() => this.readContext(root, collaborationContextRequestSchema.parse(request))),
      sendMessage: (request) => this.withCapacity(() => this.sendMessage(root, collaborationSendRequestSchema.parse(request))),
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

  private async resolveTargetLink(canonicalRoot: string, targetRef: string, expectedTaskId?: string): Promise<{ taskId: string; link: SessionLink }> {
    const parsed = parseCollaborationTargetRef(targetRef)
    if (expectedTaskId !== undefined && expectedTaskId !== parsed.taskId) {
      throw new CollaborationError('INVALID_REQUEST', 'The targetRef belongs to a different task.')
    }
    const links = await this.readTaskLinks(canonicalRoot, parsed.taskId)
    const link = links.find((candidate) => candidate.owner.clientId === parsed.ownerClientId
      && candidate.sessionId === parsed.sessionId && candidate.chatId === parsed.chatId)
    if (!link) throw new CollaborationError('NOT_FOUND', 'The target session is not currently linked to this task.')
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
        try { await this.deps.agentHosts.authorize(canonical, link) }
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

  private async acquireAuthorizedConnection(canonicalRoot: string, link: SessionLink): Promise<{ connection: AgentHostConnection; release: () => void }> {
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

  private targetLockKey(canonicalRoot: string, link: Pick<AgentHostTarget, 'sessionId' | 'chatId' | 'owner'>): string {
    return `${canonicalRoot}:${agentHostKey(link)}`
  }

  private async enrichStatus(canonicalRoot: string, record: SavedMessage): Promise<CollaborationMessageStatus> {
    if (record.status.state === 'queued' && record.status.expiresAt && this.now() >= Date.parse(record.status.expiresAt)) {
      record.text = undefined
      record.status = {
        ...record.status,
        state: 'expired',
        updatedAt: this.isoNow(),
        reason: 'Queued collaboration message expired before the target session became idle.',
      }
      await this.persistMessages()
      this.cleanupIdleWatchers()
    }
    if ((record.status.state === 'delivered' || record.status.state === 'uncertain') && record.status.turnId) {
      const parsed = parseCollaborationTargetRef(record.status.targetRef)
      const connection = this.getLoadedConnection(`${canonicalRoot}:${JSON.stringify([parsed.ownerClientId, parsed.sessionId, parsed.chatId])}`)
      const liveTurnStatus = resolveTurnStatus(connection?.view.chat, record.status.turnId)
      if (liveTurnStatus && liveTurnStatus !== record.status.turnStatus) {
        return collaborationMessageStatusSchema.parse({ ...record.status, turnStatus: liveTurnStatus })
      }
    }
    return collaborationMessageStatusSchema.parse(record.status)
  }

  private async sendMessage(root: string, request: CollaborationSendRequest): Promise<CollaborationMessageStatus> {
    await this.initialize()
    const canonical = await this.canonicalRoot(root)
    await this.expireQueuedMessages()
    const parsedTarget = parseCollaborationTargetRef(request.targetRef)
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ taskId: parsedTarget.taskId, targetRef: request.targetRef, text: request.text }))
      .digest('hex')

    const existing = this.messages.find((item) => item.root === canonical && item.status.messageId === request.messageId)
    if (existing) {
      await this.readTaskLinks(canonical, existing.status.taskId)
      if (existing.requestHash !== requestHash) {
        throw new CollaborationError('CONFLICT', 'This messageId already belongs to different collaboration content or target.')
      }
      return this.enrichStatus(canonical, existing)
    }

    const { taskId, link } = await this.resolveTargetLink(canonical, request.targetRef)
    if (this.queuedCount(canonical, taskId) >= COLLABORATION_LIMITS.maxQueuedPerTask) {
      throw new CollaborationError('BUSY', `Too many pending collaboration messages for ${taskId}. Retry when some finish.`)
    }

    const { connection, release } = await this.acquireAuthorizedConnection(canonical, link)
    try {
      await this.resolveTargetLink(canonical, request.targetRef, taskId)

      const view = connection.view
      if (view.readOnly) {
        throw new CollaborationError('ACCESS_DENIED', 'The target session is read-only or does not allow sending.')
      }
      const createdAt = this.isoNow()
      if (view.chat?.draft?.text || view.chat?.draft?.attachments?.length) {
        const blocked: SavedMessage = {
          root: canonical,
          requestHash,
          status: {
            messageId: request.messageId,
            taskId,
            targetRef: request.targetRef,
            state: 'blocked',
            createdAt,
            updatedAt: createdAt,
            reason: 'Target session has an unsent human draft; collaboration message was not sent.',
          },
        }
        this.messages.push(blocked)
        await this.persistMessages()
        return collaborationMessageStatusSchema.parse(blocked.status)
      }
      if (view.pendingTurn?.state === 'uncertain') {
        const blocked: SavedMessage = {
          root: canonical,
          requestHash,
          status: {
            messageId: request.messageId,
            taskId,
            targetRef: request.targetRef,
            state: 'blocked',
            createdAt,
            updatedAt: createdAt,
            reason: 'Target session has an uncertain delivery awaiting manual review.',
          },
        }
        this.messages.push(blocked)
        await this.persistMessages()
        return collaborationMessageStatusSchema.parse(blocked.status)
      }

      const lockKey = this.targetLockKey(canonical, link)
      const hasQueuedAhead = this.messages.some((item) => item.root === canonical && item.status.targetRef === request.targetRef && item.status.state === 'queued')
      const targetBusy = this.dispatchingTargets.has(lockKey) || hasQueuedAhead
        || Boolean(view.chat?.activeTurn) || Boolean(view.pendingTurn) || Boolean(view.chat?.queuedMessages?.length)

      if (targetBusy) {
        const expiresAt = new Date(this.now() + COLLABORATION_LIMITS.messageTtlMs).toISOString()
        const queued: SavedMessage = {
          root: canonical,
          requestHash,
          text: request.text,
          status: {
            messageId: request.messageId,
            taskId,
            targetRef: request.targetRef,
            state: 'queued',
            createdAt,
            updatedAt: createdAt,
            expiresAt,
            reason: 'Target session is currently busy; message is queued until the current turn finishes.',
          },
        }
        this.messages.push(queued)
        await this.persistMessages()
        this.watchTargetForQueue(canonical, link, connection)
        return collaborationMessageStatusSchema.parse(queued.status)
      }

      const record: SavedMessage = {
        root: canonical,
        requestHash,
        status: {
          messageId: request.messageId,
          taskId,
          targetRef: request.targetRef,
          state: 'dispatching',
          createdAt,
          updatedAt: createdAt,
        },
      }
      this.messages.push(record)
      await this.persistMessages()
      await this.dispatchNow(canonical, record, request.text, link, connection)
      return await this.enrichStatus(canonical, record)
    } finally { release() }
  }

  private async dispatchNow(canonicalRoot: string, record: SavedMessage, messageText: string, link: SessionLink, connection: AgentHostConnection): Promise<void> {
    const lockKey = this.targetLockKey(canonicalRoot, link)
    this.dispatchingTargets.add(lockKey)
    try {
      const actor = await this.deps.identity()
      const collaborationMeta: TaskContinuumCollaborationMeta = {
        version: 1,
        taskId: record.status.taskId,
        messageId: record.status.messageId,
        senderDevice: {
          clientId: actor.clientId,
          machineName: actor.machineName,
          ...(actor.username ? { username: actor.username } : {}),
        },
        sourceKind: 'mcp-client',
      }
      await connection.send(
        record.status.messageId,
        messageText,
        undefined,
        async () => { await this.resolveTargetLink(canonicalRoot, record.status.targetRef, record.status.taskId) },
        actor,
        undefined,
        collaborationMeta,
      )
      const deliveredAt = this.isoNow()
      record.text = undefined
      record.status = {
        ...record.status,
        state: 'delivered',
        updatedAt: deliveredAt,
        deliveredAt,
        turnId: record.status.messageId,
        turnStatus: resolveTurnStatus(connection.view.chat, record.status.messageId) ?? 'in-progress',
        reason: undefined,
      }
      await this.persistMessages()
    } catch (error) {
      const timestamp = this.isoNow()
      record.text = undefined
      const pendingTurn = connection.view.pendingTurn
      if (pendingTurn?.id === record.status.messageId && pendingTurn.state === 'uncertain') {
        record.status = {
          ...record.status,
          state: 'uncertain',
          updatedAt: timestamp,
          turnId: record.status.messageId,
          turnStatus: 'unknown',
          reason: 'Delivery confirmation was interrupted; inspect the target session before retrying.',
        }
      } else {
        record.status = {
          ...record.status,
          state: 'failed',
          updatedAt: timestamp,
          reason: error instanceof CollaborationError ? error.message : 'Target session rejected or could not start the collaboration message.',
        }
      }
      await this.persistMessages()
    } finally {
      this.dispatchingTargets.delete(lockKey)
      this.scheduleDrainTarget(canonicalRoot, link, connection)
    }
  }

  private watchTargetForQueue(canonicalRoot: string, link: SessionLink, connection: AgentHostConnection): void {
    const key = this.targetLockKey(canonicalRoot, link)
    const existing = this.watchers.get(key)
    if (existing?.connection === connection) return
    existing?.unlisten()
    const unlisten = connection.listen(() => {
      this.scheduleDrainTarget(canonicalRoot, link, connection)
    })
    this.watchers.set(key, { connection, unlisten })
  }

  private scheduleDrainTarget(canonicalRoot: string, link: SessionLink, connection: AgentHostConnection): void {
    if (this.closed) return
    void this.drainTargetQueue(canonicalRoot, link, connection).catch(() => {})
  }

  private async drainTargetQueue(canonicalRoot: string, link: SessionLink, connection: AgentHostConnection): Promise<void> {
    if (this.closed) return
    const lockKey = this.targetLockKey(canonicalRoot, link)
    if (this.dispatchingTargets.has(lockKey)) return
    const next = this.messages.find((item) => item.root === canonicalRoot && item.status.state === 'queued' && (() => {
      const parsed = parseCollaborationTargetRef(item.status.targetRef)
      return parsed.ownerClientId === link.owner.clientId && parsed.sessionId === link.sessionId && parsed.chatId === link.chatId
    })())
    if (!next) {
      this.cleanupIdleWatchers()
      return
    }
    if (next.status.expiresAt && this.now() >= Date.parse(next.status.expiresAt)) {
      next.text = undefined
      next.status = {
        ...next.status,
        state: 'expired',
        updatedAt: this.isoNow(),
        reason: 'Queued collaboration message expired before the target session became idle.',
      }
      await this.persistMessages()
      await this.drainTargetQueue(canonicalRoot, link, connection)
      return
    }

    try { await this.resolveTargetLink(canonicalRoot, next.status.targetRef, next.status.taskId) }
    catch {
      next.text = undefined
      next.status = {
        ...next.status,
        state: 'failed',
        updatedAt: this.isoNow(),
        reason: 'Target session is no longer linked or authorized for this task.',
      }
      await this.persistMessages()
      await this.drainTargetQueue(canonicalRoot, link, connection)
      return
    }

    if (connection.isClosed || connection.state === 'offline') {
      try {
        const { connection: fresh, release } = await this.acquireAuthorizedConnection(canonicalRoot, link)
        this.watchTargetForQueue(canonicalRoot, link, fresh)
        release()
        connection = fresh
      } catch {
        return
      }
    }

    const view = connection.view
    if (view.state !== 'connected' || !view.chat) return
    if (view.readOnly) {
      next.text = undefined
      next.status = {
        ...next.status,
        state: 'blocked',
        updatedAt: this.isoNow(),
        reason: 'Target session became read-only before queued delivery.',
      }
      await this.persistMessages()
      await this.drainTargetQueue(canonicalRoot, link, connection)
      return
    }
    if (view.chat.draft?.text || view.chat.draft?.attachments?.length) {
      next.text = undefined
      next.status = {
        ...next.status,
        state: 'blocked',
        updatedAt: this.isoNow(),
        reason: 'Target session acquired an unsent human draft before queued delivery.',
      }
      await this.persistMessages()
      await this.drainTargetQueue(canonicalRoot, link, connection)
      return
    }
    if (view.pendingTurn?.state === 'uncertain') {
      next.text = undefined
      next.status = {
        ...next.status,
        state: 'blocked',
        updatedAt: this.isoNow(),
        reason: 'Target session has an uncertain delivery awaiting manual review.',
      }
      await this.persistMessages()
      await this.drainTargetQueue(canonicalRoot, link, connection)
      return
    }
    if (view.chat.activeTurn || view.pendingTurn || view.chat.queuedMessages?.length) return

    const messageText = next.text
    if (!messageText) {
      next.status = { ...next.status, state: 'failed', updatedAt: this.isoNow(), reason: 'Queued message text was unavailable.' }
      await this.persistMessages()
      return
    }
    next.text = undefined
    next.status = { ...next.status, state: 'dispatching', updatedAt: this.isoNow(), reason: undefined }
    await this.persistMessages()
    const release = connection.retain()
    try { await this.dispatchNow(canonicalRoot, next, messageText, link, connection) }
    finally { release() }
  }

  private async messageStatus(root: string, messageId: string): Promise<CollaborationMessageStatus> {
    await this.initialize()
    const canonical = await this.canonicalRoot(root)
    const record = this.messages.find((item) => item.root === canonical && item.status.messageId === messageId)
    if (!record) throw new CollaborationError('NOT_FOUND', 'Collaboration message was not found.')
    await this.readTaskLinks(canonical, record.status.taskId)
    return this.enrichStatus(canonical, record)
  }

  async expireQueuedMessages(): Promise<void> {
    if (this.closed) return
    await this.initialize()
    const now = this.now()
    const timestamp = new Date(now).toISOString()
    let expiredAny = false
    for (const item of this.messages) {
      if (item.status.state === 'queued' && item.status.expiresAt && now >= Date.parse(item.status.expiresAt)) {
        item.text = undefined
        item.status = {
          ...item.status,
          state: 'expired',
          updatedAt: timestamp,
          reason: 'Queued collaboration message expired before the target session became idle.',
        }
        expiredAny = true
      }
    }
    if (expiredAny) {
      await this.persistMessages()
      this.cleanupIdleWatchers()
    }
  }

  private cleanupIdleWatchers(): void {
    for (const [key, watcher] of this.watchers) {
      const hasQueued = this.messages.some((item) => item.status.state === 'queued' && (() => {
        const parsed = parseCollaborationTargetRef(item.status.targetRef)
        return `${item.root}:${JSON.stringify([parsed.ownerClientId, parsed.sessionId, parsed.chatId])}` === key
      })())
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
    await this.writing
  }
}
