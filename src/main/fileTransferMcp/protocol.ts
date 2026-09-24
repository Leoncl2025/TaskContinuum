import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  FILE_TRANSFER_LIMITS, FileTransferError, fetchRequestSchema, readFileRequestSchema,
  transferDeviceSchema, transferErrorCodeSchema, transferFailure, transferLookupSchema, transferStatusSchema,
} from '../../shared/fileTransfer'
import type { FileTransferApi, TransferErrorCode } from '../../shared/fileTransfer'

export const MAX_BRIDGE_REQUEST_BYTES = 64 * 1024
export const MAX_BRIDGE_RESPONSE_BYTES = 256 * 1024
export const MAX_BRIDGE_REQUESTS = 8
export const workspaceRootSchema = z.string().min(1).max(4096).refine((value) => isAbsolute(value) && !value.includes('\0'))
const workspace = workspaceRootSchema
export const bridgeRequestSchema = z.discriminatedUnion('method', [
  z.object({ workspace, method: z.literal('devices'), arguments: z.object({}).strict() }).strict(),
  z.object({ workspace, method: z.literal('fetch'), arguments: fetchRequestSchema }).strict(),
  z.object({ workspace, method: z.literal('status'), arguments: transferLookupSchema }).strict(),
  z.object({ workspace, method: z.literal('resume'), arguments: transferLookupSchema }).strict(),
  z.object({ workspace, method: z.literal('cancel'), arguments: transferLookupSchema }).strict(),
  z.object({ workspace, method: z.literal('read'), arguments: readFileRequestSchema }).strict(),
])
export type BridgeRequest = z.infer<typeof bridgeRequestSchema>
export const bridgeErrorSchema = z.object({
  error: z.object({ code: transferErrorCodeSchema, message: z.string().max(512) }).strict(),
}).strict()

const messages: Record<TransferErrorCode, string> = {
  INVALID_REQUEST: 'Invalid file transfer request. Check the tool arguments and pagination limits.',
  ACCESS_DENIED: 'File access is not authorized. Check the workspace, device pairing and local bridge configuration.',
  NOT_FOUND: 'The requested device, transfer or file was not found.',
  UNSUPPORTED: 'This device does not support file transfer. Update both Task Continuum desktops.',
  BUSY: 'File transfer capacity is busy. Retry when the current operation finishes.',
  QUOTA_EXCEEDED: 'The file count, size or retained-storage limit was exceeded.',
  SOURCE_CHANGED: 'The source changed during transfer. Start a new request with a new requestId.',
  LOGS_DISABLED: 'Agent Host diagnostic logging is disabled on the source device. Enable it there before collecting logs.',
  LOGS_MISSING: 'Agent Host diagnostic logs are not available on the source device.',
  NO_RECORDS: 'No log records match the requested time range.',
  EXPIRED: 'This transfer has expired. Start a new request with a new requestId.',
  CANCELLED: 'This transfer was cancelled.',
  INTEGRITY_FAILED: 'File integrity verification failed. Do not use the transferred content.',
  IO_ERROR: 'File transfer could not access its data. Check permissions and available disk space.',
  UNAVAILABLE: 'Task Continuum or the source device is unavailable. Reconnect and explicitly resume the transfer.',
  NOT_TEXT: 'This file cannot be read as text.',
}

export function safeFailure(error: unknown): { code: TransferErrorCode; message: string } {
  const { code } = transferFailure(error)
  return { code, message: messages[code] }
}

export const filePageSchema = z.object({
  fileId: z.uuid(), text: z.string().max(FILE_TRANSFER_LIMITS.readBytes),
  offset: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative(),
  eof: z.boolean(), truncated: z.boolean(),
}).strict()

export function validateResult(request: BridgeRequest, value: unknown) {
  try {
    if (request.method === 'devices') return z.array(transferDeviceSchema).max(1024).parse(value).map((device) => ({
      ...device,
      ...(device.error !== undefined ? { error: messages[device.fileTransfer === 'unsupported' ? 'UNSUPPORTED' : 'UNAVAILABLE'] } : {}),
    }))
    if (request.method === 'read') {
      const page = filePageSchema.parse(value)
      const { fileId, offset, maxBytes } = request.arguments
      if (page.fileId !== fileId || page.offset !== offset || page.nextOffset < offset
        || page.nextOffset - offset > maxBytes || Buffer.byteLength(page.text) > maxBytes
        || (!page.eof && page.nextOffset === offset)) throw new Error('Invalid page')
      return page
    }
    const status = transferStatusSchema.parse(value)
    if (status.files.some((file) => file.name.includes('/') || file.name.includes('\\')
      || [...file.name].some((character) => character.charCodeAt(0) < 32))) throw new Error('Invalid file name')
    return { ...status, ...(status.error ? { error: safeFailure(new FileTransferError(status.error.code, '')) } : {}) }
  } catch {
    throw new FileTransferError('UNAVAILABLE', 'Invalid file transfer response.')
  }
}

export async function invokeApi(api: FileTransferApi, request: BridgeRequest) {
  switch (request.method) {
    case 'devices': return api.devices()
    case 'fetch': return api.fetch(request.arguments)
    case 'status': return api.status(request.arguments.transferId)
    case 'resume': return api.resume(request.arguments.transferId)
    case 'cancel': return api.cancel(request.arguments.transferId)
    case 'read': return api.read(request.arguments)
  }
}
