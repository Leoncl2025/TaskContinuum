import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  chunkRequestSchema, exportManifestSchema, exportRequestSchema, FILE_TRANSFER_LIMITS as LIMITS,
  FileTransferError, transferLookupSchema,
} from '../shared/fileTransfer'
import type { ExportManifest, ExportRequest, TransferErrorCode, TransferFile } from '../shared/fileTransfer'
import { captureAgentHostDiagnostics } from './agentHostDiagnostics'

const STORAGE = 'file-transfer-exports'
const METADATA = 'manifest.json'
const PARTIAL_METADATA = 'manifest.partial.json'
const MAX_METADATA_BYTES = 32 * 1024
const LOG_RESERVATION = 6 * 1024 * 1024 + 4096
const EXPIRY_SWEEP_MS = 60 * 1000
const uuid = z.uuid()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const storedSchema = z.object({
  schemaVersion: z.literal(1), principalHash: digest, requestHash: digest, manifest: exportManifestSchema,
}).strict()
type StoredExport = z.infer<typeof storedSchema>
type Snapshot = StoredExport & { identities: Map<string, BigIntStats> }
type Checkpoint = () => Promise<void>

// Admission includes time spent authorizing and loading persisted state. No
// unbounded queue is created, including across source instances.
let concurrent = 0
const principals = new Set<string>()

const messages: Record<TransferErrorCode, string> = {
  INVALID_REQUEST: 'Invalid file transfer request.',
  ACCESS_DENIED: 'Access to this file transfer is denied.',
  NOT_FOUND: 'The file transfer or requested file is unavailable.',
  UNSUPPORTED: 'This file source is not supported.',
  BUSY: 'File transfer is busy. Try again after the current operation finishes.',
  QUOTA_EXCEEDED: 'The file transfer storage or selection limit was exceeded.',
  SOURCE_CHANGED: 'The source file changed during capture. Request a new export.',
  LOGS_DISABLED: 'Agent Host diagnostic logging is not enabled.',
  LOGS_MISSING: 'Agent Host diagnostic logs are missing or unavailable.',
  NO_RECORDS: 'No diagnostic records match the requested range.',
  EXPIRED: 'The file transfer has expired. Request a new export.',
  CANCELLED: 'File transfer was cancelled.',
  INTEGRITY_FAILED: 'The file transfer snapshot failed integrity validation.',
  IO_ERROR: 'File transfer could not access its data.',
  UNAVAILABLE: 'File transfer is unavailable.',
  NOT_TEXT: 'The requested file is not text.',
}
function failure(code: TransferErrorCode): FileTransferError { return new FileTransferError(code, messages[code]) }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}
function within(parent: string, child: string): boolean {
  const path = relative(process.platform === 'win32' ? parent.toLowerCase() : parent,
    process.platform === 'win32' ? child.toLowerCase() : child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}
function regular(info: BigIntStats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw failure('ACCESS_DENIED')
}
function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  // Windows can update change-time for metadata-only activity during a read.
  // Content identity, size and nanosecond modification time are always checked.
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && (process.platform === 'win32' || before.ctimeNs === after.ctimeNs) && after.nlink === 1n
    && after.isFile() && !after.isSymbolicLink()
}
function privatePermissions(info: BigIntStats): void {
  if (process.platform !== 'win32' && ((info.mode & 0o077n) !== 0n
    || (process.getuid && info.uid !== BigInt(process.getuid())))) throw failure('ACCESS_DENIED')
}
function sanitize(error: unknown): FileTransferError {
  if (error instanceof FileTransferError) return failure(error.code)
  if (error instanceof z.ZodError) return failure('INVALID_REQUEST')
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return failure('NOT_FOUND')
  if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') return failure('ACCESS_DENIED')
  if ((error as Error | undefined)?.name === 'AbortError') return failure('CANCELLED')
  return failure('IO_ERROR')
}
function localPath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || [...path].some((char) => char.charCodeAt(0) < 32)
    || /^[\\/]{2}/.test(path)) throw failure('ACCESS_DENIED')
  if (process.platform === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(path) || path.slice(2).includes(':')
      || path.slice(3).split(/[\\/]/).some((part) => /[. ]$/.test(part) || /[<>"|?*]/.test(part)
        || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) throw failure('ACCESS_DENIED')
  } else if (path.includes('\\') || path.includes(':')) throw failure('ACCESS_DENIED')
  return resolve(path)
}

async function safeAncestors(path: string): Promise<void> {
  const root = parse(path).root
  const parts = relative(root, path).split(sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw failure('ACCESS_DENIED')
  }
  if (!samePath(await realpath(path), path)) throw failure('ACCESS_DENIED')
}

async function readHandle(path: string, expected?: BigIntStats, privateFile = false): Promise<{ handle: FileHandle; info: BigIntStats }> {
  await safeAncestors(path)
  const before = await lstat(path, { bigint: true })
  regular(before)
  if (privateFile) privatePermissions(before)
  if (expected && !unchanged(expected, before)) throw failure('SOURCE_CHANGED')
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
  try {
    const info = await handle.stat({ bigint: true })
    regular(info)
    if (!unchanged(before, info)) throw failure('SOURCE_CHANGED')
    await safeAncestors(path)
    return { handle, info }
  } catch (error) { await handle.close(); throw error }
}

async function writeAll(handle: FileHandle, data: Buffer): Promise<void> {
  for (let offset = 0; offset < data.length;) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset)
    if (!bytesWritten) throw failure('IO_ERROR')
    offset += bytesWritten
  }
}

/** Owner-bound, resumable immutable snapshots. `directory` is the entire app userData directory. */
export class FileTransferSource {
  private readonly directory: string
  private readonly root: string
  private readonly exports = new Map<string, Snapshot>()
  private readonly reservations = new Map<string, { bytes: number; principalHash: string; requestHash: string }>()
  private readonly busyIds = new Map<string, number>()
  private readonly operations = new Set<Promise<void>>()
  private readonly shutdown = new AbortController()
  private readonly expiryTimer: NodeJS.Timeout
  private readonly removals = new Map<string, Promise<void>>()
  private ready?: Promise<void>
  private closing?: Promise<void>
  private sweep?: Promise<void>
  private expiry?: Promise<void>
  private closed = false

  constructor(directory: string, private readonly appVersion: string) {
    this.directory = resolve(directory)
    this.root = join(this.directory, STORAGE)
    this.expiryTimer = setInterval(() => { this.startSweep() }, EXPIRY_SWEEP_MS)
    this.expiryTimer.unref()
  }

  private async checkpoint(authorize: () => Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw failure('CANCELLED')
    let abort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => { reject(failure('CANCELLED')) }
      signal.addEventListener('abort', abort, { once: true })
    })
    try { await Promise.race([Promise.resolve().then(authorize), cancelled]) }
    catch { throw failure(signal.aborted ? 'CANCELLED' : 'ACCESS_DENIED') }
    finally { signal.removeEventListener('abort', abort) }
    if (signal.aborted) throw failure('CANCELLED')
  }

  private async operation<T>(
    principal: string, transferId: string, authorize: () => Promise<void>, signal: AbortSignal,
    action: (principalHash: string, check: Checkpoint, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw failure('UNAVAILABLE')
    if (typeof principal !== 'string' || !principal || principal.length > 4096) throw failure('ACCESS_DENIED')
    const principalHash = hash(principal)
    if (concurrent >= LIMITS.concurrent || principals.has(principalHash)) throw failure('BUSY')
    concurrent++
    principals.add(principalHash)
    this.busyIds.set(transferId, (this.busyIds.get(transferId) ?? 0) + 1)
    let done!: () => void
    const finished = new Promise<void>((resolve) => { done = resolve })
    this.operations.add(finished)
    const combined = AbortSignal.any([signal, this.shutdown.signal])
    const check = () => this.checkpoint(authorize, combined)
    try {
      await check()
      await (this.ready ??= this.initialize())
      await check()
      const result = await action(principalHash, check, combined)
      if (combined.aborted) throw failure('CANCELLED')
      return result
    } catch (error) { throw sanitize(error) }
    finally {
      concurrent--
      principals.delete(principalHash)
      const busy = (this.busyIds.get(transferId) ?? 1) - 1
      if (busy) this.busyIds.set(transferId, busy)
      else this.busyIds.delete(transferId)
      this.operations.delete(finished)
      done()
    }
  }

  private async safeDirectory(path: string): Promise<void> {
    await safeAncestors(path)
    const info = await lstat(path, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('ACCESS_DENIED')
    privatePermissions(info)
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await safeAncestors(this.directory)
    await mkdir(this.root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    await this.safeDirectory(this.root)
    for (const name of await readdir(this.root)) {
      if (!uuid.safeParse(name).success) continue
      const directory = join(this.root, name)
      await this.safeDirectory(directory)
      let stored: StoredExport
      try {
        const { handle, info } = await readHandle(join(directory, METADATA), undefined, true)
        try {
          if (info.size > BigInt(MAX_METADATA_BYTES)) throw failure('INTEGRITY_FAILED')
          const buffer = Buffer.alloc(Number(info.size))
          let offset = 0
          while (offset < buffer.length) {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
            if (!bytesRead) throw failure('INTEGRITY_FAILED')
            offset += bytesRead
          }
          stored = storedSchema.parse(JSON.parse(buffer.toString('utf8')))
          if (!unchanged(info, await handle.stat({ bigint: true }))) throw failure('INTEGRITY_FAILED')
        } finally { await handle.close() }
        const created = Date.parse(stored.manifest.createdAt)
        const expiry = Date.parse(stored.manifest.expiresAt)
        if (stored.manifest.transferId !== name || expiry - created > LIMITS.retentionMs || created > Date.now()) throw failure('INTEGRITY_FAILED')
        if (expiry <= Date.now()) { await this.removeDirectory(name); continue }
        const identities = new Map<string, BigIntStats>()
        for (const file of stored.manifest.files) {
          const { handle, info } = await readHandle(join(directory, `${file.fileId}.blob`), undefined, true)
          try {
            if (info.size !== BigInt(file.sizeBytes)) throw failure('INTEGRITY_FAILED')
            identities.set(file.fileId, info)
          } finally { await handle.close() }
        }
        const expected = new Set([METADATA, ...stored.manifest.files.map((file) => `${file.fileId}.blob`)])
        for (const artifact of await readdir(directory)) {
          if (expected.has(artifact)) continue
          if (artifact !== PARTIAL_METADATA && !(artifact.endsWith('.blob') && uuid.safeParse(artifact.slice(0, -5)).success)) {
            throw failure('INTEGRITY_FAILED')
          }
          await unlink(join(directory, artifact))
        }
        if (this.closed) return
        this.exports.set(name, { ...stored, identities })
      } catch {
        // Only our exact artifact names in a verified UUID directory are removed.
        await this.removeDirectory(name)
      }
    }
    if (this.exports.size > LIMITS.transfers || this.storageBytes() > LIMITS.storageBytes) throw failure('QUOTA_EXCEEDED')
  }

  private async removeDirectory(transferId: string): Promise<void> {
    uuid.parse(transferId)
    await this.safeDirectory(this.root)
    const directory = join(this.root, transferId)
    try { await this.safeDirectory(directory) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const name of await readdir(directory)) {
      if (name !== METADATA && name !== PARTIAL_METADATA && !(name.endsWith('.blob') && uuid.safeParse(name.slice(0, -5)).success)) {
        throw failure('INTEGRITY_FAILED')
      }
      await unlink(join(directory, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    }
    await rmdir(directory)
  }

  private startSweep(): void {
    if (this.closed || this.sweep) return
    this.sweep = (async () => {
      try {
        await (this.ready ??= this.initialize())
        if (!this.closed) await this.expire()
      } catch {
        console.error('File transfer export cleanup failed. Expired snapshots remain unavailable; check file permissions and storage.')
      } finally { this.sweep = undefined }
    })()
  }

  private expire(): Promise<void> {
    if (this.expiry) return this.expiry
    const expiry = this.removeExpired()
    this.expiry = expiry
    const complete = () => { this.expiry = undefined }
    void expiry.then(complete, complete)
    return expiry
  }

  private async removeExpired(): Promise<void> {
    for (const [id, stored] of this.exports) {
      if (this.closed) return
      if (Date.parse(stored.manifest.expiresAt) <= Date.now() && !this.busyIds.has(id)) {
        await this.removeExport(id)
      }
    }
  }

  private removeExport(id: string): Promise<void> {
    const existing = this.removals.get(id)
    if (existing) return existing
    const removal = this.removeDirectory(id).then(() => { this.exports.delete(id) })
    this.removals.set(id, removal)
    const complete = () => { this.removals.delete(id) }
    void removal.then(complete, complete)
    return removal
  }

  private storageBytes(): number {
    let total = 0
    for (const stored of this.exports.values()) total += stored.manifest.files.reduce((size, file) => size + file.sizeBytes, 0)
    for (const reservation of this.reservations.values()) total += reservation.bytes
    return total
  }

  private reserve(transferId: string, principalHash: string, requestHash: string, bytes: number): void {
    if (this.exports.has(transferId)) throw failure('ACCESS_DENIED')
    const existing = this.reservations.get(transferId)
    if (existing) throw failure(existing.principalHash === principalHash && existing.requestHash === requestHash ? 'BUSY' : 'ACCESS_DENIED')
    if (this.exports.size + this.reservations.size >= LIMITS.transfers || this.storageBytes() + bytes > LIMITS.storageBytes) {
      throw failure('QUOTA_EXCEEDED')
    }
    this.reservations.set(transferId, { principalHash, requestHash, bytes })
  }

  private async source(path: string): Promise<{ path: string; info: BigIntStats }> {
    const absolute = localPath(path)
    const components = absolute.toLowerCase().split(/[\\/]/)
    const discovery = process.env.TASKCONTINUUM_AGENT_HOST_DISCOVERY
    if (within(this.directory, absolute) || components.includes('.ssh')
      || (discovery && within(resolve(discovery), absolute))
      || components.some((part, index) => part === 'local-endpoint' && components[index + 1] === 'entries')) {
      throw failure('ACCESS_DENIED')
    }
    await safeAncestors(absolute)
    const info = await lstat(absolute, { bigint: true })
    regular(info)
    if (info.size > BigInt(LIMITS.fileBytes)) throw failure('QUOTA_EXCEEDED')
    return { path: absolute, info }
  }

  private async copy(
    path: string, expected: BigIntStats, destination: string, check: Checkpoint,
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const { handle: input, info } = await readHandle(path, expected)
    try {
      await this.safeDirectory(resolve(destination, '..'))
      const output = await open(destination, 'wx', 0o600)
      try {
        const sha = createHash('sha256')
        const buffer = Buffer.alloc(LIMITS.chunkBytes)
        const sizeBytes = Number(info.size)
        let offset = 0
        while (offset < sizeBytes) {
          await check()
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, sizeBytes - offset), offset)
          if (!bytesRead) throw failure('SOURCE_CHANGED')
          await check()
          const chunk = buffer.subarray(0, bytesRead)
          sha.update(chunk)
          await writeAll(output, chunk)
          offset += bytesRead
        }
        await check()
        await safeAncestors(path)
        if (!unchanged(info, await input.stat({ bigint: true })) || !unchanged(info, await lstat(path, { bigint: true }))) {
          throw failure('SOURCE_CHANGED')
        }
        await output.sync()
        return { sizeBytes, sha256: sha.digest('hex') }
      } finally { await output.close() }
    } finally { await input.close() }
  }

  private async writeBuffer(destination: string, buffer: Buffer, check: Checkpoint): Promise<void> {
    await this.safeDirectory(resolve(destination, '..'))
    const output = await open(destination, 'wx', 0o600)
    try {
      for (let offset = 0; offset < buffer.length; offset += LIMITS.chunkBytes) {
        await check()
        await writeAll(output, buffer.subarray(offset, offset + LIMITS.chunkBytes))
      }
      await output.sync()
    } finally { await output.close() }
  }

  async prepare(principal: string, request: ExportRequest, authorize: () => Promise<void>, signal: AbortSignal): Promise<ExportManifest> {
    return this.operation(principal, request?.transferId, authorize, signal, async (principalHash, check, combined) => {
      const parsed = exportRequestSchema.parse(request)
      const id = parsed.transferId
      const requestHash = hash(JSON.stringify(parsed.selection))
      const existing = this.exports.get(id)
      if (existing) {
        if (existing.principalHash !== principalHash) throw failure('ACCESS_DENIED')
        if (existing.requestHash !== requestHash) throw failure('INVALID_REQUEST')
        if (Date.parse(existing.manifest.expiresAt) <= Date.now()) {
          await this.removeExport(id)
          throw failure('EXPIRED')
        }
        await check()
        return structuredClone(existing.manifest)
      }
      await this.expire()
      const sources = parsed.selection.kind === 'files'
        ? await Promise.all(parsed.selection.paths.map((path) => this.source(path))) : []
      const bytes = sources.reduce((total, source) => total + Number(source.info.size), 0)
      if (bytes > LIMITS.batchBytes) throw failure('QUOTA_EXCEEDED')
      this.reserve(id, principalHash, requestHash, parsed.selection.kind === 'logs' ? LOG_RESERVATION : bytes)
      const directory = join(this.root, id)
      let created = false
      try {
        await check()
        await this.safeDirectory(this.root)
        await mkdir(directory, { mode: 0o700 })
        created = true
        const files: TransferFile[] = []
        if (parsed.selection.kind === 'files') {
          for (const source of sources) {
            await check()
            const fileId = randomUUID()
            const result = await this.copy(source.path, source.info, join(directory, `${fileId}.blob`), check)
            files.push({ fileId, name: basename(source.path), mediaType: 'application/octet-stream', ...result })
          }
        } else {
          await check()
          const captured = await captureAgentHostDiagnostics(this.directory, parsed.selection, combined)
          await check()
          const metadata = Buffer.from(JSON.stringify({
            schemaVersion: 1, appVersion: this.appVersion.slice(0, 128), capturedAt: captured.capturedAt,
            loggingEnabled: captured.loggingEnabled, truncated: captured.truncated, recordCount: captured.recordCount,
            sinceUtc: parsed.selection.sinceUtc, untilUtc: parsed.selection.untilUtc,
          }) + '\n')
          for (const [name, buffer, mediaType] of [
            ['agent-host.jsonl', captured.jsonl, 'application/x-ndjson'],
            ['export-metadata.json', metadata, 'application/json'],
          ] as const) {
            const fileId = randomUUID()
            await this.writeBuffer(join(directory, `${fileId}.blob`), buffer, check)
            files.push({ fileId, name, mediaType, sizeBytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') })
          }
        }
        const now = Date.now()
        const manifest = exportManifestSchema.parse({
          transferId: id, createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + LIMITS.retentionMs).toISOString(), files,
        })
        const stored: StoredExport = { schemaVersion: 1, principalHash, requestHash, manifest }
        const identities = new Map<string, BigIntStats>()
        for (const file of files) identities.set(file.fileId, await lstat(join(directory, `${file.fileId}.blob`), { bigint: true }))
        await this.writeBuffer(join(directory, PARTIAL_METADATA), Buffer.from(JSON.stringify(stored)), check)
        await check()
        await this.safeDirectory(directory)
        await rename(join(directory, PARTIAL_METADATA), join(directory, METADATA))
        await check()
        // No await may separate this check from publication: close can run
        // between the authorization promise settling and this continuation.
        if (this.closed || combined.aborted) throw failure('CANCELLED')
        this.exports.set(id, { ...stored, identities })
        this.reservations.delete(id)
        return structuredClone(manifest)
      } catch (error) {
        if (created) {
          try {
            await this.removeDirectory(id)
            this.reservations.delete(id)
          } catch {
            // Failed cleanup still occupies disk. Keep its reservation until
            // restart cleanup succeeds instead of silently freeing the quota.
          }
        }
        throw error
      } finally { if (!created) this.reservations.delete(id) }
    })
  }

  async chunk(
    principal: string, transferId: string, fileId: string, offset: number, authorize: () => Promise<void>, signal: AbortSignal,
  ): Promise<Buffer> {
    return this.operation(principal, transferId, authorize, signal, async (principalHash, check) => {
      chunkRequestSchema.parse({ transferId, fileId, offset })
      if (!Number.isSafeInteger(offset)) throw failure('INVALID_REQUEST')
      const stored = this.exports.get(transferId)
      if (!stored) throw failure('NOT_FOUND')
      if (stored.principalHash !== principalHash) throw failure('ACCESS_DENIED')
      if (Date.parse(stored.manifest.expiresAt) <= Date.now()) {
        await this.removeExport(transferId)
        throw failure('EXPIRED')
      }
      const file = stored.manifest.files.find((file) => file.fileId === fileId)
      if (!file) throw failure('NOT_FOUND')
      if (offset > file.sizeBytes) throw failure('INVALID_REQUEST')
      const path = join(this.root, transferId, `${fileId}.blob`)
      const { handle, info } = await readHandle(path, stored.identities.get(fileId), true)
      const buffer = Buffer.alloc(Math.min(LIMITS.chunkBytes, file.sizeBytes - offset))
      try {
        let read = 0
        while (read < buffer.length) {
          await check()
          const { bytesRead } = await handle.read(buffer, read, buffer.length - read, offset + read)
          if (!bytesRead) throw failure('INTEGRITY_FAILED')
          read += bytesRead
        }
        await safeAncestors(path)
        if (!unchanged(info, await handle.stat({ bigint: true })) || !unchanged(info, await lstat(path, { bigint: true }))) {
          throw failure('INTEGRITY_FAILED')
        }
      } finally { await handle.close() }
      await check()
      return buffer
    })
  }

  async release(principal: string, transferId: string, authorize: () => Promise<void>): Promise<void> {
    return this.operation(principal, transferId, authorize, new AbortController().signal, async (principalHash, check) => {
      transferLookupSchema.parse({ transferId })
      const stored = this.exports.get(transferId)
      if (!stored) { await check(); return }
      if (stored.principalHash !== principalHash) throw failure('ACCESS_DENIED')
      await check()
      await this.removeExport(transferId)
      await check()
    })
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true
      clearInterval(this.expiryTimer)
      this.shutdown.abort()
      this.closing = Promise.all([...this.operations, ...(this.sweep ? [this.sweep] : [])]).then(() => {})
    }
    return this.closing
  }
}
