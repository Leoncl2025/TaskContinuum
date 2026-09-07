import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SharedEnrollment, SharedGrant } from '../../shared/sharedSessions'
import { SharedSessionHost } from './host'
import { grantSchema, identifier } from './schemas'

export interface SharedServerOptions {
  host: SharedSessionHost
  getGrants(): Promise<SharedGrant[]>
  checkpoint?: (grant: SharedGrant) => Promise<unknown>
  enroll?: (grant: SharedGrant, input: unknown) => Promise<SharedEnrollment>
  shutdown?: () => Promise<void>
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('JSON content is required.')
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    bytes += buffer.byteLength
    if (bytes > 65536) throw new Error('Request body exceeds 64 KB.')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(value))
}

export async function startSharedServer(options: SharedServerOptions, port = 0) {
  const streams = new Set<ServerResponse>()
  async function authenticate(request: IncomingMessage): Promise<SharedGrant | undefined> {
    const header = request.headers.authorization ?? ''
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) return undefined
    const hash = createHash('sha256').update(header.slice(7)).digest()
    return (await options.getGrants()).map((grant) => grantSchema.parse(grant)).find((grant) => timingSafeEqual(Buffer.from(grant.tokenHash, 'hex'), hash))
  }
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.origin || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host ?? '')) { json(response, 403, { error: 'Only local authenticated clients are allowed.' }); return }
      const grant = await authenticate(request)
      if (!grant) { json(response, 401, { error: 'An enrolled participant credential is required.' }); return }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/session') {
        options.host.require(grant, 'read')
        json(response, 200, { session: options.host.session, actor: grant.actor, permissions: grant.permissions, status: options.host.status })
      } else if (request.method === 'GET' && url.pathname === '/events') {
        options.host.require(grant, 'read')
        const after = Number(url.searchParams.get('after') ?? 0)
        const epoch = Number(url.searchParams.get('epoch'))
        if (!Number.isSafeInteger(after) || after < 0 || after > options.host.journal.lastSeq || epoch !== options.host.session.owner.epoch) { json(response, 409, { error: 'Invalid replay cursor or owner epoch.' }); return }
        if (streams.size >= 64) { json(response, 503, { error: 'The session subscriber limit was reached.' }); return }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' })
        response.flushHeaders()
        streams.add(response)
        const queue: string[] = []
        let waiting = false
        let buffered = 0
        const flush = () => {
          waiting = false
          while (queue.length && !response.destroyed) {
            const next = queue.shift()!
            buffered -= Buffer.byteLength(next)
            if (!response.write(next)) { waiting = true; response.once('drain', flush); break }
          }
        }
        const send = (value: unknown) => {
          const line = `data: ${JSON.stringify(value)}\n\n`
          buffered += Buffer.byteLength(line)
          if (buffered > 40 * 1024 * 1024) { response.destroy(); return }
          queue.push(line)
          if (!waiting) flush()
        }
        const unsubscribe = options.host.journal.subscribe((event) => send({ kind: 'event', event }))
        for (const event of options.host.journal.snapshot(after)) send({ kind: 'event', event })
        send({ kind: 'ready', lastSeq: options.host.journal.lastSeq })
        const heartbeat = setInterval(() => {
          void authenticate(request).then((current) => {
            if (!current?.permissions.includes('read')) response.destroy()
            else send({ kind: 'heartbeat', at: new Date().toISOString() })
          }).catch(() => response.destroy())
        }, 5000)
        response.once('close', () => { clearInterval(heartbeat); unsubscribe(); streams.delete(response) })
      } else if (request.method === 'POST' && url.pathname === '/commands') {
        json(response, 202, { commandId: await options.host.submit(grant, await body(request)) })
      } else if (request.method === 'POST' && url.pathname === '/responses') {
        await options.host.respond(grant, await body(request))
        json(response, 200, { ok: true })
      } else if (request.method === 'POST' && url.pathname === '/stop') {
        const input = await body(request) as { commandId?: unknown }
        await options.host.stop(grant, identifier.parse(input?.commandId))
        json(response, 200, { ok: true })
      } else if (request.method === 'POST' && url.pathname === '/checkpoint' && options.checkpoint) {
        options.host.require(grant, 'checkpoint')
        json(response, 200, await options.checkpoint(grant))
      } else if (request.method === 'POST' && url.pathname === '/enroll' && options.enroll) {
        options.host.require(grant, 'manage')
        json(response, 200, await options.enroll(grant, await body(request)))
      } else if (request.method === 'POST' && url.pathname === '/shutdown' && options.shutdown) {
        options.host.require(grant, 'manage')
        json(response, 200, { ok: true })
        void options.shutdown()
      } else json(response, 404, { error: 'Unknown session operation.' })
    })().catch((error: unknown) => {
      if (response.headersSent) response.destroy()
      else json(response, 400, { error: error instanceof Error ? error.message.slice(0, 2000) : 'The session request failed.' })
    })
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No loopback listener was created.')
  return {
    port: address.port,
    close: async () => {
      for (const stream of streams) stream.destroy()
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections() })
    },
  }
}