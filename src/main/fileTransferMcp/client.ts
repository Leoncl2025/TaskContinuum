import { request as httpRequest } from 'node:http'
import { z } from 'zod'
import { FileTransferError } from '../../shared/fileTransfer'
import type { FilePage, FileTransferApi, TransferDevice, TransferStatus } from '../../shared/fileTransfer'
import { readEndpoint } from './descriptor'
import type { LocalFileEndpoint } from './descriptor'
import {
  MAX_BRIDGE_REQUEST_BYTES, MAX_BRIDGE_REQUESTS, MAX_BRIDGE_RESPONSE_BYTES,
  bridgeErrorSchema, bridgeRequestSchema, validateResult, workspaceRootSchema,
} from './protocol'
import type { BridgeRequest } from './protocol'

function send(endpoint: LocalFileEndpoint, body: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // A literal loopback address and node:http deliberately bypass proxy configuration and redirects.
    const request = httpRequest({
      hostname: '127.0.0.1', port: endpoint.port, path: '/mcp/files', method: 'POST', agent: false,
      headers: {
        Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BRIDGE_RESPONSE_BYTES) { request.destroy(new FileTransferError('UNAVAILABLE', '')); return }
        chunks.push(chunk)
      })
      response.on('error', () => reject(new FileTransferError('UNAVAILABLE', '')))
      response.on('end', () => {
        if (response.statusCode === undefined || ![200, 400, 403, 503].includes(response.statusCode)
          || response.headers['content-type'] !== 'application/json') {
          reject(new FileTransferError('UNAVAILABLE', ''))
          return
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) }
        catch { reject(new FileTransferError('UNAVAILABLE', '')) }
      })
    })
    const deadline = setTimeout(() => request.destroy(new FileTransferError('UNAVAILABLE', '')), 120_000)
    deadline.unref()
    request.on('close', () => clearTimeout(deadline))
    request.on('error', () => reject(new FileTransferError('UNAVAILABLE', '')))
    request.end(body)
  })
}

export function createBridgeApi(directory: string, configuredWorkspace: string): FileTransferApi {
  const workspace = workspaceRootSchema.parse(configuredWorkspace)
  let active = 0
  async function call(method: BridgeRequest['method'], args: unknown) {
    if (active >= MAX_BRIDGE_REQUESTS) throw new FileTransferError('BUSY', '')
    active++
    try {
      const request = bridgeRequestSchema.parse({ workspace, method, arguments: args })
      const body = JSON.stringify(request)
      if (Buffer.byteLength(body) > MAX_BRIDGE_REQUEST_BYTES) throw new FileTransferError('INVALID_REQUEST', '')
      const response = await send(await readEndpoint(directory), body)
      const failure = bridgeErrorSchema.safeParse(response)
      if (failure.success) throw new FileTransferError(failure.data.error.code, '')
      const success = z.object({ result: z.unknown() }).strict().safeParse(response)
      if (!success.success) throw new FileTransferError('UNAVAILABLE', '')
      return validateResult(request, success.data.result)
    } finally { active-- }
  }
  return {
    devices: async () => await call('devices', {}) as TransferDevice[],
    fetch: async (request) => await call('fetch', request) as TransferStatus,
    status: async (transferId) => await call('status', { transferId }) as TransferStatus,
    resume: async (transferId) => await call('resume', { transferId }) as TransferStatus,
    cancel: async (transferId) => await call('cancel', { transferId }) as TransferStatus,
    read: async (request) => await call('read', request) as FilePage,
  }
}
