import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { z } from 'zod'
import type { ActionEnvelope, SessionState } from '@microsoft/agent-host-protocol'
import type { AgentHostTarget } from '../shared/agentHost'
import { chatSubmissionSchema } from '../shared/chatAttachments'
import type { ChatImageAttachment } from '../shared/chatAttachments'
import { agentHostModelSelectionSchema, agentHostTargetSchema } from './agentHostProtocol'
import { AGENT_HOST_TRACE_HEADER, agentHostDiagnosticChannel, agentHostDiagnosticMethod, logAgentHostDiagnostic } from './agentHostDiagnostics'
import type { AgentHostDiagnosticDetails } from './agentHostDiagnostics'
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
    const suppliedTrace = z.uuid().safeParse(request.headers[AGENT_HOST_TRACE_HEADER])
    const traceId = suppliedTrace.success ? suppliedTrace.data : randomUUID()
    const started = performance.now()
    let target: AgentHostTarget | undefined
    let step: NonNullable<AgentHostDiagnosticDetails['step']> = 'validation'
    let stepStarted = started
    const advance = (next: NonNullable<AgentHostDiagnosticDetails['step']>) => {
      logAgentHostDiagnostic('gateway.upgrade', { target, traceId, status: 'ok', step, elapsedMs: performance.now() - stepStarted })
      step = next
      stepStarted = performance.now()
    }
    logAgentHostDiagnostic('gateway.upgrade', { traceId, status: 'begin', step })
    void (async () => {
      if (request.headers.origin || request.headers.host !== `127.0.0.1:${options.port()}` || (request.url?.length ?? 0) > 4096 || sockets.clients.size >= 32) throw new Error('Denied.')
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/device/agent-host' || [...url.searchParams.keys()].join() !== 'target') throw new Error('Denied.')
      const selectedTarget = agentHostTargetSchema.parse(JSON.parse(Buffer.from(url.searchParams.get('target')!, 'base64url').toString('utf8')))
      target = selectedTarget
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
      advance('authorization')
      await options.authorize(token, selectedTarget, false)
      advance('native')
      const connection = await options.connection(selectedTarget)
      await connection.open()
      advance('authorization')
      const access = await options.authorize(token, selectedTarget, false)
      if (socket.destroyed) {
        logAgentHostDiagnostic('gateway.upgrade', { target: selectedTarget, traceId, status: 'closed', step, reason: 'client-closed', elapsedMs: performance.now() - started })
        return
      }
      advance('websocket')
      sockets.handleUpgrade(request, socket, head, (client) => serve(client, connection, token, selectedTarget, access, traceId))
      logAgentHostDiagnostic('gateway.upgrade', { target: selectedTarget, traceId, status: 'ok', step, elapsedMs: performance.now() - started })
    })().catch((error: unknown) => {
      logAgentHostDiagnostic('gateway.upgrade', { target, traceId, status: 'error', step, elapsedMs: performance.now() - started, error })
      if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    })
  })

  function serve(socket: WebSocket, connection: AgentHostConnection, token: string, target: AgentHostTarget, initialAccess: AgentHostAccess, traceId: string): void {
    const subscribed = new Set<string>()
    let initialized = false
    let closed = false
    let queue: ActionEnvelope[] = []
    let queueBytes = 0
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    let flushing = false
    let pendingRequests = 0
    let requests: Promise<void> = Promise.resolve()
    let closeReason: AgentHostDiagnosticDetails['reason']
    const authorize = async (send: boolean) => {
      const access = await options.authorize(token, target, send)
      if (closed || socket.readyState !== WebSocket.OPEN || access.canSend !== initialAccess.canSend) throw new Error('Access changed.')
      return access
    }
    const send = (message: unknown) => {
      if (closed) return
      const text = JSON.stringify(message)
      if (socket.bufferedAmount + Buffer.byteLength(text) > 16 * 1024 * 1024) { closeReason = 'backpressure'; socket.close(1008, 'Stream backpressure; reconnect for a snapshot.'); return }
      socket.send(text)
    }
    const fail = (reason: NonNullable<AgentHostDiagnosticDetails['reason']>) => {
      if (!closed) { closeReason = reason; socket.close(1008, 'Session access or connection changed. No execution replay.') }
    }
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
      } catch (error) {
        logAgentHostDiagnostic('gateway.socket', { target, traceId, status: 'error', step: 'authorization', error })
        fail('access-changed')
      }
      finally { flushing = false; if (queue.length && !closed) flushTimer = setTimeout(() => { void flush() }, 25) }
    }
    const unlisten = connection.listen((event) => {
      if (event.type === 'state') { if (connection.view.state !== 'connected') fail('owner-offline'); return }
      if (event.type !== 'action' || event.envelope.channel === target.sessionId || !subscribed.has(event.envelope.channel)) return
      queueBytes += Buffer.byteLength(JSON.stringify(event.envelope))
      if (queue.length >= 1024 || queueBytes > 16 * 1024 * 1024) { fail('backpressure'); return }
      queue.push(event.envelope)
      if (!flushTimer && !flushing) flushTimer = setTimeout(() => { void flush() }, 25)
    })
    const revalidate = () => {
      const started = performance.now()
      void authorize(false).then(() => {
        if (performance.now() - started > 1000) logAgentHostDiagnostic('gateway.socket', { target, traceId, status: 'ok', step: 'authorization', elapsedMs: performance.now() - started })
      }).catch((error: unknown) => {
        logAgentHostDiagnostic('gateway.socket', { target, traceId, status: 'error', step: 'authorization', elapsedMs: performance.now() - started, error })
        fail('access-changed')
      })
    }
    checks.add(revalidate)
    const heartbeat = setInterval(revalidate, 2000)
    heartbeat.unref()
    socket.on('error', (error: Error) => {
      logAgentHostDiagnostic('gateway.socket', { target, traceId, status: 'error', step: 'transport', error })
      fail('transport-closed')
    })
    socket.on('close', (code) => {
      logAgentHostDiagnostic('gateway.socket', { target, traceId, status: 'closed', reason: closeReason ?? 'client-closed', closeCode: code, pending: pendingRequests })
      closed = true
      checks.delete(revalidate)
      clearInterval(heartbeat)
      clearTimeout(flushTimer)
      queue = []
      unlisten()
    })
    socket.on('message', (data, binary) => {
      if (binary) { fail('invalid-frame'); return }
      if (++pendingRequests > 32) { fail('queue-limit'); return }
      const received = performance.now()
      logAgentHostDiagnostic('gateway.request', { target, traceId, status: 'begin', step: 'queue', pending: pendingRequests })
      requests = requests.then(async () => {
        let id: string | number | undefined
        let method: ReturnType<typeof agentHostDiagnosticMethod> = 'other'
        let channel: ReturnType<typeof agentHostDiagnosticChannel> = 'other'
        let step: NonNullable<AgentHostDiagnosticDetails['step']> = 'authorization'
        let authMs = 0
        const queueMs = performance.now() - received
        const requestAuthorization = async (send: boolean) => {
          const started = performance.now()
          try { return await authorize(send) }
          finally { authMs += performance.now() - started }
        }
        try {
          await requestAuthorization(false)
          step = 'validation'
          const request = rpcSchema.parse(JSON.parse(data.toString()))
          id = request.id
          method = agentHostDiagnosticMethod(request.method)
          channel = agentHostDiagnosticChannel(request.params.channel, target)
          let result: unknown
          if (request.method === 'initialize') {
            if (initialized) throw new Error('Already initialized.')
            const params = initializeSchema.parse(request.params)
            if (!params.protocolVersions.includes('0.9.0')) throw new Error('Unsupported protocol version.')
            const resources = params.initialSubscriptions ?? []
            if (resources.some((resource) => !connection.allowedChannel(resource))) throw new Error('Channel not authorized.')
            result = { ...connection.handshake, snapshots: resources.map((resource) => connection.snapshot(resource)), _meta: { taskcontinuumCanSend: initialAccess.canSend, taskcontinuumModelSelection: true, taskcontinuumModelConfig: true } }
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
              if (channel === 'ahp-root://') {
                step = 'native'
                const upstreamStarted = performance.now()
                logAgentHostDiagnostic('gateway.models', { target, traceId, status: 'begin', step, queueMs })
                let models: Awaited<ReturnType<AgentHostConnection['models']>>
                try {
                  models = await connection.models(traceId)
                  logAgentHostDiagnostic('gateway.models', { target, traceId, status: 'ok', step, elapsedMs: performance.now() - upstreamStarted, count: models.length })
                } catch (error) {
                  logAgentHostDiagnostic('gateway.models', { target, traceId, status: 'error', step, elapsedMs: performance.now() - upstreamStarted, error })
                  throw error
                }
                const session = connection.snapshot(target.sessionId)
                const provider = (session.state as SessionState).provider
                result = { snapshot: { resource: channel, fromSeq: session.fromSeq, state: { agents: [{ provider, displayName: provider, description: '', models }] } } }
              } else {
                if (!connection.allowedChannel(channel)) throw new Error('Channel not authorized.')
                result = { snapshot: connection.snapshot(channel) }
                subscribed.add(channel)
              }
            } else if (request.method === 'unsubscribe') {
              const { channel } = z.object({ channel: z.string().max(512) }).strict().parse(request.params)
              subscribed.delete(channel)
              result = {}
            } else if (request.method === 'dispatchAction') {
              step = 'authorization'
              const access = await requestAuthorization(true)
              const params = dispatchSchema.parse(request.params)
              if (params.channel !== target.chatId) throw new Error('Only the selected chat can receive input.')
              if (params.action.type === 'chat/turnStarted') {
                const action = z.object({ type: z.literal('chat/turnStarted'), turnId: z.uuid(), startedAt: z.iso.datetime(), message: z.object({ text: z.string().max(4000), origin: z.object({ kind: z.literal('user') }).strict(), attachments: z.array(z.object({ type: z.literal('embeddedResource'), label: z.string().max(200), displayKind: z.literal('image'), contentType: z.string(), data: z.string(), _meta: z.object({ taskcontinuumImageId: z.uuid() }).strict() }).strict()).max(4).optional(), agent: z.unknown().optional(), model: z.unknown().optional(), _meta: z.unknown().optional() }).strict() }).strict().parse(params.action)
                const images = action.message.attachments?.map((image) => ({ id: image._meta.taskcontinuumImageId, name: image.label, mimeType: image.contentType, data: image.data })) as ChatImageAttachment[] | undefined
                const command = chatSubmissionSchema.parse({ id: action.turnId, text: action.message.text, ...(images?.length ? { images } : {}) })
                const model = agentHostModelSelectionSchema.optional().parse(action.message.model)
                step = 'native'
                await connection.send(command.id, command.text, command.images, async () => { await requestAuthorization(true) }, access.actor, model)
              } else if (params.action.type === 'chat/turnCancelled') {
                const action = z.object({ type: z.literal('chat/turnCancelled'), turnId: z.string().min(1).max(200), duration: z.number().nonnegative() }).strict().parse(params.action)
                await connection.cancel(action.turnId, async () => { await authorize(true) })
              } else throw new Error('This action is not available through the session gateway.')
              result = {}
            } else throw new Error('This command is not available through the session gateway.')
          }
          step = 'authorization'
          await requestAuthorization(false)
          step = 'response'
          if (id !== undefined) send({ jsonrpc: '2.0', id, result })
          logAgentHostDiagnostic('gateway.request', { target, traceId, status: 'ok', step, method, channel, queueMs, authMs, elapsedMs: performance.now() - received, pending: pendingRequests })
        } catch (error) {
          logAgentHostDiagnostic('gateway.request', { target, traceId, status: 'error', step, method, channel, queueMs, authMs, elapsedMs: performance.now() - received, pending: pendingRequests, error })
          if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Command, channel, or session access is not authorized.' } })
          else fail('invalid-frame')
        } finally { pendingRequests-- }
      }).catch((error: unknown) => {
        logAgentHostDiagnostic('gateway.socket', { target, traceId, status: 'error', step: 'response', error })
        fail('transport-closed')
      })
    })
  }

  return { revalidate: () => { for (const check of checks) check() }, close: () => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); checks.clear() } }
}