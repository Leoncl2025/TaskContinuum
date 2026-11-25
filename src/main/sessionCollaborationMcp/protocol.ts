import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  COLLABORATION_LIMITS, CollaborationError, collaborationContextRequestSchema, collaborationContextResultSchema,
  collaborationErrorCodeSchema, collaborationMessageLookupSchema,
  collaborationMessageStatusSchema, collaborationSendRequestSchema,
  collaborationSessionsListRequestSchema, collaborationSessionsListResultSchema,
} from '../../shared/sessionCollaboration'
import type { SessionCollaborationApi } from '../../shared/sessionCollaboration'

export const MAX_COLLAB_BRIDGE_REQUEST_BYTES = COLLABORATION_LIMITS.maxToolRequestBytes
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
