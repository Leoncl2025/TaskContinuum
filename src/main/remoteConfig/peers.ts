import type { GitSyncPeer } from '../../shared/gitSync'

export interface PublicPeer {
  deviceId: string
  username: string
  machineName: string
  clientPublicKey: string
  hostPublicKey: string
  identityRevision: string
  route: { tunnelId: string; sshPort: number; controlPort: number }
}

export interface PublicPeerGrant {
  operationId: string
  grantId: string
  issuerId: string
  recipientId: string
  expiresAt: string
  issuerIdentityRef: string
  recipientIdentityRef: string
}

export interface PeerConnection {
  notify(payload: unknown): Promise<unknown>
  close(): void
  connected?(): Promise<boolean>
}

/** Drives reciprocal links; all trust, signed records and transport are supplied by the owner. */
export class PeerLinks {
  private readonly connections = new Map<string, { grant: string; connection: PeerConnection }>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly states = new Map<string, GitSyncPeer>()
  private readonly notices = new Map<string, { payload: unknown; recipients: Set<string> }>()
  private readonly deliveries = new Map<string, Promise<void>>()
  private peers = new Map<string, PublicPeer>()
  private incoming = new Map<string, PublicPeerGrant>()
  private enabled = true
  private closed = false
  private generation = 0

  constructor(private readonly options: {
    localId: string
    localIdentityRevision(): string
    authorize(peer: PublicPeer): Promise<void>
    issue(peer: PublicPeer): Promise<void>
    connect(peer: PublicPeer, grant: PublicPeerGrant): Promise<PeerConnection>
    disconnected(peerId: string): Promise<void>
    onChanged(): void
    onError(error: unknown): void
    now?: () => number
  }) {}

  status(): GitSyncPeer[] { return [...this.states.values()].map((state) => ({ ...state })) }

  async reconcile(peers: PublicPeer[], incoming: PublicPeerGrant[], enabled = true): Promise<void> {
    if (this.closed) throw new Error('Peer links are closed.')
    this.enabled = enabled
    this.peers = new Map(peers.filter((peer) => peer.deviceId !== this.options.localId).map((peer) => [peer.deviceId, peer]))
    this.incoming = new Map(incoming.filter((grant) => grant.recipientId === this.options.localId).map((grant) => [grant.issuerId, grant]))
    for (const id of [...this.states.keys()]) {
      if (!this.peers.has(id) || !enabled) await this.drop(id)
    }
    if (!enabled) return
    await Promise.all([...this.peers.keys()].map((id) => this.ensure(id)))
  }

  private currentGrant(peer: PublicPeer): PublicPeerGrant | undefined {
    const grant = this.incoming.get(peer.deviceId)
    return grant && Date.parse(grant.expiresAt) > (this.options.now?.() ?? Date.now())
      && grant.issuerIdentityRef === peer.identityRevision
      && grant.recipientIdentityRef === this.options.localIdentityRevision() ? grant : undefined
  }

  private ensure(id: string): Promise<void> {
    const prior = this.running.get(id)
    if (prior) return prior
    const generation = this.generation
    const work = this.reconcilePeer(id, generation).finally(() => {
      if (this.running.get(id) === work) this.running.delete(id)
    })
    this.running.set(id, work)
    return work
  }

  private async reconcilePeer(id: string, generation: number): Promise<void> {
    const peer = this.peers.get(id)
    if (!peer || !this.enabled || this.closed) return
    const active = () => !this.closed && this.enabled && this.generation === generation && this.peers.get(id) === peer
    try {
      await this.options.authorize(peer)
      if (!active()) return
      const grant = this.currentGrant(peer)
      const prior = this.connections.get(id)
      if (prior && (!grant || prior.grant !== grant.operationId || prior.connection.connected && !await prior.connection.connected())) await this.drop(id)
      let connectionFailure: { error: unknown } | undefined
      if (grant && !this.connections.has(id)) {
        this.states.set(id, { deviceId: id, machineName: peer.machineName, state: 'connecting' })
        this.options.onChanged()
        try {
          const connection = await this.options.connect(peer, grant)
          if (!active() || this.currentGrant(peer)?.operationId !== grant.operationId) { connection.close(); await this.options.disconnected(id); return }
          this.connections.set(id, { grant: grant.operationId, connection })
        } catch (error) { connectionFailure = { error } }
      }
      // Publication can proceed when the opposite direction has not arrived yet.
      await this.options.issue(peer)
      if (!active()) return
      if (connectionFailure) throw connectionFailure.error
      this.states.set(id, { deviceId: id, machineName: peer.machineName, state: this.connections.has(id) ? 'linked' : 'discovered' })
      await this.deliver(id)
    } catch (error) {
      const connection = this.connections.get(id)
      connection?.connection.close()
      this.connections.delete(id)
      try { await this.options.disconnected(id) } catch (cleanupError) { this.options.onError(cleanupError) }
      if (!active()) return
      this.states.set(id, { deviceId: id, machineName: peer.machineName, state: 'offline', error: error instanceof Error ? error.message : 'The peer link failed.' })
    } finally { this.options.onChanged() }
  }

  async notify(operationId: string, payload: unknown, recipients: string[]): Promise<void> {
    if (this.closed) throw new Error('Peer links are closed.')
    if (!this.notices.has(operationId) && this.notices.size >= 1000) throw new Error('The pending SSH notification limit is 1,000 changes. Git publication remains available.')
    const pending = this.notices.get(operationId) ?? { payload, recipients: new Set<string>() }
    for (const id of recipients) if (id !== this.options.localId) pending.recipients.add(id)
    if (!pending.recipients.size) return
    this.notices.set(operationId, pending)
    await Promise.all([...pending.recipients].map(async (id) => { await this.ensure(id); await this.deliver(id) }))
  }

  private deliver(id: string): Promise<void> {
    const previous = this.deliveries.get(id)
    if (previous) return previous.then(() => this.deliver(id))
    const work = this.deliverCurrent(id).finally(() => { if (this.deliveries.get(id) === work) this.deliveries.delete(id) })
    this.deliveries.set(id, work)
    return work
  }

  private async deliverCurrent(id: string): Promise<void> {
    const active = this.connections.get(id)
    if (!active || !this.enabled) return
    for (const [key, notice] of this.notices) {
      if (this.closed || !this.enabled || this.connections.get(id) !== active) return
      if (!notice.recipients.has(id)) continue
      await active.connection.notify(notice.payload)
      notice.recipients.delete(id)
      if (!notice.recipients.size) this.notices.delete(key)
    }
  }

  async drop(id: string): Promise<void> {
    const active = this.connections.get(id)
    active?.connection.close()
    this.connections.delete(id)
    this.states.delete(id)
    await this.options.disconnected(id)
    this.options.onChanged()
  }

  async pause(): Promise<void> {
    this.enabled = false
    this.generation++
    for (const id of this.connections.keys()) await this.drop(id)
    await Promise.all([...this.running.values()])
    await Promise.allSettled([...this.deliveries.values()])
  }

  async close(): Promise<void> {
    this.closed = true
    await this.pause()
    this.notices.clear()
  }
}
