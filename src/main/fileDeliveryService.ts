import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readdir, realpath, rm, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import {
  deliveryCapabilitiesSchema, deliveryChunkSchema, deliveryLookupSchema, deliveryPrepareSchema,
  deliveryInboxRequestSchema, deliveryReceiptSchema, saveReceivedFileSchema, sendFilesSchema,
} from '../shared/fileDelivery'
import type { DeliveryDestination, DeliveryReceipt, DeliverySender, SaveReceivedFileRequest, SendFilesRequest } from '../shared/fileDelivery'
import { exportManifestSchema, FILE_TRANSFER_LIMITS, FileTransferError, transferFailure, transferStatusSchema } from '../shared/fileTransfer'
import type { FileTransferApi, TransferStatus } from '../shared/fileTransfer'
import type { FileTransferService } from './fileTransferService'
import type { FileTransferSource } from './fileTransferSource'
import type { VSCodeDeviceClient } from './vscodeDeviceClient'
import { FileTransferBudget } from './fileTransferBudget'
import { assertTransferSavePath, assertTransferAncestors, localTransferPath, withinFilePath } from './fileTransferPaths'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'

const workspaceSchema = z.object({
  root: z.string().min(1), inboxId: z.uuid(), senders: z.array(z.uuid()).max(32),
  roots: z.array(z.object({ id: z.uuid(), path: z.string().min(1) }).strict()).max(20),
}).strict()
const settingsSchema = z.object({ schemaVersion: z.literal(1), workspaces: z.array(workspaceSchema).max(100) }).strict()
  .refine((value) => new Set(value.workspaces.map((item) => item.root)).size === value.workspaces.length
    && new Set(value.workspaces.map((item) => item.inboxId)).size === value.workspaces.length
    && value.workspaces.every((item) => new Set(item.roots.map((root) => root.id)).size === item.roots.length),
  'Delivery identities must be unique.')
type Workspace = z.infer<typeof workspaceSchema>
const outgoingSchema = z.object({
  schemaVersion: z.literal(1), root: z.string(), request: sendFilesSchema, targetClientId: z.uuid(),
  chunkBytes: z.number().int().min(4096).max(FILE_TRANSFER_LIMITS.chunkBytes).default(64 * 1024),
  status: transferStatusSchema, manifest: exportManifestSchema.optional(),
}).strict()
type Outgoing = z.infer<typeof outgoingSchema>
type Peer = { clientId: string; machineName: string }
type Dependencies = {
  identity(): Promise<{ clientId: string }>
  senders(root: string): Promise<Peer[]>
  authorizeSender(root: string, pairId: string, clientId: string): Promise<void>
}

export class FileDeliveryService {
  private readonly outbox: string
  private settings?: z.infer<typeof settingsSchema>
  private readonly outgoing = new Map<string, Outgoing>()
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>()
  private readonly slots = new Map<string, () => void>()
  private loading?: Promise<void>
  private writes: Promise<void> = Promise.resolve()
  private admission: Promise<void> = Promise.resolve()
  private closed = false
  private readonly timer: ReturnType<typeof setInterval>

  constructor(private readonly directory: string, private readonly files: FileTransferService, private readonly source: FileTransferSource,
    private readonly devices: Pick<VSCodeDeviceClient, 'fileRequest' | 'fileDeviceKey'>, private readonly dependencies: Dependencies,
    private readonly budget = new FileTransferBudget()) {
    this.outbox = join(directory, 'file-delivery-outbox')
    this.timer = setInterval(() => {
      void this.serialized(() => this.expire()).catch(() => console.error('File delivery expiry failed.'))
    }, 60_000)
    this.timer.unref()
  }

  get hasActiveWork(): boolean { return this.active.size > 0 }

  private async canonical(root: string): Promise<string> {
    const path = await realpath(root)
    return process.platform === 'win32' ? path.toLowerCase() : path
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = this.admission.then(action)
    this.admission = result.then(() => {}, () => {})
    return result
  }

  private async load(): Promise<void> {
    this.loading ??= (async () => {
      try { this.settings = settingsSchema.parse(await readJsonBounded(join(this.directory, 'file-delivery-settings.json'), 128 * 1024)) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new FileTransferError('IO_ERROR', 'File delivery settings are unreadable.')
        this.settings = { schemaVersion: 1, workspaces: [] }
      }
      await mkdir(this.outbox, { recursive: true, mode: 0o700 })
      if ((await lstat(this.outbox)).isSymbolicLink()) throw new FileTransferError('ACCESS_DENIED', 'Invalid delivery storage.')
      for (const name of await readdir(this.outbox)) {
        const id = name.endsWith('.json') ? name.slice(0, -5) : ''
        if (!z.uuid().safeParse(id).success) continue
        const path = join(this.outbox, name)
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new FileTransferError('ACCESS_DENIED', 'Invalid delivery metadata.')
        const record = outgoingSchema.parse(await readJsonBounded(path, 128 * 1024))
        if (record.request.requestId !== id || record.status.transferId !== id || record.status.deviceId !== record.request.targetDeviceId
          || record.manifest && (record.manifest.transferId !== id || JSON.stringify(record.manifest.files) !== JSON.stringify(record.status.files))) {
          throw new FileTransferError('INTEGRITY_FAILED', 'Saved delivery identity changed.')
        }
        if (this.outgoing.size >= FILE_TRANSFER_LIMITS.transfers) throw new FileTransferError('QUOTA_EXCEEDED', 'Too many saved deliveries.')
        if (record.status.state === 'transferring') {
          record.status.state = 'interrupted'
          record.status.error = { code: 'UNAVAILABLE', message: 'The application restarted. Resume this delivery explicitly.' }
        }
        this.outgoing.set(id, record)
      }
    })()
    await this.loading
    if (this.closed) throw new FileTransferError('UNAVAILABLE', 'File delivery service is closed.')
  }

  private write(path: string, value: unknown): Promise<void> {
    const snapshot = structuredClone(value)
    if (Buffer.byteLength(JSON.stringify(snapshot, null, 2) + '\n') > 128 * 1024) {
      return Promise.reject(new FileTransferError('QUOTA_EXCEEDED', 'Delivery metadata exceeds its retained-storage limit.'))
    }
    const result = this.writes.then(() => writeJsonAtomic(path, snapshot))
    this.writes = result.catch(() => {})
    return result
  }

  private save(record: Outgoing): Promise<void> { return this.write(join(this.outbox, `${record.request.requestId}.json`), record) }
  private persistSettings(): Promise<void> { return this.write(join(this.directory, 'file-delivery-settings.json'), this.settings) }

  private async workspace(root: string): Promise<Workspace> {
    await this.load()
    const canonical = await this.canonical(root)
    let workspace = this.settings!.workspaces.find((item) => item.root === canonical)
    if (!workspace) {
      if (this.settings!.workspaces.length >= 100) throw new FileTransferError('QUOTA_EXCEEDED', 'Too many delivery workspaces.')
      workspace = { root: canonical, inboxId: randomUUID(), senders: [], roots: [] }
      this.settings!.workspaces.push(workspace)
      await this.persistSettings()
    }
    return workspace
  }

  async authorizeIncoming(root: string, sender: DeliverySender): Promise<void> {
    await this.load()
    const workspace = this.settings!.workspaces.find((item) => item.root === root && item.inboxId === sender.inboxId)
    if (!workspace?.senders.includes(sender.clientId)) throw new FileTransferError('ACCESS_DENIED', 'Receiving files from this client is not authorized.')
    await this.dependencies.authorizeSender(root, sender.pairId, sender.clientId)
  }

  async targets(pairId: string, clientId: string): Promise<DeliveryDestination[]> {
    await this.load()
    const owner = await this.dependencies.identity()
    const result: DeliveryDestination[] = []
    for (const workspace of this.settings!.workspaces) {
      if (!workspace.senders.includes(clientId)) continue
      try { await this.authorizeIncoming(workspace.root, { pairId, clientId, inboxId: workspace.inboxId }) }
      catch (error) { if (error instanceof FileTransferError && error.code === 'ACCESS_DENIED') continue; throw error }
      result.push({ inboxId: workspace.inboxId, label: basename(workspace.root).slice(0, 200) || 'Workspace', clientId: owner.clientId })
    }
    return result
  }

  private async incomingRoot(sender: DeliverySender): Promise<string> {
    await this.load()
    const workspace = this.settings!.workspaces.find((item) => item.inboxId === sender.inboxId)
    if (!workspace) throw new FileTransferError('ACCESS_DENIED', 'The target inbox is not authorized.')
    await this.authorizeIncoming(workspace.root, sender)
    return workspace.root
  }

  async receive(pairId: string, clientId: string, method: string, value: unknown, bytes?: Buffer): Promise<unknown> {
    const parsed = method === 'prepare' ? deliveryPrepareSchema.parse(value)
      : method === 'chunk' ? deliveryChunkSchema.parse(value) : deliveryLookupSchema.parse(value)
    const sender = { pairId, clientId, inboxId: parsed.inboxId }
    const root = await this.incomingRoot(sender)
    if (method === 'prepare' && 'manifest' in parsed) {
      if (this.outgoing.has(parsed.manifest.transferId)) throw new FileTransferError('ACCESS_DENIED', 'This transfer ID is already in use.')
      return this.files.acceptDelivery(root, sender, parsed.manifest)
    }
    if (!('transferId' in parsed)) throw new FileTransferError('INVALID_REQUEST', 'Invalid delivery operation.')
    if (method === 'status') return this.files.deliveryStatus(root, sender, parsed.transferId)
    if (method === 'commit') return this.files.commitDelivery(root, sender, parsed.transferId)
    if (method === 'cancel') return this.files.cancelDelivery(root, sender, parsed.transferId)
    if (method === 'chunk' && bytes) {
      const chunk = deliveryChunkSchema.parse(value)
      return this.files.uploadDelivery(root, sender, chunk.transferId, chunk.fileId, chunk.offset, bytes)
    }
    throw new FileTransferError('INVALID_REQUEST', 'Invalid delivery operation.')
  }

  forWorkspace(root: string): FileTransferApi {
    const base = this.files.forWorkspace(root)
    const outgoing = async (id: string) => {
      await this.load()
      const record = this.outgoing.get(z.uuid().parse(id))
      if (record && record.root !== await this.canonical(root)) throw new FileTransferError('NOT_FOUND', 'Delivery not found in this workspace.')
      return record
    }
    return {
      ...base,
      fetch: async (request) => {
        await this.load()
        if (this.outgoing.has(request.requestId)) throw new FileTransferError('INVALID_REQUEST', 'This request ID belongs to an outgoing delivery.')
        return base.fetch(request)
      },
      status: async (id) => {
        const record = await outgoing(id)
        if (!record) return base.status(id)
        await this.check(record, false)
        return structuredClone(record.status)
      },
      resume: async (id) => {
        const record = await outgoing(id)
        return record ? this.resume(record) : base.resume(id)
      },
      cancel: async (id) => {
        const record = await outgoing(id)
        return record ? this.cancel(record) : base.cancel(id)
      },
      delivery: {
        destinations: async (id) => {
          z.uuid().parse(id)
          const result = deliveryCapabilitiesSchema.parse(await this.devices.fileRequest(await this.canonical(root), id, 'delivery/targets', {}, new AbortController().signal))
          return result.inboxes
        },
        send: async (request) => this.send(await this.canonical(root), sendFilesSchema.parse(request)),
        inbox: async (value) => {
          const request = deliveryInboxRequestSchema.parse(value)
          const workspace = await this.serialized(() => this.workspace(root))
          const transfers = (await this.files.incoming(workspace.root)).sort((a, b) => a.transferId.localeCompare(b.transferId))
          const index = request.cursor ? transfers.findIndex((item) => item.transferId === request.cursor) : -1
          if (request.cursor && index < 0) throw new FileTransferError('NOT_FOUND', 'The inbox cursor has expired. Start a new listing.')
          const page = transfers.slice(index + 1, index + 1 + request.limit)
          return {
            transfers: page, ...(index + 1 + page.length < transfers.length ? { nextCursor: page.at(-1)!.transferId } : {}),
            destinations: workspace.roots.map((item) => ({ id: item.id, label: basename(item.path).slice(0, 200) })),
          }
        },
        save: async (request) => this.saveFile(await this.canonical(root), saveReceivedFileSchema.parse(request)),
      },
    }
  }

  private principal(record: Outgoing): string { return `delivery:${record.root}:${record.targetClientId}` }

  private async check(record: Outgoing, transferring = true): Promise<void> {
    if (this.closed) throw new FileTransferError('UNAVAILABLE', 'File delivery is closed.')
    if (transferring && record.status.state === 'cancelled') throw new FileTransferError('CANCELLED', 'File delivery was cancelled.')
    if (Date.parse(record.status.expiresAt) <= Date.now()) throw new FileTransferError('EXPIRED', 'The delivery has expired.')
    if (await this.devices.fileDeviceKey(record.root, record.request.targetDeviceId) !== record.targetClientId) {
      throw new FileTransferError('ACCESS_DENIED', 'The target client identity changed.')
    }
  }

  private async reserve(record: Outgoing): Promise<void> {
    await this.check(record)
    this.slots.set(record.request.requestId, this.budget.acquire(record.targetClientId))
  }

  private async send(root: string, request: SendFilesRequest): Promise<TransferStatus> {
    return this.serialized(async () => {
      await this.load()
      await this.expire()
      const prior = this.outgoing.get(request.requestId)
      if (prior) {
        if (prior.root !== root || JSON.stringify(prior.request) !== JSON.stringify(request)) throw new FileTransferError('INVALID_REQUEST', 'This request ID belongs to another delivery.')
        await this.check(prior, false)
        return structuredClone(prior.status)
      }
      if (await this.files.hasTransfer(request.requestId)) throw new FileTransferError('INVALID_REQUEST', 'This request ID already belongs to a received transfer.')
      if (this.outgoing.size >= FILE_TRANSFER_LIMITS.transfers) throw new FileTransferError('QUOTA_EXCEEDED', 'Too many retained outgoing deliveries.')
      const targetClientId = await this.devices.fileDeviceKey(root, request.targetDeviceId)
      const destinations = await this.forWorkspace(root).delivery!.destinations(request.targetDeviceId)
      if (!destinations.some((item) => item.inboxId === request.targetInboxId && item.clientId === targetClientId)) throw new FileTransferError('ACCESS_DENIED', 'The target inbox is not authorized.')
      const record: Outgoing = { schemaVersion: 1, root, request, targetClientId, chunkBytes: 64 * 1024, status: {
        transferId: request.requestId, deviceId: request.targetDeviceId, state: 'transferring', files: [],
        receivedBytes: 0, expiresAt: new Date(Date.now() + FILE_TRANSFER_LIMITS.retentionMs).toISOString(),
      } }
      await this.reserve(record)
      try {
        await this.save(record)
        this.outgoing.set(request.requestId, record)
        this.start(record)
      } catch (error) { this.slots.get(request.requestId)?.(); this.slots.delete(request.requestId); throw error }
      return structuredClone(record.status)
    })
  }

  private start(record: Outgoing): void {
    const abort = new AbortController()
    const done = this.upload(record, abort.signal).catch(async (error: unknown) => {
      if (record.status.state === 'cancelled') return
      const failure = transferFailure(error)
      if (failure.code === 'UNAVAILABLE') record.chunkBytes = Math.max(4096, Math.floor(record.chunkBytes / 2))
      record.status.state = ['UNAVAILABLE', 'BUSY', 'IO_ERROR'].includes(failure.code) ? 'interrupted' : 'failed'
      record.status.error = failure
      await this.save(record)
    }).catch(() => console.error('File delivery failure status could not be saved.')).finally(() => {
      this.active.delete(record.request.requestId)
      this.slots.get(record.request.requestId)?.()
      this.slots.delete(record.request.requestId)
    })
    this.active.set(record.request.requestId, { abort, done })
  }

  private receipt(record: Outgoing, value: unknown): DeliveryReceipt {
    const receipt = deliveryReceiptSchema.parse(value)
    if (receipt.status.transferId !== record.request.requestId || JSON.stringify(receipt.status.files) !== JSON.stringify(record.manifest!.files)
      || Object.keys(receipt.offsets).length !== record.manifest!.files.length
      || Object.values(receipt.offsets).reduce((sum, size) => sum + size, 0) !== receipt.status.receivedBytes
      || record.manifest!.files.some((file) => receipt.offsets[file.fileId] === undefined || receipt.offsets[file.fileId] > file.sizeBytes
        || receipt.status.state === 'delivered' && receipt.offsets[file.fileId] !== file.sizeBytes)) {
      throw new FileTransferError('INTEGRITY_FAILED', 'The target returned a different delivery manifest or offset.')
    }
    if (!['transferring', 'delivered'].includes(receipt.status.state)) throw new FileTransferError(receipt.status.error?.code ?? 'UNAVAILABLE', 'The target did not accept the delivery.')
    return receipt
  }

  private async upload(record: Outgoing, signal: AbortSignal): Promise<void> {
    const check = async () => { signal.throwIfAborted(); await this.check(record) }
    await check()
    const manifest = await this.source.prepare(this.principal(record), { transferId: record.request.requestId, selection: { kind: 'files', paths: record.request.paths } }, check, signal)
    if (record.manifest && JSON.stringify(record.manifest) !== JSON.stringify(manifest)) throw new FileTransferError('SOURCE_CHANGED', 'The retained source snapshot changed.')
    record.manifest = manifest
    record.status.files = manifest.files
    record.status.expiresAt = manifest.expiresAt
    await this.save(record)
    const lookup = { inboxId: record.request.targetInboxId, transferId: manifest.transferId }
    const request = async (method: 'prepare' | 'chunk' | 'commit', value: unknown) => {
      await check()
      const result = await this.devices.fileRequest(record.root, record.request.targetDeviceId, `delivery/${method}`, value, signal)
      await check()
      return this.receipt(record, result)
    }
    let receipt = await request('prepare', { inboxId: lookup.inboxId, manifest })
    for (const file of manifest.files) {
      let offset = receipt.offsets[file.fileId]
      while (offset < file.sizeBytes && receipt.status.state !== 'delivered') {
        const bytes = await this.source.chunk(this.principal(record), manifest.transferId, file.fileId, offset, check, signal, record.chunkBytes)
        receipt = await request('chunk', { ...lookup, fileId: file.fileId, offset, data: bytes })
        const confirmed = receipt.offsets[file.fileId]
        if (confirmed < offset + bytes.length) throw new FileTransferError('INTEGRITY_FAILED', 'The target did not confirm the uploaded bytes.')
        offset = confirmed
        record.status.receivedBytes = receipt.status.receivedBytes
        await this.save(record)
      }
    }
    receipt = await request('commit', lookup)
    if (receipt.status.state !== 'delivered') throw new FileTransferError('INTEGRITY_FAILED', 'The target did not durably commit the delivery.')
    record.status.receivedBytes = receipt.status.receivedBytes
    record.status.state = 'delivered'
    record.status.error = undefined
    await this.save(record)
  }

  private resume(record: Outgoing): Promise<TransferStatus> {
    return this.serialized(async () => {
      await this.check(record)
      if (this.active.has(record.request.requestId) || record.status.state === 'delivered') return structuredClone(record.status)
      if (record.status.state !== 'interrupted') throw new FileTransferError('INVALID_REQUEST', 'Only interrupted deliveries can be resumed.')
      await this.reserve(record)
      record.status.state = 'transferring'
      record.status.error = undefined
      try { await this.save(record); this.start(record) }
      catch (error) { this.slots.get(record.request.requestId)?.(); this.slots.delete(record.request.requestId); record.status.state = 'interrupted'; throw error }
      return structuredClone(record.status)
    })
  }

  private async cancel(record: Outgoing): Promise<TransferStatus> {
    record.status.state = 'cancelled'
    record.status.error = undefined
    this.active.get(record.request.requestId)?.abort.abort()
    await this.active.get(record.request.requestId)?.done
    try {
      await this.devices.fileRequest(record.root, record.request.targetDeviceId, 'delivery/cancel',
        { inboxId: record.request.targetInboxId, transferId: record.request.requestId }, new AbortController().signal)
    } catch { record.status.error = { code: 'UNAVAILABLE', message: 'Cancelled locally. Target cleanup could not be confirmed and retained data will expire.' } }
    await this.source.release(this.principal(record), record.request.requestId, async () => {})
    await this.save(record)
    return structuredClone(record.status)
  }

  async preferences(root: string) {
    const workspace = await this.serialized(() => this.workspace(root))
    const peers = await this.dependencies.senders(workspace.root)
    const senders = new Map(peers.map((peer) => [peer.clientId, peer]))
    for (const id of workspace.senders) if (!senders.has(id)) senders.set(id, { clientId: id, machineName: 'Unavailable paired client' })
    return {
      inboxId: workspace.inboxId,
      senders: [...senders.values()].map((peer) => ({ ...peer, allowed: workspace.senders.includes(peer.clientId) })),
      roots: structuredClone(workspace.roots),
      transfers: [
        ...[...this.outgoing.values()].filter((item) => item.root === workspace.root).map((item) => ({ direction: 'outgoing' as const, status: structuredClone(item.status) })),
        ...(await this.files.incoming(workspace.root)).map((status) => ({ direction: 'incoming' as const, status })),
      ],
    }
  }

  setSender(root: string, clientId: string, allowed: boolean): Promise<void> {
    return this.serialized(async () => {
      const workspace = await this.workspace(root)
      z.uuid().parse(clientId)
      if (allowed && !(await this.dependencies.senders(workspace.root)).some((peer) => peer.clientId === clientId)) throw new FileTransferError('ACCESS_DENIED', 'This client is not paired for this workspace.')
      const senders = workspace.senders.filter((id) => id !== clientId)
      if (allowed) {
        senders.push(clientId)
        if (senders.length > 32) throw new FileTransferError('QUOTA_EXCEEDED', 'Revoke an old sender before authorizing another client.')
        await this.write(join(this.directory, 'file-delivery-settings.json'), {
          ...this.settings, workspaces: this.settings!.workspaces.map((item) => item === workspace ? { ...item, senders } : item),
        })
        workspace.senders = senders
      } else {
        workspace.senders = senders
        await this.persistSettings()
      }
    })
  }

  addDestination(root: string, path: string): Promise<void> {
    return this.serialized(async () => {
      const workspace = await this.workspace(root)
      const directory = localTransferPath(path)
      assertTransferSavePath(this.directory, directory)
      await assertTransferAncestors(directory)
      if (!(await lstat(directory)).isDirectory()) throw new FileTransferError('INVALID_REQUEST', 'Choose an existing destination directory.')
      if (workspace.roots.length >= 20) throw new FileTransferError('QUOTA_EXCEEDED', 'Too many authorized destination directories.')
      if (workspace.roots.some((item) => item.path === directory)) return
      const roots = [...workspace.roots, { id: randomUUID(), path: directory }]
      await this.write(join(this.directory, 'file-delivery-settings.json'), {
        ...this.settings, workspaces: this.settings!.workspaces.map((item) => item === workspace ? { ...item, roots } : item),
      })
      workspace.roots = roots
    })
  }

  removeDestination(root: string, id: string): Promise<void> {
    return this.serialized(async () => {
      const workspace = await this.workspace(root)
      workspace.roots = workspace.roots.filter((item) => item.id !== z.uuid().parse(id))
      await this.persistSettings()
    })
  }

  private async saveFile(root: string, request: SaveReceivedFileRequest) {
    const workspace = await this.serialized(() => this.workspace(root))
    const grant = workspace.roots.find((item) => item.id === request.destinationRootId)
    if (!grant) throw new FileTransferError('ACCESS_DENIED', 'The destination directory is not authorized.')
    if (isAbsolute(request.relativePath) || request.relativePath.includes(':')
      || request.relativePath.split(/[/\\]/).some((part) => !part || part === '..' || part === '.')) throw new FileTransferError('ACCESS_DENIED', 'Use a relative filename inside the authorized directory.')
    const destination = localTransferPath(resolve(grant.path, request.relativePath))
    if (!withinFilePath(grant.path, destination) || !relative(grant.path, destination)) throw new FileTransferError('ACCESS_DENIED', 'The destination is outside its grant.')
    assertTransferSavePath(this.directory, destination)
    const check = async () => {
      await this.load()
      if (!workspace.roots.some((item) => item.id === grant.id && item.path === grant.path)) throw new FileTransferError('ACCESS_DENIED', 'The destination grant was revoked.')
      await assertTransferAncestors(dirname(destination))
    }
    await check()
    const temporary = join(dirname(destination), `.tc-delivery-${randomUUID()}.tmp`)
    let created = false
    try {
      return await this.files.withDeliveredFile(root, request.transferId, request.fileId, async (file, input, checkTransfer) => {
        const output = await open(temporary, 'wx', 0o600)
        created = true
        try {
          const hash = createHash('sha256')
          const buffer = Buffer.alloc(FILE_TRANSFER_LIMITS.chunkBytes)
          for (let offset = 0; offset < file.sizeBytes;) {
            await check()
            await checkTransfer()
            const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, file.sizeBytes - offset), offset)
            if (!bytesRead) throw new FileTransferError('INTEGRITY_FAILED', 'The received file was truncated.')
            hash.update(buffer.subarray(0, bytesRead))
            for (let written = 0; written < bytesRead;) {
              const next = await output.write(buffer, written, bytesRead - written, offset + written)
              if (!next.bytesWritten) throw new FileTransferError('IO_ERROR', 'The local copy could not be written.')
              written += next.bytesWritten
            }
            offset += bytesRead
          }
          if (hash.digest('hex') !== file.sha256) throw new FileTransferError('INTEGRITY_FAILED', 'The received checksum changed.')
          await output.sync()
        } finally { await output.close() }
        await check()
        await checkTransfer()
        try { await link(temporary, destination) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new FileTransferError('ALREADY_EXISTS', 'The destination already exists; no file was overwritten.')
          throw error
        }
        return { path: destination, sizeBytes: file.sizeBytes, sha256: file.sha256 }
      })
    } finally { if (created) await unlink(temporary) }
  }

  private async expire(): Promise<void> {
    await this.load()
    for (const [id, record] of this.outgoing) {
      if (Date.parse(record.status.expiresAt) > Date.now() || this.active.has(id)) continue
      await this.writes
      await rm(join(this.outbox, `${id}.json`))
      this.outgoing.delete(id)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    for (const active of this.active.values()) active.abort.abort()
    await this.admission
    await Promise.all([...this.active.values()].map((item) => item.done))
    await this.writes
  }
}
