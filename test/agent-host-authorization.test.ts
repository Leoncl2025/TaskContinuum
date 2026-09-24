// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, open, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteConfigStore } from '../src/main/remoteConfig/store'
import { BindingOverlay } from '../src/main/remoteConfig/overlay'
import { appendRecord, createRecord, recordPath } from '../src/main/remoteConfig/records'
import type { RecordTrust } from '../src/main/remoteConfig/records'
import type { RemoteRecord } from '../src/shared/remoteConfig'
import { immutableRecordSigner, agentHostTargetFixture } from './immutable-bindings-fixture'
import { readRepositorySessionLinksForAuthorization, registerRepositorySessionLinksBackend } from '../src/main/repositorySessionLinks'
import { locallyLinkedAgentHostSessions, recordLocalLink } from '../src/main/linkedSessionPolicy'
import { VSCodeDeviceHost } from '../src/main/vscodeDeviceHost'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import type { AgentHostRegistry } from '../src/main/agentHostRegistry'
import { newSshKeyPair } from '../src/main/devTunnel/sessionSsh'
import { connectAgentHostWebSocket, connectLocalAgentHost } from '../src/main/agentHostTransport'
import { startAgentHostFixture } from './agent-host-fixture'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { flushAgentHostDiagnostics, startAgentHostDiagnostics, stopAgentHostDiagnostics } from '../src/main/agentHostDiagnostics'
import { AgentHostAuthorization } from '../src/main/agentHostAuthorization'
import { AgentHostManager } from '../src/main/agentHostManager'
import { AgentHostRegistry as NativeRegistry } from '../src/main/agentHostRegistry'
import { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import { AuthorizationWatch } from '../src/main/shared/authorizationWatch'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(options: { count?: number; overlay?: boolean; versioned?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'continuum-authorization-'))
  const root = join(home, 'workspace'), recordsRoot = join(home, 'records'), outboxRoot = join(home, 'outbox'), stateDirectory = join(home, 'state'), profile = join(home, 'profile')
  await Promise.all([root, recordsRoot, outboxRoot, stateDirectory, profile].map((path) => mkdir(path)))
  const author = immutableRecordSigner(1)
  const workspaceId = randomUUID()
  let allowed = true
  let now = 0
  const authorize = vi.fn(() => allowed)
  const trust: RecordTrust = {
    workspaceId, trustedKey: () => author.publicKey, authorize,
    ...(options.versioned === false ? {} : { authorizationVersion: () => JSON.stringify({ allowed }) }),
  }
  const target = agentHostTargetFixture('fast-auth')
  const records: RemoteRecord[] = []
  for (let index = 0; index < (options.count ?? 1); index++) {
    const record = await createRecord({ workspaceId, actor: author.actor, parents: [], kind: 'binding',
      payload: { schemaVersion: '2.1', action: 'set', taskId: `T-${String(index + 1).padStart(4, '0')}`, targets: [{ provider: 'agent-host', ...(index ? agentHostTargetFixture(`history-${index}`) : target) }] },
    }, author.sign)
    await appendRecord(recordsRoot, record)
    records.push(record)
  }
  const overlay = options.overlay ? new BindingOverlay({ workspaceId, recipientId: author.actor.deviceId, trust, now: () => now, lifetimeMs: 1000 }) : undefined
  const store = new RemoteConfigStore({ workspaceRoot: root, recordsRoot, outboxRoot, stateDirectory, workspaceId, actor: author.actor, sign: author.sign, trust, overlay })
  await store.initialize()
  const unregister = await registerRepositorySessionLinksBackend(root, store)
  cleanup.push(async () => { unregister(); await store.close(); await rm(home, { recursive: true, force: true }) })
  const originalRead = store.read.bind(store)
  const read = vi.spyOn(store, 'read')
  return { home, root, profile, recordsRoot, outboxRoot, stateDirectory, author, workspaceId, target, records, store, trust, authorize, read, originalRead, unregister,
    deny: () => { allowed = false }, allow: () => { allowed = true }, advance: (value: number) => { now += value } }
}

describe('verified Agent Host authorization fast path', () => {
  it('disables memory leases if monitoring fails or is closed', async () => {
    const f = await fixture()
    const watcher = new AuthorizationWatch()
    const current = watcher.checkpoint()
    expect(current()).toBe(true)
    expect(() => watcher.observe(join(f.home, 'missing'), true)).toThrow()
    expect(current()).toBe(false)
    watcher.close()
    expect(watcher.checkpoint()()).toBe(false)
  })

  it('checks connected-session access in memory under 100ms while a read-only sync transaction is blocked', async () => {
    const f = await fixture({ count: 32 })
    await recordLocalLink(f.profile, f.root, 'T-0001', { provider: 'agent-host', ...f.target }, f.target.owner)
    const owner = vi.fn(async () => f.target.owner)
    const access = new AgentHostAuthorization(f.profile, owner)
    cleanup.push(async () => access.close())
    const lease = await access.acquire(f.root)
    expect(lease.current()).toBe(true)
    expect(lease.localTargets).toEqual([f.target])
    owner.mockClear()
    f.read.mockClear()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const authorize = f.trust.authorize
    f.trust.authorize = async (record) => { entered(); await gate; return authorize(record) }
    const sync = f.store.read()
    await started
    try {
      const before = performance.now()
      for (let index = 0; index < 100; index++) {
        const current = await access.acquire(f.root)
        expect(current).toBe(lease)
        expect(current.current()).toBe(true)
      }
      const elapsed = performance.now() - before
      expect(elapsed).toBeLessThan(100)
      expect(owner).not.toHaveBeenCalled()
      expect(f.read).toHaveBeenCalledOnce() // Only the blocked sync, not the 100 authorization checks.
      console.log(JSON.stringify({ memoryAuthorizationChecks: 100, elapsedMs: Math.round(elapsed), additionalFullReads: 0 }))
    } finally { release(); await sync }
  }, 10000)

  it('invalidates connected-session leases on receipt removal, trust revocation and external record changes', async () => {
    const f = await fixture()
    await recordLocalLink(f.profile, f.root, 'T-0001', { provider: 'agent-host', ...f.target }, f.target.owner)
    const access = new AgentHostAuthorization(f.profile, async () => f.target.owner)
    cleanup.push(async () => access.close())
    const receiptLease = await access.acquire(f.root)
    expect(receiptLease.current()).toBe(true)
    await recordLocalLink(f.profile, f.root, 'T-0001', undefined, f.target.owner)
    expect(receiptLease.current()).toBe(false)
    expect((await access.acquire(f.root)).localTargets).toEqual([])
    await recordLocalLink(f.profile, f.root, 'T-0001', { provider: 'agent-host', ...f.target }, f.target.owner)
    const trustLease = await access.acquire(f.root)
    f.deny()
    expect(trustLease.current()).toBe(false)
    expect((await access.acquire(f.root)).targets).toEqual([])
    f.allow()
    const fileLease = await access.acquire(f.root)
    expect(fileLease.current()).toBe(true)
    const path = join(f.recordsRoot, recordPath(f.records[0]))
    const bytes = await readFile(path, 'utf8')
    await writeFile(path, bytes.replace('T-0001', 'T-0002'))
    await expect.poll(() => fileLease.current()).toBe(false)
    await expect(access.acquire(f.root)).rejects.toThrow()
  })

  it('invalidates in-memory leases for committed unlinks and expired provisional bindings', async () => {
    const f = await fixture({ overlay: true })
    const first = await f.store.acquireAuthorization()
    expect(first.current()).toBe(true)
    await f.store.writeBinding('T-0001', null, first.snapshot.revision)
    expect(first.current()).toBe(false)
    const after = await f.store.acquireAuthorization()
    expect(after.snapshot.document.bindings['T-0001']).toBeUndefined()
    const record = await createRecord({ workspaceId: f.workspaceId, actor: f.author.actor, parents: [], kind: 'binding',
      payload: { schemaVersion: '2.1', action: 'set', taskId: 'T-0002', targets: [{ provider: 'agent-host', ...agentHostTargetFixture('provisional-memory') }] } }, f.author.sign)
    await f.store.acceptNotification({ schemaVersion: 1, kind: 'binding.changed', workspaceId: f.workspaceId, recipientId: f.author.actor.deviceId, operation: record, dependencies: [] }, f.author.actor.deviceId)
    const provisional = await f.store.acquireAuthorization()
    expect(provisional.current()).toBe(true)
    f.advance(1001)
    expect(provisional.current()).toBe(false)
    expect((await f.store.acquireAuthorization()).snapshot.document.bindings['T-0002']).toBeUndefined()
  })

  it('invalidates a memory receipt lease on external corruption and refuses stale receipt access', async () => {
    const f = await fixture()
    await recordLocalLink(f.profile, f.root, 'T-0001', { provider: 'agent-host', ...f.target }, f.target.owner)
    const access = new AgentHostAuthorization(f.profile, async () => f.target.owner)
    cleanup.push(async () => access.close())
    const lease = await access.acquire(f.root)
    expect(lease.current()).toBe(true)
    await writeFile(join(f.profile, 'local-session-link-receipts.json'), '{corrupt')
    await expect.poll(() => lease.current()).toBe(false)
    await expect(access.acquire(f.root)).rejects.toThrow('receipts')
  })

  it('uses the same memory-only check in the sending desktop manager and rejects an unlinked target', async () => {
    const f = await fixture()
    const identity = { clientId: randomUUID(), machineName: 'Sending-A' }
    const owner = vi.fn(async () => identity)
    const registry = new NativeRegistry(f.profile, [], owner)
    const devices = new VSCodeDeviceClient(f.profile,
      { available: () => true, encrypt: (text) => Buffer.from(text), decrypt: (bytes) => bytes.toString() },
      async () => { throw new Error('No device transport should be opened by authorization.') }, async () => {})
    const manager = new AgentHostManager(f.profile, registry, devices, owner)
    cleanup.push(async () => { await manager.close(); devices.close() })
    await manager.authorize(f.root, f.target)
    f.read.mockClear()
    owner.mockClear()
    const start = performance.now()
    for (let index = 0; index < 100; index++) await manager.authorize(f.root, f.target)
    expect(performance.now() - start).toBeLessThan(100)
    expect(f.read).not.toHaveBeenCalled()
    expect(owner).not.toHaveBeenCalled()
    const before = await f.store.read()
    await f.store.writeBinding('T-0001', null, before.revision)
    await expect(manager.authorize(f.root, f.target)).rejects.toThrow('no longer links')
  })

  it('reuses one verified snapshot across sequential and concurrent checks without repeating record authorization', async () => {
    const f = await fixture({ count: 64 })
    const coldStart = performance.now()
    const initial = await readRepositorySessionLinksForAuthorization(f.root)
    const coldMs = performance.now() - coldStart
    f.read.mockClear()
    f.authorize.mockClear()
    const warmStart = performance.now()
    const snapshots = await Promise.all(Array.from({ length: 32 }, () => readRepositorySessionLinksForAuthorization(f.root)))
    const warmMs = performance.now() - warmStart
    for (const snapshot of snapshots) expect(snapshot).toEqual(initial)
    await readRepositorySessionLinksForAuthorization(f.root)
    expect(f.read).not.toHaveBeenCalled()
    expect(f.authorize).not.toHaveBeenCalled()
    expect(warmMs).toBeLessThan(1000)
    expect(warmMs).toBeLessThan(coldMs)
    console.log(JSON.stringify({ authorizationRecords: 64, coldMs: Math.round(coldMs), concurrentWarmChecks: 32, warmBatchMs: Math.round(warmMs), warmFullReads: f.read.mock.calls.length }))
    snapshots[0].document.bindings = {}
    expect((await readRepositorySessionLinksForAuthorization(f.root)).document.bindings['T-0001']).toBeDefined()
  }, 15000)

  it('rechecks private receipts every time and does not reuse a removed or malformed local grant', async () => {
    const f = await fixture()
    const link = { provider: 'agent-host' as const, ...f.target }
    await recordLocalLink(f.profile, f.root, 'T-0001', link, f.target.owner)
    expect(await locallyLinkedAgentHostSessions(f.profile, f.root, f.target.owner)).toEqual([f.target])
    f.read.mockClear()
    await recordLocalLink(f.profile, f.root, 'T-0001', undefined, f.target.owner)
    expect(await locallyLinkedAgentHostSessions(f.profile, f.root, f.target.owner)).toEqual([])
    await writeFile(join(f.profile, 'local-session-link-receipts.json'), '{broken')
    await expect(locallyLinkedAgentHostSessions(f.profile, f.root, f.target.owner)).rejects.toThrow('receipts')
    expect(f.read).not.toHaveBeenCalled()
  })

  it('invalidates immediately on local deletion and refuses reads after backend removal', async () => {
    const f = await fixture()
    const before = await readRepositorySessionLinksForAuthorization(f.root)
    const changed = await f.store.writeBinding('T-0001', null, before.revision)
    expect((await readRepositorySessionLinksForAuthorization(f.root)).document).toEqual(changed.document)
    expect(changed.document.bindings['T-0001']).toBeUndefined()
    f.unregister()
    await expect(readRepositorySessionLinksForAuthorization(f.root)).rejects.toThrow('backend')
  })

  it('notices new signed disk records, missing accepted records, and same-size tampering with restored mtime', async () => {
    const f = await fixture()
    await readRepositorySessionLinksForAuthorization(f.root)
    const deleted = await createRecord({ workspaceId: f.workspaceId, actor: f.author.actor, parents: [f.records[0].operationId], kind: 'binding',
      payload: { schemaVersion: '2.1', action: 'delete', taskId: 'T-0001' } }, f.author.sign)
    await appendRecord(f.recordsRoot, deleted)
    expect((await readRepositorySessionLinksForAuthorization(f.root)).document.bindings['T-0001']).toBeUndefined()
    const path = join(f.recordsRoot, recordPath(deleted))
    const info = await stat(path)
    const bytes = await readFile(path, 'utf8')
    await writeFile(path, bytes.replace('T-0001', 'T-0002'))
    await utimes(path, info.atime, info.mtime)
    await expect(readRepositorySessionLinksForAuthorization(f.root)).rejects.toThrow()
    await writeFile(path, bytes)
    await readRepositorySessionLinksForAuthorization(f.root)
    await rm(path)
    await expect(readRepositorySessionLinksForAuthorization(f.root)).rejects.toThrow('removed')
  })

  it('rejects linked cached record files and detects replaced durable state', async () => {
    const f = await fixture()
    await readRepositorySessionLinksForAuthorization(f.root)
    const path = join(f.recordsRoot, recordPath(f.records[0]))
    const extra = join(f.home, 'extra-link.json')
    await link(path, extra)
    await expect(readRepositorySessionLinksForAuthorization(f.root)).rejects.toThrow('single-link')
    await rm(extra)
    await readRepositorySessionLinksForAuthorization(f.root)
    const statePath = join(f.stateDirectory, 'store.json')
    const state = await readFile(statePath, 'utf8')
    await writeFile(statePath, '{broken')
    await expect(readRepositorySessionLinksForAuthorization(f.root)).rejects.toThrow()
    await writeFile(statePath, state)
    expect((await readRepositorySessionLinksForAuthorization(f.root)).document.bindings['T-0001']).toBeDefined()
  })

  it.runIf(process.platform === 'win32')('rejects a junction substituted for a previously verified record root', async () => {
    const f = await fixture()
    await readRepositorySessionLinksForAuthorization(f.root)
    const { rename } = await import('node:fs/promises')
    const moved = join(f.home, 'moved-records')
    await rename(f.recordsRoot, moved)
    await symlink(moved, f.recordsRoot, 'junction')
    await expect(readRepositorySessionLinksForAuthorization(f.root)).rejects.toThrow('real directories')
  })

  it('does not cache dynamic trust without an explicit version and invalidates when the enrolled trust changes', async () => {
    const f = await fixture()
    expect((await readRepositorySessionLinksForAuthorization(f.root)).document.bindings['T-0001']).toBeDefined()
    f.deny()
    expect((await readRepositorySessionLinksForAuthorization(f.root)).document.bindings['T-0001']).toBeUndefined()
    f.allow()
    expect((await readRepositorySessionLinksForAuthorization(f.root)).document.bindings['T-0001']).toBeDefined()
    const fallback = await fixture({ versioned: false })
    await fallback.store.readForAuthorization()
    fallback.deny()
    expect((await fallback.store.readForAuthorization()).document.bindings['T-0001']).toBeUndefined()
    expect(fallback.read).toHaveBeenCalledTimes(2)
  })

  it('invalidates provisional authorization at its monotonic expiry even before the timer executes', async () => {
    const f = await fixture({ overlay: true })
    const base = f.records[0]
    const added = await createRecord({ workspaceId: f.workspaceId, actor: f.author.actor, parents: [base.operationId], kind: 'binding',
      payload: { schemaVersion: '2.1', action: 'set', taskId: 'T-0001', targets: [{ provider: 'agent-host', ...agentHostTargetFixture('provisional') }] } }, f.author.sign)
    expect((await f.store.acceptNotification({ schemaVersion: 1, kind: 'binding.changed', workspaceId: f.workspaceId, recipientId: f.author.actor.deviceId,
      operation: added, dependencies: [base] }, f.author.actor.deviceId)).result).toBe('provisional')
    const before = await readRepositorySessionLinksForAuthorization(f.root)
    expect(JSON.stringify(before.document)).toContain('provisional')
    f.advance(1001)
    expect((await readRepositorySessionLinksForAuthorization(f.root)).document.bindings['T-0001']).toBeUndefined()
  })

  it('fails closed when trust changes during an in-flight read rather than installing stale success', async () => {
    const f = await fixture()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    f.read.mockImplementationOnce(async () => {
      const result = await f.originalRead()
      entered()
      await gate
      return result
    })
    const pending = readRepositorySessionLinksForAuthorization(f.root)
    await started
    f.deny()
    release()
    expect((await pending).document.bindings['T-0001']).toBeUndefined()
  })

  it('waits for queued local updates and returns the new authorization, not the warm snapshot', async () => {
    const f = await fixture()
    const before = await readRepositorySessionLinksForAuthorization(f.root)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const update = f.store.writeBinding('T-0001', null, before.revision, async () => { entered(); await gate })
    await started
    const reading = Promise.all(Array.from({ length: 8 }, () => readRepositorySessionLinksForAuthorization(f.root)))
    release()
    await update
    for (const snapshot of await reading) expect(snapshot.document.bindings['T-0001']).toBeUndefined()
  })

  it('waits when a follow-up transaction already holds the lock as the cold read finishes', async () => {
    const f = await fixture()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    let update: Promise<unknown> | undefined
    f.read.mockImplementationOnce(async () => {
      const snapshot = await f.originalRead()
      update = f.store.writeBinding('T-0001', null, snapshot.revision, async () => { entered(); await gate })
      await started
      return snapshot
    })
    const outcome = Promise.all([readRepositorySessionLinksForAuthorization(f.root), readRepositorySessionLinksForAuthorization(f.root)]).then(
      (snapshot) => ({ snapshot, error: undefined }),
      (error: unknown) => ({ snapshot: undefined, error }),
    )
    try {
      await started
      await new Promise<void>((resolve) => setTimeout(resolve, 60))
      release()
      await update
      const result = await outcome
      expect(result.error).toBeUndefined()
      expect(result.snapshot).toHaveLength(2)
      for (const snapshot of result.snapshot ?? []) expect(snapshot.document.bindings['T-0001']).toBeUndefined()
    } finally { release(); await update; await outcome }
  })

  it('does not delete an external transaction lock or return cached permission while it is held', async () => {
    const f = await fixture()
    await readRepositorySessionLinksForAuthorization(f.root)
    const path = join(f.stateDirectory, 'store.lock')
    const lock = await open(path, 'wx', 0o600)
    try {
      await expect(readRepositorySessionLinksForAuthorization(f.root)).rejects.toMatchObject({ code: 'store-busy' })
      expect((await stat(path)).isFile()).toBe(true)
      f.deny()
    } finally { await lock.close(); await rm(path) }
    expect((await readRepositorySessionLinksForAuthorization(f.root)).document.bindings['T-0001']).toBeUndefined()
  })
  it('rejects a detached backend after an in-flight read completes', async () => {
    const f = await fixture()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    f.read.mockImplementationOnce(async () => { const snapshot = await f.originalRead(); entered(); await gate; return snapshot })
    const pending = readRepositorySessionLinksForAuthorization(f.root)
    await started
    f.unregister()
    release()
    await expect(pending).rejects.toThrow('backend changed')
  })

  it('falls back to the original full verification if ongoing synchronization prevents cache reuse', async () => {
    const f = await fixture()
    let timestamp = Date.now()
    f.read.mockImplementation(async () => {
      const snapshot = await f.originalRead()
      timestamp += 2000
      await utimes(f.outboxRoot, new Date(timestamp), new Date(timestamp))
      return snapshot
    })
    expect((await readRepositorySessionLinksForAuthorization(f.root)).document.bindings['T-0001']).toBeDefined()
    expect(f.read).toHaveBeenCalledTimes(4)
    f.deny()
    expect((await readRepositorySessionLinksForAuthorization(f.root)).document.bindings['T-0001']).toBeUndefined()
  })

  it('keeps a warm loopback send under 100ms during blocked read-only sync, with revocation still enforced', async () => {
    const f = await fixture({ count: 32 })
    const native = await startAgentHostFixture()
    const target = { ...f.target, sessionId: native.sessionId, chatId: native.chatId }
    const before = await f.store.read()
    await f.store.writeBinding('T-0001', { provider: 'agent-host', ...target }, before.revision)
    await recordLocalLink(f.profile, f.root, 'T-0001', { provider: 'agent-host', ...target }, target.owner)
    const connection = new AgentHostConnection(target, f.profile, (signal) => connectLocalAgentHost(native.endpoint, signal))
    const access = new AgentHostAuthorization(f.profile, async () => target.owner)
    const host = new VSCodeDeviceHost(f.profile, { available: () => true, encrypt: (text) => Buffer.from(text), decrypt: (bytes) => bytes.toString() })
    host.setAgentHostAccess({ connection: async () => connection } as unknown as AgentHostRegistry,
      (root) => locallyLinkedAgentHostSessions(f.profile, root, target.owner), undefined, (root) => access.acquire(root))
    const pair = await host.pair({ clientId: randomUUID(), username: 'Tester', machineName: 'Client-A' }, newSshKeyPair().publicKey)
    await host.setWorkspace(pair.id, f.root, true)
    const port = await host.start()
    const abort = new AbortController()
    const remote = new AgentHostConnection(target, join(f.home, 'remote'), (signal) => connectAgentHostWebSocket(
      `ws://127.0.0.1:${port}/device/agent-host?target=${Buffer.from(JSON.stringify(target)).toString('base64url')}`,
      { headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${pair.token}` } }, AbortSignal.any([signal, abort.signal])))
    await startAgentHostDiagnostics(join(f.home, 'diagnostics'))
    let client: AhpClient | undefined
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const backgroundEntered = new Promise<void>((resolve) => { entered = resolve })
    let sync: Promise<unknown> | undefined
    try {
      await remote.open()
      await remote.models()
      const authorize = f.trust.authorize
      f.trust.authorize = async (record) => { entered(); await gate; return authorize(record) }
      sync = f.store.read()
      await backgroundEntered
      f.read.mockClear()
      f.authorize.mockClear()
      const sendStartedUtc = new Date().toISOString()
      const started = performance.now()
      await remote.send(randomUUID(), 'Measure a guarded send', undefined, async () => {}, undefined, { id: 'gpt-6' })
      const elapsedMs = performance.now() - started
      await flushAgentHostDiagnostics()
      const events = (await readFile(join(f.home, 'diagnostics', 'agent-host-diagnostics', 'agent-host.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
      const sent = events.find((event) => event.event === 'gateway.request' && event.method === 'dispatchAction' && event.status === 'ok')
      expect(events.filter((event) => event.event === 'gateway.request' && event.method === 'subscribe' && event.channel === 'chat'
        && typeof event.timeUtc === 'string' && event.timeUtc >= sendStartedUtc)).toHaveLength(0)
      expect(sent).toMatchObject({ queueMs: 0, authMs: expect.any(Number) })
      expect(sent!.authMs).toBeLessThan(10)
      expect(elapsedMs).toBeLessThan(100)
      expect(f.read).not.toHaveBeenCalled()
      expect(f.authorize).not.toHaveBeenCalled()
      expect(native.dispatches).toHaveLength(1)
      expect(native.modelQueries()).toBe(1)
      console.log(JSON.stringify({ warmGatewaySendMs: Math.round(elapsedMs), gatewayAuthMs: sent!.authMs, warmFullReads: f.read.mock.calls.length }))
      release()
      await sync
      await host.setWorkspace(pair.id, f.root, false)
      await expect.poll(() => remote.view.state).toBe('offline')
      await remote.open()
      await expect(remote.send(randomUUID(), 'Not permitted', undefined, async () => {})).rejects.toThrow('read-only')
      client = new AhpClient(await connectAgentHostWebSocket(
        `ws://127.0.0.1:${port}/device/agent-host?target=${Buffer.from(JSON.stringify(target)).toString('base64url')}`,
        { headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${pair.token}` } }, abort.signal))
      client.connect()
      await client.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'] })
      await expect(client.subscribe('ahp-chat:/private-other')).rejects.toThrow('not authorized')
      await recordLocalLink(f.profile, f.root, 'T-0001', undefined, target.owner)
      await expect(client.ping()).rejects.toThrow()
      expect(native.dispatches).toHaveLength(1)
    } finally {
      release()
      await sync
      abort.abort()
      await client?.shutdown()
      await remote.close()
      await host.close()
      access.close()
      await connection.close()
      await native.close()
      await stopAgentHostDiagnostics()
    }
  }, 20000)
})
