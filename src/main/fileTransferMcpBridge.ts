import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { FileTransferError } from '../shared/fileTransfer'
import type { FileTransferApi } from '../shared/fileTransfer'
import { removeEndpoint, writeEndpoint } from './fileTransferMcp/descriptor'
import {
  MAX_BRIDGE_REQUEST_BYTES, MAX_BRIDGE_REQUESTS, MAX_BRIDGE_RESPONSE_BYTES,
  bridgeRequestSchema, invokeApi, safeFailure, validateResult,
} from './fileTransferMcp/protocol'

function respond(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed) return
  const json = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close',
  })
  response.end(json)
}

function rejected(response: ServerResponse, status: number, code: 'ACCESS_DENIED' | 'INVALID_REQUEST' | 'BUSY'): void {
  respond(response, status, { error: safeFailure(new FileTransferError(code, '')) })
}

function body(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const onData = (bytes: Buffer) => {
      size += bytes.length
      if (size > MAX_BRIDGE_REQUEST_BYTES) {
        request.off('data', onData)
        reject(new FileTransferError('INVALID_REQUEST', ''))
        return
      }
      chunks.push(bytes)
    }
    request.on('data', onData)
    request.once('error', () => reject(new FileTransferError('INVALID_REQUEST', '')))
    request.once('end', () => {
      request.off('data', onData)
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) }
      catch { reject(new FileTransferError('INVALID_REQUEST', '')) }
    })
  })
}

export async function startFileTransferMcpBridge(
  directory: string, apiForWorkspace: (root: string) => FileTransferApi,
): Promise<{ close(): Promise<void> }> {
  const token = randomBytes(32).toString('base64url')
  const expectedAuth = Buffer.from(`Bearer ${token}`)
  let port = 0
  let active = 0
  const server = createServer({
    maxHeaderSize: 4096, headersTimeout: 5000, requestTimeout: 10_000,
    keepAliveTimeout: 1000, connectionsCheckingInterval: 1000,
  }, (request, response) => {
    const auth = Buffer.from(request.headers.authorization ?? '')
    const rawCount = (header: string) => request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === header).length
    if (request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${port}`
      || rawCount('host') !== 1 || rawCount('authorization') !== 1
      || auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) {
      rejected(response, 403, 'ACCESS_DENIED')
      return
    }
    if (request.method !== 'POST' || request.url !== '/mcp/files'
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')
      || request.headers['content-encoding'] !== undefined
      || Number(request.headers['content-length'] ?? 0) > MAX_BRIDGE_REQUEST_BYTES) {
      rejected(response, 400, 'INVALID_REQUEST')
      return
    }
    if (active >= MAX_BRIDGE_REQUESTS) { rejected(response, 503, 'BUSY'); return }
    active++
    void (async () => {
      try {
        const requestBody = bridgeRequestSchema.parse(await body(request))
        const result = validateResult(requestBody, await invokeApi(apiForWorkspace(requestBody.workspace), requestBody))
        const payload = { result }
        if (Buffer.byteLength(JSON.stringify(payload)) > MAX_BRIDGE_RESPONSE_BYTES) throw new FileTransferError('UNAVAILABLE', '')
        respond(response, 200, payload)
      } catch (error) {
        const failure = safeFailure(error)
        respond(response, failure.code === 'INVALID_REQUEST' ? 400 : 200, { error: failure })
      } finally { active-- }
    })()
  })
  server.maxConnections = 32
  server.on('clientError', (_error, socket) => { socket.destroy() })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); throw new FileTransferError('UNAVAILABLE', '') }
  port = address.port
  const endpoint = { schemaVersion: 1 as const, port, token }
  async function closeServer(): Promise<void> {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
  try { await writeEndpoint(directory, endpoint) } catch (error) { await closeServer(); throw error }
  let closing: Promise<void> | undefined
  return {
    close: () => closing ??= (async () => { await closeServer(); await removeEndpoint(directory, endpoint) })(),
  }
}
