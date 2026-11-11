import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ActionEnvelope, Snapshot } from '@microsoft/agent-host-protocol'
import type { AgentHostHistoryTransfer, AgentHostTarget } from '../shared/agentHost'
import type { AgentHostConnection } from './agentHostConnection'
import { AGENT_HOST_LIMITS, AgentHostSizeLimitError } from './agentHostLimits'
import { agentHostChatIdSchema, agentHostKey, agentHostTargetSchema } from './agentHostProtocol'
import { AgentHostChatState } from './agentHostState'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'

export const SNAPSHOT_TRANSFER_METHODS = {
  prepare: 'taskcontinuum/chatSnapshotPrepare',
  chunk: 'taskcontinuum/chatSnapshotChunk',
  activate: 'taskcontinuum/chatSnapshotActivate',
  release: 'taskcontinuum/chatSnapshotRelease',
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
  maxExportsGlobal: 8,
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

export const snapshotPrepareRequestSchema = z.object({
  channel: agentHostChatIdSchema,
  subscribe: z.boolean(),
  resumeTransferId: z.uuid().optional(),
}).strict()
export type SnapshotPrepareRequest = z.infer<typeof snapshotPrepareRequestSchema>

export const snapshotChunkRequestSchema = z.object({
  channel: agentHostChatIdSchema,
  transferId: z.uuid(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  length: z.number().int().positive().max(AGENT_HOST_LIMITS.requestBytes).optional(),
}).strict()
export type SnapshotChunkRequest = z.infer<typeof snapshotChunkRequestSchema>

export const snapshotTransferLookupSchema = z.object({
  channel: agentHostChatIdSchema,
  transferId: z.uuid(),
}).strict()
export type SnapshotTransferLookup = z.infer<typeof snapshotTransferLookupSchema>

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

const prepareResponseSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('inline'),
    snapshot: z.object({
      resource: agentHostChatIdSchema,
      fromSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      state: z.unknown(),
    }).strict(),
  }).strict(),
  z.object({
    mode: z.literal('chunked'),
    transferId: z.uuid(),
    fromSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    totalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    chunkBytes: z.number().int().positive().max(AGENT_HOST_LIMITS.requestBytes),
    maxChunkBytes: z.number().int().positive().max(AGENT_HOST_LIMITS.requestBytes),
    sha256: sha256Schema,
    resumed: z.boolean(),
  }).strict(),
])
export type SnapshotPrepareResponse = z.infer<typeof prepareResponseSchema>

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

interface SnapshotExport {
  readonly transferId: string
  readonly targetKey: string
  readonly chatId: string
  readonly connection: AgentHostConnection
  readonly fromSeq: number
  readonly payload: Buffer
  readonly totalBytes: number
  readonly sha256: string
  readonly createdAt: number
  touchedAt: number
  superseded: boolean
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

  get capability(): ChunkedSnapshotCapability {
    return {
      version: 1,
      inlineBytes: this.limits.inlineBytes,
      minChunkBytes: this.limits.minChunkBytes,
      maxChunkBytes: this.limits.maxChunkBytes,
    }
  }

  private isExpired(record: SnapshotExport, now: number): boolean {
    return now - record.touchedAt > this.limits.idleTtlMs || now - record.createdAt > this.limits.maxLifetimeMs
  }

  private evict(transferId: string): void {
    const record = this.exports.get(transferId)
    if (!record) return
    this.exports.delete(transferId)
    this.totalBytes -= record.totalBytes
    record.tailEvents = []
    record.tailBytes = 0
    record.unlisten()
  }

  sweep(now = Date.now()): void {
    for (const [id, record] of this.exports) {
      if (record.superseded || record.connection.state !== 'connected' || this.isExpired(record, now)) {
        this.evict(id)
      }
    }
  }

  prepare(target: AgentHostTarget, connection: AgentHostConnection, request: SnapshotPrepareRequest): SnapshotPrepareResponse {
    if (this.closed) throw new Error('Agent Host session gateway is closed.')
    if (request.channel !== target.chatId || !connection.allowedChannel(request.channel)) {
      throw new Error('Channel not authorized.')
    }
    const now = Date.now()
    this.sweep(now)
    const targetKey = agentHostKey(target)

    if (request.subscribe && request.resumeTransferId) {
      const existing = this.exports.get(request.resumeTransferId)
      if (existing && existing.targetKey === targetKey && existing.connection === connection && !existing.superseded && !this.isExpired(existing, now)) {
        existing.touchedAt = now
        return {
          mode: 'chunked',
          transferId: existing.transferId,
          fromSeq: existing.fromSeq,
          totalBytes: existing.totalBytes,
          chunkBytes: Math.min(this.limits.initialChunkBytes, this.limits.maxChunkBytes),
          maxChunkBytes: this.limits.maxChunkBytes,
          sha256: existing.sha256,
          resumed: true,
        }
      }
    }

    const snapshot = connection.snapshot(target.chatId)
    for (const existing of this.exports.values()) {
      if (existing.targetKey === targetKey && existing.connection === connection && !existing.superseded
        && existing.fromSeq === snapshot.fromSeq && !this.isExpired(existing, now)) {
        existing.touchedAt = now
        return {
          mode: 'chunked',
          transferId: existing.transferId,
          fromSeq: existing.fromSeq,
          totalBytes: existing.totalBytes,
          chunkBytes: Math.min(this.limits.initialChunkBytes, this.limits.maxChunkBytes),
          maxChunkBytes: this.limits.maxChunkBytes,
          sha256: existing.sha256,
          resumed: existing.transferId === request.resumeTransferId,
        }
      }
    }

    const payload = Buffer.from(JSON.stringify(snapshot), 'utf8')
    const totalBytes = payload.byteLength
    if (totalBytes > AGENT_HOST_LIMITS.messageBytes) {
      throw new AgentHostSizeLimitError('message', AGENT_HOST_LIMITS.messageBytes, totalBytes)
    }
    if (totalBytes <= this.limits.inlineBytes) {
      return { mode: 'inline', snapshot }
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
      payload,
      totalBytes,
      sha256,
      createdAt: now,
      touchedAt: now,
      superseded: false,
      tailEvents: [],
      tailBytes: 0,
      unlisten: () => {},
    }
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
      fromSeq: record.fromSeq,
      totalBytes,
      chunkBytes: Math.min(this.limits.initialChunkBytes, this.limits.maxChunkBytes),
      maxChunkBytes: this.limits.maxChunkBytes,
      sha256,
      resumed: false,
    }
  }

  private ensureCapacity(targetKey: string, incomingBytes: number): void {
    const forTarget = [...this.exports.values()]
      .filter((item) => item.targetKey === targetKey)
      .sort((left, right) => left.touchedAt - right.touchedAt)
    while (forTarget.length >= this.limits.maxExportsPerTarget) {
      const oldest = forTarget.shift()!
      this.evict(oldest.transferId)
    }
    const byAge = () => [...this.exports.values()].sort((left, right) => left.touchedAt - right.touchedAt)
    while (this.exports.size >= this.limits.maxExportsGlobal
      || this.totalBytes + incomingBytes > AGENT_HOST_LIMITS.responseBufferGlobalBytes) {
      const oldest = byAge()[0]
      if (!oldest) break
      this.evict(oldest.transferId)
    }
    if (this.totalBytes + incomingBytes > AGENT_HOST_LIMITS.responseBufferGlobalBytes) {
      throw new AgentHostSizeLimitError('send-buffer', AGENT_HOST_LIMITS.responseBufferGlobalBytes, this.totalBytes + incomingBytes)
    }
  }

  private lookup(target: AgentHostTarget, connection: AgentHostConnection, channel: string, transferId: string): SnapshotExport {
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
    record.touchedAt = now
    return record
  }

  chunk(target: AgentHostTarget, connection: AgentHostConnection, request: SnapshotChunkRequest): SnapshotChunkResponse {
    const record = this.lookup(target, connection, request.channel, request.transferId)
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

  activate(target: AgentHostTarget, connection: AgentHostConnection, request: SnapshotTransferLookup): { fromSeq: number; tailEvents: ActionEnvelope[] } {
    const record = this.lookup(target, connection, request.channel, request.transferId)
    return { fromSeq: record.fromSeq, tailEvents: [...record.tailEvents] }
  }

  release(target: AgentHostTarget, connection: AgentHostConnection, request: SnapshotTransferLookup): void {
    if (request.channel !== target.chatId || !connection.allowedChannel(request.channel)) throw new Error('Channel not authorized.')
    const record = this.exports.get(request.transferId)
    if (record && record.targetKey === agentHostKey(target) && record.connection === connection && record.superseded) {
      this.evict(record.transferId)
    }
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
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  onProgress?(progress: AgentHostHistoryTransfer | undefined): void
  onChunkSaved?(): void
  partRetentionMs?: number
}

export async function receiveChunkedChatSnapshot(options: ReceiveChunkedSnapshotOptions): Promise<{ snapshot: Snapshot; chunksTransferred: number; totalBytes: number; resumed: boolean }> {
  const retentionMs = options.partRetentionMs ?? SNAPSHOT_TRANSFER_LIMITS.partRetentionMs
  try {
    for (let attempt = 0; attempt < SNAPSHOT_TRANSFER_LIMITS.maxSupersedeRetries; attempt++) {
      options.signal.throwIfAborted()
      const saved = await readSavedPart(options.baseFilePath, options.target, retentionMs)
      try {
        const prepared = prepareResponseSchema.parse(await options.request(SNAPSHOT_TRANSFER_METHODS.prepare, {
          channel: options.target.chatId,
          subscribe: options.subscribe,
          ...(saved ? { resumeTransferId: saved.transferId } : {}),
        }))

        if (prepared.mode === 'inline') {
          await removePartialSnapshotFiles(options.baseFilePath)
          const snapshot = prepared.snapshot as Snapshot
          const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
          if (bytes > AGENT_HOST_LIMITS.messageBytes) throw new AgentHostSizeLimitError('message', AGENT_HOST_LIMITS.messageBytes, bytes)
          new AgentHostChatState(options.target.chatId).snapshot(snapshot)
          options.onProgress?.(undefined)
          return { snapshot, chunksTransferred: 0, totalBytes: bytes, resumed: false }
        }

        if (prepared.totalBytes > AGENT_HOST_LIMITS.messageBytes) {
          await removePartialSnapshotFiles(options.baseFilePath)
          throw new AgentHostSizeLimitError('message', AGENT_HOST_LIMITS.messageBytes, prepared.totalBytes)
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
        } catch (error) {
          await removePartFilesSafe(options.baseFilePath)
          throw error
        }

        if (options.subscribe) {
          const activated = activateResponseSchema.parse(await options.request(SNAPSHOT_TRANSFER_METHODS.activate, {
            channel: options.target.chatId,
            transferId: prepared.transferId,
          }))
          if (activated.fromSeq !== prepared.fromSeq) {
            throw new Error('Agent Host activated a different snapshot sequence.')
          }
        } else {
          await options.request(SNAPSHOT_TRANSFER_METHODS.release, {
            channel: options.target.chatId,
            transferId: prepared.transferId,
          }).catch(() => undefined)
        }

        await removePartFilesSafe(options.baseFilePath)
        options.onProgress?.(undefined)
        return { snapshot, chunksTransferred, totalBytes: prepared.totalBytes, resumed }
      } catch (error) {
        if (isAgentHostSnapshotSuperseded(error) && attempt + 1 < SNAPSHOT_TRANSFER_LIMITS.maxSupersedeRetries) {
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
