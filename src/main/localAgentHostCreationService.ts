import { randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentHostTarget } from '../shared/agentHost'
import type { LocalAgentHostCreateRequest, LocalAgentHostCreation } from '../shared/localAgentHostCreation'
import { agentHostIdSchema, agentHostKey, agentHostSessionSchema, agentHostTargetSchema } from './agentHostProtocol'
import { AgentHostCreationError, isExplicitlyDeletedAgentHostSession } from './agentHostRegistry'
import type { AgentHostCreationInspection, AgentHostRegistry, PreparedAgentHostCreation } from './agentHostRegistry'
import { canonicalPolicyRoot } from './linkedSessionPolicy'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'

export const localAgentHostCreateRequestSchema = z.object({ operationId: z.uuid(), hostId: agentHostIdSchema }).strict()
const resultSchema = localAgentHostCreateRequestSchema.extend({
  state: z.enum(['creating', 'uncertain', 'failed', 'ready']),
  nativeLifecycle: z.enum(['creating', 'ready', 'failed']).optional(),
  session: agentHostSessionSchema.extend({ provider: z.literal('copilotcli'), canSend: z.literal(true) }).optional(),
  error: z.string().min(1).max(2000).optional(),
}).strict()
const recordSchema = z.object({
  schemaVersion: z.literal(2),
  root: z.string().min(1).max(32768), createdAt: z.iso.datetime(),
  request: localAgentHostCreateRequestSchema, owner: agentHostTargetSchema.shape.owner,
  nativeSessionId: z.string().regex(/^copilotcli:\/[0-9a-f-]{36}$/),
  phase: z.enum(['reserved', 'dispatched']), nativeAcknowledged: z.boolean(),
  version: z.number().int().nonnegative(), result: resultSchema,
}).strict().superRefine((record, context) => {
  const { request, result } = record
  if (request.operationId !== result.operationId || request.hostId !== result.hostId
    || result.session && (result.session.sessionId !== record.nativeSessionId
      || JSON.stringify(result.session.owner) !== JSON.stringify(record.owner))) {
    context.addIssue({ code: 'custom', message: 'Local creation identity changed.' })
  }
  if ((record.nativeAcknowledged || result.session) && record.phase !== 'dispatched'
    || result.state === 'ready' && (!result.session || !['creating', 'ready'].includes(result.nativeLifecycle ?? '')
      || result.nativeLifecycle === 'creating' && !record.nativeAcknowledged)) {
    context.addIssue({ code: 'custom', message: 'Local creation lacks its durable native verification.' })
  }
})
const recordsSchema = z.array(recordSchema).max(1000).superRefine((records, context) => {
  if (new Set(records.map((record) => record.request.operationId)).size !== records.length
    || new Set(records.map((record) => record.nativeSessionId)).size !== records.length
    || new Set(records.filter((record) => record.result.state !== 'failed').map((record) => record.root)).size !== records.filter((record) => record.result.state !== 'failed').length) {
    context.addIssue({ code: 'custom', message: 'Duplicate local creation reservation.' })
  }
})
type CreationRecord = z.infer<typeof recordSchema>
type Guard = () => Promise<void>
class ChangedRecordError extends Error {}

export class LocalAgentHostCreationService {
  private readonly abort = new AbortController()
  private readonly running = new Map<string, Promise<void>>()
  private writing: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(private readonly directory: string, private readonly registry: AgentHostRegistry) {}

  private async current(authorize: Guard): Promise<void> {
    if (this.closed) throw new Error('The local creation service is closed.')
    await authorize()
    if (this.closed) throw new Error('The local creation service is closed.')
  }

  private transaction<T>(action: (records: CreationRecord[]) => Promise<{ value: T; changed?: boolean }> | { value: T; changed?: boolean }): Promise<T> {
    const work = this.writing.then(async () => {
      const directory = join(this.directory, 'local-agent-host-creations')
      await mkdir(directory, { recursive: true })
      const lockFile = join(directory, 'operations.lock')
      const lock = await open(lockFile, 'wx', 0o600).catch(() => {
        throw new Error('Local creation records are locked or unavailable. No creation was replayed. Remove a stale lock only after all app instances have stopped.')
      })
      try {
        const file = join(directory, 'operations.json')
        let records: CreationRecord[]
        try { records = recordsSchema.parse(await readJsonBounded(file, 8 * 1024 * 1024)) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Private local creation records are unreadable. They were not replaced and no creation was replayed.')
          records = []
        }
        const { value, changed } = await action(records)
        if (changed) {
          const checked = recordsSchema.parse(records)
          if (Buffer.byteLength(JSON.stringify(checked, null, 2)) >= 8 * 1024 * 1024) throw new Error('The local creation history size limit was reached. Existing records were not discarded.')
          await writeJsonAtomic(file, checked)
        }
        return structuredClone(value)
      } finally { await lock.close(); await rm(lockFile, { force: true }) }
    })
    this.writing = work.catch(() => undefined)
    return work
  }

  private async verifyOwner(record: CreationRecord): Promise<void> {
    if (JSON.stringify(record.owner) !== JSON.stringify(await this.registry.creationOwner())) throw new Error('The original local execution owner is unavailable.')
  }

  private visible(record: CreationRecord): LocalAgentHostCreation {
    if (record.result.state === 'creating' && !this.running.has(record.request.operationId)) {
      return { ...record.result, state: 'uncertain', error: 'Creation was interrupted. Check this operation to inspect its original native session; creation will not be replayed.' }
    }
    return record.result
  }

  async hosts(root: string, authorize: Guard): Promise<import('../shared/agentHostCreation').AgentHostCreationHost[]> {
    await this.current(authorize)
    await canonicalPolicyRoot(root)
    const hosts = await this.registry.creationHosts(this.abort.signal)
    await this.current(authorize)
    return hosts
  }

  async list(root: string, authorize: Guard): Promise<LocalAgentHostCreation[]> {
    await this.current(authorize)
    const canonical = await canonicalPolicyRoot(root)
    const records = await this.transaction((records) => ({ value: records.filter((record) => record.root === canonical) }))
    for (const record of records) await this.verifyOwner(record)
    await this.current(authorize)
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((record) => this.visible(record))
  }

  async create(root: string, value: LocalAgentHostCreateRequest, authorize: Guard): Promise<LocalAgentHostCreation> {
    const request = localAgentHostCreateRequestSchema.parse(value)
    await this.current(authorize)
    const canonical = await canonicalPolicyRoot(root)
    const owner = await this.registry.creationOwner()
    const reservation = await this.transaction(async (records) => {
      await this.current(authorize)
      const previous = records.find((record) => record.request.operationId === request.operationId)
      if (previous) {
        if (previous.root !== canonical || JSON.stringify(previous.request) !== JSON.stringify(request)) throw new Error('The operation ID already belongs to a different workspace or creation request.')
        await this.verifyOwner(previous)
        return { value: { record: previous, fresh: false } }
      }
      if (records.length >= 1000) throw new Error('The local creation history limit was reached. Existing records were not discarded.')
      if (this.running.size >= 16) throw new Error('Too many local creation operations are active.')
      if (records.some((record) => record.root === canonical && record.result.state !== 'failed')) throw new Error('This workspace already has a local creation operation. Resume that operation instead of creating another session.')
      const record: CreationRecord = { schemaVersion: 2, root: canonical, createdAt: new Date().toISOString(), request, owner, nativeSessionId: `copilotcli:/${randomUUID()}`,
        phase: 'reserved', nativeAcknowledged: false, version: 0, result: { ...request, state: 'creating' } }
      await this.verifyOwner(record)
      await this.current(authorize)
      records.push(record)
      return { value: { record, fresh: true }, changed: true }
    })
    if (reservation.fresh) {
      const work = this.execute(reservation.record, authorize)
      this.running.set(request.operationId, work)
      void work.finally(() => { this.running.delete(request.operationId) }).catch(() => undefined)
    }
    await this.current(authorize)
    return this.visible(reservation.record)
  }

  private async replace(record: CreationRecord, patch: Partial<CreationRecord>): Promise<CreationRecord> {
    return this.transaction((records) => {
      const index = records.findIndex((item) => item.request.operationId === record.request.operationId)
      if (index < 0 || records[index].version !== record.version) throw new ChangedRecordError('This local operation changed. Inspect its latest state; no native creation was replayed.')
      const next = recordSchema.parse({ ...record, ...patch, version: record.version + 1 })
      records[index] = next
      return { value: next, changed: true }
    })
  }

  private async execute(initial: CreationRecord, authorize: Guard): Promise<void> {
    let record = initial
    let prepared: PreparedAgentHostCreation | undefined
    try {
      await this.current(authorize)
      await this.verifyOwner(record)
      prepared = await this.registry.prepareCreation(record.request.hostId, record.nativeSessionId, record.root, this.abort.signal)
      await this.current(authorize)
      await this.verifyOwner(record)
      record = await this.replace(record, { phase: 'dispatched' })
      await prepared.create(async () => { await this.verifyOwner(record); await this.current(authorize) })
      // Persist the ACK before accepting Copilot's lazy, lifecycle=creating default chat.
      record = await this.replace(record, { nativeAcknowledged: true })
      await this.current(authorize)
      const inspected = await prepared.inspect(undefined, record.nativeAcknowledged)
      await this.verifyOwner(record)
      await this.current(authorize)
      await this.accept(record, inspected)
    } catch (error) {
      if (error instanceof ChangedRecordError) return
      await this.replace(record, { result: { ...record.result, state: prepared?.dispatched ? 'uncertain' : 'failed',
        error: error instanceof AgentHostCreationError ? error.message : prepared?.dispatched
          ? 'The native acknowledgement or exact session could not be confirmed. Inspect this same operation; creation will not be replayed.'
          : 'The local Host could not prepare creation or the workspace changed. No native create request was dispatched.' } })
    } finally { await prepared?.close() }
  }

  private async lookup(root: string, id: string, authorize: Guard): Promise<CreationRecord> {
    z.uuid().parse(id)
    await this.current(authorize)
    const canonical = await canonicalPolicyRoot(root)
    const record = await this.transaction((records) => {
      const record = records.find((item) => item.request.operationId === id && item.root === canonical)
      if (!record) throw new Error('This local creation operation does not belong to the selected workspace.')
      return { value: record }
    })
    await this.verifyOwner(record)
    await this.current(authorize)
    return record
  }

  async status(root: string, id: string, authorize: Guard): Promise<LocalAgentHostCreation> {
    let record = await this.lookup(root, id, authorize)
    if (!this.running.has(id) && record.result.state !== 'failed') {
      try {
        const inspected = await this.registry.inspectCreation(record.request.hostId, record.nativeSessionId, record.root, this.abort.signal, record.result.session?.chatId, record.nativeAcknowledged)
        await this.verifyOwner(record)
        await this.current(authorize)
        record = await this.accept(record, inspected)
      } catch (error) {
        if (error instanceof ChangedRecordError) record = await this.lookup(root, id, authorize)
        else {
          const deleted = isExplicitlyDeletedAgentHostSession(error, record.nativeSessionId)
          if (deleted) { await this.verifyOwner(record); await this.current(authorize) }
          record = await this.replace(record, { result: { ...record.result, state: deleted ? 'failed' : 'uncertain',
            error: deleted ? 'The original local session was explicitly deleted. Create a new local agent session to continue.'
              : error instanceof AgentHostCreationError ? error.message : 'The original local session is not currently verifiable. A missing session is not permission to replay creation.' } })
        }
      }
    }
    await this.current(authorize)
    return this.visible(record)
  }

  private async accept(record: CreationRecord, inspected: AgentHostCreationInspection): Promise<CreationRecord> {
    if (inspected.state !== 'ready') return this.replace(record, { result: { ...record.result, state: inspected.state === 'failed' ? 'failed' : 'uncertain', nativeLifecycle: inspected.state, error: inspected.error } })
    if (inspected.session.sessionId !== record.nativeSessionId
      || JSON.stringify(inspected.session.owner) !== JSON.stringify(record.owner)
      || record.result.session && agentHostKey(record.result.session) !== agentHostKey(inspected.session)) throw new AgentHostCreationError('The exact local session identity changed. No replacement session or chat was selected.')
    return this.replace(record, { result: resultSchema.parse({ ...record.request, state: 'ready', session: inspected.session, nativeLifecycle: inspected.nativeLifecycle }) })
  }

  async authorizes(root: string, value: AgentHostTarget): Promise<boolean> {
    if (this.closed) throw new Error('The local creation service is closed.')
    const target = agentHostTargetSchema.parse(value)
    const owner = await this.registry.creationOwner()
    if (JSON.stringify(target.owner) !== JSON.stringify(owner)) return false
    const canonical = await canonicalPolicyRoot(root)
    const allowed = await this.transaction((records) => ({ value: records.some((record) => record.root === canonical && record.result.state === 'ready'
      && JSON.stringify(record.owner) === JSON.stringify(owner) && record.result.session && agentHostKey(record.result.session) === agentHostKey(target)) }))
    if (this.closed) throw new Error('The local creation service is closed.')
    return allowed
  }

  async close(): Promise<void> {
    this.closed = true
    this.abort.abort()
    await Promise.allSettled([...this.running.values()])
    await this.writing
  }
}
