import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceSyncService } from '../src/main/remoteConfig/service'
import type { WorkspaceSyncOptions } from '../src/main/remoteConfig/service'
import { newSshKeyPair, openSessionSshBridge, startSessionSshHost } from '../src/main/devTunnel/sessionSsh'
import { VSCodeDeviceHost } from '../src/main/vscodeDeviceHost'
import { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import { readRepositorySessionLinks, updateRepositoryAgentHostLink, removeRepositorySessionLink } from '../src/main/repositorySessionLinks'
import { makeConfig, makeTask } from './taskDocuments/fixtures'
import type { DevTunnelRoute } from '../src/main/devTunnel/protocol'
import { LocalEnrollments } from '../src/main/remoteConfig/enrollment'
import { WorkspaceGitReplica as GitReplica } from '../src/main/remoteConfig/workspaceGit'
import { RemoteConfigStore } from '../src/main/remoteConfig/store'
import { canonicalPolicyRoot, locallyLinkedAgentHostSessions, recordLocalLink } from '../src/main/linkedSessionPolicy'
import { readRecords, recordPath, resolveRecords } from '../src/main/remoteConfig/records'
import { AgentHostRegistry } from '../src/main/agentHostRegistry'
import { AgentHostCreationClient } from '../src/main/agentHostCreationClient'
import { agentHostCreationWorkspaceId } from '../src/main/agentHostCreationService'
import { startAgentHostCreationFixture } from './agent-host-creation-fixture'

const execute = promisify(execFile)
const roots: string[] = []
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function git(root: string, ...args: string[]) {
  return (await execute('git', ['--no-pager', '-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', ...args], { cwd: root, timeout: 30000 })).stdout.trim()
}
async function workspace(root: string) {
  await mkdir(join(root, '.agentdesk'), { recursive: true })
  const task = join(root, 'tasks', 'T-0001-t-0001')
  await mkdir(task, { recursive: true })
  await writeFile(join(root, '.agentdesk', 'config.json'), JSON.stringify(makeConfig()))
  await writeFile(join(task, 'task.json'), JSON.stringify(makeTask({ id: 'T-0001' })))
  for (const [file, kind] of [['RequirementAnalysis.md', 'requirement-analysis'], ['Plan.md', 'plan'], ['Checklist.md', 'checklist']]) {
    await writeFile(join(task, file), `---\ndoc: ${kind}\nupdated: "2026-09-14"\n---\n`)
  }
}

async function fixture(count: number) {
  const root = await mkdtemp(join(tmpdir(), 'taskcon-full-sync-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  await git(root, 'init', '--bare', '--initial-branch=main', remote)
  const initial = join(root, 'seed')
  await git(root, 'clone', remote, initial)
  await git(initial, 'config', 'user.name', 'Test')
  await git(initial, 'config', 'user.email', 'test@example.invalid')
  await workspace(initial)
  await git(initial, 'add', '.')
  await git(initial, 'commit', '-m', 'Initialize fixture')
  await git(initial, 'push', '-u', 'origin', 'main')
  const hub = new Map<string, { port: number }>()
  const peers = []
  for (let index = 0; index < count; index++) {
    const name = String.fromCharCode(65 + index)
    const folder = join(root, name)
    await git(root, 'clone', remote, folder)
    const data = join(root, `data-${name}`)
    await mkdir(data)
    const identity = { clientId: randomUUID(), username: 'test', machineName: `Machine-${name}` }
    const clientKey = newSshKeyPair(), hostKey = newSshKeyPair()
    const ssh = await startSessionSshHost(hostKey)
    cleanup.push(() => ssh.close())
    const tunnelId = `machine-${name.toLowerCase()}.test`
    hub.set(tunnelId, { port: ssh.port })
    const blocked = { value: false }
    const activeGrants = new Set<string>()
    let tunnelGate: Promise<void> | undefined
    let releaseTunnel: (() => void) | undefined
    let tunnelStarted = false
    let tunnelFinished = false
    const tunnels: WorkspaceSyncOptions['tunnels'] = {
      publish: async () => { if (tunnelGate) { tunnelStarted = true; await tunnelGate; tunnelFinished = true } },
      publicEndpoint: () => ({ tunnelId, sshPort: ssh.port, hostPublicKey: hostKey.publicKey }),
      authorize: (grant, publicKey, port, device) => {
        ssh.allow(grant.id, publicKey, port, grant.expiresAt, device)
        activeGrants.add(grant.id)
        return { kind: 'dev-tunnel', tunnelId, sshPort: ssh.port, hostPublicKey: hostKey.publicKey, clientPublicKey: publicKey }
      },
      revoke: (id) => { ssh.revoke(id); activeGrants.delete(id) },
      connect: async (route: DevTunnelRoute, grantId: string, port: number, signal: AbortSignal) => {
        if (blocked.value) throw new Error('Fixture SSH offline.')
        const peer = hub.get(route.tunnelId)
        if (!peer) throw new Error('Unknown fixture tunnel.')
        const socket = createConnection({ host: '127.0.0.1', port: peer.port })
        return openSessionSshBridge(socket, { key: clientKey, hostPublicKey: route.hostPublicKey, grantId, targetPort: port, signal })
      },
    }
    const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString('utf8') }
    const host = new VSCodeDeviceHost(data, protector)
    cleanup.push(() => host.close())
    let privateGrantGate: Promise<void> | undefined
    let releasePrivateGrant: (() => void) | undefined
    let privateGrantStarted = false
    const hostApi: WorkspaceSyncOptions['host'] = {
      pair: (...args) => host.pair(...args), list: () => host.list(), start: () => host.start(), ownerId: () => host.ownerId(), revoke: (id) => host.revoke(id),
      setWorkspace: async (...args) => {
        if (args[2] !== null && privateGrantGate) { privateGrantStarted = true; await privateGrantGate }
        await host.setWorkspace(...args)
      },
    }
    const devices = new VSCodeDeviceClient(data, protector, (invitation, signal) => tunnels.connect(invitation.devTunnel, invitation.id, invitation.port, signal), async (invitation) => {
      expect(invitation.participant).toEqual(identity)
      expect(invitation.devTunnel.clientPublicKey).toBe(clientKey.publicKey)
    })
    cleanup.push(async () => devices.close())
    const onChange = vi.fn()
    let publicationGate: Promise<void> | undefined
    let releasePublication: (() => void) | undefined
    const serviceOptions: WorkspaceSyncOptions = {
      directory: data, identity: async () => identity, keys: { get: async (purpose) => purpose === 'client' ? clientKey : hostKey }, tunnels, host: hostApi, devices, onChange,
      createReplica: async (options) => {
        const replica = await GitReplica.open(options)
        return {
          root: replica.root, remote: replica.remote, branch: replica.branch, upstreamUrl: replica.upstreamUrl,
          assertUpstream: () => replica.assertUpstream(),
          sync: async (files, options) => {
            if (publicationGate) {
              await new Promise<void>((resolve, reject) => {
                const abort = () => reject(new Error('Delayed publication canceled.'))
                options?.signal?.addEventListener('abort', abort, { once: true })
                void publicationGate!.then(() => { options?.signal?.removeEventListener('abort', abort); resolve() })
              })
            }
            return replica.sync(files, options)
          },
          close: () => replica.close(),
        }
      },
    }
    let service = new WorkspaceSyncService(serviceOptions)
    cleanup.push(() => service.close())
    cleanup.push(async () => { releasePrivateGrant?.(); releasePublication?.(); releaseTunnel?.() })
    peers.push({
      folder, data, identity, service, host, devices, onChange, blocked,
      holdPublication: () => { publicationGate = new Promise<void>((resolve) => { releasePublication = resolve }) },
      releasePublication: () => { releasePublication?.(); publicationGate = undefined },
      holdPrivateGrant: () => { privateGrantStarted = false; privateGrantGate = new Promise<void>((resolve) => { releasePrivateGrant = resolve }) },
      releasePrivateGrant: () => { releasePrivateGrant?.(); privateGrantGate = undefined },
      privateGrantStarted: () => privateGrantStarted,
      holdTunnel: () => { tunnelStarted = false; tunnelFinished = false; tunnelGate = new Promise<void>((resolve) => { releaseTunnel = resolve }) },
      releaseTunnel: () => { releaseTunnel?.(); tunnelGate = undefined },
      tunnelStarted: () => tunnelStarted,
      tunnelFinished: () => tunnelFinished,
      activeGrantCount: () => activeGrants.size,
      restart: async () => { await service.close(); service = new WorkspaceSyncService(serviceOptions); return service },
    })
  }
  return { root, remote, peers }
}

async function settle(peers: Awaited<ReturnType<typeof fixture>>['peers']) {
  for (let round = 0; round < 8; round++) {
    await Promise.all(peers.map(async (peer) => {
      try { await peer.service.syncNow(peer.folder) } catch (error) {
        if (round === 7) throw error
      }
    }))
    const statuses = await Promise.all(peers.map((peer) => peer.service.status(peer.folder)))
    if (statuses.every((status) => status.peers.length === peers.length - 1 && status.peers.every((peer) => peer.state === 'linked') && !status.pending)) {
      const frontiers = await Promise.all(peers.map(async (peer) => {
        const directory = (await readdir(join(peer.data, 'workspace-sync')))[0]
        const metadata = JSON.parse(await readFile(join(peer.data, 'workspace-sync', directory, 'runtime.json'), 'utf8'))
        return (await readRecords(metadata.recordsRoot)).map((record) => record.operationId).sort().join(',')
      }))
      if (frontiers.every((frontier) => frontier === frontiers[0])) return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Peers did not converge: ${JSON.stringify(await Promise.all(peers.map((peer) => peer.service.status(peer.folder))))}`)
}

it('links A/B/C over real SSH and converges immediate binding publication through independent Git clones', async () => {
  const { peers, remote } = await fixture(3)
  const [a, b, c] = peers
  for (const peer of [b, c, a]) {
    try { await peer.service.enable(peer.folder) } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('upstream advanced during all three')) throw error
    }
  }
  await settle(peers)
  const states = await Promise.all(peers.map((peer) => peer.service.status(peer.folder)))
  expect(new Set(states.map((state) => state.workspaceId)).size).toBe(1)
  expect(states.every((state) => state.peers.every((peer) => peer.state === 'linked'))).toBe(true)
  for (const peer of peers) {
    const pairs = await peer.host.list()
    expect(pairs).toHaveLength(2)
    for (const pair of pairs) expect(pair.workspaces).toEqual([{ root: await canonicalPolicyRoot(peer.folder), canSend: true }])
  }
  const target = { hostId: 'host_machine_b', sessionId: 'copilotcli:/original-session', chatId: 'ahp-chat:/original-chat', owner: { clientId: b.identity.clientId, machineName: b.identity.machineName } }
  a.holdPublication()
  const before = await readRepositorySessionLinks(a.folder)
  await updateRepositoryAgentHostLink(a.folder, 'T-0001', target, before.revision)
  await vi.waitFor(async () => {
    expect((await readRepositorySessionLinks(b.folder)).document.bindings['T-0001']).toEqual({ provider: 'agent-host', ...target })
  }, { timeout: 15000, interval: 100 })
  expect((await b.service.status(b.folder)).provisionalTasks).toContain('T-0001')
  await b.service.syncNow(b.folder)
  expect((await b.service.status(b.folder)).provisionalTasks).toContain('T-0001')
  a.releasePublication()
  await settle(peers)
  for (const peer of [a, b, c]) {
    expect((await readRepositorySessionLinks(peer.folder)).document.bindings['T-0001']).toEqual({ provider: 'agent-host', ...target })
    expect((await peer.service.status(peer.folder)).provisionalTasks).toEqual([])
  }
  const tracked = await git(remote, '--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main', '.taskcontinuum')
  expect(tracked).toContain('records/v1/bindings/T-0001/')
  for (const file of tracked.split('\n').filter(Boolean)) {
    expect(await git(remote, '--git-dir', remote, 'show', `main:${file}`)).not.toMatch(/"token"|"privateKey"|"encrypted"|PRIVATE KEY/)
  }
  a.holdPublication()
  b.holdPublication()
  const aSettings = await a.service.status(a.folder)
  await a.service.setSettings(a.folder, aSettings.revision, { connectTimeoutMs: 10000 })
  const bFile = (await b.service.status(b.folder)).settingsFile!
  const bSettings = JSON.parse(await readFile(bFile, 'utf8'))
  bSettings.values.connectTimeoutMs = 15000
  await writeFile(bFile, JSON.stringify(bSettings))
  await vi.waitFor(async () => {
    const status = await b.service.status(b.folder)
    expect(status.settings?.connectTimeoutMs, status.error).toBe(15000)
  }, { timeout: 15000, interval: 100 })
  a.releasePublication()
  b.releasePublication()
  await settle(peers)
  const effective = []
  for (const peer of peers) {
    const directory = (await readdir(join(peer.data, 'workspace-sync')))[0]
    const metadata = JSON.parse(await readFile(join(peer.data, 'workspace-sync', directory, 'runtime.json'), 'utf8'))
    const enrollment = (await new LocalEnrollments(peer.data).get(peer.folder))!
    effective.push((await resolveRecords(await readRecords(metadata.recordsRoot), {
      workspaceId: enrollment.workspaceId, trustedKey: (actor) => enrollment.pins[actor.deviceId]?.clientPublicKey, authorize: () => true,
    })).settings)
  }
  expect(effective[0]).toEqual(effective[1])
  expect(effective[0]).toEqual(effective[2])
  expect(effective[0].devices[a.identity.clientId].connectTimeoutMs).toBe(10000)
  expect(effective[0].devices[b.identity.clientId].connectTimeoutMs).toBe(15000)
  const enrollments = new LocalEnrollments(a.data)
  expect((await enrollments.get(a.folder))?.enabled).toBe(true)
  await a.service.disable(a.folder)
  expect((await readRepositorySessionLinks(a.folder)).document.bindings['T-0001']).toEqual({ provider: 'agent-host', ...target })
  expect((await a.service.status(a.folder)).enabled).toBe(false)
  expect(await readFile(join(a.data, 'git-workspace-enrollments.json'), 'utf8')).not.toContain('privateKey')
  b.holdPublication()
  const settingsFile = (await b.service.status(b.folder)).settingsFile!
  const settings = JSON.parse(await readFile(settingsFile, 'utf8'))
  settings.values.tunnelEnabled = false
  await writeFile(settingsFile, JSON.stringify(settings))
  await vi.waitFor(async () => {
    expect((await b.service.status(b.folder)).settings?.tunnelEnabled).toBe(false)
    expect((await b.host.list()).some((pair) => pair.workspaces.some((policy) => policy.root.toLowerCase() === b.folder.toLowerCase()))).toBe(false)
  }, { timeout: 15000, interval: 100 })
  b.releasePublication()
}, 180000)

it('upgrades saved enrolled links and creates and assigns with write access without another permission step', async () => {
  const { peers, root } = await fixture(2)
  const [a, b] = peers
  const native = await startAgentHostCreationFixture()
  cleanup.push(() => native.close())
  const discovery = join(b.data, 'discovery')
  await mkdir(discovery)
  await writeFile(join(discovery, 'host.json'), JSON.stringify(native.endpoint))
  const owner = { clientId: b.identity.clientId, machineName: b.identity.machineName }
  const registry = new AgentHostRegistry(b.data, [discovery], async () => owner)
  cleanup.push(() => registry.close())
  b.host.setAgentHostAccess(registry, (folder) => locallyLinkedAgentHostSessions(b.data, folder, owner))
  const client = new AgentHostCreationClient(a.data, a.devices)
  cleanup.push(() => client.close())
  await b.service.enable(b.folder)
  await a.service.enable(a.folder)
  await settle(peers)
  const pair = (await b.host.list()).find((entry) => entry.participant.clientId === a.identity.clientId)!
  const unrelated = join(root, 'unrelated-workspace')
  await mkdir(unrelated)
  b.service = await b.restart()
  await b.host.setWorkspace(pair.id, b.folder, false)
  await b.host.setWorkspace(pair.id, unrelated, false)
  await b.service.restore()
  b.service.startRestored()
  await settle(peers)
  const restored = (await b.host.list()).find((entry) => entry.id === pair.id)!
  expect(restored.token).toBe(pair.token)
  expect(restored.workspaces).toContainEqual({ root: await canonicalPolicyRoot(b.folder), canSend: true })
  expect(restored.workspaces).toContainEqual({ root: await canonicalPolicyRoot(unrelated), canSend: false })
  expect(native.creations).toHaveLength(0)
  const worker = (await client.workers(a.folder, 'T-0001')).find((entry) => entry.owner?.clientId === owner.clientId)!
  expect(worker.state).toBe('connected')
  expect(worker.hosts).toContainEqual(expect.objectContaining({ hostId: native.hostId, available: true }))
  const workspaceId = await agentHostCreationWorkspaceId(b.folder)
  const workspace = worker.workspaces.find((entry) => entry.id === workspaceId)!
  expect(workspace).toMatchObject({ canSend: true, taskState: 'available' })
  const started = await client.create(a.folder, {
    operationId: randomUUID(), taskId: 'T-0001', workerId: worker.id, workspaceId: workspace.id,
    hostId: native.hostId, expectedRevision: workspace.expectedRevision,
  }, async () => {})
  await expect.poll(async () => (await client.status(a.folder, started.operationId, async () => {})).state, { timeout: 15000, interval: 100 }).toBe('ready')
  const result = await client.status(a.folder, started.operationId, async () => {})
  expect(native.creations).toHaveLength(1)
  expect(native.calls.some((call) => call.method === 'dispatchAction')).toBe(false)
  const { hostId, sessionId, chatId, owner: sessionOwner } = result.session!
  const binding = { provider: 'agent-host', hostId, sessionId, chatId, owner: sessionOwner }
  expect((await readRepositorySessionLinks(a.folder)).document.bindings['T-0001']).toEqual(binding)
  expect((await readRepositorySessionLinks(b.folder)).document.bindings['T-0001']).toEqual(binding)
  await b.service.revokeDevice(b.folder, a.identity.clientId)
  expect((await b.host.list()).find((entry) => entry.id === pair.id)!.workspaces).toEqual([{ root: await canonicalPolicyRoot(unrelated), canSend: false }])
}, 120000)

it('does not start Git enrollment or publication just by opening an unconfigured workspace', async () => {
  const { peers } = await fixture(1)
  const [peer] = peers
  await peer.service.open(peer.folder)
  expect(await peer.service.status(peer.folder)).toMatchObject({ enabled: false, state: 'disabled' })
  expect(await git(peer.folder, 'status', '--porcelain')).toBe('')
  expect(await readRepositorySessionLinks(peer.folder)).toEqual({ document: { schemaVersion: 1, bindings: {} }, revision: null })
}, 30000)

it('drains a private link grant and removes its permission before pause completes', async () => {
  const { peers } = await fixture(2)
  const [a, b] = peers
  await b.service.enable(b.folder)
  b.holdPrivateGrant()
  await a.service.enable(a.folder)
  for (let round = 0; round < 5 && !b.privateGrantStarted(); round++) {
    await Promise.all(peers.map(async (peer) => {
      try { await peer.service.syncNow(peer.folder) } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('upstream advanced during all three')) throw error
      }
    }))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await vi.waitFor(() => expect(b.privateGrantStarted()).toBe(true), { timeout: 20000 })
  let paused = false
  const pause = b.service.disable(b.folder).then(() => { paused = true })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(paused).toBe(false)
  b.releasePrivateGrant()
  await pause
  expect((await b.host.list()).some((pair) => pair.workspaces.some((policy) => policy.root.toLowerCase() === b.folder.toLowerCase()))).toBe(false)
  await expect(b.service.requireReadyRoot(b.folder.toLowerCase())).rejects.toThrow('authoritative')
  b.holdTunnel()
  const connects = vi.spyOn(b.devices, 'connectOwner')
  await b.service.enable(b.folder)
  await vi.waitFor(() => expect(b.tunnelStarted()).toBe(true), { timeout: 15000 })
  await b.service.disable(b.folder)
  const before = connects.mock.calls.length
  b.releaseTunnel()
  await vi.waitFor(() => expect(b.tunnelFinished()).toBe(true))
  expect(connects).toHaveBeenCalledTimes(before)
  expect(b.activeGrantCount()).toBe(0)
}, 120000)

it('does not restore metadata grants from a delayed read after auto-linking is disabled', async () => {
  const { peers } = await fixture(2)
  const [a, b] = peers
  await b.service.enable(b.folder)
  await a.service.enable(a.folder)
  await settle(peers)
  let unblock!: () => void
  const gate = new Promise<void>((resolve) => { unblock = resolve })
  const original = RemoteConfigStore.prototype.read
  let captured = false
  const spy = vi.spyOn(RemoteConfigStore.prototype, 'read').mockImplementation(async function (this: RemoteConfigStore) {
    const result = await original.call(this)
    if (!captured && this.options.workspaceRoot.toLowerCase() === b.folder.toLowerCase()) {
      captured = true
      await gate
    }
    return result
  })
  cleanup.push(async () => { unblock(); spy.mockRestore() })
  const recovery = b.service.restoreControlGrants()
  await vi.waitFor(() => expect(captured).toBe(true))
  const snapshot = await readRepositorySessionLinks(b.folder)
  await b.service.setSettings(b.folder, snapshot.revision, { autoLink: false })
  await vi.waitFor(() => expect(b.activeGrantCount()).toBe(0), { timeout: 15000 })
  unblock()
  await recovery
  expect(b.activeGrantCount()).toBe(0)
  await expect(b.service.requireReadyRoot(b.folder.toLowerCase())).rejects.toThrow('authoritative')
}, 120000)

it('initializes without legacy bindings and restores an unopened immutable backend before session authorization', async () => {
  const { peers, remote } = await fixture(1)
  const [peer] = peers
  const owner = { clientId: peer.identity.clientId, machineName: peer.identity.machineName }
  const target = { hostId: 'local_host_a', sessionId: 'copilotcli:/owner-session', chatId: 'ahp-chat:/owner-chat', owner }
  const legacyFile = join(peer.folder, '.taskcontinuum', 'session-bindings.json')
  await mkdir(join(peer.folder, '.taskcontinuum'), { recursive: true })
  await writeFile(legacyFile, '{ unsupported legacy configuration')
  await expect(readRepositorySessionLinks(peer.folder)).rejects.toThrow('Enable Automatic workspace links')
  peer.holdTunnel()
  await peer.service.enable(peer.folder)
  await vi.waitFor(() => expect(peer.tunnelStarted()).toBe(true))
  const empty = await readRepositorySessionLinks(peer.folder)
  expect(empty.document.bindings).toEqual({})
  const linked = await updateRepositoryAgentHostLink(peer.folder, 'T-0001', target, empty.revision)
  await recordLocalLink(peer.data, peer.folder, 'T-0001', linked.document.bindings['T-0001'], owner)
  expect(await git(remote, '--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main', '.taskcontinuum/records/v1')).toBe('')
  peer.releaseTunnel()
  await vi.waitFor(async () => {
    await peer.service.syncNow(peer.folder)
    expect((await peer.service.status(peer.folder)).pending).toBe(0)
  }, { timeout: 20000, interval: 100 })
  const current = await readRepositorySessionLinks(peer.folder)
  await removeRepositorySessionLink(peer.folder, 'T-0001', current.revision)
  await peer.service.syncNow(peer.folder)
  expect(await locallyLinkedAgentHostSessions(peer.data, peer.folder, owner)).toEqual([])
  const restored = await peer.restart()
  await expect(restored.requireReadyRoot(peer.folder.toLowerCase())).rejects.toThrow('authoritative')
  await restored.restore()
  await restored.requireReadyRoot(peer.folder.toLowerCase())
  expect(await locallyLinkedAgentHostSessions(peer.data, peer.folder, owner)).toEqual([])
  expect((await readRepositorySessionLinks(peer.folder)).document.bindings).toEqual({})
  expect(await readFile(legacyFile, 'utf8')).toBe('{ unsupported legacy configuration')
}, 60000)

it('denies and persists revocation even when the canonical configuration becomes unreadable', async () => {
  const { peers } = await fixture(2)
  const [a, b] = peers
  await b.service.enable(b.folder)
  await a.service.enable(a.folder)
  await settle(peers)
  const directory = (await readdir(join(b.data, 'workspace-sync')))[0]
  const metadata = JSON.parse(await readFile(join(b.data, 'workspace-sync', directory, 'runtime.json'), 'utf8'))
  const records = await readRecords(metadata.recordsRoot)
  await writeFile(join(metadata.recordsRoot, recordPath(records[0])), '{invalid')
  await expect(b.service.revokeDevice(b.folder, a.identity.clientId)).rejects.toThrow()
  expect((await new LocalEnrollments(b.data).list())[0].pins[a.identity.clientId].blocked).toBe(true)
  expect(b.activeGrantCount()).toBe(0)
  expect((await b.host.list()).filter((pair) => pair.participant.clientId === a.identity.clientId).every((pair) => !pair.workspaces.length)).toBe(true)
}, 120000)
