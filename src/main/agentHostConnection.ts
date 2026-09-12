import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import type { AhpTransport, Subscription } from '@microsoft/agent-host-protocol/client'
import { MessageKind, sessionReducer, terminalReducer } from '@microsoft/agent-host-protocol'
import type { ActionEnvelope, ChatTurnStartedAction, ChatTurnCancelledAction, InitializeResult, MessageEmbeddedResourceAttachment, ModelSelection, SessionState, Snapshot, TerminalState } from '@microsoft/agent-host-protocol'
import type { AgentHostTarget, AgentHostView } from '../shared/agentHost'
import { chatSubmissionSchema } from '../shared/chatAttachments'
import type { ChatImageAttachment } from '../shared/chatAttachments'
import { AgentHostChatState } from './agentHostState'
import { agentHostKey, agentHostModelInfoSchema, agentHostModelSelectionSchema, agentHostTargetSchema, agentHostTerminalIdSchema } from './agentHostProtocol'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'

export type AgentHostEvent = { type: 'action'; envelope: ActionEnvelope } | { type: 'snapshot'; snapshot: Snapshot } | { type: 'state' }
const commandSchema = z.object({ id: z.uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['pending', 'uncertain', 'confirmed', 'failed']) }).strict()
const ledgerSchema = z.object({ target: agentHostTargetSchema, commands: z.array(commandSchema).max(1000) }).strict()
type Command = z.infer<typeof commandSchema>

export class AgentHostConnection {
  private current?: { client: AhpClient; abort: AbortController }
  private opening?: Promise<void>
  private closed = false
  private connected = false
  private error?: string
  private chat: AgentHostChatState
  private readonly snapshots = new Map<string, Snapshot>()
  private readonly listeners = new Set<(event: AgentHostEvent) => void>()
  private readonly subscribing = new Set<string>()
  private commands: Command[] = []
  private loaded?: Promise<void>
  private writing: Promise<void> = Promise.resolve()
  private sending = false
  private retry?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private failures = 0
  private readonly file: string
  private initialized?: InitializeResult

  constructor(readonly target: AgentHostTarget, directory: string, private readonly transport: (signal: AbortSignal) => Promise<AhpTransport>) {
    agentHostTargetSchema.parse(target)
    this.chat = new AgentHostChatState(target.chatId)
    this.file = join(directory, 'agent-host', createHash('sha256').update(agentHostKey(target)).digest('hex'))
  }

  get view(): AgentHostView {
    const chat = this.chat.value
    const pending = this.commands.find((command) => command.state === 'pending' || command.state === 'uncertain')
    const readOnly = this.initialized?._meta?.taskcontinuumCanSend === false || chat?.interactivity === 'read-only' || chat?.interactivity === 'hidden'
    return { target: this.target, state: this.connected ? 'connected' : this.opening ? 'connecting' : 'offline', chat,
      terminals: Object.fromEntries([...this.snapshots].filter(([resource]) => agentHostTerminalIdSchema.safeParse(resource).success).map(([resource, snapshot]) => [resource, structuredClone(snapshot.state) as TerminalState])),
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

  allowedChannel(resource: string): boolean { return resource === this.target.sessionId || resource === this.target.chatId || this.terminalResources().includes(resource) }

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
        const saved = z.object({ target: agentHostTargetSchema, chat: z.unknown() }).strict().parse(await readJsonBounded(`${this.file}.cache.json`, 16 * 1024 * 1024))
        if (agentHostKey(saved.target) === agentHostKey(this.target)) this.chat.snapshot(saved.chat as Snapshot)
      } catch { this.error = 'No verified offline history is available yet.' }
    })()
    return this.loaded
  }

  private save(): Promise<void> {
    const ledger = structuredClone({ target: this.target, commands: this.commands })
    const operation = this.writing.then(() => writeJsonAtomic(`${this.file}.commands.json`, ledgerSchema.parse(ledger)))
    this.writing = operation.catch(() => undefined)
    return operation
  }

  async open(): Promise<void> {
    if (this.closed) throw new Error('Agent Host view is closed.')
    if (this.connected) return
    if (this.opening) return this.opening
    clearTimeout(this.retry)
    const operation = (async () => {
      await this.load()
      if (this.closed) throw new Error('Agent Host view is closed.')
      const abort = new AbortController()
      let active: typeof this.current
      try {
        const client = new AhpClient(await this.transport(abort.signal), { requestTimeoutMs: 15000, subscriptionBuffer: 4096 })
        active = { client, abort }
        if (this.closed) { abort.abort(); await client.shutdown(); throw new Error('Agent Host view is closed.') }
        this.current = active
        client.connect()
        this.initialized = await client.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'] })
        if (this.initialized.protocolVersion !== '0.9.0') throw new Error('Unsupported Agent Host protocol.')
        this.snapshots.clear()
        this.subscribing.clear()
        this.chat = new AgentHostChatState(this.target.chatId)
        await this.subscribe(this.target.sessionId, active)
        await this.subscribe(this.target.chatId, active)
        if (this.current !== active || abort.signal.aborted) throw new Error('Agent Host connection changed.')
        this.connected = true
        this.failures = 0
        this.error = undefined
        await this.reconcile()
        this.emit({ type: 'state' })
        this.discoverTerminals(active)
        this.heartbeat = setInterval(() => { void client.ping().catch(() => this.offline(active!)) }, 15000)
        this.heartbeat.unref()
        void (async () => { for await (const state of client.stateChanges()) if (state.status === 'closed') this.offline(active!) })()
      } catch (error) {
        if (active) { this.offline(active); await active.client.shutdown() }
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
    if (!this.allowedChannel(resource)) throw new Error('This channel does not belong to the linked chat.')
    this.subscribing.add(resource)
    try {
      const { result, subscription } = await active.client.subscribe(resource, { delivery: { maxLatencyMs: 25 } })
      if (this.current !== active) { await subscription.close(); return }
      if (!result.snapshot || result.snapshot.resource !== resource) throw new Error('Agent Host did not return the requested snapshot.')
      this.acceptSnapshot(result.snapshot)
      void this.pump(subscription, active)
    } catch (error) { this.subscribing.delete(resource); throw error }
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
    this.emit({ type: 'snapshot', snapshot })
  }

  private async pump(subscription: Subscription, active: NonNullable<typeof this.current>): Promise<void> {
    try {
      for await (const event of subscription) {
        if (this.current !== active) return
        if (event.type === 'authRequired') { this.error = 'Authentication is required in the owner Agent Host.'; this.emit({ type: 'state' }); continue }
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
        this.emit({ type: 'action', envelope })
        void this.reconcile().catch(() => { this.error = 'Delivery confirmation could not be saved. Inspect the owner before retrying.'; this.emit({ type: 'state' }) })
        this.discoverTerminals(active)
      }
      this.offline(active)
    } catch { this.offline(active) }
  }

  private terminalResources(): string[] {
    const chat = this.chat.value
    return [...new Set([...chat?.turns ?? [], ...chat?.activeTurn ? [chat.activeTurn] : []].flatMap((turn) => turn.responseParts.flatMap((part) => part.kind === 'toolCall' && 'content' in part.toolCall ? (part.toolCall.content ?? []).flatMap((content) => content.type === 'terminal' && agentHostTerminalIdSchema.safeParse(content.resource).success ? [content.resource] : []) : [])))].slice(-16)
  }

  private discoverTerminals(active: NonNullable<typeof this.current>): void {
    for (const resource of this.terminalResources()) if (!this.subscribing.has(resource)) void this.subscribe(resource, active).catch(() => { if (this.current === active) { this.error = 'Some terminal output is unavailable.'; this.emit({ type: 'state' }) } })
  }

  private async reconcile(): Promise<void> {
    const chat = this.chat.value
    let changed = false
    for (const command of this.commands) if ((command.state === 'pending' || command.state === 'uncertain') && (chat?.activeTurn?.id === command.id || chat?.turns.some((turn) => turn.id === command.id))) { command.state = 'confirmed'; changed = true }
    if (changed) { await this.save(); this.emit({ type: 'state' }) }
  }

  async models() {
    await this.open()
    const active = this.current!
    if (this.initialized?._meta?.taskcontinuumCanSend !== undefined && this.initialized._meta.taskcontinuumModelSelection !== true) throw new Error('Update Task Continuum on the owner device to select remote models.')
    const { result, subscription } = await active.client.subscribe('ahp-root://')
    try {
      if (this.current !== active || result.snapshot?.resource !== 'ahp-root://') throw new Error('The model catalog is unavailable.')
      const root = z.object({ agents: z.array(z.object({ provider: z.string(), models: z.array(agentHostModelInfoSchema).max(1000) })).max(100) }).parse(result.snapshot.state)
      const provider = (this.snapshots.get(this.target.sessionId)?.state as SessionState | undefined)?.provider
      const agent = root.agents.find((item) => item.provider === provider)
      if (!agent) throw new Error('The original session provider has no model catalog.')
      return agent.models.filter((model) => model.provider === provider && model.policyState !== 'disabled').map(({ id, name, provider }) => ({ id, name, provider }))
    } finally { await subscription.close() }
  }

  async send(id: string, text: string, images: ChatImageAttachment[] | undefined, authorize: () => Promise<void>, actor?: { clientId: string; machineName: string; username?: string }, model?: ModelSelection): Promise<void> {
    const command = { ...chatSubmissionSchema.parse({ id, text, ...(images?.length ? { images } : {}) }), ...(model === undefined ? {} : { model: agentHostModelSelectionSchema.parse(model) }) }
    if (this.sending) throw new Error('Another message is being submitted to this chat.')
    this.sending = true
    let record: Command | undefined
    let dispatched = false
    try {
      await this.open()
      await authorize()
      const modelId = command.model?.id
      if (modelId && !(await this.models()).some((item) => item.id === modelId)) throw new Error('The selected model is no longer available. Refresh the model list and choose another model.')
      const active = this.current!
      const fresh = await active.client.request('subscribe', { channel: this.target.chatId })
      if (this.current !== active || !fresh.snapshot) throw new Error('The connection changed before sending. Nothing was sent.')
      this.acceptSnapshot(fresh.snapshot)
      await this.reconcile()
      const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex')
      const prior = this.commands.find((item) => item.id === id)
      if (prior) { if (prior.hash !== hash) throw new Error('This message ID belongs to different content.'); if (prior.state === 'confirmed') return; throw new Error('This message was already attempted. Inspect the original; it was not replayed.') }
      const chat = this.chat.value!
      if (this.initialized?._meta?.taskcontinuumCanSend === false || this.commands.some((item) => item.state === 'pending' || item.state === 'uncertain') || chat.activeTurn || chat.draft?.text || chat.draft?.attachments?.length || chat.queuedMessages?.length || chat.interactivity === 'read-only' || chat.interactivity === 'hidden') throw new Error('The original chat is busy, has a draft, is read-only, or has an uncertain delivery.')
      if (this.commands.length >= 1000) throw new Error('Delivery record limit reached. No message was sent.')
      record = { id, hash, state: 'pending' }
      this.commands.push(record)
      await this.save()
      await authorize()
      if (this.current !== active || !this.connected) throw new Error('The connection changed before sending. Nothing was sent.')
      const latest = this.chat.value!
      if (latest.activeTurn || latest.draft?.text || latest.draft?.attachments?.length || latest.queuedMessages?.length || latest.interactivity === 'read-only' || latest.interactivity === 'hidden') throw new Error('The original chat became busy or has a new draft. Nothing was sent.')
      const selection = latest.draft ?? latest.turns.at(-1)?.message
      const selectedModel = command.model ?? selection?.model
      const attachments: MessageEmbeddedResourceAttachment[] | undefined = command.images?.map((image) => ({ type: 'embeddedResource' as MessageEmbeddedResourceAttachment['type'], label: image.name, displayKind: 'image', contentType: image.mimeType, data: image.data, _meta: { taskcontinuumImageId: image.id } }))
      const action: ChatTurnStartedAction = { type: 'chat/turnStarted' as ChatTurnStartedAction['type'], turnId: id, startedAt: new Date().toISOString(), message: { text: command.text, origin: { kind: MessageKind.User }, ...(attachments?.length ? { attachments } : {}), ...(selection?.agent ? { agent: selection.agent } : {}), ...(selectedModel ? { model: selectedModel } : {}), ...(actor ? { _meta: { taskcontinuumActor: actor } } : {}) } }
      dispatched = true
      active.client.dispatch(this.target.chatId, action)
      this.emit({ type: 'state' })
      await this.waitForTurn(id, active)
    } catch (error) {
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

  private offline(active: NonNullable<typeof this.current>): void {
    if (this.current !== active) return
    this.current = undefined
    this.connected = false
    clearInterval(this.heartbeat)
    active.abort.abort()
    void active.client.shutdown()
    for (const command of this.commands) if (command.state === 'pending') command.state = 'uncertain'
    void this.save().catch(() => undefined)
    this.error = 'Agent Host disconnected. Restoring state only; messages are never replayed.'
    this.emit({ type: 'state' })
    this.scheduleRecovery()
  }

  private scheduleRecovery(): void {
    if (this.closed || this.retry || !this.listeners.size) return
    this.retry = setTimeout(() => { this.retry = undefined; void this.open().catch(() => undefined) }, Math.min(30000, 1000 * 2 ** Math.min(this.failures++, 5)))
    this.retry.unref()
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.retry)
    clearInterval(this.heartbeat)
    if (this.current) this.offline(this.current)
    await this.opening?.catch(() => undefined)
    await this.writing
    const chat = this.snapshots.get(this.target.chatId)
    if (chat && Buffer.byteLength(JSON.stringify(chat)) < 15 * 1024 * 1024) await writeJsonAtomic(`${this.file}.cache.json`, { target: this.target, chat })
    this.listeners.clear()
  }
}