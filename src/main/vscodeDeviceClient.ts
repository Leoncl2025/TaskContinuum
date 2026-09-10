import { randomUUID } from 'node:crypto'
import { realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { RemoteVSCodeConnection, VSCodeChatTarget } from '../shared/remoteVSCode'
import type { VSCodeChatView } from '../shared/vscodeChat'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import { deviceInvitationSchema, deviceCatalogSchema } from './vscodeDeviceProtocol'
import type { DeviceInvitation } from './vscodeDeviceProtocol'
import { deviceRequest, DeviceRequestError } from './vscodeDeviceHttp'
import { remoteHistorySchema, remoteInvitationSchema, sameRemoteTarget } from './vscodeRemoteProtocol'
import { deliverySchema } from './vscodeChatDelivery'
import type { DeviceProtector } from './vscodeDeviceHost'
import { readRepositorySessionLinks } from './repositorySessionLinks'
import type { SessionOwner } from '../shared/sessionBindings'

const knownSchema = z.object({ id: z.uuid(), invitation: remoteInvitationSchema }).strict()
const peerSchema = z.object({ id: z.uuid(), root: z.string().min(1), invitation: deviceInvitationSchema,
  enabled: z.boolean(), known: z.array(knownSchema).max(128),
}).strict()
type Peer = z.infer<typeof peerSchema>
type Connection = { port: number; close(): void }
type Active = { tunnel: Connection; abort: AbortController; refreshed: number; available: Set<string> }

export class VSCodeDeviceClient {
  private peers: Peer[] = []
  private loading?: Promise<void>
  private writing: Promise<unknown> = Promise.resolve()
  private readonly active = new Map<string, Active>()
  private readonly connecting = new Map<string, Promise<void>>()
  private readonly attempts = new Map<string, AbortController>()
  private readonly errors = new Map<string, string>()
  private readonly retry = new Map<string, { at: number; count: number }>()
  private closed = false

  constructor(private readonly directory: string, private readonly protector: DeviceProtector,
    private readonly transport: (invitation: DeviceInvitation, signal: AbortSignal) => Promise<Connection>,
    private readonly validateRecipient: (invitation: DeviceInvitation) => Promise<void>) {}

  private async load(): Promise<void> {
    this.loading ??= (async () => {
      if (!this.protector.available()) throw new Error('Secure storage is required for device connections.')
      try {
        const value = z.object({ encrypted: z.string().max(8 * 1024 * 1024) }).strict().parse(await readJsonBounded(join(this.directory, 'remote-vscode-devices.json'), 9 * 1024 * 1024))
        this.peers = z.array(peerSchema).max(32).parse(JSON.parse(this.protector.decrypt(Buffer.from(value.encrypted, 'base64'))))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Device enrollments are unreadable. They were not replaced.')
      }
    })()
    return this.loading
  }
  private async update(action: () => void | Promise<void>): Promise<void> {
    const pending = this.writing.then(async () => {
      await this.load()
      const previous = structuredClone(this.peers)
      try {
        await action()
        z.array(peerSchema).max(32).parse(this.peers)
        await writeJsonAtomic(join(this.directory, 'remote-vscode-devices.json'), { encrypted: this.protector.encrypt(JSON.stringify(this.peers)).toString('base64') })
      } catch (error) {
        for (const peer of this.peers) this.drop(peer.id)
        this.peers = previous
        throw error
      }
    })
    this.writing = pending.catch(() => undefined)
    await pending
  }
  private async root(value: string): Promise<string> { const root = await realpath(value); return process.platform === 'win32' ? root.toLowerCase() : root }
  private async peer(root: string, id: string): Promise<Peer> {
    await this.load()
    const canonical = await this.root(root)
    const peer = this.peers.find((item) => item.id === id && item.root === canonical)
    if (!peer) throw new Error('Device does not belong to this task workspace.')
    return peer
  }
  async import(root: string, value: unknown, autoConnect = false): Promise<void> {
    const invitation = deviceInvitationSchema.parse(value)
    if (Date.parse(invitation.expiresAt) <= Date.now()) throw new Error('Device pairing expired.')
    await this.validateRecipient(invitation)
    const canonical = await this.root(root)
    await this.update(() => {
      const prior = this.peers.find((peer) => peer.root === canonical && peer.invitation.ownerId === invitation.ownerId)
      if (this.peers.some((peer) => peer.root === canonical && peer !== prior && peer.invitation.machineName.toLowerCase() === invitation.machineName.toLowerCase())) throw new Error('Another paired identity uses this machine name. Resolve it before pairing.')
      if (prior && prior.invitation.devTunnel.hostPublicKey !== invitation.devTunnel.hostPublicKey) throw new Error('Device host key changed. Forget the previous device before pairing.')
      if (prior) this.drop(prior.id)
      if (!prior && this.peers.length >= 32) throw new Error('Device limit reached.')
      this.peers = this.peers.filter((peer) => peer !== prior).concat({ id: prior?.id ?? randomUUID(), root: canonical, invitation, enabled: autoConnect, known: prior?.known ?? [] })
    })
  }
  async list(root: string) {
    await this.load()
    const canonical = await this.root(root)
    return this.peers.filter((peer) => peer.root === canonical).map((peer) => {
      if (peer.enabled && !this.closed && (!this.active.has(peer.id) || Date.now() - this.active.get(peer.id)!.refreshed > 10000)) void this.ensure(peer).catch(() => undefined)
      return { id: peer.id, machineName: peer.invitation.machineName, state: this.active.has(peer.id) ? 'connected' as const : this.connecting.has(peer.id) ? 'connecting' as const : 'offline' as const,
        enabled: peer.enabled, expiresAt: peer.invitation.expiresAt, error: this.errors.get(peer.id) }
    })
  }
  async sessions(root: string): Promise<RemoteVSCodeConnection[]> {
    await this.list(root)
    const canonical = await this.root(root)
    return this.peers.filter((peer) => peer.root === canonical).flatMap((peer) => peer.known.map((known) => {
      const invitation = known.invitation
      const connected = this.active.get(peer.id)?.available.has(known.id) ?? false
      return { id: known.id, deviceId: peer.id, target: { ...invitation.identity, remoteMachineName: invitation.execution.machineName },
        title: invitation.title, hostAlias: '', transport: 'dev-tunnel' as const, tunnelId: peer.invitation.devTunnel.tunnelId,
        participant: invitation.grant.participant, execution: invitation.execution, canSend: connected && invitation.grant.canSend,
        expiresAt: peer.invitation.expiresAt, state: connected ? 'connected' as const : 'offline' as const }
    }))
  }
  async find(root: string, target: VSCodeChatTarget) {
    const owner = await this.repositoryOwner(root, target)
    if (owner) {
      await this.load()
      const canonical = await this.root(root)
      const peer = this.peers.find((item) => item.root === canonical && item.invitation.ownerClientId === owner.clientId)
      if (!peer) throw new Error(`Pair with session owner ${owner.machineName} in Devices. Git links do not grant device access.`)
      if (!peer.known.some((item) => sameRemoteTarget(item.invitation.identity, targetIdentity(target)))) {
        await this.ensure(peer)
      }
      const session = (await this.sessions(root)).find((item) => item.deviceId === peer.id && sameRemoteTarget(item.target, target))
      if (!session) throw new Error('The owner has not made this Git-linked session available. Check its local link, workspace policy, and original VS Code bridge.')
      return session
    }
    return (await this.sessions(root)).find((item) => sameRemoteTarget(item.target, target))
  }
  private async repositoryOwner(root: string, target: VSCodeChatTarget): Promise<SessionOwner | undefined> {
    const { document } = await readRepositorySessionLinks(root)
    const candidates = Object.values(document.bindings).filter((link) => link.provider === 'vscode-copilot' && link.sessionId === target.nativeSessionId && link.workspaceStorageId === target.workspaceStorageId && (!target.remoteMachineName || (link.owner?.machineName ?? link.remoteMachineName)?.toLowerCase() === target.remoteMachineName.toLowerCase()))
    if (candidates.length > 1) throw new Error('Ambiguous repository session owner.')
    return candidates[0]?.owner
  }
  async owner(root: string, target: VSCodeChatTarget): Promise<SessionOwner | undefined> {
    const known = (await this.sessions(root)).find((session) => sameRemoteTarget(session.target, target))
    const peer = this.peers.find((item) => item.id === known?.deviceId)
    return peer?.invitation.ownerClientId ? { clientId: peer.invitation.ownerClientId, machineName: peer.invitation.machineName } : undefined
  }
  private drop(id: string): void {
    this.attempts.get(id)?.abort()
    const active = this.active.get(id)
    this.active.delete(id)
    active?.abort.abort()
    active?.tunnel.close()
  }
  private async ensure(peer: Peer): Promise<void> {
    if (this.closed || !peer.enabled) throw new Error('Device connection is disabled.')
    if (this.connecting.has(peer.id)) return this.connecting.get(peer.id)
    if ((this.retry.get(peer.id)?.at ?? 0) > Date.now()) throw new Error(this.errors.get(peer.id) ?? 'Waiting to reconnect to the owner.')
    const operation = (async () => {
      let active = this.active.get(peer.id)
      try {
        if (Date.parse(peer.invitation.expiresAt) <= Date.now()) throw new Error('Device pairing expired. Pair again with the owner.')
        await this.validateRecipient(peer.invitation)
        if (!active) {
          const abort = new AbortController()
          this.attempts.set(peer.id, abort)
          const tunnel = await this.transport(peer.invitation, abort.signal)
          active = { tunnel, abort, refreshed: 0, available: new Set() }
          if (this.closed || !peer.enabled || abort.signal.aborted) { tunnel.close(); throw new Error('Connection cancelled.') }
          this.active.set(peer.id, active)
        }
        const catalog = deviceCatalogSchema.parse(await deviceRequest(active.tunnel.port, peer.invitation.port, peer.invitation.token, '/device/sessions', {}, active.abort.signal))
        if (catalog.ownerId !== peer.invitation.ownerId || catalog.deviceId !== peer.invitation.id) throw new Error('Device identity changed.')
        const available = new Set<string>()
        await this.update(() => {
          if (this.active.get(peer.id) !== active || !peer.enabled) throw new Error('Device connection changed.')
          for (const invitation of catalog.sessions) {
            if (JSON.stringify(invitation.grant.participant) !== JSON.stringify(peer.invitation.participant) || invitation.execution.machineName.toLowerCase() !== peer.invitation.machineName.toLowerCase()) throw new Error('Session owner or participant changed.')
            let known = peer.known.find((item) => sameRemoteTarget(item.invitation.identity, invitation.identity))
            if (!known) { if (peer.known.length >= 128) throw new Error('Session catalog limit reached.'); known = { id: randomUUID(), invitation }; peer.known.push(known) }
            known.invitation = invitation
            available.add(known.id)
          }
        })
        active.available = available
        active.refreshed = Date.now()
        this.errors.delete(peer.id)
        this.retry.delete(peer.id)
      } catch (error) {
        this.drop(peer.id)
        this.errors.set(peer.id, error instanceof Error ? error.message : 'Device connection failed.')
        const count = (this.retry.get(peer.id)?.count ?? 0) + 1
        this.retry.set(peer.id, { count, at: Date.now() + Math.min(30000, 1000 * 2 ** Math.min(count, 5)) })
        throw error
      }
    })()
    this.connecting.set(peer.id, operation)
    try { await operation } finally { this.connecting.delete(peer.id); this.attempts.delete(peer.id) }
  }
  async connect(root: string, id: string): Promise<void> {
    const peer = await this.peer(root, id)
    await this.update(() => { peer.enabled = true })
    this.retry.delete(id)
    await this.ensure(peer)
  }
  async disconnect(root: string, id: string): Promise<void> {
    const peer = await this.peer(root, id)
    peer.enabled = false
    this.drop(id)
    await this.update(() => { peer.enabled = false })
  }
  async forget(root: string, id: string): Promise<void> {
    const peer = await this.peer(root, id)
    await this.disconnect(root, id)
    await this.update(() => { this.peers = this.peers.filter((item) => item !== peer) })
    for (const known of peer.known) await rm(join(this.directory, 'remote-vscode-device-cache', `${known.id}.json`), { force: true })
  }
  private async selected(root: string, target: VSCodeChatTarget) {
    const session = await this.find(root, target)
    if (!session) throw new Error('No device has shared this original session.')
    const peer = await this.peer(root, session.deviceId!)
    return { peer, known: peer.known.find((item) => item.id === session.id)! }
  }
  async read(root: string, target: VSCodeChatTarget): Promise<VSCodeChatView> {
    const { peer, known } = await this.selected(root, target)
    const file = join(this.directory, 'remote-vscode-device-cache', `${known.id}.json`)
    let requested: Active | undefined
    try {
      if (!this.active.has(peer.id)) await this.ensure(peer)
      const active = this.active.get(peer.id)!
      if (!active.available.has(known.id)) throw new Error('Session is unavailable or no longer shared.')
      requested = active
      const payload = remoteHistorySchema.parse(await deviceRequest(active.tunnel.port, peer.invitation.port, peer.invitation.token, '/device/session/read', { identity: targetIdentity(target) }, active.abort.signal))
      if (!sameRemoteTarget(payload.identity, known.invitation.identity) || payload.view.session.id !== target.nativeSessionId || payload.view.deliveries.some((item) => item.nativeSessionId !== target.nativeSessionId) || JSON.stringify(payload.view.participant) !== JSON.stringify(peer.invitation.participant) || JSON.stringify(payload.view.execution) !== JSON.stringify(known.invitation.execution)) throw new Error('Session history identity changed.')
      await this.update(async () => {
        if (this.active.get(peer.id) !== active || !peer.enabled || !this.peers.includes(peer)) return
        await writeJsonAtomic(file, payload)
      })
      if (this.active.get(peer.id) !== active || !peer.enabled) throw new Error('Device disconnected while reading.')
      return payload.view
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Device is offline.'
      const current = requested ? this.active.get(peer.id) === requested : !this.active.has(peer.id)
      if (current) {
        if (requested && !(error instanceof DeviceRequestError)) {
          this.drop(peer.id)
          this.retry.set(peer.id, { count: 1, at: Date.now() + 2000 })
        }
        this.errors.set(peer.id, message)
      }
      try {
        const cached = remoteHistorySchema.parse(await readJsonBounded(file, 4 * 1024 * 1024))
        if (!sameRemoteTarget(cached.identity, targetIdentity(target)) || cached.view.session.id !== target.nativeSessionId || cached.view.deliveries.some((item) => item.nativeSessionId !== target.nativeSessionId) || JSON.stringify(cached.view.participant) !== JSON.stringify(peer.invitation.participant) || JSON.stringify(cached.view.execution) !== JSON.stringify(known.invitation.execution)) throw new Error('Cached identity changed.')
        return { ...cached.view, connectionState: 'offline', canSend: false, responding: false, bridgeError: message,
          deliveries: cached.view.deliveries.map((delivery) => delivery.state === 'pending' ? { ...delivery, state: 'uncertain', error: 'Disconnected before confirmation. No automatic replay.' } : delivery) }
      } catch {
        return { session: { id: target.nativeSessionId, source: 'vscode', title: known.invitation.title, updatedAt: new Date().toISOString() }, messages: [], deliveries: [], participant: peer.invitation.participant,
          execution: known.invitation.execution, connectionState: 'offline', canSend: false, responding: false, bridgeError: `${message} No verified cached history is available.` }
      }
    }
  }
  async send(root: string, target: VSCodeChatTarget, id: string, text: string) {
    const { peer, known } = await this.selected(root, target)
    const active = this.active.get(peer.id)
    if (!active || !peer.enabled || !active.available.has(known.id) || !known.invitation.grant.canSend) throw new Error('Session is not connected with send access. No message was queued or sent.')
    try {
      const command = z.object({ id: z.uuid(), text: z.string().trim().min(1).max(4000) }).parse({ id, text })
      const result = deliverySchema.parse(await deviceRequest(active.tunnel.port, peer.invitation.port, peer.invitation.token, '/device/session/send', { identity: targetIdentity(target), ...command }, active.abort.signal))
      if (result.id !== command.id || result.text !== command.text || result.nativeSessionId !== target.nativeSessionId || JSON.stringify(result.participant) !== JSON.stringify(peer.invitation.participant) || JSON.stringify(result.execution) !== JSON.stringify(known.invitation.execution)) throw new Error('Delivery identity mismatch. Inspect the original session before retrying.')
      return result
    } catch (error) {
      if (this.active.get(peer.id) === active && !(error instanceof DeviceRequestError)) { this.drop(peer.id); this.retry.set(peer.id, { count: 1, at: Date.now() + 2000 }) }
      throw error
    }
  }
  async open(root: string, target: VSCodeChatTarget): Promise<void> {
    const { peer, known } = await this.selected(root, target)
    if (!this.active.has(peer.id)) await this.ensure(peer)
    const active = this.active.get(peer.id)
    if (!active || !peer.enabled || !active.available.has(known.id) || !known.invitation.grant.canSend) throw new Error('Opening on the owner requires a connected session with read and send access.')
    const result = z.object({ opened: z.literal(true), nativeSessionId: z.string(), workspaceStorageId: z.string() }).strict().parse(await deviceRequest(active.tunnel.port, peer.invitation.port, peer.invitation.token, '/device/session/open', { identity: targetIdentity(target) }, active.abort.signal))
    if (!sameRemoteTarget(result, targetIdentity(target))) throw new Error('The owner returned a different opened session. No message was sent.')
  }
  close(): void { this.closed = true; for (const peer of this.peers) this.drop(peer.id) }
}

function targetIdentity(target: VSCodeChatTarget) { return { nativeSessionId: target.nativeSessionId, workspaceStorageId: target.workspaceStorageId } }