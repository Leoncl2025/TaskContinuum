import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, posix, win32 } from 'node:path'
import { open, rename, rm } from 'node:fs/promises'
import type { SessionOwner } from '../shared/sessionBindings'
import { agentHostKey } from '../shared/agentHost'
import type { AgentHostTarget } from '../shared/agentHost'
import { chatImageAttachmentSchema, CHAT_IMAGE_TYPES, MAX_CHAT_IMAGE_BYTES } from '../shared/chatAttachments'
import { FILE_TRANSFER_LIMITS, FileTransferError } from '../shared/fileTransfer'
import type { TransferFile, TransferStatus } from '../shared/fileTransfer'
import { parseChatLink } from '../shared/chatLinks'
import type { ChatFilePreview, ChatFilePreviewRequest, ChatFileRequest, OpenChatLinkRequest, OpenChatLinkResult } from '../shared/chatLinks'
import type { FileTransferService } from './fileTransferService'

interface LinkRecord {
  root: string
  target: AgentHostTarget
  deviceId: string
  expiresAt: number
}
export interface ChatLinkDependencies {
  files: Pick<FileTransferService, 'forWorkspace' | 'withDeliveredFile'>
  owner(): Promise<SessionOwner>
  device(root: string, owner: SessionOwner): Promise<string>
  authorize(root: string, target: AgentHostTarget): Promise<void>
  directories(root: string, target: AgentHostTarget): Promise<readonly string[]>
  openExternal(url: string): Promise<void>
}

export class ChatLinkService {
  private readonly records = new Map<string, LinkRecord>()
  constructor(private readonly dependencies: ChatLinkDependencies) {}

  private async check(record: LinkRecord, checkpoint: () => Promise<void>): Promise<void> {
    await checkpoint()
    try { await this.dependencies.authorize(record.root, record.target) }
    catch { throw new FileTransferError('ACCESS_DENIED', 'This exact chat is no longer authorized for the workspace. No file was opened.') }
    await checkpoint()
  }

  async open(root: string | undefined, request: OpenChatLinkRequest, checkpoint: () => Promise<void>): Promise<OpenChatLinkResult> {
    const link = parseChatLink(request.href)
    if (!link) throw new FileTransferError('INVALID_REQUEST', 'This link type or file address is not supported.')
    await checkpoint()
    if (link.kind === 'external') {
      await this.dependencies.openExternal(link.url)
      return { kind: 'external' }
    }
    if (!root || !request.target) throw new FileTransferError('INVALID_REQUEST', 'Open file links from an original Agent Host chat so their source device is known.')
    for (const [id, record] of this.records) if (record.expiresAt <= Date.now()) this.records.delete(id)
    if (this.records.size >= FILE_TRANSFER_LIMITS.transfers) throw new FileTransferError('QUOTA_EXCEEDED', 'Too many retained file links. Wait for old transfers to expire.')
    const record: LinkRecord = { root, target: request.target, deviceId: 'local', expiresAt: Date.now() + FILE_TRANSFER_LIMITS.retentionMs }
    await this.check(record, checkpoint)
    let path = link.path
    if (link.relative) {
      let directories: readonly string[]
      try { directories = await this.dependencies.directories(root, request.target) }
      catch { throw new FileTransferError('UNAVAILABLE', 'The source chat folder is unavailable. Reconnect its Host or use an absolute file link.') }
      const base = directories.length === 1 ? parseChatLink(directories[0]) : undefined
      if (!base || base.kind !== 'file' || base.relative) throw new FileTransferError('INVALID_REQUEST', 'The chat has no single verified source folder. Use an absolute file link.')
      path = /^[a-z]:[\\/]/i.test(base.path) ? win32.resolve(base.path, path) : posix.resolve(base.path, path)
    }
    if (request.target.owner.clientId !== (await this.dependencies.owner()).clientId) {
      record.deviceId = await this.dependencies.device(root, request.target.owner)
    }
    await this.check(record, checkpoint)
    const api = this.dependencies.files.forWorkspace(root)
    const status = await api.fetch({ requestId: request.requestId, deviceId: record.deviceId,
      selection: { kind: 'files', paths: [path] } })
    try { await this.check(record, checkpoint) }
    catch (error) {
      await api.cancel(status.transferId).catch(() => console.error('Chat link transfer cleanup failed.'))
      throw error
    }
    if (status.transferId !== request.requestId || status.deviceId !== record.deviceId) throw new FileTransferError('INTEGRITY_FAILED', 'The file transfer returned a different source identity.')
    record.expiresAt = Date.parse(status.expiresAt)
    this.records.set(status.transferId, record)
    return { kind: 'file', target: request.target, status, ...(link.line ? { line: link.line } : {}), ...(link.column ? { column: link.column } : {}) }
  }

  private record(root: string, request: ChatFileRequest): LinkRecord {
    const record = this.records.get(request.transferId)
    if (!record || record.root !== root || agentHostKey(record.target) !== agentHostKey(request.target)) {
      throw new FileTransferError('ACCESS_DENIED', 'This transfer does not belong to the original chat and workspace.')
    }
    return record
  }

  async status(root: string, request: ChatFileRequest, checkpoint: () => Promise<void>): Promise<TransferStatus> {
    const record = this.record(root, request)
    await this.check(record, checkpoint)
    const status = await this.dependencies.files.forWorkspace(root).status(request.transferId)
    if (status.deviceId !== record.deviceId || status.transferId !== request.transferId || status.files.length > 1) {
      throw new FileTransferError('INTEGRITY_FAILED', 'The linked file transfer identity changed.')
    }
    await this.check(record, checkpoint)
    return status
  }

  async preview(root: string, request: ChatFilePreviewRequest, checkpoint: () => Promise<void>): Promise<ChatFilePreview> {
    const status = await this.status(root, request, checkpoint)
    const file = status.files.find((item) => item.fileId === request.fileId)
    if (!file) throw new FileTransferError('NOT_FOUND', 'The linked file is not in this transfer.')
    const extensionMime: Record<string, typeof CHAT_IMAGE_TYPES[number]> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    }
    const extension = file.name.split('.').at(-1)?.toLowerCase() ?? ''
    const mime = CHAT_IMAGE_TYPES.find((type) => type === file.mediaType)
      ?? (Object.hasOwn(extensionMime, extension) ? extensionMime[extension] : undefined)
    if (mime && (request.offset ?? 0) === 0) {
      return this.dependencies.files.withDeliveredFile(root, request.transferId, request.fileId, async (_file, handle) => {
        if (file.sizeBytes > MAX_CHAT_IMAGE_BYTES) throw new FileTransferError('NOT_TEXT', 'This image is too large for an inline preview. Save a local copy to open it.')
        const bytes = Buffer.alloc(file.sizeBytes)
        let offset = 0
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
          if (!bytesRead) throw new FileTransferError('INTEGRITY_FAILED', 'The received image was truncated.')
          offset += bytesRead
        }
        if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new FileTransferError('INTEGRITY_FAILED', 'The received image checksum changed.')
        const image = chatImageAttachmentSchema.safeParse({ id: file.fileId, name: file.name.slice(0, 200).trim() || 'Image',
          mimeType: mime, data: bytes.toString('base64') })
        if (!image.success) throw new FileTransferError('NOT_TEXT', 'This file is not a supported image. Save a local copy to inspect it.')
        await this.check(this.record(root, request), checkpoint)
        return { kind: 'image', image: image.data }
      })
    }
    const page = await this.dependencies.files.forWorkspace(root).read({
      transferId: request.transferId, fileId: request.fileId, offset: request.offset ?? 0, maxBytes: request.maxBytes ?? FILE_TRANSFER_LIMITS.readBytes,
    })
    await this.check(this.record(root, request), checkpoint)
    return { kind: 'text', page }
  }

  async file(root: string, request: ChatFilePreviewRequest, checkpoint: () => Promise<void>): Promise<TransferFile> {
    const status = await this.status(root, request, checkpoint)
    if (status.state !== 'delivered') throw new FileTransferError('INVALID_REQUEST', 'Wait for the file to finish transferring.')
    const file = status.files.find((item) => item.fileId === request.fileId)
    if (!file) throw new FileTransferError('NOT_FOUND', 'The linked file is not in this transfer.')
    return file
  }

  async save(root: string, request: ChatFilePreviewRequest, destination: string, checkpoint: () => Promise<void>): Promise<void> {
    const record = this.record(root, request)
    await this.file(root, request, checkpoint)
    const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
    let committed = false
    let created = false
    try {
      await this.dependencies.files.withDeliveredFile(root, request.transferId, request.fileId, async (file, source, checkTransfer) => {
        const output = await open(temporary, 'wx', 0o600)
        created = true
        try {
          const hash = createHash('sha256')
          const buffer = Buffer.alloc(FILE_TRANSFER_LIMITS.chunkBytes)
          let offset = 0
          while (offset < file.sizeBytes) {
            await checkTransfer()
            await this.check(record, checkpoint)
            const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, file.sizeBytes - offset), offset)
            if (!bytesRead) throw new FileTransferError('INTEGRITY_FAILED', 'The received file was truncated.')
            const bytes = buffer.subarray(0, bytesRead)
            hash.update(bytes)
            let written = 0
            while (written < bytesRead) {
              const result = await output.write(bytes, written, bytesRead - written, offset + written)
              if (!result.bytesWritten) throw new FileTransferError('IO_ERROR', 'The local copy could not be written.')
              written += result.bytesWritten
            }
            offset += bytesRead
          }
          if (hash.digest('hex') !== file.sha256) throw new FileTransferError('INTEGRITY_FAILED', 'The received file checksum changed.')
          await output.sync()
        } finally { await output.close() }
      })
      await this.check(record, checkpoint)
      await rename(temporary, destination)
      committed = true
    } finally {
      if (created && !committed) await rm(temporary, { force: true })
    }
  }

  async cancel(root: string, request: ChatFileRequest, checkpoint: () => Promise<void>): Promise<TransferStatus> {
    this.record(root, request)
    await checkpoint()
    return this.dependencies.files.forWorkspace(root).cancel(request.transferId)
  }
}
