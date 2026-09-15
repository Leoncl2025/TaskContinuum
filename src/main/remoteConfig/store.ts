import { createHash } from 'node:crypto'
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import type { SessionLink, SessionLinksDocument, SessionLinksSnapshot } from '../../shared/sessionBindings'
import {
  remoteConfigLimits, type BindingNotificationAcknowledgement, type RemoteActor, type RemoteConfigSnapshot,
  type RemoteConfigStoreStatus, type RemotePayloads, type RemoteRecord, type RemoteRecordFile, type RemoteRecordKind,
  type RemoteSettingChanges, type RemoteSettingsSnapshot, type SettingPayload, type SettingScope,
} from '../../shared/remoteConfig'
import { readLegacyRepositorySessionLinks, type RepositorySessionLinksBackend } from '../repositorySessionLinks'
import { sessionLinkKey, sessionLinkSchema, sessionLinksDocumentSchema, sessionLinkTaskIdSchema } from '../sessionLinkSchema'
import { BindingOverlay } from './overlay'
import {
  appendRecord, canonicalJson, createRecord, devicePublicationSchema, entityKey, operationIdSchema, parseRecord,
  readCheckedFile, readRecords, recordClosure, recordPath, RemoteConfigError, resolvedSettings, resolveRecords, serializeRecord, unionRecords, verifyRecord, writeLocalState,
  type Awaitable, type RecordInput, type RecordSigner, type RecordTrust,
} from './records'

const stateSchema = z.object({
  schemaVersion: z.literal(1), workspaceId: z.uuid(), initialized: z.boolean(),
  legacyRevision: operationIdSchema.nullable(), legacyDocument: sessionLinksDocumentSchema,
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
  readLegacy?(): Promise<SessionLinksSnapshot>
  onLocalChange?: LocalChangeListener
  onChange?(): void
  onError?(error: unknown): void
}
interface TransactionResult<T> { value: T; changed: RemoteRecord[]; snapshot?: RemoteConfigSnapshot }
interface Journal { schemaVersion: 1; workspaceId: string; operations: RemoteRecord[]; state: StoreState }
interface RecordSources { canonical: RemoteRecord[]; outbox: RemoteRecord[] }

function sha(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex') }
export function legacyMigrationNonce(workspaceId: string, document: SessionLinksDocument, taskId: string): string {
  const seed = sha(['TaskCon.LegacyBindings.v1', workspaceId, document, taskId])
  return `${seed.slice(0, 8)}-${seed.slice(8, 12)}-5${seed.slice(13, 16)}-a${seed.slice(17, 20)}-${seed.slice(20, 32)}`
}

export class RemoteConfigStore implements RepositorySessionLinksBackend {
  private pending: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<LocalChangeListener>()
  private closed = false

  constructor(readonly options: RemoteConfigStoreOptions) {
    z.uuid().parse(options.workspaceId)
    z.uuid().parse(options.actor.deviceId)
    if (options.workspaceId !== options.trust.workspaceId) throw new RemoteConfigError('workspace-mismatch', 'The store and trust policy must pin the same workspace.')
    if (options.onLocalChange) this.listeners.add(options.onLocalChange)
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
  private async legacy(): Promise<SessionLinksSnapshot> {
    const result = this.options.readLegacy ? await this.options.readLegacy() : await readLegacyRepositorySessionLinks(this.options.workspaceRoot)
    return { ...result, document: sessionLinksDocumentSchema.parse(result.document) }
  }
  private async state(): Promise<StoreState> {
    const saved = await this.localJson('store.json', 2 * 1024 * 1024)
    if (saved !== undefined) {
      const state = stateSchema.parse(saved)
      if (state.workspaceId !== this.options.workspaceId) throw new RemoteConfigError('workspace-mismatch', 'Saved remote configuration belongs to another workspace. It was not reset.')
      return state
    }
    const legacy = await this.legacy()
    return { schemaVersion: 1, workspaceId: this.options.workspaceId, initialized: false, legacyRevision: legacy.revision, legacyDocument: legacy.document, canonicalIds: [], localIds: [] }
  }
  private trust(state: StoreState): RecordTrust {
    return {
      ...this.options.trust, allowLegacyBindings: true,
      authorize: async (record) => {
        if (record.kind === 'binding' && record.payload.action === 'set' && !record.payload.target.owner && !this.options.trust.allowLegacyBindings) {
          const baseline = state.legacyDocument.bindings[record.payload.taskId]
          if (!baseline || canonicalJson(baseline) !== canonicalJson(record.payload.target)
            || record.nonce !== legacyMigrationNonce(this.options.workspaceId, state.legacyDocument, record.payload.taskId)) return false
        }
        return this.options.trust.authorize(record)
      },
    }
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
  private async transaction<T>(action: (state: StoreState, recovered: RemoteRecord[]) => Promise<TransactionResult<T>>): Promise<T> {
    const operation = this.pending.then(async () => {
      if (this.closed) throw new RemoteConfigError('closed', 'The remote configuration store is closed.')
      await this.directory(this.options.stateDirectory)
      await this.directory(this.options.outboxRoot)
      for (const repository of [this.options.recordsRoot, this.options.workspaceRoot]) {
        const root = await realpath(repository)
        for (const local of [this.options.stateDirectory, this.options.outboxRoot]) {
          const child = relative(root, await realpath(local))
          if (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)) throw new RemoteConfigError('unsafe-path', 'Local state and the durable outbox must be outside both the Git replica and the user checkout.')
        }
      }
      const lockFile = join(this.options.stateDirectory, 'store.lock')
      let lock
      try { lock = await open(lockFile, 'wx', 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new RemoteConfigError('store-busy', 'Another process is using this configuration store. Retry after it finishes; remove a stale store.lock only after all app instances stop.')
        throw error
      }
      try {
        const recovered = await this.recoverJournal()
        return await action(await this.state(), recovered)
      } finally {
        await lock.close()
        await rm(lockFile, { force: true })
      }
    })
    this.pending = operation.then(() => undefined, () => undefined)
    const result = await operation
    if (result.changed.length) await this.notify(result.changed, result.snapshot ?? await this.read())
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
      await verifyRecord(record, this.trust(parsed.state))
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
    if (state.initialized) {
      const legacy = await this.legacy()
      if (legacy.revision !== state.legacyRevision) throw new RemoteConfigError('legacy-write', 'The archived session-bindings.json changed after remote configuration was enabled. Old-client writes are unsupported; restore the archive and use the effective store.')
    }
    return { canonical, outbox }
  }
  private async snapshot(state: StoreState, sources?: RecordSources): Promise<RemoteConfigSnapshot> {
    const { canonical, outbox } = sources ?? await this.sources(state)
    const records = unionRecords(canonical, outbox)
    const overlay = await this.options.overlay?.reconcile(canonical, this.trust(state))
    const resolution = await resolveRecords(unionRecords(records, overlay?.records ?? []), this.trust(state))
    const bindings = resolution.bindings
    for (const marker of overlay?.awaitingSync ?? []) {
      delete bindings[marker.taskId]
      const entity = resolution.entities[`binding:${marker.taskId}`]
      if (entity) entity.state = 'blocked'
      resolution.diagnostics.push({ code: 'awaiting-sync', message: 'A provisional binding expired or was recovered after restart. Await the exact canonical operation or explicitly cancel it.', entityKey: `binding:${marker.taskId}`, operationId: marker.operationId })
    }
    let document: SessionLinksDocument = { schemaVersion: 1, bindings }
    let revision: string | null = sha({ resolution: resolution.revision, canonical: canonical.map((record) => record.operationId), overlay: overlay?.revision ?? null, initialized: state.initialized })
    if (!state.initialized) {
      const legacy = await this.legacy()
      document = legacy.document
      revision = legacy.revision
    } else {
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
    })
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

  /** Reconcile only against the validated on-disk Git replica, never against an SSH-provided snapshot. */
  reconcileSynced(): Promise<RemoteConfigSnapshot> { return this.read() }

  private async ensureRevision(state: StoreState, expected: string | null): Promise<RemoteConfigSnapshot> {
    if (expected !== null) operationIdSchema.parse(expected)
    const current = await this.snapshot(state)
    if (current.revision !== expected) throw new RemoteConfigError('stale-revision', 'Session links changed on disk or in the provisional overlay. Reload the bindings and retry; no changes were written.')
    if (current.resolution.blocked) throw new RemoteConfigError('blocked-config', 'Remote configuration contains invalid or unauthorized operations. Resolve validation errors before writing.')
    return current
  }
  private async commitBatch(state: StoreState, operations: RemoteRecord[]): Promise<void> {
    for (const record of operations) {
      if (record.actor.deviceId !== this.options.actor.deviceId) throw new RemoteConfigError('wrong-actor', 'A local write must retain the local enrolled author.')
      await verifyRecord(record, this.trust(state))
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

  /** Explicit cutover only. Merely constructing/registering/reading the backend preserves legacy routing. */
  initialize(expectedLegacyRevision?: string | null): Promise<RemoteConfigSnapshot> {
    return this.transaction(async (state, recovered) => {
      if (state.initialized) {
        const snapshot = await this.snapshot(state)
        return { value: snapshot, changed: recovered, snapshot }
      }
      const baseline = await this.legacy()
      if (expectedLegacyRevision !== undefined && baseline.revision !== expectedLegacyRevision) throw new RemoteConfigError('stale-revision', 'The legacy migration preview changed. Reload it before initialization.')
      state.legacyDocument = baseline.document
      state.legacyRevision = baseline.revision
      const before = await this.snapshot(state)
      if (before.resolution.blocked) throw new RemoteConfigError('blocked-config', 'Remote configuration must validate before legacy migration.')
      const operations: RemoteRecord[] = []
      for (const [taskId, target] of Object.entries(baseline.document.bindings).sort(([left], [right]) => left < right ? -1 : 1)) {
        // Any retained history, including a tombstone, proves this task already entered the new authority.
        if (before.resolution.entities[`binding:${taskId}`]) continue
        operations.push(await this.make('binding', { action: 'set', taskId, target }, before, {
          nonce: legacyMigrationNonce(this.options.workspaceId, baseline.document, taskId),
          // Legacy creation time is unknown; the epoch sentinel keeps repeated imports byte-identical.
          createdAt: '1970-01-01T00:00:00.000Z', parents: [],
        }))
      }
      const candidate = await resolveRecords(unionRecords(before.records, operations), this.trust(state))
      if (candidate.blocked || candidate.diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-session')) throw new RemoteConfigError('migration-conflict', 'Legacy migration would introduce an invalid binding or duplicate session claim. The legacy baseline remains authoritative.')
      if ((await this.legacy()).revision !== baseline.revision) throw new RemoteConfigError('stale-revision', 'Legacy bindings changed during migration. No migration batch was written.')
      state.initialized = true
      await this.commitBatch(state, operations)
      const snapshot = await this.snapshot(state)
      return { value: snapshot, changed: unionRecords(recovered, operations), snapshot }
    })
  }

  update(expectedRevision: string | null, transform: (before: SessionLinksDocument) => SessionLinksDocument | Promise<SessionLinksDocument>, beforeWrite?: () => Promise<void>): Promise<RemoteConfigSnapshot> {
    return this.transaction(async (state, recovered) => {
      if (!state.initialized) throw new RemoteConfigError('initialization-required', 'Explicitly initialize or migrate this workspace before writing immutable bindings. Legacy bindings have not been replaced.')
      const before = await this.ensureRevision(state, expectedRevision)
      const document = sessionLinksDocumentSchema.parse(await transform(structuredClone(before.document)))
      const operations: RemoteRecord[] = []
      for (const taskId of [...new Set([...Object.keys(before.document.bindings), ...Object.keys(document.bindings)])].sort()) {
        const previous = before.document.bindings[taskId]
        const target = document.bindings[taskId]
        if (canonicalJson(previous ?? null) === canonicalJson(target ?? null)) continue
        if (target && target.provider !== 'agent-host') throw new RemoteConfigError('unsupported-provider', 'New enrolled bindings must use Agent Host. Existing migrated provider records remain readable.')
        if (previous?.owner && target && previous.provider === target.provider && previous.sessionId === target.sessionId && previous.owner.clientId !== target.owner?.clientId) throw new RemoteConfigError('ownership-transfer', 'Session ownership cannot be changed by linking.')
        operations.push(await this.make('binding', target ? { action: 'set', taskId, target } : { action: 'delete', taskId }, before))
      }
      if (!operations.length) return { value: before, changed: recovered, snapshot: before }
      await this.validateNew(state, before, operations)
      await this.ensureRevision(state, expectedRevision)
      if (beforeWrite) {
        await beforeWrite()
        await this.ensureRevision(state, expectedRevision)
        await beforeWrite()
      }
      await this.ensureRevision(state, expectedRevision)
      await this.commitBatch(state, operations)
      const snapshot = await this.snapshot(state)
      return { value: snapshot, changed: unionRecords(recovered, operations), snapshot }
    })
  }

  async writeBinding(taskId: string, target: SessionLink | null, expectedRevision: string | null, beforeWrite?: () => Promise<void>): Promise<RemoteConfigSnapshot> {
    sessionLinkTaskIdSchema.parse(taskId)
    const selected = target === null ? null : sessionLinkSchema.parse(target)
    if (selected && selected.provider !== 'agent-host') throw new RemoteConfigError('unsupported-provider', 'New enrolled bindings must use Agent Host. Existing migrated provider records remain readable.')
    return this.transaction(async (state, recovered) => {
      if (!state.initialized) throw new RemoteConfigError('initialization-required', 'Explicitly initialize the legacy baseline before writing binding operations.')
      const before = await this.ensureRevision(state, expectedRevision)
      const entity = before.resolution.entities[`binding:${taskId}`]
      const prior = before.document.bindings[taskId]
      if (selected && prior?.owner && prior.provider === selected.provider && prior.sessionId === selected.sessionId && prior.owner.clientId !== selected.owner?.clientId) throw new RemoteConfigError('ownership-transfer', 'Session ownership cannot be changed by linking.')
      if (selected) {
        const duplicate = Object.entries(before.document.bindings).find(([id, value]) => id !== taskId && sessionLinkKey(value) === sessionLinkKey(selected))?.[0]
        if (duplicate) throw new RemoteConfigError('duplicate-session', `This session is already linked to ${duplicate}. Detach it there before moving it.`)
      }
      if ((selected && entity?.state === 'active' && canonicalJson(prior ?? null) === canonicalJson(selected)) || (!selected && entity?.state === 'deleted')) {
        return { value: before, changed: recovered, snapshot: before }
      }
      const record = await this.make('binding', selected ? { action: 'set', taskId, target: selected } : { action: 'delete', taskId }, before)
      await this.validateNew(state, before, [record])
      await this.ensureRevision(state, expectedRevision)
      if (beforeWrite) {
        await beforeWrite()
        await this.ensureRevision(state, expectedRevision)
        await beforeWrite()
      }
      await this.ensureRevision(state, expectedRevision)
      await this.commitBatch(state, [record])
      const snapshot = await this.snapshot(state)
      return { value: snapshot, changed: unionRecords(recovered, [record]), snapshot }
    })
  }
  private async validateNew(state: StoreState, before: RemoteConfigSnapshot, operations: RemoteRecord[]): Promise<void> {
    const durable = unionRecords(before.records, operations)
    for (const operation of operations) {
      if (operation.kind === 'binding' && before.awaitingSync.some((marker) => marker.taskId === operation.payload.taskId)) throw new RemoteConfigError('awaiting-sync', 'Synchronize or explicitly cancel the unresolved provisional binding before editing this task.')
      // A provisional parent must first arrive durably; do not promote a received SSH hint into Git authority.
      recordClosure(operation, durable, remoteConfigLimits.records)
    }
    const union = unionRecords(before.resolution.records, operations)
    const after = await resolveRecords(union, this.trust(state))
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
      if (!state.initialized && kind === 'binding') throw new RemoteConfigError('initialization-required', 'Initialize the legacy binding baseline before publishing binding edits.')
      if (kind === 'binding' && 'target' in payload && payload.target.provider !== 'agent-host') throw new RemoteConfigError('unsupported-provider', 'New enrolled bindings must use Agent Host. Legacy records are only imported by explicit migration.')
      if (kind === 'device' && payload.action === 'publish' && !devicePublicationSchema.safeParse(payload).success) throw new RemoteConfigError('publication-metadata', 'New device publications require the existing public username and a scoped controlPort on every Dev Tunnel route.')
      const before = expectedRevision === undefined ? await this.snapshot(state) : await this.ensureRevision(state, expectedRevision)
      const record = await this.make(kind, payload, before, metadata)
      await this.validateNew(state, before, [record])
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
      await this.validateNew(state, before, operations)
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
      const value = await this.options.overlay.accept(notification, senderId, canonical, this.trust(state))
      const snapshot = await this.snapshot(state)
      return { value, changed: recovered, snapshot }
    })
  }

  receiveOverlay(notification: unknown, senderId: string): Promise<BindingNotificationAcknowledgement> {
    return this.acceptNotification(notification, senderId)
  }

  async close(): Promise<void> {
    await this.pending
    this.closed = true
    this.listeners.clear()
    await this.options.overlay?.close()
  }
}
