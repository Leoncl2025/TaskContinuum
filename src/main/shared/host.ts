import type { CopilotEvent, SendMessageRequest } from '../../shared/sessions'
import type { SharedActor, SharedEvent, SharedGrant, SharedPermission, SharedSessionDescriptor } from '../../shared/sharedSessions'
import { SharedJournal } from './journal'
import { commandSchema, responseSchema } from './schemas'
import type { ChatImageReference } from '../../shared/chatAttachments'
import { describeChatImages } from '../chatImageStore'

export interface SharedExecutor {
  send(request: SendMessageRequest, prompt?: string): Promise<void>
  abort(id: string): Promise<void>
  respond(id: string, response: boolean | string): void
  onEvent(listener: (event: CopilotEvent) => void): () => void
}

interface QueuedCommand { id: string; text: string; actor: SharedActor; images?: ChatImageReference[] }
interface PendingInteraction { commandId: string; type: 'permission' | 'question'; choices?: string[]; allowFreeform?: boolean }

export class SharedSessionHost {
  private readonly queue: QueuedCommand[] = []
  private readonly commands = new Map<string, QueuedCommand>()
  private readonly interactions = new Map<string, PendingInteraction>()
  private accepting = Promise.resolve()
  private events = Promise.resolve()
  private running?: Promise<void>
  private active?: QueuedCommand
  private interruptedBy?: SharedActor
  private closed = false
  private fault?: string
  private checkpointing = false
  private unsubscribe?: () => void

  constructor(readonly session: SharedSessionDescriptor, readonly journal: SharedJournal, private readonly executor: SharedExecutor, private readonly initialContext?: string) {}

  private get agent(): SharedActor {
    return { kind: 'agent', id: this.session.owner.agentId, name: 'GitHub Copilot', machineId: this.session.owner.machineId, machineName: this.session.owner.machineName }
  }

  async start(): Promise<void> {
    await this.journal.load()
    const unfinished = new Map<string, QueuedCommand>()
    const pending = new Map<string, string>()
    for (const event of this.journal.snapshot()) {
      if (event.type === 'message' && event.commandId) {
        const command = { id: event.commandId, text: event.text ?? '', actor: event.actor, ...(event.images?.length ? { images: event.images } : {}) }
        this.commands.set(command.id, command)
        unfinished.set(command.id, command)
      }
      if (event.commandId && ['completed', 'failed', 'interrupted'].includes(event.type)) unfinished.delete(event.commandId)
      if ((event.type === 'permission' || event.type === 'question') && event.interactionId && event.commandId) pending.set(event.interactionId, event.commandId)
      if (event.type === 'resolved' && event.interactionId) pending.delete(event.interactionId)
    }
    for (const [interactionId, commandId] of pending) await this.journal.append({ type: 'resolved', commandId, interactionId, actor: { ...this.agent, kind: 'host' }, text: 'Host restarted; the pending decision was not approved.' })
    for (const command of unfinished.values()) await this.journal.append({ type: 'interrupted', commandId: command.id, actor: { ...this.agent, kind: 'host' }, text: 'Host restarted. This command was interrupted and will not be replayed automatically.' })
    this.unsubscribe = this.executor.onEvent((event) => {
      if (!this.active) return
      const command = this.active
      const append = async () => {
        const data: Omit<SharedEvent, 'sessionId' | 'epoch' | 'seq' | 'at'> = { type: 'activity', commandId: command.id, actor: this.agent }
        if ('sessionId' in event && event.sessionId !== this.session.owner.nativeSessionId) return
        if ('requestId' in event && event.requestId !== command.id) return
        if (event.type === 'delta' || event.type === 'activity') await this.journal.append({ ...data, type: event.type, text: event.text })
        else if (event.type === 'permission') {
          this.interactions.set(event.id, { commandId: command.id, type: 'permission' })
          await this.journal.append({ ...data, type: 'permission', interactionId: event.id, permissionKind: event.kind, text: event.details })
        } else if (event.type === 'user-input') {
          this.interactions.set(event.id, { commandId: command.id, type: 'question', choices: event.choices, allowFreeform: event.allowFreeform })
          await this.journal.append({ ...data, type: 'question', interactionId: event.id, text: event.question, choices: event.choices, allowFreeform: event.allowFreeform })
        } else if (event.type === 'interaction-resolved' && this.interactions.has(event.id)) {
          this.interactions.delete(event.id)
          await this.journal.append({ ...data, type: 'resolved', interactionId: event.id })
        }
      }
      this.events = this.events.then(append).catch((error: unknown) => { this.fail(error); void this.executor.abort(command.id).catch(() => undefined) })
    })
  }

  private fail(error: unknown): void { this.fault = error instanceof Error ? error.message : 'The Host could not persist session state.' }
  require(grant: SharedGrant, permission: SharedPermission): void {
    if (!grant.permissions.includes(permission)) throw new Error(`Permission denied: ${permission}.`)
  }
  get status(): { active?: string; queued: number; error?: string } { return { active: this.active?.id, queued: this.queue.length, error: this.fault } }

  submit(grant: SharedGrant, input: unknown): Promise<string> {
    this.require(grant, 'send')
    const request = commandSchema.parse(input)
    const images = describeChatImages(request.images ?? [])
    const submit = async () => {
      if (this.closed || this.fault) throw new Error(this.fault ?? 'Session Host is closed.')
      if (this.checkpointing) throw new Error('A checkpoint is being frozen. Retry after export completes.')
      const prior = this.commands.get(request.id)
      if (prior) {
        if (prior.text !== request.text || JSON.stringify(prior.images ?? []) !== JSON.stringify(images) || prior.actor.id !== grant.actor.id || prior.actor.machineId !== grant.actor.machineId) throw new Error('Command ID is already used by a different message or participant.')
        return prior.id
      }
      if (this.queue.length >= 32) throw new Error('The session queue is full.')
      if (images.length) await this.journal.images.store(request.images!)
      const command: QueuedCommand = { id: request.id, text: request.text, actor: grant.actor, ...(images.length ? { images } : {}) }
      await this.journal.append({ type: 'message', commandId: command.id, actor: command.actor, text: command.text, ...(images.length ? { images } : {}) })
      this.commands.set(command.id, command)
      this.queue.push(command)
      this.schedule()
      return command.id
    }
    const operation = this.accepting.then(submit)
    this.accepting = operation.then(() => undefined, () => undefined)
    return operation
  }

  private schedule(): void {
    if (this.running || this.closed || this.fault || !this.queue.length) return
    this.running = this.drain().catch((error: unknown) => this.fail(error)).finally(() => { this.running = undefined; this.schedule() })
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.closed && !this.fault) {
      const command = this.queue.shift()!
      this.active = command
      this.interruptedBy = undefined
      await this.journal.append({ type: 'started', actor: this.agent, commandId: command.id })
      try {
        const priorTurns = this.journal.snapshot().filter((event) => event.type === 'started').length
        const prompt = `${this.initialContext && priorTurns === 1 ? this.initialContext + '\n\n' : ''}Message from authenticated participant ${JSON.stringify({ user: command.actor.name, machine: command.actor.machineName })}:\n${command.text}`
        const images = command.images?.length ? await this.journal.images.read(command.images) : undefined
        await this.executor.send({ sessionId: this.session.owner.nativeSessionId, requestId: command.id, message: command.text, ...(images ? { images } : {}) }, prompt)
        await this.events
        if (this.fault) throw new Error(this.fault)
        await this.journal.append(this.interruptedBy ? { type: 'interrupted', actor: this.interruptedBy, commandId: command.id, text: 'The response was stopped.' } : { type: 'completed', actor: this.agent, commandId: command.id })
      } catch (error) {
        await this.events
        await this.journal.append(this.interruptedBy ? { type: 'interrupted', actor: this.interruptedBy, commandId: command.id, text: 'The response was stopped.' } : { type: 'failed', actor: this.agent, commandId: command.id, text: error instanceof Error ? error.message.slice(0, 2000) : 'Agent request failed.' })
      } finally { this.active = undefined; this.interruptedBy = undefined }
    }
  }

  async respond(grant: SharedGrant, input: unknown): Promise<void> {
    this.require(grant, 'approve')
    const request = responseSchema.parse(input)
    await this.events
    const interaction = this.interactions.get(request.id)
    if (!interaction) throw new Error('This interaction is no longer pending.')
    if (interaction.type === 'permission' && typeof request.answer !== 'boolean') throw new Error('A permission decision must be allow or deny.')
    if (interaction.type === 'question' && request.answer !== false) {
      if (typeof request.answer !== 'string' || !request.answer.trim()) throw new Error('A question requires an answer.')
      if (interaction.allowFreeform === false && !interaction.choices?.includes(request.answer)) throw new Error('Choose one of the offered answers.')
    }
    this.interactions.delete(request.id)
    await this.journal.append({ type: 'resolved', commandId: interaction.commandId, interactionId: request.id, actor: grant.actor, text: typeof request.answer === 'boolean' ? request.answer ? 'Allowed once' : 'Denied' : 'Answer provided' })
    this.executor.respond(request.id, request.answer)
  }

  async stop(grant: SharedGrant, id: string): Promise<void> {
    this.require(grant, 'stop')
    if (this.active?.id === id) {
      if (this.interruptedBy) throw new Error('This response is already stopping.')
      this.interruptedBy = grant.actor
      try { await this.executor.abort(id) } catch (error) { this.interruptedBy = undefined; throw error }
      return
    }
    const index = this.queue.findIndex((command) => command.id === id)
    if (index < 0) throw new Error('This command is not active or queued.')
    this.queue.splice(index, 1)
    await this.journal.append({ type: 'interrupted', actor: grant.actor, commandId: id, text: 'Queued command cancelled.' })
  }

  async idle(): Promise<void> { await this.accepting; while (this.running) await this.running; await this.events }
  async freeze<Result>(create: (events: SharedEvent[]) => Promise<Result>): Promise<Result> {
    if (this.checkpointing || this.closed || this.fault) throw new Error('The Host is not available for a checkpoint.')
    this.checkpointing = true
    try {
      await this.accepting
      await this.events
      if (this.active || this.queue.length || this.interactions.size) throw new Error('Wait for all turns and decisions to complete before checkpointing.')
      return await create(this.journal.snapshot())
    } finally { this.checkpointing = false }
  }
  async close(): Promise<void> {
    this.closed = true
    await this.accepting
    if (this.active) { this.interruptedBy = { ...this.agent, kind: 'host' }; await this.executor.abort(this.active.id) }
    await this.running
    await this.events
    for (const command of this.queue.splice(0)) await this.journal.append({ type: 'interrupted', actor: { ...this.agent, kind: 'host' }, commandId: command.id, text: 'Host stopped before this queued command started.' })
    this.unsubscribe?.()
  }
}