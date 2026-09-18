import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { basename, join } from 'node:path'
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
import { AgentHostCreationRequestError, AgentHostCreationService, agentHostCreationWorkspaceId } from './agentHostCreationService'
import { agentHostCreateCommandSchema, agentHostCreationBindSchema, agentHostCreationLookupSchema, agentHostWorkerCatalogSchema, creationTaskIdSchema } from './agentHostCreationProtocol'
import { canonicalPolicyRoot } from './linkedSessionPolicy'
import { readRepositorySessionLinks } from './repositorySessionLinks'
import { readTaskWorkspace } from './workspaceReader'
import type { AgentHostCreationWorkspace } from '../shared/agentHostCreation'

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

  constructor(private readonly directory: string, private readonly protector: DeviceProtector) {}

  setAgentHostAccess(registry: AgentHostRegistry, linked: (root: string) => Promise<AgentHostTarget[]>): void {
    if (this.server) throw new Error('Agent Host access must be configured before device publication.')
    this.agentHosts = { registry, linked }
    this.agentHostCreations = new AgentHostCreationService(this.directory, registry, (pairId, workspaceId) => this.authorizedCreationWorkspace(pairId, workspaceId))
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
    if (!this.agentHosts) throw new DeviceRequestError(404, true)
    const policies = JSON.stringify(pair.workspaces)
    const workspaces: AgentHostCreationWorkspace[] = []
    for (const policy of pair.workspaces) {
      let id: string
      let reachable = true
      try { id = await agentHostCreationWorkspaceId(policy.root) } catch {
        id = createHash('sha256').update(process.platform === 'win32' ? policy.root.toLowerCase() : policy.root).digest('hex')
        reachable = false
      }
      if (workspaces.some((workspace) => workspace.id === id)) continue
      const workspace: AgentHostCreationWorkspace = { id, name: basename(policy.root).slice(0, 300) || 'Authorized workspace', canSend: policy.canSend, taskState: 'unavailable', expectedRevision: null }
      try {
        if (!reachable) throw new Error('Unavailable workspace.')
        const [tasks, links] = await Promise.all([readTaskWorkspace(policy.root), readRepositorySessionLinks(policy.root)])
        workspace.expectedRevision = links.revision
        workspace.taskState = !tasks.tasks.some((task) => task.id === taskId) ? 'missing' : links.document.bindings[taskId] ? 'bound' : 'available'
      } catch { workspace.error = 'The authorized task workspace or its session bindings could not be read.' }
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
          if (!response.headersSent) response.writeHead(error instanceof DeviceRequestError || error instanceof AgentHostCreationRequestError ? error.status : error instanceof z.ZodError ? 400 : 503)
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
  private async body(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) { size += chunk.length; if (size > 32768) throw new Error('Request too large.'); chunks.push(chunk) }
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