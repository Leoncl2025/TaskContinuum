import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  exportManifestSchema, fetchRequestSchema, FILE_TRANSFER_LIMITS, FileTransferError,
  readFileRequestSchema, transferFailure, transferStatusSchema,
} from '../shared/fileTransfer'
import type { ExportManifest, FetchRequest, FilePage, FileTransferApi, ReadFileRequest, TransferStatus } from '../shared/fileTransfer'
import type { FileTransferSource } from './fileTransferSource'
import type { VSCodeDeviceClient } from './vscodeDeviceClient'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import { FileTransferBudget } from './fileTransferBudget'

const savedSchema = z.object({
  schemaVersion: z.literal(1), root: z.string(), request: fetchRequestSchema,
  status: transferStatusSchema, manifest: exportManifestSchema.optional(),
}).strict()
type Saved = z.infer<typeof savedSchema>
type Active = { abort: AbortController; done: Promise<void> }

export class FileTransferService {
  private readonly directory: string
  private readonly records = new Map<string, Saved>()
  private readonly active = new Map<string, Active>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly busy = new Set<string>()
  private readonly slots = new Map<string, () => void>()
  private loading?: Promise<void>
  private expiring?: Promise<void>
  private admission: Promise<void> = Promise.resolve()
  private closed = false
  private readonly shutdown = new AbortController()
  private readonly cleanupTimer: ReturnType<typeof setInterval>

  constructor(directory: string, private readonly source: Pick<FileTransferSource, 'prepare' | 'chunk' | 'release'>,
    private readonly devices: Pick<VSCodeDeviceClient, 'fileDevices' | 'fileRequest' | 'fileDeviceKey'>, private readonly budget = new FileTransferBudget()) {
    this.directory = join(directory, 'file-transfer-inbox')
    this.cleanupTimer = setInterval(() => { void this.serialized(() => this.expire()).catch(() => console.error('File transfer inbox expiry failed.')) }, 60_000)
    this.cleanupTimer.unref()
  }

  forWorkspace(root: string): FileTransferApi {
    const canonical = async () => {
      const value = await realpath(root)
      return process.platform === 'win32' ? value.toLowerCase() : value
    }
    return {
      devices: async () => [
        { deviceId: 'local', machineName: hostname(), state: 'connected', enabled: true, fileTransfer: 'available' },
        ...await this.devices.fileDevices(await canonical()),
      ],
      fetch: async (request) => this.fetch(await canonical(), fetchRequestSchema.parse(request)),
      status: async (id) => this.status(await canonical(), z.uuid().parse(id)),
      resume: async (id) => this.resume(await canonical(), z.uuid().parse(id)),
      cancel: async (id) => this.cancel(await canonical(), z.uuid().parse(id)),
      read: async (request) => this.read(await canonical(), readFileRequestSchema.parse(request)),
    }
  }

  private async initialize(): Promise<void> {
    this.loading ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const directory = await lstat(this.directory)
      if (!directory.isDirectory() || directory.isSymbolicLink() || process.platform !== 'win32' && (directory.mode & 0o077)) throw new FileTransferError('ACCESS_DENIED', 'The file inbox is not private.')
      for (const item of await readdir(this.directory, { withFileTypes: true })) {
        if (!z.uuid().safeParse(item.name).success) continue
        if (!item.isDirectory() || item.isSymbolicLink()) throw new FileTransferError('ACCESS_DENIED', 'Invalid file transfer storage.')
        const folder = join(this.directory, item.name)
        const metadata = join(folder, 'transfer.json')
        await this.removeTemporaryMetadata(folder)
        try { await this.privateFile(metadata, 128 * 1024) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          if ((await readdir(folder)).length) throw new FileTransferError('INTEGRITY_FAILED', 'File transfer metadata is missing for stored data.')
          await rmdir(folder)
          continue
        }
        const record = savedSchema.parse(await readJsonBounded(metadata, 128 * 1024))
        if (record.request.requestId !== item.name || record.status.transferId !== item.name || record.status.deviceId !== record.request.deviceId
          || record.manifest && (record.manifest.transferId !== item.name || JSON.stringify(record.manifest.files) !== JSON.stringify(record.status.files))) throw new FileTransferError('INTEGRITY_FAILED', 'The saved file transfer identity changed.')
        if (record.status.state === 'transferring') {
          record.status.state = 'interrupted'
          record.status.error = { code: 'UNAVAILABLE', message: 'The application restarted during transfer. Resume this transfer explicitly.' }
        }
        if (this.records.size >= FILE_TRANSFER_LIMITS.transfers) throw new FileTransferError('QUOTA_EXCEEDED', 'The saved file transfer count exceeds its limit.')
        this.records.set(item.name, record)
      }
    })()
    await this.loading
    if (this.closed) throw new FileTransferError('UNAVAILABLE', 'File transfer service is closed.')
  }

  private async removeTemporaryMetadata(folder: string): Promise<void> {
    for (const name of await readdir(folder)) {
      const temporary = /^transfer\.json\.([a-f0-9-]+)\.tmp$/i.exec(name)
      if (!temporary || !z.uuid().safeParse(temporary[1]).success) continue
      const file = join(folder, name)
      await this.privateFile(file, 128 * 1024)
      await rm(file)
    }
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.admission.then(action)
    this.admission = operation.then(() => {}, () => {})
    return operation
  }

  private save(record: Saved): Promise<void> {
    const id = record.status.transferId
    const copy = structuredClone(record)
    const operation = (this.writes.get(id) ?? Promise.resolve()).then(() => writeJsonAtomic(join(this.directory, id, 'transfer.json'), copy))
    this.writes.set(id, operation.then(() => {}, () => {}))
    return operation
  }

  private record(root: string, id: string): Saved {
    const record = this.records.get(id)
    if (!record || record.root !== root) throw new FileTransferError('NOT_FOUND', 'File transfer not found in this workspace.')
    return record
  }

  private checkState(record: Saved): void {
    if (this.closed) throw new FileTransferError('UNAVAILABLE', 'File transfer service is closed.')
    if (record.status.state === 'cancelled') throw new FileTransferError('CANCELLED', 'File transfer was cancelled.')
    if (Date.parse(record.status.expiresAt) <= Date.now()) throw new FileTransferError('EXPIRED', 'File transfer has expired.')
  }

  private async check(record: Saved, signal = new AbortController().signal): Promise<void> {
    const cancellation = AbortSignal.any([signal, this.shutdown.signal])
    cancellation.throwIfAborted()
    this.checkState(record)
    if (record.request.deviceId !== 'local') {
      await this.devices.fileRequest(record.root, record.request.deviceId, 'capabilities', {}, cancellation)
    }
    cancellation.throwIfAborted()
    this.checkState(record)
  }

  private async fetch(root: string, request: FetchRequest): Promise<TransferStatus> {
    return this.serialized(async () => {
      await this.initialize()
      await this.expire()
      const existing = this.records.get(request.requestId)
      if (existing) {
        if (existing.root !== root || JSON.stringify(existing.request) !== JSON.stringify(request)) throw new FileTransferError('INVALID_REQUEST', 'This request ID belongs to a different file selection or workspace.')
        await this.check(existing)
        return structuredClone(existing.status)
      }
      if (this.records.size >= FILE_TRANSFER_LIMITS.transfers) throw new FileTransferError('QUOTA_EXCEEDED', 'Too many stored file transfers. Cancel an old transfer or wait for expiry.')
      const record: Saved = {
        schemaVersion: 1, root, request,
        status: { transferId: request.requestId, deviceId: request.deviceId, state: 'transferring', receivedBytes: 0, files: [], expiresAt: new Date(Date.now() + FILE_TRANSFER_LIMITS.retentionMs).toISOString() },
      }
      await this.check(record)
      await this.reserve(record)
      try {
        await mkdir(join(this.directory, request.requestId), { mode: 0o700 })
        await this.save(record)
        this.records.set(request.requestId, record)
        if (this.closed) throw new FileTransferError('UNAVAILABLE', 'File transfer service is closed.')
        this.start(record)
        return structuredClone(record.status)
      } catch (error) { this.free(record); throw error }
    })
  }

  private peerKey(record: Saved): string { return record.request.deviceId }
  private async reserve(record: Saved): Promise<void> {
    if (this.busy.has(this.peerKey(record)) || this.active.size >= FILE_TRANSFER_LIMITS.concurrent) throw new FileTransferError('BUSY', 'Another file transfer is active for this peer, or both global file slots are in use.')
    const used = [...this.records.values()].filter((item) => !['cancelled', 'expired'].includes(item.status.state))
      .reduce((total, item) => total + (item.manifest?.files.reduce((size, file) => size + file.sizeBytes, 0)
        ?? (item.status.state === 'failed' ? 0 : FILE_TRANSFER_LIMITS.batchBytes)), 0)
    if (!this.records.has(record.status.transferId) && used + FILE_TRANSFER_LIMITS.batchBytes > FILE_TRANSFER_LIMITS.storageBytes) throw new FileTransferError('QUOTA_EXCEEDED', 'The private file inbox has reached its storage quota.')
    const key = record.request.deviceId === 'local' ? 'local' : await this.devices.fileDeviceKey(record.root, record.request.deviceId)
    this.slots.set(record.status.transferId, this.budget.acquire(key))
    this.busy.add(this.peerKey(record))
  }

  private free(record: Saved): void {
    this.slots.get(record.status.transferId)?.()
    this.slots.delete(record.status.transferId)
    this.busy.delete(this.peerKey(record))
  }

  private start(record: Saved): void {
    const abort = new AbortController()
    const done = this.receive(record, AbortSignal.any([abort.signal, this.shutdown.signal])).catch(async (error: unknown) => {
      if (record.status.state !== 'cancelled' && record.status.state !== 'expired') {
        const failure = transferFailure(error)
        record.status.state = ['UNAVAILABLE', 'BUSY', 'IO_ERROR'].includes(failure.code) ? 'interrupted' : 'failed'
        record.status.error = failure
        try { await this.save(record) } catch { console.error('File transfer failure status could not be saved.') }
      }
    }).finally(() => { this.active.delete(record.status.transferId); this.free(record) })
    this.active.set(record.status.transferId, { abort, done })
  }

  private async prepare(record: Saved, signal: AbortSignal): Promise<ExportManifest> {
    const request = { transferId: record.status.transferId, selection: record.request.selection }
    const result = record.request.deviceId === 'local'
      ? await this.source.prepare(`local:${record.root}`, request, () => this.check(record, signal), signal)
      : await this.devices.fileRequest(record.root, record.request.deviceId, 'prepare', request, signal)
    const manifest = exportManifestSchema.parse(result)
    if (manifest.transferId !== request.transferId || Date.parse(manifest.expiresAt) <= Date.now()
      || Date.parse(manifest.expiresAt) > Date.now() + FILE_TRANSFER_LIMITS.retentionMs + 60_000) throw new FileTransferError('INTEGRITY_FAILED', 'The source returned an invalid transfer identity or expiry.')
    if (record.manifest && JSON.stringify(record.manifest) !== JSON.stringify(manifest)) throw new FileTransferError('SOURCE_CHANGED', 'The source snapshot changed. Start a new request.')
    return manifest
  }

  private async receive(record: Saved, signal: AbortSignal): Promise<void> {
    const manifest = await this.prepare(record, signal)
    record.manifest = manifest
    record.status.files = manifest.files
    record.status.expiresAt = manifest.expiresAt
    record.status.receivedBytes = 0
    await this.save(record)
    for (const file of manifest.files) {
      signal.throwIfAborted()
      const base = join(this.directory, record.status.transferId, file.fileId)
      let complete = false
      try { await this.privateFile(`${base}.blob`, file.sizeBytes); complete = true }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const path = `${base}.${complete ? 'blob' : 'part'}`
      if (!complete) {
        try { await this.privateFile(path, file.sizeBytes) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          const created = await open(path, 'wx', 0o600)
          await created.close()
        }
      }
      const handle = await open(path, complete ? 'r' : 'r+')
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.nlink !== 1 || info.size > file.sizeBytes) throw new FileTransferError('INTEGRITY_FAILED', 'Invalid partial file.')
        const hash = createHash('sha256')
        const buffer = Buffer.alloc(FILE_TRANSFER_LIMITS.chunkBytes)
        let offset = 0
        while (offset < info.size) {
          signal.throwIfAborted()
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset)
          if (!bytesRead) throw new FileTransferError('INTEGRITY_FAILED', 'The partial file changed.')
          hash.update(buffer.subarray(0, bytesRead))
          offset += bytesRead
        }
        record.status.receivedBytes += offset
        while (offset < file.sizeBytes) {
          signal.throwIfAborted()
          const chunk = record.request.deviceId === 'local'
            ? await this.source.chunk(`local:${record.root}`, manifest.transferId, file.fileId, offset, () => this.check(record, signal), signal)
            : await this.devices.fileRequest(record.root, record.request.deviceId, 'chunk', { transferId: manifest.transferId, fileId: file.fileId, offset }, signal)
          signal.throwIfAborted()
          const expected = Math.min(FILE_TRANSFER_LIMITS.chunkBytes, file.sizeBytes - offset)
          if (!Buffer.isBuffer(chunk) || chunk.length !== expected) throw new FileTransferError('INTEGRITY_FAILED', 'The source returned an incomplete or oversized chunk.')
          let written = 0
          while (written < chunk.length) {
            const result = await handle.write(chunk, written, chunk.length - written, offset + written)
            if (!result.bytesWritten) throw new FileTransferError('IO_ERROR', 'Could not write the file chunk.')
            written += result.bytesWritten
          }
          hash.update(chunk)
          offset += chunk.length
          record.status.receivedBytes += chunk.length
        }
        if (hash.digest('hex') !== file.sha256) throw new FileTransferError('INTEGRITY_FAILED', 'The received file checksum does not match the source snapshot.')
        if (!complete) await handle.sync()
      } finally { await handle.close() }
      if (!complete) await rename(path, `${base}.blob`)
      await this.save(record)
    }
    await this.check(record, signal)
    record.status.state = 'delivered'
    record.status.error = undefined
    await this.save(record)
  }

  private async privateFile(file: string, max: number): Promise<void> {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > max || process.platform !== 'win32' && (info.mode & 0o077)) throw new FileTransferError('ACCESS_DENIED', 'The received file is not a private regular file.')
  }

  private async status(root: string, id: string): Promise<TransferStatus> {
    await this.initialize()
    await this.expire()
    const record = this.record(root, id)
    if (!['cancelled', 'expired'].includes(record.status.state)) await this.check(record)
    return structuredClone(record.status)
  }

  private async resume(root: string, id: string): Promise<TransferStatus> {
    return this.serialized(async () => {
      await this.initialize()
      const record = this.record(root, id)
      await this.check(record)
      if (this.active.has(id) || record.status.state === 'delivered') return structuredClone(record.status)
      if (record.status.state !== 'interrupted') throw new FileTransferError('INVALID_REQUEST', 'Only an interrupted transfer can be resumed. Use a new request ID for a failed transfer.')
      await this.reserve(record)
      record.status.state = 'transferring'
      record.status.error = undefined
      try { await this.save(record); this.start(record) }
      catch (error) { this.free(record); record.status.state = 'interrupted'; throw error }
      return structuredClone(record.status)
    })
  }

  private async cancel(root: string, id: string): Promise<TransferStatus> {
    await this.initialize()
    const record = this.record(root, id)
    record.status.state = 'cancelled'
    record.status.error = undefined
    this.active.get(id)?.abort.abort()
    await this.active.get(id)?.done
    await this.removeBlobs(record)
    try {
      if (record.request.deviceId === 'local') await this.source.release(`local:${record.root}`, id, async () => {})
      else await this.devices.fileRequest(record.root, record.request.deviceId, 'release', { transferId: id }, new AbortController().signal)
    } catch {
      record.status.error = { code: 'UNAVAILABLE', message: 'Local access was cancelled. The source snapshot could not be released and will expire automatically.' }
    }
    await this.save(record)
    return structuredClone(record.status)
  }

  private async read(root: string, request: ReadFileRequest): Promise<FilePage> {
    await this.initialize()
    const record = this.record(root, request.transferId)
    await this.check(record)
    if (record.status.state !== 'delivered') throw new FileTransferError('INVALID_REQUEST', 'The complete file has not been delivered.')
    const file = record.status.files.find((item) => item.fileId === request.fileId)
    if (!file) throw new FileTransferError('NOT_FOUND', 'File not found in this transfer.')
    if (request.offset > file.sizeBytes) throw new FileTransferError('INVALID_REQUEST', 'The file offset is out of range.')
    const path = join(this.directory, request.transferId, `${request.fileId}.blob`)
    await this.privateFile(path, file.sizeBytes)
    const handle = await open(path, 'r')
    let bytes: Buffer
    try {
      const length = Math.min(request.maxBytes + 3, file.sizeBytes - request.offset)
      bytes = Buffer.alloc(length)
      const { bytesRead } = await handle.read(bytes, 0, length, request.offset)
      if (bytesRead !== length) throw new FileTransferError('INTEGRITY_FAILED', 'The received file was truncated.')
    } finally { await handle.close() }
    let length = Math.min(request.maxBytes, bytes.length)
    if (request.offset + length < file.sizeBytes) while (length > 0 && (bytes[length] & 0xc0) === 0x80) length--
    const page = bytes.subarray(0, length)
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(page) }
    catch { throw new FileTransferError('NOT_TEXT', 'This file or offset is not valid UTF-8 text. Binary files are stored but not exposed as text.') }
    if (text.includes('\0')) throw new FileTransferError('NOT_TEXT', 'This file contains binary data and cannot be read as text.')
    await this.check(record)
    const nextOffset = request.offset + length
    return { fileId: request.fileId, text, offset: request.offset, nextOffset, eof: nextOffset === file.sizeBytes, truncated: nextOffset < file.sizeBytes }
  }

  private async removeBlobs(record: Saved): Promise<void> {
    for (const file of record.manifest?.files ?? []) for (const extension of ['part', 'blob']) {
      await rm(join(this.directory, record.status.transferId, `${file.fileId}.${extension}`), { force: true })
    }
    record.status.receivedBytes = 0
  }

  private expire(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.expiring ??= this.sweepExpired().finally(() => { this.expiring = undefined })
    return this.expiring
  }

  private async sweepExpired(): Promise<void> {
    await this.initialize()
    for (const [id, record] of this.records) {
      if (Date.parse(record.status.expiresAt) > Date.now()) continue
      record.status.state = 'expired'
      this.active.get(id)?.abort.abort()
      await this.active.get(id)?.done
      await this.removeBlobs(record)
      await this.writes.get(id)
      await rm(join(this.directory, id, 'transfer.json'), { force: true })
      await rmdir(join(this.directory, id))
      this.records.delete(id)
      this.writes.delete(id)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.shutdown.abort()
    clearInterval(this.cleanupTimer)
    for (const active of this.active.values()) active.abort.abort()
    await this.admission
    await this.expiring
    await Promise.all([...this.active.values()].map((active) => active.done))
    await Promise.all(this.writes.values())
  }
}
