import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import type { AhpTransport, Subscription } from '@microsoft/agent-host-protocol/client'
import { MessageKind, sessionReducer, terminalReducer } from '@microsoft/agent-host-protocol'
import type { ActionEnvelope, ChatTurnStartedAction, ChatTurnCancelledAction, InitializeResult, MessageEmbeddedResourceAttachment, ModelSelection, SessionModelInfo, SessionState, Snapshot, TerminalState } from '@microsoft/agent-host-protocol'
import type { AgentHostTarget, AgentHostView } from '../shared/agentHost'
import { chatSubmissionSchema } from '../shared/chatAttachments'
import type { ChatImageAttachment } from '../shared/chatAttachments'
import { modelConfigErrors } from '../shared/agentHostModelConfig'
import { AgentHostChatState } from './agentHostState'
import { agentHostDiagnosticChannel, logAgentHostDiagnostic } from './agentHostDiagnostics'
import type { AgentHostDiagnosticDetails, AgentHostDiagnosticEvent } from './agentHostDiagnostics'
import { agentHostKey, agentHostModelInfoSchema, agentHostModelSelectionSchema, agentHostTargetSchema, agentHostTerminalIdSchema } from './agentHostProtocol'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'

export type AgentHostEvent = { type: 'action'; envelope: ActionEnvelope } | { type: 'snapshot'; snapshot: Snapshot } | { type: 'state' }
const commandSchema = z.object({ id: z.uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['pending', 'uncertain', 'confirmed', 'failed']) }).strict()
const ledgerSchema = z.object({ schemaVersion: z.literal(2), target: agentHostTargetSchema, commands: z.array(commandSchema).max(1000) }).strict()
type Command = z.infer<typeof commandSchema>
type ModelCatalog = Pick<SessionModelInfo, 'id' | 'name' | 'provider' | 'configSchema'>[]
type ActiveConnection = { client: AhpClient; abort: AbortController; traceId: string }

export class AgentHostConnection {
  private current?: ActiveConnection
  private opening?: Promise<void>
  private closed = false
  private connected = false
  private error?: string
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
  private retry?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private failures = 0
  private readonly file: string
  private initialized?: InitializeResult
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

  get view(): AgentHostView {
    const chat = this.chat.value
    const pending = this.commands.find((command) => command.state === 'pending' || command.state === 'uncertain')
    const readOnly = this.initialized?._meta?.taskcontinuumCanSend === false || chat?.interactivity === 'read-only' || chat?.interactivity === 'hidden'
    return { target: this.target, state: this.connected ? 'connected' : this.opening ? 'connecting' : 'offline', chat,
      terminals: Object.fromEntries([...this.snapshots].filter(([resource]) => this.referencedTerminals.has(resource)).map(([resource, snapshot]) => [resource, structuredClone(snapshot.state) as TerminalState])),
      terminalStatus: Object.fromEntries([...this.terminalStatus].filter(([resource]) => this.referencedTerminals.has(resource))),
      canSend: this.connected && !readOnly && !pending && !this.sending && !chat?.activeTurn && !chat?.draft?.text && !chat?.draft?.attachments?.length && !chat?.queuedMessages?.length, readOnly,
      error: this.error, ...(pending ? { pendingTurn: { id: pending.id, state: pending.state as 'pending' | 'uncertain' } } : {}) }
  }

  get handshake(): InitializeResult {
    if (!this.initialized || !this.connected) throw new Error('Agent Host is offline.')
    return { protocolVersion: this.initialized.protocolVersion, serverSeq: Math.max(0, ...[...this.snapshots.values()].map((snapshot) => snapshot.fromSeq)), snapshots: [], terminalCommandPrefix: this.initialized.terminalCommandPrefix }
  }

  snapshot(resource: string): Snapshot {
    const snapshot = this.snapshots.get(resource)
    if (!this.connected || !snapshot) throw new Error('This Agent Host channel is unavailable.')
    if (resource === this.target.sessionId) {
      const state = snapshot.state as SessionState
      return { ...snapshot, state: { provider: state.provider, title: state.title, lifecycle: state.lifecycle, status: state.status,
        activeClients: [], chats: structuredClone(state.chats.filter((chat) => chat.resource === this.target.chatId)), defaultChat: this.target.chatId } }
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
        const saved = z.object({ schemaVersion: z.literal(2), target: agentHostTargetSchema, chat: z.unknown() }).strict().parse(await readJsonBounded(`${this.file}.cache.json`, 16 * 1024 * 1024))
        if (agentHostKey(saved.target) === agentHostKey(this.target)) this.chat.snapshot(saved.chat as Snapshot)
        this.refreshTerminals()
      } catch { this.error = 'No verified offline history is available yet.' }
    })()
    return this.loaded
  }

  private save(): Promise<void> {
    const ledger = structuredClone({ schemaVersion: 2, target: this.target, commands: this.commands })
    const operation = this.writing.then(() => writeJsonAtomic(`${this.file}.commands.json`, ledgerSchema.parse(ledger)))
    this.writing = operation.catch(() => undefined)
    return operation
  }

  async open(): Promise<void> {
    if (this.closed) throw new Error('Agent Host view is closed.')
    if (this.connected) return
    if (this.opening) return this.opening
    clearTimeout(this.retry)
    this.retry = undefined
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
        const client = new AhpClient(await this.transport(abort.signal, traceId), { requestTimeoutMs: 15000, subscriptionBuffer: 4096 })
        active = { client, abort, traceId }
        if (this.closed) { abort.abort(); await client.shutdown(); throw new Error('Agent Host view is closed.') }
        advance('initialize')
        this.current = active
        this.modelCatalog = undefined
        client.connect()
        this.initialized = await client.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'] })
        if (this.initialized.protocolVersion !== '0.9.0') throw new Error('Unsupported Agent Host protocol.')
        advance('session')
        this.snapshots.clear()
        this.subscribing.clear()
        this.terminalSubscriptions.clear()
        this.terminalRequests.clear()
        this.terminalStatus.clear()
        this.referencedTerminals.clear()
        this.activeTerminals.clear()
        this.chat = new AgentHostChatState(this.target.chatId)
        await this.subscribe(this.target.sessionId, active)
        advance('chat')
        await this.subscribe(this.target.chatId, active)
        advance('reconcile')
        if (this.current !== active || abort.signal.aborted) throw new Error('Agent Host connection changed.')
        this.connected = true
        this.failures = 0
        this.error = undefined
        await this.reconcile()
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
        if (active) { this.offline(active, 'stream-error'); await active.client.shutdown() }
        else abort.abort()
        this.error = 'Agent Host is unavailable, unsupported, or no longer authorized. No session was created and no message was replayed.'
        this.emit({ type: 'state' })
        this.scheduleRecovery()
        throw error
      }
    })()
    this.opening = operation
    try { await operation } finally { this.opening = undefined; this.emit({ type: 'state' }) }
  }

  private async subscribe(resource: string, active: NonNullable<typeof this.current>): Promise<void> {
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
      const { result, subscription } = await active.client.subscribe(resource, { delivery: { maxLatencyMs: 25 } })
      try {
        if (this.current !== active) {
          this.diagnose('connection.subscribe', { traceId: active.traceId, status: 'closed', channel, reason: 'transport-closed', elapsedMs: performance.now() - started })
          return
        }
        if (!result.snapshot || result.snapshot.resource !== resource) throw new Error('Agent Host did not return the requested snapshot.')
        this.acceptSnapshot(result.snapshot)
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

  private acceptSnapshot(snapshot: Snapshot): void {
    if (!Number.isSafeInteger(snapshot.fromSeq) || snapshot.fromSeq < 0 || !this.allowedChannel(snapshot.resource)) throw new Error('Invalid Agent Host snapshot identity.')
    if ((this.snapshots.get(snapshot.resource)?.fromSeq ?? -1) > snapshot.fromSeq) return
    if (snapshot.resource === this.target.sessionId && !(snapshot.state as SessionState).chats?.some((chat) => chat.resource === this.target.chatId && chat.interactivity !== 'hidden')) throw new Error('The chat is not a visible member of this original session.')
    if (agentHostTerminalIdSchema.safeParse(snapshot.resource).success) {
      const state = snapshot.state as TerminalState
      if (!Array.isArray(state.content) || state.claim?.kind !== 'session' || state.claim.session !== this.target.sessionId || state.claim.chat !== this.target.chatId) throw new Error('The terminal does not belong to the linked chat.')
    }
    if (snapshot.resource === this.target.chatId) this.chat.snapshot(snapshot)
    this.snapshots.set(snapshot.resource, structuredClone(snapshot))
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
        const prior = this.snapshots.get(envelope.channel)
        if (!prior || !this.allowedChannel(envelope.channel) || !Number.isSafeInteger(envelope.serverSeq)) throw new Error('Agent Host event identity changed.')
        if (envelope.serverSeq <= prior.fromSeq) continue
        let state: Snapshot['state']
        if (envelope.channel === this.target.chatId) { this.chat.apply(envelope); state = this.chat.value! }
        else if (envelope.channel === this.target.sessionId && envelope.action.type.startsWith('session/')) state = sessionReducer(prior.state as SessionState, envelope.action as Parameters<typeof sessionReducer>[1])
        else if (agentHostTerminalIdSchema.safeParse(envelope.channel).success && envelope.action.type.startsWith('terminal/')) state = terminalReducer(prior.state as TerminalState, envelope.action as Parameters<typeof terminalReducer>[1])
        else throw new Error('Unexpected Agent Host action.')
        if (envelope.channel === this.target.sessionId && !(state as SessionState).chats.some((chat) => chat.resource === this.target.chatId && chat.interactivity !== 'hidden')) throw new Error('The selected chat is no longer available in this session.')
        if (agentHostTerminalIdSchema.safeParse(envelope.channel).success) {
          const terminal = state as TerminalState
          if (terminal.claim.kind !== 'session' || terminal.claim.session !== this.target.sessionId || terminal.claim.chat !== this.target.chatId) throw new Error('The terminal changed ownership.')
        }
        this.snapshots.set(envelope.channel, { resource: envelope.channel, fromSeq: envelope.serverSeq, state })
        if (envelope.channel === this.target.chatId) this.refreshTerminals()
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
    const chat = this.chat.value
    const referenced = new Set<string>()
    const active = new Set<string>()
    const currentTurn = chat?.activeTurn
    for (const turn of [...chat?.turns ?? [], ...currentTurn ? [currentTurn] : []]) for (const part of turn.responseParts) {
      if (part.kind !== 'toolCall' || !('content' in part.toolCall)) continue
      for (const content of part.toolCall.content ?? []) if (content.type === 'terminal' && agentHostTerminalIdSchema.safeParse(content.resource).success) {
        referenced.add(content.resource)
        if (turn === currentTurn && (part.toolCall.status === 'running' || part.toolCall.status === 'auth-required')) active.add(content.resource)
      }
    }
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

  private async reconcile(): Promise<void> {
    const chat = this.chat.value
    let changed = false
    for (const command of this.commands) if ((command.state === 'pending' || command.state === 'uncertain') && (chat?.activeTurn?.id === command.id || chat?.turns.some((turn) => turn.id === command.id))) { command.state = 'confirmed'; changed = true }
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
    if (this.sending) {
      const error = new Error('Another message is being submitted to this chat.')
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
    try {
      await this.open()
      traceId = this.current?.traceId
      step = 'authorization'
      await authorize()
      if (command.model) {
        step = 'models'
        this.validateModel(command.model, await this.modelsForSend())
      }
      const active = this.current!
      step = 'snapshot'
      if (this.initialized?._meta?.taskcontinuumCanSend === undefined || this.initialized._meta.taskcontinuumStreamedSendValidation !== true) {
        const fresh = await active.client.request('subscribe', { channel: this.target.chatId })
        if (this.current !== active || !fresh.snapshot) throw new Error('The connection changed before sending. Nothing was sent.')
        this.acceptSnapshot(fresh.snapshot)
      }
      if (this.current !== active || !this.connected || !this.chat.value) throw new Error('The connection changed before sending. Nothing was sent.')
      await this.reconcile()
      step = 'validation'
      const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex')
      const prior = this.commands.find((item) => item.id === id)
      if (prior) { if (prior.hash !== hash) throw new Error('This message ID belongs to different content.'); if (prior.state === 'confirmed') return; throw new Error('This message was already attempted. Inspect the original; it was not replayed.') }
      const chat = this.chat.value!
      if (this.initialized?._meta?.taskcontinuumCanSend === false || this.commands.some((item) => item.state === 'pending' || item.state === 'uncertain') || chat.activeTurn || chat.draft?.text || chat.draft?.attachments?.length || chat.queuedMessages?.length || chat.interactivity === 'read-only' || chat.interactivity === 'hidden') throw new Error('The original chat is busy, has a draft, is read-only, or has an uncertain delivery.')
      if (this.commands.length >= 1000) throw new Error('Delivery record limit reached. No message was sent.')
      step = 'ledger'
      record = { id, hash, state: 'pending' }
      this.commands.push(record)
      await this.save()
      await authorize()
      if (this.current !== active || !this.connected) throw new Error('The connection changed before sending. Nothing was sent.')
      const latest = this.chat.value!
      if (latest.activeTurn || latest.draft?.text || latest.draft?.attachments?.length || latest.queuedMessages?.length || latest.interactivity === 'read-only' || latest.interactivity === 'hidden') throw new Error('The original chat became busy or has a new draft. Nothing was sent.')
      if (command.model) {
        const catalog = this.modelCatalog
        if (catalog?.active !== active || !catalog.models || catalog.pending || catalog.failed) throw new Error('The model catalog changed before sending. Retry after loading models. Nothing was sent.')
        this.validateModel(command.model, catalog.models)
      }
      const selection = latest.draft ?? latest.turns.at(-1)?.message
      const selectedModel = command.model ?? selection?.model
      const attachments: MessageEmbeddedResourceAttachment[] | undefined = command.images?.map((image) => ({ type: 'embeddedResource' as MessageEmbeddedResourceAttachment['type'], label: image.name, displayKind: 'image', contentType: image.mimeType, data: image.data, _meta: { taskcontinuumImageId: image.id } }))
      const action: ChatTurnStartedAction = { type: 'chat/turnStarted' as ChatTurnStartedAction['type'], turnId: id, startedAt: new Date().toISOString(), message: { text: command.text, origin: { kind: MessageKind.User }, ...(attachments?.length ? { attachments } : {}), ...(selection?.agent ? { agent: selection.agent } : {}), ...(selectedModel ? { model: selectedModel } : {}), ...(actor ? { _meta: { taskcontinuumActor: actor } } : {}) } }
      step = 'dispatch'
      dispatched = true
      active.client.dispatch(this.target.chatId, action)
      this.emit({ type: 'state' })
      step = 'confirmation'
      await this.waitForTurn(id, active)
      this.diagnose('connection.send', { traceId: active.traceId, status: 'ok', step, elapsedMs: performance.now() - started, dispatched })
    } catch (error) {
      this.diagnose('connection.send', { traceId, status: 'error', step, elapsedMs: performance.now() - started, dispatched, error })
      if (record && record.state !== 'confirmed') { record.state = dispatched ? 'uncertain' : 'failed'; await this.save() }
      throw error
    } finally { this.sending = false; this.emit({ type: 'state' }) }
  }

  private waitForTurn(id: string, active: NonNullable<typeof this.current>): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error('Delivery was not confirmed. Inspect the original chat; no automatic replay.')) }, 15000)
      const check = () => {
        const chat = this.chat.value
        if (chat?.activeTurn?.id === id || chat?.turns.some((turn) => turn.id === id)) { stop(); resolve() }
        else if (this.current !== active) { stop(); reject(new Error('Disconnected before confirmation. Inspect the original chat; no automatic replay.')) }
      }
      const unlisten = this.listen(check)
      const stop = () => { clearTimeout(timer); unlisten() }
      check()
    })
  }

  async cancel(turnId: string, authorize: () => Promise<void>): Promise<void> {
    await authorize()
    const active = this.current
    if (!active || !this.connected || this.view.readOnly || this.chat.value?.activeTurn?.id !== turnId) throw new Error('This exact turn is no longer running or control is not permitted.')
    active.client.dispatch(this.target.chatId, { type: 'chat/turnCancelled' as ChatTurnCancelledAction['type'], turnId, duration: 0 })
  }

  private offline(active: NonNullable<typeof this.current>, reason: NonNullable<AgentHostDiagnosticDetails['reason']>): void {
    if (this.current !== active) return
    this.diagnose('connection.offline', { traceId: active.traceId, status: 'closed', reason })
    this.current = undefined
    this.modelCatalog = undefined
    this.connected = false
    clearInterval(this.heartbeat)
    active.abort.abort()
    void active.client.shutdown()
    this.terminalSubscriptions.clear()
    this.terminalRequests.clear()
    this.subscribing.clear()
    for (const command of this.commands) if (command.state === 'pending') command.state = 'uncertain'
    void this.save().catch(() => undefined)
    this.error = 'Agent Host disconnected. Restoring state only; messages are never replayed.'
    this.emit({ type: 'state' })
    this.scheduleRecovery()
  }

  private scheduleRecovery(): void {
    if (this.closed || this.retry || !this.listeners.size) return
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
    await this.writing
    const chat = this.snapshots.get(this.target.chatId)
    if (chat && Buffer.byteLength(JSON.stringify(chat)) < 15 * 1024 * 1024) await writeJsonAtomic(`${this.file}.cache.json`, { schemaVersion: 2, target: this.target, chat })
    this.listeners.clear()
    this.diagnose('connection.close', { status: 'closed', reason: 'shutdown' })
  }
}