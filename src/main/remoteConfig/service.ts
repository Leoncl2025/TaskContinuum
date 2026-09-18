import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import ssh2 from 'ssh2'
import { z } from 'zod'
import type { WorkspaceGitSyncStatus } from '../../shared/gitSync'
import type { DeviceRecord, RemoteConfigSnapshot, RemoteRecord } from '../../shared/remoteConfig'
import { readClientIdentity } from '../clientIdentity'
import type { DeviceSshKeys } from '../devTunnel/identity'
import type { ManagedDevTunnels } from '../devTunnel/manager'
import { sshFingerprint } from '../devTunnel/protocol'
import { canonicalPolicyRoot } from '../linkedSessionPolicy'
import { registerRepositorySessionLinksBackend } from '../repositorySessionLinks'
import { readJsonBounded, writeJsonAtomic } from '../shared/storage'
import { deviceInvitationSchema } from '../vscodeDeviceProtocol'
import type { VSCodeDeviceClient } from '../vscodeDeviceClient'
import type { VSCodeDeviceHost } from '../vscodeDeviceHost'
import { LocalEnrollments, initialWorkspaceId } from './enrollment'
import type { WorkspaceEnrollment } from './enrollment'
import { WorkspaceGitReplica as GitReplica } from './workspaceGit'
import type { WorkspaceGitOptions as GitReplicaOptions } from './workspaceGit'
import { GitSyncError } from './git'
import { BindingOverlay } from './overlay'
import { PeerLinks } from './peers'
import type { PublicPeer, PublicPeerGrant } from './peers'
import { PeerControlError, PeerControlServer, callPeer } from './peerControl'
import { RemoteSyncScheduler } from './scheduler'
import { LocalSettingsFile } from './settingsFile'
import type { RemoteSettingChanges, RemoteSettings } from './settingsFile'
import { RemoteConfigStore } from './store'
import {
  canonicalJson, parseRecord, readCheckedFile, readRecords, recordClosure, recordPath, RemoteConfigError, resolveRecords, serializeRecord, unionRecords, verifyRecordSignature,
} from './records'
import type { RecordTrust } from './records'

const descriptorSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('taskcontinuum-workspace'), workspaceId: z.uuid(),
  remoteConfigFormat: z.literal('immutable-operations-v1'),
}).strict()
const runtimeSchema = z.object({
  schemaVersion: z.literal(1), workspaceId: z.uuid(), recordsRoot: z.string().min(1),
  controlPort: z.number().int().min(1024).max(65535).optional(),
  managedPairs: z.record(z.uuid(), z.uuid()).default({}),
}).strict()
type RuntimeMetadata = z.infer<typeof runtimeSchema>
interface Runtime {
  root: string
  directory: string
  metadata: RuntimeMetadata
  enrollment: WorkspaceEnrollment
  local: Awaited<ReturnType<typeof readClientIdentity>>
  store: RemoteConfigStore
  scheduler: RemoteSyncScheduler
  control: PeerControlServer
  peers: PeerLinks
  settings: LocalSettingsFile
  replica?: Replica
  disposeBackend(): void
  snapshot?: RemoteConfigSnapshot
  status: WorkspaceGitSyncStatus
  ownRevision: string
  grants: Map<string, string>
  grantedPairs: Map<string, string>
  importedGrants: Map<string, string>
  network: Set<Promise<void>>
  peerWork?: Promise<void>
  peerAgain: boolean
  closed: boolean
  generation: number
  grantWork: Set<Promise<unknown>>
  disconnecting?: Promise<void>
  connectionAbort: AbortController
}
type Replica = Pick<GitReplica, 'root' | 'remote' | 'branch' | 'upstreamUrl' | 'sync' | 'close' | 'assertUpstream'>
export interface WorkspaceSyncOptions {
  directory: string
  keys: Pick<DeviceSshKeys, 'get'>
  tunnels: Pick<ManagedDevTunnels, 'publish' | 'publicEndpoint' | 'authorize' | 'revoke' | 'connect'>
  host: Pick<VSCodeDeviceHost, 'pair' | 'setWorkspace' | 'start' | 'ownerId' | 'list' | 'revoke'>
  devices: Pick<VSCodeDeviceClient, 'import' | 'connectOwner' | 'disconnectOwner' | 'ownerConnected' | 'publicIdentities'>
  identity?(): Promise<Awaited<ReturnType<typeof readClientIdentity>>>
  createReplica?(options: GitReplicaOptions): Promise<Replica>
  onChange(root: string): void
}

export class WorkspaceSyncService {
  private readonly enrollments: LocalEnrollments
  private readonly runtimes = new Map<string, Runtime>()
  private readonly starting = new Map<string, Promise<Runtime | undefined>>()
  private readonly blockedBackends = new Map<string, () => void>()
  private restoring = false
  private closed = false

  constructor(private readonly options: WorkspaceSyncOptions) { this.enrollments = new LocalEnrollments(options.directory) }

  private networkAllowed(runtime: Runtime, generation = runtime.generation): boolean {
    const localIdentity = runtime.snapshot?.resolution.entities[`device:${runtime.local.clientId}`]
    return !this.closed && !runtime.closed && runtime.enrollment.enabled && runtime.generation === generation
      && runtime.status.settings?.autoLink === true && runtime.status.settings?.tunnelEnabled === true
      && runtime.snapshot?.resolution.blocked !== true
      && (!localIdentity || localIdentity.state === 'active')
  }

  private directory(root: string): string {
    return join(this.options.directory, 'workspace-sync', createHash('sha256').update(root).digest('hex'))
  }
  private async descriptor(root: string) {
    try { return descriptorSchema.parse(JSON.parse((await readCheckedFile(root, join(root, '.taskcontinuum', 'workspace.json'), 4096)).toString('utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  private async saved(directory: string): Promise<RuntimeMetadata | undefined> {
    try {
      const value = runtimeSchema.parse(await readJsonBounded(join(directory, 'runtime.json'), 8192))
      const child = relative(directory, value.recordsRoot)
      if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) throw new Error('The saved replica path escapes its app-owned state directory.')
      return value
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  private error(runtime: Runtime, error: unknown): void {
    const message = error instanceof Error ? error.message : 'Workspace synchronization failed.'
    const changed = runtime.status.error !== message || runtime.status.state !== 'error'
    runtime.status.error = message
    runtime.status.state = 'error'
    if (changed) this.options.onChange(runtime.root)
  }
  private async checkUpstream(runtime: Runtime, opening = false): Promise<void> {
    try { await runtime.replica?.assertUpstream() } catch (error) {
      if (!(error instanceof GitSyncError) || error.code !== 'upstream' && !(opening && error.code === 'upstream-changed')) throw error
      // Missing upstream pauses Git, not cached configuration access or durable local edits.
      this.error(runtime, error)
    }
  }
  private track(runtime: Runtime, work: Promise<void>): void {
    const observed = work.catch((error: unknown) => {
      if (runtime.closed || !this.networkAllowed(runtime) && error instanceof PeerControlError && error.code === 'aborted') return
      this.error(runtime, error)
    }).finally(() => { runtime.network.delete(observed) })
    runtime.network.add(observed)
  }
  private settings(snapshot: RemoteConfigSnapshot, deviceId: string): RemoteSettings {
    const values = { autoLink: true, tunnelEnabled: true, connectTimeoutMs: 45000, ...snapshot.resolution.settings.workspace, ...snapshot.resolution.settings.devices[deviceId] }
    for (const entity of Object.values(snapshot.resolution.entities)) {
      if (entity.kind === 'setting' && ['blocked', 'needs-resolution'].includes(entity.state)) {
        if (entity.key.startsWith('setting:workspace:') || entity.key.startsWith(`setting:${deviceId}:`)) return { ...values, autoLink: false, tunnelEnabled: false }
      }
    }
    return values
  }
  private async refresh(runtime: Runtime): Promise<RemoteConfigSnapshot> {
    const before = JSON.stringify(runtime.status)
    const snapshot = await runtime.store.read()
    runtime.snapshot = snapshot
    runtime.status.pending = (await runtime.store.getPendingRecords()).length
    runtime.status.revision = snapshot.revision
    runtime.status.provisionalTasks = snapshot.provisional
    runtime.status.conflicts = [...new Set(snapshot.resolution.diagnostics.map((issue) => issue.entityKey ?? issue.code))]
    runtime.status.settings = this.settings(snapshot, runtime.local.clientId)
    const peers = new Map(runtime.peers.status().map((peer) => [peer.deviceId, peer]))
    for (const [id, pin] of Object.entries(runtime.enrollment.pins)) {
      if (id === runtime.local.clientId) continue
      const identity = snapshot.resolution.devices[id]
      const name = identity?.payload.action === 'publish' ? identity.payload.identity.machineName : id
      if (pin.blocked) peers.set(id, { deviceId: id, machineName: name, state: 'blocked', error: 'This device is locally revoked.' })
      else if (!peers.has(id)) {
        const operational = identity?.payload.action === 'publish' && !!identity.payload.identity.username && !!identity.payload.routes[0]?.controlPort
        peers.set(id, { deviceId: id, machineName: name, state: operational ? 'discovered' : 'blocked', ...(operational ? {} : { error: 'The device identity is inactive, conflicted, or missing its control endpoint.' }) })
      }
    }
    runtime.status.peers = [...peers.values()]
    if (before !== JSON.stringify(runtime.status)) this.options.onChange(runtime.root)
    return snapshot
  }

  private async admitRecords(runtime: Runtime, records: RemoteRecord[]): Promise<void> {
    const existingClients = await this.options.host.list()
    const existingHosts = await this.options.devices.publicIdentities(runtime.root)
    for (const record of records) {
      if (record.kind !== 'device' || record.payload.action !== 'publish' || record.workspaceId !== runtime.enrollment.workspaceId) continue
      const payload = record.payload
      verifyRecordSignature(record, payload.identity.clientPublicKey)
      if (record.actor.deviceId !== payload.deviceId) throw new Error('A public device record is not signed by its owner.')
      const pin = runtime.enrollment.pins[payload.deviceId]
      if (pin) {
        if (pin.clientPublicKey !== payload.identity.clientPublicKey || pin.hostPublicKey !== payload.identity.hostPublicKey) throw new Error(`Device ${payload.identity.machineName} changed SSH keys. Local trust review is required.`)
        continue
      }
      const priorClient = existingClients.find((pair) => pair.participant.clientId === payload.deviceId)
      const priorHost = existingHosts.find((peer) => peer.deviceId === payload.deviceId)
      if (priorClient && priorClient.publicKey !== payload.identity.clientPublicKey || priorHost && priorHost.hostPublicKey !== payload.identity.hostPublicKey) {
        throw new Error(`The published identity for ${payload.identity.machineName} differs from an existing SSH pairing.`)
      }
      const blocked = Object.entries(runtime.enrollment.pins).filter(([, saved]) => saved.blocked)
      await this.enrollments.admit(runtime.root, payload.deviceId, payload.identity.clientPublicKey, payload.identity.hostPublicKey)
      runtime.enrollment = (await this.enrollments.get(runtime.root))!
      for (const [id, saved] of blocked) runtime.enrollment.pins[id] = saved
    }
  }

  async open(root: string): Promise<void> {
    const runtime = await this.ensure(root, false)
    if (runtime) await this.checkUpstream(runtime, true)
  }

  async restore(): Promise<void> {
    this.restoring = true
    try {
      for (const enrollment of await this.enrollments.list()) {
        try { await this.ensure(enrollment.root, false) } catch (error) {
          const fail = async (): Promise<never> => { throw new Error('The enrolled workspace configuration is unavailable. Legacy authorization is disabled.', { cause: error }) }
          try {
            this.blockedBackends.get(enrollment.root)?.()
            this.blockedBackends.set(enrollment.root, await registerRepositorySessionLinksBackend(enrollment.root, { read: fail, update: fail }))
          } catch (registrationError) {
            if ((registrationError as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Cannot register the unavailable workspace (${enrollment.root}):`, registrationError instanceof Error ? registrationError.message : 'Invalid workspace')
          }
          console.error(`Workspace synchronization restoration failed (${enrollment.root}):`, error instanceof Error ? error.message : 'Invalid enrollment')
        }
      }
    } finally { this.restoring = false }
  }

  startRestored(): void {
    for (const runtime of this.runtimes.values()) if (runtime.enrollment.enabled) {
      this.reconcilePeers(runtime)
      runtime.scheduler.start()
    }
  }

  async whenConnectionsSettled(root: string): Promise<void> {
    const runtime = await this.ensure(root, false)
    if (!runtime) return
    await runtime.peerWork
    await runtime.scheduler.whenIdle()
    await runtime.peerWork
  }

  async restoreControlGrants(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      const generation = runtime.generation
      if (!this.networkAllowed(runtime, generation) || !runtime.metadata.controlPort) continue
      const snapshot = await runtime.store.read()
      if (!this.networkAllowed(runtime, generation)) continue
      if (snapshot.resolution.blocked) { this.error(runtime, new Error('Cannot restore invalid metadata grants.')); continue }
      for (const grant of Object.values(snapshot.resolution.invitations)) {
        if (grant.payload.action !== 'grant' || grant.payload.issuerId !== runtime.local.clientId) continue
        const pin = runtime.enrollment.pins[grant.payload.recipientId]
        if (!pin || pin.blocked) continue
        const lifetime = { id: grant.payload.grantId, expiresAt: grant.payload.expiresAt }
        runtime.control.allow(lifetime, grant.payload.recipientId, pin.clientPublicKey)
        this.options.tunnels.authorize(lifetime, pin.clientPublicKey, runtime.metadata.controlPort, true)
        runtime.grants.set(lifetime.id, grant.payload.recipientId)
      }
    }
  }

  async requireReadyRoot(root: string): Promise<void> {
    const canonical = process.platform === 'win32' ? root.toLowerCase() : root
    const enrolled = (await this.enrollments.list()).find((row) => row.root === canonical)
    if (!enrolled) return
    const runtime = this.runtimes.get(canonical)
    if (!runtime || !this.networkAllowed(runtime)) {
      throw new Error('The enrolled workspace must restore its authoritative configuration before granting session access.')
    }
  }

  private async ensure(root: string, enable: boolean): Promise<Runtime | undefined> {
    if (this.closed) throw new Error('Workspace synchronization is closed.')
    root = await canonicalPolicyRoot(root)
    const prior = this.runtimes.get(root)
    if (prior) {
      if (enable && !prior.enrollment.enabled) {
        prior.enrollment = await this.enrollments.enable(root, prior.enrollment.workspaceId, true)
        prior.status.enabled = true
        this.reconcilePeers(prior)
        prior.scheduler.start()
      }
      return prior
    }
    const current = this.starting.get(root)
    if (current) {
      await current
      return this.ensure(root, enable)
    }
    const work = this.create(root, enable).finally(() => { this.starting.delete(root) })
    this.starting.set(root, work)
    return work
  }

  private async create(root: string, enable: boolean): Promise<Runtime | undefined> {
    let enrollment = await this.enrollments.get(root)
    if (!enrollment && !enable) return undefined
    const directory = this.directory(root)
    await mkdir(directory, { recursive: true })
    let metadata = await this.saved(directory)
    let replica: Replica | undefined
    if (!metadata) {
      if (!enable && !enrollment?.enabled) throw new Error('The paused workspace has no local synced configuration. Reenable to recover it.')
      replica = await (this.options.createReplica ?? GitReplica.open)({ workspaceRoot: root, stateDirectory: directory })
      const published = await this.descriptor(replica.root)
      const workspaceId = published?.workspaceId ?? enrollment?.workspaceId ?? initialWorkspaceId(replica.upstreamUrl)
      if (enrollment && enrollment.workspaceId !== workspaceId) throw new Error('The upstream workspace identity differs from its local enrollment.')
      enrollment = await this.enrollments.enable(root, workspaceId, true)
      metadata = { schemaVersion: 1, workspaceId, recordsRoot: replica.root, managedPairs: {} }
      await writeJsonAtomic(join(directory, 'runtime.json'), metadata)
    } else {
      replica = await (this.options.createReplica ?? GitReplica.open)({ workspaceRoot: root, stateDirectory: directory, prepare: false, cachedRoot: metadata.recordsRoot })
      if (replica.root !== metadata.recordsRoot) throw new Error('The workspace upstream changed. Review its existing enrollment before publishing.')
    }
    if (!enrollment || enrollment.workspaceId !== metadata.workspaceId) throw new Error('The saved replica does not match this local enrollment.')
    if (enable && !enrollment.enabled) enrollment = await this.enrollments.enable(root, metadata.workspaceId, true)
    const local = await (this.options.identity?.() ?? readClientIdentity(this.options.directory))
    const [client, hostKey] = await Promise.all([this.options.keys.get('client'), this.options.keys.get('host')])
    if (enrollment.enabled) await this.enrollments.admit(root, local.clientId, client.publicKey, hostKey.publicKey, true)
    enrollment = (await this.enrollments.get(root))!
    const parsedKey = ssh2.utils.parseKey(client.privateKey)
    if (parsedKey instanceof Error || Array.isArray(parsedKey)) throw new Error('The local signing key cannot be loaded.')
    const sign = (bytes: Buffer) => {
      const value = parsedKey.sign(bytes)
      if (value instanceof Error) throw value
      return value
    }
    const trust: RecordTrust = {
      workspaceId: enrollment.workspaceId,
      maximumInvitationLifetimeMs: 24 * 60 * 60 * 1000,
      trustedKey: (actor) => {
        const pin = runtime.enrollment.pins[actor.deviceId]
        return pin && sshFingerprint(pin.clientPublicKey) === actor.keyId ? pin.clientPublicKey : undefined
      },
      authorize: (record) => {
        const pin = runtime.enrollment.pins[record.actor.deviceId]
        return !!pin && (!pin.blocked || !!pin.acceptedOperations?.includes(record.operationId))
      },
    }
    const scheduler = new RemoteSyncScheduler({
      cycle: ({ signal }) => this.cycle(runtime, signal),
      onStatus: (status) => {
        runtime.status.state = status.state === 'running' ? 'syncing' : status.state === 'stopped' ? 'disabled' : status.state === 'error' ? 'error' : runtime.status.error ? 'error' : 'idle'
        if (status.error) runtime.status.error = status.error
        this.options.onChange(root)
      },
    })
    const changed = () => this.options.onChange(root)
    const overlay = new BindingOverlay({
      workspaceId: enrollment.workspaceId, recipientId: local.clientId, trust,
      markerFile: join(directory, 'store', 'binding-overlays.json'),
      requestSync: () => scheduler.request('ssh-binding'),
      onChange: changed, onError: (error) => this.error(runtime, error),
    })
    const config = new RemoteConfigStore({
      workspaceRoot: root, recordsRoot: metadata.recordsRoot, outboxRoot: join(directory, 'outbox'), stateDirectory: join(directory, 'store'),
      workspaceId: enrollment.workspaceId, actor: { deviceId: local.clientId, keyId: sshFingerprint(client.publicKey) }, sign, trust, overlay,
      onLocalChange: (records, snapshot) => {
        runtime.snapshot = snapshot
        runtime.status.settings = this.settings(snapshot, local.clientId)
        scheduler.request('configuration-change')
        this.track(runtime, Promise.resolve().then(() => this.notify(runtime, records)))
        if (records.some((record) => record.kind === 'setting')) {
          if (!runtime.status.settings.autoLink || !runtime.status.settings.tunnelEnabled) this.track(runtime, this.disconnect(runtime))
          else this.reconcilePeers(runtime)
        }
      },
      onChange: changed, onError: (error) => this.error(runtime, error),
    })
    const control = new PeerControlServer({
      workspaceId: enrollment.workspaceId, localId: local.clientId, keyPair: client, port: metadata.controlPort,
      authorize: async (senderId, publicKey) => {
        const generation = runtime.generation
        if (!this.networkAllowed(runtime, generation) || !runtime.enrollment.pins[senderId]
          || runtime.enrollment.pins[senderId].blocked || runtime.enrollment.pins[senderId].clientPublicKey !== publicKey) return false
        await this.checkUpstream(runtime)
        return this.networkAllowed(runtime, generation) && !runtime.enrollment.pins[senderId].blocked
      },
      onLink: (senderId, signal) => this.linkInvitation(runtime, senderId, signal),
      onBinding: async (senderId, payload) => {
        const acknowledgement = await config.acceptNotification({ ...payload, schemaVersion: 1, kind: 'binding.changed', workspaceId: runtime.enrollment.workspaceId, recipientId: local.clientId }, senderId)
        await this.refresh(runtime)
        scheduler.request('ssh-binding')
        return acknowledgement
      },
    })
    const peers = new PeerLinks({
      localId: local.clientId, localIdentityRevision: () => runtime.ownRevision,
      authorize: async (peer) => {
        if (!this.networkAllowed(runtime)) throw new Error('Automatic workspace connections are disabled.')
        const pin = runtime.enrollment.pins[peer.deviceId]
        if (!pin || pin.blocked || pin.clientPublicKey !== peer.clientPublicKey || pin.hostPublicKey !== peer.hostPublicKey) throw new Error('The peer does not match the local pinned identity.')
      },
      issue: (peer) => this.issue(runtime, peer),
      connect: async (peer, grant) => {
        const generation = runtime.generation
        if (!this.networkAllowed(runtime, generation)) throw new Error('Automatic workspace connections are disabled.')
        const options = {
          workspaceId: runtime.enrollment.workspaceId, local: { deviceId: local.clientId, keyPair: client },
          recipient: { deviceId: peer.deviceId, clientPublicKey: peer.clientPublicKey, hostPublicKey: peer.hostPublicKey },
          grantId: grant.grantId, expiresAt: grant.expiresAt,
          route: { kind: 'dev-tunnel' as const, tunnelId: peer.route.tunnelId, sshPort: peer.route.sshPort, hostPublicKey: peer.hostPublicKey, clientPublicKey: client.publicKey },
          targetPort: peer.route.controlPort, transport: this.options.tunnels,
          timeoutMs: runtime.status.settings?.connectTimeoutMs ?? 45000,
        }
        const signal = runtime.connectionAbort.signal
        const invitation = deviceInvitationSchema.parse(await callPeer(options, 'link', {}, signal))
        if (!this.networkAllowed(runtime, generation)) throw new Error('Automatic workspace connections changed while linking.')
        if (invitation.ownerClientId !== peer.deviceId || invitation.devTunnel.hostPublicKey !== peer.hostPublicKey) throw new Error('The metadata endpoint returned a different device owner.')
        if (runtime.importedGrants.get(peer.deviceId) !== grant.operationId) {
          await this.options.devices.import(root, invitation, true)
          runtime.importedGrants.set(peer.deviceId, grant.operationId)
        }
        if (!this.networkAllowed(runtime, generation)) {
          await this.options.devices.disconnectOwner(root, peer.deviceId)
          throw new Error('Automatic workspace connections changed while importing the peer.')
        }
        await this.options.devices.connectOwner(root, peer.deviceId)
        return {
          connected: () => this.options.devices.ownerConnected(root, peer.deviceId),
          notify: async (payload: unknown) => {
            const operationId = parseRecord(z.object({ operation: z.unknown() }).passthrough().parse(payload).operation).operationId
            const response = z.object({
              workspaceId: z.uuid(), operationId: z.string().regex(/^[a-f0-9]{64}$/),
              result: z.enum(['provisional', 'already-synced', 'awaiting-sync', 'conflict', 'rejected']), reason: z.string().optional(),
            }).strict().parse(await callPeer({ ...options, timeoutMs: runtime.status.settings?.connectTimeoutMs ?? options.timeoutMs }, 'binding.changed', payload, signal))
            if (response.workspaceId !== runtime.enrollment.workspaceId || response.operationId !== operationId) throw new Error('Binding acknowledgement belongs to another workspace or operation.')
            if (response.result === 'rejected') throw new Error(response.reason ?? 'The peer rejected the binding notification.')
            return response
          },
          close: () => {},
        }
      },
      disconnected: (id) => this.options.devices.disconnectOwner(root, id),
      onChanged: () => { runtime.status.peers = peers.status(); changed() },
      onError: (error) => this.error(runtime, error),
    })
    const settings = new LocalSettingsFile(join(directory, 'settings.json'), {
      read: async () => {
        const snapshot = await config.read()
        const prefix = `setting:${local.clientId}:`
        return {
          revision: snapshot.revision, values: this.settings(snapshot, local.clientId),
          frontier: { autoLink: snapshot.resolution.heads[`${prefix}autoLink`] ?? [], tunnelEnabled: snapshot.resolution.heads[`${prefix}tunnelEnabled`] ?? [], connectTimeoutMs: snapshot.resolution.heads[`${prefix}connectTimeoutMs`] ?? [] },
        }
      },
      apply: async (revision, changes, frontier) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          await this.checkUpstream(runtime)
          const before = await config.read()
          if (frontier) {
            for (const key of ['autoLink', 'tunnelEnabled', 'connectTimeoutMs'] as const) {
              if (changes[key] !== undefined && canonicalJson(frontier[key]) !== canonicalJson(before.resolution.heads[`setting:${local.clientId}:${key}`] ?? [])
                && before.resolution.settings.devices[local.clientId]?.[key] !== changes[key]) {
                throw new Error(`Setting ${key} changed concurrently. The edited proposal is retained for resolution.`)
              }
            }
          }
          try {
            await config.updateSettings(frontier ? before.revision : revision, changes, { scope: 'device', deviceId: local.clientId })
            return
          } catch (error) {
            if (!(error instanceof RemoteConfigError) || error.code !== 'stale-revision' || !frontier || attempt === 2) throw error
          }
        }
      },
      onError: (error) => this.error(runtime, error),
    })
    const runtime: Runtime = {
      root, directory, metadata, enrollment, local, store: config, scheduler, control, peers, settings, replica,
      disposeBackend: () => {}, status: { enabled: enrollment.enabled, workspaceId: enrollment.workspaceId, intervalMs: 15000, state: 'starting', pending: 0, provisionalTasks: [], conflicts: [], peers: [], revision: null, settingsFile: settings.file },
      ownRevision: '', grants: new Map(), grantedPairs: new Map(Object.entries(metadata.managedPairs)), importedGrants: new Map(), network: new Set(), peerAgain: false, closed: false, generation: 0, grantWork: new Set(), connectionAbort: new AbortController(),
    }
    try {
      await mkdir(config.options.outboxRoot, { recursive: true })
      await mkdir(config.options.stateDirectory, { recursive: true })
      await this.admitRecords(runtime, unionRecords(await readRecords(metadata.recordsRoot), await readRecords(config.options.outboxRoot)))
      const endpoint = await control.start()
      metadata.controlPort = endpoint.port
      await writeJsonAtomic(join(directory, 'runtime.json'), metadata)
      await config.initialize()
      this.blockedBackends.get(root)?.()
      this.blockedBackends.delete(root)
      runtime.disposeBackend = await registerRepositorySessionLinksBackend(root, {
        read: () => config.read(),
        writeBinding: async (taskId, target, revision, beforeWrite) => {
          await this.checkUpstream(runtime)
          return config.writeBinding(taskId, target, revision, async () => {
            await this.checkUpstream(runtime)
            await beforeWrite?.()
          })
        },
        update: async (revision, transform, beforeWrite) => {
          await this.checkUpstream(runtime)
          return config.update(revision, transform, async () => {
            await this.checkUpstream(runtime)
            await beforeWrite?.()
          })
        },
      })
      this.runtimes.set(root, runtime)
      await this.refresh(runtime)
      try { await settings.start() } catch (error) { this.error(runtime, error) }
      if (enrollment.enabled && !this.restoring) { this.reconcilePeers(runtime); scheduler.start() }
      else runtime.status.state = 'disabled'
      return runtime
    } catch (error) {
      runtime.disposeBackend()
      await control.close()
      await config.close()
      await replica?.close()
      throw error
    }
  }

  async enable(root: string): Promise<void> {
    const runtime = await this.ensure(root, true)
    if (!runtime) throw new Error('Workspace enrollment did not complete.')
    runtime.scheduler.request('enrollment')
    await runtime.scheduler.whenIdle()
    if (runtime.status.error) throw new Error(runtime.status.error)
  }
  async status(root: string): Promise<WorkspaceGitSyncStatus> {
    const runtime = await this.ensure(root, false)
    if (!runtime) return { enabled: false, intervalMs: 15000, state: 'disabled', pending: 0, provisionalTasks: [], conflicts: [], peers: [], revision: null }
    try { await this.refresh(runtime) } catch (error) { this.error(runtime, error) }
    return structuredClone(runtime.status)
  }
  async syncNow(root: string): Promise<void> {
    const runtime = await this.ensure(root, false)
    if (!runtime?.enrollment.enabled) throw new Error('Enable automatic workspace links before synchronizing.')
    runtime.scheduler.request('manual')
    await runtime.scheduler.whenIdle()
    if (runtime.status.error) throw new Error(runtime.status.error)
  }
  async setSettings(root: string, expectedRevision: string | null, changes: RemoteSettingChanges): Promise<void> {
    const runtime = await this.ensure(root, false)
    if (!runtime?.enrollment.enabled) throw new Error('Enable automatic workspace links before changing remote configuration.')
    await this.checkUpstream(runtime)
    await runtime.store.updateSettings(expectedRevision, changes, { scope: 'device', deviceId: runtime.local.clientId })
    await this.refresh(runtime)
    await runtime.settings.refresh()
    this.reconcilePeers(runtime)
  }
  async disable(root: string): Promise<void> {
    const runtime = await this.ensure(root, false)
    if (!runtime) throw new Error('This workspace is not enrolled.')
    runtime.enrollment.enabled = false
    runtime.status.enabled = false
    await runtime.scheduler.stop()
    await this.disconnect(runtime)
    await this.enrollments.disable(root)
    runtime.status.state = 'disabled'
    this.options.onChange(root)
  }

  private async cycle(runtime: Runtime, signal: AbortSignal): Promise<void> {
    if (!runtime.enrollment.enabled || runtime.closed) return
    for (const [id, pin] of Object.entries(runtime.enrollment.pins)) if (pin.blocked) await this.enrollments.revoke(runtime.root, id, pin.acceptedOperations ?? [])
    runtime.replica ??= await (this.options.createReplica ?? GitReplica.open)({ workspaceRoot: runtime.root, stateDirectory: runtime.directory })
    if (runtime.replica.root !== runtime.metadata.recordsRoot) throw new Error('The selected upstream changed. Review the existing enrollment before switching repositories.')
    const canonical = await readRecords(runtime.metadata.recordsRoot)
    const pending = await runtime.store.getPendingRecords()
    const known = new Set(canonical.map((record) => record.operationId))
    const snapshot = await runtime.store.read()
    const ownIdentity = snapshot.resolution.records.find((record) => record.kind === 'device' && record.payload.action === 'publish'
      && record.payload.deviceId === runtime.local.clientId && record.payload.identity.clientKeyId === runtime.store.options.actor.keyId)
    // Other peers must receive the signing identity in the same batch as its first operations.
    const publishable = ownIdentity && !snapshot.resolution.blocked ? pending : []
    const publication = publishable.filter((record) => !known.has(record.operationId)).map((record) => ({ path: recordPath(record).split(sep).join('/'), content: serializeRecord(record) }))
    publication.unshift({ path: '.taskcontinuum/workspace.json', content: `${JSON.stringify(descriptorSchema.parse({ schemaVersion: 1, kind: 'taskcontinuum-workspace', workspaceId: runtime.enrollment.workspaceId, remoteConfigFormat: 'immutable-operations-v1' }), null, 2)}\n` })
    await runtime.replica.sync(publication, {
      signal, refreshUserCheckout: true,
      validateReplica: async (root) => {
        const descriptor = await this.descriptor(root)
        if (descriptor && descriptor.workspaceId !== runtime.enrollment.workspaceId) throw new Error('The remote workspace identity changed. No records were accepted.')
        const records = unionRecords(await readRecords(root), await runtime.store.getPendingRecords())
        await this.admitRecords(runtime, records)
        const resolved = await resolveRecords(records, runtime.store.options.trust)
        if (resolved.blocked) throw new Error(resolved.diagnostics.map((issue) => issue.message).join('; ').slice(0, 2000))
      },
    })
    signal.throwIfAborted()
    runtime.status.lastSyncedAt = new Date().toISOString()
    runtime.status.error = undefined
    await this.refresh(runtime)
    await runtime.settings.refresh()
    this.reconcilePeers(runtime)
    await this.notify(runtime, publishable.filter((record) => record.actor.deviceId === runtime.local.clientId && !known.has(record.operationId)))
  }

  private reconcilePeers(runtime: Runtime): void {
    if (runtime.peerWork) { runtime.peerAgain = true; return }
    const work = Promise.resolve().then(async () => {
      do {
        runtime.peerAgain = false
        await runtime.disconnecting
        if (!runtime.enrollment.enabled || runtime.closed) return
        const generation = runtime.generation
        const snapshot = await this.refresh(runtime)
        if (runtime.generation !== generation || this.closed || runtime.closed || !runtime.enrollment.enabled) return
        if (!this.networkAllowed(runtime, generation)) { await this.disconnect(runtime); return }
        if (runtime.connectionAbort.signal.aborted) runtime.connectionAbort = new AbortController()
        await this.options.tunnels.publish()
        if (!this.networkAllowed(runtime, generation)) return
        const endpoint = this.options.tunnels.publicEndpoint()
        if (!endpoint || !runtime.metadata.controlPort) throw new Error('The scoped SSH publication is not ready.')
        const [client, hostKey] = await Promise.all([this.options.keys.get('client'), this.options.keys.get('host')])
        if (!this.networkAllowed(runtime, generation)) return
        const payload = {
          action: 'publish' as const, deviceId: runtime.local.clientId,
          identity: { username: runtime.local.username, machineName: runtime.local.machineName, clientPublicKey: client.publicKey, hostPublicKey: hostKey.publicKey, clientKeyId: sshFingerprint(client.publicKey), hostKeyId: sshFingerprint(hostKey.publicKey) },
          routes: [{ kind: 'dev-tunnel' as const, tunnelId: endpoint.tunnelId, sshPort: endpoint.sshPort, controlPort: runtime.metadata.controlPort }],
        }
        const previous = snapshot.resolution.devices[runtime.local.clientId]
        const own = previous && canonicalJson(previous.payload) === canonicalJson(payload) ? previous : await runtime.store.append('device', payload)
        if (!this.networkAllowed(runtime, generation)) return
        runtime.ownRevision = own.operationId
        const current = await this.refresh(runtime)
        if (!this.networkAllowed(runtime, generation)) return
        const peers = Object.values(current.resolution.devices).flatMap((record) => this.publicPeer(runtime, record) ?? [])
        const incoming = Object.values(current.resolution.invitations).filter((record) => record.payload.action === 'grant').map((record): PublicPeerGrant => {
          if (record.payload.action !== 'grant') throw new Error('Invalid active grant.')
          return { operationId: record.operationId, ...record.payload }
        })
        const validGrantIds = new Set(Object.values(current.resolution.invitations).filter((record) => record.payload.action === 'grant' && record.payload.issuerId === runtime.local.clientId).map((record) => record.payload.grantId))
        for (const [id, peerId] of runtime.grants) if (!validGrantIds.has(id) || runtime.enrollment.pins[peerId]?.blocked) {
          runtime.control.revoke(id); this.options.tunnels.revoke(id); runtime.grants.delete(id)
        }
        for (const [peerId, pairId] of runtime.grantedPairs) {
          const liveGrant = Object.values(current.resolution.invitations).some((record) => record.payload.action === 'grant'
            && record.payload.issuerId === runtime.local.clientId && record.payload.recipientId === peerId)
          if (current.resolution.devices[peerId] && liveGrant && !runtime.enrollment.pins[peerId]?.blocked) continue
          this.options.tunnels.revoke(pairId)
          const pairs = await this.options.host.list()
          if (!this.networkAllowed(runtime, generation)) return
          if (pairs.some((pair) => pair.id === pairId)) await this.options.host.setWorkspace(pairId, runtime.root, null)
          if (!this.networkAllowed(runtime, generation)) return
          runtime.grantedPairs.delete(peerId)
          delete runtime.metadata.managedPairs[peerId]
          await writeJsonAtomic(join(runtime.directory, 'runtime.json'), runtime.metadata)
        }
        if (!this.networkAllowed(runtime, generation)) return
        const pairs = await this.options.host.list()
        if (!this.networkAllowed(runtime, generation)) return
        for (const peer of peers) {
          const pair = pairs.find((entry) => entry.participant.clientId === peer.deviceId
            && entry.publicKey === peer.clientPublicKey && Date.parse(entry.expiresAt) > Date.now())
          const liveGrant = Object.values(current.resolution.invitations).some((record) => record.payload.action === 'grant'
            && record.payload.issuerId === runtime.local.clientId && record.payload.recipientId === peer.deviceId)
          if (!pair || !liveGrant) continue
          if (pair.workspaces.some((policy) => policy.root === runtime.root && policy.canSend)
            && runtime.grantedPairs.get(peer.deviceId) === pair.id) continue
          // Upgrade saved read-only grants through the same revocation-safe path as new links.
          await this.linkInvitation(runtime, peer.deviceId, runtime.connectionAbort.signal)
          if (!this.networkAllowed(runtime, generation)) return
        }
        await runtime.peers.reconcile(peers, incoming)
      } while (runtime.peerAgain)
    }).finally(() => {
      runtime.peerWork = undefined
      if (runtime.peerAgain && this.networkAllowed(runtime)) this.reconcilePeers(runtime)
    })
    runtime.peerWork = work
    this.track(runtime, work)
  }

  private publicPeer(runtime: Runtime, record: DeviceRecord): PublicPeer | undefined {
    if (record.payload.action !== 'publish' || record.payload.deviceId === runtime.local.clientId || runtime.enrollment.pins[record.payload.deviceId]?.blocked) return undefined
    const { identity } = record.payload
    const route = record.payload.routes[0]
    if (!identity.username || !route?.controlPort) return undefined
    return { deviceId: record.payload.deviceId, username: identity.username, machineName: identity.machineName, clientPublicKey: identity.clientPublicKey, hostPublicKey: identity.hostPublicKey, identityRevision: record.operationId, route: { tunnelId: route.tunnelId, sshPort: route.sshPort, controlPort: route.controlPort } }
  }
  private async issue(runtime: Runtime, peer: PublicPeer): Promise<void> {
    const generation = runtime.generation
    const enabled = () => this.networkAllowed(runtime, generation) && !runtime.enrollment.pins[peer.deviceId]?.blocked
    if (!enabled()) throw new Error('Peer admission is disabled.')
    const snapshot = await runtime.store.read()
    const prior = Object.values(snapshot.resolution.invitations).find((record) => record.payload.issuerId === runtime.local.clientId && record.payload.recipientId === peer.deviceId)
    const valid = prior?.payload.action === 'grant' && prior.payload.issuerIdentityRef === runtime.ownRevision && prior.payload.recipientIdentityRef === peer.identityRevision && Date.parse(prior.payload.expiresAt) > Date.now() + 3600000
    const issuedAt = Date.now()
    const grant = valid ? prior : await runtime.store.append('invitation', {
      action: 'grant', issuerId: runtime.local.clientId, recipientId: peer.deviceId, grantId: randomUUID(),
      issuerIdentityRef: runtime.ownRevision, recipientIdentityRef: peer.identityRevision,
      capability: 'ah-link', issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(issuedAt + 24 * 60 * 60 * 1000).toISOString(),
      routeRef: { identityRef: runtime.ownRevision, routeIndex: 0 },
    })
    if (runtime.generation !== generation || !enabled()) return
    if (grant.payload.action !== 'grant' || !runtime.metadata.controlPort) throw new Error('The reciprocal metadata grant is not ready.')
    runtime.control.allow({ id: grant.payload.grantId, expiresAt: grant.payload.expiresAt }, peer.deviceId, peer.clientPublicKey)
    this.options.tunnels.authorize({ id: grant.payload.grantId, expiresAt: grant.payload.expiresAt }, peer.clientPublicKey, runtime.metadata.controlPort, true)
    runtime.grants.set(grant.payload.grantId, peer.deviceId)
  }

  private linkInvitation(runtime: Runtime, senderId: string, signal: AbortSignal): Promise<unknown> {
    const generation = runtime.generation
    const work = Promise.resolve().then(() => this.createLinkInvitation(runtime, senderId, signal, generation))
    runtime.grantWork.add(work)
    void work.then(() => { runtime.grantWork.delete(work) }, () => { runtime.grantWork.delete(work) })
    return work
  }

  private async createLinkInvitation(runtime: Runtime, senderId: string, signal: AbortSignal, generation: number) {
    const permitted = () => this.networkAllowed(runtime, generation) && !runtime.enrollment.pins[senderId]?.blocked
    const check = () => {
      if (signal.aborted || !permitted()) throw new PeerControlError('aborted')
    }
    check()
    if (!runtime.enrollment.enabled || runtime.enrollment.pins[senderId]?.blocked) throw new Error('The peer is no longer enrolled.')
    const snapshot = await this.refresh(runtime)
    check()
    const identity = snapshot.resolution.devices[senderId]
    const peer = identity ? this.publicPeer(runtime, identity) : undefined
    if (!peer) throw new Error('The sender identity is not ready for linking.')
    const old = (await this.options.host.list()).find((pair) => pair.participant.clientId === senderId)
    check()
    if (old && old.publicKey === peer.clientPublicKey && Date.parse(old.expiresAt) <= Date.now()) {
      await this.options.host.revoke(old.id)
      this.options.tunnels.revoke(old.id)
      check()
    }
    const pair = await this.options.host.pair({ clientId: senderId, username: peer.username, machineName: peer.machineName }, peer.clientPublicKey)
    check()
    const existing = pair.workspaces.find((policy) => policy.root === runtime.root)
    let managed = runtime.grantedPairs.has(senderId)
    try {
      if (!existing?.canSend || runtime.grantedPairs.get(senderId) !== pair.id) {
        managed = true
        runtime.grantedPairs.set(senderId, pair.id)
        runtime.metadata.managedPairs[senderId] = pair.id
        await this.options.host.setWorkspace(pair.id, runtime.root, true)
        check()
        await writeJsonAtomic(join(runtime.directory, 'runtime.json'), runtime.metadata)
      }
      check()
      const port = await this.options.host.start()
      check()
      const route = this.options.tunnels.authorize(pair, peer.clientPublicKey, port, true)
      const ownerId = await this.options.host.ownerId()
      check()
      return deviceInvitationSchema.parse({
        schemaVersion: 2, provider: 'vscode-copilot-device', id: pair.id, ownerId,
        ownerClientId: runtime.local.clientId, machineName: runtime.local.machineName,
        participant: pair.participant, expiresAt: pair.expiresAt, token: pair.token, port, devTunnel: route,
      })
    } finally {
      if (!permitted() && managed) {
        await this.options.host.setWorkspace(pair.id, runtime.root, null)
      }
    }
  }

  private async notify(runtime: Runtime, records: RemoteRecord[]): Promise<void> {
    if (!this.networkAllowed(runtime)) return
    const snapshot = await this.refresh(runtime)
    for (const record of records) {
      if (record.kind !== 'binding') continue
      const dependencies = recordClosure(record, snapshot.records)
      const recipients = new Set<string>(runtime.peers.status().map((peer) => peer.deviceId))
      if (record.payload.action === 'set' && record.payload.target.owner) recipients.add(record.payload.target.owner.clientId)
      for (const prior of dependencies) if (prior.kind === 'binding' && prior.payload.action === 'set' && prior.payload.target.owner) recipients.add(prior.payload.target.owner.clientId)
      await runtime.peers.notify(record.operationId, { operation: record, dependencies }, [...recipients])
    }
  }

  async revokeDevice(root: string, deviceId: string): Promise<void> {
    const runtime = await this.ensure(root, false)
    if (!runtime?.enrollment.enabled || deviceId === runtime.local.clientId) throw new Error('Select another enrolled device to revoke.')
    const pin = runtime.enrollment.pins[z.uuid().parse(deviceId)]
    if (!pin) throw new Error('This device is not enrolled.')
    const snapshot = runtime.snapshot
    pin.blocked = true
    pin.acceptedOperations = snapshot?.records.filter((record) => record.actor.deviceId === deviceId).map((record) => record.operationId) ?? []
    for (const [grantId, peerId] of runtime.grants) if (peerId === deviceId) {
      runtime.control.revoke(grantId); this.options.tunnels.revoke(grantId); runtime.grants.delete(grantId)
    }
    const pairId = runtime.grantedPairs.get(deviceId)
    if (pairId) this.options.tunnels.revoke(pairId)
    const denial = await Promise.allSettled([
      this.enrollments.revoke(root, deviceId, pin.acceptedOperations),
      runtime.peers.drop(deviceId),
      Promise.allSettled([...runtime.grantWork]),
    ])
    if (pairId) {
      await this.options.host.setWorkspace(pairId, runtime.root, null)
      runtime.grantedPairs.delete(deviceId)
      delete runtime.metadata.managedPairs[deviceId]
      await writeJsonAtomic(join(runtime.directory, 'runtime.json'), runtime.metadata)
    }
    const failed = denial.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    if (!snapshot) return
    for (const grant of Object.values(snapshot.resolution.invitations)) {
      if (grant.payload.action !== 'grant' || grant.payload.issuerId !== runtime.local.clientId || grant.payload.recipientId !== deviceId) continue
      const { issuerId, recipientId, grantId, issuerIdentityRef, recipientIdentityRef } = grant.payload
      await runtime.store.append('invitation', { action: 'revoke', issuerId, recipientId, grantId, issuerIdentityRef, recipientIdentityRef, revokes: grant.operationId })
      runtime.control.revoke(grantId); this.options.tunnels.revoke(grantId); runtime.grants.delete(grantId)
    }
    await this.refresh(runtime)
  }

  async revokeEverywhere(deviceId: string): Promise<void> {
    z.uuid().parse(deviceId)
    for (const row of await this.enrollments.list()) {
      if (!row.pins[deviceId]) continue
      const runtime = this.runtimes.get(row.root)
      if (runtime) runtime.enrollment.pins[deviceId].blocked = true
      await this.enrollments.revoke(row.root, deviceId, runtime?.snapshot?.records.filter((record) => record.actor.deviceId === deviceId).map((record) => record.operationId) ?? [])
      if (runtime?.enrollment.enabled) {
        try { await this.revokeDevice(row.root, deviceId) } catch (error) { this.error(runtime, error) }
      }
    }
  }

  private disconnect(runtime: Runtime): Promise<void> {
    if (runtime.disconnecting) return runtime.disconnecting
    runtime.generation++
    runtime.connectionAbort.abort()
    for (const id of runtime.grants.keys()) { runtime.control.revoke(id); this.options.tunnels.revoke(id) }
    runtime.grants.clear()
    for (const pair of runtime.grantedPairs.values()) this.options.tunnels.revoke(pair)
    const work = (async () => {
      await runtime.peers.pause()
      await Promise.allSettled([...runtime.grantWork])
      for (const pair of runtime.grantedPairs.values()) {
        if ((await this.options.host.list()).some((entry) => entry.id === pair)) await this.options.host.setWorkspace(pair, runtime.root, null)
      }
    })().finally(() => { runtime.disconnecting = undefined })
    runtime.disconnecting = work
    return work
  }
  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.starting.values()])
    for (const runtime of this.runtimes.values()) {
      runtime.closed = true
      runtime.connectionAbort.abort()
      await runtime.scheduler.stop()
      await runtime.peers.close()
      await runtime.control.close()
      await Promise.all([...runtime.network])
      await runtime.settings.close()
      await runtime.store.close()
      await runtime.replica?.close()
      runtime.disposeBackend()
    }
    this.runtimes.clear()
    for (const dispose of this.blockedBackends.values()) dispose()
    this.blockedBackends.clear()
  }
}
