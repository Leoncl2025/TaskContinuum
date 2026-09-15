import { createHash, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import ssh2 from 'ssh2'
import { z } from 'zod'
import { devTunnelRouteSchema, sshFingerprint, sshPublicKeySchema } from '../devTunnel/protocol'
import type { DevTunnelRoute } from '../devTunnel/protocol'
import type { SshKeyPair } from '../devTunnel/sessionSsh'

export const PEER_CONTROL_PATH = '/peer-control/v1'
export const PEER_CONTROL_MAX_BYTES = 256 * 1024
export const PEER_CONTROL_MAX_AGE_MS = 60000
export const PEER_CONTROL_REPLAY_TTL_MS = 125000
const futureSkewMs = 5000
const ioTimeoutMs = 15000
const fingerprintSchema = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/)
const signatureSchema = z.string().length(88).regex(/^[A-Za-z0-9+/]{86}==$/)
const kindSchema = z.enum(['link', 'binding.changed'])
const bindingPayloadSchema = z.object({
  operation: z.record(z.string(), z.unknown()),
  dependencies: z.array(z.record(z.string(), z.unknown())).max(64),
}).strict()
export type PeerControlKind = z.infer<typeof kindSchema>
export type PeerBindingPayload = z.infer<typeof bindingPayloadSchema>

const requestBodySchema = z.object({
  protocol: z.literal('TaskContinuum.PeerControl.Request.v1'),
  workspaceId: z.uuid(),
  senderId: z.uuid(),
  recipientId: z.uuid(),
  senderKeyId: fingerprintSchema,
  recipientKeyId: fingerprintSchema,
  grantId: z.uuid(),
  expiresAt: z.iso.datetime(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  timestamp: z.iso.datetime(),
  kind: kindSchema,
  payload: z.unknown(),
}).strict()
const requestSchema = requestBodySchema.extend({ signature: signatureSchema })
export type PeerControlRequestBody = z.infer<typeof requestBodySchema>
export type SignedPeerControlRequest = z.infer<typeof requestSchema>

const errors = {
  'invalid-request': [400, 'The metadata request is malformed or uses an unsupported operation.'],
  'invalid-key': [400, 'A matching private Ed25519 device identity is required.'],
  'invalid-payload': [422, 'The metadata payload is invalid.'],
  'wrong-workspace': [403, 'The metadata request belongs to another workspace.'],
  'wrong-recipient': [403, 'The metadata request is addressed to another device identity.'],
  'invalid-grant': [403, 'The metadata grant is missing, revoked, or bound to another identity.'],
  'expired-grant': [403, 'The metadata grant has expired.'],
  'unauthorized': [403, 'The sender is not currently trusted for this workspace.'],
  'invalid-signature': [401, 'The metadata request does not prove the sender private key.'],
  'stale-request': [408, 'The signed metadata request is stale or its clock is too far ahead.'],
  'replay': [409, 'This signed metadata request has already been used.'],
  'too-large': [413, 'The metadata message exceeds the 256 KiB limit.'],
  'busy': [429, 'The metadata endpoint is at its bounded request or replay limit. Retry later.'],
  'timeout': [408, 'The metadata operation timed out. Its outcome may be unknown; reconcile before retrying.'],
  'aborted': [499, 'The metadata operation was canceled. Its outcome may be unknown.'],
  'closed': [503, 'The metadata endpoint is closed.'],
  'operation-failed': [500, 'The peer could not complete the metadata operation.'],
  'invalid-response': [502, 'The peer response is malformed or does not match this signed request.'],
  'transport-failed': [502, 'The authenticated SSH metadata connection failed.'],
} as const
export type PeerControlErrorCode = keyof typeof errors

export class PeerControlError extends Error {
  readonly status: number
  constructor(readonly code: PeerControlErrorCode) {
    super(errors[code][1])
    this.name = 'PeerControlError'
    this.status = errors[code][0]
  }
}

const errorCodeSchema = z.custom<PeerControlErrorCode>((value) => typeof value === 'string' && Object.hasOwn(errors, value))
const responseBaseSchema = z.object({
  protocol: z.literal('TaskContinuum.PeerControl.Response.v1'),
  workspaceId: z.uuid(),
  senderId: z.uuid(),
  recipientId: z.uuid(),
  senderKeyId: fingerprintSchema,
  recipientKeyId: fingerprintSchema,
  grantId: z.uuid(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  timestamp: z.iso.datetime(),
  kind: kindSchema,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  signature: signatureSchema,
}).strict()
const responseSchema = z.discriminatedUnion('ok', [
  responseBaseSchema.extend({ ok: z.literal(true), payload: z.unknown() }),
  responseBaseSchema.extend({ ok: z.literal(false), error: z.object({ code: errorCodeSchema }).strict() }),
])

type MaybePromise<T> = T | Promise<T>
export interface PeerControlServerOptions {
  localId: string
  workspaceId: string
  keyPair: SshKeyPair
  authorize(senderId: string, publicKey: string, signal: AbortSignal): MaybePromise<boolean | void>
  onLink(senderId: string, signal: AbortSignal): MaybePromise<unknown>
  /** Validate every signed record, its actor, and dependency closure before applying an overlay. */
  onBinding(senderId: string, payload: PeerBindingPayload, signal: AbortSignal): MaybePromise<unknown>
  port?: number
  requestTimeoutMs?: number
  maxConcurrentRequests?: number
  maxReplayEntries?: number
  now?: () => number
}

export interface PeerControlTransport {
  connect(route: DevTunnelRoute, grantId: string, targetPort: number, signal: AbortSignal): Promise<{ port: number; close(): void }>
}
export interface PeerRequestIdentity {
  workspaceId: string
  local: { deviceId: string; keyPair: SshKeyPair }
  recipient: { deviceId: string; clientPublicKey: string }
  grantId: string
  expiresAt: string
}
export interface CallPeerOptions extends PeerRequestIdentity {
  recipient: PeerRequestIdentity['recipient'] & { hostPublicKey: string }
  route: DevTunnelRoute
  targetPort: number
  transport: PeerControlTransport
  timeoutMs?: number
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new PeerControlError('invalid-payload')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`
  if (typeof value === 'object' && value && [null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`
  }
  throw new PeerControlError('invalid-payload')
}

function encode(value: unknown): Buffer {
  const bytes = Buffer.from(canonicalJson(value))
  if (bytes.length > PEER_CONTROL_MAX_BYTES) throw new PeerControlError('too-large')
  return bytes
}

function signingKey(pair: SshKeyPair) {
  const key = ssh2.utils.parseKey(pair.privateKey)
  if (key instanceof Error || Array.isArray(key) || key.type !== 'ssh-ed25519'
    || key.getPublicSSH().toString('base64') !== sshPublicKeySchema.parse(pair.publicKey).split(' ')[1]) throw new PeerControlError('invalid-key')
  return key
}

function sign(value: unknown, pair: SshKeyPair): string {
  const signature = signingKey(pair).sign(encode(value))
  if (signature instanceof Error) throw new PeerControlError('invalid-key')
  return signature.toString('base64')
}

function verify(value: unknown, signature: string, publicKey: string): boolean {
  const key = ssh2.utils.parseKey(sshPublicKeySchema.parse(publicKey))
  const decoded = Buffer.from(signature, 'base64')
  return !(key instanceof Error) && !Array.isArray(key) && decoded.length === 64
    && decoded.toString('base64') === signature && key.verify(encode(value), decoded) === true
}

function parsePayload(kind: PeerControlKind, value: unknown): unknown {
  try { return kind === 'link' ? z.object({}).strict().parse(value) : bindingPayloadSchema.parse(value) } catch { throw new PeerControlError('invalid-payload') }
}

export function signPeerRequest(body: PeerControlRequestBody, keyPair: SshKeyPair): SignedPeerControlRequest {
  const parsed = requestBodySchema.parse(body)
  parsePayload(parsed.kind, parsed.payload)
  if (parsed.senderKeyId !== sshFingerprint(keyPair.publicKey)) throw new PeerControlError('invalid-key')
  const signed = { ...parsed, signature: sign(parsed, keyPair) }
  encode(signed)
  return signed
}

export function createPeerRequest(options: PeerRequestIdentity, kind: PeerControlKind, payload: unknown): SignedPeerControlRequest {
  return signPeerRequest({
    protocol: 'TaskContinuum.PeerControl.Request.v1',
    workspaceId: options.workspaceId,
    senderId: options.local.deviceId,
    recipientId: options.recipient.deviceId,
    senderKeyId: sshFingerprint(options.local.keyPair.publicKey),
    recipientKeyId: sshFingerprint(options.recipient.clientPublicKey),
    grantId: options.grantId,
    expiresAt: options.expiresAt,
    nonce: randomBytes(32).toString('base64url'),
    timestamp: new Date().toISOString(),
    kind,
    payload: parsePayload(kind, payload),
  }, options.local.keyPair)
}

function requestHash(request: SignedPeerControlRequest): string { return createHash('sha256').update(encode(request)).digest('hex') }
function asError(error: unknown, fallback: PeerControlErrorCode): PeerControlError { return error instanceof PeerControlError ? error : new PeerControlError(fallback) }

function readBody(message: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = message.headers['content-length']
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > PEER_CONTROL_MAX_BYTES)) { reject(new PeerControlError('too-large')); return }
    let size = 0
    const chunks: Buffer[] = []
    const finish = (error?: Error) => {
      message.off('data', data)
      message.off('end', end)
      message.off('aborted', aborted)
      message.off('error', failed)
      signal.removeEventListener('abort', aborted)
      if (error) { message.pause(); reject(error) } else resolve(Buffer.concat(chunks, size))
    }
    const data = (chunk: Buffer) => {
      size += chunk.length
      if (size > PEER_CONTROL_MAX_BYTES) finish(new PeerControlError('too-large'))
      else chunks.push(chunk)
    }
    const end = () => finish()
    const aborted = () => finish(asError(signal.reason, 'aborted'))
    const failed = () => finish(new PeerControlError('transport-failed'))
    message.on('data', data)
    message.once('end', end)
    message.once('aborted', aborted)
    message.once('error', failed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

type Grant = { id: string; senderId: string; publicKey: string; expiresAt: string; expires: number }

/** This listener grants metadata access only. The owner must separately register the same grant
 * with ManagedDevTunnels.authorize(grant, publicKey, controlPort, true), never a session port. */
export class PeerControlServer {
  private readonly http: Server
  private readonly sockets = new Set<Socket>()
  private readonly requests = new Map<AbortController, string | undefined>()
  private readonly grants = new Map<string, Grant>()
  private readonly replays = new Map<string, number>()
  private readonly maxConcurrent: number
  private readonly maxReplays: number
  private readonly timeoutMs: number
  private readonly listenPort: number
  private readonly keyId: string
  private starting?: Promise<{ port: number }>
  private closing?: Promise<void>
  private closed = false

  constructor(private readonly options: PeerControlServerOptions) {
    z.uuid().parse(options.localId)
    z.uuid().parse(options.workspaceId)
    this.keyId = sshFingerprint(options.keyPair.publicKey)
    sign({ protocol: 'TaskContinuum.PeerControl.KeyCheck.v1' }, options.keyPair)
    this.maxConcurrent = z.number().int().min(1).max(16).parse(options.maxConcurrentRequests ?? 8)
    this.maxReplays = z.number().int().min(1).max(4096).parse(options.maxReplayEntries ?? 2048)
    this.timeoutMs = z.number().int().min(10).max(30000).parse(options.requestTimeoutMs ?? ioTimeoutMs)
    this.listenPort = z.number().int().min(1024).max(65535).optional().parse(options.port) ?? 0
    this.http = createServer({ maxHeaderSize: 8192, requestTimeout: this.timeoutMs, headersTimeout: this.timeoutMs, keepAliveTimeout: 1, connectionsCheckingInterval: 1000 }, (request, response) => this.receive(request, response))
    this.http.maxRequestsPerSocket = 1
    this.http.on('connection', (socket) => {
      if (this.closed || this.sockets.size >= 32) { socket.destroy(); return }
      this.sockets.add(socket)
      socket.setTimeout(this.timeoutMs + 1000, () => socket.destroy())
      socket.on('error', () => {})
      socket.once('close', () => this.sockets.delete(socket))
    })
    this.http.on('checkContinue', (_request, response) => this.write(response, new PeerControlError('invalid-request')))
    this.http.on('checkExpectation', (_request, response) => this.write(response, new PeerControlError('invalid-request')))
  }

  private now(): number { return this.options.now?.() ?? Date.now() }

  start(): Promise<{ port: number }> {
    if (this.closed) return Promise.reject(new PeerControlError('closed'))
    this.starting ??= new Promise<{ port: number }>((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen(this.listenPort, '127.0.0.1', () => {
        this.http.off('error', reject)
        const address = this.http.address()
        if (!address || typeof address === 'string' || this.closed) { reject(new PeerControlError('closed')); return }
        resolve({ port: address.port })
      })
    })
    return this.starting
  }

  allow(grant: { id: string; expiresAt: string }, senderId: string, publicKey: string): void {
    z.uuid().parse(grant.id)
    z.uuid().parse(senderId)
    sshPublicKeySchema.parse(publicKey)
    const expires = Date.parse(z.iso.datetime().parse(grant.expiresAt))
    if (this.closed) throw new PeerControlError('closed')
    if (expires <= this.now() || expires > this.now() + 31 * 24 * 60 * 60 * 1000) throw new PeerControlError('expired-grant')
    for (const [id, existing] of this.grants) if (existing.expires <= this.now()) this.revoke(id)
    const previous = this.grants.get(grant.id)
    if (previous?.senderId === senderId && previous.publicKey === publicKey && previous.expiresAt === grant.expiresAt) return
    if (!previous && this.grants.size >= 32) throw new PeerControlError('busy')
    if (previous) this.revoke(grant.id)
    this.grants.set(grant.id, { ...grant, senderId, publicKey, expires })
  }

  revoke(grantId: string): void {
    this.grants.delete(grantId)
    for (const [controller, id] of this.requests) if (id === grantId) controller.abort(new PeerControlError('invalid-grant'))
  }

  private access(request: SignedPeerControlRequest, prior?: Grant): Grant {
    if (this.closed) throw new PeerControlError('closed')
    if (request.workspaceId !== this.options.workspaceId) throw new PeerControlError('wrong-workspace')
    if (request.recipientId !== this.options.localId || request.recipientKeyId !== this.keyId) throw new PeerControlError('wrong-recipient')
    const grant = this.grants.get(request.grantId)
    if (!grant || prior && prior !== grant || grant.senderId !== request.senderId
      || sshFingerprint(grant.publicKey) !== request.senderKeyId || grant.expiresAt !== request.expiresAt) throw new PeerControlError('invalid-grant')
    if (grant.expires <= this.now()) throw new PeerControlError('expired-grant')
    const timestamp = Date.parse(request.timestamp)
    if (timestamp > this.now() + futureSkewMs || this.now() - timestamp > PEER_CONTROL_MAX_AGE_MS) throw new PeerControlError('stale-request')
    return grant
  }

  private async trusted(request: SignedPeerControlRequest, grant: Grant, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    let allowed: boolean | void
    try { allowed = await this.options.authorize(request.senderId, grant.publicKey, signal) } catch { throw new PeerControlError('unauthorized') }
    signal.throwIfAborted()
    if (allowed === false) throw new PeerControlError('unauthorized')
    this.access(request, grant)
  }

  private response(request: SignedPeerControlRequest, result: { ok: true; payload: unknown } | { ok: false; error: { code: PeerControlErrorCode } }): Buffer {
    const body = {
      protocol: 'TaskContinuum.PeerControl.Response.v1' as const,
      workspaceId: this.options.workspaceId,
      senderId: this.options.localId,
      recipientId: request.senderId,
      senderKeyId: this.keyId,
      recipientKeyId: request.senderKeyId,
      grantId: request.grantId,
      nonce: request.nonce,
      timestamp: new Date(this.now()).toISOString(),
      kind: request.kind,
      requestHash: requestHash(request),
      ...result,
    }
    return encode({ ...body, signature: sign(body, this.options.keyPair) })
  }

  private write(response: ServerResponse, result: Buffer | PeerControlError, request?: SignedPeerControlRequest): void {
    if (response.destroyed || response.writableEnded) return
    const status = result instanceof PeerControlError ? result.status : 200
    const bytes = result instanceof PeerControlError
      ? request ? this.response(request, { ok: false, error: { code: result.code } }) : encode({ error: { code: result.code } })
      : result
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length, 'cache-control': 'no-store', connection: 'close' })
    response.end(bytes)
  }

  private receive(message: IncomingMessage, response: ServerResponse): void {
    if (this.closed) { this.write(response, new PeerControlError('closed')); return }
    if (this.requests.size >= this.maxConcurrent) { this.write(response, new PeerControlError('busy')); return }
    if (message.method !== 'POST' || message.url !== PEER_CONTROL_PATH
      || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(message.headers['content-type'] ?? '')
      || message.headers['content-encoding'] !== undefined || message.headers.origin !== undefined) {
      this.write(response, new PeerControlError('invalid-request')); return
    }
    const controller = new AbortController()
    this.requests.set(controller, undefined)
    let authenticated: SignedPeerControlRequest | undefined
    const aborted = () => this.write(response, asError(controller.signal.reason, 'aborted'), authenticated)
    controller.signal.addEventListener('abort', aborted, { once: true })
    const disconnected = () => { if (!response.writableEnded) controller.abort(new PeerControlError('aborted')) }
    response.once('close', disconnected)
    const timeout = setTimeout(() => controller.abort(new PeerControlError('timeout')), this.timeoutMs)
    timeout.unref()
    const work = async () => {
      const bytes = await readBody(message, controller.signal)
      let request: SignedPeerControlRequest
      try { request = requestSchema.parse(JSON.parse(bytes.toString('utf8'))) } catch { throw new PeerControlError('invalid-request') }
      const grant = this.access(request)
      const { signature, ...body } = request
      if (!verify(body, signature, grant.publicKey)) throw new PeerControlError('invalid-signature')
      authenticated = request
      this.requests.set(controller, request.grantId)
      for (const [nonce, expires] of this.replays) if (expires <= this.now()) this.replays.delete(nonce)
      const replayId = `${request.senderId}:${request.nonce}`
      if (this.replays.has(replayId)) throw new PeerControlError('replay')
      if (this.replays.size >= this.maxReplays) throw new PeerControlError('busy')
      this.replays.set(replayId, this.now() + PEER_CONTROL_REPLAY_TTL_MS)
      const payload = parsePayload(request.kind, request.payload)
      await this.trusted(request, grant, controller.signal)
      const result = request.kind === 'link'
        ? await this.options.onLink(request.senderId, controller.signal)
        : await this.options.onBinding(request.senderId, payload as PeerBindingPayload, controller.signal)
      await this.trusted(request, grant, controller.signal)
      return this.response(request, { ok: true, payload: result })
    }
    // Timed-out handlers retain their slot until they settle, even if they ignore cancellation.
    void work().then((bytes) => this.write(response, bytes), (error: unknown) => this.write(response, asError(error, 'operation-failed'), authenticated)).finally(() => {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', aborted)
      response.off('close', disconnected)
      this.requests.delete(controller)
    })
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true
      this.grants.clear()
      for (const controller of this.requests.keys()) controller.abort(new PeerControlError('closed'))
      this.http.closeAllConnections()
      for (const socket of this.sockets) socket.destroy()
      await this.starting?.catch(() => undefined)
      if (this.http.listening) await new Promise<void>((resolve) => this.http.close(() => resolve()))
      this.replays.clear()
    })()
    return this.closing
  }
}

/** Low-level signed HTTP exchange for an already-open SSH bridge; never accepts a remote host. */
export function postPeerRequest(port: number, request: SignedPeerControlRequest, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
  z.number().int().min(1024).max(65535).parse(port)
  const bytes = encode(request)
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const deadline = new AbortController()
    const combined = AbortSignal.any([signal, deadline.signal])
    const outbound = httpRequest({
      host: '127.0.0.1', port, path: PEER_CONTROL_PATH, method: 'POST', agent: false, signal: combined,
      maxHeaderSize: 8192,
      headers: { 'content-type': 'application/json', 'content-length': bytes.length, connection: 'close' },
    }, (response) => {
      void readBody(response, combined).then((body) => {
        try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(body.toString('utf8')) }) } catch { reject(new PeerControlError('invalid-response')) }
      }, (error: unknown) => { reject(error); response.destroy() })
    })
    const expire = () => deadline.abort(new PeerControlError('timeout'))
    const timeout = setTimeout(expire, ioTimeoutMs)
    timeout.unref()
    outbound.once('close', () => clearTimeout(timeout))
    outbound.setTimeout(ioTimeoutMs, expire)
    outbound.once('error', (error) => reject(combined.aborted ? asError(combined.reason, 'aborted') : asError(error, 'transport-failed')))
    outbound.end(bytes)
  })
}

function checkResponse(value: { status: number; body: unknown }, request: SignedPeerControlRequest, recipientPublicKey: string): unknown {
  const parsed = responseSchema.safeParse(value.body)
  if (!parsed.success) throw new PeerControlError('invalid-response')
  const { signature, ...body } = parsed.data
  if (body.workspaceId !== request.workspaceId || body.senderId !== request.recipientId || body.recipientId !== request.senderId
    || body.senderKeyId !== request.recipientKeyId || body.recipientKeyId !== request.senderKeyId || body.grantId !== request.grantId
    || body.kind !== request.kind || body.nonce !== request.nonce || body.requestHash !== requestHash(request)
    || Date.parse(body.timestamp) > Date.now() + futureSkewMs || Date.now() - Date.parse(body.timestamp) > PEER_CONTROL_MAX_AGE_MS
    || !verify(body, signature, recipientPublicKey)) throw new PeerControlError('invalid-response')
  if (!body.ok) {
    const error = new PeerControlError(body.error.code)
    if (value.status !== error.status) throw new PeerControlError('invalid-response')
    throw error
  }
  if (value.status !== 200) throw new PeerControlError('invalid-response')
  return body.payload
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(asError(signal.reason, 'aborted'))
    signal.addEventListener('abort', aborted, { once: true })
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
    if (signal.aborted) aborted()
  })
}

let activeCalls = 0

export async function callPeer(options: CallPeerOptions, kind: PeerControlKind, payload: unknown, signal?: AbortSignal): Promise<unknown> {
  if (activeCalls >= 16) throw new PeerControlError('busy')
  const route = devTunnelRouteSchema.parse(options.route)
  z.number().int().min(1024).max(65535).parse(options.targetPort)
  if (route.clientPublicKey !== options.local.keyPair.publicKey || route.hostPublicKey !== options.recipient.hostPublicKey) throw new PeerControlError('invalid-key')
  const expires = Date.parse(z.iso.datetime().parse(options.expiresAt)) - Date.now()
  if (expires <= 0) throw new PeerControlError('expired-grant')
  const timeoutMs = z.number().int().min(10).max(120000).parse(options.timeoutMs ?? 30000)
  const deadline = new AbortController()
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  if (combined.aborted) throw new PeerControlError('aborted')
  let signed = createPeerRequest(options, kind, payload)
  const timeout = setTimeout(() => deadline.abort(new PeerControlError(expires <= timeoutMs ? 'expired-grant' : 'timeout')), Math.min(expires, timeoutMs))
  timeout.unref()
  activeCalls++
  const work = async () => {
    let connection: Awaited<ReturnType<PeerControlTransport['connect']>> | undefined
    try {
      connection = await options.transport.connect(route, options.grantId, options.targetPort, combined)
      combined.throwIfAborted()
      signed = createPeerRequest(options, kind, payload)
      const response = await postPeerRequest(connection.port, signed, combined)
      combined.throwIfAborted()
      return checkResponse(response, signed, options.recipient.clientPublicKey)
    } catch (error) {
      throw combined.aborted ? asError(combined.reason, 'aborted') : asError(error, 'transport-failed')
    } finally {
      try { connection?.close() } finally { activeCalls-- }
    }
  }
  try { return await abortable(work(), combined) } finally { clearTimeout(timeout); deadline.abort(new PeerControlError('aborted')) }
}
