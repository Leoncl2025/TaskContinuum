import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { sessionLinkEntries, taskSessionLinks, type SessionLink, type SessionLinksDocument, type SessionLinksSnapshot } from '../../shared/sessionBindings'
import {
  remoteConfigLimits, type BindingNotificationAcknowledgement, type RemoteActor, type RemoteConfigSnapshot,
  type RemoteConfigStoreStatus, type RemotePayloads, type RemoteRecord, type RemoteRecordFile, type RemoteRecordKind,
  type RemoteSettingChanges, type RemoteSettingsSnapshot, type SettingPayload, type SettingScope,
} from '../../shared/remoteConfig'
import type { RepositorySessionLinksBackend, SessionLinksAuthorization } from '../repositorySessionLinks'
import { sessionLinkKey, sessionLinkSchema, sessionLinksDocumentSchema, sessionLinkTaskIdSchema } from '../sessionLinkSchema'
import { BindingOverlay } from './overlay'
import { authorizationInputs } from './authorizationInputs'
import { acquireStoreLock } from './storeLock'
import type { AuthorizationTransactionLock } from './authorizationInputs'
import { AuthorizationWatch } from '../shared/authorizationWatch'
import { logAgentHostDiagnostic, measureAgentHostDiagnostic } from '../agentHostDiagnostics'
import type { AgentHostDiagnosticDetails } from '../agentHostDiagnostics'
import {
  appendRecord, canonicalJson, createRecord, devicePublicationSchema, entityKey, operationIdSchema, parseRecord,
  readCheckedFile, readRecords, recordClosure, recordPath, RemoteConfigError, resolvedSettings, resolveRecords, serializeRecord, unionRecords, verifyRecord, writeLocalState,
  type Awaitable, type RecordInput, type RecordSigner, type RecordTrust,
} from './records'

const stateSchema = z.object({
  schemaVersion: z.literal(1), workspaceId: z.uuid(), initialized: z.boolean(),
  canonicalIds: z.array(operationIdSchema).max(remoteConfigLimits.records),
  localIds: z.array(operationIdSchema).max(remoteConfigLimits.records).default([]),
}).strict()
type StoreState = z.infer<typeof stateSchema>
type LocalChangeListener = (operations: RemoteRecord[], snapshot: RemoteConfigSnapshot) => Awaitable<void>
export interface RemoteConfigStoreOptions {
  workspaceRoot: string
  recordsRoot: string
  outboxRoot: string
  stateDirectory: string
  workspaceId: string
  actor: RemoteActor
  sign: RecordSigner
  trust: RecordTrust
  overlay?: BindingOverlay
  onLocalChange?: LocalChangeListener
  onChange?(): void
  onError?(error: unknown): void
}
interface TransactionResult<T> { value: T; changed: RemoteRecord[]; snapshot?: RemoteConfigSnapshot }
interface Journal { schemaVersion: 1; workspaceId: string; operations: RemoteRecord[]; state: StoreState }
interface RecordSources { canonical: RemoteRecord[]; outbox: RemoteRecord[] }

function sha(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex') }
function assertNoOwnershipTransfer(previous: SessionLink[], next: SessionLink[]): void {
  const removed = previous.filter((old) => !next.some((target) => sessionLinkKey(target) === sessionLinkKey(old)))
  const added = next.filter((target) => !previous.some((old) => sessionLinkKey(old) === sessionLinkKey(target)))
  for (const old of removed) {
    if (added.some((target) => old.provider === target.provider && old.sessionId === target.sessionId
      && old.owner.clientId !== target.owner.clientId)) {
      throw new RemoteConfigError('ownership-transfer', 'Session ownership cannot be changed by linking.')
    }
  }
}

export class RemoteConfigStore implements RepositorySessionLinksBackend {
  private pending: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<LocalChangeListener>()
  private closed = false
  private authorizationCache?: { inputs: string; snapshot: SessionLinksSnapshot; from: number; until: number }
  private authorizing?: Promise<{ snapshot: SessionLinksSnapshot; generation: number }>
  private generation = 0
  private readonly accessWatch = new AuthorizationWatch()
  private watching?: Promise<void>
  private sessionAuthorization?: SessionLinksAuthorization
  private acquiringAuthorization?: Promise<SessionLinksAuthorization>
  private transactionLock?: AuthorizationTransactionLock
  private readOnlyLock?: AuthorizationTransactionLock
  private pendingMutations = 0
  private verifiedSnapshot?: {
    inputs: string; state: string; snapshot: RemoteConfigSnapshot; from: number; until: number
    trustedKey: RecordTrust['trustedKey']; authorize: RecordTrust['authorize']
    allowKeyRotation: RecordTrust['allowKeyRotation']; allowDeviceReactivation: RecordTrust['allowDeviceReactivation']
  }

  constructor(readonly options: RemoteConfigStoreOptions) {
    z.uuid().parse(options.workspaceId)
    z.uuid().parse(options.actor.deviceId)
    if (options.workspaceId !== options.trust.workspaceId) throw new RemoteConfigError('workspace-mismatch', 'The store and trust policy must pin the same workspace.')
    if (options.onLocalChange) this.listeners.add(options.onLocalChange)
  }

  private measure<T>(event: 'authorization.store' | 'configuration.transaction' | 'configuration.snapshot',
    step: AgentHostDiagnosticDetails['step'], action: () => Promise<T>): Promise<T> {
    return measureAgentHostDiagnostic(event, { scope: this.options.workspaceRoot, step }, action)
  }

  subscribeLocalChanges(listener: LocalChangeListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private async directory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new RemoteConfigError('unsafe-path', 'The remote configuration storage root must be a real directory.')
  }
  private async localJson(name: string, maximum: number): Promise<unknown | undefined> {
    try { return JSON.parse((await readCheckedFile(this.options.stateDirectory, join(this.options.stateDirectory, name), maximum)).toString('utf8')) as unknown }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  private async state(): Promise<StoreState> {
    const saved = await this.localJson('store.json', 2 * 1024 * 1024)
    if (saved !== undefined) {
      const parsed = stateSchema.safeParse(saved)
      if (!parsed.success) throw new RemoteConfigError('unsupported-state', 'The saved binding store is invalid or uses legacy configuration. Restore a new-format store; legacy state is not migrated.')
      const state = parsed.data
      if (state.workspaceId !== this.options.workspaceId) throw new RemoteConfigError('workspace-mismatch', 'Saved remote configuration belongs to another workspace. It was not reset.')
      return state
    }
    return { schemaVersion: 1, workspaceId: this.options.workspaceId, initialized: false, canonicalIds: [], localIds: [] }
  }
  private async notify(operations: RemoteRecord[], snapshot: RemoteConfigSnapshot): Promise<void> {
    if (!operations.length) return
    // Start every delivery independently. An SSH failure must not prevent Git publication.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.options.onChange?.()),
      ...[...this.listeners].map(async (listener) => listener(structuredClone(operations), structuredClone(snapshot))),
    ])
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason as unknown] : [])
    for (const failure of failures) this.options.onError?.(failure)
    if (failures.length && !this.options.onError) throw new RemoteConfigError('delivery-failed', `The configuration was durably saved, but ${failures.length} local change notification(s) failed. Retry delivery, not the edit.`)
  }
  private async transaction<T>(action: (state: StoreState, recovered: RemoteRecord[]) => Promise<TransactionResult<T>>, mutates = true): Promise<T> {
    this.generation++
    if (mutates) this.pendingMutations++
    const previous = this.pending
    const operation = this.measure('configuration.transaction', 'response', async () => {
      await this.measure('configuration.transaction', 'queue', async () => { await previous })
      if (this.closed) throw new RemoteConfigError('closed', 'The remote configuration store is closed.')
      await this.directory(this.options.stateDirectory)
      await this.directory(this.options.outboxRoot)
      for (const repository of [this.options.recordsRoot, this.options.workspaceRoot]) {
        const root = await realpath(repository)
        for (const local of [this.options.stateDirectory, this.options.outboxRoot]) {
          const child = relative(root, await realpath(local))
          if (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)) throw new RemoteConfigError('unsafe-path', 'Local state and the durable outbox must be outside both the accepted-record cache and the user checkout.')
        }
      }
      const lock = await this.measure('configuration.transaction', 'lock', () => acquireStoreLock(this.options.stateDirectory, this.options.workspaceId))
      try {
        if (lock.recovered) logAgentHostDiagnostic('configuration.transaction', { scope: this.options.workspaceRoot, step: 'workspace-recovery', status: 'ok' })
        this.transactionLock = lock.identity
        const recovered = await this.measure('configuration.transaction', 'journal', () => this.recoverJournal())
        const state = await this.measure('configuration.transaction', 'state', () => this.state())
        if (!mutates) this.readOnlyLock = this.transactionLock
        return await action(state, recovered)
      } finally {
        this.readOnlyLock = undefined
        this.transactionLock = undefined
        await lock.release()
      }
    }).catch((error: unknown) => { this.verifiedSnapshot = undefined; this.accessWatch.invalidate(); throw error })
      .finally(() => { if (mutates) this.pendingMutations-- })
    this.pending = operation.then(() => undefined, () => undefined)
    const result = await operation
    if (result.changed.length) await this.measure('configuration.transaction', 'notify', async () => this.notify(result.changed, result.snapshot ?? await this.read()))
    return result.value
  }
  private async recoverJournal(): Promise<RemoteRecord[]> {
    const raw = await this.localJson('pending-operations.json', remoteConfigLimits.totalBytes)
    if (raw === undefined) return []
    const parsed = z.object({
      schemaVersion: z.literal(1), workspaceId: z.uuid(), operations: z.array(z.unknown()).max(1000), state: stateSchema,
    }).strict().parse(raw)
    if (parsed.workspaceId !== this.options.workspaceId || parsed.state.workspaceId !== this.options.workspaceId) throw new RemoteConfigError('workspace-mismatch', 'Pending operation recovery belongs to another workspace.')
    const operations = parsed.operations.map(parseRecord)
    for (const record of operations) {
      if (record.actor.deviceId !== this.options.actor.deviceId) throw new RemoteConfigError('wrong-actor', 'A local pending batch has a different operation author.')
      await verifyRecord(record, this.options.trust)
    }
    // Replays the exact previously persisted intentions; never reparent after a restart.
    for (const record of operations) await appendRecord(this.options.outboxRoot, record)
    parsed.state.localIds = [...new Set([...parsed.state.localIds, ...operations.map((record) => record.operationId)])].sort()
    await writeLocalState(this.options.stateDirectory, 'store.json', parsed.state)
    await rm(join(this.options.stateDirectory, 'pending-operations.json'))
    return operations
  }
  private async sources(state: StoreState): Promise<RecordSources> {
    const [canonical, outbox] = await Promise.all([readRecords(this.options.recordsRoot), readRecords(this.options.outboxRoot)])
    const present = new Set(canonical.map((record) => record.operationId))
    if (state.canonicalIds.some((id) => !present.has(id))) throw new RemoteConfigError('immutable-removal', 'A previously accepted canonical operation was removed. Synchronization is blocked; historical records cannot be deleted or compacted.')
    const allPresent = new Set([...present, ...outbox.map((record) => record.operationId)])
    if (state.localIds.some((id) => !allPresent.has(id))) throw new RemoteConfigError('immutable-removal', 'A durably saved local operation was removed before canonical publication. Restore its original record; no older configuration was activated.')
    return { canonical, outbox }
  }
  private async snapshot(state: StoreState, sources?: RecordSources): Promise<RemoteConfigSnapshot> {
    if (!sources && this.transactionLock && this.options.trust.authorizationVersion) {
      const before = await this.inputs('configuration.snapshot', this.transactionLock)
      const currentState = canonicalJson(state)
      const now = this.options.trust.now?.() ?? Date.now()
      const cached = this.verifiedSnapshot
      const trust = this.options.trust
      if (cached?.inputs === before && cached.state === currentState && now >= cached.from && now < cached.until
        && cached.trustedKey === trust.trustedKey && cached.authorize === trust.authorize
        && cached.allowKeyRotation === trust.allowKeyRotation && cached.allowDeviceReactivation === trust.allowDeviceReactivation) {
        logAgentHostDiagnostic('configuration.snapshot', { scope: this.options.workspaceRoot, step: 'cache', status: 'ok', reason: 'cache-hit' })
        return structuredClone(cached.snapshot)
      }
      this.verifiedSnapshot = undefined
      logAgentHostDiagnostic('configuration.snapshot', { scope: this.options.workspaceRoot, step: 'cache', status: 'ok', reason: 'cache-miss' })
      const snapshot = await this.resolveSnapshot(state)
      const after = await this.inputs('configuration.snapshot', this.transactionLock)
      if (before === after && !snapshot.resolution.blocked) {
        this.verifiedSnapshot = { inputs: after, state: canonicalJson(state), snapshot: structuredClone(snapshot), from: now,
          until: this.nextExpiry(snapshot.resolution.records, now), trustedKey: trust.trustedKey, authorize: trust.authorize,
          allowKeyRotation: trust.allowKeyRotation, allowDeviceReactivation: trust.allowDeviceReactivation }
      }
      return snapshot
    }
    return this.resolveSnapshot(state, sources)
  }

  private nextExpiry(records: readonly RemoteRecord[], now: number): number {
    return Math.min(Infinity, ...records.flatMap((record) => record.kind === 'invitation' && record.payload.action === 'grant'
      && Date.parse(record.payload.expiresAt) > now ? [Date.parse(record.payload.expiresAt)] : []))
  }

  private async inputs(event: 'authorization.store' | 'configuration.snapshot', ownedLock?: AuthorizationTransactionLock): Promise<string> {
    const version = this.options.trust.authorizationVersion!()
    const files = await this.measure(event, 'inputs', () => authorizationInputs(this.options.recordsRoot, this.options.outboxRoot, this.options.stateDirectory, ownedLock))
    const overlay = await this.measure(event, 'overlay', async () => this.options.overlay?.authorizationRevision())
    if (version !== this.options.trust.authorizationVersion!()) throw new RemoteConfigError('authorization-changed', 'The enrolled trust changed during authorization.')
    return JSON.stringify([files, version, this.options.trust.workspaceId, this.options.trust.maximumInvitationLifetimeMs, overlay])
  }

  private async resolveSnapshot(state: StoreState, sources?: RecordSources): Promise<RemoteConfigSnapshot> {
    const { canonical, outbox } = sources ?? await this.measure('configuration.snapshot', 'records', () => this.sources(state))
    const records = unionRecords(canonical, outbox)
    const overlay = await this.measure('configuration.snapshot', 'overlay', async () => this.options.overlay?.reconcile(canonical, this.options.trust))
    const resolution = await this.measure('configuration.snapshot', 'resolution', () => resolveRecords(unionRecords(records, overlay?.records ?? []), this.options.trust))
    logAgentHostDiagnostic('configuration.snapshot', { scope: this.options.workspaceRoot, step: 'records', status: 'ok', count: records.length })
    const bindings = resolution.bindings
    for (const marker of overlay?.awaitingSync ?? []) {
      delete bindings[marker.taskId]
      const entity = resolution.entities[`binding:${marker.taskId}`]
      if (entity) entity.state = 'blocked'
      resolution.diagnostics.push({ code: 'awaiting-sync', message: 'A provisional binding expired or was recovered after restart. Await the exact canonical operation or explicitly cancel it.', entityKey: `binding:${marker.taskId}`, operationId: marker.operationId })
    }
    const document: SessionLinksDocument = { schemaVersion: '2.1', bindings }
    const revision = sha({ resolution: resolution.revision, canonical: canonical.map((record) => record.operationId), overlay: overlay?.revision ?? null, initialized: state.initialized })
    if (state.initialized) {
      const accepted = canonical.map((record) => record.operationId).sort()
      if (canonicalJson(accepted) !== canonicalJson(state.canonicalIds) && !resolution.blocked) {
        state.canonicalIds = accepted
        await writeLocalState(this.options.stateDirectory, 'store.json', state)
      }
    }
    return {
      document, revision, initialized: state.initialized, records, resolution,
      provisional: overlay?.provisional ?? [], awaitingSync: overlay?.awaitingSync ?? [],
    }
  }
  read(): Promise<RemoteConfigSnapshot> {
    return this.transaction(async (state, recovered) => {
      const snapshot = await this.snapshot(state)
      return { value: snapshot, changed: recovered, snapshot }
    }, false)
  }

  async readForAuthorization(): Promise<SessionLinksSnapshot> {
    if (!this.options.trust.authorizationVersion) return this.read()
    for (let attempt = 0; attempt < 3; attempt++) {
      this.authorizing ??= this.authorizationSnapshot().finally(() => { this.authorizing = undefined })
      const result = await this.authorizing
      if (!this.closed && result.generation === this.generation) return structuredClone(result.snapshot)
    }
    // Active synchronization may keep invalidating reuse. Preserve the original verified read in that case.
    return this.read()
  }

  async acquireAuthorization(): Promise<SessionLinksAuthorization> {
    if (this.sessionAuthorization?.current()) return this.sessionAuthorization
    if (this.acquiringAuthorization) logAgentHostDiagnostic('authorization.store', { scope: this.options.workspaceRoot, step: 'cache', status: 'scheduled', reason: 'coalesced' })
    this.acquiringAuthorization ??= this.measure('authorization.store', 'load', () => this.createSessionAuthorization()).finally(() => { this.acquiringAuthorization = undefined })
    return this.acquiringAuthorization
  }

  private async createSessionAuthorization(): Promise<SessionLinksAuthorization> {
    if (!this.options.trust.authorizationVersion) return { snapshot: await this.read(), current: () => false }
    this.watching ??= (async () => {
      for (const root of [this.options.recordsRoot, this.options.outboxRoot]) {
        await this.directory(root)
        this.accessWatch.observe(root, true)
      }
      await this.directory(this.options.stateDirectory)
      this.accessWatch.observe(this.options.stateDirectory, false, (name) => ['store.json', 'pending-operations.json', 'binding-overlays.json'].includes(name))
      this.accessWatch.observe(this.options.workspaceRoot, false)
    })()
    await this.watching
    for (let attempt = 0; attempt < 3; attempt++) {
      const unchanged = this.accessWatch.checkpoint()
      const version = this.options.trust.authorizationVersion()
      const snapshot = await this.measure('authorization.store', 'snapshot', () => this.readForAuthorization())
      const overlay = this.options.overlay?.currentAuthorizationRevision()
      const cached = this.authorizationCache
      if (!unchanged() || !cached || cached.snapshot.revision !== snapshot.revision || version !== this.options.trust.authorizationVersion()) {
        logAgentHostDiagnostic('authorization.store', { scope: this.options.workspaceRoot, step: 'retry', status: 'scheduled', attempt: attempt + 1, reason: 'inputs-changed' })
        continue
      }
      const lease = {
        snapshot,
        current: () => {
          const now = this.options.trust.now?.() ?? Date.now()
          return !this.closed && unchanged() && version === this.options.trust.authorizationVersion?.()
            && now >= cached.from && now < cached.until && overlay === this.options.overlay?.currentAuthorizationRevision()
        },
      }
      this.sessionAuthorization = lease
      return lease
    }
    logAgentHostDiagnostic('authorization.store', { scope: this.options.workspaceRoot, step: 'retry', status: 'error', reason: 'retry-exhausted' })
    return { snapshot: await this.readForAuthorization(), current: () => false }
  }

  private async authorizationSnapshot(): Promise<{ snapshot: SessionLinksSnapshot; generation: number }> {
    const inputs = () => this.inputs('authorization.store')
    for (let attempt = 0; attempt < 3; attempt++) {
      const readOnlyLock = this.readOnlyLock
      const reusable = this.authorizationCache
      if (!this.pendingMutations && readOnlyLock && reusable) {
        let currentInputs: string
        try { currentInputs = await this.inputs('authorization.store', readOnlyLock) }
        catch (error) {
          if (this.readOnlyLock !== readOnlyLock || this.pendingMutations || reusable !== this.authorizationCache) continue
          throw error
        }
        const now = this.options.trust.now?.() ?? Date.now()
        if (!this.closed && !this.pendingMutations && this.readOnlyLock === readOnlyLock && reusable === this.authorizationCache
          && reusable.inputs === currentInputs && now >= reusable.from && now < reusable.until) {
          logAgentHostDiagnostic('authorization.store', { scope: this.options.workspaceRoot, step: 'queue', status: 'ok', reason: 'cache-hit', elapsedMs: 0 })
          return { snapshot: reusable.snapshot, generation: this.generation }
        }
      }
      const pending = this.pending
      await this.measure('authorization.store', 'queue', async () => { await pending })
      if (pending !== this.pending) {
        logAgentHostDiagnostic('authorization.store', { scope: this.options.workspaceRoot, step: 'retry', status: 'scheduled', attempt: attempt + 1, reason: 'generation-changed' })
        continue
      }
      if (this.closed) throw new RemoteConfigError('closed', 'The remote configuration store is closed.')
      const generation = this.generation
      let before: string
      try { before = await inputs() }
      catch (error) { if (generation !== this.generation) continue; throw error }
      if (generation !== this.generation) continue
      const now = this.options.trust.now?.() ?? Date.now()
      const cached = this.authorizationCache
      if (cached?.inputs === before && now >= cached.from && now < cached.until) {
        logAgentHostDiagnostic('authorization.store', { scope: this.options.workspaceRoot, step: 'cache', status: 'ok', reason: 'cache-hit' })
        return { snapshot: cached.snapshot, generation }
      }
      logAgentHostDiagnostic('authorization.store', { scope: this.options.workspaceRoot, step: 'cache', status: 'ok', reason: 'cache-miss' })
      this.authorizationCache = undefined
      const reading = this.read()
      const afterGeneration = this.generation
      const fresh = await reading
      // A read can finish while its change notifications have already queued another transaction.
      // Capture our generation before awaiting it, not the generation of that newer lock holder.
      if (afterGeneration !== this.generation) continue
      let after: string
      try { after = await inputs() }
      catch (error) { if (afterGeneration !== this.generation) continue; throw error }
      if (before !== after || afterGeneration !== this.generation || this.closed) continue
      const snapshot = { document: fresh.document, revision: fresh.revision }
      if (!fresh.resolution.blocked) this.authorizationCache = { inputs: after, snapshot: structuredClone(snapshot), from: now, until: this.nextExpiry(fresh.resolution.records, now) }
      return { snapshot, generation: afterGeneration }
    }
    const reading = this.read()
    const generation = this.generation
    const fresh = await reading
    return { snapshot: { document: fresh.document, revision: fresh.revision }, generation }
  }

  /** Canonical plus locally durable records; provisional SSH records are not exportable authority. */
  async getRecords(): Promise<RemoteRecord[]> { return (await this.read()).records }

  private pendingRecords(sources: RecordSources): RemoteRecord[] {
    const canonical = new Set(sources.canonical.map((record) => record.operationId))
    return sources.outbox.filter((record) => !canonical.has(record.operationId))
  }

  getPendingRecords(): Promise<RemoteRecord[]> {
    return this.transaction(async (state, recovered) => {
      const sources = await this.sources(state)
      const snapshot = await this.snapshot(state, sources)
      return { value: this.pendingRecords(sources), changed: recovered, snapshot }
    })
  }

  /** Returns canonical bytes and Git-relative paths, without writing or publishing them. */
  exportRecords(pendingOnly = false): Promise<RemoteRecordFile[]> {
    return this.transaction(async (state, recovered) => {
      const sources = await this.sources(state)
      const snapshot = await this.snapshot(state, sources)
      if (snapshot.resolution.blocked) throw new RemoteConfigError('blocked-export', 'Invalid or unauthorized configuration cannot be exported for publication.')
      const records = pendingOnly ? this.pendingRecords(sources) : snapshot.records
      const value = records.map((record) => ({ path: recordPath(record).split(sep).join('/'), content: serializeRecord(record) }))
      return { value, changed: recovered, snapshot }
    })
  }

  async getSettings(deviceId = this.options.actor.deviceId): Promise<RemoteSettingsSnapshot> {
    z.uuid().parse(deviceId)
    const snapshot = await this.read()
    return {
      revision: snapshot.revision, values: resolvedSettings(snapshot.resolution, deviceId),
      diagnostics: snapshot.resolution.diagnostics.filter((diagnostic) => snapshot.resolution.blocked || !diagnostic.entityKey
        || diagnostic.entityKey.startsWith('setting:workspace:') || diagnostic.entityKey.startsWith(`setting:${deviceId}:`)),
    }
  }

  status(): Promise<RemoteConfigStoreStatus> {
    return this.transaction(async (state, recovered) => {
      const sources = await this.sources(state)
      const snapshot = await this.snapshot(state, sources)
      const value: RemoteConfigStoreStatus = {
        workspaceId: this.options.workspaceId, initialized: snapshot.initialized, revision: snapshot.revision,
        pendingOperationIds: this.pendingRecords(sources).map((record) => record.operationId),
        provisionalTasks: snapshot.provisional, awaitingSync: snapshot.awaitingSync, blocked: snapshot.resolution.blocked,
        conflicts: Object.values(snapshot.resolution.entities).flatMap((entity) => entity.state === 'needs-resolution' || entity.state === 'blocked'
          ? [{ entityKey: entity.key, kind: entity.kind, state: entity.state, heads: entity.records.filter((record) => entity.heads.includes(record.operationId)) }] : []),
        diagnostics: snapshot.resolution.diagnostics,
      }
      return { value, changed: recovered, snapshot }
    })
  }

  /** Reconcile only against accepted Git records, never against an SSH-provided snapshot. */
  reconcileSynced(): Promise<RemoteConfigSnapshot> { return this.read() }

  private async ensureRevision(state: StoreState, expected: string | null): Promise<RemoteConfigSnapshot> {
    if (expected !== null) operationIdSchema.parse(expected)
    const current = await this.snapshot(state)
    if (current.revision !== expected) throw new RemoteConfigError('stale-revision', 'Session links changed on disk or in the provisional overlay. Reload the bindings and retry; no changes were written.')
    if (current.resolution.blocked) throw new RemoteConfigError('blocked-config', 'Remote configuration contains invalid or unauthorized operations. Resolve validation errors before writing.')
    return current
  }
  private async commitBatch(state: StoreState, operations: RemoteRecord[]): Promise<void> {
    if (operations.length) this.accessWatch.invalidate()
    for (const record of operations) {
      if (record.actor.deviceId !== this.options.actor.deviceId) throw new RemoteConfigError('wrong-actor', 'A local write must retain the local enrolled author.')
      await verifyRecord(record, this.options.trust)
    }
    state.localIds = [...new Set([...state.localIds, ...operations.map((record) => record.operationId)])].sort()
    const journal: Journal = { schemaVersion: 1, workspaceId: this.options.workspaceId, operations, state }
    await writeLocalState(this.options.stateDirectory, 'pending-operations.json', journal)
    try { await this.recoverJournal() } catch (error) {
      throw new RemoteConfigError('incomplete-write', `The signed operation batch is durable but publication is incomplete. Its original operations will be recovered on the next access. ${error instanceof Error ? error.message : ''}`)
    }
  }
  private async make<K extends RemoteRecordKind>(kind: K, payload: RemotePayloads[K], before: RemoteConfigSnapshot, metadata?: Pick<RecordInput<K>, 'nonce' | 'createdAt' | 'parents'>): Promise<RemoteRecord<K>> {
    const key = entityKey({ kind, payload })
    return createRecord({
      kind, payload, workspaceId: this.options.workspaceId, actor: this.options.actor,
      parents: [...before.resolution.heads[key] ?? []], ...metadata,
    } as unknown as RecordInput<K>, this.options.sign)
  }

  initialize(): Promise<RemoteConfigSnapshot> {
    return this.transaction(async (state, recovered) => {
      if (state.initialized) {
        const snapshot = await this.snapshot(state)
        return { value: snapshot, changed: recovered, snapshot }
      }
      const before = await this.snapshot(state)
      if (before.resolution.blocked) throw new RemoteConfigError('blocked-config', 'Immutable remote configuration must validate before initialization.')
      state.initialized = true
      await this.commitBatch(state, [])
      const snapshot = await this.snapshot(state)
      return { value: snapshot, changed: recovered, snapshot }
    })
  }

  update(expectedRevision: string | null, transform: (before: SessionLinksDocument) => SessionLinksDocument | Promise<SessionLinksDocument>, beforeWrite?: () => Promise<void>): Promise<RemoteConfigSnapshot> {
    return this.transaction(async (state, recovered) => {
      if (!state.initialized) throw new RemoteConfigError('initialization-required', 'Enable the immutable binding store before writing session bindings.')
      const before = await this.ensureRevision(state, expectedRevision)
      const document = sessionLinksDocumentSchema.parse(await transform(structuredClone(before.document)))
      const operations: RemoteRecord[] = []
      for (const taskId of [...new Set([...Object.keys(before.document.bindings), ...Object.keys(document.bindings)])].sort()) {
        const previous = taskSessionLinks(before.document.bindings, taskId)
        const targets = taskSessionLinks(document.bindings, taskId)
        if (canonicalJson(previous) === canonicalJson(targets)) continue
        assertNoOwnershipTransfer(previous, targets)
        operations.push(await this.make('binding', targets.length ? { schemaVersion: '2.1', action: 'set', taskId, targets } : { schemaVersion: '2.1', action: 'delete', taskId }, before))
      }
      if (!operations.length) return { value: before, changed: recovered, snapshot: before }
      await this.validateNew(before, operations)
      await this.ensureRevision(state, expectedRevision)
      if (beforeWrite) {
        await this.measure('configuration.transaction', 'validation', beforeWrite)
        await this.ensureRevision(state, expectedRevision)
        await this.measure('configuration.transaction', 'validation', beforeWrite)
      }
      await this.ensureRevision(state, expectedRevision)
      await this.commitBatch(state, operations)
      const snapshot = await this.snapshot(state)
      return { value: snapshot, changed: unionRecords(recovered, operations), snapshot }
    })
  }

  async writeBinding(taskId: string, targets: SessionLink | SessionLink[] | null, expectedRevision: string | null, beforeWrite?: () => Promise<void>): Promise<RemoteConfigSnapshot> {
    sessionLinkTaskIdSchema.parse(taskId)
    const selected = targets === null ? [] : z.array(sessionLinkSchema).min(1).max(1000).parse(Array.isArray(targets) ? targets : [targets])
    return this.transaction(async (state, recovered) => {
      if (!state.initialized) throw new RemoteConfigError('initialization-required', 'Enable the immutable binding store before writing session bindings.')
      const before = await this.ensureRevision(state, expectedRevision)
      const entity = before.resolution.entities[`binding:${taskId}`]
      const prior = taskSessionLinks(before.document.bindings, taskId)
      assertNoOwnershipTransfer(prior, selected)
      for (const target of selected) {
        const duplicate = sessionLinkEntries(before.document.bindings).find(([id, value]) => id !== taskId && sessionLinkKey(value) === sessionLinkKey(target))?.[0]
        if (duplicate) throw new RemoteConfigError('duplicate-session', `This session is already linked to ${duplicate}. Detach it there before moving it.`)
      }
      if ((selected.length && entity?.state === 'active' && canonicalJson(prior) === canonicalJson(selected)) || (!selected.length && entity?.state === 'deleted')) {
        return { value: before, changed: recovered, snapshot: before }
      }
      const record = await this.make('binding', selected.length ? { schemaVersion: '2.1', action: 'set', taskId, targets: selected } : { schemaVersion: '2.1', action: 'delete', taskId }, before)
      await this.validateNew(before, [record])
      await this.ensureRevision(state, expectedRevision)
      if (beforeWrite) {
        await this.measure('configuration.transaction', 'validation', beforeWrite)
        await this.ensureRevision(state, expectedRevision)
        await this.measure('configuration.transaction', 'validation', beforeWrite)
      }
      await this.ensureRevision(state, expectedRevision)
      await this.commitBatch(state, [record])
      const snapshot = await this.snapshot(state)
      return { value: snapshot, changed: unionRecords(recovered, [record]), snapshot }
    })
  }
  private async validateNew(before: RemoteConfigSnapshot, operations: RemoteRecord[]): Promise<void> {
    const durable = unionRecords(before.records, operations)
    for (const operation of operations) {
      if (operation.kind === 'binding' && before.awaitingSync.some((marker) => marker.taskId === operation.payload.taskId)) throw new RemoteConfigError('awaiting-sync', 'Synchronize or explicitly cancel the unresolved provisional binding before editing this task.')
      // A provisional parent must first arrive durably; do not promote a received SSH hint into Git authority.
      recordClosure(operation, durable, remoteConfigLimits.records)
    }
    const union = unionRecords(before.resolution.records, operations)
    const after = await resolveRecords(union, this.options.trust)
    const changed = new Set(operations.map(entityKey))
    const errors = after.diagnostics.filter((diagnostic) => !diagnostic.entityKey || changed.has(diagnostic.entityKey))
    if (after.blocked || errors.length) throw new RemoteConfigError('invalid-change', errors[0]?.message ?? 'The change would activate invalid or conflicting remote configuration.')
    for (const operation of operations) {
      if (operation.payload.action === 'publish' || operation.payload.action === 'grant' || operation.payload.action === 'set') {
        const entity = after.entities[entityKey(operation)]
        if (entity.state !== 'active') throw new RemoteConfigError('inactive-change', 'The new value is removed, revoked or expired. Explicit reenrollment or a new authorized grant is required; no operation was written.')
      }
    }
  }

  append<K extends RemoteRecordKind>(kind: K, payload: RemotePayloads[K], expectedRevision?: string | null, metadata?: Pick<RecordInput<K>, 'nonce' | 'createdAt' | 'parents'>): Promise<RemoteRecord<K>> {
    return this.transaction(async (state, recovered) => {
      if (!state.initialized && kind === 'binding') throw new RemoteConfigError('initialization-required', 'Enable the immutable binding store before publishing session bindings.')
      if (kind === 'device' && payload.action === 'publish' && !devicePublicationSchema.safeParse(payload).success) throw new RemoteConfigError('publication-metadata', 'New device publications require the existing public username and a scoped controlPort on every Dev Tunnel route.')
      const before = expectedRevision === undefined ? await this.snapshot(state) : await this.ensureRevision(state, expectedRevision)
      const record = await this.make(kind, payload, before, metadata)
      await this.validateNew(before, [record])
      if (expectedRevision !== undefined) await this.ensureRevision(state, expectedRevision)
      await this.commitBatch(state, [record])
      const snapshot = await this.snapshot(state)
      return { value: record, changed: unionRecords(recovered, [record]), snapshot }
    })
  }

  updateSettings(expectedRevision: string | null, changes: RemoteSettingChanges, scope: SettingScope = { scope: 'workspace' }): Promise<RemoteConfigSnapshot> {
    return this.transaction(async (state, recovered) => {
      const before = await this.ensureRevision(state, expectedRevision)
      const operations: RemoteRecord[] = []
      for (const key of Object.keys(changes).sort()) {
        if (!['autoLink', 'tunnelEnabled', 'connectTimeoutMs'].includes(key)) throw new RemoteConfigError('invalid-setting', 'Only typed remote settings may be edited.')
        const settingKey = key as keyof RemoteSettingChanges
        const value = changes[settingKey]
        if (value === undefined) throw new RemoteConfigError('invalid-setting', 'Use null to delete a setting; undefined is not a setting operation.')
        const payload = { ...scope, settingKey, ...(value === null ? { action: 'delete' } : { action: 'set', value }) } as SettingPayload
        const existing = before.resolution.entities[entityKey({ kind: 'setting', payload })]
        if (existing?.state === 'active' && existing.value && canonicalJson(existing.value.payload) === canonicalJson(payload)) continue
        if (value === null && (!existing || existing.state === 'deleted')) continue
        operations.push(await this.make('setting', payload, before))
      }
      await this.validateNew(before, operations)
      await this.ensureRevision(state, expectedRevision)
      if (operations.length) await this.commitBatch(state, operations)
      const snapshot = operations.length ? await this.snapshot(state) : before
      return { value: snapshot, changed: unionRecords(recovered, operations), snapshot }
    })
  }

  acceptNotification(notification: unknown, senderId: string): Promise<BindingNotificationAcknowledgement> {
    return this.transaction(async (state, recovered) => {
      if (!state.initialized || !this.options.overlay) throw new RemoteConfigError('overlay-disabled', 'This workspace has not enabled temporary binding notifications.')
      const { canonical } = await this.sources(state)
      const value = await this.options.overlay.accept(notification, senderId, canonical, this.options.trust)
      const snapshot = await this.snapshot(state)
      return { value, changed: recovered, snapshot }
    })
  }

  receiveOverlay(notification: unknown, senderId: string): Promise<BindingNotificationAcknowledgement> {
    return this.acceptNotification(notification, senderId)
  }

  async close(): Promise<void> {
    this.accessWatch.close()
    this.authorizationCache = undefined
    this.verifiedSnapshot = undefined
    this.generation++
    await this.pending
    this.closed = true
    this.listeners.clear()
    await this.options.overlay?.close()
  }
}
