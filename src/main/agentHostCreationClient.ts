import { createHash } from 'node:crypto'
import { mkdir, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentHostCreateRequest, AgentHostCreation, AgentHostWorker } from '../shared/agentHostCreation'
import { agentHostCreateRequestSchema, agentHostCreationSchema, creationRevisionSchema, creationTaskIdSchema } from './agentHostCreationProtocol'
import { agentHostKey, agentHostTargetSchema } from './agentHostProtocol'
import { canonicalPolicyRoot } from './linkedSessionPolicy'
import { bindRepositoryAgentHostCreation, readRepositorySessionLinks } from './repositorySessionLinks'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import type { VSCodeDeviceClient } from './vscodeDeviceClient'
import { readTaskWorkspace } from './workspaceReader'

const recordSchema = z.object({
  schemaVersion: z.literal(2), root: z.string().min(1).max(4096), createdAt: z.iso.datetime(),
  request: agentHostCreateRequestSchema, owner: agentHostTargetSchema.shape.owner,
  expectedRevision: creationRevisionSchema, result: agentHostCreationSchema,
  localBound: z.boolean(), bindingBlocked: z.boolean(),
}).strict().superRefine((record, context) => {
  for (const key of ['operationId', 'taskId', 'workerId', 'workspaceId', 'hostId'] as const) {
    if (record.request[key] !== record.result[key]) context.addIssue({ code: 'custom', message: 'Creation record identity changed.' })
  }
  if (record.result.session && record.result.session.owner.clientId !== record.owner.clientId) context.addIssue({ code: 'custom', message: 'Creation record owner changed.' })
})
type CreationRecord = z.infer<typeof recordSchema>
type Devices = Pick<VSCodeDeviceClient, 'agentHostWorkers' | 'agentHostWorker' | 'agentHostCreate' | 'agentHostCreationStatus' | 'agentHostBindCreation'>

function failureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : 'The creation operation could not be confirmed.').slice(0, 2000)
}

export class AgentHostCreationClient {
  private readonly pending = new Map<string, Promise<AgentHostCreation>>()
  private closed = false

  constructor(private readonly directory: string, private readonly devices: Devices) {}

  private async scope(root: string) {
    const canonical = await canonicalPolicyRoot(root)
    return { root: canonical, directory: join(this.directory, 'agent-host-creations', 'client', createHash('sha256').update(canonical).digest('hex')) }
  }

  private file(directory: string, id: string): string { return join(directory, `${z.uuid().parse(id)}.json`) }

  private async records(root: string): Promise<CreationRecord[]> {
    const scope = await this.scope(root)
    let entries
    try { entries = await readdir(scope.directory, { withFileTypes: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const files = entries.filter((entry) => entry.name.endsWith('.json'))
    if (files.length > 1000) throw new Error('The remote creation history limit was reached. Records were not discarded.')
    const records: CreationRecord[] = []
    for (const file of files) {
      if (!file.isFile() || !z.uuid().safeParse(file.name.slice(0, -5)).success) throw new Error('Remote creation records are invalid. No operation was replayed.')
      const record = recordSchema.parse(await readJsonBounded(join(scope.directory, file.name), 32768))
      if (record.root !== scope.root || `${record.request.operationId}.json` !== file.name) throw new Error('Remote creation records belong to a different workspace or operation.')
      records.push(record)
    }
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  private async record(root: string, id: string): Promise<CreationRecord> {
    const scope = await this.scope(root)
    let record: CreationRecord
    try { record = recordSchema.parse(await readJsonBounded(this.file(scope.directory, id), 32768)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('This creation operation does not belong to the selected task workspace.')
      throw error
    }
    if (record.root !== scope.root || record.request.operationId !== id) throw new Error('The saved creation operation identity changed.')
    return record
  }

  private async save(record: CreationRecord, exclusive = false): Promise<void> {
    const scope = await this.scope(record.root)
    await writeJsonAtomic(this.file(scope.directory, record.request.operationId), recordSchema.parse(record), exclusive)
  }

  private async current(authorize: () => Promise<void>): Promise<void> {
    if (this.closed) throw new Error('The remote creation client is closed. No operation was replayed.')
    await authorize()
    if (this.closed) throw new Error('The remote creation client closed while preparing the operation.')
  }

  private async knownTask(root: string, taskId: string): Promise<void> {
    if (!(await readTaskWorkspace(root)).tasks.some((task) => task.id === taskId)) throw new Error('This task no longer exists in the selected workspace.')
  }

  private operation(root: string, id: string, action: () => Promise<AgentHostCreation>): Promise<AgentHostCreation> {
    const key = JSON.stringify([root, z.uuid().parse(id)])
    const previous = this.pending.get(key)
    const work = (previous ? previous.then(() => undefined, () => undefined) : Promise.resolve()).then(action)
    this.pending.set(key, work)
    void work.finally(() => { if (this.pending.get(key) === work) this.pending.delete(key) }).catch(() => undefined)
    return work
  }

  async workers(root: string, taskId: string): Promise<AgentHostWorker[]> {
    creationTaskIdSchema.parse(taskId)
    await this.knownTask(root, taskId)
    return this.devices.agentHostWorkers(root, taskId)
  }

  async list(root: string, taskId: string): Promise<AgentHostCreation[]> {
    creationTaskIdSchema.parse(taskId)
    return (await this.records(root)).filter((record) => record.request.taskId === taskId && !record.localBound).map((record) => this.result(record))
  }

  private result(record: CreationRecord): CreationRecord['result'] {
    return record.result.state === 'ready' && !record.localBound
      ? { ...record.result, state: 'created-unbound', error: record.result.error ?? 'Worker creation is confirmed, but the caller assignment is not. Check this operation to recover without creating again.' }
      : record.result
  }

  async create(root: string, value: AgentHostCreateRequest, authorize: () => Promise<void>): Promise<AgentHostCreation> {
    const request = agentHostCreateRequestSchema.parse(value)
    const scope = await this.scope(root)
    return this.operation(scope.root, request.operationId, async () => {
      await this.current(authorize)
      await mkdir(scope.directory, { recursive: true })
      const lockFile = join(scope.directory, 'reservation.lock')
      let lock
      try { lock = await open(lockFile, 'wx', 0o600) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another creation reservation is being saved. Reopen its status instead of submitting again. A stale reservation.lock requires all app instances to be stopped before removal.')
        throw error
      }
      let record: CreationRecord
      let existing = false
      try {
        const records = await this.records(scope.root)
        const prior = records.find((item) => item.request.operationId === request.operationId)
        if (prior) {
          if (JSON.stringify(prior.request) !== JSON.stringify(request)) throw new Error('The operation ID was already used with different creation parameters.')
          record = prior
          existing = true
        } else {
          if (records.length >= 1000) throw new Error('The remote creation history limit was reached.')
          if (records.some((item) => item.request.taskId === request.taskId && !item.localBound && item.result.state !== 'failed')) throw new Error('This task has an unresolved creation operation. Check that operation instead of creating another session.')
          await this.knownTask(scope.root, request.taskId)
          const links = await readRepositorySessionLinks(scope.root)
          if (links.document.bindings[request.taskId]) throw new Error('Detach the current session before creating another session for this task.')
          const worker = await this.devices.agentHostWorker(scope.root, request.workerId, request.taskId)
          const workspace = worker.workspaces.find((item) => item.id === request.workspaceId)
          if (worker.state !== 'connected') throw new Error(worker.error ?? 'The selected worker is not connected.')
          if (!workspace?.canSend || workspace.taskState !== 'available') throw new Error(workspace?.error ?? 'The selected workspace is not available with send permission for this task.')
          if (workspace.expectedRevision !== request.expectedRevision) throw new Error('The worker task bindings changed. Refresh the worker selection before creating.')
          if (!worker.hosts.some((host) => host.hostId === request.hostId && host.available)) throw new Error('The exact selected Host is unavailable or unsupported.')
          await this.current(authorize)
          const result: AgentHostCreation = { operationId: request.operationId, taskId: request.taskId, workerId: request.workerId, workspaceId: request.workspaceId, hostId: request.hostId, state: 'uncertain', error: 'Creation intent saved; no worker result has been confirmed. Query this operation without replaying it.' }
          record = { schemaVersion: 2, root: scope.root, createdAt: new Date().toISOString(), request, owner: worker.owner, expectedRevision: links.revision, result: agentHostCreationSchema.parse(result), localBound: false, bindingBlocked: false }
          await this.save(record, true)
        }
      } finally { await lock.close(); await rm(lockFile, { force: true }) }
      if (existing) return this.refresh(record, authorize)
      let dispatched = false
      try {
        const result = await this.devices.agentHostCreate(scope.root, request, async () => {
          await this.current(authorize)
          await this.knownTask(scope.root, request.taskId)
          const links = await readRepositorySessionLinks(scope.root)
          if (links.revision !== record.expectedRevision || links.document.bindings[request.taskId]) throw new Error('The caller task binding changed before creation. No remote create request was sent.')
          await this.current(authorize)
          dispatched = true
        })
        return await this.accept(record, result, authorize)
      } catch (error) {
        record.result = { ...record.result, state: dispatched ? 'uncertain' : 'failed', error: failureMessage(error) }
        await this.save(record)
        return record.result
      }
    })
  }

  private async accept(record: CreationRecord, value: AgentHostCreation, authorize: () => Promise<void>): Promise<AgentHostCreation> {
    const result = agentHostCreationSchema.parse(value)
    for (const key of ['operationId', 'taskId', 'workerId', 'workspaceId', 'hostId'] as const) {
      if (result[key] !== record.request[key]) throw new Error('The creation result belongs to a different request.')
    }
    if (result.session && (result.session.owner.clientId !== record.owner.clientId || result.session.owner.machineName.toLowerCase() !== record.owner.machineName.toLowerCase()
      || record.result.session && agentHostKey(result.session) !== agentHostKey(record.result.session))) throw new Error('The original creation owner or session identity changed.')
    const priorError = record.result.error
    record.result = result
    record.result = this.result(record)
    await this.save(record)
    if (result.state !== 'ready' || record.localBound) return result
    if (!result.session) throw new Error('The worker did not confirm a native session identity.')
    if (record.bindingBlocked) {
      record.result = { ...result, state: 'created-unbound', error: priorError ?? 'The session was created but its caller binding needs an explicit retry.' }
      await this.save(record)
      return record.result
    }
    try {
      await this.current(authorize)
      await this.knownTask(record.root, record.request.taskId)
      const before = await readRepositorySessionLinks(record.root)
      const prior = before.document.bindings[record.request.taskId]
      if (prior) {
        if (prior.provider !== 'agent-host' || agentHostKey(prior) !== agentHostKey(result.session)) throw new Error('The task is already bound to a different session. It was not overwritten.')
      } else {
        await this.current(authorize)
        const { sessionId, chatId, owner } = result.session
        await bindRepositoryAgentHostCreation(record.root, record.request.taskId, { sessionId, chatId, owner }, record.expectedRevision, () => this.current(authorize))
      }
      record.localBound = true
      record.bindingBlocked = false
      record.result = { ...result, error: undefined }
    } catch (error) {
      record.bindingBlocked = true
      record.result = { ...result, state: 'created-unbound', error: `The session was created on ${record.owner.machineName}, but its caller task binding was not saved. ${failureMessage(error)}`.slice(0, 2000) }
    }
    await this.save(record)
    return record.result
  }

  private async refresh(record: CreationRecord, authorize: () => Promise<void>): Promise<AgentHostCreation> {
    if (record.localBound || record.result.state === 'failed') return record.result
    try {
      await this.current(authorize)
      const result = await this.devices.agentHostCreationStatus(record.root, record.request, () => this.current(authorize))
      return await this.accept(record, result, authorize)
    } catch (error) {
      record.result = { ...record.result, state: record.result.session ? 'created-unbound' : 'uncertain', error: failureMessage(error) }
      await this.save(record)
      return record.result
    }
  }

  async status(root: string, id: string, authorize: () => Promise<void>): Promise<AgentHostCreation> {
    const scope = await this.scope(root)
    return this.operation(scope.root, id, async () => this.refresh(await this.record(scope.root, id), authorize))
  }

  async bind(root: string, id: string, authorize: () => Promise<void>): Promise<AgentHostCreation> {
    const scope = await this.scope(root)
    return this.operation(scope.root, id, async () => {
      const record = await this.record(scope.root, id)
      if (record.localBound) return record.result
      if (!record.result.session || record.result.state !== 'created-unbound') throw new Error('Confirm the original created session before retrying its binding.')
      await this.current(authorize)
      await this.knownTask(scope.root, record.request.taskId)
      const before = await readRepositorySessionLinks(scope.root)
      const prior = before.document.bindings[record.request.taskId]
      if (prior && (prior.provider !== 'agent-host' || agentHostKey(prior) !== agentHostKey(record.result.session))) throw new Error('The task already links a different session. It was not overwritten.')
      const worker = await this.devices.agentHostWorker(scope.root, record.request.workerId, record.request.taskId)
      const workspace = worker.workspaces.find((item) => item.id === record.request.workspaceId)
      if (worker.state !== 'connected' || worker.owner.clientId !== record.owner.clientId || !workspace?.canSend) throw new Error(worker.error ?? 'The original worker workspace is no longer available with send permission.')
      record.expectedRevision = before.revision
      await this.save(record)
      try {
        const result = await this.devices.agentHostBindCreation(scope.root, record.request, workspace.expectedRevision, () => this.current(authorize))
        record.bindingBlocked = false
        return await this.accept(record, result, authorize)
      } catch (error) {
        record.result = { ...record.result, state: 'created-unbound', error: failureMessage(error) }
        await this.save(record)
        return record.result
      }
    })
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.pending.values())
  }
}
