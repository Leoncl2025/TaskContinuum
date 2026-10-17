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
import { captureAgentHostDiagnostics, flushAgentHostDiagnostics, startAgentHostDiagnostics, stopAgentHostDiagnostics } from '../src/main/agentHostDiagnostics'
import { AgentHostAuthorization } from '../src/main/agentHostAuthorization'
import { AgentHostManager } from '../src/main/agentHostManager'
import { AgentHostRegistry as NativeRegistry } from '../src/main/agentHostRegistry'
import { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import { AuthorizationWatch } from '../src/main/shared/authorizationWatch'
import * as inputChecks from '../src/main/remoteConfig/authorizationInputs'
import * as storeLocks from '../src/main/remoteConfig/storeLock'

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

  it.each(['pending', 'export', 'status'] as const)('keeps verified authorization under 1s while a read-only %s query is blocked', async (query) => {
    const f = await fixture({ count: 32 })
    const before = await readRepositorySessionLinksForAuthorization(f.root)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const authorize = f.trust.authorize
    f.trust.authorize = async (record) => { entered(); await gate; return authorize(record) }
    const background = query === 'pending' ? f.store.getPendingRecords() : query === 'export' ? f.store.exportRecords() : f.store.status()
    await started
    let reading: Promise<unknown> | undefined
    try {
      f.read.mockClear()
      let completed = false
      const start = performance.now()
      reading = readRepositorySessionLinksForAuthorization(f.root).then((snapshot) => {
        expect(snapshot).toEqual(before)
        completed = true
      })
      await expect.poll(() => completed, { timeout: 1000, interval: 10 }).toBe(true)
      expect(performance.now() - start).toBeLessThan(1000)
      expect(f.read).not.toHaveBeenCalled()
    } finally { release(); await background; await reading }
  }, 10000)

  it.each(['pending', 'export', 'status'] as const)('acquires the first permission lease under 1s during a blocked read-only %s query', async (query) => {
    const f = await fixture({ count: 32 })
    await f.store.read()
    f.read.mockClear()
    await recordLocalLink(f.profile, f.root, 'T-0001', { provider: 'agent-host', ...f.target }, f.target.owner)
    const access = new AgentHostAuthorization(f.profile, async () => f.target.owner)
    cleanup.push(async () => access.close())
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const originalRead = inputChecks.authorizationInputs
    const diskRead = vi.spyOn(inputChecks, 'authorizationInputs').mockImplementationOnce(async (...args) => {
      entered()
      await gate
      return originalRead(...args)
    })
    let finished = false
    const background = (query === 'pending' ? f.store.getPendingRecords() : query === 'export' ? f.store.exportRecords() : f.store.status())
      .then(() => { finished = true })
    await started
    let acquiring: ReturnType<AgentHostAuthorization['acquire']> | undefined
    try {
      let complete = false
      const start = performance.now()
      acquiring = access.acquire(f.root).then((lease) => { complete = true; return lease })
      await expect.poll(() => complete, { timeout: 1000, interval: 10 }).toBe(true)
      const lease = await acquiring
      expect(performance.now() - start).toBeLessThan(1000)
      expect(lease.current()).toBe(true)
      expect(lease.localTargets).toEqual([f.target])
      expect(f.read).not.toHaveBeenCalled()
      expect(finished).toBe(false)
    } finally { release(); await background; await acquiring; diskRead.mockRestore() }
  }, 10000)

  it('does not change the authority fingerprint for unrelated files at the record root', async () => {
    const f = await fixture()
    const before = await inputChecks.authorizationInputs(f.recordsRoot, f.outboxRoot, f.stateDirectory)
    await writeFile(join(f.recordsRoot, 'build-output.txt'), 'This artifact is not an access grant.')
    expect(await inputChecks.authorizationInputs(f.recordsRoot, f.outboxRoot, f.stateDirectory)).toBe(before)
    const record = join(f.recordsRoot, recordPath(f.records[0]))
    const bytes = await readFile(record, 'utf8')
    await writeFile(record, bytes.replace('T-0001', 'T-0002'))
    expect(await inputChecks.authorizationInputs(f.recordsRoot, f.outboxRoot, f.stateDirectory)).not.toBe(before)
  })

  it('checks mutable state bytes rather than timestamp-only changes or restored modification times', async () => {
    const f = await fixture()
    const file = join(f.stateDirectory, 'store.json')
    const timestamp = await stat(file)
    const before = await inputChecks.authorizationInputs(f.recordsRoot, f.outboxRoot, f.stateDirectory)
    await utimes(file, timestamp.atime, new Date(timestamp.mtimeMs + 2000))
    expect(await inputChecks.authorizationInputs(f.recordsRoot, f.outboxRoot, f.stateDirectory)).toBe(before)
    const content = await readFile(file, 'utf8')
    await writeFile(file, content.replace('"schemaVersion":1', '"schemaVersion":2'))
    await utimes(file, timestamp.atime, timestamp.mtime)
    expect(await inputChecks.authorizationInputs(f.recordsRoot, f.outboxRoot, f.stateDirectory)).not.toBe(before)
    await expect(f.store.acquireAuthorization()).rejects.toMatchObject({ code: 'unsupported-state' })
  })

  it('waits only for an in-process read-only lock to become ready, not for its blocked query', async () => {
    const f = await fixture()
    const before = await readRepositorySessionLinksForAuthorization(f.root)
    let lockReady!: () => void, lockEntered!: () => void, readReady!: () => void, readEntered!: () => void
    const lockGate = new Promise<void>((resolve) => { lockReady = resolve })
    const lockStarted = new Promise<void>((resolve) => { lockEntered = resolve })
    const readGate = new Promise<void>((resolve) => { readReady = resolve })
    const readStarted = new Promise<void>((resolve) => { readEntered = resolve })
    const acquire = storeLocks.acquireStoreLock
    const lock = vi.spyOn(storeLocks, 'acquireStoreLock').mockImplementationOnce(async (...args) => {
      const owned = await acquire(...args)
      lockEntered()
      await lockGate
      return owned
    })
    const authorize = f.trust.authorize
    f.trust.authorize = async (record) => { readEntered(); await readGate; return authorize(record) }
    let backgroundDone = false
    const background = f.store.status().then(() => { backgroundDone = true })
    await lockStarted
    let reading: Promise<unknown> | undefined
    try {
      let completed = false
      reading = readRepositorySessionLinksForAuthorization(f.root).then((snapshot) => {
        expect(snapshot).toEqual(before)
        completed = true
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 30))
      expect(completed).toBe(false)
      lockReady()
      await readStarted
      await expect.poll(() => completed, { timeout: 1000, interval: 10 }).toBe(true)
      expect(backgroundDone).toBe(false)
    } finally { lockReady(); readReady(); await background; await reading; lock.mockRestore() }
  }, 10000)

  it('does not restart a cold authorization read when a subsequent read-only transaction acquires the lock', async () => {
    const f = await fixture()
    await f.store.read()
    f.trust.trustedKey = () => f.author.publicKey
    f.read.mockClear()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    let background: Promise<unknown> | undefined
    f.read.mockImplementationOnce(async () => {
      const snapshot = await f.originalRead()
      const authorize = f.trust.authorize
      f.trust.authorize = async (record) => { entered(); await gate; return authorize(record) }
      background = f.store.status()
      await started
      return snapshot
    })
    let reading: ReturnType<typeof readRepositorySessionLinksForAuthorization> | undefined
    try {
      let completed = false
      reading = readRepositorySessionLinksForAuthorization(f.root).then((snapshot) => { completed = true; return snapshot })
      await started
      await expect.poll(() => completed, { timeout: 1000, interval: 10 }).toBe(true)
      expect((await reading).document.bindings['T-0001']).toHaveLength(1)
      expect(f.read).toHaveBeenCalledOnce()
    } finally { release(); await background; await reading }
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

  it('revalidates an invalidated lease without waiting for an unrelated read-only transaction', async () => {
    const f = await fixture({ count: 32 })
    await recordLocalLink(f.profile, f.root, 'T-0001', { provider: 'agent-host', ...f.target }, f.target.owner)
    const access = new AgentHostAuthorization(f.profile, async () => f.target.owner)
    cleanup.push(async () => access.close())
    const lease = await access.acquire(f.root)
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
      await writeFile(join(f.root, 'unrelated.txt'), 'This file grants no access.')
      await expect.poll(() => lease.current()).toBe(false)
      const before = performance.now()
      const pending = access.acquire(f.root)
      let completed = false
      void pending.then(() => { completed = true }, () => { completed = true })
      await expect.poll(() => completed, { timeout: 1000 }).toBe(true)
      const current = await pending
      expect(performance.now() - before).toBeLessThan(1000)
      expect(current.current()).toBe(true)
      expect(current.localTargets).toEqual([f.target])
      expect(f.read).toHaveBeenCalledOnce() // Only the still-blocked sync.
    } finally { release(); await sync }
  }, 10000)

  it('does not bypass a queued mutation while revalidating an invalidated lease', async () => {
    const f = await fixture()
    const access = new AgentHostAuthorization(f.profile, async () => f.target.owner)
    cleanup.push(async () => access.close())
    const lease = await access.acquire(f.root)
    const revision = (await f.store.acquireAuthorization()).snapshot.revision
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const authorize = f.trust.authorize
    f.trust.authorize = async (record) => { entered(); await gate; return authorize(record) }
    const sync = f.store.read()
    await started
    const update = f.store.writeBinding('T-0001', null, revision)
    let completed = false
    let authorization: ReturnType<AgentHostAuthorization['acquire']> | undefined
    try {
      await writeFile(join(f.root, 'unrelated.txt'), 'No authority.')
      await expect.poll(() => lease.current()).toBe(false)
      authorization = access.acquire(f.root).then((result) => { completed = true; return result })
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      expect(completed).toBe(false)
      release()
      await update
      expect((await authorization).targets).toEqual([])
    } finally { release(); await sync; await update; await authorization }
  }, 10000)

  it('retries instead of reporting a busy store when a read-only lock closes during input validation', async () => {
    const f = await fixture()
    const access = new AgentHostAuthorization(f.profile, async () => f.target.owner)
    cleanup.push(async () => access.close())
    const lease = await access.acquire(f.root)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const authorize = f.trust.authorize
    f.trust.authorize = async (record) => { entered(); await gate; return authorize(record) }
    const sync = f.store.read()
    await started
    try {
      await writeFile(join(f.root, 'unrelated.txt'), 'No authority.')
      await expect.poll(() => lease.current()).toBe(false)
      const original = inputChecks.authorizationInputs
      const inputs = vi.spyOn(inputChecks, 'authorizationInputs').mockImplementationOnce(async (...args) => {
        expect(args[3]).toBeDefined()
        release()
        await sync
        return original(...args)
      })
      expect((await access.acquire(f.root)).targets).toEqual([f.target])
      expect(inputs).toHaveBeenCalled()
    } finally { release(); await sync }
  }, 10000)

  it('reuses fully verified configuration snapshots across unchanged reads without extending trust or file validity', async () => {
    const f = await fixture({ count: 32 })
    const before = await f.store.read()
    await f.store.read()
    f.authorize.mockClear()
    const start = performance.now()
    const cached = await f.store.read()
    expect(cached).toEqual(before)
    expect(f.authorize).not.toHaveBeenCalled()
    expect(performance.now() - start).toBeLessThan(1000)
    cached.document.bindings = {}
    expect((await f.store.read()).document.bindings).toEqual(before.document.bindings)
    f.deny()
    expect((await f.store.read()).document.bindings).toEqual({})
    f.allow()
    await f.store.read()
    const path = join(f.recordsRoot, recordPath(f.records[0]))
    const info = await stat(path)
    const bytes = await readFile(path, 'utf8')
    await writeFile(path, bytes.replace('T-0001', 'T-0002'))
    await utimes(path, info.atime, info.mtime)
    await expect(f.store.read()).rejects.toThrow()
  }, 10000)

  it('keeps verified authorization inputs reusable after an unchanged full read', async () => {
    const f = await fixture()
    const initial = await readRepositorySessionLinksForAuthorization(f.root)
    await f.store.read()
    f.read.mockClear()
    f.authorize.mockClear()
    expect(await readRepositorySessionLinksForAuthorization(f.root)).toEqual(initial)
    expect(f.read).not.toHaveBeenCalled()
    expect(f.authorize).not.toHaveBeenCalled()
  })

  it('reuses one verified snapshot for status, pending records and exports without re-verifying each record', async () => {
    const f = await fixture({ count: 32 })
    const before = await f.store.read()
    f.authorize.mockClear()
    const status = await f.store.status()
    const pending = await f.store.getPendingRecords()
    const files = await f.store.exportRecords()
    expect(status.revision).toBe(before.revision)
    expect(status.pendingOperationIds).toEqual(before.pendingOperationIds)
    expect(pending.map((record) => record.operationId)).toEqual(before.pendingOperationIds)
    expect(files).toHaveLength(before.records.length)
    expect(f.authorize).not.toHaveBeenCalled()
    await f.store.writeBinding('T-0001', null, before.revision)
    const changed = await f.store.read()
    expect(changed.pendingOperationIds).toHaveLength(1)
    expect((await f.store.getPendingRecords()).map((record) => record.operationId)).toEqual(changed.pendingOperationIds)
    f.deny()
    await expect(f.store.exportRecords()).rejects.toMatchObject({ code: 'blocked-export' })
  })

  it('reuses stable trust across days and rechecks changed trust policy even with unchanged files', async () => {
    const f = await fixture()
    const peer = immutableRecordSigner(2)
    let now = Date.parse('2026-09-24T10:00:00.000Z')
    f.trust.now = () => now
    f.trust.trustedKey = (actor) => [f.author, peer].find((item) => item.actor.deviceId === actor.deviceId)?.publicKey
    const devices = await Promise.all([f.author, peer].map((author) => createRecord({
      workspaceId: f.workspaceId, actor: author.actor, kind: 'device', createdAt: new Date(now).toISOString(),
      payload: { action: 'publish', deviceId: author.actor.deviceId, identity: {
        username: 'Fixture-user', machineName: `Pinned-device-${author.actor.deviceId.at(-1)}`, clientPublicKey: author.publicKey, hostPublicKey: author.publicKey,
        clientKeyId: author.actor.keyId, hostKeyId: author.actor.keyId,
      }, routes: [{ kind: 'dev-tunnel', tunnelId: 'fixture-route.use', sshPort: 2200, controlPort: 2201 }] },
    }, author.sign)))
    const grant = await createRecord({ workspaceId: f.workspaceId, actor: f.author.actor, kind: 'invitation', createdAt: new Date(now).toISOString(),
      payload: { action: 'grant', issuerId: f.author.actor.deviceId, recipientId: peer.actor.deviceId, grantId: randomUUID(),
        issuerIdentityRef: devices[0].operationId, recipientIdentityRef: devices[1].operationId, capability: 'ah-link',
        issuedAt: new Date(now).toISOString(), lifetime: 'until-revoked',
        routeRef: { identityRef: devices[0].operationId, routeIndex: 0 },
      } }, f.author.sign)
    for (const record of [...devices, grant]) await appendRecord(f.recordsRoot, record)
    await f.store.read()
    await f.store.read()
    f.authorize.mockClear()
    expect(Object.values((await f.store.read()).resolution.invitations)).toEqual([grant])
    expect(f.authorize).not.toHaveBeenCalled()
    now += 365 * 86400000
    expect(Object.values((await f.store.read()).resolution.invitations)).toEqual([grant])
    expect(f.authorize).not.toHaveBeenCalled()
    f.trust.authorize = () => false
    expect((await f.store.read()).resolution.blocked).toBe(true)
  })

  it('exports nested timings that separate queued authorization from record resolution without private data', async () => {
    const f = await fixture()
    await recordLocalLink(f.profile, f.root, 'T-0001', { provider: 'agent-host', ...f.target }, f.target.owner)
    const access = new AgentHostAuthorization(f.profile, async () => f.target.owner)
    cleanup.push(async () => access.close())
    await startAgentHostDiagnostics(f.profile)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const before = await f.store.read()
    const update = f.store.writeBinding('T-0001', null, before.revision, async () => { entered(); await gate })
    await started
    const authorizing = access.acquire(f.root)
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      release()
      await update
      expect((await authorizing).targets).toEqual([])
      const capture = await captureAgentHostDiagnostics(f.profile, {}, new AbortController().signal)
      expect(capture.truncated).toBe(false)
      const text = capture.jsonl.toString('utf8')
      for (const secret of [f.root, f.profile, f.workspaceId, f.target.sessionId, f.author.publicKey]) expect(text).not.toContain(secret)
      const events = text.trim().split('\n').map((line) => JSON.parse(line) as { event: string; step: string; status: string; elapsedMs?: number; traceId?: string; parentTraceId?: string; scopeHash?: string })
      for (const step of ['binding', 'identity', 'receipts']) expect(events).toContainEqual(expect.objectContaining({ event: 'authorization.acquire', step, status: 'ok', scopeHash: expect.stringMatching(/^[a-f0-9]{16}$/) }))
      for (const step of ['inputs', 'records', 'resolution']) expect(events).toContainEqual(expect.objectContaining({ event: 'configuration.snapshot', step, status: 'ok' }))
      const queue = events.find((event) => event.event === 'authorization.store' && event.step === 'queue' && event.status === 'ok' && event.elapsedMs! >= 35)
      expect(queue).toBeDefined()
      expect(queue?.parentTraceId).toMatch(/^[0-9a-f-]{36}$/)
      expect(events.some((event) => event.traceId === queue?.parentTraceId)).toBe(true)
    } finally { release(); await update; await authorizing; await stopAgentHostDiagnostics() }
  }, 10000)

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
    f.trust.trustedKey = () => f.author.publicKey
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
    f.trust.trustedKey = () => f.author.publicKey
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
    f.trust.trustedKey = () => f.author.publicKey
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
    f.trust.trustedKey = () => f.author.publicKey
    let writes = 0
    f.read.mockImplementation(async () => {
      const snapshot = await f.originalRead()
      const state = join(f.stateDirectory, 'store.json')
      await writeFile(state, `${(await readFile(state, 'utf8')).trimEnd()}${' '.repeat(++writes)}\n`)
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

  it('answers remote heartbeats while a status read holds the configuration lock and the access lease needs refreshing', async () => {
    const f = await fixture({ count: 32 })
    const native = await startAgentHostFixture()
    const target = { ...f.target, sessionId: native.sessionId, chatId: native.chatId }
    const before = await f.store.read()
    await f.store.writeBinding('T-0001', { provider: 'agent-host', ...target }, before.revision)
    await recordLocalLink(f.profile, f.root, 'T-0001', { provider: 'agent-host', ...target }, target.owner)
    const connection = new AgentHostConnection(target, f.profile, (signal) => connectLocalAgentHost(native.endpoint, signal))
    const access = new AgentHostAuthorization(f.profile, async () => target.owner)
    const acquire = vi.spyOn(access, 'acquire')
    const host = new VSCodeDeviceHost(f.profile, { available: () => true, encrypt: (text) => Buffer.from(text), decrypt: (bytes) => bytes.toString() })
    host.setAgentHostAccess({ connection: async () => connection } as unknown as AgentHostRegistry,
      (root) => locallyLinkedAgentHostSessions(f.profile, root, target.owner), undefined, (root) => access.acquire(root))
    const pair = await host.pair({ clientId: randomUUID(), machineName: 'Heartbeat client', username: 'Tester' }, newSshKeyPair().publicKey)
    await host.setWorkspace(pair.id, f.root, true)
    const port = await host.start()
    const abort = new AbortController()
    const client = new AhpClient(await connectAgentHostWebSocket(
      `ws://127.0.0.1:${port}/device/agent-host?target=${Buffer.from(JSON.stringify(target)).toString('base64url')}`,
      { headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${pair.token}` } }, abort.signal), { requestTimeoutMs: 1000 })
    client.connect()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    let background: Promise<unknown> | undefined
    try {
      await client.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0', '1.0.0'] })
      const lease = await access.acquire(f.root)
      const authorize = f.trust.authorize
      f.trust.authorize = async (record) => { entered(); await gate; return authorize(record) }
      background = f.store.status()
      await started
      await writeFile(join(f.root, 'unrelated-code.txt'), 'A code edit does not change session access.')
      await expect.poll(() => lease.current()).toBe(false)
      f.read.mockClear()
      acquire.mockClear()
      const begin = performance.now()
      await client.ping()
      const refreshed = performance.now() - begin
      expect(refreshed).toBeLessThan(1000)
      expect(acquire).toHaveBeenCalledOnce()
      acquire.mockClear()
      const warm = performance.now()
      for (let index = 0; index < 20; index++) await client.ping()
      const elapsedMs = performance.now() - warm
      expect(elapsedMs).toBeLessThan(250)
      expect(acquire).not.toHaveBeenCalled()
      expect(f.read).not.toHaveBeenCalled()
      expect(native.dispatches).toHaveLength(0)
      console.log(JSON.stringify({ refreshedGatewayPingMs: Math.round(refreshed), warmGatewayPings: 20, elapsedMs: Math.round(elapsedMs), extraFullReads: f.read.mock.calls.length }))
      await recordLocalLink(f.profile, f.root, 'T-0001', undefined, target.owner)
      await expect(client.ping()).rejects.toThrow()
      expect(native.dispatches).toHaveLength(0)
    } finally {
      release()
      await background
      abort.abort()
      await client.shutdown()
      await host.close()
      access.close()
      await connection.close()
      await native.close()
    }
  }, 20000)

  it('opens the first remote connection with 351 records before queued background queries finish', async () => {
    const f = await fixture({ count: 351 })
    const native = await startAgentHostFixture()
    const target = { ...f.target, sessionId: native.sessionId, chatId: native.chatId }
    const before = await f.store.read()
    await f.store.writeBinding('T-0001', { provider: 'agent-host', ...target }, before.revision)
    await recordLocalLink(f.profile, f.root, 'T-0001', { provider: 'agent-host', ...target }, target.owner)
    await f.store.read()
    f.read.mockClear()
    const access = new AgentHostAuthorization(f.profile, async () => target.owner)
    const connection = new AgentHostConnection(target, f.profile, (signal) => connectLocalAgentHost(native.endpoint, signal))
    const host = new VSCodeDeviceHost(f.profile, { available: () => true, encrypt: (text) => Buffer.from(text), decrypt: (bytes) => bytes.toString() })
    host.setAgentHostAccess({ connection: async () => connection } as unknown as AgentHostRegistry,
      (root) => locallyLinkedAgentHostSessions(f.profile, root, target.owner), undefined, (root) => access.acquire(root))
    const pair = await host.pair({ clientId: randomUUID(), machineName: 'First connection', username: 'Tester' }, newSshKeyPair().publicKey)
    await host.setWorkspace(pair.id, f.root, true)
    const port = await host.start()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const readRecords = inputChecks.authorizationInputs
    const diskRead = vi.spyOn(inputChecks, 'authorizationInputs').mockImplementationOnce(async (...args) => {
      entered()
      await gate
      return readRecords(...args)
    })
    let backgroundFinished = false
    const background = f.store.status().then(() => { backgroundFinished = true })
    await started
    const queued = [f.store.status(), f.store.getPendingRecords(), f.store.exportRecords()]
    const abort = new AbortController()
    let client: AhpClient | undefined
    try {
      const start = performance.now()
      client = new AhpClient(await connectAgentHostWebSocket(
        `ws://127.0.0.1:${port}/device/agent-host?target=${Buffer.from(JSON.stringify(target)).toString('base64url')}`,
        { headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${pair.token}` } }, abort.signal), { requestTimeoutMs: 1000 })
      client.connect()
      await client.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0', '1.0.0'] })
      await client.subscribe(target.chatId)
      await client.ping()
      const elapsedMs = performance.now() - start
      expect(elapsedMs).toBeLessThan(1000)
      expect(backgroundFinished).toBe(false)
      expect(f.read).not.toHaveBeenCalled()
      expect(native.dispatches).toHaveLength(0)
      console.log(JSON.stringify({ coldGatewayRecords: 351, connectionAndPingMs: Math.round(elapsedMs), permissionFullReads: f.read.mock.calls.length }))
      await host.revoke(pair.id)
      await expect(client.ping()).rejects.toThrow()
      expect(native.dispatches).toHaveLength(0)
    } finally {
      release()
      await Promise.all([background, ...queued])
      diskRead.mockRestore()
      abort.abort()
      await client?.shutdown()
      await host.close()
      access.close()
      await connection.close()
      await native.close()
    }
  }, 30000)
})
