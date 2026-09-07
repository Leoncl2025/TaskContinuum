import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hostname, userInfo } from 'node:os'
import { z } from 'zod'
import { VSCodeSessionStore } from './vscodeSessions'
import { writeJsonAtomic } from './shared/storage'
import { vsCodeChatResource } from '../shared/vscodeChat'
import { VSCodeChatDeliveryService } from './vscodeChatDelivery'
import type { VSCodeDispatch } from './vscodeChatDelivery'

export const vscodeIdentitySchema = z.object({ nativeSessionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/), workspaceStorageId: z.string().regex(/^[a-f0-9]{32}$/) }).strict()
export const companionSchema = z.object({
  protocol: z.literal(1), instanceId: z.uuid(), workspaceStorageId: z.string().regex(/^[a-f0-9]{32}$/),
  port: z.number().int().min(1024).max(65535), token: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
  vscodeVersion: z.string().min(1).max(100), pid: z.number().int().positive(),
}).strict()

export async function startVSCodeChatCompanion(options: {
  storageRoot: string
  workspaceStorageId: string
  discoveryDirectory: string
  vscodeVersion: string
  open(resource: string): Promise<void>
  dispatch?: VSCodeDispatch
}) {
  const workspaceStorageId = z.string().regex(/^[a-f0-9]{32}$/).parse(options.workspaceStorageId)
  const storageRoot = await realpath(options.storageRoot)
  const store = new VSCodeSessionStore([storageRoot])
  const token = randomBytes(32).toString('base64url')
  const instanceId = randomUUID()
  const participant = { username: userInfo().username, machineName: hostname() }
  const execution = { agentName: 'GitHub Copilot', machineName: hostname() }
  const deliveries = options.dispatch ? new VSCodeChatDeliveryService(dirname(options.discoveryDirectory), store, participant, execution, options.dispatch) : undefined
  let opening = false
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('Content-Type', 'application/json')
      response.setHeader('Cache-Control', 'no-store')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Bridge unavailable.')
      const expectedHost = `127.0.0.1:${address.port}`
      if (request.headers.origin !== undefined || request.headers.host !== expectedHost) { response.writeHead(403).end('{}'); return }
      const supplied = request.headers.authorization ?? ''
      const expected = `Bearer ${token}`
      if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
        response.writeHead(401).end('{}'); return
      }
      if (request.method === 'GET' && request.url === '/identity') {
        response.end(JSON.stringify({ protocol: 1, instanceId, workspaceStorageId, vscodeVersion: options.vscodeVersion, participant, execution, capabilities: { open: true, send: Boolean(deliveries) } })); return
      }
      if (request.method !== 'POST' || !['/open', '/send', '/deliveries'].includes(request.url ?? '') || request.url !== '/open' && !deliveries) { response.writeHead(404).end('{}'); return }
      if (!request.headers['content-type']?.startsWith('application/json')) { response.writeHead(415).end('{}'); return }
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        const value = Buffer.from(chunk)
        bytes += value.byteLength
        if (bytes > 32768) { response.writeHead(413).end('{}'); return }
        chunks.push(value)
      }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const submission = request.url === '/send' ? vscodeIdentitySchema.extend({ id: z.uuid(), text: z.string().trim().min(1).max(4000) }).strict().parse(input) : undefined
      const identity = submission ? { nativeSessionId: submission.nativeSessionId, workspaceStorageId: submission.workspaceStorageId } : vscodeIdentitySchema.parse(input)
      if (identity.workspaceStorageId !== workspaceStorageId) { response.writeHead(403).end(JSON.stringify({ error: 'This is a different VS Code workspace.' })); return }
      if (submission) {
        response.end(JSON.stringify(await deliveries!.submit(identity, { id: submission.id, text: submission.text }))); return
      }
      if (request.url === '/deliveries') {
        response.end(JSON.stringify(await deliveries!.list(identity))); return
      }
      if (opening) { response.writeHead(409).end(JSON.stringify({ error: 'Another original conversation is being opened. Retry after it finishes.' })); return }
      opening = true
      try {
        const original = await store.locateOriginal(identity)
        if (!original.snapshot.messages.length) throw new Error('The original conversation has no saved history. Open it in VS Code directly.')
        await options.open(vsCodeChatResource(identity.nativeSessionId))
        response.end(JSON.stringify({ opened: true, ...identity }))
      } finally { opening = false }
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 1000) : 'The original conversation could not be opened.' }))
      else response.end()
    })
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Bridge failed to bind to loopback.')
  const descriptor = companionSchema.parse({ protocol: 1, instanceId, workspaceStorageId, port: address.port, token, vscodeVersion: options.vscodeVersion, pid: process.pid })
  const file = join(options.discoveryDirectory, `${instanceId}.json`)
  try {
    await mkdir(options.discoveryDirectory, { recursive: true })
    await writeJsonAtomic(file, descriptor, true)
  } catch (error) { server.closeAllConnections(); server.close(); throw error }
  return {
    descriptor,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      try { await deliveries?.close() } finally { await rm(file, { force: true }) }
    },
  }
}