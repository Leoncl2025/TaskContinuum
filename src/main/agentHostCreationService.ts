import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { agentHostCreationErrorMessages } from '../shared/agentHostCreation'
import type { AgentHostCreationErrorCode, AgentHostCreationLocation, AgentHostCreationResult, AgentHostCreationWorkspace } from '../shared/agentHostCreation'
import { agentHostCreateCommandSchema, agentHostCreationBindSchema, agentHostCreationLookupSchema, agentHostCreationResultSchema, creationRevisionSchema } from './agentHostCreationProtocol'
import { agentHostKey, agentHostSessionIdSchema, agentHostTargetSchema } from './agentHostProtocol'
import { AgentHostCreationError } from './agentHostRegistry'
import type { AgentHostCreationInspection, AgentHostRegistry, PreparedAgentHostCreation } from './agentHostRegistry'
import { canonicalPolicyRoot, locallyLinkedAgentHostSessions, recordLocalLink } from './linkedSessionPolicy'
import { bindRepositoryAgentHostCreation, readRepositorySessionLinks, sessionOwnerSchema } from './repositorySessionLinks'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import { readTaskWorkspace } from './workspaceReader'
import { taskSessionLinks } from '../shared/sessionBindings'

type CreateCommand = z.infer<typeof agentHostCreateCommandSchema>
type Lookup = z.infer<typeof agentHostCreationLookupSchema>
const operationSchema = z.object({
  schemaVersion: z.literal(2),
  // Local operations use the owner's client ID as principal, not a network pairing.
  local: z.literal(true).optional(),
  pairId: z.uuid(), root: z.string().min(1).max(32768), owner: sessionOwnerSchema,
  request: agentHostCreateCommandSchema, requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  nativeSessionId: agentHostSessionIdSchema, phase: z.enum(['reserved', 'dispatched', 'binding', 'complete']),
  nativeAcknowledged: z.boolean(), nativeLifecycle: z.enum(['creating', 'ready', 'failed']).optional(),
  bindingRevision: creationRevisionSchema, everReady: z.boolean(), version: z.number().int().nonnegative(),
  result: agentHostCreationResultSchema,
}).strict().superRefine((operation, context) => {
  const request = operation.request, result = operation.result
  if (operation.local && operation.pairId !== operation.owner.clientId) context.addIssue({ code: 'custom', message: 'Local creation must belong to its execution owner.' })
  if (hash(request) !== operation.requestHash || result.operationId !== request.operationId || result.workspaceId !== request.workspaceId || result.taskId !== request.taskId || result.hostId !== request.hostId
    || result.session && (result.session.sessionId !== operation.nativeSessionId || JSON.stringify(result.session.owner) !== JSON.stringify(operation.owner))) {
    context.addIssue({ code: 'custom', message: 'Creation operation identity does not match its durable intent.' })
  }
  if (operation.nativeLifecycle === 'creating' && (result.state === 'ready' || result.state === 'created-unbound') && !operation.nativeAcknowledged) {
    context.addIssue({ code: 'custom', message: 'A provisional created session requires a durable native acknowledgement.' })
  }
  if (result.nativeLifecycle !== undefined && result.nativeLifecycle !== operation.nativeLifecycle) context.addIssue({ code: 'custom', message: 'Native lifecycle metadata does not match the worker verification record.' })
})
const operationsSchema = z.array(operationSchema).max(1000).superRefine((operations, context) => {
  if (new Set(operations.map((operation) => operation.request.operationId)).size !== operations.length) context.addIssue({ code: 'custom', message: 'Duplicate creation operation.' })
})
type Operation = Omit<z.infer<typeof operationSchema>, 'result'> & { result: AgentHostCreationResult }

export class AgentHostCreationRequestError extends AgentHostCreationError {
  constructor(readonly status: 400 | 403 | 409 | 503, message: string, readonly code?: AgentHostCreationErrorCode) { super(message) }
}
class ChangedOperationError extends AgentHostCreationError {}

function hash(request: CreateCommand): string { return createHash('sha256').update(JSON.stringify(agentHostCreateCommandSchema.parse(request))).digest('hex') }
export async function agentHostCreationWorkspaceId(root: string): Promise<string> { return createHash('sha256').update(await canonicalPolicyRoot(root)).digest('hex') }
function unresolved(operation: Operation): boolean { return !operation.everReady && ['creating', 'uncertain', 'created-unbound'].includes(operation.result.state) }
function operationLocation(operation: Operation): AgentHostCreationLocation { return operation.local ? 'local' : 'remote' }

export async function describeAgentHostCreationWorkspace(root: string, taskId: string, canSend: boolean): Promise<AgentHostCreationWorkspace> {
  let id: string
  let reachable = true
  try { id = await agentHostCreationWorkspaceId(root) } catch {
    id = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex')
    reachable = false
  }
  const workspace: AgentHostCreationWorkspace = { id, name: basename(root).slice(0, 300) || 'Authorized workspace', canSend, taskState: 'unavailable', expectedRevision: null }
  try {
    if (!reachable) throw new Error('Unavailable workspace.')
    const [tasks, links] = await Promise.all([readTaskWorkspace(root), readRepositorySessionLinks(root)])
    workspace.expectedRevision = links.revision
    workspace.taskState = !tasks.tasks.some((task) => task.id === taskId) ? 'missing' : links.document.bindings[taskId] ? 'bound' : 'available'
  } catch { workspace.error = 'The authorized task workspace or its session bindings could not be read.' }
  return workspace
}

export class AgentHostCreationService {
  private readonly abort = new AbortController()
  private readonly running = new Map<string, Promise<void>>()
  private readonly failures = new Map<string, string>()
  private writing: Promise<unknown> = Promise.resolve()
  private initialized = false
  private closed = false

  constructor(private readonly directory: string, private readonly registry: AgentHostRegistry,
    private readonly authorize: (pairId: string, workspaceId: string) => Promise<string>,
    private readonly authorizeLocal?: (ownerId: string, workspaceId: string) => Promise<string>) {}

  private async readOperations(): Promise<Operation[]> {
    try { return operationsSchema.parse(await readJsonBounded(join(this.directory, 'agent-host-creation', 'operations.json'), 8 * 1024 * 1024)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new AgentHostCreationRequestError(503, agentHostCreationErrorMessages['creation-records-unavailable'], 'creation-records-unavailable')
    }
  }

  async checkReady(): Promise<void> {
    if (this.closed) throw new AgentHostCreationRequestError(503, 'The worker is closed.')
    await this.writing
    await this.readOperations()
  }

  private transaction<Result>(action: (operations: Operation[]) => Promise<{ value: Result; changed?: boolean }> | { value: Result; changed?: boolean }): Promise<Result> {
    const operation = this.writing.then(async () => {
      const directory = join(this.directory, 'agent-host-creation')
      await mkdir(directory, { recursive: true })
      const lockPath = join(directory, 'operations.lock')
      const lock = await open(lockPath, 'wx', 0o600).catch(() => {
        throw new AgentHostCreationRequestError(503, 'Creation records are locked or unavailable. No native creation was retried. A stale lock may be removed only after all worker instances have stopped.')
      })
      try {
        const file = join(directory, 'operations.json')
        const operations = await this.readOperations()
        let recovered = false
        if (!this.initialized) for (const saved of operations) if (saved.result.state === 'creating') {
          saved.result.state = 'uncertain'
          saved.result.error = 'The worker restarted before this operation completed. Only its recorded native session may be inspected; creation will not be replayed.'
          saved.version++
          recovered = true
        }
        const { value, changed } = await action(operations)
        if (recovered || changed) {
          const checked = operationsSchema.parse(operations)
          if (Buffer.byteLength(JSON.stringify(checked, null, 2)) >= 8 * 1024 * 1024) throw new AgentHostCreationRequestError(503, 'The private creation record limit was reached. Existing reservations were not discarded.')
          await writeJsonAtomic(file, checked)
        }
        this.initialized = true
        return structuredClone(value)
      } finally { await lock.close(); await rm(lockPath, { force: true }) }
    })
    this.writing = operation.catch(() => undefined)
    return operation
  }

  private async authorizedRoot(pairId: string, workspaceId: string, expectedRoot?: string, location: AgentHostCreationLocation = 'remote'): Promise<string> {
    if (this.closed) throw new AgentHostCreationRequestError(403, 'The worker is closed.')
    const authorize = location === 'local' ? this.authorizeLocal : this.authorize
    if (!authorize) throw new AgentHostCreationRequestError(403, 'Local task creation is not authorized.')
    const root = await authorize(pairId, workspaceId)
    if (expectedRoot && root !== expectedRoot) throw new AgentHostCreationRequestError(403, 'The authorized workspace identity changed.')
    this.abort.signal.throwIfAborted()
    return root
  }

  private authorizedOperation(operation: Operation): Promise<string> {
    return this.authorizedRoot(operation.pairId, operation.request.workspaceId, operation.root, operationLocation(operation))
  }

  private async checkTask(root: string, request: CreateCommand): Promise<void> {
    let workspace
    try { workspace = await readTaskWorkspace(root) }
    catch { throw new AgentHostCreationRequestError(409, 'The authorized task workspace is unavailable. No native session was created.') }
    if (!workspace.tasks.some((task) => task.id === request.taskId)) throw new AgentHostCreationRequestError(409, 'The task does not exist on this worker. No native session was created.')
    const links = await readRepositorySessionLinks(root)
    if (links.revision !== request.expectedRevision) throw new AgentHostCreationRequestError(409, 'The worker task binding revision changed. Refresh before starting a new operation.')
  }

  async begin(pairId: string, value: CreateCommand, location: AgentHostCreationLocation = 'remote'): Promise<AgentHostCreationResult> {
    const request = agentHostCreateCommandSchema.parse(value)
    const root = await this.authorizedRoot(pairId, request.workspaceId, undefined, location)
    const owner = await this.registry.creationOwner()
    const reserved = await this.transaction(async (operations) => {
      const existing = operations.find((operation) => operation.request.operationId === request.operationId)
      if (existing) {
        if (existing.pairId !== pairId || existing.root !== root || operationLocation(existing) !== location) throw new AgentHostCreationRequestError(403, 'This operation does not belong to the authenticated caller and workspace.')
        if (JSON.stringify(existing.owner) !== JSON.stringify(owner)) throw new AgentHostCreationRequestError(403, 'The original worker execution identity is unavailable.')
        if (existing.requestHash !== hash(request)) throw new AgentHostCreationRequestError(409, 'The operation ID was already used with different creation parameters.')
        await this.authorizedRoot(pairId, request.workspaceId, root, location)
        return { value: { operation: existing, start: false } }
      }
      if (operations.length >= 1000) throw new AgentHostCreationRequestError(409, 'The private creation operation limit was reached. No records were discarded.')
      if (operations.some((operation) => operation.root === root && operation.request.taskId === request.taskId && unresolved(operation))) {
        throw new AgentHostCreationRequestError(409, 'Another unresolved creation already owns this worker task. Check that original operation instead of creating a duplicate.')
      }
      await this.checkTask(root, request)
      await this.authorizedRoot(pairId, request.workspaceId, root, location)
      const result: AgentHostCreationResult = { operationId: request.operationId, taskId: request.taskId, workspaceId: request.workspaceId, hostId: request.hostId, state: 'creating' }
      const operation: Operation = { schemaVersion: 2, ...(location === 'local' ? { local: true as const } : {}), pairId, root, owner, request, requestHash: hash(request), nativeSessionId: `copilotcli:/${randomUUID()}`, phase: 'reserved',
        nativeAcknowledged: false, bindingRevision: request.expectedRevision, everReady: false, version: 0, result }
      operations.push(operation)
      return { value: { operation, start: true }, changed: true }
    })
    if (reserved.start) this.launch(reserved.operation)
    await this.authorizedRoot(pairId, request.workspaceId, root, location)
    return this.visible(reserved.operation)
  }

  private launch(operation: Operation): void {
    const id = operation.request.operationId
    const pending = this.execute(operation).catch((error: unknown) => {
      this.failures.set(id, error instanceof AgentHostCreationError ? error.message : 'The native creation outcome could not be recorded. The durable reservation is retained; query this operation and do not create a replacement.')
    }).finally(() => { this.running.delete(id) })
    this.running.set(id, pending)
  }

  private async replace(operation: Operation, patch: Partial<Pick<Operation, 'phase' | 'bindingRevision' | 'everReady' | 'nativeAcknowledged' | 'nativeLifecycle' | 'result'>>): Promise<Operation> {
    const changed = await this.transaction((operations) => {
      const index = operations.findIndex((item) => item.request.operationId === operation.request.operationId)
      if (index < 0 || operations[index].version !== operation.version) throw new ChangedOperationError('This creation operation changed. Query its latest state; no native creation was replayed.')
      const next = { ...operation, ...patch, version: operation.version + 1 }
      const changed = operationSchema.parse({ ...next, result: { ...next.result, nativeLifecycle: next.nativeLifecycle } })
      operations[index] = changed
      return { value: changed, changed: true }
    })
    this.failures.delete(operation.request.operationId)
    return changed
  }

  private async execute(initial: Operation): Promise<void> {
    let operation = initial
    let prepared: PreparedAgentHostCreation | undefined
    try {
      await this.authorizedOperation(operation)
      if (JSON.stringify(await this.registry.creationOwner()) !== JSON.stringify(operation.owner)) throw new AgentHostCreationError('The worker execution identity changed. No replacement owner was selected.')
      prepared = await this.registry.prepareCreation(operation.request.hostId, operation.nativeSessionId, operation.root, this.abort.signal)
      await this.checkTask(operation.root, operation.request)
      if (JSON.stringify(await this.registry.creationOwner()) !== JSON.stringify(operation.owner)) throw new AgentHostCreationError('The worker execution identity changed during native preparation.')
      await this.authorizedOperation(operation)
      operation = await this.replace(operation, { phase: 'dispatched' })
      await prepared.create(async () => {
        await this.checkTask(operation.root, operation.request)
        if (JSON.stringify(await this.registry.creationOwner()) !== JSON.stringify(operation.owner)) throw new AgentHostCreationError('The worker execution identity changed before creation.')
        await this.authorizedOperation(operation)
      })
      operation = await this.replace(operation, { nativeAcknowledged: true })
      await this.authorizedOperation(operation)
      const inspected = await prepared.inspect(undefined, operation.nativeAcknowledged)
      await this.authorizedOperation(operation)
      await this.acceptInspection(operation, inspected)
    } catch (error) {
      if (error instanceof ChangedOperationError) return
      const message = error instanceof AgentHostCreationError ? error.message : prepared?.dispatched
        ? 'The native creation acknowledgement or exact session could not be verified. Query this same operation; creation will not be replayed.'
        : 'The Host could not prepare native creation. No native create request was dispatched.'
      await this.replace(operation, { phase: prepared?.dispatched ? operation.phase : 'complete', result: { ...operation.result, state: prepared?.dispatched ? 'uncertain' : 'failed', error: message } })
    } finally { await prepared?.close() }
  }

  private async lookup(pairId: string, value: Lookup, location: AgentHostCreationLocation = 'remote'): Promise<Operation> {
    const request = agentHostCreationLookupSchema.parse(value)
    const root = await this.authorizedRoot(pairId, request.workspaceId, undefined, location)
    const operation = await this.transaction((operations) => {
      const operation = operations.find((item) => item.request.operationId === request.operationId)
      if (!operation || operation.pairId !== pairId || operation.request.workspaceId !== request.workspaceId || operation.root !== root || operationLocation(operation) !== location) {
        throw new AgentHostCreationRequestError(403, 'This operation does not belong to the authenticated pairing and workspace.')
      }
      return { value: operation }
    })
    await this.authorizedOperation(operation)
    if (JSON.stringify(await this.registry.creationOwner()) !== JSON.stringify(operation.owner)) throw new AgentHostCreationRequestError(403, 'The original worker execution identity is unavailable.')
    return operation
  }

  private visible(operation: Operation): AgentHostCreationResult {
    const failure = this.failures.get(operation.request.operationId)
    return agentHostCreationResultSchema.parse({ ...(failure ? { ...operation.result, state: operation.result.session ? 'created-unbound' : 'uncertain', error: failure } : operation.result), nativeLifecycle: operation.nativeLifecycle })
  }

  async status(pairId: string, value: Lookup, location: AgentHostCreationLocation = 'remote'): Promise<AgentHostCreationResult> {
    let operation = await this.lookup(pairId, value, location)
    if (!this.running.has(operation.request.operationId)) {
      if (operation.result.state === 'ready') {
        if (!await this.bindingReady(operation)) operation = await this.replace(operation, { phase: 'complete', result: { ...operation.result, state: 'created-unbound', error: 'The original task binding or local receipt was removed. Status will not rebind it. Explicitly retry binding this same session if intended.' } })
        else if (operation.nativeLifecycle === 'creating') operation = await this.reconcile(operation)
        else this.failures.delete(operation.request.operationId)
      } else if (operation.result.state !== 'failed' && operation.result.state !== 'created-unbound') {
        operation = await this.reconcile(operation)
      }
    }
    await this.authorizedOperation(operation)
    return this.visible(operation)
  }

  private async reconcile(operation: Operation): Promise<Operation> {
    try {
      const inspected = await this.registry.inspectCreation(operation.request.hostId, operation.nativeSessionId, operation.root, this.abort.signal, operation.result.session?.chatId, operation.nativeAcknowledged)
      await this.authorizedOperation(operation)
      return await this.acceptInspection(operation, inspected)
    } catch (error) {
      if (error instanceof ChangedOperationError) return this.lookup(operation.pairId, { operationId: operation.request.operationId, workspaceId: operation.request.workspaceId }, operationLocation(operation))
      return this.replace(operation, { nativeLifecycle: undefined, result: { ...operation.result, state: operation.result.session && !operation.everReady ? 'created-unbound' : 'uncertain',
        error: error instanceof AgentHostCreationError ? error.message : 'The recorded native session is not currently verifiable. A missing session is not permission to replay creation.' } })
    }
  }

  private async acceptInspection(operation: Operation, inspected: AgentHostCreationInspection): Promise<Operation> {
    if (inspected.state === 'creating') return this.replace(operation, { nativeLifecycle: 'creating', result: { ...operation.result, state: 'uncertain', error: inspected.error } })
    if (inspected.state === 'failed') return this.replace(operation, { phase: 'complete', nativeLifecycle: 'failed', result: { ...operation.result, state: 'failed', error: inspected.error } })
    if (JSON.stringify(inspected.session.owner) !== JSON.stringify(operation.owner) || inspected.session.sessionId !== operation.nativeSessionId
      || operation.result.session && agentHostKey(operation.result.session) !== agentHostKey(inspected.session)) throw new AgentHostCreationError('The native session identity changed. No replacement session or chat was selected.')
    const recovery = operation.phase === 'binding'
    operation = await this.replace(operation, { nativeLifecycle: inspected.nativeLifecycle, result: { ...operation.result, session: inspected.session } })
    if (operation.everReady) {
      const bound = await this.bindingReady(operation)
      return this.replace(operation, { phase: 'complete', result: { ...operation.result, state: bound ? 'ready' : 'created-unbound', error: bound ? undefined : 'The original binding must be retried explicitly; status cannot rebind a previously completed operation.' } })
    }
    return this.bindVerified(operation, operation.bindingRevision, recovery)
  }

  private async bindingReady(operation: Operation): Promise<boolean> {
    try {
      const { document } = await readRepositorySessionLinks(operation.root)
      const link = operation.result.session && taskSessionLinks(document.bindings, operation.request.taskId)
        .find((candidate) => agentHostKey(candidate) === agentHostKey(operation.result.session!))
      return !!link
        && (await readTaskWorkspace(operation.root)).tasks.some((task) => task.id === operation.request.taskId)
        && (await locallyLinkedAgentHostSessions(this.directory, operation.root, operation.owner)).some((target) => agentHostKey(target) === agentHostKey(operation.result.session!))
    } catch { return false }
  }

  private async bindVerified(initial: Operation, expectedRevision: string | null, recovering = false): Promise<Operation> {
    let operation = initial
    const session = operation.result.session!
    const target = agentHostTargetSchema.parse({ sessionId: session.sessionId, chatId: session.chatId, owner: session.owner })
    const authorize = async () => {
      if (JSON.stringify(await this.registry.creationOwner()) !== JSON.stringify(operation.owner)) throw new AgentHostCreationRequestError(403, 'The worker execution identity changed before binding.')
      await this.authorizedOperation(operation)
    }
    try {
      const before = await readRepositorySessionLinks(operation.root)
      const same = taskSessionLinks(before.document.bindings, operation.request.taskId).some((link) => agentHostKey(link) === agentHostKey(target))
      if (recovering && !same) throw new AgentHostCreationError('A prior binding attempt was interrupted and its binding is absent or changed. Explicitly retry binding; status will not silently restore a detached task.')
      if (!recovering && before.revision !== expectedRevision) throw new AgentHostCreationError('The task binding changed. Refresh its revision and explicitly retry binding this same session.')
      await authorize()
      operation = await this.replace(operation, { phase: 'binding', bindingRevision: expectedRevision })
      await bindRepositoryAgentHostCreation(operation.root, operation.request.taskId, target, recovering ? before.revision : expectedRevision, authorize)
      await authorize()
      const current = await readRepositorySessionLinks(operation.root)
      const link = taskSessionLinks(current.document.bindings, operation.request.taskId).find((candidate) => agentHostKey(candidate) === agentHostKey(target))
      if (!link) throw new AgentHostCreationError('The created session was not present in the task bindings before its worker-local receipt could be saved.')
      await authorize()
      await recordLocalLink(this.directory, operation.root, operation.request.taskId, link, operation.owner)
      await authorize()
      if (!await this.bindingReady(operation)) throw new AgentHostCreationError('The created session binding or local receipt could not be verified. Retry binding explicitly, not creation.')
      await authorize()
      return await this.replace(operation, { phase: 'complete', everReady: true, result: { ...operation.result, state: 'ready', error: undefined } })
    } catch (error) {
      if (error instanceof ChangedOperationError) throw error
      return this.replace(operation, { phase: 'complete', result: { ...operation.result, state: 'created-unbound',
        error: error instanceof AgentHostCreationError ? error.message : 'The verified native session was created, but its task binding or local receipt could not be saved. Refresh the revision and explicitly retry binding this same session.' } })
    }
  }

  async bind(pairId: string, value: z.infer<typeof agentHostCreationBindSchema>, location: AgentHostCreationLocation = 'remote'): Promise<AgentHostCreationResult> {
    const request = agentHostCreationBindSchema.parse(value)
    let operation = await this.lookup(pairId, { operationId: request.operationId, workspaceId: request.workspaceId }, location)
    if (this.running.has(request.operationId)) throw new AgentHostCreationRequestError(409, 'This creation is still running. Query its status before retrying binding.')
    if (operation.result.state === 'ready' && await this.bindingReady(operation)) {
      return operation.nativeLifecycle === 'creating' ? this.status(pairId, { operationId: request.operationId, workspaceId: request.workspaceId }, location) : this.visible(operation)
    }
    if (!operation.result.session) throw new AgentHostCreationRequestError(409, 'The exact native session and chat have not been verified. Query status; binding cannot create a session.')
    const inspected = await this.registry.inspectCreation(operation.request.hostId, operation.nativeSessionId, operation.root, this.abort.signal, operation.result.session.chatId, operation.nativeAcknowledged)
    await this.authorizedOperation(operation)
    if (inspected.state !== 'ready' || agentHostKey(inspected.session) !== agentHostKey(operation.result.session)) throw new AgentHostCreationRequestError(409, 'The exact original native session and chat are not ready. Binding did not create or replace a session.')
    operation = await this.replace(operation, { nativeLifecycle: inspected.nativeLifecycle })
    operation = await this.bindVerified(operation, request.expectedRevision)
    await this.authorizedOperation(operation)
    return this.visible(operation)
  }

  async close(): Promise<void> {
    this.closed = true
    this.abort.abort()
    await Promise.all([...this.running.values()])
    await this.writing
  }
}
