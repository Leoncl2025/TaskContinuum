import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { readJsonBounded, writeJsonAtomic } from './shared/storage'
import { deviceInvitationSchema, deviceIdentitySchema } from './vscodeDeviceProtocol'
import type { DeviceInvitation } from './vscodeDeviceProtocol'
import { deviceRequest, DeviceRequestError } from './vscodeDeviceHttp'
import type { DeviceProtector } from './vscodeDeviceHost'
import type { AgentHostSession, AgentHostTarget } from '../shared/agentHost'
import { agentHostCatalogSchema, agentHostTargetSchema } from './agentHostProtocol'
import { connectAgentHostWebSocket } from './agentHostTransport'
import { AGENT_HOST_TRACE_HEADER, logAgentHostDiagnostic } from './agentHostDiagnostics'
import type { AgentHostDiagnosticDetails } from './agentHostDiagnostics'
import type { AgentHostCreateRequest, AgentHostCreation, AgentHostWorker } from '../shared/agentHostCreation'
import { agentHostCreateCommandSchema, agentHostCreateRequestSchema, agentHostCreationResultSchema, agentHostWorkerCatalogSchema, creationTaskIdSchema, creationRevisionSchema } from './agentHostCreationProtocol'
import { fileDeviceRequest } from './fileTransferHttp'
import type { FileRoute } from './fileTransferHttp'
import { FileTransferError, transferFailure } from '../shared/fileTransfer'
import type { TransferDevice } from '../shared/fileTransfer'

const peerSchema = z.object({ id: z.uuid(), root: z.string().min(1), invitation: deviceInvitationSchema,
  enabled: z.boolean(),
  // Preserve old catalog metadata without loading its sessions or cached transcripts.
  known: z.array(z.unknown()).max(128).optional(),
}).strict()
type Peer = z.infer<typeof peerSchema>
type Connection = { port: number; close(): void }
type Active = { tunnel: Connection; abort: AbortController; refreshed: number }

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => { signal.removeEventListener('abort', cancelled); reject(signal.reason) }
    if (signal.aborted) cancelled()
    else signal.addEventListener('abort', cancelled, { once: true })
    void work.then((value) => { signal.removeEventListener('abort', cancelled); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', cancelled); reject(error) })
  })
}

export class VSCodeDeviceClient {
  private peers: Peer[] = []
  private loading?: Promise<void>
  private writing: Promise<unknown> = Promise.resolve()
  private readonly active = new Map<string, Active>()
  private readonly connecting = new Map<string, Promise<void>>()
  private readonly connectingPeers = new Map<string, Peer>()
  private readonly attempts = new Map<string, AbortController>()
  private readonly peerChanges = new Map<string, AbortController>()
  private readonly errors = new Map<string, string>()
  private readonly retry = new Map<string, { at: number; count: number }>()
  private readonly lifetime = new AbortController()
  private closed = false

  constructor(private readonly directory: string, private readonly protector: DeviceProtector,
    private readonly transport: (invitation: DeviceInvitation, signal: AbortSignal) => Promise<Connection>,
    private readonly validateRecipient: (invitation: DeviceInvitation) => Promise<void>,
    private readonly recoverOwner?: (root: string, owner: AgentHostTarget['owner'], signal: AbortSignal) => Promise<void>) {}

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
      if (this.closed) throw new Error('Device client is closed.')
      const previous = structuredClone(this.peers)
      try {
        await action()
        z.array(peerSchema).max(32).parse(this.peers)
        await writeJsonAtomic(join(this.directory, 'remote-vscode-devices.json'), { encrypted: this.protector.encrypt(JSON.stringify(this.peers)).toString('base64') })
      } catch (error) {
        for (const peer of this.peers) this.drop(peer.id, 'access-changed', 'configuration')
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
    const parsed = deviceInvitationSchema.safeParse(value)
    if (!parsed.success) throw new Error('Only private device invitations are supported. Legacy per-session invitations cannot be imported; existing data was not changed.')
    const invitation = parsed.data
    if (Date.parse(invitation.expiresAt) <= Date.now()) throw new Error('Device pairing expired.')
    await this.validateRecipient(invitation)
    const canonical = await this.root(root)
    await this.update(() => {
      const prior = this.peers.find((peer) => peer.root === canonical && peer.invitation.ownerId === invitation.ownerId)
      if (this.peers.some((peer) => peer.root === canonical && peer !== prior && peer.invitation.machineName.toLowerCase() === invitation.machineName.toLowerCase())) throw new Error('Another paired identity uses this machine name. Resolve it before pairing.')
      if (prior && prior.invitation.devTunnel.hostPublicKey !== invitation.devTunnel.hostPublicKey) throw new Error('Device host key changed. Forget the previous device before pairing.')
      if (prior?.invitation.ownerClientId && prior.invitation.ownerClientId !== invitation.ownerClientId) throw new Error('Device owner identity changed. Forget the previous device before pairing.')
      if (prior) {
        logAgentHostDiagnostic('device.identity', { ownerId: invitation.ownerClientId, status: 'begin', step: 'configuration', reason: 'reimport' })
        this.drop(prior.id, 'reimport', 'configuration')
        this.retry.delete(prior.id)
      }
      if (!prior && this.peers.length >= 32) throw new Error('Device limit reached.')
      this.peers = this.peers.filter((peer) => peer !== prior).concat({ ...prior, id: prior?.id ?? randomUUID(), root: canonical, invitation, enabled: autoConnect })
    })
  }
  async list(root: string) {
    await this.load()
    const canonical = await this.root(root)
    return this.peers.filter((peer) => peer.root === canonical).map((peer) => {
      if (peer.enabled && !this.closed && (!this.active.has(peer.id) || Date.now() - this.active.get(peer.id)!.refreshed > 10000)) void this.ensure(peer).catch(() => undefined)
      return { id: peer.id, ownerClientId: peer.invitation.ownerClientId, machineName: peer.invitation.machineName, state: this.active.get(peer.id)?.refreshed ? 'connected' as const : this.connecting.has(peer.id) ? 'connecting' as const : 'offline' as const,
        enabled: peer.enabled, expiresAt: peer.invitation.expiresAt, error: this.errors.get(peer.id) }
    })
  }

  async connectOwner(root: string, ownerClientId: string): Promise<void> {
    await this.load()
    const canonical = await this.root(root)
    const peer = this.peers.find((item) => item.root === canonical && item.invitation.ownerClientId === z.uuid().parse(ownerClientId))
    if (!peer) throw new Error('The authenticated owner has no imported device invitation.')
    await this.connect(root, peer.id)
  }

  async disconnectOwner(root: string, ownerClientId: string): Promise<void> {
    await this.load()
    if (!isAbsolute(root)) throw new Error('Disconnect requires an absolute enrolled workspace root.')
    const canonical = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)
    z.uuid().parse(ownerClientId)
    const peers = this.peers.filter((item) => item.root === canonical && item.invitation.ownerClientId === ownerClientId)
    for (const peer of peers) { peer.enabled = false; this.drop(peer.id, 'owner-disabled', 'reconcile') }
    if (peers.length) await this.update(() => {})
  }

  async publicIdentities(root: string) {
    await this.load()
    const canonical = await this.root(root)
    return this.peers.filter((item) => item.root === canonical && item.invitation.ownerClientId).map((item) => ({
      deviceId: item.invitation.ownerClientId!,
      machineName: item.invitation.machineName,
      hostPublicKey: item.invitation.devTunnel.hostPublicKey,
    }))
  }

  async ownerConnected(root: string, ownerClientId: string): Promise<boolean> {
    await this.load()
    const canonical = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)
    const peer = this.peers.find((item) => item.root === canonical && item.invitation.ownerClientId === ownerClientId)
    return !this.closed && !!peer && peer.enabled && Date.parse(peer.invitation.expiresAt) > Date.now()
      && !!this.active.get(peer.id)?.refreshed && !this.active.get(peer.id)!.abort.signal.aborted
  }
  private drop(id: string, reason: AgentHostDiagnosticDetails['reason'], step: AgentHostDiagnosticDetails['step'] = 'tunnel'): void {
    const peer = this.peers.find((item) => item.id === id)
    logAgentHostDiagnostic('device.disconnect', { ownerId: peer?.invitation.ownerClientId, status: 'closed', step, reason })
    const changed = new Error('The selected device connection or identity changed.')
    this.peerChanges.get(id)?.abort(changed)
    this.peerChanges.delete(id)
    this.attempts.get(id)?.abort(changed)
    const active = this.active.get(id)
    this.active.delete(id)
    active?.abort.abort(changed)
    active?.tunnel.close()
  }
  private async ensure(peer: Peer): Promise<void> {
    this.checkPeer(peer)
    const pending = this.connecting.get(peer.id)
    if (pending) {
      if (this.connectingPeers.get(peer.id) === peer) return pending
      await pending.catch(() => undefined)
      return this.ensure(peer)
    }
    if ((this.retry.get(peer.id)?.at ?? 0) > Date.now()) throw new Error(this.errors.get(peer.id) ?? 'Waiting to reconnect to the owner.')
    const abort = new AbortController()
    this.attempts.set(peer.id, abort)
    const timeout = setTimeout(() => abort.abort(new DOMException('The selected device did not reconnect in time.', 'TimeoutError')), 45000)
    timeout.unref?.()
    const operation = (async () => {
      let active = this.active.get(peer.id)
      const started = performance.now()
      let step: 'authorization' | 'tunnel' | 'identity' = 'authorization'
      logAgentHostDiagnostic('device.identity', { ownerId: peer.invitation.ownerClientId, status: 'begin', step })
      try {
        if (Date.parse(peer.invitation.expiresAt) <= Date.now()) throw new Error('Device pairing expired. Pair again with the owner.')
        await abortable(this.validateRecipient(peer.invitation), abort.signal)
        this.checkPeer(peer)
        abort.signal.throwIfAborted()
        if (!active) {
          step = 'tunnel'
          const tunnelStarted = performance.now()
          const opening = this.transport(peer.invitation, abort.signal)
          void opening.then((tunnel) => { if (abort.signal.aborted) tunnel.close() }, () => undefined)
          const tunnel = await abortable(opening, abort.signal)
          logAgentHostDiagnostic('device.transport', { ownerId: peer.invitation.ownerClientId, status: 'ok', step, elapsedMs: performance.now() - tunnelStarted })
          active = { tunnel, abort, refreshed: 0 }
          if (this.closed || !this.peers.includes(peer) || !peer.enabled || abort.signal.aborted) { tunnel.close(); throw new Error('The selected device connection or identity changed.') }
          this.active.set(peer.id, active)
        }
        step = 'identity'
        const signal = AbortSignal.any([abort.signal, active.abort.signal])
        const identity = deviceIdentitySchema.parse(await abortable(deviceRequest(active.tunnel.port, peer.invitation.port, peer.invitation.token, '/device/identity', {}, signal), signal))
        if (identity.ownerId !== peer.invitation.ownerId || identity.deviceId !== peer.invitation.id) throw new Error('Device identity changed.')
        active.refreshed = Date.now()
        this.currentPeer(peer, active)
        this.errors.delete(peer.id)
        this.retry.delete(peer.id)
        logAgentHostDiagnostic('device.identity', { ownerId: peer.invitation.ownerClientId, status: 'ok', step, elapsedMs: performance.now() - started })
      } catch (error) {
        logAgentHostDiagnostic('device.identity', { ownerId: peer.invitation.ownerClientId, status: 'error', step, elapsedMs: performance.now() - started, error })
        if (this.peers.includes(peer) && this.attempts.get(peer.id) === abort) {
          const reason = this.closed ? 'shutdown' : !peer.enabled ? 'owner-disabled'
            : step === 'tunnel' || abort.signal.reason?.name === 'TimeoutError' ? 'owner-offline'
              : abort.signal.aborted ? 'access-changed' : 'identity-failed'
          this.drop(peer.id, reason, step)
          if (!this.closed && peer.enabled) {
            this.errors.set(peer.id, error instanceof Error ? error.message : 'Device connection failed.')
            const count = (this.retry.get(peer.id)?.count ?? 0) + 1
            this.retry.set(peer.id, { count, at: Date.now() + Math.min(30000, 1000 * 2 ** Math.min(count, 5)) })
          }
        }
        throw error
      }
    })()
    this.connecting.set(peer.id, operation)
    this.connectingPeers.set(peer.id, peer)
    try { await operation } finally {
      clearTimeout(timeout)
      if (this.connecting.get(peer.id) === operation) {
        this.connecting.delete(peer.id); this.connectingPeers.delete(peer.id); this.attempts.delete(peer.id)
      }
    }
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
    this.drop(id, 'owner-disabled', 'configuration')
    await this.update(() => { peer.enabled = false })
  }
  async forget(root: string, id: string): Promise<void> {
    const peer = await this.peer(root, id)
    await this.disconnect(root, id)
    await this.update(() => { this.peers = this.peers.filter((item) => item !== peer) })
  }
  async agentHostSessions(root: string): Promise<{ sessions: AgentHostSession[]; warnings: string[] }> {
    await this.load()
    const canonical = await this.root(root)
    const sessions: AgentHostSession[] = []
    const warnings: string[] = []
    for (const peer of this.peers.filter((item) => item.root === canonical && item.enabled)) {
      try {
        if (!peer.invitation.ownerClientId) throw new Error('This device invitation does not identify an Agent Host owner.')
        await this.connecting.get(peer.id)
        if (!this.active.has(peer.id)) await this.ensure(peer)
        const active = this.active.get(peer.id)!
        this.currentPeer(peer, active)
        const catalog = agentHostCatalogSchema.parse(await deviceRequest(active.tunnel.port, peer.invitation.port, peer.invitation.token, '/device/agent-host/sessions', {}, active.abort.signal))
        this.currentPeer(peer, active)
        if (catalog.ownerId !== peer.invitation.ownerId || catalog.deviceId !== peer.invitation.id || catalog.sessions.some((item) => item.owner.clientId !== peer.invitation.ownerClientId || item.owner.machineName.toLowerCase() !== peer.invitation.machineName.toLowerCase())) throw new Error('Device identity changed.')
        sessions.push(...catalog.sessions)
      } catch { warnings.push(`Agent Host sessions on ${peer.invitation.machineName} are unavailable or not shared.`) }
    }

    return { sessions, warnings }
  }

  async fileDevices(root: string): Promise<TransferDevice[]> {
    const peers = await this.list(root)
    return Promise.all(peers.map(async (peer) => {
      let fileTransfer: TransferDevice['fileTransfer'] = 'unknown'
      let error: string | undefined
      if (peer.enabled) {
        try { await this.fileRequest(root, peer.id, 'capabilities', {}, new AbortController().signal); fileTransfer = 'available' }
        catch (failure) {
          if (failure instanceof FileTransferError && failure.code === 'UNSUPPORTED') fileTransfer = 'unsupported'
          error = transferFailure(failure).message
        }
      }
      return { deviceId: peer.id, machineName: peer.machineName, state: fileTransfer === 'available' ? 'connected' : peer.state, enabled: peer.enabled, fileTransfer, ...(error ? { error } : {}) }
    }))
  }

  async fileRequest(root: string, peerId: string, route: FileRoute, body: unknown, signal: AbortSignal): Promise<unknown | Buffer> {
    signal.throwIfAborted()
    const peer = await this.peer(root, z.uuid().parse(peerId))
    if (this.closed || !peer.enabled || !peer.invitation.ownerClientId || Date.parse(peer.invitation.expiresAt) <= Date.now()) {
      throw new FileTransferError('ACCESS_DENIED', 'The selected trusted device is disabled, expired or unavailable.')
    }
    await this.validateRecipient(peer.invitation)
    await this.connecting.get(peer.id)
    if (!this.active.has(peer.id)) await this.ensure(peer)
    const active = this.active.get(peer.id)
    this.currentPeer(peer, active)
    const result = await fileDeviceRequest(active.tunnel.port, peer.invitation.port, peer.invitation.token, route, body, AbortSignal.any([signal, active.abort.signal]))
    this.currentPeer(peer, active)
    if (route === 'capabilities') {
      const identity = z.object({ protocolVersion: z.literal(1), ownerId: z.uuid(), pairId: z.uuid() }).strict().parse(result)
      if (identity.ownerId !== peer.invitation.ownerId || identity.pairId !== peer.invitation.id) throw new FileTransferError('ACCESS_DENIED', 'The file source returned a different authenticated device identity.')
    }
    return result
  }

  async fileDeviceKey(root: string, peerId: string): Promise<string> {
    const peer = await this.peer(root, z.uuid().parse(peerId))
    if (this.closed || !peer.enabled || !peer.invitation.ownerClientId || Date.parse(peer.invitation.expiresAt) <= Date.now()) throw new FileTransferError('ACCESS_DENIED', 'The trusted file device is not available.')
    return peer.invitation.ownerClientId
  }

  private ownerPeer(root: string, owner: AgentHostTarget['owner']): Peer | undefined {
    if (this.closed) throw new Error('Device client is closed.')
    const peers = this.peers.filter((item) => item.root === root && item.invitation.ownerClientId === owner.clientId)
    if (peers.length > 1) throw new Error('The Agent Host owner has ambiguous device invitations.')
    const peer = peers[0]
    if (!peer) return undefined
    if (!peer.enabled || Date.parse(peer.invitation.expiresAt) <= Date.now()) throw new Error('The owner connection is disabled or expired.')
    if (peer.invitation.machineName.toLowerCase() !== owner.machineName.toLowerCase()) throw new Error('The Agent Host owner identity does not match the paired device.')
    return peer
  }

  private peerChangeSignal(peer: Peer): AbortSignal {
    let changes = this.peerChanges.get(peer.id)
    if (!changes) { changes = new AbortController(); this.peerChanges.set(peer.id, changes) }
    return changes.signal
  }

  /** Reuse an enabled private invitation without enabling, replacing, or discovering any other device. */
  async reconnectOwner(root: string, value: AgentHostTarget['owner'], signal: AbortSignal): Promise<boolean> {
    const owner = agentHostTargetSchema.shape.owner.parse(value)
    signal.throwIfAborted()
    await abortable(this.load(), signal)
    const canonical = await abortable(this.root(root), signal)
    const peer = this.ownerPeer(canonical, owner)
    if (!peer) return false
    const current = AbortSignal.any([signal, this.lifetime.signal, this.peerChangeSignal(peer)])
    await abortable(this.validateRecipient(peer.invitation), current)
    this.checkPeer(peer)
    this.retry.delete(peer.id)
    await abortable(this.ensure(peer), current)
    current.throwIfAborted()
    this.currentPeer(peer, this.active.get(peer.id))
    return true
  }

  async agentHostTransport(root: string, value: AgentHostTarget, signal: AbortSignal, traceId?: string) {
    const target = agentHostTargetSchema.parse(value)
    const started = performance.now()
    let step: 'load' | 'workspace-recovery' | 'tunnel' | 'websocket' = 'load'
    const deadline = new AbortController()
    const timeout = setTimeout(() => deadline.abort(new DOMException('The selected Agent Host owner did not reconnect in time. Retry when that device is available.', 'TimeoutError')), 45000)
    timeout.unref?.()
    let readiness = AbortSignal.any([signal, this.lifetime.signal, deadline.signal])
    logAgentHostDiagnostic('device.transport', { target, traceId, status: 'begin', step })
    try {
      readiness.throwIfAborted()
      await abortable(this.load(), readiness)
      const canonical = await abortable(this.root(root), readiness)
      const selected = this.ownerPeer(canonical, target.owner)
      if (selected) readiness = AbortSignal.any([readiness, this.peerChangeSignal(selected)])
      if (this.recoverOwner && !await abortable(this.ownerConnected(canonical, target.owner.clientId), readiness)) {
        step = 'workspace-recovery'
        const recoveryStarted = performance.now()
        await abortable(this.recoverOwner(canonical, target.owner, readiness), readiness)
        readiness.throwIfAborted()
        logAgentHostDiagnostic('device.transport', { target, traceId, status: 'ok', step, elapsedMs: performance.now() - recoveryStarted })
      }
      const peer = this.ownerPeer(canonical, target.owner)
      if (!peer) throw new Error('Enable automatic workspace links on both devices and wait for the exact Agent Host owner to connect. Git alone does not grant access.')
      if (selected && selected !== peer) throw new Error('The selected device connection or identity changed.')
      readiness = AbortSignal.any([readiness, this.peerChangeSignal(peer)])
      step = 'tunnel'
      await abortable(this.validateRecipient(peer.invitation), readiness)
      if (this.connecting.has(peer.id)) await abortable(this.connecting.get(peer.id)!, readiness)
      if (!this.active.get(peer.id)?.refreshed || Date.now() - this.active.get(peer.id)!.refreshed > 10000) await abortable(this.ensure(peer), readiness)
      readiness.throwIfAborted()
      const active = this.active.get(peer.id)
      this.currentPeer(peer, active)
      if (await abortable(this.root(root), readiness) !== canonical) throw new Error('The task workspace changed while reconnecting.')
      readiness.throwIfAborted()
      this.currentPeer(peer, active)
      clearTimeout(timeout)
      const combined = AbortSignal.any([signal, active.abort.signal])
      const encoded = Buffer.from(JSON.stringify(target)).toString('base64url')
      step = 'websocket'
      const websocketStarted = performance.now()
      const transport = await connectAgentHostWebSocket(`ws://127.0.0.1:${active.tunnel.port}/device/agent-host?target=${encoded}`, { headers: {
        Host: `127.0.0.1:${peer.invitation.port}`, Authorization: `Bearer ${peer.invitation.token}`,
        ...(traceId ? { [AGENT_HOST_TRACE_HEADER]: traceId } : {}),
      } }, combined)
      try {
        combined.throwIfAborted()
        this.currentPeer(peer, active)
        if (await this.root(root) !== canonical) throw new Error('The task workspace changed while reconnecting.')
        combined.throwIfAborted()
        this.currentPeer(peer, active)
      } catch (error) { await transport.close(); throw error }
      logAgentHostDiagnostic('device.transport', { target, traceId, status: 'ok', step, elapsedMs: performance.now() - websocketStarted })
      return transport
    } catch (error) {
      logAgentHostDiagnostic('device.transport', { target, traceId, status: 'error', step, elapsedMs: performance.now() - started, error })
      throw error
    } finally { clearTimeout(timeout) }
  }

  private async creationPeer(root: string, workerId: string): Promise<Peer> {
    const peer = await this.peer(root, z.uuid().parse(workerId))
    if (!peer.invitation.ownerClientId) throw new Error('This worker invitation does not identify an Agent Host owner. Update the worker and reconnect through automatic workspace links.')
    if (this.closed || !peer.enabled || Date.parse(peer.invitation.expiresAt) <= Date.now()) throw new Error('The worker connection is disabled or expired. Connect it in Devices.')
    await this.validateRecipient(peer.invitation)
    await this.connecting.get(peer.id)
    if (!this.active.has(peer.id)) await this.ensure(peer)
    this.currentPeer(peer, this.active.get(peer.id))
    return peer
  }

  private checkPeer(peer: Peer): void {
    if (this.closed || !this.peers.includes(peer) || !peer.enabled || Date.parse(peer.invitation.expiresAt) <= Date.now()) throw new Error('The selected device connection or identity changed.')
  }

  private currentPeer(peer: Peer, active: Active | undefined): asserts active is Active {
    this.checkPeer(peer)
    if (!active?.refreshed || active.abort.signal.aborted || this.active.get(peer.id) !== active) throw new Error('The selected device connection or identity changed.')
  }

  async agentHostWorker(root: string, workerId: string, taskId: string): Promise<AgentHostWorker> {
    creationTaskIdSchema.parse(taskId)
    const peer = await this.peer(root, z.uuid().parse(workerId))
    const clientId = peer.invitation.ownerClientId
    if (!clientId) throw new Error('This device does not advertise an Agent Host owner identity.')
    const worker: AgentHostWorker = { id: peer.id, owner: { clientId, machineName: peer.invitation.machineName }, state: 'offline', hosts: [], workspaces: [] }
    try {
      await this.creationPeer(root, workerId)
      const active = this.active.get(peer.id)
      this.currentPeer(peer, active)
      const catalog = agentHostWorkerCatalogSchema.parse(await deviceRequest(active.tunnel.port, peer.invitation.port, peer.invitation.token, '/device/agent-host/workers', { taskId }, active.abort.signal))
      this.currentPeer(peer, active)
      if (catalog.ownerId !== peer.invitation.ownerId || catalog.deviceId !== peer.invitation.id
        || catalog.owner.clientId !== clientId || catalog.owner.machineName.toLowerCase() !== peer.invitation.machineName.toLowerCase()) throw new Error('The worker catalog returned a different authenticated owner.')
      return { ...worker, state: 'connected', hosts: catalog.hosts, workspaces: catalog.workspaces }
    } catch (error) {
      const state = error instanceof DeviceRequestError && error.creationCode ? 'blocked' : error instanceof DeviceRequestError && error.status === 404 ? 'unsupported' : 'offline'
      return { ...worker, state,
        error: (error instanceof Error ? error.message : 'The selected worker could not be queried.').slice(0, 2000) }
    }
  }

  async agentHostWorkers(root: string, taskId: string): Promise<AgentHostWorker[]> {
    creationTaskIdSchema.parse(taskId)
    await this.load()
    const canonical = await this.root(root)
    const ids = this.peers.filter((peer) => peer.root === canonical && peer.invitation.ownerClientId).map((peer) => peer.id)
    const workers: AgentHostWorker[] = []
    for (const id of ids) workers.push(await this.agentHostWorker(root, id, taskId))
    return workers
  }

  private async creationRequest(root: string, value: AgentHostCreateRequest, path: '/device/agent-host/create' | '/device/agent-host/creation-status' | '/device/agent-host/creation-bind' | '/device/agent-host/creation-abandon', body: unknown, authorize: () => Promise<void>): Promise<AgentHostCreation> {
    const request = agentHostCreateRequestSchema.parse(value)
    const peer = await this.creationPeer(root, request.workerId)
    const active = this.active.get(peer.id)
    this.currentPeer(peer, active)
    await authorize()
    this.currentPeer(peer, active)
    try {
      const result = agentHostCreationResultSchema.parse(await deviceRequest(active.tunnel.port, peer.invitation.port, peer.invitation.token, path, body, active.abort.signal))
      this.currentPeer(peer, active)
      if (result.operationId !== request.operationId || result.workspaceId !== request.workspaceId || result.taskId !== request.taskId || result.hostId !== request.hostId
        || result.session && (result.session.provider !== 'copilotcli' || result.session.owner.clientId !== peer.invitation.ownerClientId
          || result.session.owner.machineName.toLowerCase() !== peer.invitation.machineName.toLowerCase())) throw new Error('The worker returned a different creation operation or session identity. No replacement was selected.')
      return { ...result, workerId: peer.id }
    } catch (error) {
      if (this.active.get(peer.id) === active && !(error instanceof DeviceRequestError)) {
        this.drop(peer.id, 'owner-offline', 'response')
        this.retry.set(peer.id, { count: 1, at: Date.now() + 2000 })
      }
      throw error
    }
  }

  agentHostCreate(root: string, value: AgentHostCreateRequest, authorize: () => Promise<void>): Promise<AgentHostCreation> {
    const request = agentHostCreateRequestSchema.parse(value)
    const { operationId, taskId, workspaceId, hostId, expectedRevision } = request
    return this.creationRequest(root, request, '/device/agent-host/create', agentHostCreateCommandSchema.parse({ operationId, taskId, workspaceId, hostId, expectedRevision }), authorize)
  }

  agentHostCreationStatus(root: string, request: AgentHostCreateRequest, authorize: () => Promise<void>): Promise<AgentHostCreation> {
    return this.creationRequest(root, request, '/device/agent-host/creation-status', { operationId: request.operationId, workspaceId: request.workspaceId }, authorize)
  }

  agentHostBindCreation(root: string, request: AgentHostCreateRequest, revision: string | null, authorize: () => Promise<void>): Promise<AgentHostCreation> {
    return this.creationRequest(root, request, '/device/agent-host/creation-bind', { operationId: request.operationId, workspaceId: request.workspaceId, expectedRevision: creationRevisionSchema.parse(revision) }, authorize)
  }

  agentHostAbandonCreation(root: string, value: AgentHostCreateRequest, authorize: () => Promise<void>): Promise<AgentHostCreation> {
    const { workerId, ...command } = agentHostCreateRequestSchema.parse(value)
    return this.creationRequest(root, { ...command, workerId }, '/device/agent-host/creation-abandon', agentHostCreateCommandSchema.parse(command), authorize)
  }

  close(): void { this.closed = true; this.lifetime.abort(new Error('Device client is closed.')); for (const peer of this.peers) this.drop(peer.id, 'shutdown') }
}