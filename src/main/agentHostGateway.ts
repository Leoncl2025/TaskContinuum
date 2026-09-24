import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { z } from 'zod'
import type { ActionEnvelope, SessionState, Snapshot } from '@microsoft/agent-host-protocol'
import type { AgentHostTarget } from '../shared/agentHost'
import { chatSubmissionSchema } from '../shared/chatAttachments'
import type { ChatImageAttachment } from '../shared/chatAttachments'
import { agentHostModelSelectionSchema, agentHostTargetSchema, agentHostTerminalIdSchema } from './agentHostProtocol'
import { AGENT_HOST_TRACE_HEADER, agentHostDiagnosticChannel, agentHostDiagnosticMethod, logAgentHostDiagnostic, withAgentHostDiagnosticTrace } from './agentHostDiagnostics'
import type { AgentHostDiagnosticDetails } from './agentHostDiagnostics'
import type { AgentHostConnection } from './agentHostConnection'
import { isAgentHostTurnBoundary } from './agentHostConnection'
import { AgentHostGatewayScheduler } from './agentHostGatewayScheduler'

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

class TerminalUnavailableError extends Error {}

export function attachAgentHostGateway(server: Server, options: AgentHostGatewayOptions) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false })
  const checks = new Set<() => void>()
  const scheduler = new AgentHostGatewayScheduler()
  let bufferedEventBytes = 0
  let terminalLeases = 0
  let pendingUpgrades = 0
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
      if (request.headers.origin || request.headers.host !== `127.0.0.1:${options.port()}` || (request.url?.length ?? 0) > 4096 || sockets.clients.size + pendingUpgrades >= 32) throw new Error('Denied.')
      pendingUpgrades++
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/device/agent-host' || [...url.searchParams.keys()].join() !== 'target') throw new Error('Denied.')
        const selectedTarget = agentHostTargetSchema.parse(JSON.parse(Buffer.from(url.searchParams.get('target')!, 'base64url').toString('utf8')))
        target = selectedTarget
        const token = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
        advance('authorization')
        await withAgentHostDiagnosticTrace(traceId, () => options.authorize(token, selectedTarget, false))
        advance('native')
        const connection = await options.connection(selectedTarget)
        await connection.open()
        advance('authorization')
        const access = await withAgentHostDiagnosticTrace(traceId, () => options.authorize(token, selectedTarget, false))
        if (socket.destroyed) {
          logAgentHostDiagnostic('gateway.upgrade', { target: selectedTarget, traceId, status: 'closed', step, reason: 'client-closed', elapsedMs: performance.now() - started })
          return
        }
        advance('websocket')
        sockets.handleUpgrade(request, socket, head, (client) => serve(client, connection, token, selectedTarget, access, traceId))
        logAgentHostDiagnostic('gateway.upgrade', { target: selectedTarget, traceId, status: 'ok', step, elapsedMs: performance.now() - started })
      } finally {
        pendingUpgrades--
      }
    })().catch((error: unknown) => {
      logAgentHostDiagnostic('gateway.upgrade', { target, traceId, status: 'error', step, elapsedMs: performance.now() - started, error })
      if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    })
  })

  function serve(socket: WebSocket, connection: AgentHostConnection, token: string, target: AgentHostTarget, initialAccess: AgentHostAccess, traceId: string): void {
    const subscribed = new Set<string>()
    const retained = new Set<string>()
    const pendingSubscriptions = new Map<string, { events: ActionEnvelope[] }>()
    const delivered = new Map<string, number>()
    const cancellations = new Map<string, number>()
    const unsubscribeBarriers = new Map<string, Promise<void>>()
    let initialized = false
    let initialization: Promise<void> | undefined
    let resolveInitialization: (() => void) | undefined
    let rejectInitialization: ((error: Error) => void) | undefined
    let closed = false
    let queue: ActionEnvelope[] = []
    let queueBytes = 0
    let queuedEvents = 0
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    let flushing = false
    let urgent = false
    let pendingRequests = 0
    let closeReason: AgentHostDiagnosticDetails['reason']
    const authorize = async (send: boolean) => {
      const access = await withAgentHostDiagnosticTrace(traceId, () => options.authorize(token, target, send))
      if (closed || socket.readyState !== WebSocket.OPEN || access.canSend !== initialAccess.canSend) throw new Error('Access changed.')
      return access
    }
    const fail = (reason: NonNullable<AgentHostDiagnosticDetails['reason']>) => {
      if (!closed) { closeReason = reason; scheduler.cancel(socket); socket.close(1008, 'Session access or connection changed. No execution replay.') }
    }
    const send = (message: unknown): boolean => {
      if (closed || socket.readyState !== WebSocket.OPEN) return false
      const text = JSON.stringify(message)
      if (socket.bufferedAmount + Buffer.byteLength(text) > 16 * 1024 * 1024) { fail('backpressure'); return false }
      socket.send(text)
      return true
    }
    const discard = (events: ActionEnvelope[]): void => {
      for (const envelope of events) {
        const bytes = Buffer.byteLength(JSON.stringify(envelope))
        queuedEvents--
        queueBytes -= bytes
        bufferedEventBytes -= bytes
      }
    }
    const releaseTerminal = (resource: string): void => {
      if (retained.delete(resource)) { terminalLeases--; connection.releaseTerminal(resource) }
    }
    const cancelSubscription = (resource: string): void => {
      subscribed.delete(resource)
      delivered.delete(resource)
      const pending = pendingSubscriptions.get(resource)
      if (pending) { pendingSubscriptions.delete(resource); discard(pending.events) }
      const obsolete = queue.filter((envelope) => envelope.channel === resource)
      discard(obsolete)
      queue = queue.filter((envelope) => envelope.channel !== resource)
      releaseTerminal(resource)
    }
    async function flush(): Promise<void> {
      clearTimeout(flushTimer)
      flushTimer = undefined
      if (flushing || closed) return
      flushing = true
      urgent = false
      try {
        await authorize(false)
        const batch = queue
        queue = []
        discard(batch)
        for (const envelope of batch) if (subscribed.has(envelope.channel) && connection.allowedChannel(envelope.channel) && envelope.serverSeq > (delivered.get(envelope.channel) ?? -1)) {
          if (send({ jsonrpc: '2.0', method: 'action', params: envelope })) delivered.set(envelope.channel, envelope.serverSeq)
        }
      } catch (error) {
        logAgentHostDiagnostic('gateway.socket', { target, traceId, status: 'error', step: 'authorization', error })
        fail('access-changed')
      }
      finally { flushing = false; if (queue.length && !closed) flushTimer = setTimeout(() => { void flush() }, urgent ? 0 : 25) }
    }
    const unlisten = connection.listen((event) => {
      if (event.type === 'state') { if (connection.state !== 'connected') fail('owner-offline'); return }
      if (event.type !== 'action' || event.envelope.channel === target.sessionId) return
      const resource = event.envelope.channel
      const pending = pendingSubscriptions.get(resource)
      if (!pending && !subscribed.has(resource)) return
      const bytes = Buffer.byteLength(JSON.stringify(event.envelope))
      if (queuedEvents >= 1024 || queueBytes + bytes > 16 * 1024 * 1024 || bufferedEventBytes + bytes > 32 * 1024 * 1024) { fail('backpressure'); return }
      queuedEvents++
      queueBytes += bytes
      bufferedEventBytes += bytes
      if (pending) pending.events.push(event.envelope)
      else {
        queue.push(event.envelope)
        urgent ||= isAgentHostTurnBoundary(event)
        if (urgent && !flushing) void flush()
        else if (!flushTimer && !flushing) flushTimer = setTimeout(() => { void flush() }, 25)
      }
    })
    let checking = false
    const revalidate = () => {
      if (checking || closed) return
      checking = true
      const started = performance.now()
      void authorize(false).then(() => {
        if (performance.now() - started > 1000) logAgentHostDiagnostic('gateway.socket', { target, traceId, status: 'ok', step: 'authorization', elapsedMs: performance.now() - started })
      }).catch((error: unknown) => {
        logAgentHostDiagnostic('gateway.socket', { target, traceId, status: 'error', step: 'authorization', elapsedMs: performance.now() - started, error })
        fail('access-changed')
      }).finally(() => { checking = false })
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
      scheduler.cancel(socket)
      checks.delete(revalidate)
      clearInterval(heartbeat)
      clearTimeout(flushTimer)
      discard(queue)
      queue = []
      for (const pending of pendingSubscriptions.values()) discard(pending.events)
      pendingSubscriptions.clear()
      for (const resource of [...retained]) releaseTerminal(resource)
      rejectInitialization?.(new Error('Agent Host connection closed.'))
      unlisten()
    })
    socket.on('message', (data, binary) => {
      if (closed || binary) { if (binary) fail('invalid-frame'); return }
      const received = performance.now()
      const raw = data.toString()
      let parsed: unknown
      try { parsed = JSON.parse(raw) }
      catch { fail('invalid-frame'); return }
      const hint = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
      const params = hint.params !== null && typeof hint.params === 'object' && !Array.isArray(hint.params) ? hint.params as Record<string, unknown> : {}
      const hintedMethod = typeof hint.method === 'string' ? hint.method : ''
      const resource = typeof params.channel === 'string' ? params.channel : undefined
      let id: string | number | undefined
      let method = agentHostDiagnosticMethod(hintedMethod)
      let channel = agentHostDiagnosticChannel(resource, target)
      const terminal = hintedMethod === 'subscribe' && resource !== undefined && agentHostTerminalIdSchema.safeParse(resource).success
      const activeTerminal = terminal && connection.isActiveTerminal(resource)
      const lane = hintedMethod === 'ping' || hintedMethod === 'unsubscribe' ? 'control'
        : hintedMethod === 'dispatchAction' ? 'execution'
          : terminal && !activeTerminal ? 'history' : 'interactive'
      const isInitialization = hintedMethod === 'initialize' || hintedMethod === 'reconnect'
      let initializer = false
      if (isInitialization && !initialization) {
        initialization = new Promise<void>((resolve, reject) => { resolveInitialization = resolve; rejectInitialization = reject })
        void initialization.catch(() => {})
        initializer = true
      }
      let generation = resource ? cancellations.get(resource) ?? 0 : 0
      const precedingUnsubscribe = resource ? unsubscribeBarriers.get(resource) : undefined
      let completeUnsubscribe: (() => void) | undefined
      let unsubscribeBarrier: Promise<void> | undefined
      if (hintedMethod === 'unsubscribe' && resource) {
        generation++
        cancellations.set(resource, generation)
        unsubscribeBarrier = new Promise<void>((resolve) => { completeUnsubscribe = resolve })
        unsubscribeBarriers.set(resource, unsubscribeBarrier)
      }
      const finishUnsubscribe = () => {
        completeUnsubscribe?.()
        completeUnsubscribe = undefined
        if (resource && unsubscribeBarrier && unsubscribeBarriers.get(resource) === unsubscribeBarrier) unsubscribeBarriers.delete(resource)
      }
      pendingRequests++
      logAgentHostDiagnostic('gateway.request', { target, traceId, status: 'begin', step: 'queue', method, channel, pending: pendingRequests })
      const queued = scheduler.enqueue({
        owner: socket, lane, activeTerminal, bytes: Buffer.byteLength(raw),
        drop: (expired) => {
          pendingRequests--
          finishUnsubscribe()
          if (initializer) rejectInitialization?.(new Error('Agent Host initialization was interrupted.'))
          if (expired) {
            logAgentHostDiagnostic('gateway.request', { target, traceId, status: 'error', step: 'queue', method, channel, elapsedMs: performance.now() - received, pending: pendingRequests })
            fail('queue-limit')
          }
        },
        error: (error) => {
          logAgentHostDiagnostic('gateway.socket', { target, traceId, status: 'error', step: 'response', error })
          fail('transport-closed')
        },
        run: async (queueMs) => {
          let step: NonNullable<AgentHostDiagnosticDetails['step']> = 'authorization'
          let authMs = 0
          let authorized = false
          const ready: { resource: string; pending: { events: ActionEnvelope[] }; snapshot: Snapshot }[] = []
          let staged: { resource: string; pending: { events: ActionEnvelope[] } } | undefined
          let newlyRetained: string | undefined
          const requestAuthorization = async (send: boolean) => {
            const started = performance.now()
            try { return await authorize(send) }
            finally { authMs += performance.now() - started }
          }
          try {
            await requestAuthorization(false)
            authorized = true
            step = 'validation'
            const request = rpcSchema.parse(parsed)
            id = request.id
            method = agentHostDiagnosticMethod(request.method)
            channel = agentHostDiagnosticChannel(request.params.channel, target)
            if (!initializer && request.method !== 'ping') {
              if (initialization) await initialization
              if (!initialized) throw new Error('Initialize first.')
            }
            if (precedingUnsubscribe) await precedingUnsubscribe
            if (request.method === 'subscribe' && resource && (cancellations.get(resource) ?? 0) !== generation) throw new Error('Subscription was cancelled.')
            let result: unknown
            if (isInitialization) {
              if (!initializer || initialized) throw new Error('Already initialized.')
              let resources: string[]
              if (request.method === 'initialize') {
                const params = initializeSchema.parse(request.params)
                if (!params.protocolVersions.includes('0.9.0')) throw new Error('Unsupported protocol version.')
                resources = params.initialSubscriptions ?? []
              } else resources = reconnectSchema.parse(request.params).subscriptions
              if (resources.length > 2 || new Set(resources).size !== resources.length || resources.some((item) => item !== target.sessionId && item !== target.chatId)) throw new Error('Channel not authorized.')
              for (const item of resources) {
                const snapshot = connection.snapshot(item)
                const pending = { events: [] as ActionEnvelope[] }
                pendingSubscriptions.set(item, pending)
                staged = { resource: item, pending }
                ready.push({ resource: item, pending, snapshot })
              }
              result = request.method === 'initialize'
                ? { ...connection.handshake, snapshots: ready.map((item) => item.snapshot), _meta: { taskcontinuumCanSend: initialAccess.canSend, taskcontinuumModelSelection: true, taskcontinuumModelConfig: true, taskcontinuumStreamedSendValidation: true } }
                : { type: 'snapshot', snapshots: ready.map((item) => item.snapshot) }
            } else if (request.method === 'ping') {
              z.object({ channel: z.literal('ahp-root://') }).strict().parse(request.params)
              result = {}
            } else if (request.method === 'subscribe') {
              const { channel: selected } = subscribeSchema.parse(request.params)
              if (selected === 'ahp-root://') {
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
                result = { snapshot: { resource: selected, fromSeq: session.fromSeq, state: { agents: [{ provider, displayName: provider, description: '', models }] } } }
              } else {
                if (!connection.allowedChannel(selected) || pendingSubscriptions.has(selected)) throw new Error('Channel not authorized or subscription in progress.')
                if (subscribed.has(selected)) result = { snapshot: connection.snapshot(selected) }
                else {
                  const isTerminal = agentHostTerminalIdSchema.safeParse(selected).success
                  let snapshot = isTerminal ? undefined : connection.snapshot(selected)
                  if (isTerminal && !retained.has(selected)) {
                    if (retained.size >= 32 || terminalLeases >= 128) throw new Error('Terminal subscription limit reached.')
                    connection.retainTerminal(selected)
                    retained.add(selected)
                    terminalLeases++
                    newlyRetained = selected
                  }
                  const pending = { events: [] as ActionEnvelope[] }
                  pendingSubscriptions.set(selected, pending)
                  staged = { resource: selected, pending }
                  if (isTerminal) {
                    step = 'native'
                    try { snapshot = await connection.terminal(selected, true) }
                    catch (error) { throw new TerminalUnavailableError('Terminal output is unavailable.', { cause: error }) }
                  }
                  if (!snapshot) throw new Error('Agent Host did not return the requested snapshot.')
                  result = { snapshot }
                  ready.push({ resource: selected, pending, snapshot })
                }
              }
            } else if (request.method === 'unsubscribe') {
              const { channel: selected } = z.object({ channel: z.string().max(512) }).strict().parse(request.params)
              if (selected !== 'ahp-root://' && !connection.allowedChannel(selected) && !subscribed.has(selected) && !retained.has(selected) && !pendingSubscriptions.has(selected)) throw new Error('Channel not authorized.')
              cancelSubscription(selected)
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
                await connection.cancel(action.turnId, async () => { await requestAuthorization(true) })
              } else throw new Error('This action is not available through the session gateway.')
              result = {}
            } else throw new Error('This command is not available through the session gateway.')
            step = 'authorization'
            await requestAuthorization(false)
            for (const item of ready) {
              if (pendingSubscriptions.get(item.resource) !== item.pending || !connection.allowedChannel(item.resource)
                || request.method === 'subscribe' && (cancellations.get(item.resource) ?? 0) !== generation) throw new Error('Subscription was cancelled or channel access changed.')
              item.snapshot = connection.snapshot(item.resource)
            }
            if (ready.length && request.method === 'subscribe') result = { snapshot: ready[0].snapshot }
            if (ready.length && request.method === 'initialize') result = { ...result as object, snapshots: ready.map((item) => item.snapshot) }
            if (ready.length && request.method === 'reconnect') result = { type: 'snapshot', snapshots: ready.map((item) => item.snapshot) }
            step = 'response'
            if (id !== undefined && !send({ jsonrpc: '2.0', id, result })) throw new Error('Agent Host connection closed before replying.')
            for (const item of ready) {
              pendingSubscriptions.delete(item.resource)
              subscribed.add(item.resource)
              delivered.set(item.resource, item.snapshot.fromSeq)
              const events = item.pending.events
              discard(events)
              for (const envelope of events) if (connection.allowedChannel(item.resource) && envelope.serverSeq > (delivered.get(item.resource) ?? -1)) {
                if (send({ jsonrpc: '2.0', method: 'action', params: envelope })) delivered.set(item.resource, envelope.serverSeq)
              }
            }
            if (initializer) { initialized = true; resolveInitialization?.() }
            logAgentHostDiagnostic('gateway.request', { target, traceId, status: 'ok', step, method, channel, queueMs, authMs, elapsedMs: performance.now() - received, pending: pendingRequests })
          } catch (error) {
            for (const item of ready) if (pendingSubscriptions.get(item.resource) === item.pending) cancelSubscription(item.resource)
            if (staged && pendingSubscriptions.get(staged.resource) === staged.pending) cancelSubscription(staged.resource)
            if (newlyRetained) releaseTerminal(newlyRetained)
            if (initializer) rejectInitialization?.(error instanceof Error ? error : new Error('Agent Host initialization failed.'))
            logAgentHostDiagnostic('gateway.request', { target, traceId, status: 'error', step, method, channel, queueMs, authMs, elapsedMs: performance.now() - received, pending: pendingRequests, error })
            if (!closed && authorized) {
              try { await requestAuthorization(false) }
              catch (failure) {
                logAgentHostDiagnostic('gateway.socket', { target, traceId, status: 'error', step: 'authorization', error: failure })
                fail('access-changed')
                return
              }
              if (id !== undefined) send({ jsonrpc: '2.0', id, error: error instanceof TerminalUnavailableError
                ? { code: -32000, message: 'Terminal output is unavailable from the owner Host. Retry manually.' }
                : { code: -32602, message: 'Command, channel, or session access is not authorized.' } })
              else fail('invalid-frame')
            } else if (!closed) fail('access-changed')
          } finally {
            finishUnsubscribe()
            pendingRequests--
          }
        },
      })
      if (!queued) { pendingRequests--; finishUnsubscribe(); if (initializer) rejectInitialization?.(new Error('Agent Host gateway is busy.')); fail('queue-limit') }
    })
  }

  return { revalidate: () => { for (const check of checks) check() }, close: () => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); checks.clear() } }
}