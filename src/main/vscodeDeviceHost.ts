import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import { remoteClientSchema, remoteInvitationSchema, sameRemoteTarget } from './vscodeRemoteProtocol'
import type { RemoteVSCodeInvitation } from './vscodeRemoteProtocol'
import { vscodeIdentitySchema } from './vscodeChatSchemas'
import type { VSCodeChatIdentity } from '../shared/vscodeChat'
import { sshPublicKeySchema } from './devTunnel/protocol'
import { deviceRequest, DeviceRequestError } from './vscodeDeviceHttp'

const policySchema = z.object({ identity: vscodeIdentitySchema, canSend: z.boolean(), revision: z.uuid(), invitation: remoteInvitationSchema.optional(), linkedRoot: z.string().optional() }).strict()
const workspacePolicySchema = z.object({ root: z.string().min(1), canSend: z.boolean() }).strict()
const pairingSchema = z.object({ id: z.uuid(), participant: remoteClientSchema, publicKey: sshPublicKeySchema,
  token: z.string().regex(/^[a-zA-Z0-9_-]{43}$/), expiresAt: z.iso.datetime(), sessions: z.array(policySchema).max(32),
  workspaces: z.array(workspacePolicySchema).max(10).default([]),
}).strict()
const stateSchema = z.object({ ownerId: z.uuid(), port: z.number().int().min(1024).max(65535).optional(), pairs: z.array(pairingSchema).max(32) }).strict()
type Pairing = z.infer<typeof pairingSchema>
export interface DeviceProtector { available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string }

export class VSCodeDeviceHost {
  private state?: z.infer<typeof stateSchema>
  private readonly invitations = new Map<string, RemoteVSCodeInvitation>()
  private readonly pending = new Map<string, Promise<RemoteVSCodeInvitation>>()
  private server?: ReturnType<typeof createServer>
  private starting?: Promise<number>
  private writing: Promise<unknown> = Promise.resolve()
  private loading?: Promise<void>
  private closed = false
  private abort = new AbortController()

  constructor(private readonly directory: string, private readonly protector: DeviceProtector,
    private readonly resolve: (identity: VSCodeChatIdentity, participant: Pairing['participant'], canSend: boolean, prior?: RemoteVSCodeInvitation) => Promise<RemoteVSCodeInvitation>,
    private readonly revokeGrant: (invitation: RemoteVSCodeInvitation) => Promise<void> = async () => {},
    private readonly linkedSessions?: (root: string) => Promise<VSCodeChatIdentity[]>) {}

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
      const pair: Pairing = { id: randomUUID(), participant, publicKey, token: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), sessions: [], workspaces: [] }
      state.pairs.push(pair)
      return structuredClone(pair)
    })
  }

  async list(): Promise<Pairing[]> { await this.load(); return structuredClone(this.state!.pairs) }
  async ownerId(): Promise<string> { await this.load(); return this.state!.ownerId }
  async setWorkspace(id: string, root: string, permission: boolean | null): Promise<void> {
    const revoke: RemoteVSCodeInvitation[] = []
    await this.update((state) => {
      const pair = state.pairs.find((item) => item.id === id)
      if (!pair) throw new Error('Device not paired.')
      pair.workspaces = pair.workspaces.filter((item) => item.root !== root)
      if (permission !== null) pair.workspaces.push(workspacePolicySchema.parse({ root, canSend: permission }))
      pair.sessions = pair.sessions.filter((policy) => {
        if (policy.linkedRoot !== root) return true
        const invitation = policy.invitation ?? this.invitations.get(this.key(id, policy.identity))
        if (invitation) revoke.push(invitation)
        this.invitations.delete(this.key(id, policy.identity))
        return false
      })
    })
    for (const invitation of revoke) await this.revokeGrant(invitation).catch(() => undefined)
  }
  private async refreshLinked(id: string): Promise<void> {
    const pair = this.state!.pairs.find((item) => item.id === id)
    if (!pair || !this.linkedSessions) return
    const roots = JSON.stringify(pair.workspaces)
    const desired: { identity: VSCodeChatIdentity; canSend: boolean; linkedRoot: string }[] = []
    for (const policy of pair.workspaces) {
      let identities: VSCodeChatIdentity[] = []
      try { identities = await this.linkedSessions(policy.root) } catch { identities = [] }
      for (const identity of identities) desired.push({ identity: vscodeIdentitySchema.parse(identity), canSend: policy.canSend, linkedRoot: policy.root })
    }
    const signature = (policy: { identity: VSCodeChatIdentity; canSend: boolean; linkedRoot?: string }) => JSON.stringify([policy.linkedRoot, policy.identity, policy.canSend])
    const old = pair.sessions.filter((item) => item.linkedRoot)
    if (JSON.stringify(old.map(signature).sort()) === JSON.stringify(desired.map(signature).sort())) return
    const removed: RemoteVSCodeInvitation[] = []
    await this.update((state) => {
      const current = state.pairs.find((item) => item.id === id)
      if (!current || JSON.stringify(current.workspaces) !== roots) throw new Error('Workspace policy changed.')
      for (const policy of current.sessions.filter((item) => item.linkedRoot)) {
        if (desired.some((item) => signature(item) === signature(policy))) continue
        const invitation = policy.invitation ?? this.invitations.get(this.key(id, policy.identity))
        if (invitation) removed.push(invitation)
        this.invitations.delete(this.key(id, policy.identity))
      }
      const manual = current.sessions.filter((item) => !item.linkedRoot)
      current.sessions = manual.concat(desired.filter((item) => !manual.some((policy) => sameRemoteTarget(policy.identity, item.identity))).map((item) => current.sessions.find((policy) => signature(policy) === signature(item)) ?? { ...item, revision: randomUUID() }))
    })
    for (const invitation of removed) await this.revokeGrant(invitation).catch(() => undefined)
  }
  async approve(id: string, identity: VSCodeChatIdentity, canSend: boolean): Promise<void> {
    const policy = policySchema.parse({ identity, canSend, revision: randomUUID() })
    const previous = (await this.list()).find((pair) => pair.id === id)?.sessions.find((item) => sameRemoteTarget(item.identity, identity))?.invitation
    await this.update((state) => {
      const pair = state.pairs.find((item) => item.id === id)
      if (!pair || Date.parse(pair.expiresAt) <= Date.now()) throw new Error('Device pairing is unavailable or expired.')
      pair.sessions = pair.sessions.filter((item) => !sameRemoteTarget(item.identity, identity)).concat(policy)
    })
    const prior = this.invitations.get(this.key(id, identity)) ?? previous
    this.invitations.delete(this.key(id, identity))
    if (prior) await this.revokeGrant(prior)
  }
  async revokeSession(id: string, identity: VSCodeChatIdentity): Promise<void> {
    const previous = (await this.list()).find((pair) => pair.id === id)?.sessions.find((item) => sameRemoteTarget(item.identity, identity))?.invitation
    await this.update((state) => { const pair = state.pairs.find((item) => item.id === id); if (pair) pair.sessions = pair.sessions.filter((item) => !sameRemoteTarget(item.identity, identity)) })
    const prior = this.invitations.get(this.key(id, identity)) ?? previous
    this.invitations.delete(this.key(id, identity))
    if (prior) await this.revokeGrant(prior)
  }
  async revoke(id: string): Promise<void> {
    const pair = (await this.list()).find((item) => item.id === id)
    await this.update((state) => { state.pairs = state.pairs.filter((pair) => pair.id !== id) })
    for (const policy of pair?.sessions ?? []) {
      const key = this.key(id, policy.identity)
      const prior = this.invitations.get(key) ?? policy.invitation
      this.invitations.delete(key)
      if (prior) await this.revokeGrant(prior)
    }
  }
  private key(id: string, identity: VSCodeChatIdentity): string { return JSON.stringify([id, identity.workspaceStorageId, identity.nativeSessionId]) }
  private permitted(id: string, identity?: VSCodeChatIdentity, send = false): boolean {
    const pair = this.state?.pairs.find((item) => item.id === id)
    return !!pair && Date.parse(pair.expiresAt) > Date.now() && (!identity || pair.sessions.some((policy) => sameRemoteTarget(policy.identity, identity) && (!send || policy.canSend)))
  }
  private currentPolicy(id: string, policy: z.infer<typeof policySchema>): boolean {
    return this.permitted(id, policy.identity, policy.canSend) && !!this.state?.pairs.find((pair) => pair.id === id)?.sessions.some((item) => item.revision === policy.revision)
  }

  private async invitation(pair: Pairing, policy: z.infer<typeof policySchema>): Promise<RemoteVSCodeInvitation> {
    const key = this.key(pair.id, policy.identity)
    const pendingKey = `${key}:${policy.revision}`
    const existing = this.pending.get(pendingKey)
    if (existing) return existing
    const operation = (async () => {
      const value = remoteInvitationSchema.parse(await this.resolve(policy.identity, pair.participant, policy.canSend, policy.invitation ?? this.invitations.get(key)))
      if (!sameRemoteTarget(value.identity, policy.identity) || JSON.stringify(value.grant.participant) !== JSON.stringify(pair.participant) || value.grant.canSend !== policy.canSend || value.execution.machineName.toLowerCase() !== hostname().toLowerCase()) throw new Error('The original session identity changed.')
      if (!this.currentPolicy(pair.id, policy)) { await this.revokeGrant(value); throw new Error('Session access was revoked.') }
      if (JSON.stringify(value) !== JSON.stringify(policy.invitation)) await this.update((state) => {
        const current = state.pairs.find((item) => item.id === pair.id)?.sessions.find((item) => item.revision === policy.revision)
        if (!current) throw new Error('Session access changed.')
        current.invitation = value
      })
      this.invitations.set(key, value)
      return value
    })()
    this.pending.set(pendingKey, operation)
    try { return await operation } finally { this.pending.delete(pendingKey) }
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
          await this.refreshLinked(pair.id)
          pair = this.state!.pairs.find((item) => item.id === pair!.id)
          if (!pair) { response.writeHead(403).end(); return }
          if (!this.permitted(pair.id)) { response.writeHead(403).end(); return }
          let result: unknown
          if (request.url === '/device/sessions') {
            z.object({}).strict().parse(body)
            const sessions: RemoteVSCodeInvitation[] = []
            for (const policy of pair.sessions) {
              try { sessions.push(await this.invitation(pair, policy)) } catch { continue }
            }
            await this.refreshLinked(pair.id)
            result = { ownerId: this.state!.ownerId, deviceId: pair.id, sessions: sessions.filter((item) => this.permitted(pair.id, item.identity, item.grant.canSend)) }
          } else {
            const route = /^\/device\/session\/(read|send|open)$/.exec(request.url ?? '')
            if (!route) { response.writeHead(404).end(); return }
            const command = z.object({ identity: vscodeIdentitySchema, id: z.uuid().optional(), text: z.string().trim().min(1).max(4000).optional() }).strict().parse(body)
            const sending = route[1] === 'send'
            const controlling = sending || route[1] === 'open'
            if (sending && (!command.id || !command.text)) { response.writeHead(400).end(); return }
            if (!this.permitted(pair.id, command.identity, controlling)) { response.writeHead(403).end(); return }
            const policy = pair.sessions.find((item) => sameRemoteTarget(item.identity, command.identity))!
            const invitation = await this.invitation(pair, policy)
            await this.refreshLinked(pair.id)
            if (!this.currentPolicy(pair.id, policy)) { response.writeHead(403).end(); return }
            result = await deviceRequest(invitation.port, invitation.port, invitation.token, `/remote/${route[1]}`, { ...command.identity, ...(sending ? { id: command.id, text: command.text } : {}) }, this.abort.signal)
            await this.refreshLinked(pair.id)
            if (!this.currentPolicy(pair.id, policy)) { response.writeHead(403).end(); return }
          }
          if (!this.permitted(pair.id)) { response.writeHead(403).end(); return }
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify(result))
        })().catch((error: unknown) => { if (!response.headersSent) response.writeHead(error instanceof DeviceRequestError ? error.status : 503); response.end() })
      })
      server.requestTimeout = 15000
      server.headersTimeout = 10000
      server.maxConnections = 64
      this.server = server
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
    await this.starting?.catch(() => undefined)
    this.server?.closeAllConnections()
    if (this.server?.listening) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
  }
}