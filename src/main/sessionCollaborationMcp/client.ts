import { request as httpRequest } from 'node:http'
import { z } from 'zod'
import { CollaborationError } from '../../shared/sessionCollaboration'
import type {
  CollaborationContextResult, CollaborationMessageStatus, CollaborationSessionsListResult,
  LocalCollaborationEndpoint, SessionCollaborationApi,
} from '../../shared/sessionCollaboration'
import { readCollaborationEndpoint } from './descriptor'
import {
  MAX_COLLAB_BRIDGE_REQUEST_BYTES, MAX_COLLAB_BRIDGE_REQUESTS, MAX_COLLAB_BRIDGE_RESPONSE_BYTES,
  collaborationBridgeErrorSchema, collaborationBridgeRequestSchema, collaborationWorkspaceRootSchema,
  validateCollaborationResult,
} from './protocol'
import type { CollaborationBridgeRequest } from './protocol'

function send(endpoint: LocalCollaborationEndpoint, body: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const authHeader = ['Bearer', endpoint.token].join(' ')
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: endpoint.port,
      path: '/mcp/collab',
      method: 'POST',
      agent: false,
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_COLLAB_BRIDGE_RESPONSE_BYTES) {
          request.destroy(new CollaborationError('UNAVAILABLE', ''))
          return
        }
        chunks.push(chunk)
      })
      response.on('error', () => reject(new CollaborationError('UNAVAILABLE', '')))
      response.on('end', () => {
        if (response.statusCode === undefined || ![200, 400, 403, 503].includes(response.statusCode)
          || response.headers['content-type'] !== 'application/json') {
          reject(new CollaborationError('UNAVAILABLE', ''))
          return
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) }
        catch { reject(new CollaborationError('UNAVAILABLE', '')) }
      })
    })
    const deadline = setTimeout(() => request.destroy(new CollaborationError('UNAVAILABLE', '')), 120_000)
    deadline.unref()
    request.on('close', () => clearTimeout(deadline))
    request.on('error', () => reject(new CollaborationError('UNAVAILABLE', '')))
    request.end(body)
  })
}

export function createCollaborationBridgeApi(directory: string, configuredWorkspace: string): SessionCollaborationApi {
  const workspace = collaborationWorkspaceRootSchema.parse(configuredWorkspace)
  let active = 0
  async function call(method: CollaborationBridgeRequest['method'], args: unknown) {
    if (active >= MAX_COLLAB_BRIDGE_REQUESTS) throw new CollaborationError('BUSY', '')
    active++
    try {
      const request = collaborationBridgeRequestSchema.parse({ workspace, method, arguments: args })
      const body = JSON.stringify(request)
      if (Buffer.byteLength(body) > MAX_COLLAB_BRIDGE_REQUEST_BYTES) throw new CollaborationError('INVALID_REQUEST', '')
      const response = await send(await readCollaborationEndpoint(directory), body)
      const failure = collaborationBridgeErrorSchema.safeParse(response)
      if (failure.success) throw new CollaborationError(failure.data.error.code, failure.data.error.message)
      const success = z.object({ result: z.unknown() }).strict().safeParse(response)
      if (!success.success) throw new CollaborationError('UNAVAILABLE', '')
      return validateCollaborationResult(request, success.data.result)
    } finally { active-- }
  }
  return {
    listSessions: async (request) => await call('listSessions', request) as CollaborationSessionsListResult,
    readContext: async (request) => await call('readContext', request) as CollaborationContextResult,
    sendMessage: async (request) => await call('sendMessage', request) as CollaborationMessageStatus,
    messageStatus: async (messageId) => await call('messageStatus', { messageId }) as CollaborationMessageStatus,
  }
}
