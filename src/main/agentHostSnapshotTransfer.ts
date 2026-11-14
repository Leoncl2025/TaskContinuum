import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ActionEnvelope, ChatState, Snapshot } from '@microsoft/agent-host-protocol'
import type { AgentHostHistoryTransfer, AgentHostTarget } from '../shared/agentHost'
import type { AgentHostConnection } from './agentHostConnection'
import { AGENT_HOST_LIMITS, AgentHostSizeLimitError } from './agentHostLimits'
import { agentHostChatIdSchema, agentHostKey, agentHostTargetSchema } from './agentHostProtocol'
import { AgentHostChatState, AgentHostHistoryCursorError } from './agentHostState'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'

export const SNAPSHOT_TRANSFER_METHODS = {
  prepare: 'taskcontinuum/chatSnapshotPrepare',
  chunk: 'taskcontinuum/chatSnapshotChunk',
  activate: 'taskcontinuum/chatSnapshotActivate',
  release: 'taskcontinuum/chatSnapshotRelease',
  containsTurn: 'taskcontinuum/chatHistoryContainsTurn',
} as const

export const AGENT_HOST_SNAPSHOT_SUPERSEDED_RPC_CODE = -32051

export const SNAPSHOT_TRANSFER_LIMITS = {
  inlineBytes: 256 * 1024,
  minChunkBytes: 64 * 1024,
  initialChunkBytes: 256 * 1024,
  maxChunkBytes: 1024 * 1024,
  idleTtlMs: 15 * 60 * 1000,
  maxLifetimeMs: 2 * 60 * 60 * 1000,
  partRetentionMs: 24 * 60 * 60 * 1000,
  maxExportsPerTarget: 2,
  maxExportsGlobal: 32,
  maxLeasesPerExport: 32,
  maxTailEvents: 1024,
  maxTailBytes: 16 * 1024 * 1024,
  maxSupersedeRetries: 3,
} as const

export type SnapshotTransferLimits = {
  readonly [K in keyof typeof SNAPSHOT_TRANSFER_LIMITS]: number
}

export const chunkedSnapshotCapabilitySchema = z.object({
  version: z.literal(1),
  inlineBytes: z.number().int().positive().max(AGENT_HOST_LIMITS.requestBytes),
  minChunkBytes: z.number().int().positive().max(AGENT_HOST_LIMITS.requestBytes),
  maxChunkBytes: z.number().int().positive().max(AGENT_HOST_LIMITS.requestBytes),
}).strict()
export type ChunkedSnapshotCapability = z.infer<typeof chunkedSnapshotCapabilitySchema>

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
export const chatSnapshotCacheCapabilitySchema = z.object({ version: z.literal(1) }).strict()
export const pagedChatHistoryCapabilitySchema = z.object({ version: z.literal(1) }).strict()
export const snapshotHistoryRequestSchema = z.object({
  before: z.object({ epoch: z.uuid(), turnId: z.string().min(1).max(512) }).strict().optional(),
}).strict()
export type SnapshotHistoryRequest = z.infer<typeof snapshotHistoryRequestSchema>
export const snapshotHistoryPageSchema = z.object({
  epoch: z.uuid(),
  totalTurns: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  beforeTurnId: z.string().min(1).max(512).optional(),
}).strict()
export type SnapshotHistoryPage = z.infer<typeof snapshotHistoryPageSchema>

export const historyContainsTurnRequestSchema = z.object({
  channel: agentHostChatIdSchema,
  turnId: z.uuid(),
}).strict()
export const historyContainsTurnResponseSchema = z.object({ found: z.boolean(), epoch: z.uuid() }).strict()

export const snapshotPrepareRequestSchema = z.object({
  channel: agentHostChatIdSchema,
  subscribe: z.boolean(),
  history: snapshotHistoryRequestSchema.optional(),
  cachedStateSha256: sha256Schema.optional(),
  resumeTransferId: z.uuid().optional(),
  resumeLeaseId: z.uuid().optional(),
}).strict().refine((request) => !request.subscribe || !request.history?.before, {
  message: 'Earlier history pages cannot replace the live chat subscription.',
})
export type SnapshotPrepareRequest = z.infer<typeof snapshotPrepareRequestSchema>

export const snapshotChunkRequestSchema = z.object({
  channel: agentHostChatIdSchema,
  transferId: z.uuid(),
  leaseId: z.uuid().optional(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  length: z.number().int().positive().max(AGENT_HOST_LIMITS.requestBytes).optional(),
}).strict()
export type SnapshotChunkRequest = z.infer<typeof snapshotChunkRequestSchema>

export const snapshotTransferLookupSchema = z.object({
  channel: agentHostChatIdSchema,
  transferId: z.uuid(),
  leaseId: z.uuid().optional(),
}).strict()
export type SnapshotTransferLookup = z.infer<typeof snapshotTransferLookupSchema>

const prepareResponseSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('cached'),
    fromSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    stateSha256: sha256Schema,
    history: snapshotHistoryPageSchema.optional(),
  }).strict(),
  z.object({
    mode: z.literal('inline'),
    snapshot: z.object({
      resource: agentHostChatIdSchema,
      fromSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      state: z.unknown(),
    }).strict(),
    history: snapshotHistoryPageSchema.optional(),
  }).strict(),
  z.object({
    mode: z.literal('chunked'),
    transferId: z.uuid(),
    leaseId: z.uuid(),
    fromSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    totalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    chunkBytes: z.number().int().positive().max(AGENT_HOST_LIMITS.requestBytes),
    maxChunkBytes: z.number().int().positive().max(AGENT_HOST_LIMITS.requestBytes),
    sha256: sha256Schema,
    resumed: z.boolean(),
    history: snapshotHistoryPageSchema.optional(),
  }).strict(),
])
export type SnapshotPrepareResponse = z.infer<typeof prepareResponseSchema>

function snapshotStateSha256(snapshot: Snapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot.state), 'utf8').digest('hex')
}

const chunkResponseSchema = z.object({
  transferId: z.uuid(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nextOffset: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  totalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  data: z.string().min(4),
}).strict()
export type SnapshotChunkResponse = z.infer<typeof chunkResponseSchema>

const activateResponseSchema = z.object({
  fromSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

const partMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  target: agentHostTargetSchema,
  transferId: z.uuid(),
  leaseId: z.uuid().optional(),
  fromSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  totalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: sha256Schema,
  updatedAt: z.iso.datetime(),
}).strict()
type PartMetadata = z.infer<typeof partMetadataSchema>

const supersededDataSchema = z.object({
  code: z.literal('TC_AHP_SNAPSHOT_SUPERSEDED'),
}).strict()

export class AgentHostSnapshotSupersededError extends Error {
  constructor(message = 'The Agent Host chat snapshot changed during transfer. Restarting from the latest snapshot.') {
    super(message)
    this.name = 'AgentHostSnapshotSupersededError'
  }

  toData(): { code: 'TC_AHP_SNAPSHOT_SUPERSEDED' } {
    return { code: 'TC_AHP_SNAPSHOT_SUPERSEDED' }
  }
}

export function isAgentHostSnapshotSuperseded(error: unknown): boolean {
  for (let depth = 0; depth < 8 && error instanceof Error; depth++) {
    if (error instanceof AgentHostSnapshotSupersededError) return true
    if (error.name === 'RpcError' && 'code' in error && error.code === AGENT_HOST_SNAPSHOT_SUPERSEDED_RPC_CODE && 'data' in error) {
      if (supersededDataSchema.safeParse(error.data).success) return true
    }
    error = error.cause
  }
  return false
}

interface SnapshotLease {
  readonly leaseId: string
  owner: object | undefined
  readonly subscribe: boolean
  touchedAt: number
}

interface SnapshotExport {
  readonly transferId: string
  readonly targetKey: string
  readonly chatId: string
  readonly connection: AgentHostConnection
  readonly fromSeq: number
  readonly historyKey: string
  readonly history?: SnapshotHistoryPage
  readonly payload: Buffer
  readonly totalBytes: number
  readonly sha256: string
  readonly createdAt: number
  touchedAt: number
  superseded: boolean
  readonly leases: Map<string, SnapshotLease>
  tailEvents: ActionEnvelope[]
  tailBytes: number
  unlisten: () => void
}

export class AgentHostSnapshotStore {
  private readonly exports = new Map<string, SnapshotExport>()
  private readonly limits: SnapshotTransferLimits
  private readonly sweepTimer: ReturnType<typeof setInterval>
  private totalBytes = 0
  private closed = false

  constructor(limits?: Partial<SnapshotTransferLimits>) {
    this.limits = { ...SNAPSHOT_TRANSFER_LIMITS, ...limits }
    this.sweepTimer = setInterval(() => { this.sweep() }, Math.min(60_000, Math.max(1000, Math.floor(this.limits.idleTtlMs / 2))))
    this.sweepTimer.unref()
  }

  get exportCount(): number { return this.exports.size }
  get bufferedBytes(): number { return this.totalBytes }

  get capability(): ChunkedSnapshotCapability {
    return {
      version: 1,
      inlineBytes: this.limits.inlineBytes,
      minChunkBytes: this.limits.minChunkBytes,
      maxChunkBytes: this.limits.maxChunkBytes,
    }
  }

  private isLeaseExpired(lease: SnapshotLease, now: number): boolean {
    return now - lease.touchedAt > this.limits.idleTtlMs
  }

  private isExpired(record: SnapshotExport, now: number): boolean {
    return now - record.touchedAt > this.limits.idleTtlMs || now - record.createdAt > this.limits.maxLifetimeMs
  }

  private hasConnectedLease(record: SnapshotExport): boolean {
    for (const lease of record.leases.values()) {
      if (lease.owner !== undefined) return true
    }
    return false
  }

  private evict(transferId: string): void {
    const record = this.exports.get(transferId)
    if (!record) return
    this.exports.delete(transferId)
    this.totalBytes -= record.totalBytes
    record.leases.clear()
    record.tailEvents = []
    record.tailBytes = 0
    record.unlisten()
  }

  private acquireLease(
    record: SnapshotExport,
    owner: object | undefined,
    subscribe: boolean,
    now: number,
    resumeLeaseId?: string,
  ): string {
    if (resumeLeaseId) {
      const prior = record.leases.get(resumeLeaseId)
      if (prior) {
        prior.owner = owner
        prior.touchedAt = now
        record.touchedAt = now
        return prior.leaseId
      }
    }
    if (owner !== undefined) {
      for (const existing of record.leases.values()) {
        if (existing.owner === owner) {
          existing.touchedAt = now
          record.touchedAt = now
          return existing.leaseId
        }
      }
    }
    if (record.leases.size >= this.limits.maxLeasesPerExport) {
      for (const [id, lease] of record.leases) {
        if (lease.owner === undefined) { record.leases.delete(id); break }
      }
      if (record.leases.size >= this.limits.maxLeasesPerExport) {
        throw new Error('Agent Host snapshot export lease limit reached.')
      }
    }
    const leaseId = randomUUID()
    record.leases.set(leaseId, { leaseId, owner, subscribe, touchedAt: now })
    record.touchedAt = now
    return leaseId
  }

  private releaseOwnerTargetLeases(owner: object | undefined, targetKey: string, keepTransferId?: string, keepLeaseId?: string): void {
    if (owner === undefined) return
    for (const [id, record] of [...this.exports]) {
      if (record.targetKey !== targetKey) continue
      for (const [leaseId, lease] of [...record.leases]) {
        if (lease.owner === owner && !(id === keepTransferId && leaseId === keepLeaseId)) {
          record.leases.delete(leaseId)
        }
      }
      if (record.leases.size === 0) this.evict(id)
    }
  }

  private consumeLease(record: SnapshotExport, owner: object | undefined, leaseId?: string): void {
    if (leaseId !== undefined) {
      record.leases.delete(leaseId)
    } else if (owner !== undefined) {
      for (const [id, lease] of [...record.leases]) {
        if (lease.owner === owner) record.leases.delete(id)
      }
    } else if (record.leases.size === 1) {
      record.leases.clear()
    }
    if (record.leases.size === 0) this.evict(record.transferId)
  }

  disconnectOwner(owner: object): void {
    const now = Date.now()
    for (const [id, record] of [...this.exports]) {
      for (const [leaseId, lease] of [...record.leases]) {
        if (lease.owner !== owner) continue
        if (lease.subscribe) {
          lease.owner = undefined
          lease.touchedAt = now
        } else {
          record.leases.delete(leaseId)
        }
      }
      if (record.leases.size === 0) this.evict(id)
    }
  }

  releaseOwner(owner: object, channel?: string): void {
    for (const [id, record] of [...this.exports]) {
      if (channel !== undefined && record.chatId !== channel) continue
      for (const [leaseId, lease] of [...record.leases]) {
        if (lease.owner === owner) record.leases.delete(leaseId)
      }
      if (record.leases.size === 0) this.evict(id)
    }
  }

  sweep(now = Date.now()): void {
    for (const [id, record] of [...this.exports]) {
      if (record.superseded || record.connection.state !== 'connected' || this.isExpired(record, now)) {
        this.evict(id)
        continue
      }
      for (const [leaseId, lease] of [...record.leases]) {
        if (this.isLeaseExpired(lease, now)) record.leases.delete(leaseId)
      }
      if (record.leases.size === 0) this.evict(id)
    }
  }

  prepare(target: AgentHostTarget, connection: AgentHostConnection, request: SnapshotPrepareRequest, owner?: object): SnapshotPrepareResponse {
    if (this.closed) throw new Error('Agent Host session gateway is closed.')
    if (request.channel !== target.chatId || !connection.allowedChannel(request.channel)) {
      throw new Error('Channel not authorized.')
    }
    const now = Date.now()
    this.sweep(now)
    const targetKey = agentHostKey(target)
    const historyKey = request.history === undefined ? '' : JSON.stringify(request.history)
    if (request.history?.before && request.history.before.epoch !== connection.historyEpoch) {
      throw new AgentHostSnapshotSupersededError('The original history changed. Reload the recent conversation before paging again.')
    }

    if (request.subscribe && request.resumeTransferId) {
      const existing = this.exports.get(request.resumeTransferId)
      if (existing && existing.targetKey === targetKey && existing.connection === connection && existing.historyKey === historyKey
        && !existing.superseded && !this.isExpired(existing, now)) {
        const leaseId = this.acquireLease(existing, owner, request.subscribe, now, request.resumeLeaseId)
        this.releaseOwnerTargetLeases(owner, targetKey, existing.transferId, leaseId)
        return {
          mode: 'chunked',
          transferId: existing.transferId,
          leaseId,
          fromSeq: existing.fromSeq,
          totalBytes: existing.totalBytes,
          chunkBytes: Math.min(this.limits.initialChunkBytes, this.limits.maxChunkBytes),
          maxChunkBytes: this.limits.maxChunkBytes,
          sha256: existing.sha256,
          resumed: true,
          ...(existing.history ? { history: existing.history } : {}),
        }
      }
    }

    let page: ReturnType<AgentHostConnection['historySnapshot']> | undefined
    try { page = request.history ? connection.historySnapshot(request.history.before?.turnId) : undefined }
    catch (error) {
      if (error instanceof AgentHostHistoryCursorError) throw new AgentHostSnapshotSupersededError(error.message)
      throw error
    }
    const snapshot = page?.snapshot ?? connection.snapshot(target.chatId)
    const history: SnapshotHistoryPage | undefined = page ? {
      epoch: connection.historyEpoch, totalTurns: page.totalTurns,
      ...(page.beforeTurnId ? { beforeTurnId: page.beforeTurnId } : {}),
    } : undefined
    if (request.cachedStateSha256 && snapshotStateSha256(snapshot) === request.cachedStateSha256) {
      const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
      if (bytes > AGENT_HOST_LIMITS.messageBytes) throw new AgentHostSizeLimitError('message', AGENT_HOST_LIMITS.messageBytes, bytes)
      this.releaseOwnerTargetLeases(owner, targetKey)
      return {
        mode: 'cached', fromSeq: snapshot.fromSeq, stateSha256: request.cachedStateSha256,
        ...(history ? { history } : {}),
      }
    }
    for (const existing of this.exports.values()) {
      if (existing.targetKey === targetKey && existing.connection === connection && !existing.superseded
        && existing.fromSeq === snapshot.fromSeq && existing.historyKey === historyKey && !this.isExpired(existing, now)) {
        const leaseId = this.acquireLease(existing, owner, request.subscribe, now, request.resumeLeaseId)
        this.releaseOwnerTargetLeases(owner, targetKey, existing.transferId, leaseId)
        return {
          mode: 'chunked',
          transferId: existing.transferId,
          leaseId,
          fromSeq: existing.fromSeq,
          totalBytes: existing.totalBytes,
          chunkBytes: Math.min(this.limits.initialChunkBytes, this.limits.maxChunkBytes),
          maxChunkBytes: this.limits.maxChunkBytes,
          sha256: existing.sha256,
          resumed: existing.transferId === request.resumeTransferId,
          ...(existing.history ? { history: existing.history } : {}),
        }
      }
    }

    this.releaseOwnerTargetLeases(owner, targetKey)
    const payload = Buffer.from(JSON.stringify(snapshot), 'utf8')
    const totalBytes = payload.byteLength
    if (totalBytes > AGENT_HOST_LIMITS.messageBytes) {
      throw new AgentHostSizeLimitError('message', AGENT_HOST_LIMITS.messageBytes, totalBytes)
    }
    if (totalBytes <= this.limits.inlineBytes) {
      return { mode: 'inline', snapshot, ...(history ? { history } : {}) }
    }

    this.ensureCapacity(targetKey, totalBytes)
    const transferId = randomUUID()
    const sha256 = createHash('sha256').update(payload).digest('hex')
    const record: SnapshotExport = {
      transferId,
      targetKey,
      chatId: target.chatId,
      connection,
      fromSeq: snapshot.fromSeq,
      historyKey,
      history,
      payload,
      totalBytes,
      sha256,
      createdAt: now,
      touchedAt: now,
      superseded: false,
      leases: new Map(),
      tailEvents: [],
      tailBytes: 0,
      unlisten: () => {},
    }
    const leaseId = this.acquireLease(record, owner, request.subscribe, now)
    const supersede = () => {
      if (record.superseded) return
      record.superseded = true
      this.evict(transferId)
    }
    record.unlisten = connection.listen((event) => {
      if (record.superseded) return
      if (event.type === 'state') {
        if (connection.state !== 'connected') supersede()
        return
      }
      if (event.type === 'snapshot' && event.snapshot.resource === target.chatId) {
        supersede()
        return
      }
      if (event.type !== 'action' || event.envelope.channel !== target.chatId) return
      if (record.history && record.history.epoch !== connection.historyEpoch) { supersede(); return }
      if (record.history && event.envelope.action.type === 'chat/turnsLoaded') return
      if (event.envelope.serverSeq <= record.fromSeq) return
      const bytes = Buffer.byteLength(JSON.stringify(event.envelope))
      if (record.tailEvents.length >= this.limits.maxTailEvents || record.tailBytes + bytes > this.limits.maxTailBytes) {
        supersede()
        return
      }
      record.tailEvents.push(event.envelope)
      record.tailBytes += bytes
    })
    this.exports.set(transferId, record)
    this.totalBytes += totalBytes
    return {
      mode: 'chunked',
      transferId,
      leaseId,
      fromSeq: record.fromSeq,
      totalBytes,
      chunkBytes: Math.min(this.limits.initialChunkBytes, this.limits.maxChunkBytes),
      maxChunkBytes: this.limits.maxChunkBytes,
      sha256,
      resumed: false,
      ...(history ? { history } : {}),
    }
  }

  private ensureCapacity(targetKey: string, incomingBytes: number): void {
    for (const [id, record] of [...this.exports]) {
      if (record.leases.size === 0) this.evict(id)
    }
    const targetDisconnected = () => [...this.exports.values()]
      .filter((item) => item.targetKey === targetKey && !this.hasConnectedLease(item))
      .sort((left, right) => left.touchedAt - right.touchedAt)
    while ([...this.exports.values()].filter((item) => item.targetKey === targetKey).length >= this.limits.maxExportsPerTarget) {
      const candidate = targetDisconnected()[0]
      if (!candidate) break
      this.evict(candidate.transferId)
    }
    const globalDisconnected = () => [...this.exports.values()]
      .filter((item) => !this.hasConnectedLease(item))
      .sort((left, right) => left.touchedAt - right.touchedAt)
    while (this.exports.size >= this.limits.maxExportsGlobal
      || this.totalBytes + incomingBytes > AGENT_HOST_LIMITS.responseBufferGlobalBytes) {
      const candidate = globalDisconnected()[0]
      if (!candidate) break
      this.evict(candidate.transferId)
    }
    if (this.totalBytes + incomingBytes > AGENT_HOST_LIMITS.responseBufferGlobalBytes) {
      throw new AgentHostSizeLimitError('send-buffer', AGENT_HOST_LIMITS.responseBufferGlobalBytes, this.totalBytes + incomingBytes)
    }
    if (this.exports.size >= this.limits.maxExportsGlobal) {
      throw new Error('Agent Host snapshot export capacity is busy. Retry shortly.')
    }
  }

  private lookup(
    target: AgentHostTarget,
    connection: AgentHostConnection,
    channel: string,
    transferId: string,
    owner?: object,
    leaseId?: string,
  ): SnapshotExport {
    if (this.closed) throw new Error('Agent Host session gateway is closed.')
    if (channel !== target.chatId || !connection.allowedChannel(channel)) throw new Error('Channel not authorized.')
    const now = Date.now()
    const record = this.exports.get(transferId)
    if (!record || record.targetKey !== agentHostKey(target) || record.connection !== connection) {
      throw new AgentHostSnapshotSupersededError()
    }
    if (record.superseded || connection.state !== 'connected' || this.isExpired(record, now)) {
      this.evict(transferId)
      throw new AgentHostSnapshotSupersededError()
    }
    if (leaseId !== undefined) {
      const lease = record.leases.get(leaseId)
      if (!lease || this.isLeaseExpired(lease, now) || lease.owner !== undefined && owner !== undefined && lease.owner !== owner) {
        throw new AgentHostSnapshotSupersededError()
      }
      if (owner !== undefined) lease.owner = owner
      lease.touchedAt = now
    } else if (owner !== undefined) {
      for (const lease of record.leases.values()) {
        if (lease.owner === owner) lease.touchedAt = now
      }
    }
    record.touchedAt = now
    return record
  }

  chunk(target: AgentHostTarget, connection: AgentHostConnection, request: SnapshotChunkRequest, owner?: object): SnapshotChunkResponse {
    const record = this.lookup(target, connection, request.channel, request.transferId, owner, request.leaseId)
    if (request.offset >= record.totalBytes) throw new Error('Snapshot chunk offset exceeds snapshot size.')
    const length = Math.min(
      Math.max(1, request.length ?? this.limits.minChunkBytes),
      this.limits.maxChunkBytes,
      record.totalBytes - request.offset,
    )
    const slice = record.payload.subarray(request.offset, request.offset + length)
    return {
      transferId: record.transferId,
      offset: request.offset,
      nextOffset: request.offset + slice.byteLength,
      totalBytes: record.totalBytes,
      data: slice.toString('base64'),
    }
  }

  activate(target: AgentHostTarget, connection: AgentHostConnection, request: SnapshotTransferLookup, owner?: object): { fromSeq: number; tailEvents: ActionEnvelope[]; history?: SnapshotHistoryPage } {
    const record = this.lookup(target, connection, request.channel, request.transferId, owner, request.leaseId)
    const result = { fromSeq: record.fromSeq, tailEvents: [...record.tailEvents], ...(record.history ? { history: record.history } : {}) }
    this.consumeLease(record, owner, request.leaseId)
    return result
  }

  release(target: AgentHostTarget, connection: AgentHostConnection, request: SnapshotTransferLookup, owner?: object): void {
    if (request.channel !== target.chatId || !connection.allowedChannel(request.channel)) throw new Error('Channel not authorized.')
    const record = this.exports.get(request.transferId)
    if (!record || record.targetKey !== agentHostKey(target) || record.connection !== connection) return
    if (request.leaseId !== undefined) {
      const lease = record.leases.get(request.leaseId)
      if (!lease || lease.owner !== undefined && owner !== undefined && lease.owner !== owner) return
    }
    this.consumeLease(record, owner, request.leaseId)
  }

  close(): void {
    this.closed = true
    clearInterval(this.sweepTimer)
    for (const id of [...this.exports.keys()]) this.evict(id)
  }
}

function partPaths(baseFilePath: string): { partFile: string; metadataFile: string } {
  return {
    partFile: `${baseFilePath}.snapshot.part`,
    metadataFile: `${baseFilePath}.snapshot.part.json`,
  }
}

async function ensurePrivateRegularFile(path: string, maxBytes: number): Promise<{ size: number; dev: number; ino: number }> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) {
    throw new Error('Invalid partial Agent Host snapshot file.')
  }
  return { size: info.size, dev: info.dev, ino: info.ino }
}

export async function removePartialSnapshotFiles(baseFilePath: string): Promise<void> {
  const { partFile, metadataFile } = partPaths(baseFilePath)
  await Promise.all([
    rm(partFile, { force: true }).catch(() => undefined),
    rm(metadataFile, { force: true }).catch(() => undefined),
  ])
}

interface SavedPartState extends PartMetadata {
  sizeBytes: number
}

async function readSavedPart(baseFilePath: string, target: AgentHostTarget, retentionMs: number): Promise<SavedPartState | undefined> {
  const { partFile, metadataFile } = partPaths(baseFilePath)
  try {
    await ensurePrivateRegularFile(metadataFile, 64 * 1024)
    const metadata = partMetadataSchema.parse(await readJsonBounded(metadataFile, 64 * 1024))
    if (agentHostKey(metadata.target) !== agentHostKey(target)
      || metadata.totalBytes > AGENT_HOST_LIMITS.messageBytes
      || Date.now() - Date.parse(metadata.updatedAt) > retentionMs) {
      await removePartialSnapshotFiles(baseFilePath)
      return undefined
    }
    const partInfo = await ensurePrivateRegularFile(partFile, metadata.totalBytes)
    if (partInfo.size === 0) {
      await removePartialSnapshotFiles(baseFilePath)
      return undefined
    }
    return { ...metadata, sizeBytes: partInfo.size }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await removePartialSnapshotFiles(baseFilePath)
    return undefined
  }
}

async function openResumablePart(
  baseFilePath: string,
  target: AgentHostTarget,
  manifest: Extract<SnapshotPrepareResponse, { mode: 'chunked' }>,
  saved: SavedPartState | undefined,
): Promise<{ handle: FileHandle; hash: ReturnType<typeof createHash>; offset: number; resumed: boolean }> {
  const folder = dirname(baseFilePath)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const dirInfo = await lstat(folder)
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new Error('Agent Host cache directory is not private.')
  const { partFile, metadataFile } = partPaths(baseFilePath)
  const hash = createHash('sha256')
  const metadata: PartMetadata = {
    schemaVersion: 1,
    target,
    transferId: manifest.transferId,
    leaseId: manifest.leaseId,
    fromSeq: manifest.fromSeq,
    totalBytes: manifest.totalBytes,
    sha256: manifest.sha256,
    updatedAt: new Date().toISOString(),
  }

  if (saved && saved.totalBytes === manifest.totalBytes && saved.sha256 === manifest.sha256
    && saved.sizeBytes > 0 && saved.sizeBytes <= manifest.totalBytes) {
    const before = await ensurePrivateRegularFile(partFile, manifest.totalBytes)
    const handle = await open(partFile, 'r+')
    try {
      const current = await handle.stat()
      if (!current.isFile() || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino || current.size !== saved.sizeBytes) {
        throw new Error('Partial Agent Host snapshot file changed on disk.')
      }
      const scratch = Buffer.alloc(SNAPSHOT_TRANSFER_LIMITS.minChunkBytes)
      let offset = 0
      while (offset < saved.sizeBytes) {
        const { bytesRead } = await handle.read(scratch, 0, Math.min(scratch.byteLength, saved.sizeBytes - offset), offset)
        if (!bytesRead) throw new Error('Partial Agent Host snapshot could not be verified.')
        hash.update(scratch.subarray(0, bytesRead))
        offset += bytesRead
      }
      await writeJsonAtomic(metadataFile, metadata)
      return { handle, hash, offset: saved.sizeBytes, resumed: true }
    } catch (error) {
      await handle.close()
      await removePartialSnapshotFiles(baseFilePath)
      throw error
    }
  }

  await removePartialSnapshotFiles(baseFilePath)
  const created = await open(partFile, 'wx', 0o600)
  await created.close()
  const handle = await open(partFile, 'r+')
  try {
    await writeJsonAtomic(metadataFile, metadata)
    return { handle, hash, offset: 0, resumed: false }
  } catch (error) {
    await handle.close()
    await removePartialSnapshotFiles(baseFilePath)
    throw error
  }
}

async function readVerifiedSnapshotBuffer(handle: FileHandle, totalBytes: number): Promise<Buffer> {
  const result = Buffer.allocUnsafe(totalBytes)
  let offset = 0
  while (offset < totalBytes) {
    const { bytesRead } = await handle.read(result, offset, Math.min(16 * 1024 * 1024, totalBytes - offset), offset)
    if (!bytesRead) throw new Error('Verified Agent Host snapshot file ended unexpectedly.')
    offset += bytesRead
  }
  return result
}

function decodeBase64Chunk(encoded: string, expectedBytes: number): Buffer {
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('Invalid base64 chunk in Agent Host snapshot transfer.')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.byteLength !== expectedBytes) {
    throw new Error('Agent Host snapshot chunk length did not match its header.')
  }
  return bytes
}

export interface ReceiveChunkedSnapshotOptions {
  baseFilePath: string
  target: AgentHostTarget
  subscribe: boolean
  signal: AbortSignal
  capability: ChunkedSnapshotCapability
  history?: SnapshotHistoryRequest
  cachedSnapshot?: Snapshot
  cacheValidation?: boolean
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  onProgress?(progress: AgentHostHistoryTransfer | undefined): void
  onChunkSaved?(): void
  partRetentionMs?: number
}

function validateHistoryPage(snapshot: Snapshot, history: SnapshotHistoryPage | undefined, request: SnapshotHistoryRequest | undefined): void {
  if (Boolean(history) !== Boolean(request)) throw new Error('Agent Host returned a different history transfer mode.')
  if (!history) return
  const turns = (snapshot.state as ChatState).turns
  if (history.totalTurns !== undefined && history.totalTurns < turns.length || history.beforeTurnId && history.beforeTurnId !== turns[0]?.id
    || request?.before && turns.some((turn) => turn.id === request.before?.turnId)) {
    throw new Error('Agent Host returned an invalid history page boundary.')
  }
  if (request?.before && history.epoch !== request.before.epoch) throw new AgentHostSnapshotSupersededError()
}

export async function receiveChunkedChatSnapshot(options: ReceiveChunkedSnapshotOptions): Promise<{
  snapshot: Snapshot; history?: SnapshotHistoryPage; chunksTransferred: number; totalBytes: number; resumed: boolean; fromCache: boolean
}> {
  const retentionMs = options.partRetentionMs ?? SNAPSHOT_TRANSFER_LIMITS.partRetentionMs
  const cachedSnapshot = options.cachedSnapshot
  if (cachedSnapshot) new AgentHostChatState(options.target.chatId).snapshot(cachedSnapshot)
  const cachedStateSha256 = options.cacheValidation && cachedSnapshot ? snapshotStateSha256(cachedSnapshot) : undefined
  try {
    for (let attempt = 0; attempt < SNAPSHOT_TRANSFER_LIMITS.maxSupersedeRetries; attempt++) {
      options.signal.throwIfAborted()
      const saved = await readSavedPart(options.baseFilePath, options.target, retentionMs)
      try {
        const prepared = prepareResponseSchema.parse(await options.request(SNAPSHOT_TRANSFER_METHODS.prepare, {
          channel: options.target.chatId,
          subscribe: options.subscribe,
          ...(options.history ? { history: options.history } : {}),
          ...(cachedStateSha256 ? { cachedStateSha256 } : {}),
          ...(saved ? {
            resumeTransferId: saved.transferId,
            ...(saved.leaseId ? { resumeLeaseId: saved.leaseId } : {}),
          } : {}),
        }))
        options.signal.throwIfAborted()

        if (prepared.mode === 'cached') {
          if (!cachedSnapshot || cachedStateSha256 !== prepared.stateSha256) {
            throw new Error('Agent Host returned an unverified cached snapshot. Reconnect to restore history.')
          }
          const snapshot: Snapshot = { ...cachedSnapshot, fromSeq: prepared.fromSeq }
          validateHistoryPage(snapshot, prepared.history, options.history)
          await removePartialSnapshotFiles(options.baseFilePath)
          options.onProgress?.(undefined)
          return { snapshot, history: prepared.history, chunksTransferred: 0, totalBytes: 0, resumed: false, fromCache: true }
        }
        if (prepared.mode === 'inline') {
          await removePartialSnapshotFiles(options.baseFilePath)
          const snapshot = prepared.snapshot as Snapshot
          const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
          if (bytes > AGENT_HOST_LIMITS.messageBytes) throw new AgentHostSizeLimitError('message', AGENT_HOST_LIMITS.messageBytes, bytes)
          new AgentHostChatState(options.target.chatId).snapshot(snapshot)
          validateHistoryPage(snapshot, prepared.history, options.history)
          options.onProgress?.(undefined)
          return { snapshot, history: prepared.history, chunksTransferred: 0, totalBytes: bytes, resumed: false, fromCache: false }
        }

        const releaseRemoteLease = () => options.request(SNAPSHOT_TRANSFER_METHODS.release, {
          channel: options.target.chatId,
          transferId: prepared.transferId,
          leaseId: prepared.leaseId,
        }).catch(() => undefined)

        const completeTransfer = async () => {
          if (options.subscribe) {
            const activated = activateResponseSchema.parse(await options.request(SNAPSHOT_TRANSFER_METHODS.activate, {
              channel: options.target.chatId,
              transferId: prepared.transferId,
              leaseId: prepared.leaseId,
            }))
            if (activated.fromSeq !== prepared.fromSeq) throw new Error('Agent Host activated a different snapshot sequence.')
          } else await releaseRemoteLease()
        }

        if (prepared.totalBytes > AGENT_HOST_LIMITS.messageBytes) {
          await releaseRemoteLease()
          await removePartialSnapshotFiles(options.baseFilePath)
          throw new AgentHostSizeLimitError('message', AGENT_HOST_LIMITS.messageBytes, prepared.totalBytes)
        }

        if (cachedSnapshot) {
          const snapshot: Snapshot = { ...cachedSnapshot, fromSeq: prepared.fromSeq }
          const text = JSON.stringify(snapshot)
          if (Buffer.byteLength(text, 'utf8') === prepared.totalBytes
            && createHash('sha256').update(text, 'utf8').digest('hex') === prepared.sha256) {
            validateHistoryPage(snapshot, prepared.history, options.history)
            await completeTransfer()
            await removePartialSnapshotFiles(options.baseFilePath)
            options.onProgress?.(undefined)
            return { snapshot, history: prepared.history, chunksTransferred: 0, totalBytes: 0, resumed: false, fromCache: true }
          }
        }

        const { handle, hash, offset: initialOffset, resumed } = await openResumablePart(
          options.baseFilePath,
          options.target,
          prepared,
          saved,
        )
        let offset = initialOffset
        let chunksTransferred = 0
        let fullBuffer: Buffer
        const minChunkBytes = Math.min(options.capability.minChunkBytes, prepared.maxChunkBytes)
        let chunkBytes = Math.min(Math.max(1, prepared.chunkBytes), prepared.maxChunkBytes)
        let lastProgressAt = 0
        const reportProgress = (force = false) => {
          const now = performance.now()
          if (!force && now - lastProgressAt < 200) return
          lastProgressAt = now
          options.onProgress?.({
            receivedBytes: offset,
            totalBytes: prepared.totalBytes,
            ...(resumed ? { resumed: true } : {}),
          })
        }

        let steppedDownOnTimeout = false
        try {
          reportProgress(true)
          while (offset < prepared.totalBytes) {
            options.signal.throwIfAborted()
            const requested = Math.min(chunkBytes, prepared.totalBytes - offset)
            const started = performance.now()
            let rawResponse: unknown
            try {
              rawResponse = await options.request(SNAPSHOT_TRANSFER_METHODS.chunk, {
                channel: options.target.chatId,
                transferId: prepared.transferId,
                leaseId: prepared.leaseId,
                offset,
                length: requested,
              })
            } catch (chunkError) {
              if (!options.signal.aborted && !steppedDownOnTimeout && chunkBytes > minChunkBytes
                && chunkError instanceof Error && chunkError.name === 'RpcTimeoutError') {
                steppedDownOnTimeout = true
                chunkBytes = minChunkBytes
                continue
              }
              throw chunkError
            }
            const response = chunkResponseSchema.parse(rawResponse)
            steppedDownOnTimeout = false
            options.signal.throwIfAborted()
            const expectedBytes = response.nextOffset - offset
            if (response.transferId !== prepared.transferId || response.offset !== offset
              || response.totalBytes !== prepared.totalBytes || expectedBytes <= 0
              || expectedBytes > requested || response.nextOffset > prepared.totalBytes) {
              throw new Error('Agent Host returned an out-of-bounds snapshot chunk.')
            }
            const chunk = decodeBase64Chunk(response.data, expectedBytes)
            let written = 0
            try {
              while (written < chunk.byteLength) {
                const writeResult = await handle.write(chunk, written, chunk.byteLength - written, offset + written)
                if (!writeResult.bytesWritten) throw new Error('Could not write Agent Host snapshot chunk.')
                written += writeResult.bytesWritten
              }
            } catch (writeError) {
              await handle.truncate(offset).catch(() => undefined)
              throw writeError
            }
            hash.update(chunk)
            offset += chunk.byteLength
            chunksTransferred++
            options.onChunkSaved?.()
            const elapsedMs = performance.now() - started
            if (elapsedMs < 1000) chunkBytes = Math.min(prepared.maxChunkBytes, chunkBytes * 2)
            else if (elapsedMs > 4000) chunkBytes = Math.max(minChunkBytes, Math.floor(chunkBytes / 2))
            reportProgress(offset === prepared.totalBytes)
          }

          if (hash.digest('hex') !== prepared.sha256) {
            await handle.close()
            await releaseRemoteLease()
            await removePartialSnapshotFiles(options.baseFilePath)
            throw new Error('Agent Host chat snapshot checksum mismatch. No history was truncated and no message was replayed.')
          }
          fullBuffer = await readVerifiedSnapshotBuffer(handle, prepared.totalBytes)
        } finally {
          await handle.close().catch(() => undefined)
        }

        let text: string
        try { text = fullBuffer.toString('utf8') }
        catch (error) {
          await releaseRemoteLease()
          await removePartFilesSafe(options.baseFilePath)
          throw new Error('Agent Host text could not be decoded within runtime memory or string limits. No history was truncated and no message was replayed.', { cause: error })
        }

        let snapshot: Snapshot
        try {
          snapshot = JSON.parse(text) as Snapshot
          if (!snapshot || typeof snapshot !== 'object' || snapshot.resource !== options.target.chatId || snapshot.fromSeq !== prepared.fromSeq) {
            throw new Error('Agent Host returned a mismatched chunked chat snapshot.')
          }
          new AgentHostChatState(options.target.chatId).snapshot(snapshot)
          validateHistoryPage(snapshot, prepared.history, options.history)
        } catch (error) {
          await releaseRemoteLease()
          await removePartFilesSafe(options.baseFilePath)
          throw error
        }

        await completeTransfer()

        await removePartFilesSafe(options.baseFilePath)
        options.onProgress?.(undefined)
        return { snapshot, history: prepared.history, chunksTransferred, totalBytes: prepared.totalBytes, resumed, fromCache: false }
      } catch (error) {
        if (!options.history?.before && isAgentHostSnapshotSuperseded(error) && attempt + 1 < SNAPSHOT_TRANSFER_LIMITS.maxSupersedeRetries) {
          await removePartFilesSafe(options.baseFilePath)
          continue
        }
        throw error
      }
    }
    throw new Error('Agent Host chat snapshot changed repeatedly before transfer could complete. Retry the connection.')
  } finally {
    options.onProgress?.(undefined)
  }
}

async function removePartFilesSafe(baseFilePath: string): Promise<void> {
  await removePartialSnapshotFiles(baseFilePath)
}
