import { z } from 'zod'
import { exportManifestSchema, FILE_TRANSFER_LIMITS, transferStatusSchema } from './fileTransfer'
import type { TransferStatus } from './fileTransfer'

export const deliverySenderSchema = z.object({
  pairId: z.uuid(), clientId: z.uuid(), inboxId: z.uuid(),
}).strict()
export type DeliverySender = z.infer<typeof deliverySenderSchema>
export const incomingSelectionSchema = deliverySenderSchema.extend({ kind: z.literal('incoming') }).strict()
export const incomingRequestSchema = z.object({
  deviceId: z.uuid(), requestId: z.uuid(), selection: incomingSelectionSchema,
}).strict()
export const sendFilesSchema = z.object({
  requestId: z.uuid(), targetDeviceId: z.uuid(), targetInboxId: z.uuid(),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(FILE_TRANSFER_LIMITS.files),
}).strict()
export type SendFilesRequest = z.infer<typeof sendFilesSchema>
export const deliveryDestinationSchema = z.object({
  inboxId: z.uuid(), label: z.string().min(1).max(200), clientId: z.uuid(),
}).strict()
export type DeliveryDestination = z.infer<typeof deliveryDestinationSchema>
export const deliveryCapabilitiesSchema = z.object({
  protocolVersion: z.literal(2), ownerId: z.uuid(), pairId: z.uuid(), clientId: z.uuid(),
  inboxes: z.array(deliveryDestinationSchema).max(100),
}).strict()
export const deliveryPrepareSchema = z.object({ inboxId: z.uuid(), manifest: exportManifestSchema }).strict()
export const deliveryLookupSchema = z.object({ inboxId: z.uuid(), transferId: z.uuid() }).strict()
export const deliveryChunkSchema = deliveryLookupSchema.extend({
  fileId: z.uuid(), offset: z.number().int().min(0).max(FILE_TRANSFER_LIMITS.fileBytes),
}).strict()
export const deliveryReceiptSchema = z.object({
  status: transferStatusSchema,
  offsets: z.record(z.uuid(), z.number().int().min(0).max(FILE_TRANSFER_LIMITS.fileBytes)),
}).strict()
export type DeliveryReceipt = z.infer<typeof deliveryReceiptSchema>
export const saveReceivedFileSchema = z.object({
  transferId: z.uuid(), fileId: z.uuid(), destinationRootId: z.uuid(),
  relativePath: z.string().min(1).max(4096),
}).strict()
export type SaveReceivedFileRequest = z.infer<typeof saveReceivedFileSchema>
export const savedReceivedFileSchema = z.object({
  path: z.string().min(1).max(8192), sizeBytes: z.number().int().min(0).max(FILE_TRANSFER_LIMITS.fileBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type SavedReceivedFile = z.infer<typeof savedReceivedFileSchema>
export const deliveryInboxRequestSchema = z.object({
  cursor: z.uuid().optional(), limit: z.number().int().min(1).max(20).default(20),
}).strict()
export type DeliveryInboxRequest = z.infer<typeof deliveryInboxRequestSchema>
export const deliveryInboxSchema = z.object({
  transfers: z.array(transferStatusSchema).max(20), nextCursor: z.uuid().optional(),
  destinations: z.array(z.object({ id: z.uuid(), label: z.string().max(200) }).strict()).max(20),
}).strict()
export type DeliveryInbox = z.infer<typeof deliveryInboxSchema>
export interface DeliveryApi {
  destinations(deviceId: string): Promise<DeliveryDestination[]>
  send(request: SendFilesRequest): Promise<TransferStatus>
  inbox(request: DeliveryInboxRequest): Promise<DeliveryInbox>
  save(request: SaveReceivedFileRequest): Promise<SavedReceivedFile>
}
export interface FileDeliverySettings {
  inboxId: string
  senders: { clientId: string; machineName: string; allowed: boolean }[]
  roots: { id: string; path: string }[]
  transfers: { direction: 'incoming' | 'outgoing'; status: TransferStatus }[]
  configurations: { vscode: string; mcpServers: string }
  nodeVersion?: string
  error?: string
}
export interface FileDeliveryBridge {
  settings(): Promise<FileDeliverySettings>
  setSender(clientId: string, allowed: boolean): Promise<void>
  addDestination(): Promise<void>
  removeDestination(id: string): Promise<void>
  resume(transferId: string): Promise<TransferStatus>
  cancel(transferId: string): Promise<TransferStatus>
}
