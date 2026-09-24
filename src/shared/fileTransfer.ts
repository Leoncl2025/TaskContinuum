import { z } from 'zod'

export const FILE_TRANSFER_LIMITS = {
  chunkBytes: 256 * 1024,
  readBytes: 32 * 1024,
  fileBytes: 100 * 1024 * 1024,
  batchBytes: 100 * 1024 * 1024,
  files: 10,
  storageBytes: 500 * 1024 * 1024,
  transfers: 128,
  concurrent: 2,
  retentionMs: 24 * 60 * 60 * 1000,
} as const

export const transferErrorCodeSchema = z.enum([
  'INVALID_REQUEST', 'ACCESS_DENIED', 'NOT_FOUND', 'UNSUPPORTED', 'BUSY', 'QUOTA_EXCEEDED',
  'SOURCE_CHANGED', 'LOGS_DISABLED', 'LOGS_MISSING', 'NO_RECORDS', 'EXPIRED', 'CANCELLED',
  'INTEGRITY_FAILED', 'IO_ERROR', 'UNAVAILABLE', 'NOT_TEXT',
])
export type TransferErrorCode = z.infer<typeof transferErrorCodeSchema>
export class FileTransferError extends Error {
  constructor(readonly code: TransferErrorCode, message: string) { super(message); this.name = 'FileTransferError' }
}
export function transferFailure(error: unknown): { code: TransferErrorCode; message: string } {
  if (error instanceof FileTransferError) return { code: error.code, message: error.message }
  if (error instanceof z.ZodError) return { code: 'INVALID_REQUEST', message: 'Invalid file transfer request.' }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return { code: 'UNAVAILABLE', message: 'File transfer was interrupted; resume the same transfer when the device is available.' }
  return { code: 'IO_ERROR', message: 'File transfer could not access its data. Check device availability, file permissions and free disk space.' }
}
const logsSelection = z.object({
  kind: z.literal('logs'), source: z.literal('agent-host'),
  sinceUtc: z.iso.datetime().optional(), untilUtc: z.iso.datetime().optional(),
}).strict()
export const fileSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('files'), paths: z.array(z.string().min(1).max(4096)).min(1).max(FILE_TRANSFER_LIMITS.files) }).strict(),
  logsSelection,
]).refine((value) => value.kind !== 'logs' || !value.sinceUtc || !value.untilUtc || value.sinceUtc <= value.untilUtc,
  'The log time range is reversed.')
export type FileSelection = z.infer<typeof fileSelectionSchema>
export const exportRequestSchema = z.object({ transferId: z.uuid(), selection: fileSelectionSchema }).strict()
export type ExportRequest = z.infer<typeof exportRequestSchema>
export const transferFileSchema = z.object({
  fileId: z.uuid(), name: z.string().min(1).max(255), sizeBytes: z.number().int().min(0).max(FILE_TRANSFER_LIMITS.fileBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), mediaType: z.string().max(128),
}).strict()
export type TransferFile = z.infer<typeof transferFileSchema>
export const exportManifestSchema = z.object({
  transferId: z.uuid(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  files: z.array(transferFileSchema).min(1).max(FILE_TRANSFER_LIMITS.files),
}).strict().refine((value) => new Set(value.files.map((file) => file.fileId)).size === value.files.length
  && value.files.reduce((total, file) => total + file.sizeBytes, 0) <= FILE_TRANSFER_LIMITS.batchBytes
  && value.createdAt < value.expiresAt, 'Invalid transfer manifest.')
export type ExportManifest = z.infer<typeof exportManifestSchema>
export const transferLookupSchema = z.object({ transferId: z.uuid() }).strict()
export const chunkRequestSchema = transferLookupSchema.extend({
  fileId: z.uuid(), offset: z.number().int().nonnegative(),
}).strict()
export const transferDeviceSchema = z.object({
  deviceId: z.union([z.literal('local'), z.uuid()]), machineName: z.string(),
  state: z.enum(['connected', 'connecting', 'offline']), enabled: z.boolean(),
  fileTransfer: z.enum(['available', 'unsupported', 'unknown']),
  error: z.string().optional(),
}).strict()
export type TransferDevice = z.infer<typeof transferDeviceSchema>
export const fetchRequestSchema = z.object({
  deviceId: z.union([z.literal('local'), z.uuid()]),
  requestId: z.uuid(),
  selection: fileSelectionSchema,
}).strict()
export type FetchRequest = z.infer<typeof fetchRequestSchema>
export const transferStatusSchema = z.object({
  transferId: z.uuid(), deviceId: z.union([z.literal('local'), z.uuid()]),
  state: z.enum(['transferring', 'interrupted', 'delivered', 'cancelled', 'expired', 'failed']),
  receivedBytes: z.number().int().nonnegative(),
  files: z.array(transferFileSchema).max(FILE_TRANSFER_LIMITS.files),
  expiresAt: z.iso.datetime(),
  error: z.object({ code: transferErrorCodeSchema, message: z.string() }).strict().optional(),
}).strict()
export type TransferStatus = z.infer<typeof transferStatusSchema>
export const readFileRequestSchema = transferLookupSchema.extend({
  fileId: z.uuid(), offset: z.number().int().nonnegative().default(0),
  maxBytes: z.number().int().min(4).max(FILE_TRANSFER_LIMITS.readBytes).default(FILE_TRANSFER_LIMITS.readBytes),
}).strict()
export type ReadFileRequest = z.infer<typeof readFileRequestSchema>
export interface FilePage {
  fileId: string
  text: string
  offset: number
  nextOffset: number
  eof: boolean
  truncated: boolean
}
export interface FileTransferApi {
  devices(): Promise<TransferDevice[]>
  fetch(request: FetchRequest): Promise<TransferStatus>
  status(transferId: string): Promise<TransferStatus>
  resume(transferId: string): Promise<TransferStatus>
  cancel(transferId: string): Promise<TransferStatus>
  read(request: ReadFileRequest): Promise<FilePage>
}

export const FILE_MCP_DESCRIPTOR = 'file-transfer-mcp.json'
export const localFileEndpointSchema = z.object({
  schemaVersion: z.literal(1), port: z.number().int().min(1024).max(65535),
  token: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
}).strict()
