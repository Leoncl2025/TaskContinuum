import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  CollaborationError, collaborationContextRequestSchema, collaborationContextResultSchema,
  collaborationErrorCodeSchema, collaborationFailure, collaborationMessageLookupSchema,
  collaborationMessageStatusSchema, collaborationSendRequestSchema,
  collaborationSessionsListRequestSchema, collaborationSessionsListResultSchema,
} from '../../shared/sessionCollaboration'
import type { CollaborationErrorCode, SessionCollaborationApi } from '../../shared/sessionCollaboration'

export const MAX_COLLAB_BRIDGE_REQUEST_BYTES = 64 * 1024
export const MAX_COLLAB_BRIDGE_RESPONSE_BYTES = 256 * 1024
export const MAX_COLLAB_BRIDGE_REQUESTS = 8

export const collaborationWorkspaceRootSchema = z.string().min(1).max(4096)
  .refine((value) => isAbsolute(value) && !value.includes('\0'))
const workspace = collaborationWorkspaceRootSchema

export const collaborationBridgeRequestSchema = z.discriminatedUnion('method', [
  z.object({ workspace, method: z.literal('listSessions'), arguments: collaborationSessionsListRequestSchema }).strict(),
  z.object({ workspace, method: z.literal('readContext'), arguments: collaborationContextRequestSchema }).strict(),
  z.object({ workspace, method: z.literal('sendMessage'), arguments: collaborationSendRequestSchema }).strict(),
  z.object({ workspace, method: z.literal('messageStatus'), arguments: collaborationMessageLookupSchema }).strict(),
])
export type CollaborationBridgeRequest = z.infer<typeof collaborationBridgeRequestSchema>

export const collaborationBridgeErrorSchema = z.object({
  error: z.object({ code: collaborationErrorCodeSchema, message: z.string().max(512) }).strict(),
}).strict()

const defaultMessages: Record<CollaborationErrorCode, string> = {
  INVALID_REQUEST: 'Invalid session collaboration request. Check taskId, targetRef, messageId, and limits.',
  ACCESS_DENIED: 'Session collaboration is not authorized. Check workspace and session access and the task collaboration settings.',
  COLLABORATION_PAUSED: 'Session collaboration is currently paused for this task in Task Continuum.',
  NOT_FOUND: 'The requested task, linked target session, or collaboration message was not found.',
  CONFLICT: 'This messageId already belongs to a different collaboration request.',
  BUSY: 'Session collaboration capacity is busy. Retry when active requests complete.',
  QUOTA_EXCEEDED: 'The task collaboration message or queue limit was exceeded.',
  EXPIRED: 'This queued collaboration message expired before the target session became idle.',
  UNAVAILABLE: 'Task Continuum or the target Agent Host session is unavailable.',
}

export function safeCollaborationFailure(error: unknown): { code: CollaborationErrorCode; message: string } {
  const { code, message } = collaborationFailure(error)
  if (error instanceof CollaborationError && message && message.length <= 320 && !/[\\/]/.test(message)) {
    return { code, message }
  }
  return { code, message: defaultMessages[code] }
}

export function validateCollaborationResult(request: CollaborationBridgeRequest, value: unknown) {
  try {
    switch (request.method) {
      case 'listSessions': return collaborationSessionsListResultSchema.parse(value)
      case 'readContext': return collaborationContextResultSchema.parse(value)
      case 'sendMessage':
      case 'messageStatus': return collaborationMessageStatusSchema.parse(value)
    }
  } catch {
    throw new CollaborationError('UNAVAILABLE', '')
  }
}

export async function invokeCollaborationApi(api: SessionCollaborationApi, request: CollaborationBridgeRequest) {
  switch (request.method) {
    case 'listSessions': return api.listSessions(request.arguments)
    case 'readContext': return api.readContext(request.arguments)
    case 'sendMessage': return api.sendMessage(request.arguments)
    case 'messageStatus': return api.messageStatus(request.arguments.messageId)
  }
}
