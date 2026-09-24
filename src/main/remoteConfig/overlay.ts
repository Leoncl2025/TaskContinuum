import { createHash } from 'node:crypto'
import { dirname, basename } from 'node:path'
import { z } from 'zod'
import {
  remoteConfigLimits, type BindingChangedNotification, type BindingNotificationAcknowledgement,
  type PendingBindingMarker, type RemoteRecord,
} from '../../shared/remoteConfig'
import {
  canonicalJson, operationIdSchema, readCheckedFile, recordClosure, remoteRecordSchema,
  RemoteConfigError, resolveRecords, unionRecords, verifyRecord, writeLocalState,
  type Awaitable, type RecordTrust,
} from './records'

export const bindingChangedNotificationSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('binding.changed'), workspaceId: z.uuid(), recipientId: z.uuid(),
  operation: remoteRecordSchema.refine((record) => record.kind === 'binding', 'A binding operation is required.'),
  dependencies: z.array(remoteRecordSchema).max(remoteConfigLimits.notificationDependencies),
}).strict()
const markersSchema = z.object({
  schemaVersion: z.literal(1), workspaceId: z.uuid(),
  markers: z.array(z.object({ operationId: operationIdSchema, taskId: z.string().max(64).regex(/^T-\d{4,}$/) }).strict()).max(remoteConfigLimits.overlayOperations),
}).strict()

interface Entry { operation: RemoteRecord<'binding'>; dependencies: RemoteRecord[]; deadline: number }
export interface BindingOverlayState {
  records: RemoteRecord[]
  heads: string[]
  provisional: string[]
  awaitingSync: PendingBindingMarker[]
  revision: string
}
export interface BindingOverlayOptions {
  workspaceId: string
  recipientId: string
  trust: RecordTrust
  markerFile?: string
  /** Monotonic milliseconds; wall-clock changes must not renew provisional authorization. */
  now?: () => number
  lifetimeMs?: number
  requestSync?(): Awaitable<void>
  onChange?(): void
  onError?(error: unknown): void
}

export class BindingOverlay {
  private readonly entries = new Map<string, Entry>()
  private markers = new Map<string, PendingBindingMarker>()
  private pending: Promise<unknown> = Promise.resolve()
  private loaded = false
  private closed = false
  private timer?: ReturnType<typeof setTimeout>

  constructor(private readonly options: BindingOverlayOptions) {
    if (options.workspaceId !== options.trust.workspaceId) throw new RemoteConfigError('workspace-mismatch', 'Overlay and enrollment workspace identities differ.')
    if (options.lifetimeMs !== undefined && (!Number.isSafeInteger(options.lifetimeMs) || options.lifetimeMs < 1 || options.lifetimeMs > remoteConfigLimits.overlayLifetimeMs)) throw new RemoteConfigError('resource-limit', 'An overlay lifetime must be between 1 and 60,000 ms.')
  }

  private queue<T>(action: () => Promise<T>): Promise<T> {
    const work = this.pending.then(async () => {
      if (this.closed) throw new RemoteConfigError('closed', 'The binding overlay is closed.')
      await this.load()
      return action()
    })
    this.pending = work.then(() => undefined, () => undefined)
    return work
  }
  private now(): number { return this.options.now?.() ?? performance.now() }
  private requestSync(): void {
    if (this.options.requestSync) void Promise.resolve().then(this.options.requestSync).catch((error: unknown) => this.options.onError?.(error))
  }
  private async load(): Promise<void> {
    if (this.loaded) return
    if (this.options.markerFile) {
      const file = this.options.markerFile
      try {
        const saved = markersSchema.parse(JSON.parse((await readCheckedFile(dirname(file), file, 32768)).toString('utf8')))
        if (saved.workspaceId !== this.options.workspaceId) throw new RemoteConfigError('workspace-mismatch', 'Saved pending bindings belong to a different workspace.')
        this.markers = new Map(saved.markers.map((marker) => [marker.operationId, marker]))
        if (this.markers.size !== saved.markers.length) throw new RemoteConfigError('invalid-marker', 'Saved pending bindings contain duplicate operation IDs.')
        if (this.markers.size) this.requestSync()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    this.loaded = true
  }
  private async persist(markers = this.markers): Promise<void> {
    if (this.options.markerFile) await writeLocalState(dirname(this.options.markerFile), basename(this.options.markerFile), {
      schemaVersion: 1, workspaceId: this.options.workspaceId,
      markers: [...markers.values()].sort((left, right) => left.operationId < right.operationId ? -1 : 1),
    })
  }
  private expire(): boolean {
    let changed = false
    for (const [id, entry] of this.entries) if (entry.deadline <= this.now()) { this.entries.delete(id); changed = true }
    return changed
  }
  private schedule(): void {
    clearTimeout(this.timer)
    if (!this.entries.size || this.closed) return
    const next = Math.min(...[...this.entries.values()].map((entry) => entry.deadline))
    this.timer = setTimeout(() => {
      void this.queue(async () => {
        if (this.expire()) { this.options.onChange?.(); this.requestSync() }
        this.schedule()
      }).catch((error: unknown) => this.options.onError?.(error))
    }, Math.max(1, next - this.now()))
    this.timer.unref()
  }
  private state(): BindingOverlayState {
    const heads = [...this.entries.keys()].sort()
    const awaitingSync = [...this.markers.values()].filter((marker) => !this.entries.has(marker.operationId)).sort((left, right) => left.operationId < right.operationId ? -1 : 1)
    return {
      records: unionRecords(...[...this.entries.values()].map((entry) => [entry.operation, ...entry.dependencies])),
      heads, provisional: [...new Set([...this.entries.values()].map((entry) => entry.operation.payload.taskId))].sort(),
      awaitingSync,
      revision: createHash('sha256').update(canonicalJson({ heads, awaitingSync })).digest('hex'),
    }
  }
  private async reconcileCurrent(canonical: readonly RemoteRecord[], trust: RecordTrust): Promise<boolean> {
    this.expire()
    if (!this.markers.size) return false
    const resolution = await resolveRecords(canonical, trust)
    const synced = new Set(canonical.filter((record) => record.kind === 'binding'
      && resolution.entities[`binding:${record.payload.taskId}`]?.state !== 'blocked').map((record) => record.operationId))
    const retired = [...this.markers.keys()].filter((id) => synced.has(id))
    if (!retired.length) return false
    const next = new Map(this.markers)
    for (const id of retired) next.delete(id)
    await this.persist(next)
    for (const id of retired) this.entries.delete(id)
    this.markers = next
    return true
  }

  async reconcile(canonical: readonly RemoteRecord[], trust = this.options.trust): Promise<BindingOverlayState> {
    return this.queue(async () => {
      if (trust.workspaceId !== this.options.workspaceId) throw new RemoteConfigError('workspace-mismatch', 'Overlay reconciliation must use its enrolled workspace policy.')
      const before = this.state().revision
      await this.reconcileCurrent(canonical, trust)
      this.schedule()
      const state = this.state()
      if (before !== state.revision) this.options.onChange?.()
      return state
    })
  }

  authorizationRevision(): Promise<string> {
    return this.queue(async () => {
      if (this.expire()) { this.options.onChange?.(); this.requestSync(); this.schedule() }
      return this.state().revision
    })
  }

  currentAuthorizationRevision(): string | undefined {
    if (!this.loaded || this.closed) return undefined
    if (this.expire()) { this.options.onChange?.(); this.requestSync(); this.schedule() }
    return this.state().revision
  }

  async accept(input: unknown, senderId: string, canonical: readonly RemoteRecord[], trust = this.options.trust): Promise<BindingNotificationAcknowledgement> {
    return this.queue(async () => {
      let operationId = ''
      const response = (result: BindingNotificationAcknowledgement['result'], reason?: string): BindingNotificationAcknowledgement => ({
        workspaceId: this.options.workspaceId, operationId, result, ...(reason ? { reason } : {}),
      })
      try {
        if (trust.workspaceId !== this.options.workspaceId) throw new RemoteConfigError('workspace-mismatch', 'Overlay receipt must use its enrolled workspace policy.')
        if (Buffer.byteLength(canonicalJson(input)) > remoteConfigLimits.notificationBytes) throw new RemoteConfigError('resource-limit', 'The decoded binding notification exceeds 256 KiB.')
        const notification = bindingChangedNotificationSchema.parse(input) as BindingChangedNotification
        if (canonicalJson(notification) !== canonicalJson(input)) throw new RemoteConfigError('noncanonical-record', 'A signed notification must not require schema normalization.')
        const operation = notification.operation
        operationId = operation.operationId
        if (notification.workspaceId !== this.options.workspaceId || notification.recipientId !== this.options.recipientId) throw new RemoteConfigError('wrong-recipient', 'The notification does not match this enrolled workspace and recipient.')
        if (senderId !== operation.actor.deviceId) throw new RemoteConfigError('wrong-actor', 'Only the authenticated operation author may deliver a binding notification.')
        await verifyRecord(operation, trust)
        for (const dependency of notification.dependencies) await verifyRecord(dependency, trust)
        const available = unionRecords(canonical, this.state().records, notification.dependencies, [operation])
        const closure = recordClosure(operation, available)
        const needed = new Set(closure.map((record) => record.operationId))
        if (notification.dependencies.some((record) => !needed.has(record.operationId))) throw new RemoteConfigError('unrelated-dependency', 'The notification includes records outside this operation dependency closure.')
        await this.reconcileCurrent(canonical, trust)
        const canonicalResolution = await resolveRecords(canonical, trust)
        const canonicalEntity = canonicalResolution.entities[`binding:${operation.payload.taskId}`]
        if (canonical.some((record) => record.operationId === operationId) && canonicalEntity?.state !== 'blocked') return response(canonicalEntity?.state === 'needs-resolution' ? 'conflict' : 'already-synced')
        const current = this.markers.get(operationId)
        if (current && !this.entries.has(operationId)) { this.requestSync(); return response('awaiting-sync', 'The provisional authorization expired or was recovered after restart. Await the exact Git operation.') }
        if ([...this.markers.values()].some((marker) => marker.taskId === operation.payload.taskId && !this.entries.has(marker.operationId))) {
          this.requestSync()
          return response('awaiting-sync', 'An earlier provisional binding on this task still requires canonical reconciliation or explicit cancellation.')
        }
        const resolution = await resolveRecords(available, trust)
        const entity = resolution.entities[`binding:${operation.payload.taskId}`]
        if (!entity || entity.state === 'blocked') throw new RemoteConfigError('invalid-dependency', 'The binding or its dependency closure is blocked by validation or current trust.')
        if (!current) {
          if (this.markers.size >= remoteConfigLimits.overlayOperations) throw new RemoteConfigError('resource-limit', 'The temporary binding overlay is full. Synchronize or cancel unresolved operations.')
          const bytes = Buffer.byteLength(canonicalJson(unionRecords(this.state().records, closure, [operation])))
          if (bytes > remoteConfigLimits.overlayBytes) throw new RemoteConfigError('resource-limit', 'The temporary binding overlay exceeds 1 MiB.')
          const next = new Map(this.markers)
          next.set(operationId, { operationId, taskId: operation.payload.taskId })
          await this.persist(next)
          this.markers = next
          this.entries.set(operationId, { operation, dependencies: closure, deadline: this.now() + (this.options.lifetimeMs ?? remoteConfigLimits.overlayLifetimeMs) })
          this.options.onChange?.()
        }
        this.schedule()
        this.requestSync()
        return response(entity.state === 'needs-resolution' ? 'conflict' : 'provisional')
      } catch (error) {
        if (error instanceof RemoteConfigError && (error.code === 'missing-dependency' || error.code === 'resource-limit')) {
          this.requestSync()
          return response('awaiting-sync', error.message)
        }
        return response('rejected', error instanceof RemoteConfigError ? error.message : 'The binding notification failed strict validation.')
      }
    })
  }

  cancel(operationId: string): Promise<void> {
    operationIdSchema.parse(operationId)
    return this.queue(async () => {
      const next = new Map(this.markers)
      if (!next.delete(operationId)) return
      await this.persist(next)
      this.markers = next
      this.entries.delete(operationId)
      this.schedule()
      this.options.onChange?.()
    })
  }

  async close(): Promise<void> {
    await this.pending
    this.closed = true
    clearTimeout(this.timer)
    this.entries.clear()
  }
}
