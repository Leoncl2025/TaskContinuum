import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { z } from 'zod'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import { remoteClientSchema } from './vscodeRemoteProtocol'
import { sshPublicKeySchema } from './devTunnel/protocol'
import { DeviceRequestError } from './vscodeDeviceHttp'
import { attachAgentHostGateway } from './agentHostGateway'
import type { AgentHostAccess } from './agentHostGateway'
import type { AgentHostSession, AgentHostTarget } from '../shared/agentHost'
import type { AgentHostRegistry } from './agentHostRegistry'
import { agentHostKey } from './agentHostProtocol'
import { AgentHostCreationRequestError, AgentHostCreationService, agentHostCreationWorkspaceId, describeAgentHostCreationWorkspace } from './agentHostCreationService'
import { agentHostCreateCommandSchema, agentHostCreationBindSchema, agentHostCreationLookupSchema, agentHostWorkerCatalogSchema, creationTaskIdSchema } from './agentHostCreationProtocol'
import { canonicalPolicyRoot } from './linkedSessionPolicy'
import type { AgentHostCreationWorkspace } from '../shared/agentHostCreation'
import type { FileTransferSource } from './fileTransferSource'
import { chunkRequestSchema, exportRequestSchema, FileTransferError, transferFailure, transferLookupSchema } from '../shared/fileTransfer'
import { FileTransferBudget } from './fileTransferBudget'

const workspacePolicySchema = z.object({ root: z.string().min(1), canSend: z.boolean() }).strict()
const pairingSchema = z.object({ id: z.uuid(), participant: remoteClientSchema, publicKey: sshPublicKeySchema,
  token: z.string().regex(/^[a-zA-Z0-9_-]{43}$/), expiresAt: z.iso.datetime(),
  // Preserve retired grants as opaque data, never as authorization or session discovery.
  sessions: z.array(z.unknown()).max(32).optional(),
  workspaces: z.array(workspacePolicySchema).max(10).default([]),
}).strict()
const stateSchema = z.object({ ownerId: z.uuid(), port: z.number().int().min(1024).max(65535).optional(), pairs: z.array(pairingSchema).max(32) }).strict()
type Pairing = z.infer<typeof pairingSchema>
export interface DeviceProtector { available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string }

export class VSCodeDeviceHost {
  private state?: z.infer<typeof stateSchema>
  private server?: ReturnType<typeof createServer>
  private starting?: Promise<number>
  private writing: Promise<unknown> = Promise.resolve()
  private loading?: Promise<void>
  private closed = false
  private abort = new AbortController()
  private agentHosts?: { registry: AgentHostRegistry; linked(root: string): Promise<AgentHostTarget[]> }
  private agentHostGateway?: ReturnType<typeof attachAgentHostGateway>
  private agentHostCreations?: AgentHostCreationService
  private fileSource?: FileTransferSource
  private fileBudget = new FileTransferBudget()

  constructor(private readonly directory: string, private readonly protector: DeviceProtector) {}

  setFileTransferSource(source: FileTransferSource, budget = new FileTransferBudget()): void {
    if (this.server) throw new Error('File transfers must be configured before device publication.')
    this.fileSource = source
    this.fileBudget = budget
  }

  setAgentHostAccess(registry: AgentHostRegistry, linked: (root: string) => Promise<AgentHostTarget[]>,
    authorizeLocal?: (ownerId: string, workspaceId: string) => Promise<string>): void {
    if (this.server) throw new Error('Agent Host access must be configured before device publication.')
    this.agentHosts = { registry, linked }
    this.agentHostCreations = new AgentHostCreationService(this.directory, registry, (pairId, workspaceId) => this.authorizedCreationWorkspace(pairId, workspaceId), authorizeLocal)
  }

  // Share reservations so local and incoming remote requests cannot race for the same task.
  get taskCreationService(): AgentHostCreationService {
    if (this.closed || !this.agentHostCreations) throw new Error('The task creation service is unavailable.')
    return this.agentHostCreations
  }

  private async authorizedCreationWorkspace(pairId: string, workspaceId: string): Promise<string> {
    await this.load()
    await this.writing
    const pair = this.state!.pairs.find((item) => item.id === pairId)
    if (this.closed || !pair || !this.permitted(pairId) || !this.agentHosts) throw new AgentHostCreationRequestError(403, 'The original device pairing is unavailable, revoked, or expired.')
    for (const policy of pair.workspaces) {
      if (!policy.canSend) continue
      let canonical: string
      try {
        canonical = await canonicalPolicyRoot(policy.root)
        if (await agentHostCreationWorkspaceId(canonical) !== workspaceId) continue
      } catch { continue }
      await this.writing
      const current = this.state!.pairs.find((item) => item.id === pairId)
      if (this.closed || !this.permitted(pairId) || !current?.workspaces.some((item) => item.root === policy.root && item.canSend)) throw new AgentHostCreationRequestError(403, 'Workspace send permission changed.')
      return canonical
    }
    throw new AgentHostCreationRequestError(403, 'The paired workspace does not currently grant send permission.')
  }

  private async agentHostWorkers(pair: Pairing, taskId: string) {
    if (!this.agentHosts || !this.agentHostCreations) throw new DeviceRequestError(404, true)
    await this.agentHostCreations.checkReady()
    const policies = JSON.stringify(pair.workspaces)
    const workspaces: AgentHostCreationWorkspace[] = []
    for (const policy of pair.workspaces) {
      const workspace = await describeAgentHostCreationWorkspace(policy.root, taskId, policy.canSend)
      if (workspaces.some((existing) => existing.id === workspace.id)) continue
      workspaces.push(workspace)
    }
    const hosts = await this.agentHosts.registry.creationHosts(AbortSignal.any([this.abort.signal, AbortSignal.timeout(8000)]))
    const owner = await this.agentHosts.registry.creationOwner()
    await this.writing
    const current = this.state!.pairs.find((item) => item.id === pair.id)
    if (this.closed || !current || !this.permitted(pair.id) || JSON.stringify(current.workspaces) !== policies) throw new AgentHostCreationRequestError(403, 'The device pairing or authorized workspace policy changed.')
    return agentHostWorkerCatalogSchema.parse({ ownerId: this.state!.ownerId, deviceId: pair.id, owner, hosts, workspaces })
  }

  private async authorizedAgentHost(token: string, target: AgentHostTarget, send: boolean): Promise<AgentHostAccess> {
    await this.load()
    const pair = this.state!.pairs.find((item) => Buffer.byteLength(token) === Buffer.byteLength(item.token) && timingSafeEqual(Buffer.from(token), Buffer.from(item.token)))
    if (!pair || !this.permitted(pair.id) || !this.agentHosts) throw new Error('Device access is unavailable.')
    const policy = JSON.stringify(pair.workspaces)
    for (const workspace of pair.workspaces) {
      if (send && !workspace.canSend) continue
      const linked = await this.agentHosts.linked(workspace.root).catch(() => [])
      if (!linked.some((item) => agentHostKey(item) === agentHostKey(target))) continue
      const current = this.state!.pairs.find((item) => item.id === pair.id)
      if (!current || !this.permitted(pair.id) || JSON.stringify(current.workspaces) !== policy) throw new Error('Device policy changed.')
      return { canSend: workspace.canSend, actor: pair.participant }
    }
    throw new Error('The exact Agent Host chat has not been locally confirmed for this workspace.')
  }

  private async agentHostCatalog(pair: Pairing) {
    if (!this.agentHosts) throw new DeviceRequestError(404)
    const sessions: AgentHostSession[] = []
    for (const workspace of pair.workspaces) for (const target of await this.agentHosts.linked(workspace.root).catch(() => [])) {
      try {
        await this.authorizedAgentHost(pair.token, target, false)
        const description = await this.agentHosts.registry.describe(target)
        const access = await this.authorizedAgentHost(pair.token, target, false)
        if (!sessions.some((item) => agentHostKey(item) === agentHostKey(description))) sessions.push({ ...description, canSend: access.canSend && description.canSend })
      } catch { continue }
    }
    return { ownerId: this.state!.ownerId, deviceId: pair.id, sessions }
  }

  private async load(): Promise<void> {
    this.loading ??= (async () => {
      if (!this.protector.available()) throw new Error('Secure storage is required for device pairing.')
      try {
        const encrypted = z.object({ encrypted: z.string().max(4 * 1024 * 1024) }).strict().parse(await readJsonBounded(join(this.directory, 'remote-vscode-device-host.json'), 5 * 1024 * 1024))
        this.state = stateSchema.parse(JSON.parse(this.protector.decrypt(Buffer.from(encrypted.encrypted, 'base64'))))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Device pairing storage is unreadable. It was not replaced.')
        this.state = { ownerId: randomUUID(), pairs: [] }
      }
    })()
    return this.loading
  }

  private async update<Result>(action: (state: z.infer<typeof stateSchema>) => Result): Promise<Result> {
    const operation = this.writing.then(async () => {
      await this.load()
      if (this.closed) throw new Error('Device host is closed.')
      const next = structuredClone(this.state!)
      const result = action(next)
      stateSchema.parse(next)
      await writeJsonAtomic(join(this.directory, 'remote-vscode-device-host.json'), { encrypted: this.protector.encrypt(JSON.stringify(next)).toString('base64') })
      this.state = next
      return result
    })
    this.writing = operation.catch(() => undefined)
    return operation
  }

  async pair(participant: Pairing['participant'], publicKey: string): Promise<Pairing> {
    remoteClientSchema.parse(participant)
    sshPublicKeySchema.parse(publicKey)
    return this.update((state) => {
      const existing = state.pairs.find((pair) => pair.participant.clientId === participant.clientId)
      if (existing) {
        if (existing.publicKey !== publicKey || JSON.stringify(existing.participant) !== JSON.stringify(participant)) throw new Error('The paired device identity changed. Revoke it before pairing again.')
        if (Date.parse(existing.expiresAt) <= Date.now()) throw new Error('The device pairing expired. Revoke it before pairing again.')
        return structuredClone(existing)
      }
      if (state.pairs.length >= 32) throw new Error('Device pairing limit reached.')
      const pair: Pairing = { id: randomUUID(), participant, publicKey, token: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), workspaces: [] }
      state.pairs.push(pair)
      return structuredClone(pair)
    })
  }

  async list(): Promise<Pairing[]> { await this.load(); return structuredClone(this.state!.pairs) }
  async ownerId(): Promise<string> { await this.load(); return this.state!.ownerId }
  async setWorkspace(id: string, root: string, permission: boolean | null): Promise<void> {
    const originalRoot = root
    root = permission === null ? await canonicalPolicyRoot(root).catch(() => process.platform === 'win32' ? root.toLowerCase() : root) : await canonicalPolicyRoot(root)
    await this.update((state) => {
      const pair = state.pairs.find((item) => item.id === id)
      if (!pair) throw new Error('Device not paired.')
      pair.workspaces = pair.workspaces.filter((item) => item.root !== root && item.root !== originalRoot)
      if (permission !== null) pair.workspaces.push(workspacePolicySchema.parse({ root, canSend: permission }))
    })
    this.agentHostGateway?.revalidate()
  }
  async revoke(id: string): Promise<void> {
    await this.update((state) => { state.pairs = state.pairs.filter((pair) => pair.id !== id) })
    this.agentHostGateway?.revalidate()
  }
  private permitted(id: string): boolean {
    const pair = this.state?.pairs.find((item) => item.id === id)
    return !this.closed && !!pair && Date.parse(pair.expiresAt) > Date.now()
  }

  private async fileRequest(request: IncomingMessage, response: ServerResponse, pair: Pairing): Promise<void> {
    if (!this.fileSource) throw new FileTransferError('UNSUPPORTED', 'Update Task Continuum on the source device to enable file transfers.')
    const source = this.fileSource
    let release: (() => void) | undefined
    const abort = new AbortController()
    const disconnected = () => { if (!response.writableFinished) abort.abort() }
    request.once('aborted', disconnected)
    response.once('close', disconnected)
    const signal = AbortSignal.any([this.abort.signal, abort.signal])
    const authorize = async () => {
      signal.throwIfAborted()
      await this.writing
      const current = this.state?.pairs.find((item) => item.id === pair.id)
      if (!current || current.token !== pair.token || !this.permitted(pair.id) || !current.workspaces.length) {
        throw new FileTransferError('ACCESS_DENIED', 'The trusted device pairing is unavailable, revoked or expired.')
      }
    }
    try {
      await authorize()
      const body = await this.body(request, 64 * 1024)
      await authorize()
      if (request.url === '/device/files/prepare' || request.url === '/device/files/chunk') release = this.fileBudget.acquire(pair.participant.clientId)
      let result: unknown
      if (request.url === '/device/files/capabilities') {
        z.object({}).strict().parse(body)
        result = { protocolVersion: 1, ownerId: this.state!.ownerId, pairId: pair.id }
      } else if (request.url === '/device/files/prepare') result = await source.prepare(pair.id, exportRequestSchema.parse(body), authorize, signal)
      else if (request.url === '/device/files/chunk') {
        const value = chunkRequestSchema.parse(body)
        result = await source.chunk(pair.id, value.transferId, value.fileId, value.offset, authorize, signal)
      } else if (request.url === '/device/files/release') {
        await source.release(pair.id, transferLookupSchema.parse(body).transferId, authorize)
        result = {}
      } else throw new FileTransferError('NOT_FOUND', 'File transfer operation not found.')
      await authorize()
      if (Buffer.isBuffer(result)) response.setHeader('Content-Type', 'application/octet-stream')
      else response.setHeader('Content-Type', 'application/json')
      response.setHeader('Cache-Control', 'no-store')
      await new Promise<void>((resolve, reject) => {
        const finished = () => { cleanup(); resolve() }
        const interrupted = () => { cleanup(); reject(new FileTransferError('UNAVAILABLE', 'File transfer connection closed before delivery.')) }
        const cleanup = () => { response.off('finish', finished); response.off('close', interrupted); response.off('error', interrupted) }
        response.once('finish', finished)
        response.once('close', interrupted)
        response.once('error', interrupted)
        response.end(Buffer.isBuffer(result) ? result : JSON.stringify(result))
      })
    } finally {
      release?.()
      request.off('aborted', disconnected)
      response.off('close', disconnected)
    }
  }

  async start(): Promise<number> {
    if (this.closed) throw new Error('Device host is closed.')
    this.starting ??= (async () => {
      await this.load()
      const server = createServer((request, response) => {
        void (async () => {
          if (request.method !== 'POST' || request.headers.origin || request.headers.host !== `127.0.0.1:${this.state!.port}`) { response.writeHead(403).end(); return }
          const bearer = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
          let pair = this.state!.pairs.find((item) => Buffer.byteLength(bearer) === Buffer.byteLength(item.token) && timingSafeEqual(Buffer.from(bearer), Buffer.from(item.token)))
          if (!pair || !this.permitted(pair.id)) { response.writeHead(403).end(); return }
          if (request.url?.startsWith('/device/files/')) {
            await this.fileRequest(request, response, pair)
            return
          }
          const body = await this.body(request)
          const creationRoute = ['/device/agent-host/workers', '/device/agent-host/create', '/device/agent-host/creation-status', '/device/agent-host/creation-bind'].includes(request.url ?? '')
          pair = this.state!.pairs.find((item) => item.id === pair!.id)
          if (!pair) { response.writeHead(403).end(); return }
          if (!this.permitted(pair.id)) { response.writeHead(403).end(); return }
          let result: unknown
          if (creationRoute) {
            if (!this.agentHostCreations) throw new DeviceRequestError(404, true)
            if (request.url === '/device/agent-host/workers') result = await this.agentHostWorkers(pair, z.object({ taskId: creationTaskIdSchema }).strict().parse(body).taskId)
            else if (request.url === '/device/agent-host/create') result = await this.agentHostCreations.begin(pair.id, agentHostCreateCommandSchema.parse(body))
            else if (request.url === '/device/agent-host/creation-status') result = await this.agentHostCreations.status(pair.id, agentHostCreationLookupSchema.parse(body))
            else result = await this.agentHostCreations.bind(pair.id, agentHostCreationBindSchema.parse(body))
          } else if (request.url === '/device/identity') {
            z.object({}).strict().parse(body)
            result = { ownerId: this.state!.ownerId, deviceId: pair.id }
          } else if (request.url === '/device/agent-host/sessions') {
            z.object({}).strict().parse(body)
            result = await this.agentHostCatalog(pair)
          } else {
            response.writeHead(404).end()
            return
          }
          if (!this.permitted(pair.id)) { response.writeHead(403).end(); return }
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify(result))
        })().catch((error: unknown) => {
          if (request.url?.startsWith('/device/files/') && !response.headersSent) {
            const failure = transferFailure(error)
            const status = failure.code === 'ACCESS_DENIED' ? 403 : failure.code === 'UNSUPPORTED' ? 404 : failure.code === 'BUSY' ? 429 : 400
            response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
            response.end(JSON.stringify({ error: failure }))
            return
          }
          if (!response.headersSent) {
            const status = error instanceof DeviceRequestError || error instanceof AgentHostCreationRequestError ? error.status : error instanceof z.ZodError ? 400 : 503
            if (error instanceof AgentHostCreationRequestError && error.code) {
              response.writeHead(status, { 'Content-Type': 'application/json' })
              response.end(JSON.stringify({ error: { code: error.code } }))
              return
            }
            response.writeHead(status)
          }
          response.end()
        })
      })
      server.requestTimeout = 15000
      server.headersTimeout = 10000
      server.maxConnections = 64
      this.server = server
      if (this.agentHosts) this.agentHostGateway = attachAgentHostGateway(server, { port: () => this.state?.port,
        authorize: (token, target, send) => this.authorizedAgentHost(token, target, send), connection: (target) => this.agentHosts!.registry.connection(target) })
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.state!.port ?? 0, '127.0.0.1', resolve) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Device gateway could not listen.')
      await this.update((state) => { state.port = address.port })
      return address.port
    })().catch((error) => { this.starting = undefined; this.server?.close(); throw error })
    return this.starting
  }
  private async body(request: IncomingMessage, maximum = 32768): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) { size += chunk.length; if (size > maximum) throw new Error('Request too large.'); chunks.push(chunk) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  async close(): Promise<void> {
    this.closed = true
    this.abort.abort()
    this.agentHostGateway?.close()
    await this.agentHostCreations?.close()
    await this.starting?.catch(() => undefined)
    this.server?.closeAllConnections()
    if (this.server?.listening) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
  }
}