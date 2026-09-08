import { join } from 'node:path'
import { z } from 'zod'
import type { VSCodeChatDelivery, VSCodeChatIdentity, VSCodeChatParticipant, VSCodeExecutionIdentity } from '../shared/vscodeChat'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import type { VSCodeSessionStore } from './vscodeSessions'

export const participantSchema = z.object({ clientId: z.uuid().optional(), username: z.string().trim().min(1).max(300), machineName: z.string().trim().min(1).max(300) }).strict()
export const executionIdentitySchema = z.object({ agentName: z.string().trim().min(1).max(300), machineName: z.string().trim().min(1).max(300) }).strict()
export const deliverySchema = z.object({
  id: z.uuid(), nativeSessionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/), text: z.string().trim().min(1).max(4000),
  participant: participantSchema, execution: executionIdentitySchema, createdAt: z.iso.datetime(),
  state: z.enum(['pending', 'submitted', 'failed', 'uncertain']), nativeRequestId: z.string().min(1).max(240).optional(), error: z.string().max(1500).optional(),
}).strict()
export type VSCodeDispatchResult = Pick<VSCodeChatDelivery, 'state' | 'nativeRequestId' | 'error'>
export type VSCodeDispatch = (identity: VSCodeChatIdentity, delivery: VSCodeChatDelivery, signal: AbortSignal) => Promise<VSCodeDispatchResult>

export function deliveryPrompt(delivery: VSCodeChatDelivery): string {
  return `${delivery.text}\n\nMessage from ${JSON.stringify(delivery.participant.username)} on ${JSON.stringify(delivery.participant.machineName)}.\nTask Continuum message ID: ${delivery.id}`
}

export class VSCodeChatDeliveryService {
  private readonly file: string
  private readonly records = new Map<string, VSCodeChatDelivery>()
  private loading?: Promise<void>
  private writing: Promise<unknown> = Promise.resolve()
  private readonly running = new Map<string, AbortController>()
  private readonly operations = new Map<string, Promise<void>>()
  private closed = false

  constructor(directory: string, private readonly store: VSCodeSessionStore, private readonly participant: VSCodeChatParticipant, private readonly execution: VSCodeExecutionIdentity, private readonly dispatch: VSCodeDispatch) {
    this.file = join(directory, 'deliveries.json')
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const entries = z.array(deliverySchema).max(500).parse(await readJsonBounded(this.file, 4 * 1024 * 1024))
        for (const entry of entries) {
          if (this.records.has(entry.id)) throw new Error('The VS Code delivery journal contains duplicate message IDs.')
          if (entry.state === 'pending') { entry.state = 'uncertain'; entry.error = 'The bridge restarted before delivery was confirmed. No message was replayed.' }
          this.records.set(entry.id, entry)
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    })()
    return this.loading
  }

  private update<Result>(action: () => Promise<Result>): Promise<Result> {
    const operation = this.writing.then(async () => { await this.load(); return action() })
    this.writing = operation.catch(() => undefined)
    return operation
  }

  private async save(record: VSCodeChatDelivery): Promise<void> {
    const next = new Map(this.records)
    next.set(record.id, deliverySchema.parse(record))
    if (Buffer.byteLength(JSON.stringify([...next.values()], null, 2) + '\n') > 4 * 1024 * 1024) throw new Error('The local delivery journal exceeds its 4 MB limit.')
    await writeJsonAtomic(this.file, [...next.values()])
    this.records.set(record.id, record)
  }

  async list(identity: VSCodeChatIdentity): Promise<VSCodeChatDelivery[]> {
    return this.update(async () => {
      const original = await this.store.locateOriginal(identity)
      for (const record of this.records.values()) {
        if (record.nativeSessionId !== identity.nativeSessionId || record.state !== 'uncertain') continue
        const found = original.state.turns.find((turn) => turn.prompt === deliveryPrompt(record) && turn.id)
        if (found) await this.save({ ...record, state: 'submitted', nativeRequestId: found.id, error: undefined })
      }
      return structuredClone([...this.records.values()].filter((record) => record.nativeSessionId === identity.nativeSessionId))
    })
  }

  submit(identity: VSCodeChatIdentity, value: unknown, authorizedParticipant: VSCodeChatParticipant = this.participant, assertAuthorized: () => void = () => {}): Promise<VSCodeChatDelivery> {
    const request = z.object({ id: z.uuid(), text: z.string().trim().min(1).max(4000) }).strict().parse(value)
    const participant = participantSchema.parse(authorizedParticipant)
    return this.update(async () => {
      assertAuthorized()
      if (this.closed) throw new Error('The VS Code bridge is stopping.')
      const prior = this.records.get(request.id)
      if (prior) {
        if (prior.nativeSessionId !== identity.nativeSessionId || prior.text !== request.text || prior.participant.clientId !== participant.clientId || prior.participant.username !== participant.username || prior.participant.machineName !== participant.machineName) throw new Error('This message ID belongs to a different submission.')
        return structuredClone(prior)
      }
      if (this.running.size) throw new Error('Another message is being delivered. Wait for its confirmation before sending again.')
      if (this.records.size >= 500) throw new Error('The local delivery journal has reached its 500-message limit.')
      const original = await this.store.locateOriginal(identity)
      assertAuthorized()
      if (original.state.turns.at(-1)?.complete === false) throw new Error('The original VS Code conversation is still responding. Wait or stop it in VS Code first.')
      if (original.state.hasDraft) throw new Error('The original VS Code conversation has an unsent draft. Send or clear it in VS Code first.')
      if ([...this.records.values()].some((record) => record.nativeSessionId === identity.nativeSessionId && (record.state === 'pending' || record.state === 'uncertain'))) throw new Error('An earlier delivery is unconfirmed. Inspect the original conversation before sending another message.')
      const delivery: VSCodeChatDelivery = { ...request, nativeSessionId: identity.nativeSessionId, participant, execution: this.execution, createdAt: new Date().toISOString(), state: 'pending' }
      await this.save(delivery)
      try { assertAuthorized() } catch {
        const rejected: VSCodeChatDelivery = { ...delivery, state: 'failed', error: 'Remote access ended before dispatch. The message was not sent.' }
        await this.save(rejected)
        return structuredClone(rejected)
      }
      const controller = new AbortController()
      this.running.set(request.id, controller)
      const operation = this.dispatch(identity, structuredClone(delivery), controller.signal).then(async (result) => {
        await this.update(() => this.save({ ...delivery, ...result }))
      }).catch(async (error: unknown) => {
        await this.update(() => this.save({ ...delivery, state: 'uncertain', error: error instanceof Error ? error.message.slice(0, 1500) : 'Delivery could not be confirmed. Inspect the original conversation.' })).catch(() => undefined)
      }).finally(() => { this.running.delete(request.id); this.operations.delete(request.id) })
      this.operations.set(request.id, operation)
      return structuredClone(delivery)
    })
  }

  async close(): Promise<void> {
    this.closed = true
    await this.writing
    for (const controller of this.running.values()) controller.abort()
    await Promise.all(this.operations.values())
    await this.writing
  }

  revokeParticipant(clientId: string, nativeSessionId: string): void {
    for (const [id, controller] of this.running) {
      const record = this.records.get(id)
      if (record?.participant.clientId === clientId && record.nativeSessionId === nativeSessionId) controller.abort(new Error('Remote access was revoked. Inspect the original conversation before retrying.'))
    }
  }
}