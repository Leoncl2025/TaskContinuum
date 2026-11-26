import { z } from 'zod'
import type { AgentHostTarget } from './agentHost'
import { MAX_CHAT_TEXT_LENGTH } from './chatAttachments'

export const COLLABORATION_MCP_DESCRIPTOR = 'session-collaboration-mcp.json'

export const COLLABORATION_LIMITS = {
  maxMessageLength: MAX_CHAT_TEXT_LENGTH,
  maxQueuedPerTask: 16,
  maxRetainedMessages: 200,
  messageTtlMs: 30 * 60 * 1000,
  maxSessionPageSize: 20,
  maxSessionListTitleLength: 512,
  defaultContextTurns: 5,
  maxContextTurns: 20,
  maxContextBytes: 64 * 1024,
  maxConcurrentOperations: 4,
  maxToolRequestBytes: 64 * 1024,
} as const

export const collaborationTaskIdSchema = z.string().max(64).regex(/^T-\d{4,}$/)
const collaborationMachineSchema = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/)
const collaborationSessionIdSchema = z.string().max(512).regex(/^(ahp-session|copilotcli):\/[^\s?#]+$/)
const collaborationChatIdSchema = z.string().max(512).regex(/^ahp-chat:\/[^\s?#]+$/)

export const collaborationOwnerSchema = z.object({
  clientId: z.uuid(),
  machineName: collaborationMachineSchema,
}).strict()

export const collaborationSenderDeviceSchema = collaborationOwnerSchema.extend({
  username: z.string().trim().min(1).max(300).optional(),
}).strict()

export const collaborationTargetSchema = z.object({
  sessionId: collaborationSessionIdSchema,
  chatId: collaborationChatIdSchema,
  owner: collaborationOwnerSchema,
}).strict()

export const taskContinuumCollaborationMetaSchema = z.object({
  version: z.literal(1),
  taskId: collaborationTaskIdSchema,
  messageId: z.uuid(),
  senderDevice: collaborationSenderDeviceSchema,
  sourceKind: z.enum(['mcp-client', 'agent-host-client']),
  sourceTarget: collaborationTargetSchema.optional(),
}).strict()

// Keep the strict v1 wire metadata readable by older versions.
export const RELAYED_COLLABORATION_SOURCE_KEY = 'taskcontinuumRelayedSource'
const relayedCollaborationSourceSchema = collaborationTargetSchema.extend({
  owner: collaborationOwnerSchema.pick({ clientId: true }),
})
export type RelayedCollaborationSource = z.infer<typeof relayedCollaborationSourceSchema>
export const taskContinuumCollaborationSendMetaSchema = taskContinuumCollaborationMetaSchema.extend({
  relayedSourceTarget: relayedCollaborationSourceSchema.optional(),
}).refine(({ relayedSourceTarget, sourceTarget, sourceKind, senderDevice }) =>
  !relayedSourceTarget || (!sourceTarget && sourceKind === 'agent-host-client' && relayedSourceTarget.owner.clientId !== senderDevice.clientId),
'A relayed source must reference a separate Agent Host chat without asserting its owner as the sender.')
export type TaskContinuumCollaborationMeta = z.infer<typeof taskContinuumCollaborationSendMetaSchema>

export type NativeDelegationMeta =
  | { kind: 'thread'; sourceThreadId: string }
  | {
    kind: 'session'
    sourceSession: string
    sourceChat?: string
    sourceTurnId?: string
    messageId?: string
    revision?: number
  }

export function readNativeDelegationMeta(meta: Record<string, unknown> | undefined): NativeDelegationMeta | undefined {
  const raw = meta?.['vscode.chat.delegation']
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.sourceThreadId === 'string' && candidate.sourceThreadId.length > 0 && candidate.sourceThreadId.length <= 512) {
    return { kind: 'thread', sourceThreadId: candidate.sourceThreadId }
  }
  if (typeof candidate.sourceSession !== 'string' || candidate.sourceSession.length === 0 || candidate.sourceSession.length > 512) {
    return undefined
  }
  return {
    kind: 'session',
    sourceSession: candidate.sourceSession,
    ...(typeof candidate.sourceChat === 'string' && candidate.sourceChat.length <= 512 ? { sourceChat: candidate.sourceChat } : {}),
    ...(typeof candidate.sourceTurnId === 'string' && candidate.sourceTurnId.length <= 200 ? { sourceTurnId: candidate.sourceTurnId } : {}),
    ...(typeof candidate.messageId === 'string' && candidate.messageId.length > 0 && candidate.messageId.length <= 200 ? { messageId: candidate.messageId } : {}),
    ...(typeof candidate.revision === 'number' && Number.isSafeInteger(candidate.revision) && candidate.revision > 0 ? { revision: candidate.revision } : {}),
  }
}

export function readTaskContinuumCollaborationMeta(meta: Record<string, unknown> | undefined): TaskContinuumCollaborationMeta | undefined {
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, 'taskcontinuumCollaboration')) return undefined
  const parsed = taskContinuumCollaborationMetaSchema.safeParse(meta.taskcontinuumCollaboration)
  if (!parsed.success) return undefined
  if (!Object.hasOwn(meta, RELAYED_COLLABORATION_SOURCE_KEY)) return parsed.data
  const withSource = taskContinuumCollaborationSendMetaSchema.safeParse({ ...parsed.data, relayedSourceTarget: meta[RELAYED_COLLABORATION_SOURCE_KEY] })
  return withSource.success ? withSource.data : parsed.data
}

export interface ParsedCollaborationTargetRef {
  taskId: string
  ownerClientId: string
  sessionId: string
  chatId: string
}

export function formatCollaborationTargetRef(taskId: string, target: Pick<AgentHostTarget, 'sessionId' | 'chatId'> & { owner: { clientId: string } }): string {
  const validTask = collaborationTaskIdSchema.parse(taskId)
  const validOwner = z.uuid().parse(target.owner.clientId)
  const validSession = collaborationSessionIdSchema.parse(target.sessionId)
  const validChat = collaborationChatIdSchema.parse(target.chatId)
  return `tc-session:${validTask}:${validOwner}:${encodeURIComponent(validSession)}:${encodeURIComponent(validChat)}`
}

export function parseCollaborationTargetRef(value: string): ParsedCollaborationTargetRef {
  const parts = value.split(':')
  if (parts.length !== 5 || parts[0] !== 'tc-session') throw new CollaborationError('INVALID_REQUEST', 'Invalid collaboration target reference.')
  let sessionId: string
  let chatId: string
  try {
    sessionId = decodeURIComponent(parts[3])
    chatId = decodeURIComponent(parts[4])
  } catch {
    throw new CollaborationError('INVALID_REQUEST', 'Invalid collaboration target reference.')
  }
  const parsed = z.object({
    taskId: collaborationTaskIdSchema,
    ownerClientId: z.uuid(),
    sessionId: collaborationSessionIdSchema,
    chatId: collaborationChatIdSchema,
  }).strict().safeParse({ taskId: parts[1], ownerClientId: parts[2], sessionId, chatId })
  if (!parsed.success) throw new CollaborationError('INVALID_REQUEST', 'Invalid collaboration target reference.')
  return parsed.data
}

export const collaborationTargetRefSchema = z.string().min(24).max(2048).refine((value) => {
  try { parseCollaborationTargetRef(value); return true }
  catch { return false }
}, 'Invalid collaboration targetRef.')

export const collaborationErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'ACCESS_DENIED',
  'NOT_FOUND',
  'CONFLICT',
  'BUSY',
  'EXPIRED',
  'UNAVAILABLE',
])
export type CollaborationErrorCode = z.infer<typeof collaborationErrorCodeSchema>

export class CollaborationError extends Error {
  constructor(readonly code: CollaborationErrorCode, message: string) {
    super(message)
    this.name = 'CollaborationError'
  }
}

export function collaborationFailure(error: unknown): { code: CollaborationErrorCode; message: string } {
  if (error instanceof CollaborationError) return { code: error.code, message: error.message }
  if (error instanceof z.ZodError) return { code: 'INVALID_REQUEST', message: 'Invalid session collaboration request.' }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return { code: 'UNAVAILABLE', message: 'Session collaboration timed out or was interrupted.' }
  }
  return { code: 'UNAVAILABLE', message: 'Task Continuum or the target Agent Host is currently unavailable.' }
}

const defaultCollaborationErrors: Record<CollaborationErrorCode, string> = {
  INVALID_REQUEST: 'Invalid session collaboration request. Check taskId, targetRef, messageId, and limits.',
  ACCESS_DENIED: 'Session collaboration is not authorized. Check workspace and linked session access.',
  NOT_FOUND: 'The requested task, linked target session, or collaboration message was not found.',
  CONFLICT: 'This messageId already belongs to a different collaboration request.',
  BUSY: 'Session collaboration capacity is busy. Retry after pending operations finish.',
  EXPIRED: 'This queued collaboration message expired before the target session became idle.',
  UNAVAILABLE: 'Task Continuum or the target Agent Host session is unavailable.',
}

export function safeCollaborationFailure(error: unknown): { code: CollaborationErrorCode; message: string } {
  const { code, message } = collaborationFailure(error)
  return {
    code,
    message: error instanceof CollaborationError && message && message.length <= 320 && !/[\\/]/.test(message)
      ? message : defaultCollaborationErrors[code],
  }
}

export const collaborationSessionsListRequestSchema = z.object({
  taskId: collaborationTaskIdSchema.optional().describe('Starting task for search priority, not a filter. Omit to browse the workspace.'),
  query: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(COLLABORATION_LIMITS.maxSessionPageSize).optional(),
  offset: z.number().int().nonnegative().max(1000).optional().describe('Use nextOffset from the previous page with the same task and query.'),
}).strict()
export type CollaborationSessionsListRequest = z.infer<typeof collaborationSessionsListRequestSchema>

export const collaborationSessionEntrySchema = z.object({
  targetRef: collaborationTargetRefSchema,
  taskId: collaborationTaskIdSchema,
  sessionId: collaborationSessionIdSchema,
  chatId: collaborationChatIdSchema,
  title: z.string().max(COLLABORATION_LIMITS.maxSessionListTitleLength),
  owner: collaborationOwnerSchema,
  location: z.enum(['local', 'remote']),
  state: z.enum(['connected', 'connecting', 'offline', 'available']),
  canSend: z.boolean(),
}).strict()
export type CollaborationSessionEntry = z.infer<typeof collaborationSessionEntrySchema>

export const collaborationSessionsListResultSchema = z.object({
  taskId: collaborationTaskIdSchema.optional(),
  collaboration: z.object({
    queuedCount: z.number().int().nonnegative(),
  }).strict(),
  sessions: z.array(collaborationSessionEntrySchema).max(COLLABORATION_LIMITS.maxSessionPageSize),
  nextOffset: z.number().int().positive().max(1000).optional(),
}).strict()
export type CollaborationSessionsListResult = z.infer<typeof collaborationSessionsListResultSchema>

export const collaborationContextRequestSchema = z.object({
  targetRef: collaborationTargetRefSchema,
  taskId: collaborationTaskIdSchema.optional().describe('Optional caller task hint. The targetRef selects the destination.'),
  cursor: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(COLLABORATION_LIMITS.maxContextTurns).default(COLLABORATION_LIMITS.defaultContextTurns),
  detail: z.enum(['summary', 'full']).default('summary'),
}).strict()
export type CollaborationContextRequest = z.infer<typeof collaborationContextRequestSchema>

export const collaborationContextTurnSchema = z.object({
  turnId: z.string().min(1).max(256),
  origin: z.enum(['user', 'agent', 'collaboration', 'tool', 'automation', 'systemNotification']),
  messageText: z.string().max(COLLABORATION_LIMITS.maxContextBytes),
  responseText: z.string().max(COLLABORATION_LIMITS.maxContextBytes),
  toolSummary: z.array(z.string().max(256)).max(64),
  truncated: z.boolean(),
}).strict()
export type CollaborationContextTurn = z.infer<typeof collaborationContextTurnSchema>

export const collaborationContextResultSchema = z.object({
  taskId: collaborationTaskIdSchema,
  targetRef: collaborationTargetRefSchema,
  title: z.string().max(2000),
  state: z.enum(['connecting', 'connected', 'offline']),
  canSend: z.boolean(),
  readOnly: z.boolean(),
  chatStatus: z.enum(['idle', 'inProgress', 'hasDraft', 'uncertainDelivery']),
  activeTurn: z.object({
    turnId: z.string().min(1).max(256),
    origin: z.enum(['user', 'agent', 'collaboration', 'tool', 'automation', 'systemNotification']),
    messagePreview: z.string().max(4096),
    responsePreview: z.string().max(8192),
    runningTools: z.array(z.string().max(256)).max(32),
  }).strict().optional(),
  pendingCount: z.number().int().nonnegative(),
  turns: z.array(collaborationContextTurnSchema).max(COLLABORATION_LIMITS.maxContextTurns),
  hasMoreHistory: z.boolean(),
  nextCursor: z.string().min(1).max(256).optional(),
  truncated: z.boolean(),
}).strict()
export type CollaborationContextResult = z.infer<typeof collaborationContextResultSchema>

export const collaborationSendRequestSchema = z.object({
  targetRef: collaborationTargetRefSchema,
  taskId: collaborationTaskIdSchema.optional().describe('Optional caller task hint. The targetRef selects the destination.'),
  messageId: z.uuid(),
  text: z.string().max(COLLABORATION_LIMITS.maxMessageLength).refine((value) => value.trim().length > 0, 'Collaboration message text cannot be empty.'),
}).strict()
export type CollaborationSendRequest = z.infer<typeof collaborationSendRequestSchema>

export const collaborationMessageLookupSchema = z.object({
  messageId: z.uuid(),
}).strict()
export type CollaborationMessageLookup = z.infer<typeof collaborationMessageLookupSchema>

export const collaborationDeliveryStateSchema = z.enum([
  'queued',
  'dispatching',
  'delivered',
  'uncertain',
  'blocked',
  'expired',
  'failed',
])
export type CollaborationDeliveryState = z.infer<typeof collaborationDeliveryStateSchema>

export const collaborationTurnStatusSchema = z.enum([
  'in-progress',
  'completed',
  'cancelled',
  'error',
  'unknown',
])
export type CollaborationTurnStatus = z.infer<typeof collaborationTurnStatusSchema>

export const collaborationMessageStatusSchema = z.object({
  messageId: z.uuid(),
  taskId: collaborationTaskIdSchema,
  targetRef: collaborationTargetRefSchema,
  state: collaborationDeliveryStateSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().optional(),
  deliveredAt: z.iso.datetime().optional(),
  turnId: z.uuid().optional(),
  turnStatus: collaborationTurnStatusSchema.optional(),
  reason: z.string().max(512).optional(),
}).strict()
export type CollaborationMessageStatus = z.infer<typeof collaborationMessageStatusSchema>

export interface SessionCollaborationApi {
  listSessions(request: CollaborationSessionsListRequest): Promise<CollaborationSessionsListResult>
  readContext(request: CollaborationContextRequest): Promise<CollaborationContextResult>
  sendMessage(request: CollaborationSendRequest): Promise<CollaborationMessageStatus>
  messageStatus(messageId: string): Promise<CollaborationMessageStatus>
}

export const localCollaborationEndpointSchema = z.object({
  schemaVersion: z.literal(1),
  port: z.number().int().min(1024).max(65535),
  token: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
}).strict()
export type LocalCollaborationEndpoint = z.infer<typeof localCollaborationEndpointSchema>
