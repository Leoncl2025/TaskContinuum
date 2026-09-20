import { request } from 'node:http'
import { agentHostCreationErrorMessages } from '../shared/agentHostCreation'
import type { AgentHostCreationErrorCode } from '../shared/agentHostCreation'
import { agentHostCreationErrorResponseSchema } from './agentHostCreationProtocol'

export class DeviceRequestError extends Error {
  constructor(readonly status: number, agentHostCreation = false, readonly creationCode?: AgentHostCreationErrorCode) {
    super(agentHostCreation && status === 503 && creationCode ? agentHostCreationErrorMessages[creationCode] : agentHostCreation
      ? status === 401 || status === 403 ? 'The worker send permission or device pairing is unavailable, revoked, or expired.'
        : status === 404 ? 'This worker does not support the requested Agent Host creation operation. Update Task Continuum on the worker.'
          : status === 400 || status === 409 ? 'The creation request or task binding conflicts with the worker state. Refresh the same operation; do not create a replacement.'
            : 'The Agent Host worker could not confirm this operation. Check its status using the same operation ID.'
      : status === 401 || status === 403 ? 'Device or native Agent Host access was revoked or expired.'
        : status === 404 ? 'This operation is unsupported. Update Task Continuum on the execution machine.'
          : status === 400 || status === 409 ? 'The native Agent Host operation conflicts with its current state. Inspect the original session before retrying.'
            : 'The execution device or native Agent Host is unavailable. Reconnect the owner; no replacement session was selected.')
  }
}

export async function deviceRequest(port: number, remotePort: number, token: string, path: string, value: unknown, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const deadline = AbortSignal.timeout(15000)
    const cancellation = AbortSignal.any([signal, deadline])
    const creation = ['/device/agent-host/workers', '/device/agent-host/create', '/device/agent-host/creation-status', '/device/agent-host/creation-bind'].includes(path)
    const stage = creation ? 'Agent Host creation operation' : path === '/device/agent-host/sessions' ? 'Agent Host session discovery' : path === '/device/identity' ? 'Device identity verification' : 'Device operation'
    const failed = (error: Error) => {
      if (!cancellation.aborted) { reject(error); return }
      const timedOut = cancellation.reason?.name === 'TimeoutError'
      const outcome = path.endsWith('/create') || path.endsWith('/creation-bind') ? 'The outcome is not confirmed; query the same operation ID. No automatic creation retry.' : 'No message was sent by this operation.'
      reject(new Error(`${stage} ${timedOut ? 'timed out waiting for the owner' : 'was cancelled'}. ${outcome}`, { cause: error }))
    }
    const operation = request({ hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { Host: `127.0.0.1:${remotePort}`, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: cancellation,
    }, (response) => {
      response.on('error', failed)
      const status = response.statusCode ?? 500
      const diagnostic = creation && status === 503 && response.headers['content-type']?.split(';')[0].trim().toLowerCase() === 'application/json'
      if (status !== 200 && !diagnostic) {
        response.destroy()
        reject(new DeviceRequestError(status, creation))
        return
      }
      const chunks: Buffer[] = []
      let length = 0
      response.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > (diagnostic ? 4096 : 4 * 1024 * 1024)) response.destroy(new Error('Device response exceeds its limit.'))
        else chunks.push(chunk)
      })
      response.on('end', () => {
        let value: unknown
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
          reject(diagnostic ? new DeviceRequestError(status, creation) : new Error('Invalid device response.'))
          return
        }
        if (diagnostic) {
          const result = agentHostCreationErrorResponseSchema.safeParse(value)
          reject(new DeviceRequestError(status, creation, result.success ? result.data.error.code : undefined))
        } else resolve(value)
      })
    })
    operation.on('error', failed)
    operation.end(JSON.stringify(value))
  })
}