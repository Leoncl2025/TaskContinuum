import { randomUUID } from 'node:crypto'
import { realpath, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { z } from 'zod'
import type { RemoteVSCodeClientIdentity, RemoteVSCodeConnection, VSCodeChatTarget } from '../shared/remoteVSCode'
import type { VSCodeChatDelivery, VSCodeChatView } from '../shared/vscodeChat'
import { openSshTunnel } from './shared/ssh'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import { deliverySchema } from './vscodeChatDelivery'
import { remoteClientSchema, remoteHandshakeSchema, remoteHistorySchema, remoteInvitationFileSchema, sameRemoteTarget, sshHostAliasSchema, vscodeTargetSchema } from './vscodeRemoteProtocol'
import type { RemoteVSCodeInvitation } from './vscodeRemoteProtocol'
import type { DevTunnelRoute } from './devTunnel/protocol'
import type { VSCodeDeviceClient } from './vscodeDeviceClient'
import { readClientIdentity } from './clientIdentity'
import { readRepositorySessionLinks } from './repositorySessionLinks'

const enrollmentSchema = z.object({ id: z.uuid(), root: z.string().min(1).max(4000), hostAlias: sshHostAliasSchema.optional(), invitation: remoteInvitationFileSchema }).strict()
  .refine((entry) => Boolean(entry.invitation.devTunnel) !== Boolean(entry.hostAlias), 'Exactly one remote transport is required.')
type Enrollment = z.infer<typeof enrollmentSchema>
type Tunnel = Awaited<ReturnType<typeof openSshTunnel>>
type ActiveConnection = { tunnel: Tunnel; abort: AbortController }
const maximumResponseBytes = 4 * 1024 * 1024

function sameParticipant(left: RemoteVSCodeClientIdentity, right: RemoteVSCodeClientIdentity): boolean {
  return left.clientId === right.clientId && left.username === right.username && left.machineName === right.machineName
}

function targetOf(invitation: RemoteVSCodeInvitation): VSCodeChatTarget {
  return { ...invitation.identity, remoteMachineName: invitation.execution.machineName }
}

export class RemoteVSCodeManager {
  private readonly entries = new Map<string, Enrollment>()
  private readonly active = new Map<string, ActiveConnection>()
  private readonly connecting = new Map<string, Promise<void>>()
  private readonly attempts = new Map<string, AbortController>()
  private readonly reads = new Map<string, Promise<VSCodeChatView>>()
  private readonly revisions = new Map<string, number>()
  private readonly reconnect = new Map<string, { root: string; after: number }>()
  private loading?: Promise<void>
  private writing: Promise<unknown> = Promise.resolve()
  private identityValue?: Promise<RemoteVSCodeClientIdentity>
  private readonly file: string

  constructor(private readonly directory: string, private readonly options: {
    tunnel?: (hostAlias: string, remotePort: number, signal: AbortSignal) => Promise<Tunnel>
    devTunnel?: (route: DevTunnelRoute, grantId: string, remotePort: number, signal: AbortSignal) => Promise<Tunnel>
    devTunnelPublicKey?: () => Promise<string>
    identity?: () => Promise<RemoteVSCodeClientIdentity>
    devices?: VSCodeDeviceClient
  } = {}) { this.file = join(directory, 'remote-vscode-enrollments.json') }

  identity(): Promise<RemoteVSCodeClientIdentity> {
    this.identityValue ??= (async () => {
      if (this.options.identity) return remoteClientSchema.parse(await this.options.identity())
      return readClientIdentity(this.directory)
    })()
    return this.identityValue
  }
  async resolveTarget(root: string, value: unknown): Promise<VSCodeChatTarget> {
    const target = vscodeTargetSchema.parse(value)
    const { document } = await readRepositorySessionLinks(root)
    const candidates = Object.values(document.bindings).filter((link) => link.provider === 'vscode-copilot' && link.sessionId === target.nativeSessionId && link.workspaceStorageId === target.workspaceStorageId && (!target.remoteMachineName || (link.owner?.machineName ?? link.remoteMachineName)?.toLowerCase() === target.remoteMachineName.toLowerCase()))
    if (candidates.length > 1) throw new Error('Ambiguous repository session identity.')
    const owner = candidates[0]?.owner
    if (!owner) return target
    const local = await this.identity()
    return { nativeSessionId: target.nativeSessionId, workspaceStorageId: target.workspaceStorageId, ...(owner.clientId === local.clientId ? {} : { remoteMachineName: owner.machineName }) }
  }
  async remoteOwner(root: string, target: VSCodeChatTarget) { return this.options.devices?.owner(root, target) }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      let values: Enrollment[]
      try { values = z.array(enrollmentSchema).max(32).parse(await readJsonBounded(this.file)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw new Error('Remote VS Code enrollments are invalid. The file was not changed.')
      }
      for (const entry of values) {
        if (this.entries.has(entry.id) || [...this.entries.values()].some((item) => item.root === entry.root && sameRemoteTarget(targetOf(item.invitation), targetOf(entry.invitation)))) throw new Error('Remote VS Code enrollments contain duplicate identities.')
        this.entries.set(entry.id, entry)
      }
    })()
    return this.loading
  }

  private update<Result>(action: () => Promise<Result>): Promise<Result> {
    const operation = this.writing.then(async () => { await this.load(); return action() })
    this.writing = operation.catch(() => undefined)
    return operation
  }

  private async root(value: string): Promise<string> {
    const root = await realpath(value)
    return process.platform === 'win32' ? root.toLowerCase() : root
  }

  private summary(entry: Enrollment): RemoteVSCodeConnection {
    const { invitation } = entry
    return { id: entry.id, target: targetOf(invitation), title: invitation.title, hostAlias: entry.hostAlias ?? '',
      transport: invitation.devTunnel ? 'dev-tunnel' : 'ssh', tunnelId: invitation.devTunnel?.tunnelId,
      participant: invitation.grant.participant, execution: invitation.execution, canSend: invitation.grant.canSend, expiresAt: invitation.grant.expiresAt,
      state: this.active.has(entry.id) ? 'connected' : this.connecting.has(entry.id) ? 'connecting' : 'disconnected' }
  }

  async list(root: string): Promise<RemoteVSCodeConnection[]> {
    await this.load()
    const canonical = await this.root(root)
    const devices = await this.options.devices?.sessions(root) ?? []
    return [...devices, ...[...this.entries.values()].filter((entry) => entry.root === canonical && !devices.some((session) => sameRemoteTarget(session.target, targetOf(entry.invitation)))).map((entry) => this.summary(entry))]
  }

  async importInvitation(root: string, value: unknown, hostAlias?: string): Promise<RemoteVSCodeConnection> {
    const invitation = remoteInvitationFileSchema.parse(value)
    const alias = invitation.devTunnel ? undefined : sshHostAliasSchema.parse(hostAlias)
    const canonical = await this.root(root)
    if (Date.parse(invitation.grant.expiresAt) <= Date.now()) throw new Error('This remote invitation has expired. Ask its owner for a new one.')
    if (!sameParticipant(invitation.grant.participant, await this.identity())) throw new Error('This invitation belongs to a different client identity. Export this desktop identity and ask the owner to enroll it.')
    if (invitation.devTunnel && (!this.options.devTunnel || invitation.devTunnel.clientPublicKey !== await this.options.devTunnelPublicKey?.())) throw new Error('This invitation does not match this desktop SSH identity. Export its identity and pair again.')
    return this.update(async () => {
      const prior = [...this.entries.values()].find((entry) => entry.root === canonical && sameRemoteTarget(targetOf(entry.invitation), targetOf(invitation)))
      if (!prior && this.entries.size >= 32) throw new Error('The remote connection limit is 32. Forget an unused invitation first.')
      const entry = enrollmentSchema.parse({ id: prior?.id ?? randomUUID(), root: canonical, hostAlias: alias, invitation })
      const values = [...this.entries.values()].filter((item) => item.id !== entry.id).concat(entry)
      await writeJsonAtomic(this.file, values)
      this.drop(entry.id)
      this.entries.set(entry.id, entry)
      await rm(this.cacheFile(entry.id), { force: true })
      return this.summary(entry)
    })
  }

  private async enrollment(root: string, id: string): Promise<Enrollment> {
    await this.load()
    z.uuid().parse(id)
    const entry = this.entries.get(id)
    if (!entry || entry.root !== await this.root(root)) throw new Error('This remote connection does not belong to the selected task workspace.')
    return entry
  }

  private async forTarget(root: string, value: VSCodeChatTarget): Promise<Enrollment> {
    const target = vscodeTargetSchema.parse(value)
    if (!target.remoteMachineName) throw new Error('A remote execution machine is required.')
    const entry = (await this.list(root)).find((item) => sameRemoteTarget(item.target, target))
    if (!entry) throw new Error('Import a private invitation for this remote original conversation first. No local session was substituted.')
    return this.enrollment(root, entry.id)
  }

  private async authorized(entry: Enrollment): Promise<void> {
    if (this.entries.get(entry.id) !== entry) throw new Error('The remote invitation changed. Reopen the connection before continuing.')
    if (Date.parse(entry.invitation.grant.expiresAt) <= Date.now()) throw new Error('Remote access has expired. Ask the execution owner for a fresh invitation.')
    if (!sameParticipant(entry.invitation.grant.participant, await this.identity())) throw new Error('The enrolled remote identity no longer matches this desktop.')
  }

  private drop(id: string, recover = false): void {
    if (!recover) this.reconnect.delete(id)
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1)
    this.attempts.get(id)?.abort(new Error('The connection attempt was cancelled.'))
    const active = this.active.get(id)
    this.active.delete(id)
    active?.abort.abort(new Error('The remote connection was closed. No message was replayed.'))
    active?.tunnel.close()
  }

  private async request(entry: Enrollment, active: ActiveConnection, route: '/remote/identity' | '/remote/read' | '/remote/send' | '/remote/open', value?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        hostname: '127.0.0.1', port: active.tunnel.port, path: route, method: value === undefined ? 'GET' : 'POST',
        headers: { Host: `127.0.0.1:${entry.invitation.port}`, Authorization: `Bearer ${entry.invitation.token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.any([active.abort.signal, AbortSignal.timeout(15000)]),
      }, (response) => {
        response.once('error', reject)
        if (response.statusCode !== 200) {
          response.destroy()
          reject(new Error(response.statusCode === 401 || response.statusCode === 403 ? 'Remote access was revoked, expired, or rejected. Re-enroll with the execution owner.' : response.statusCode === 404 ? 'Update the VS Code Bridge on the execution machine to support this operation.' : 'The remote VS Code bridge rejected the request. Inspect its original conversation before retrying.'))
          return
        }
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength
          if (bytes > maximumResponseBytes) { response.destroy(new Error('The remote bridge response exceeds its size limit.')); return }
          chunks.push(chunk)
        })
        response.once('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) } catch { reject(new Error('The remote bridge returned invalid JSON.')) }
        })
      })
      request.once('error', reject)
      request.end(value === undefined ? undefined : JSON.stringify(value))
    })
  }

  async connect(root: string, id: string): Promise<void> {
    const device = (await this.options.devices?.sessions(root))?.find((session) => session.id === id)
    if (device) return this.options.devices!.connect(root, device.deviceId!)
    const entry = await this.enrollment(root, id)
    await this.authorized(entry)
    if (entry.invitation.devTunnel) this.reconnect.set(id, { root, after: Date.now() + 10000 })
    if (this.active.has(id)) return
    if (this.connecting.has(id)) return this.connecting.get(id)
    const revision = this.revisions.get(id) ?? 0
    const abort = new AbortController()
    this.attempts.set(id, abort)
    const operation = (async () => {
      const route = entry.invitation.devTunnel
      if (route && !this.options.devTunnel) throw new Error('Managed Dev Tunnel transport is unavailable. No SSH alias or local substitute was used.')
      const tunnel = route ? await this.options.devTunnel!(route, entry.invitation.grant.id, entry.invitation.port, abort.signal)
        : await (this.options.tunnel ? this.options.tunnel(entry.hostAlias!, entry.invitation.port, abort.signal) : openSshTunnel(entry.hostAlias!, entry.invitation.port, undefined, abort.signal))
      const active = { tunnel, abort }
      try {
        const value = remoteHandshakeSchema.parse(await this.request(entry, active, '/remote/identity'))
        const expected = entry.invitation
        if (value.instanceId !== expected.instanceId || !sameRemoteTarget(value.identity, expected.identity) || JSON.stringify(value.grant) !== JSON.stringify(expected.grant) || JSON.stringify(value.execution) !== JSON.stringify(expected.execution) || value.vscodeVersion !== expected.vscodeVersion) throw new Error('Remote VS Code identity changed. Ask the owner for a new invitation; no replacement Agent was started.')
        if (revision !== (this.revisions.get(id) ?? 0)) throw new Error('The connection attempt was cancelled.')
        this.active.set(id, active)
        await this.read(root, targetOf(expected))
        if (!this.active.has(id)) throw new Error('The remote conversation could not be read after connecting.')
      } catch (error) {
        active.abort.abort()
        tunnel.close()
        if (this.active.get(id) === active) this.active.delete(id)
        throw error
      }
    })()
    this.connecting.set(id, operation)
    try { await operation } finally {
      if (this.connecting.get(id) === operation) this.connecting.delete(id)
      if (this.attempts.get(id) === abort) this.attempts.delete(id)
    }
  }

  private cacheFile(id: string): string { return join(this.directory, 'remote-vscode-cache', `${id}.json`) }

  private validateHistory(entry: Enrollment, value: unknown): VSCodeChatView {
    const payload = remoteHistorySchema.parse(value)
    const expected = entry.invitation
    if (payload.instanceId !== expected.instanceId || payload.grantId !== expected.grant.id || !sameRemoteTarget(payload.identity, expected.identity)
      || payload.view.session.id !== expected.identity.nativeSessionId || !sameParticipant(payload.view.participant, expected.grant.participant)
      || JSON.stringify(payload.view.execution) !== JSON.stringify(expected.execution) || payload.view.deliveries.some((record) => record.nativeSessionId !== expected.identity.nativeSessionId)) throw new Error('The remote history belongs to a different conversation or execution owner.')
    return payload.view
  }

  private async cached(entry: Enrollment, error: string): Promise<VSCodeChatView> {
    try {
      const view = this.validateHistory(entry, await readJsonBounded(this.cacheFile(entry.id), maximumResponseBytes))
      return { ...view, canSend: false, responding: false, connectionState: 'offline', bridgeError: error,
        deliveries: view.deliveries?.map((record) => record.state === 'pending' ? { ...record, state: 'uncertain', error: 'Disconnected before confirmation. This message is not replayed automatically.' } : record) }
    } catch {
      return { session: { id: entry.invitation.identity.nativeSessionId, source: 'vscode', title: entry.invitation.title, updatedAt: new Date().toISOString() }, messages: [], deliveries: [], participant: entry.invitation.grant.participant,
        execution: entry.invitation.execution, connectionState: 'offline', canSend: false, responding: false, bridgeError: `${error} No verified cached history is available.` }
    }
  }

  async read(root: string, target: VSCodeChatTarget): Promise<VSCodeChatView> {
    if (await this.options.devices?.find(root, target)) return this.options.devices!.read(root, target)
    const entry = await this.forTarget(root, target)
    const active = this.active.get(entry.id)
    if (!active) {
      const reconnect = this.reconnect.get(entry.id)
      if (reconnect && Date.now() >= reconnect.after && !this.connecting.has(entry.id)) {
        reconnect.after = Date.now() + 10000
        void this.connect(reconnect.root, entry.id).catch(() => undefined)
      }
      return this.cached(entry, 'Remote VS Code is disconnected. Connect to the original execution machine; cached history is read-only.')
    }
    const existing = this.reads.get(entry.id)
    if (existing) return structuredClone(await existing)
    const operation = (async () => {
      try {
        await this.authorized(entry)
        const payload = await this.request(entry, active, '/remote/read', entry.invitation.identity)
        const view = this.validateHistory(entry, payload)
        await this.update(async () => {
          if (this.active.get(entry.id) !== active || this.entries.get(entry.id) !== entry) throw new Error('The remote connection changed while reading.')
          await writeJsonAtomic(this.cacheFile(entry.id), payload)
        })
        return this.active.get(entry.id) === active ? view : { ...view, canSend: false, connectionState: 'offline' as const, bridgeError: 'The remote connection was closed.' }
      } catch (error) {
        if (this.active.get(entry.id) === active) this.drop(entry.id, !(error instanceof Error && /revoked|expired|identity|different/.test(error.message)))
        return this.cached(entry, error instanceof Error ? error.message : 'Remote VS Code could not be reached. No message was replayed.')
      }
    })()
    this.reads.set(entry.id, operation)
    try { return structuredClone(await operation) } finally { if (this.reads.get(entry.id) === operation) this.reads.delete(entry.id) }
  }

  async send(root: string, target: VSCodeChatTarget, commandId: string, text: string): Promise<VSCodeChatDelivery> {
    if (await this.options.devices?.find(root, target)) return this.options.devices!.send(root, target, commandId, text)
    const entry = await this.forTarget(root, target)
    await this.authorized(entry)
    if (!entry.invitation.grant.canSend) throw new Error('This invitation allows reading only.')
    const active = this.active.get(entry.id)
    if (!active) throw new Error('Remote VS Code is disconnected. No message was queued or sent.')
    const command = z.object({ id: z.uuid(), text: z.string().trim().min(1).max(4000) }).strict().parse({ id: commandId, text })
    try {
      const receipt = deliverySchema.parse(await this.request(entry, active, '/remote/send', { ...entry.invitation.identity, ...command }))
      if (receipt.id !== command.id || receipt.text !== command.text || receipt.nativeSessionId !== entry.invitation.identity.nativeSessionId
        || !sameParticipant(remoteClientSchema.parse(receipt.participant), entry.invitation.grant.participant) || JSON.stringify(receipt.execution) !== JSON.stringify(entry.invitation.execution)) throw new Error('Remote delivery identity did not match. Inspect the original conversation before retrying.')
      return receipt
    } catch (error) {
      if (this.active.get(entry.id) === active) this.drop(entry.id)
      throw error
    }
  }

  async connectTarget(root: string, target: VSCodeChatTarget): Promise<void> {
    const device = await this.options.devices?.find(root, target)
    if (device) return this.options.devices!.connect(root, device.deviceId!)
    await this.connect(root, (await this.forTarget(root, target)).id)
  }
  async open(root: string, target: VSCodeChatTarget): Promise<void> {
    if (await this.options.devices?.find(root, target)) return this.options.devices!.open(root, target)
    const entry = await this.forTarget(root, target)
    await this.authorized(entry)
    const active = this.active.get(entry.id)
    if (!active || !entry.invitation.grant.canSend) throw new Error('Opening on the owner requires a connected session with read and send access.')
    const opened = z.object({ opened: z.literal(true), nativeSessionId: z.string(), workspaceStorageId: z.string() }).strict().parse(await this.request(entry, active, '/remote/open', entry.invitation.identity))
    if (!sameRemoteTarget(opened, entry.invitation.identity)) throw new Error('The owner returned a different opened session. No message was sent.')
  }
  async disconnect(root: string, id: string): Promise<void> {
    const device = (await this.options.devices?.sessions(root))?.find((session) => session.id === id)
    if (device) return this.options.devices!.disconnect(root, device.deviceId!)
    await this.enrollment(root, id); this.drop(id)
  }
  async forget(root: string, id: string): Promise<void> {
    await this.enrollment(root, id)
    await this.update(async () => {
      await writeJsonAtomic(this.file, [...this.entries.values()].filter((entry) => entry.id !== id))
      this.drop(id)
      this.entries.delete(id)
      await rm(this.cacheFile(id), { force: true })
    })
  }
  close(): void { this.options.devices?.close(); for (const id of this.entries.keys()) this.drop(id) }
}