import type { Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { z } from 'zod'
import type { ActionEnvelope } from '@microsoft/agent-host-protocol'
import type { AgentHostTarget } from '../shared/agentHost'
import { chatSubmissionSchema } from '../shared/chatAttachments'
import type { ChatImageAttachment } from '../shared/chatAttachments'
import { agentHostTargetSchema } from './agentHostProtocol'
import type { AgentHostConnection } from './agentHostConnection'

export interface AgentHostAccess { canSend: boolean; actor: { clientId: string; machineName: string; username?: string } }
export interface AgentHostGatewayOptions {
  port(): number | undefined
  authorize(token: string, target: AgentHostTarget, send: boolean): Promise<AgentHostAccess>
  connection(target: AgentHostTarget): Promise<AgentHostConnection>
}
const rpcSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.number().int().nonnegative(), z.string().max(128)]).optional(), method: z.string().max(100), params: z.record(z.string(), z.unknown()) }).strict()
const subscribeSchema = z.object({ channel: z.string().max(512), delivery: z.unknown().optional(), view: z.unknown().optional() }).strict()
const initializeSchema = z.object({ channel: z.literal('ahp-root://'), clientId: z.string().min(1).max(128), protocolVersions: z.array(z.string()).min(1).max(10), initialSubscriptions: z.array(z.string().max(512)).max(18).optional(), locale: z.string().max(100).optional(), clientInfo: z.unknown().optional() }).strict()
const reconnectSchema = z.object({ channel: z.literal('ahp-root://'), clientId: z.string().min(1).max(128), lastSeenServerSeq: z.number().int().nonnegative(), subscriptions: z.array(z.string().max(512)).max(18) }).strict()
const dispatchSchema = z.object({ channel: z.string().max(512), clientSeq: z.number().int().nonnegative(), action: z.record(z.string(), z.unknown()) }).strict()

export function attachAgentHostGateway(server: Server, options: AgentHostGatewayOptions) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false })
  const checks = new Set<() => void>()
  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      if (request.headers.origin || request.headers.host !== `127.0.0.1:${options.port()}` || (request.url?.length ?? 0) > 4096 || sockets.clients.size >= 32) throw new Error('Denied.')
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/device/agent-host' || [...url.searchParams.keys()].join() !== 'target') throw new Error('Denied.')
      const target = agentHostTargetSchema.parse(JSON.parse(Buffer.from(url.searchParams.get('target')!, 'base64url').toString('utf8')))
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
      await options.authorize(token, target, false)
      const connection = await options.connection(target)
      await connection.open()
      const access = await options.authorize(token, target, false)
      if (socket.destroyed) return
      sockets.handleUpgrade(request, socket, head, (client) => serve(client, connection, token, target, access))
    })().catch(() => { if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') })
  })

  function serve(socket: WebSocket, connection: AgentHostConnection, token: string, target: AgentHostTarget, initialAccess: AgentHostAccess): void {
    const subscribed = new Set<string>()
    let initialized = false
    let closed = false
    let queue: ActionEnvelope[] = []
    let queueBytes = 0
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    let flushing = false
    let pendingRequests = 0
    let requests: Promise<void> = Promise.resolve()
    const authorize = async (send: boolean) => {
      const access = await options.authorize(token, target, send)
      if (closed || socket.readyState !== WebSocket.OPEN || access.canSend !== initialAccess.canSend) throw new Error('Access changed.')
      return access
    }
    const send = (message: unknown) => {
      if (closed) return
      const text = JSON.stringify(message)
      if (socket.bufferedAmount + Buffer.byteLength(text) > 16 * 1024 * 1024) { socket.close(1008, 'Stream backpressure; reconnect for a snapshot.'); return }
      socket.send(text)
    }
    const fail = () => { if (!closed) socket.close(1008, 'Session access or connection changed. No execution replay.') }
    async function flush(): Promise<void> {
      flushTimer = undefined
      if (flushing || closed) return
      flushing = true
      try {
        await authorize(false)
        const batch = queue
        queue = []
        queueBytes = 0
        for (const envelope of batch) if (subscribed.has(envelope.channel) && connection.allowedChannel(envelope.channel)) send({ jsonrpc: '2.0', method: 'action', params: envelope })
      } catch { fail() }
      finally { flushing = false; if (queue.length && !closed) flushTimer = setTimeout(() => { void flush() }, 25) }
    }
    const unlisten = connection.listen((event) => {
      if (event.type === 'state') { if (connection.view.state !== 'connected') fail(); return }
      if (event.type !== 'action' || event.envelope.channel === target.sessionId || !subscribed.has(event.envelope.channel)) return
      queueBytes += Buffer.byteLength(JSON.stringify(event.envelope))
      if (queue.length >= 1024 || queueBytes > 16 * 1024 * 1024) { fail(); return }
      queue.push(event.envelope)
      if (!flushTimer && !flushing) flushTimer = setTimeout(() => { void flush() }, 25)
    })
    const revalidate = () => { void authorize(false).catch(fail) }
    checks.add(revalidate)
    const heartbeat = setInterval(revalidate, 2000)
    heartbeat.unref()
    socket.on('error', fail)
    socket.on('close', () => { closed = true; checks.delete(revalidate); clearInterval(heartbeat); clearTimeout(flushTimer); queue = []; unlisten() })
    socket.on('message', (data, binary) => {
      if (binary || ++pendingRequests > 32) { fail(); return }
      requests = requests.then(async () => {
        let id: string | number | undefined
        try {
          await authorize(false)
          const request = rpcSchema.parse(JSON.parse(data.toString()))
          id = request.id
          let result: unknown
          if (request.method === 'initialize') {
            if (initialized) throw new Error('Already initialized.')
            const params = initializeSchema.parse(request.params)
            if (!params.protocolVersions.includes('0.9.0')) throw new Error('Unsupported protocol version.')
            const resources = params.initialSubscriptions ?? []
            if (resources.some((resource) => !connection.allowedChannel(resource))) throw new Error('Channel not authorized.')
            result = { ...connection.handshake, snapshots: resources.map((resource) => connection.snapshot(resource)), _meta: { taskcontinuumCanSend: initialAccess.canSend } }
            for (const resource of resources) subscribed.add(resource)
            initialized = true
          } else if (request.method === 'reconnect') {
            if (initialized) throw new Error('Already initialized.')
            const params = reconnectSchema.parse(request.params)
            if (params.subscriptions.some((resource) => !connection.allowedChannel(resource))) throw new Error('Channel not authorized.')
            result = { type: 'snapshot', snapshots: params.subscriptions.map((resource) => connection.snapshot(resource)) }
            for (const resource of params.subscriptions) subscribed.add(resource)
            initialized = true
          } else if (request.method === 'ping') {
            z.object({ channel: z.literal('ahp-root://') }).strict().parse(request.params)
            result = {}
          } else {
            if (!initialized) throw new Error('Initialize first.')
            if (request.method === 'subscribe') {
              const { channel } = subscribeSchema.parse(request.params)
              if (!connection.allowedChannel(channel)) throw new Error('Channel not authorized.')
              result = { snapshot: connection.snapshot(channel) }
              subscribed.add(channel)
            } else if (request.method === 'unsubscribe') {
              const { channel } = z.object({ channel: z.string().max(512) }).strict().parse(request.params)
              subscribed.delete(channel)
              result = {}
            } else if (request.method === 'dispatchAction') {
              const access = await authorize(true)
              const params = dispatchSchema.parse(request.params)
              if (params.channel !== target.chatId) throw new Error('Only the selected chat can receive input.')
              if (params.action.type === 'chat/turnStarted') {
                const action = z.object({ type: z.literal('chat/turnStarted'), turnId: z.uuid(), startedAt: z.iso.datetime(), message: z.object({ text: z.string().max(4000), origin: z.object({ kind: z.literal('user') }).strict(), attachments: z.array(z.object({ type: z.literal('embeddedResource'), label: z.string().max(200), displayKind: z.literal('image'), contentType: z.string(), data: z.string(), _meta: z.object({ taskcontinuumImageId: z.uuid() }).strict() }).strict()).max(4).optional(), agent: z.unknown().optional(), model: z.unknown().optional(), _meta: z.unknown().optional() }).strict() }).strict().parse(params.action)
                const images = action.message.attachments?.map((image) => ({ id: image._meta.taskcontinuumImageId, name: image.label, mimeType: image.contentType, data: image.data })) as ChatImageAttachment[] | undefined
                const command = chatSubmissionSchema.parse({ id: action.turnId, text: action.message.text, ...(images?.length ? { images } : {}) })
                await connection.send(command.id, command.text, command.images, async () => { await authorize(true) }, access.actor)
              } else if (params.action.type === 'chat/turnCancelled') {
                const action = z.object({ type: z.literal('chat/turnCancelled'), turnId: z.string().min(1).max(200), duration: z.number().nonnegative() }).strict().parse(params.action)
                await connection.cancel(action.turnId, async () => { await authorize(true) })
              } else throw new Error('This action is not available through the session gateway.')
              result = {}
            } else throw new Error('This command is not available through the session gateway.')
          }
          await authorize(false)
          if (id !== undefined) send({ jsonrpc: '2.0', id, result })
        } catch {
          if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Command, channel, or session access is not authorized.' } })
          else fail()
        } finally { pendingRequests-- }
      }).catch(fail)
    })
  }

  return { revalidate: () => { for (const check of checks) check() }, close: () => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); checks.clear() } }
}