import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import type { AhpTransport, Subscription } from '@microsoft/agent-host-protocol/client'
import { MessageKind, sessionReducer, terminalReducer } from '@microsoft/agent-host-protocol'
import type { ActionEnvelope, ChatTurnStartedAction, ChatTurnCancelledAction, InitializeResult, MessageEmbeddedResourceAttachment, ModelSelection, SessionModelInfo, SessionState, Snapshot, TerminalState } from '@microsoft/agent-host-protocol'
import type { AgentHostHistoryTransfer, AgentHostProtocolVersion, AgentHostTarget, AgentHostView } from '../shared/agentHost'
import { agentHostProtocolVersions } from '../shared/agentHost'
import { chatSubmissionSchema } from '../shared/chatAttachments'
import type { ChatImageAttachment } from '../shared/chatAttachments'
import { modelConfigErrors } from '../shared/agentHostModelConfig'
import { AgentHostChatState, AgentHostHistoryCursorError } from './agentHostState'
import { agentHostDiagnosticChannel, logAgentHostDiagnostic } from './agentHostDiagnostics'
import type { AgentHostDiagnosticDetails, AgentHostDiagnosticEvent } from './agentHostDiagnostics'
import { agentHostKey, agentHostModelInfoSchema, agentHostModelSelectionSchema, agentHostTargetSchema, agentHostTerminalIdSchema, requireAgentHostProtocolVersion } from './agentHostProtocol'
import { JsonFileSizeError, readJsonBounded, writeJsonAtomic, writeTextAtomic } from './shared/storage'
import { AGENT_HOST_LIMITS, AgentHostSizeLimitError, agentHostSizeLimit } from './agentHostLimits'
import {
  AgentHostSnapshotSupersededError, SNAPSHOT_TRANSFER_LIMITS, SNAPSHOT_TRANSFER_METHODS, chunkedSnapshotCapabilitySchema,
  historyContainsTurnResponseSchema, isAgentHostSnapshotSuperseded, pagedChatHistoryCapabilitySchema,
  receiveChunkedChatSnapshot, removePartialSnapshotFiles, snapshotHistoryPageSchema,
} from './agentHostSnapshotTransfer'
import type { ChunkedSnapshotCapability, SnapshotHistoryPage } from './agentHostSnapshotTransfer'

export type AgentHostEvent = { type: 'action'; envelope: ActionEnvelope } | { type: 'snapshot'; snapshot: Snapshot } | { type: 'state' | 'history-progress' }
export function isAgentHostTurnBoundary(event: AgentHostEvent): boolean {
  return event.type === 'action' && ['chat/turnStarted', 'chat/turnComplete', 'chat/turnCancelled', 'chat/error', 'chat/turnResume'].includes(event.envelope.action.type)
}
const commandSchema = z.object({ id: z.uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['pending', 'uncertain', 'confirmed', 'failed', 'abandoned']) }).strict()
const ledgerSchema = z.object({ schemaVersion: z.literal(2), target: agentHostTargetSchema, commands: z.array(commandSchema).max(1000) }).strict()
const cacheSchema = z.discriminatedUnion('schemaVersion', [
  z.object({ schemaVersion: z.literal(2), target: agentHostTargetSchema, chat: z.unknown() }).strict(),
  z.object({ schemaVersion: z.literal(3), target: agentHostTargetSchema, chat: z.unknown(), history: snapshotHistoryPageSchema.optional() }).strict(),
])
type Command = z.infer<typeof commandSchema>
type ModelCatalog = Pick<SessionModelInfo, 'id' | 'name' | 'provider' | 'configSchema'>[]
type ActiveConnection = { client: AhpClient; abort: AbortController; traceId: string }

export class AgentHostConnection {
  private current?: ActiveConnection
  private opening?: Promise<void>
  private closed = false
  private connected = false
  private error?: string
  private cacheError?: string
  private lastSizeFailure?: AgentHostSizeLimitError
  private historyTransfer?: AgentHostHistoryTransfer
  private historyPage?: SnapshotHistoryPage
  private historyError?: string
  private historyGeneration = randomUUID()
  private historyLoading?: { active: ActiveConnection; promise: Promise<void>; counts: { sequence: number; delta: number }[] }
  private unverifiedCacheTurns = new Set<string>()
  private nativeHistoryLoading?: { active: ActiveConnection; promise: Promise<void> }
  private chat: AgentHostChatState
  private readonly snapshots = new Map<string, Snapshot>()
  private readonly listeners = new Set<(event: AgentHostEvent) => void>()
  private readonly subscribing = new Set<string>()
  private readonly terminalSubscriptions = new Map<string, Subscription>()
  private readonly terminalRequests = new Map<string, Promise<Snapshot>>()
  private readonly terminalLeases = new Map<string, number>()
  private readonly terminalStatus = new Map<string, { state: 'loading' | 'error'; error?: string }>()
  private referencedTerminals = new Set<string>()
  private activeTerminals = new Set<string>()
  private commands: Command[] = []
  private loaded?: Promise<void>
  private writing: Promise<void> = Promise.resolve()
  private sending = false
  private reviewing = false
  private retry?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private failures = 0
  private readonly file: string
  private initialized?: InitializeResult & { protocolVersion: AgentHostProtocolVersion }
  private modelCatalog?: {
    active: ActiveConnection
    models?: ModelCatalog
    pending?: Promise<ModelCatalog>
    failed?: boolean
  }

  constructor(readonly target: AgentHostTarget, directory: string, private readonly transport: (signal: AbortSignal, traceId: string) => Promise<AhpTransport>) {
    agentHostTargetSchema.parse(target)
    this.chat = new AgentHostChatState(target.chatId)
    this.file = join(directory, 'agent-host', createHash('sha256').update(agentHostKey(target)).digest('hex'))
  }

  private diagnose(event: AgentHostDiagnosticEvent, details: AgentHostDiagnosticDetails): void {
    logAgentHostDiagnostic(event, { target: this.target, ...details })
  }

  private updateHistoryProgress(progress: AgentHostHistoryTransfer | undefined): void {
    const phaseChanged = Boolean(progress) !== Boolean(this.historyTransfer)
    this.historyTransfer = progress
    this.emit({ type: phaseChanged ? 'state' : 'history-progress' })
  }

  get state(): AgentHostView['state'] { return this.connected ? 'connected' : this.opening ? 'connecting' : 'offline' }
  get sizeLimitError(): AgentHostSizeLimitError | undefined { return this.lastSizeFailure }
  get historyEpoch(): string { return this.historyGeneration }
  get historyProgress(): AgentHostHistoryTransfer | undefined { return this.historyTransfer ? { ...this.historyTransfer } : undefined }
  private get readOnly(): boolean { return this.initialized?._meta?.taskcontinuumCanSend === false || this.chat.sendState.readOnly }

  get hasActiveWork(): boolean {
    const chat = this.chat.value
    return this.sending || this.reviewing || this.commands.some(command => command.state === 'pending' || command.state === 'uncertain')
      || !!chat?.activeTurn || !!chat?.draft?.text || !!chat?.draft?.attachments?.length || !!chat?.queuedMessages?.length
  }

  get view(): AgentHostView {
    const chat = this.chat.value
    const pending = this.commands.find((command) => command.state === 'pending' || command.state === 'uncertain')
    const readOnly = this.readOnly
    return { target: this.target, state: this.state, protocolVersion: this.initialized?.protocolVersion, chat,
      ...(this.historyTransfer ? { historyTransfer: { ...this.historyTransfer } } : {}),
      ...(this.historyPage || this.chat.nativeHistoryCursor ? { history: {
        hasMore: Boolean(this.historyPage?.beforeTurnId || this.chat.nativeHistoryCursor),
        loadedTurns: this.chat.completedTurns,
        totalTurns: this.historyPage?.totalTurns,
        loading: this.current !== undefined && (this.historyLoading?.active === this.current || this.nativeHistoryLoading?.active === this.current),
        ...(this.historyError ? { error: this.historyError } : {}),
      } } : {}),
      terminals: Object.fromEntries([...this.snapshots].filter(([resource]) => this.referencedTerminals.has(resource)).map(([resource, snapshot]) => [resource, structuredClone(snapshot.state) as TerminalState])),
      terminalStatus: Object.fromEntries([...this.terminalStatus].filter(([resource]) => this.referencedTerminals.has(resource)).map(([resource, status]) => [resource, { ...status }])),
      canSend: this.connected && !readOnly && !pending && !this.sending && !chat?.activeTurn && !chat?.draft?.text && !chat?.draft?.attachments?.length && !chat?.queuedMessages?.length, readOnly,
      error: [this.error, this.cacheError].filter(Boolean).join(' ') || undefined, ...(pending ? { pendingTurn: { id: pending.id, state: pending.state as 'pending' | 'uncertain' } } : {}) }
  }

  private chunkedSnapshotCapability(): ChunkedSnapshotCapability | undefined {
    const parsed = chunkedSnapshotCapabilitySchema.safeParse(this.initialized?._meta?.taskcontinuumChunkedChatSnapshot)
    return parsed.success ? parsed.data : undefined
  }

  private get pagedHistory(): boolean {
    return pagedChatHistoryCapabilitySchema.safeParse(this.initialized?._meta?.taskcontinuumPagedChatHistory).success
  }

  private requestExtension(active: ActiveConnection, method: string, params: Record<string, unknown>): Promise<unknown> {
    return active.client.request(method as Parameters<AhpClient['request']>[0], params as never)
  }

  historySnapshot(beforeTurnId?: string): ReturnType<AgentHostChatState['historySnapshot']> {
    if (!this.connected || !this.chat.loaded) throw new Error('This Agent Host channel is unavailable.')
    if (this.historyPage?.beforeTurnId) throw new Error('A partial remote history cannot be exported as complete owner history.')
    return this.chat.historySnapshot(beforeTurnId)
  }

  async ensureEarlierHistory(epoch: string, beforeTurnId: string): Promise<void> {
    if (epoch !== this.historyEpoch) throw new AgentHostSnapshotSupersededError()
    const active = this.current
    if (!active || !this.connected) throw new Error('The original Agent Host is offline.')
    if (this.chat.oldestTurnId === beforeTurnId && this.chat.nativeHistoryCursor) await this.fetchNativeHistory(active)
    if (this.current !== active || epoch !== this.historyEpoch) throw new AgentHostSnapshotSupersededError()
  }

  async fetchHistory(cursor?: string): Promise<void> {
    const active = this.current
    if (!active || !this.connected) throw new Error('The original Agent Host is offline.')
    if (cursor !== undefined && cursor !== this.chat.nativeHistoryCursor) throw new Error('The native history cursor changed. Reconnect before loading it.')
    await this.fetchNativeHistory(active)
  }

  private fetchNativeHistory(active: ActiveConnection): Promise<void> {
    if (this.nativeHistoryLoading?.active === active) return this.nativeHistoryLoading.promise
    const cursor = this.chat.nativeHistoryCursor
    if (!cursor) throw new Error('The native Agent Host has no earlier history cursor.')
    const previousCount = this.chat.completedTurns
    let notify!: () => void
    let timer: ReturnType<typeof setTimeout>
    const updated = new Promise<void>((resolve, reject) => {
      notify = () => {
        if (this.current !== active || this.chat.nativeHistoryCursor !== cursor || this.chat.completedTurns !== previousCount) resolve()
      }
      timer = setTimeout(() => reject(new Error('The native Agent Host did not publish the requested history page.')), 60000)
      timer.unref()
    })
    const unlisten = this.listen(notify)
    const operation = Promise.all([active.client.request('fetchTurns', { channel: this.target.chatId, cursor }), updated])
      .then(() => {
        if (this.current !== active || !this.connected) throw new Error('The connection changed while loading native history.')
      }).finally(() => {
        clearTimeout(timer)
        unlisten()
        if (this.nativeHistoryLoading?.promise === operation) this.nativeHistoryLoading = undefined
      })
    this.nativeHistoryLoading = { active, promise: operation }
    return operation
  }

  private async originalHasTurn(id: string, active: ActiveConnection): Promise<boolean> {
    if (this.current !== active) throw new Error('The connection changed while checking original history.')
    if (this.historyPage && this.pagedHistory) {
      const found = historyContainsTurnResponseSchema.parse(await this.requestExtension(active, SNAPSHOT_TRANSFER_METHODS.containsTurn, {
        channel: this.target.chatId, turnId: id,
      }))
      if (this.current !== active || found.epoch !== this.historyPage.epoch) throw new Error('The original history changed while checking delivery. Reconnect before reviewing it.')
      if (found.found) this.unverifiedCacheTurns.delete(id)
      return found.found
    }
    if (this.chat.hasTurn(id)) return true
    while (this.chat.nativeHistoryCursor && !this.chat.hasTurn(id)) await this.fetchNativeHistory(active)
    if (this.current !== active) throw new Error('The connection changed while checking original history.')
    return this.chat.hasTurn(id)
  }

  async containsTurn(id: string): Promise<boolean> {
    z.uuid().parse(id)
    const active = this.current
    if (!active || !this.connected) throw new Error('The original Agent Host is offline.')
    return this.originalHasTurn(id, active)
  }

  loadHistory(): Promise<void> {
    const active = this.current
    if (!active || !this.connected) throw new Error('Reconnect to the original Agent Host before loading earlier history.')
    if (this.historyLoading?.active === active) return this.historyLoading.promise
    const beforeTurnId = this.historyPage?.beforeTurnId
    if (!beforeTurnId && !this.chat.nativeHistoryCursor) throw new Error('No earlier history remains to load.')
    const epoch = this.historyPage?.epoch
    const capability = this.chunkedSnapshotCapability()
    const pageFile = `${this.file}.history-${active.traceId}`
    const started = performance.now()
    this.historyError = undefined
    this.diagnose('connection.subscribe', { traceId: active.traceId, status: 'begin', channel: 'chat', step: 'snapshot' })
    const operation: Promise<void> = Promise.resolve().then(async () => {
      try {
        if (beforeTurnId && epoch && capability && this.pagedHistory) {
          const received = await receiveChunkedChatSnapshot({
            baseFilePath: pageFile, target: this.target, subscribe: false, signal: active.abort.signal,
            capability, history: { before: { epoch, turnId: beforeTurnId } },
            request: (method, params) => this.requestExtension(active, method, params),
            onProgress: (progress) => {
              if (this.current !== active) return
              this.updateHistoryProgress(progress && { ...progress, kind: 'earlier' })
            },
            onChunkSaved: () => { if (this.current === active) this.failures = 0 },
          })
          if (this.current !== active || this.historyPage?.epoch !== epoch || this.historyPage.beforeTurnId !== beforeTurnId
            || !received.history) throw new AgentHostSnapshotSupersededError()
          const loading = this.historyLoading
          if (!loading || loading.active !== active) throw new AgentHostSnapshotSupersededError()
          this.chat.prependHistory(received.snapshot, beforeTurnId)
          this.historyPage = {
            ...received.history,
            ...(received.history.totalTurns !== undefined ? {
              totalTurns: received.history.totalTurns + loading.counts.filter((item) => item.sequence > received.snapshot.fromSeq).reduce((total, item) => total + item.delta, 0),
            } : {}),
          }
          this.refreshTerminals()
          this.diagnose('connection.subscribe', { traceId: active.traceId, status: 'ok', channel: 'chat', step: 'snapshot',
            elapsedMs: performance.now() - started, bytes: received.totalBytes, count: received.chunksTransferred })
        } else {
          await this.fetchNativeHistory(active)
          this.diagnose('connection.subscribe', { traceId: active.traceId, status: 'ok', channel: 'chat', step: 'snapshot', elapsedMs: performance.now() - started })
        }
      } catch (error) {
        this.diagnose('connection.subscribe', { traceId: active.traceId, status: 'error', channel: 'chat', step: 'snapshot', elapsedMs: performance.now() - started, error })
        if (this.current === active) {
          this.historyError = error instanceof Error ? error.message : 'Earlier history could not be loaded. Retry when the owner is available.'
          if (isAgentHostSnapshotSuperseded(error) || error instanceof AgentHostHistoryCursorError) this.offline(active, 'stream-error', error)
        }
        throw error
      } finally {
        if (beforeTurnId) await removePartialSnapshotFiles(pageFile)
        if (this.historyLoading?.promise === operation) this.historyLoading = undefined
        if (this.current === active) {
          this.historyTransfer = undefined
          this.emit({ type: 'state' })
        }
      }
    })
    this.historyLoading = { active, promise: operation, counts: [] }
    this.emit({ type: 'state' })
    return operation
  }

  get handshake(): InitializeResult {
    if (!this.initialized || !this.connected) throw new Error('Agent Host is offline.')
    return { protocolVersion: this.initialized.protocolVersion, serverSeq: Math.max(0, this.chat.lastSequence, ...[...this.snapshots.values()].map((snapshot) => snapshot.fromSeq)), snapshots: [], terminalCommandPrefix: this.initialized.terminalCommandPrefix }
  }

  snapshot(resource: string): Snapshot {
    if (resource === this.target.chatId) {
      if (!this.connected || !this.chat.loaded) throw new Error('This Agent Host channel is unavailable.')
      return this.chat.toSnapshot()!
    }
    const snapshot = this.snapshots.get(resource)
    if (!this.connected || !snapshot) throw new Error('This Agent Host channel is unavailable.')
    if (resource === this.target.sessionId) {
      const state = snapshot.state as SessionState
      return { ...snapshot, state: { provider: state.provider, title: state.title, lifecycle: state.lifecycle, status: state.status,
        activeClients: [], chats: structuredClone(state.chats.filter((chat) => chat.resource === this.target.chatId)), defaultChat: this.target.chatId,
        ...(state.workingDirectories ? { workingDirectories: structuredClone(state.workingDirectories) } : {}) } }
    }
    return structuredClone(snapshot)
  }

  allowedChannel(resource: string): boolean { return resource === this.target.sessionId || resource === this.target.chatId || this.referencedTerminals.has(resource) }

  isActiveTerminal(resource: string): boolean { return this.activeTerminals.has(resource) }

  retainTerminal(resource: string): void {
    if (!agentHostTerminalIdSchema.safeParse(resource).success || !this.allowedChannel(resource)) throw new Error('Channel not authorized.')
    this.terminalLeases.set(resource, (this.terminalLeases.get(resource) ?? 0) + 1)
  }

  releaseTerminal(resource: string): void {
    const count = this.terminalLeases.get(resource)
    if (!count) return
    if (count > 1) { this.terminalLeases.set(resource, count - 1); return }
    this.terminalLeases.delete(resource)
    if (!this.activeTerminals.has(resource) && !this.terminalRequests.has(resource)) this.stopTerminal(resource)
  }

  async terminal(resource: string, retry = false): Promise<Snapshot> {
    await this.open()
    if (!agentHostTerminalIdSchema.safeParse(resource).success || !this.allowedChannel(resource)) throw new Error('Channel not authorized.')
    const active = this.current
    if (!active || !this.connected) throw new Error('Agent Host is offline.')
    const pending = this.terminalRequests.get(resource)
    if (pending) return pending
    const cached = this.terminalSubscriptions.has(resource) ? this.snapshots.get(resource) : undefined
    if (cached) return structuredClone(cached)
    if (this.terminalStatus.get(resource)?.state === 'error' && !retry) throw new Error('Terminal output is unavailable. Retry manually.')
    this.terminalStatus.set(resource, { state: 'loading' })
    this.emit({ type: 'state' })
    const operation = this.subscribe(resource, active).then(() => {
        if (this.current !== active || !this.connected) throw new Error('Agent Host connection changed.')
        return this.snapshot(resource)
      }).catch((error: unknown) => {
        if (this.current === active && this.allowedChannel(resource)) {
          this.terminalStatus.set(resource, { state: 'error', error: 'The owner Host could not load this terminal output. Retry manually.' })
          this.emit({ type: 'state' })
        }
        throw error
      }).finally(() => {
        if (this.terminalRequests.get(resource) === operation) this.terminalRequests.delete(resource)
        if (this.current === active) {
          if (this.terminalStatus.get(resource)?.state === 'loading') this.terminalStatus.delete(resource)
          if (!this.terminalLeases.has(resource) && !this.activeTerminals.has(resource)) this.stopTerminal(resource)
          this.emit({ type: 'state' })
        }
      })
    this.terminalRequests.set(resource, operation)
    return operation
  }

  listen(listener: (event: AgentHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { clearTimeout(this.retry); this.retry = undefined } }
  }

  private emit(event: AgentHostEvent): void { for (const listener of this.listeners) listener(event) }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const saved = ledgerSchema.parse(await readJsonBounded(`${this.file}.commands.json`))
        if (agentHostKey(saved.target) !== agentHostKey(this.target)) throw new Error('Identity changed.')
        this.commands = saved.commands.map((command) => command.state === 'pending' ? { ...command, state: 'uncertain' } : command)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Agent Host delivery records are unreadable. No message was sent.') }
      try {
        const saved = cacheSchema.parse(await readJsonBounded(`${this.file}.cache.json`, AGENT_HOST_LIMITS.cacheBytes))
        if (agentHostKey(saved.target) !== agentHostKey(this.target)) throw new Error('Cached chat identity changed.')
        const chat = new AgentHostChatState(this.target.chatId)
        chat.snapshot(saved.chat as Snapshot)
        const history = saved.schemaVersion === 3 ? saved.history : undefined
        if (history?.beforeTurnId && history.beforeTurnId !== chat.oldestTurnId) throw new Error('The cached history page boundary changed.')
        this.chat = chat
        this.historyPage = history
        this.refreshTerminals()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        const failure = error instanceof JsonFileSizeError ? new AgentHostSizeLimitError('cache', error.limitBytes, error.actualBytes) : error
        this.cacheError = agentHostSizeLimit(failure)?.message ?? 'Offline chat history could not be read. Reconnect to the original Host to restore history.'
        this.diagnose('connection.cache', { status: 'error', step: 'load', error: failure })
      }
    })()
    return this.loaded
  }

  private save(): Promise<void> {
    const ledger = ledgerSchema.parse({ schemaVersion: 2, target: this.target, commands: this.commands })
    const operation = this.writing.then(() => writeJsonAtomic(`${this.file}.commands.json`, ledger))
    this.writing = operation.catch(() => undefined)
    return operation
  }

  async open(): Promise<void> {
    if (this.closed) throw new Error('Agent Host view is closed.')
    if (this.connected) return
    if (this.opening) return this.opening
    clearTimeout(this.retry)
    this.retry = undefined
    this.lastSizeFailure = undefined
    const traceId = randomUUID()
    const started = performance.now()
    this.diagnose('connection.open', { traceId, status: 'begin', step: 'load' })
    const operation = (async () => {
      try { await this.load() }
      catch (error) {
        this.diagnose('connection.open', { traceId, status: 'error', step: 'load', elapsedMs: performance.now() - started, error })
        throw error
      }
      this.diagnose('connection.open', { traceId, status: 'ok', step: 'load', elapsedMs: performance.now() - started })
      if (this.closed) throw new Error('Agent Host view is closed.')
      const abort = new AbortController()
      let active: typeof this.current
      let step: NonNullable<AgentHostDiagnosticDetails['step']> = 'transport'
      let stepStarted = performance.now()
      const advance = (next: NonNullable<AgentHostDiagnosticDetails['step']>) => {
        this.diagnose('connection.open', { traceId, status: 'ok', step, elapsedMs: performance.now() - stepStarted })
        step = next
        stepStarted = performance.now()
      }
      try {
        const client = new AhpClient(await this.transport(abort.signal, traceId), { requestTimeoutMs: 60000, subscriptionBuffer: 4096 })
        active = { client, abort, traceId }
        if (this.closed) { abort.abort(); await client.shutdown(); throw new Error('Agent Host view is closed.') }
        advance('initialize')
        this.current = active
        this.modelCatalog = undefined
        client.connect()
        const initialized = await client.initialize({ clientId: randomUUID(), protocolVersions: [...agentHostProtocolVersions] })
        this.initialized = { ...initialized, protocolVersion: requireAgentHostProtocolVersion(initialized.protocolVersion) }
        advance('session')
        this.snapshots.clear()
        this.subscribing.clear()
        this.terminalSubscriptions.clear()
        this.terminalRequests.clear()
        this.terminalStatus.clear()
        this.referencedTerminals.clear()
        this.activeTerminals.clear()
        await this.subscribe(this.target.sessionId, active)
        if (this.current === active && this.error !== undefined) {
          this.error = undefined
          this.emit({ type: 'state' })
        }
        advance('chat')
        await this.subscribe(this.target.chatId, active, true)
        advance('reconcile')
        if (this.current !== active || abort.signal.aborted) throw new Error('Agent Host connection changed.')
        this.connected = true
        this.failures = 0
        this.error = undefined
        await this.reconcile(true)
        this.emit({ type: 'state' })
        this.discoverActiveTerminals()
        this.heartbeat = setInterval(() => {
          const sent = performance.now()
          void client.ping().then(() => {
            if (this.current === active) this.diagnose('connection.heartbeat', { traceId, status: 'ok', elapsedMs: performance.now() - sent })
          }).catch((error: unknown) => {
            this.diagnose('connection.heartbeat', { traceId, status: 'error', elapsedMs: performance.now() - sent, error })
            this.offline(active!, 'heartbeat-failed')
          })
        }, 15000)
        this.heartbeat.unref()
        void (async () => { for await (const state of client.stateChanges()) if (state.status === 'closed') this.offline(active!, 'transport-closed') })()
        advance('response')
        this.diagnose('connection.open', { traceId, status: 'ok', step: 'response', elapsedMs: performance.now() - started })
      } catch (error) {
        this.diagnose('connection.open', { traceId, status: 'error', step, elapsedMs: performance.now() - stepStarted, error })
        if (active) { this.offline(active, 'stream-error', error); await active.client.shutdown() }
        else abort.abort()
        this.lastSizeFailure = agentHostSizeLimit(error) ?? this.lastSizeFailure
        this.error = this.lastSizeFailure?.message ?? 'Agent Host is unavailable, unsupported, or no longer authorized. No session was created and no message was replayed.'
        this.emit({ type: 'state' })
        this.scheduleRecovery()
        throw error
      }
    })()
    this.opening = operation
    try { await operation } finally { this.opening = undefined; this.emit({ type: 'state' }) }
  }

  private async subscribe(resource: string, active: NonNullable<typeof this.current>, freshChat = false): Promise<void> {
    if (this.subscribing.has(resource)) return
    const channel = agentHostDiagnosticChannel(resource, this.target)
    const started = performance.now()
    this.diagnose('connection.subscribe', { traceId: active.traceId, status: 'begin', channel })
    if (!this.allowedChannel(resource)) {
      const error = new Error('This channel does not belong to the linked chat.')
      this.diagnose('connection.subscribe', { traceId: active.traceId, status: 'error', channel, elapsedMs: performance.now() - started, error })
      throw error
    }
    this.subscribing.add(resource)
    try {
      const chunkedCapability = resource === this.target.chatId ? this.chunkedSnapshotCapability() : undefined
      if (chunkedCapability) {
        const subscription = active.client.attachSubscription(resource)
        let activatedOnServer = false
        try {
          const received = await receiveChunkedChatSnapshot({
            baseFilePath: this.file,
            target: this.target,
            subscribe: true,
            signal: active.abort.signal,
            capability: chunkedCapability,
            ...(this.pagedHistory ? { history: {} } : {}),
            request: (method, params) => this.requestExtension(active, method, params),
            onProgress: (progress) => {
              if (this.current !== active) return
              this.updateHistoryProgress(progress && { ...progress, ...(this.pagedHistory ? { kind: 'recent' as const } : {}) })
            },
            onChunkSaved: () => {
              if (this.current === active) this.failures = 0
            },
          })
          activatedOnServer = true
          if (this.current !== active) {
            this.diagnose('connection.subscribe', { traceId: active.traceId, status: 'closed', channel, reason: 'transport-closed', elapsedMs: performance.now() - started })
            return
          }
          this.acceptSnapshot(received.snapshot, freshChat, received.history)
          this.diagnose('connection.subscribe', {
            traceId: active.traceId, status: 'ok', channel, elapsedMs: performance.now() - started,
            bytes: received.totalBytes, count: received.chunksTransferred,
          })
          void this.pump(subscription, active, resource)
        } catch (error) {
          await subscription.close()
          if (activatedOnServer && this.current === active) {
            try { await active.client.unsubscribe(resource) }
            catch (failure) { this.diagnose('connection.subscribe', { traceId: active.traceId, status: 'error', channel, step: 'response', error: failure }) }
          }
          throw error
        } finally {
          if (this.current !== active || !this.subscribing.has(resource)) await subscription.close()
        }
        return
      }
      const { result, subscription } = await active.client.subscribe(resource, { delivery: { maxLatencyMs: 25 } })
      try {
        if (this.current !== active) {
          this.diagnose('connection.subscribe', { traceId: active.traceId, status: 'closed', channel, reason: 'transport-closed', elapsedMs: performance.now() - started })
          return
        }
        if (!result.snapshot || result.snapshot.resource !== resource) throw new Error('Agent Host did not return the requested snapshot.')
        this.acceptSnapshot(result.snapshot, freshChat)
        if (resource === this.target.chatId) void removePartialSnapshotFiles(this.file)
        if (agentHostTerminalIdSchema.safeParse(resource).success) this.terminalSubscriptions.set(resource, subscription)
        this.diagnose('connection.subscribe', { traceId: active.traceId, status: 'ok', channel, elapsedMs: performance.now() - started })
        void this.pump(subscription, active, resource)
      } catch (error) {
        if (this.current === active) {
          try { await active.client.unsubscribe(resource) }
          catch (failure) { this.diagnose('connection.subscribe', { traceId: active.traceId, status: 'error', channel, step: 'response', error: failure }) }
        }
        throw error
      } finally {
        if (this.current !== active || !this.subscribing.has(resource)) await subscription.close()
      }
    } catch (error) {
      if (this.current === active) this.subscribing.delete(resource)
      this.diagnose('connection.subscribe', { traceId: active.traceId, status: 'error', channel, elapsedMs: performance.now() - started, error })
      throw error
    }
  }

  private acceptSnapshot(snapshot: Snapshot, freshChat = false, history?: SnapshotHistoryPage): void {
    if (!Number.isSafeInteger(snapshot.fromSeq) || snapshot.fromSeq < 0 || !this.allowedChannel(snapshot.resource)) throw new Error('Invalid Agent Host snapshot identity.')
    const replaceChat = freshChat && snapshot.resource === this.target.chatId
    if (!replaceChat && (snapshot.resource === this.target.chatId ? this.chat.lastSequence : this.snapshots.get(snapshot.resource)?.fromSeq ?? -1) > snapshot.fromSeq) return
    if (snapshot.resource === this.target.sessionId && !(snapshot.state as SessionState).chats?.some((chat) => chat.resource === this.target.chatId && chat.interactivity !== 'hidden')) throw new Error('The chat is not a visible member of this original session.')
    if (agentHostTerminalIdSchema.safeParse(snapshot.resource).success) {
      const state = snapshot.state as TerminalState
      if (!Array.isArray(state.content) || state.claim?.kind !== 'session' || state.claim.session !== this.target.sessionId || state.claim.chat !== this.target.chatId) throw new Error('The terminal does not belong to the linked chat.')
    }
    if (snapshot.resource === this.target.chatId) {
      // A reconnect may restart serverSeq; keep displayed history until validation succeeds.
      const previous = this.chat
      const previousHistory = this.historyPage
      const wasLoaded = previous.loaded
      const chat = replaceChat ? new AgentHostChatState(this.target.chatId) : this.chat
      chat.snapshot(snapshot)
      this.unverifiedCacheTurns.clear()
      if (replaceChat && history && previousHistory?.epoch === history.epoch) {
        const retained = chat.retainEarlierHistory(previous)
        if (retained.length) {
          this.unverifiedCacheTurns = new Set(retained)
          const hasMore = Boolean(previousHistory.beforeTurnId) || history.totalTurns === undefined
            || history.totalTurns > chat.completedTurns
          history = { ...history, beforeTurnId: hasMore ? chat.oldestTurnId : undefined }
        }
      }
      this.chat = chat
      this.historyPage = history
      this.historyError = undefined
      if (replaceChat || !wasLoaded) this.historyGeneration = randomUUID()
    } else this.snapshots.set(snapshot.resource, structuredClone(snapshot))
    if (snapshot.resource === this.target.chatId) this.refreshTerminals()
    this.emit({ type: 'snapshot', snapshot })
  }

  private async pump(subscription: Subscription, active: NonNullable<typeof this.current>, resource: string): Promise<void> {
    const channel = agentHostDiagnosticChannel(resource, this.target)
    const terminal = agentHostTerminalIdSchema.safeParse(resource).success
    try {
      for await (const event of subscription) {
        if (this.current !== active || terminal && this.terminalSubscriptions.get(resource) !== subscription) return
        if (event.type === 'authRequired') {
          this.diagnose('connection.stream', { traceId: active.traceId, status: 'error', channel, reason: 'auth-required' })
          if (this.terminalSubscriptions.get(resource) === subscription) {
            this.terminalStatus.set(resource, { state: 'error', error: 'Terminal output requires attention on the owner Host. Retry manually.' })
            this.stopTerminal(resource)
          } else this.error = 'Authentication is required in the owner Agent Host.'
          this.emit({ type: 'state' })
          continue
        }
        if (event.type !== 'action') continue
        const envelope = event.params
        if (!this.allowedChannel(envelope.channel) || !Number.isSafeInteger(envelope.serverSeq)) throw new Error('Agent Host event identity changed.')
        if (envelope.channel === this.target.chatId) {
          if (envelope.action.type === 'chat/truncated' && this.historyPage) {
            this.offline(active, 'stream-error', new AgentHostSnapshotSupersededError('The original history was edited. Reloading its recent window.'))
            return
          }
          const loading = this.historyLoading
          const previousCount = this.chat.completedTurns
          if (!this.chat.apply(envelope)) continue
          if (loading?.active === active && this.chat.completedTurns !== previousCount) {
            if (loading.counts.length >= SNAPSHOT_TRANSFER_LIMITS.maxTailEvents) throw new AgentHostSnapshotSupersededError('History changed too quickly while loading a page.')
            loading.counts.push({ sequence: envelope.serverSeq, delta: this.chat.completedTurns - previousCount })
          }
          if (envelope.action.type === 'chat/truncated') this.historyGeneration = randomUUID()
          if (this.historyPage?.totalTurns !== undefined) this.historyPage.totalTurns += this.chat.completedTurns - previousCount
          this.refreshTerminals()
        } else {
          const prior = this.snapshots.get(envelope.channel)
          if (!prior) throw new Error('Agent Host channel needs a snapshot.')
          if (envelope.serverSeq <= prior.fromSeq) continue
          let state: Snapshot['state']
          if (envelope.channel === this.target.sessionId && envelope.action.type.startsWith('session/')) state = sessionReducer(prior.state as SessionState, envelope.action as Parameters<typeof sessionReducer>[1])
          else if (agentHostTerminalIdSchema.safeParse(envelope.channel).success && envelope.action.type.startsWith('terminal/')) state = terminalReducer(prior.state as TerminalState, envelope.action as Parameters<typeof terminalReducer>[1])
          else throw new Error('Unexpected Agent Host action.')
          if (envelope.channel === this.target.sessionId && !(state as SessionState).chats.some((chat) => chat.resource === this.target.chatId && chat.interactivity !== 'hidden')) throw new Error('The selected chat is no longer available in this session.')
          if (agentHostTerminalIdSchema.safeParse(envelope.channel).success) {
            const terminal = state as TerminalState
            if (terminal.claim.kind !== 'session' || terminal.claim.session !== this.target.sessionId || terminal.claim.chat !== this.target.chatId) throw new Error('The terminal changed ownership.')
          }
          this.snapshots.set(envelope.channel, { resource: envelope.channel, fromSeq: envelope.serverSeq, state })
        }
        this.emit({ type: 'action', envelope })
        void this.reconcile().catch(() => { this.error = 'Delivery confirmation could not be saved. Inspect the owner before retrying.'; this.emit({ type: 'state' }) })
        if (envelope.channel === this.target.chatId) this.discoverActiveTerminals()
      }
      this.diagnose('connection.stream', { traceId: active.traceId, status: 'closed', channel, reason: 'stream-ended' })
      if (terminal) {
        if (this.terminalSubscriptions.get(resource) === subscription) this.failTerminalStream(resource)
      } else this.offline(active, 'stream-ended')
    } catch (error) {
      this.diagnose('connection.stream', { traceId: active.traceId, status: 'error', channel, reason: 'stream-error', error })
      if (terminal) {
        if (this.terminalSubscriptions.get(resource) === subscription) this.failTerminalStream(resource)
      } else this.offline(active, 'stream-error')
    }
  }

  private refreshTerminals(): void {
    const { referenced, active } = this.chat.terminalResources
    this.referencedTerminals = referenced
    this.activeTerminals = active
    for (const resource of this.terminalSubscriptions.keys()) if (!referenced.has(resource) || !active.has(resource) && !this.terminalLeases.has(resource)) this.stopTerminal(resource)
    for (const resource of this.terminalStatus.keys()) if (!referenced.has(resource)) this.terminalStatus.delete(resource)
  }

  private discoverActiveTerminals(): void {
    for (const resource of this.activeTerminals) if (!this.subscribing.has(resource) && !this.terminalRequests.has(resource) && this.terminalStatus.get(resource)?.state !== 'error') {
      void this.terminal(resource).catch(() => {})
    }
  }

  private stopTerminal(resource: string): void {
    const subscription = this.terminalSubscriptions.get(resource)
    if (!subscription) return
    this.terminalSubscriptions.delete(resource)
    this.subscribing.delete(resource)
    this.snapshots.delete(resource)
    const active = this.current
    void subscription.close().catch((error: unknown) => { this.diagnose('connection.subscribe', { traceId: active?.traceId, status: 'error', channel: 'terminal', step: 'response', error }) })
    if (active) void active.client.unsubscribe(resource).catch((error: unknown) => { this.diagnose('connection.subscribe', { traceId: active.traceId, status: 'error', channel: 'terminal', step: 'response', error }) })
    this.emit({ type: 'state' })
  }

  private failTerminalStream(resource: string): void {
    this.terminalStatus.set(resource, { state: 'error', error: 'The terminal output stream stopped. Retry manually.' })
    this.stopTerminal(resource)
  }

  private async reconcile(authoritative = false): Promise<void> {
    let changed = false
    for (const command of this.commands) {
      if (command.state !== 'pending' && command.state !== 'uncertain') continue
      const active = this.current
      const found = authoritative && active ? await this.originalHasTurn(command.id, active)
        : this.chat.hasTurn(command.id) && !this.unverifiedCacheTurns.has(command.id)
      if (found) { command.state = 'confirmed'; changed = true }
    }
    if (changed) { await this.save(); this.emit({ type: 'state' }) }
  }

  async models(parentTraceId?: string): Promise<ModelCatalog> {
    const started = performance.now()
    let step: NonNullable<AgentHostDiagnosticDetails['step']> = 'load'
    let traceId = this.current?.traceId
    this.diagnose('connection.models', { traceId, parentTraceId, status: 'begin', step })
    try {
      await this.open()
      const active = this.current!
      traceId = active.traceId
      if (this.initialized?._meta?.taskcontinuumCanSend !== undefined && this.initialized._meta.taskcontinuumModelSelection !== true) throw new Error('Update Task Continuum on the owner device to select remote models.')
      step = 'root'
      let catalog = this.modelCatalog
      if (catalog?.active !== active || !catalog.pending) {
        catalog = { active }
        this.modelCatalog = catalog
        const selected = catalog
        selected.pending = this.loadModels(active).then((models) => {
          if (this.current !== active || this.modelCatalog !== selected) throw new Error('The connection changed while loading models.')
          selected.models = models
          return models
        }).catch((error: unknown) => {
          selected.failed = true
          throw error
        }).finally(() => { selected.pending = undefined })
      }
      const models = await catalog.pending!
      this.diagnose('connection.models', { traceId: active.traceId, parentTraceId, status: 'ok', step, elapsedMs: performance.now() - started, count: models.length })
      return structuredClone(models)
    } catch (error) {
      this.diagnose('connection.models', { traceId, parentTraceId, status: 'error', step, elapsedMs: performance.now() - started, error })
      throw error
    }
  }

  private async loadModels(active: NonNullable<typeof this.current>): Promise<ModelCatalog> {
    const { result, subscription } = await active.client.subscribe('ahp-root://')
    try {
      if (this.current !== active || result.snapshot?.resource !== 'ahp-root://') throw new Error('The model catalog is unavailable.')
      const root = z.object({ agents: z.array(z.object({ provider: z.string(), models: z.array(agentHostModelInfoSchema).max(1000) })).max(100) }).parse(result.snapshot.state)
      const provider = (this.snapshots.get(this.target.sessionId)?.state as SessionState | undefined)?.provider
      const agent = root.agents.find((item) => item.provider === provider)
      if (!agent) throw new Error('The original session provider has no model catalog.')
      return agent.models.filter((model) => model.provider === provider && model.policyState !== 'disabled').map(({ id, name, provider, configSchema }) => ({ id, name, provider, ...(configSchema ? { configSchema } : {}) }))
    } finally { await subscription.close() }
  }

  private async modelsForSend(): Promise<ModelCatalog> {
    const catalog = this.modelCatalog
    if (catalog && catalog.active === this.current) {
      if (catalog.pending) return catalog.pending
      if (catalog.failed) throw new Error('The model catalog could not be refreshed. Retry loading models before sending.')
      if (catalog.models) return catalog.models
    }
    return this.models()
  }

  private validateModel(model: ModelSelection, models: ModelCatalog): void {
    const provider = (this.snapshots.get(this.target.sessionId)?.state as SessionState | undefined)?.provider
    const selected = models.find((item) => item.id === model.id && item.provider === provider)
    if (!selected) throw new Error('The selected model is no longer available. Refresh the model list and choose another model.')
    if (Object.keys(model.config ?? {}).length && this.initialized?._meta?.taskcontinuumCanSend !== undefined && this.initialized._meta.taskcontinuumModelConfig !== true) throw new Error('Update Task Continuum on the owner device to configure remote models.')
    const errors = modelConfigErrors(selected.configSchema, model.config ?? {})
    if (errors.length) throw new Error(errors.join(' '))
  }

  async send(id: string, text: string, images: ChatImageAttachment[] | undefined, authorize: () => Promise<void>, actor?: { clientId: string; machineName: string; username?: string }, model?: ModelSelection): Promise<void> {
    const command = { ...chatSubmissionSchema.parse({ id, text, ...(images?.length ? { images } : {}) }), ...(model === undefined ? {} : { model: agentHostModelSelectionSchema.parse(model) }) }
    if (this.sending || this.reviewing) {
      const error = new Error('Another delivery or review is in progress for this chat.')
      this.diagnose('connection.send', { traceId: this.current?.traceId, status: 'error', step: 'validation', dispatched: false, error })
      throw error
    }
    this.sending = true
    const started = performance.now()
    let step: NonNullable<AgentHostDiagnosticDetails['step']> = 'load'
    let traceId = this.current?.traceId
    this.diagnose('connection.send', { traceId, status: 'begin', step, dispatched: false })
    let record: Command | undefined
    let dispatched = false
    let phaseStarted = started
    const phase = (next: NonNullable<AgentHostDiagnosticDetails['step']>) => {
      this.diagnose('connection.send.phase', { traceId, status: 'ok', step, elapsedMs: performance.now() - phaseStarted, dispatched })
      step = next
      phaseStarted = performance.now()
    }
    try {
      await this.open()
      traceId = this.current?.traceId
      phase('authorization')
      await authorize()
      if (command.model) {
        phase('models')
        this.validateModel(command.model, await this.modelsForSend())
      }
      const active = this.current!
      if (this.initialized?._meta?.taskcontinuumCanSend === undefined || this.initialized._meta.taskcontinuumStreamedSendValidation !== true) {
        phase('snapshot')
        const fresh = await active.client.request('subscribe', { channel: this.target.chatId })
        if (this.current !== active || !fresh.snapshot) throw new Error('The connection changed before sending. Nothing was sent.')
        phase('snapshot-apply')
        this.acceptSnapshot(fresh.snapshot)
      }
      phase('reconcile')
      if (this.current !== active || !this.connected || !this.chat.loaded) throw new Error('The connection changed before sending. Nothing was sent.')
      await this.reconcile()
      phase('validation')
      const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex')
      const prior = this.commands.find((item) => item.id === id)
      if (prior) { if (prior.hash !== hash) throw new Error('This message ID belongs to different content.'); if (prior.state === 'confirmed') return; throw new Error('This message was already attempted. Inspect the original; it was not replayed.') }
      const chat = this.chat.sendState
      if (this.readOnly || this.commands.some((item) => item.state === 'pending' || item.state === 'uncertain') || chat.activeTurnId || chat.hasDraft || chat.hasQueuedMessages) throw new Error('The original chat is busy, has a draft, is read-only, or has an uncertain delivery.')
      if (this.commands.length >= 1000) throw new Error('Delivery record limit reached. No message was sent.')
      phase('ledger')
      record = { id, hash, state: 'pending' }
      this.commands.push(record)
      await this.save()
      phase('authorization')
      await authorize()
      phase('validation')
      if (this.current !== active || !this.connected) throw new Error('The connection changed before sending. Nothing was sent.')
      const latest = this.chat.sendState
      if (this.readOnly || latest.activeTurnId || latest.hasDraft || latest.hasQueuedMessages) throw new Error('The original chat became busy or has a new draft. Nothing was sent.')
      if (command.model) {
        const catalog = this.modelCatalog
        if (catalog?.active !== active || !catalog.models || catalog.pending || catalog.failed) throw new Error('The model catalog changed before sending. Retry after loading models. Nothing was sent.')
        this.validateModel(command.model, catalog.models)
      }
      const selection = this.chat.selection
      const selectedModel = command.model ?? selection?.model
      const attachments: MessageEmbeddedResourceAttachment[] | undefined = command.images?.map((image) => ({ type: 'embeddedResource' as MessageEmbeddedResourceAttachment['type'], label: image.name, displayKind: 'image', contentType: image.mimeType, data: image.data, _meta: { taskcontinuumImageId: image.id } }))
      const action: ChatTurnStartedAction = { type: 'chat/turnStarted' as ChatTurnStartedAction['type'], turnId: id, startedAt: new Date().toISOString(), message: { text: command.text, origin: { kind: MessageKind.User }, ...(attachments?.length ? { attachments } : {}), ...(selection?.agent ? { agent: selection.agent } : {}), ...(selectedModel ? { model: selectedModel } : {}), ...(actor ? { _meta: { taskcontinuumActor: actor } } : {}) } }
      phase('dispatch')
      dispatched = true
      active.client.dispatch(this.target.chatId, action)
      this.emit({ type: 'state' })
      phase('confirmation')
      await this.waitForTurn(id, active)
      this.diagnose('connection.send.phase', { traceId, status: 'ok', step, elapsedMs: performance.now() - phaseStarted, dispatched })
      this.diagnose('connection.send', { traceId: active.traceId, status: 'ok', step, elapsedMs: performance.now() - started, dispatched })
    } catch (error) {
      this.diagnose('connection.send.phase', { traceId, status: 'error', step, elapsedMs: performance.now() - phaseStarted, dispatched, error })
      this.diagnose('connection.send', { traceId, status: 'error', step, elapsedMs: performance.now() - started, dispatched, error })
      if (record && record.state !== 'confirmed') { record.state = dispatched ? 'uncertain' : 'failed'; await this.save() }
      throw error
    } finally { this.sending = false; this.emit({ type: 'state' }) }
  }

  private waitForTurn(id: string, active: NonNullable<typeof this.current>): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error('Delivery was not confirmed. Inspect the original chat; no automatic replay.')) }, 15000)
      const check = () => {
        if (this.chat.hasTurn(id)) { stop(); resolve() }
        else if (this.current !== active) { stop(); reject(new Error('Disconnected before confirmation. Inspect the original chat; no automatic replay.')) }
      }
      const unlisten = this.listen(check)
      const stop = () => { clearTimeout(timer); unlisten() }
      check()
    })
  }

  async resolveDelivery(id: string, action: 'check' | 'abandon', authorize: () => Promise<void>): Promise<'confirmed' | 'not-found' | 'abandoned'> {
    z.uuid().parse(id)
    if (action !== 'check' && action !== 'abandon') throw new Error('Invalid delivery review action.')
    if (this.sending) throw new Error('Wait for the current delivery attempt to finish before reviewing it.')
    if (this.reviewing) throw new Error('A delivery review is already in progress.')
    this.reviewing = true
    try {
      await this.load()
      const record = this.commands.find((command) => command.id === id)
      if (!record) throw new Error('No delivery attempt matches this turn.')
      if (record.state === 'confirmed' || record.state === 'abandoned') return record.state
      if (record.state !== 'uncertain') throw new Error('Only an uncertain delivery can be reviewed.')
      await authorize()
      await this.open()
      const active = this.current
      if (!active || !this.connected) throw new Error('Reconnect to the original Agent Host before reviewing delivery.')
      const chunkedCapability = this.chunkedSnapshotCapability()
      const snapshot = this.pagedHistory ? undefined : chunkedCapability
        ? (await receiveChunkedChatSnapshot({
          baseFilePath: this.file,
          target: this.target,
          subscribe: false,
          signal: active.abort.signal,
          capability: chunkedCapability,
          request: (method, params) => this.requestExtension(active, method, params),
          onChunkSaved: () => { if (this.current === active) this.failures = 0 },
        })).snapshot
        : (await active.client.request('subscribe', { channel: this.target.chatId })).snapshot
      if (this.current !== active || !this.connected || !this.pagedHistory && !snapshot) throw new Error('The Agent Host connection changed while reviewing delivery.')
      if (snapshot) this.acceptSnapshot(snapshot)
      await this.reconcile(true)
      await authorize()
      if (this.current !== active || !this.connected) throw new Error('The Agent Host connection changed while reviewing delivery.')
      const latest = this.commands.find((command) => command.id === id)
      if (latest?.state === 'confirmed') return 'confirmed'
      if (latest !== record || latest.state !== 'uncertain') throw new Error('The delivery record changed while reviewing it.')
      if (action === 'check') return 'not-found'
      if (await this.originalHasTurn(id, active)) {
        record.state = 'confirmed'
        try { await this.save() } catch (error) { if (record.state === 'confirmed') record.state = 'uncertain'; throw error }
        this.emit({ type: 'state' })
        return 'confirmed'
      }
      // Only an explicit user decision retires the old UUID; it is never replayed.
      record.state = 'abandoned'
      try { await this.save() } catch (error) { if (record.state === 'abandoned') record.state = 'uncertain'; throw error }
      this.emit({ type: 'state' })
      return 'abandoned'
    } finally { this.reviewing = false }
  }

  async cancel(turnId: string, authorize: () => Promise<void>): Promise<void> {
    await authorize()
    const active = this.current
    if (!active || !this.connected || this.readOnly || this.chat.sendState.activeTurnId !== turnId) throw new Error('This exact turn is no longer running or control is not permitted.')
    active.client.dispatch(this.target.chatId, { type: 'chat/turnCancelled' as ChatTurnCancelledAction['type'], turnId, duration: 0 })
  }

  private offline(active: NonNullable<typeof this.current>, reason: NonNullable<AgentHostDiagnosticDetails['reason']>, error?: unknown): void {
    if (this.current !== active) return
    const state = active.client.connectionState
    this.lastSizeFailure = agentHostSizeLimit(error ?? (state.status === 'closed' && state.reason.type === 'transport' ? state.reason.error : undefined))
    this.diagnose('connection.offline', { traceId: active.traceId, status: 'closed', reason, ...(this.lastSizeFailure ? { error: this.lastSizeFailure } : {}) })
    this.current = undefined
    this.modelCatalog = undefined
    this.historyTransfer = undefined
    this.connected = false
    clearInterval(this.heartbeat)
    active.abort.abort()
    void active.client.shutdown()
    this.terminalSubscriptions.clear()
    this.terminalRequests.clear()
    this.subscribing.clear()
    for (const command of this.commands) if (command.state === 'pending') command.state = 'uncertain'
    void this.save().catch(() => undefined)
    this.error = this.lastSizeFailure?.message ?? 'Agent Host disconnected. Restoring state only; messages are never replayed.'
    this.emit({ type: 'state' })
    this.scheduleRecovery()
  }

  private scheduleRecovery(): void {
    if (this.closed || this.retry || this.lastSizeFailure || !this.listeners.size) return
    const attempt = this.failures + 1
    const retryMs = Math.min(30000, 1000 * 2 ** Math.min(this.failures++, 5))
    this.diagnose('connection.retry', { status: 'scheduled', attempt, retryMs })
    this.retry = setTimeout(() => { this.retry = undefined; void this.open().catch(() => undefined) }, retryMs)
    this.retry.unref()
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.retry)
    clearInterval(this.heartbeat)
    if (this.current) this.offline(this.current, 'shutdown')
    await this.opening?.catch(() => undefined)
    if (this.historyLoading) await Promise.allSettled([this.historyLoading.promise])
    if (this.nativeHistoryLoading) await Promise.allSettled([this.nativeHistoryLoading.promise])
    await this.writing
    const chat = this.chat.toSnapshot()
    try {
      if (chat) {
        const paged = Boolean(this.historyPage || this.chat.nativeHistoryCursor)
        const text = JSON.stringify({
          schemaVersion: paged ? 3 : 2, target: this.target, chat,
          ...(this.historyPage ? { history: this.historyPage } : {}),
        }) + '\n'
        const bytes = Buffer.byteLength(text)
        if (bytes > AGENT_HOST_LIMITS.cacheBytes) throw new AgentHostSizeLimitError('cache', AGENT_HOST_LIMITS.cacheBytes, bytes)
        await writeTextAtomic(`${this.file}.cache.json`, text)
        this.diagnose('connection.cache', { status: 'ok', step: 'cache', bytes })
      }
    } catch (error) {
      this.diagnose('connection.cache', { status: 'error', step: 'cache', error })
      throw error
    } finally {
      this.listeners.clear()
      this.diagnose('connection.close', { status: 'closed', reason: 'shutdown' })
    }
  }
}