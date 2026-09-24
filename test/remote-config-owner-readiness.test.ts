// @vitest-environment node
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import { afterEach, expect, it, vi } from 'vitest'
import type { DeviceRecord, RemoteRecord } from '../src/shared/remoteConfig'
import { WorkspaceSyncService } from '../src/main/remoteConfig/service'
import type { WorkspaceSyncOptions } from '../src/main/remoteConfig/service'
import { LocalEnrollments } from '../src/main/remoteConfig/enrollment'
import { appendRecord, createRecord } from '../src/main/remoteConfig/records'
import type { RecordInput } from '../src/main/remoteConfig/records'
import { canonicalPolicyRoot } from '../src/main/linkedSessionPolicy'
import { newSshKeyPair } from '../src/main/devTunnel/sessionSsh'
import { sshFingerprint } from '../src/main/devTunnel/protocol'
import { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import { deviceInvitationSchema } from '../src/main/vscodeDeviceProtocol'
import type { WorkspaceGitReplica } from '../src/main/remoteConfig/workspaceGit'
import * as peerControl from '../src/main/remoteConfig/peerControl'
import * as deviceHttp from '../src/main/vscodeDeviceHttp'
import * as agentTransport from '../src/main/agentHostTransport'
import { flushAgentHostDiagnostics, measureAgentHostDiagnostic, startAgentHostDiagnostics, stopAgentHostDiagnostics } from '../src/main/agentHostDiagnostics'
import { GitSyncError } from '../src/main/remoteConfig/git'

const cleanup: (() => Promise<void>)[] = []
// Real signed-store setup shares Windows disk/crypto resources with broad integration runs.
// The product's 45s deadline is tested separately with a controlled clock.
const fixtureOptions = { timeout: 15000 }
async function drainCleanup(): Promise<void> {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Owner readiness fixture cleanup failed.')
}
afterEach(async () => {
  try { await drainCleanup() }
  finally { vi.restoreAllMocks(); vi.useRealTimers() }
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  cleanup.push(async () => { resolve() })
  return { promise, resolve }
}
function cancelled(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) reject(signal.reason)
    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

async function fixture(known = false, unrelatedWorkspace = false, discovered = true) {
  const home = await mkdtemp(join(process.cwd(), '.test-owner-ready-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'workspace'), other = join(home, 'unrelated'), data = join(home, 'profile')
  await Promise.all([root, other, data].map((path) => mkdir(path)))
  const workspaceId = randomUUID()
  const members = ['A', 'B', 'C'].map((name, index) => {
    const client = newSshKeyPair(), host = newSshKeyPair()
    const identity = { clientId: randomUUID(), username: 'fixture', machineName: `Machine-${name}` }
    const parsed = ssh2.utils.parseKey(client.privateKey)
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Fixture key is invalid.')
    return { client, host, identity, route: { kind: 'dev-tunnel' as const, tunnelId: `machine-${name.toLowerCase()}.test`, sshPort: 2200 + index, controlPort: 31001 + index },
      sign: (value: Buffer) => { const signed = parsed.sign(value); if (signed instanceof Error) throw signed; return signed } }
  })
  const [a, b, c] = members
  const record = async (input: Omit<RecordInput, 'workspaceId' | 'actor'>, author = b) => createRecord({
    ...input, workspaceId, actor: { deviceId: author.identity.clientId, keyId: sshFingerprint(author.client.publicKey) },
  } as RecordInput, author.sign)
  const identities: DeviceRecord[] = []
  for (const member of members) identities.push(await record({ kind: 'device', payload: {
    action: 'publish', deviceId: member.identity.clientId,
    identity: { username: member.identity.username, machineName: member.identity.machineName, clientPublicKey: member.client.publicKey,
      hostPublicKey: member.host.publicKey, clientKeyId: sshFingerprint(member.client.publicKey), hostKeyId: sshFingerprint(member.host.publicKey) },
    routes: [member.route],
  } }, member) as DeviceRecord)
  const grants: RemoteRecord[] = []
  for (const [index, member] of members.entries()) {
    if (index === 0) continue
    grants.push(await record({ kind: 'invitation', payload: {
      action: 'grant', capability: 'ah-link', issuerId: member.identity.clientId, recipientId: a.identity.clientId,
      grantId: randomUUID(), issuerIdentityRef: identities[index].operationId, recipientIdentityRef: identities[0].operationId,
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
      routeRef: { identityRef: identities[index].operationId, routeIndex: 0 },
    } }, member))
  }
  const enrollment = new LocalEnrollments(data)
  await enrollment.enable(root, workspaceId, true)
  for (const member of members) await enrollment.admit(root, member.identity.clientId, member.client.publicKey, member.host.publicKey, true)
  if (unrelatedWorkspace) await enrollment.enable(other, randomUUID(), true)
  const canonical = await canonicalPolicyRoot(root)
  const directory = join(data, 'workspace-sync', createHash('sha256').update(canonical).digest('hex'))
  const recordsRoot = join(directory, 'records-cache')
  await mkdir(recordsRoot, { recursive: true })
  const initial = discovered ? [...identities, ...grants] : [identities[0], identities[2], grants[1]]
  for (const value of initial) await appendRecord(recordsRoot, value)
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ schemaVersion: 2, workspaceId, recordsRoot, controlPort: a.route.controlPort, managedPairs: {} }))

  const invitations = [b, c].map((member) => deviceInvitationSchema.parse({
    schemaVersion: 2, provider: 'vscode-copilot-device', id: randomUUID(), ownerId: randomUUID(),
    ownerClientId: member.identity.clientId, machineName: member.identity.machineName, participant: a.identity,
    token: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 3600000).toISOString(), port: 32001,
    devTunnel: { kind: 'dev-tunnel', tunnelId: member.route.tunnelId, sshPort: member.route.sshPort,
      hostPublicKey: member.host.publicKey, clientPublicKey: a.client.publicKey },
  }))
  const otherGate = deferred(), publication = deferred()
  let blockPublication = false
  const transport = vi.fn(async () => ({ port: 33001, close: vi.fn() }))
  const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
  const recipient = vi.fn(async (invitation) => {
    expect(invitation.participant).toEqual(a.identity)
    expect(invitation.devTunnel.clientPublicKey).toBe(a.client.publicKey)
  })
  const devices = new VSCodeDeviceClient(data, protector, transport, recipient, (folder, owner, signal) => service.whenOwnerConnected(folder, owner, signal))
  if (known) await devices.import(root, invitations[0], true)
  const requests = vi.spyOn(deviceHttp, 'deviceRequest').mockImplementation(async (_port, _remotePort, token, path) => {
    expect(path).toBe('/device/identity')
    const invitation = invitations.find((entry) => entry.token === token)!
    return { ownerId: invitation.ownerId, deviceId: invitation.id }
  })
  const socket = { send: vi.fn(), recv: vi.fn(), close: vi.fn(async () => {}) }
  const websocket = vi.spyOn(agentTransport, 'connectAgentHostWebSocket').mockResolvedValue(socket)
  const link = vi.spyOn(peerControl, 'callPeer').mockImplementation(async (options) => invitations.find((entry) => entry.ownerClientId === options.recipient.deviceId))
  vi.spyOn(peerControl.PeerControlServer.prototype, 'start').mockResolvedValue({ port: a.route.controlPort })
  const sync = vi.fn<WorkspaceGitReplica['sync']>((_files, options) => cancelled(options?.signal))
  const upstream = vi.fn(async () => {})
  const publish = vi.fn(async () => { if (blockPublication) await publication.promise })
  const options: WorkspaceSyncOptions = {
    directory: data, identity: async () => a.identity, keys: { get: async (purpose) => purpose === 'client' ? a.client : a.host },
    devices, onChange: vi.fn(), createReplica: async (options) => {
      if (options.workspaceRoot === await canonicalPolicyRoot(other) && unrelatedWorkspace) await otherGate.promise
      return { root: options.workspaceRoot, workspaceRelativePath: '', upstreamUrl: 'fixture-upstream', branch: 'main', remote: 'origin',
        assertUpstream: upstream, sync, close: async () => {} }
    },
    host: { pair: vi.fn(async () => { throw new Error('Unexpected local pairing.') }), list: async () => [], start: async () => 32001,
      ownerId: async () => a.identity.clientId, revoke: async () => {}, setWorkspace: async () => {} },
    tunnels: { publish, publicEndpoint: () => ({ ...a.route, hostPublicKey: a.host.publicKey }),
      authorize: (_grant, publicKey) => ({ ...a.route, hostPublicKey: a.host.publicKey, clientPublicKey: publicKey }), revoke: () => {}, connect: vi.fn(async () => ({ port: 33001, close: vi.fn() })) },
  }
  const service = new WorkspaceSyncService(options)
  let restoring = false
  const restore = service.restore().then(() => { restoring = true })
  cleanup.push(async () => {
    otherGate.resolve(); publication.resolve()
    try {
      await restore
      await service.close()
    } finally { devices.close() }
  })
  await vi.waitFor(() => expect(service.sessionAccessReady(canonical)).toBe(true), { timeout: 5000 })
  const target = { sessionId: 'copilotcli:/selected', chatId: 'ahp-chat:/selected', owner: { clientId: b.identity.clientId, machineName: b.identity.machineName } }
  return { root, other, canonical, data, service, devices, target, transport, websocket, socket, requests, link, invitations, b, c, record, identities, grants, recordsRoot,
    sync, upstream, publish, restored: () => restoring, holdPublication: () => { blockPublication = true }, releasePublication: publication.resolve,
    releaseOther: otherGate.resolve }
}

it.each([false, true])('opens only B with a %s known invitation while global restore and Git/publication stay pending', fixtureOptions, async (known) => {
  const f = await fixture(known, true)
  f.holdPublication()
  f.service.startRestored()
  await vi.waitFor(() => { expect(f.publish).toHaveBeenCalled(); expect(f.sync).toHaveBeenCalled() }, { timeout: 5000 })
  const allPeers = vi.spyOn(f.service, 'whenConnectionsSettled')
  expect(await f.devices.agentHostTransport(f.root, f.target, new AbortController().signal)).toBe(f.socket)
  expect(f.restored()).toBe(false)
  expect(allPeers).not.toHaveBeenCalled()
  expect(f.transport).toHaveBeenCalledOnce()
  expect(f.link).toHaveBeenCalledTimes(known ? 0 : 1)
  if (!known) expect(f.link.mock.calls[0][0].recipient.deviceId).toBe(f.target.owner.clientId)
  expect(f.socket.send).not.toHaveBeenCalled()
  expect(await f.devices.ownerConnected(f.root, f.target.owner.clientId)).toBe(true)
})

it('resolves B as soon as its identity is verified while C reconciliation and Git never finish', fixtureOptions, async () => {
  const f = await fixture()
  const identity = deferred()
  const request = f.requests.getMockImplementation()!
  f.requests.mockImplementation(async (...args) => { await identity.promise; return request(...args) })
  const link = f.link.getMockImplementation()!
  f.link.mockImplementation((...args) => args[0].recipient.deviceId === f.c.identity.clientId ? cancelled(args[3]) : link(...args))
  f.service.startRestored()
  await vi.waitFor(() => expect(f.requests).toHaveBeenCalledOnce(), { timeout: 5000 })
  const pending = f.devices.agentHostTransport(f.root, f.target, new AbortController().signal)
  identity.resolve()
  expect(await pending).toBe(f.socket)
  expect(f.link.mock.calls.some((call) => call[0].recipient.deviceId === f.c.identity.clientId)).toBe(true)
  expect(f.link.mock.calls.filter((call) => call[0].recipient.deviceId === f.target.owner.clientId)).toHaveLength(1)
  expect(f.socket.send).not.toHaveBeenCalled()
})

it('coalesces exact-owner recovery and cancelling one observer does not cancel another', fixtureOptions, async () => {
  const f = await fixture()
  const identity = deferred()
  const request = f.requests.getMockImplementation()!
  f.requests.mockImplementation(async (...args) => { await identity.promise; return request(...args) })
  const abort = new AbortController()
  const first = expect(f.service.whenOwnerConnected(f.root, f.target.owner, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
  const second = f.service.whenOwnerConnected(f.root, f.target.owner, new AbortController().signal)
  await vi.waitFor(() => expect(f.requests).toHaveBeenCalledOnce(), { timeout: 5000 })
  abort.abort()
  await first
  identity.resolve()
  await second
  expect(f.link).toHaveBeenCalledOnce()
  expect(f.transport).toHaveBeenCalledOnce()
})

it('recovers an initially missing owner when its trusted records arrive without waiting for Git to idle', fixtureOptions, async () => {
  const f = await fixture(false, false, false)
  f.holdPublication()
  const pending = f.devices.agentHostTransport(f.root, f.target, new AbortController().signal)
  await vi.waitFor(() => { expect(f.publish).toHaveBeenCalledOnce(); expect(f.sync).toHaveBeenCalledOnce() }, { timeout: 5000 })
  expect(f.link).not.toHaveBeenCalled()
  await appendRecord(f.recordsRoot, f.identities[1])
  await appendRecord(f.recordsRoot, f.grants[0])
  await f.service.status(f.root)
  expect(await pending).toBe(f.socket)
  expect(f.sync).toHaveBeenCalledOnce()
  expect(f.link).toHaveBeenCalledOnce()
})

it.each(['owner', 'machine', 'host-pin', 'recipient', 'client-key'] as const)('rejects a metadata invitation with a different %s', fixtureOptions, async (mismatch) => {
  const f = await fixture()
  const invitation = structuredClone(f.invitations[0])
  if (mismatch === 'owner') invitation.ownerClientId = randomUUID()
  if (mismatch === 'machine') invitation.machineName = 'Different-Machine'
  if (mismatch === 'host-pin') invitation.devTunnel.hostPublicKey = newSshKeyPair().publicKey
  if (mismatch === 'recipient') invitation.participant.clientId = randomUUID()
  if (mismatch === 'client-key') invitation.devTunnel.clientPublicKey = newSshKeyPair().publicKey
  f.link.mockResolvedValue(invitation)
  await expect(f.devices.agentHostTransport(f.root, f.target, new AbortController().signal)).rejects.toThrow('different device owner or recipient')
  expect(f.transport).not.toHaveBeenCalled()
  expect(f.websocket).not.toHaveBeenCalled()
})

it.each(['machine', 'disabled', 'revoked', 'expired-grant', 'removed-owner'] as const)('does not accept a %s target even with a saved private invitation', fixtureOptions, async (mode) => {
  const f = await fixture(true)
  let owner = f.target.owner
  if (mode === 'machine') owner = { ...owner, machineName: 'Different-Machine' }
  if (mode === 'disabled') await f.service.disable(f.root)
  if (mode === 'revoked') await f.service.revokeDevice(f.root, owner.clientId)
  if (mode === 'removed-owner') await appendRecord(f.recordsRoot, await f.record({ kind: 'device', parents: [f.identities[1].operationId], payload: { action: 'remove', deviceId: owner.clientId } }))
  if (mode === 'expired-grant') {
    f.holdPublication()
    const grant = f.grants[0]
    if (grant.kind !== 'invitation' || grant.payload.action !== 'grant') throw new Error('Fixture grant unavailable.')
    await appendRecord(f.recordsRoot, await f.record({ kind: 'invitation', parents: [grant.operationId],
      payload: { ...grant.payload, grantId: randomUUID(), issuedAt: new Date(Date.now() - 7200000).toISOString(), expiresAt: new Date(Date.now() - 3600000).toISOString() } }))
  }
  const abort = new AbortController()
  const pending = f.service.whenOwnerConnected(f.root, owner, abort.signal)
  if (mode === 'expired-grant') {
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalled(), { timeout: 5000 })
    abort.abort()
    await rejected
  } else await expect(pending).rejects.toThrow()
  expect(f.transport).not.toHaveBeenCalled()
  expect(f.websocket).not.toHaveBeenCalled()
})

it('rejects target identity removal during readiness and never opens a late socket', fixtureOptions, async () => {
  const f = await fixture(true)
  const identity = deferred()
  const request = f.requests.getMockImplementation()!
  f.requests.mockImplementation(async (...args) => { await identity.promise; return request(...args) })
  const pending = expect(f.devices.agentHostTransport(f.root, f.target, new AbortController().signal)).rejects.toThrow(/owner|changed/)
  await vi.waitFor(() => expect(f.requests).toHaveBeenCalledOnce(), { timeout: 5000 })
  await appendRecord(f.recordsRoot, await f.record({ kind: 'device', parents: [f.identities[1].operationId],
    payload: { action: 'remove', deviceId: f.target.owner.clientId } }))
  await f.service.status(f.root)
  await pending
  identity.resolve()
  expect(await f.devices.ownerConnected(f.root, f.target.owner.clientId)).toBe(false)
  await expect(f.devices.agentHostTransport(f.root, f.target, new AbortController().signal)).rejects.toThrow('disabled')
  expect(f.websocket).not.toHaveBeenCalled()
})

it('disables a targeted-only connection even before background peer reconciliation starts', fixtureOptions, async () => {
  const f = await fixture(true)
  await f.devices.agentHostTransport(f.root, f.target, new AbortController().signal)
  expect(f.publish).not.toHaveBeenCalled()
  await f.service.disable(f.root)
  expect(await f.devices.ownerConnected(f.root, f.target.owner.clientId)).toBe(false)
  await expect(f.devices.agentHostTransport(f.root, f.target, new AbortController().signal)).rejects.toThrow('disabled')
})

it.each(['disable', 'revoke'] as const)('rejects %s during identity verification and leaves no late live connection', fixtureOptions, async (action) => {
  const f = await fixture(true)
  const identity = deferred()
  const request = f.requests.getMockImplementation()!
  f.requests.mockImplementation(async (...args) => { await identity.promise; return request(...args) })
  const pending = expect(f.devices.agentHostTransport(f.root, f.target, new AbortController().signal)).rejects.toThrow()
  await vi.waitFor(() => expect(f.requests).toHaveBeenCalledOnce(), { timeout: 5000 })
  if (action === 'disable') await f.service.disable(f.root)
  else await f.service.revokeDevice(f.root, f.target.owner.clientId)
  await pending
  identity.resolve()
  expect(await f.devices.ownerConnected(f.root, f.target.owner.clientId)).toBe(false)
  expect(f.websocket).not.toHaveBeenCalled()
})

it('bounds a missing-owner wait, removes its deadline and does not spin on unrelated progress', fixtureOptions, async () => {
  const f = await fixture(false, false, false)
  f.holdPublication()
  vi.useFakeTimers()
  try {
    const pending = expect(f.service.whenOwnerConnected(f.root, f.target.owner, new AbortController().signal)).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.waitFor(() => { expect(f.publish).toHaveBeenCalledOnce(); expect(f.sync).toHaveBeenCalledOnce() }, { timeout: 5000 })
    await vi.advanceTimersByTimeAsync(45001)
    await pending
    expect(f.link).not.toHaveBeenCalled()
    expect(f.sync).toHaveBeenCalledOnce()
    expect(f.publish).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1) // The normal workspace scheduler, not an owner waiter.
  } finally { vi.useRealTimers() }
})

it('drains controlled waits on an early teardown with global restore, identity, another peer and Git unfinished', fixtureOptions, async () => {
  const f = await fixture(false, true)
  const identity = deferred()
  const request = f.requests.getMockImplementation()!
  f.requests.mockImplementation(async (...args) => { await identity.promise; return request(...args) })
  const link = f.link.getMockImplementation()!
  f.link.mockImplementation((...args) => args[0].recipient.deviceId === f.c.identity.clientId ? cancelled(args[3]) : link(...args))
  f.service.startRestored()
  await vi.waitFor(() => { expect(f.requests).toHaveBeenCalledOnce(); expect(f.sync).toHaveBeenCalledOnce() }, { timeout: 5000 })
  const abort = new AbortController()
  const pending = expect(f.service.whenOwnerConnected(f.root, f.target.owner, abort.signal)).rejects.toThrow()
  abort.abort()
  await pending
  // Exercise the failure-path cleanup rather than releasing any controlled gate in the test body.
  await drainCleanup()
  await expect(f.service.whenOwnerConnected(f.root, f.target.owner, new AbortController().signal)).rejects.toThrow('closed')
  await expect(f.devices.agentHostTransport(f.root, f.target, new AbortController().signal)).rejects.toThrow('closed')
  expect(f.websocket).not.toHaveBeenCalled()
})

it('records nested upstream diagnostics without changing validation or exposing paths/errors', fixtureOptions, async () => {
  const f = await fixture()
  const directory = join(f.data, 'diagnostics')
  await startAgentHostDiagnostics(directory)
  cleanup.push(() => stopAgentHostDiagnostics())
  await measureAgentHostDiagnostic('configuration.transaction', { scope: f.canonical, step: 'validation' }, () => f.service.open(f.root))
  f.upstream.mockRejectedValueOnce(new GitSyncError('upstream', 'private-upstream-detail'))
  await expect(f.service.open(f.root)).resolves.toBeUndefined()
  const failure = new GitSyncError('git', 'private-git-detail')
  f.upstream.mockRejectedValueOnce(failure)
  await expect(f.service.open(f.root)).rejects.toBe(failure)
  await flushAgentHostDiagnostics()
  const text = await readFile(join(directory, 'agent-host-diagnostics', 'agent-host.jsonl'), 'utf8')
  const records = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
  const validation = records.find((record) => record.step === 'validation' && record.status === 'begin')!
  expect(records).toContainEqual(expect.objectContaining({
    event: 'configuration.transaction', step: 'upstream', status: 'ok', parentTraceId: validation.traceId,
    scopeHash: validation.scopeHash, elapsedMs: expect.any(Number),
  }))
  expect(records.filter((record) => record.step === 'upstream' && record.status === 'error')).toHaveLength(2)
  expect(records.every((record) => !('scope' in record) && !('error' in record))).toBe(true)
  expect(text).not.toContain('private-upstream-detail')
  expect(text).not.toContain('private-git-detail')
  expect(f.upstream).toHaveBeenCalledTimes(3)
})
