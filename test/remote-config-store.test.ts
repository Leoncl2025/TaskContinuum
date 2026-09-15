import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto'
import { link, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionLink } from '../src/shared/sessionBindings'
import { remoteConfigFormat, type BindingChangedNotification, type DevicePayload, type RemoteRecord, type RemoteSettingChanges } from '../src/shared/remoteConfig'
import {
  migrateRepositorySessionLinks, readLegacyRepositorySessionLinks, readRepositorySessionLinks,
  registerRepositorySessionLinksBackend, updateRepositoryAgentHostLink, updateRepositorySessionLink,
  writeRepositorySessionLinks,
} from '../src/main/repositorySessionLinks'
import { locallyLinkedAgentHostSessions, recordLocalLink } from '../src/main/linkedSessionPolicy'
import { sshFingerprint } from '../src/main/devTunnel/protocol'
import { appendRecord, createRecord, readRecords, recordPath, serializeRecord, type RecordInput, type RecordTrust } from '../src/main/remoteConfig/records'
import { BindingOverlay } from '../src/main/remoteConfig/overlay'
import { legacyMigrationNonce, RemoteConfigStore, type RemoteConfigStoreOptions } from '../src/main/remoteConfig/store'

const workspaceId = '10000000-0000-4000-8000-000000000001'
function signer(index: number) {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, index)]), format: 'der', type: 'pkcs8' })
  const raw = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)
  const publicKey = `ssh-ed25519 ${Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020', 'hex'), raw]).toString('base64')}`
  return {
    actor: { deviceId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, keyId: sshFingerprint(publicKey) },
    publicKey, sign: (bytes: Buffer) => sign(null, bytes, key),
  }
}
const a = signer(1)
const b = signer(2)
const trust: RecordTrust = {
  workspaceId,
  trustedKey: (actor) => [a, b].find((device) => device.actor.deviceId === actor.deviceId)?.publicKey,
  authorize: () => true,
}
function target(session = 'one', owner = b) {
  return { owner: { clientId: owner.actor.deviceId, machineName: `machine-${owner.actor.deviceId.at(-1)}` }, hostId: 'host-main', sessionId: `copilotcli:/${session}`, chatId: `ahp-chat:/${session}` }
}
function binding(session = 'one', owner = b): SessionLink { return { provider: 'agent-host', ...target(session, owner) } }
async function operation(input: Omit<RecordInput, 'actor' | 'workspaceId'>, author = a): Promise<RemoteRecord> {
  return createRecord({ ...input, actor: author.actor, workspaceId } as RecordInput, author.sign)
}
function notice(record: RemoteRecord, dependencies: RemoteRecord[] = []): BindingChangedNotification {
  if (record.kind !== 'binding') throw new Error('Test requires a binding operation.')
  return { schemaVersion: 1, kind: 'binding.changed', workspaceId, recipientId: b.actor.deviceId, operation: record, dependencies }
}
async function descriptor(root: string): Promise<string> {
  const directory = join(root, '.taskcontinuum')
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'workspace.json')
  await writeFile(file, JSON.stringify({ schemaVersion: 1, kind: 'taskcontinuum-workspace', workspaceId, remoteConfigFormat }))
  return file
}
const directories: string[] = []
const stores: RemoteConfigStore[] = []
const disposers: (() => void)[] = []
async function fixture(author = a, configure?: (paths: Omit<RemoteConfigStoreOptions, 'actor' | 'sign' | 'trust'>) => Partial<RemoteConfigStoreOptions>) {
  const home = join(process.cwd(), 'artifacts', `remote-store-${randomUUID()}`)
  directories.push(home)
  const paths = { workspaceRoot: join(home, 'workspace'), recordsRoot: join(home, 'replica'), outboxRoot: join(home, 'outbox'), stateDirectory: join(home, 'data'), workspaceId }
  await Promise.all([home, ...Object.values(paths).filter((value) => value !== workspaceId)].map((path) => mkdir(path, { recursive: true })))
  const changed = vi.fn()
  const onError = vi.fn()
  const options: RemoteConfigStoreOptions = { ...paths, actor: author.actor, sign: author.sign, trust, onLocalChange: changed, onError, ...configure?.(paths) }
  const store = new RemoteConfigStore(options)
  stores.push(store)
  return { ...paths, home, store, changed, onError, options }
}
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose()
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('effective repository binding backend and durable immutable store', () => {
  it('never falls back to archival bindings when an immutable descriptor exists without a ready backend', async () => {
    const f = await fixture()
    const legacy = await updateRepositorySessionLink(f.workspaceRoot, 'T-0001', 'archived', null)
    const file = await descriptor(f.workspaceRoot)
    const contents = await readFile(file, 'utf8')
    await expect(readRepositorySessionLinks(f.workspaceRoot)).rejects.toThrow('backend is not ready')
    await expect(updateRepositorySessionLink(f.workspaceRoot, 'T-0002', 'stale-write', legacy.revision)).rejects.toThrow('archival only')
    expect(await readLegacyRepositorySessionLinks(f.workspaceRoot)).toEqual(legacy)
    const initialized = await f.store.initialize(legacy.revision)
    const dispose = await registerRepositorySessionLinksBackend(f.workspaceRoot, f.store)
    disposers.push(dispose)
    await f.store.writeBinding('T-0001', binding('current'), initialized.revision)
    f.changed.mockClear()
    expect((await readRepositorySessionLinks(f.workspaceRoot)).document.bindings['T-0001']).toEqual(binding('current'))
    expect((await readLegacyRepositorySessionLinks(f.workspaceRoot)).document.bindings['T-0001']).toEqual(legacy.document.bindings['T-0001'])
    expect(f.changed).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe(contents)
    dispose()
    await expect(readRepositorySessionLinks(f.workspaceRoot)).rejects.toThrow('backend is not ready')
  })

  it('rejects invalid, unknown-format, oversized and linked descriptors without writing the legacy archive', async () => {
    const f = await fixture()
    const legacy = await updateRepositorySessionLink(f.workspaceRoot, 'T-0001', 'archived', null)
    const file = await descriptor(f.workspaceRoot)
    for (const content of ['{', JSON.stringify({ remoteConfigFormat: 'future-unknown-format' }), 'x'.repeat(4097)]) {
      await writeFile(file, content)
      await expect(readRepositorySessionLinks(f.workspaceRoot)).rejects.toThrow()
      await expect(updateRepositorySessionLink(f.workspaceRoot, 'T-0001', null, legacy.revision)).rejects.toThrow()
      expect(await readLegacyRepositorySessionLinks(f.workspaceRoot)).toEqual(legacy)
    }
    await descriptor(f.workspaceRoot)
    await link(file, join(f.home, 'linked-workspace.json'))
    await expect(readRepositorySessionLinks(f.workspaceRoot)).rejects.toThrow('hard links')
    expect(await readLegacyRepositorySessionLinks(f.workspaceRoot)).toEqual(legacy)
  })

  it('aborts an in-progress legacy edit if immutable enrollment appears during its transform', async () => {
    const f = await fixture()
    const legacy = await updateRepositorySessionLink(f.workspaceRoot, 'T-0001', 'original', null)
    await expect(writeRepositorySessionLinks(f.workspaceRoot, legacy.revision, async (document) => {
      await descriptor(f.workspaceRoot)
      return { ...document, bindings: { 'T-0001': binding('new') } }
    })).rejects.toThrow('backend is not ready')
    expect(await readLegacyRepositorySessionLinks(f.workspaceRoot)).toEqual(legacy)
    expect(await readdir(join(f.workspaceRoot, '.taskcontinuum'))).not.toContain('session-bindings.lock')
  })

  it('keeps the legacy baseline until explicit initialization and never rewrites its archive', async () => {
    const f = await fixture()
    const legacy = await migrateRepositorySessionLinks(f.workspaceRoot, { 'T-0001': { provider: 'github-copilot', sessionId: 'historical' } })
    const raw = await readFile(join(f.workspaceRoot, '.taskcontinuum', 'session-bindings.json'), 'utf8')
    disposers.push(await registerRepositorySessionLinksBackend(f.workspaceRoot, f.store))
    expect(await readRepositorySessionLinks(f.workspaceRoot)).toMatchObject(legacy)
    await expect(writeRepositorySessionLinks(f.workspaceRoot, legacy.revision, (document) => document)).rejects.toThrow('initialize')
    expect(await readRecords(f.outboxRoot)).toEqual([])
    const migrated = await f.store.initialize(legacy.revision)
    expect(migrated.initialized).toBe(true)
    expect(migrated.document).toEqual(legacy.document)
    expect(migrated.revision).not.toBe(legacy.revision)
    const records = await readRecords(f.outboxRoot)
    expect(records).toHaveLength(1)
    expect(records[0].nonce).toBe(legacyMigrationNonce(workspaceId, legacy.document, 'T-0001'))
    expect(await readFile(join(f.workspaceRoot, '.taskcontinuum', 'session-bindings.json'), 'utf8')).toBe(raw)
    expect(f.changed).toHaveBeenCalledTimes(1)
    await f.store.initialize()
    expect(await readRecords(f.outboxRoot)).toEqual(records)
    expect(f.changed).toHaveBeenCalledTimes(1)
    await writeFile(join(f.workspaceRoot, '.taskcontinuum', 'session-bindings.json'), raw.replace('historical', 'old-client-edit'))
    await expect(f.store.read()).rejects.toThrow('Old-client writes')
  })

  it('deduplicates deterministic migration retries and never resurrects canonical tombstones', async () => {
    const first = await fixture(a)
    const second = await fixture(a)
    const baseline = { 'T-0001': binding('old'), 'T-0002': binding('two') }
    const one = await migrateRepositorySessionLinks(first.workspaceRoot, baseline)
    const two = await migrateRepositorySessionLinks(second.workspaceRoot, baseline)
    await first.store.initialize(one.revision)
    await second.store.initialize(two.revision)
    expect(await readRecords(second.outboxRoot)).toEqual(await readRecords(first.outboxRoot))
    const records = await readRecords(first.outboxRoot)
    const prior = records.find((record) => record.kind === 'binding' && record.payload.taskId === 'T-0001')!
    const deleted = await operation({ kind: 'binding', payload: { action: 'delete', taskId: 'T-0001' }, parents: [prior.operationId] })
    const third = await fixture(b)
    await migrateRepositorySessionLinks(third.workspaceRoot, baseline)
    for (const record of [...records, deleted]) await appendRecord(third.recordsRoot, record)
    const snapshot = await third.store.initialize()
    expect(snapshot.document.bindings).toEqual({ 'T-0002': binding('two') })
    expect(await readRecords(third.outboxRoot)).toEqual([])
  })

  it('registers by canonical root, routes existing callers through one store, and leaves other roots unchanged', async () => {
    const enrolled = await fixture()
    const other = await fixture()
    await enrolled.store.initialize()
    const dispose = await registerRepositorySessionLinksBackend(enrolled.workspaceRoot, enrolled.store)
    disposers.push(dispose)
    await expect(registerRepositorySessionLinksBackend(enrolled.workspaceRoot, enrolled.store)).rejects.toThrow('already')
    const before = await readRepositorySessionLinks(enrolled.workspaceRoot)
    expect(Object.keys(before).sort()).toEqual(['document', 'revision'])
    const saved = await updateRepositoryAgentHostLink(enrolled.workspaceRoot, 'T-0001', target(), before.revision)
    expect(saved).not.toHaveProperty('records')
    const alias = process.platform === 'win32' ? enrolled.workspaceRoot.toUpperCase() : enrolled.workspaceRoot
    expect((await readRepositorySessionLinks(alias)).document).toEqual(saved.document)
    expect((await readLegacyRepositorySessionLinks(enrolled.workspaceRoot)).document.bindings).toEqual({})
    const legacy = await updateRepositorySessionLink(other.workspaceRoot, 'T-0001', 'legacy-native', null)
    expect((await readRepositorySessionLinks(other.workspaceRoot)).document).toEqual(legacy.document)
    dispose()
    expect((await readRepositorySessionLinks(enrolled.workspaceRoot)).document.bindings).toEqual({})
    disposers.push(await registerRepositorySessionLinksBackend(enrolled.workspaceRoot, enrolled.store))
    dispose()
    expect((await readRepositorySessionLinks(enrolled.workspaceRoot)).document.bindings['T-0001']).toEqual(binding())
  })

  it('retains original causal heads and fails stale revisions instead of rebasing a semantic edit', async () => {
    const f = await fixture()
    const initial = await f.store.initialize()
    const first = await f.store.update(initial.revision, () => ({ schemaVersion: 1, bindings: { 'T-0001': binding('old') } }))
    const original = first.records[0]
    const remote = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: binding('remote') }, parents: [original.operationId] }, b)
    await appendRecord(f.recordsRoot, original)
    const fetched = await f.store.read()
    await expect(f.store.update(fetched.revision, async (document) => {
      await appendRecord(f.recordsRoot, remote)
      return { ...document, bindings: { 'T-0001': binding('attempted') } }
    })).rejects.toThrow('changed on disk')
    expect(await readRecords(f.outboxRoot)).toEqual([original])
    const latest = await f.store.read()
    const saved = await f.store.update(latest.revision, (document) => ({ ...document, bindings: { 'T-0001': binding('resolved') } }))
    const last = saved.records.find((record) => record.kind === 'binding' && record.payload.action === 'set' && record.payload.target.sessionId === 'copilotcli:/resolved')!
    expect(last.parents).toEqual([remote.operationId])
    expect(original.parents).toEqual([])
  })

  it('writes an explicit conflict tombstone even when the effective document transform would be a no-op', async () => {
    const f = await fixture()
    await f.store.initialize()
    const first = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: binding('one') } })
    const second = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: binding('two') } }, b)
    for (const record of [first, second]) await appendRecord(f.recordsRoot, record)
    const before = await f.store.read()
    expect(before.document.bindings).toEqual({})
    expect((await f.store.status()).conflicts).toMatchObject([{ entityKey: 'binding:T-0001', state: 'needs-resolution' }])
    await f.store.update(before.revision, (document) => document)
    expect(await f.store.getPendingRecords()).toEqual([])
    const deleted = await f.store.writeBinding('T-0001', null, before.revision)
    const tombstone = deleted.records.find((record) => record.kind === 'binding' && record.payload.action === 'delete')!
    expect(tombstone.parents).toEqual([first.operationId, second.operationId].sort())
    expect(tombstone.actor).toEqual(a.actor)
    expect(deleted.records).toContainEqual(first)
    expect(deleted.records).toContainEqual(second)
    expect(deleted.resolution.entities['binding:T-0001'].state).toBe('deleted')
    expect((await f.store.status()).conflicts).toEqual([])
    await f.store.writeBinding('T-0001', null, deleted.revision)
    expect(await f.store.getPendingRecords()).toHaveLength(1)
    expect(f.changed).toHaveBeenCalledTimes(1)
  })

  it('routes existing explicit detach callers through the backend tombstone operation', async () => {
    const f = await fixture()
    await f.store.initialize()
    disposers.push(await registerRepositorySessionLinksBackend(f.workspaceRoot, f.store))
    const first = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: binding('one') } })
    const second = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: binding('two') } }, b)
    for (const record of [first, second]) await appendRecord(f.recordsRoot, record)
    const before = await readRepositorySessionLinks(f.workspaceRoot)
    expect(before.document.bindings).toEqual({})
    await updateRepositorySessionLink(f.workspaceRoot, 'T-0001', null, before.revision)
    const snapshot = await f.store.read()
    expect(snapshot.resolution.entities['binding:T-0001'].state).toBe('deleted')
    expect((await f.store.getPendingRecords())[0].parents).toEqual([first.operationId, second.operationId].sort())
    const authorize = vi.fn(async () => { throw new Error('The local grant was revoked') })
    await expect(f.store.writeBinding('T-0002', null, snapshot.revision, authorize)).rejects.toThrow('revoked')
    expect(await f.store.getPendingRecords()).toHaveLength(1)
  })

  it('checks beforeWrite at the durable boundary, forbids uniqueness violations and never transfers ownership', async () => {
    const f = await fixture()
    const initial = await f.store.initialize()
    await expect(f.store.update(initial.revision, () => ({ schemaVersion: 1, bindings: { 'T-0001': binding() } }), async () => { throw new Error('Authorization changed') })).rejects.toThrow('Authorization changed')
    expect(await readRecords(f.outboxRoot)).toEqual([])
    const saved = await f.store.update(initial.revision, () => ({ schemaVersion: 1, bindings: { 'T-0001': binding() } }))
    await expect(f.store.update(saved.revision, (document) => ({ ...document, bindings: { ...document.bindings, 'T-0002': binding() } }))).rejects.toThrow('only one task')
    await expect(f.store.update(saved.revision, (document) => ({ ...document, bindings: { 'T-0001': binding('one', a) } }))).rejects.toThrow('ownership')
    const beforeWrite = vi.fn(async () => undefined)
    await f.store.update(saved.revision, (document) => ({ ...document, bindings: { ...document.bindings, 'T-0002': binding('two') } }), beforeWrite)
    expect(beforeWrite).toHaveBeenCalledTimes(2)
  })

  it('notifies Git and SSH independently after durable writes, outside the mutation lock', async () => {
    const f = await fixture()
    const initial = await f.store.initialize()
    const seen: string[] = []
    let releaseGit!: () => void
    const git = new Promise<void>((resolve) => { releaseGit = resolve })
    const received = new Promise<void>((resolve) => {
      f.store.subscribeLocalChanges(async (records) => {
        expect((await readRecords(f.outboxRoot))[0]).toEqual(records[0])
        seen.push('git')
        await git
      })
      f.store.subscribeLocalChanges(async () => {
        expect((await f.store.read()).document.bindings['T-0001']).toEqual(binding())
        seen.push('ssh')
        resolve()
      })
    })
    const saving = f.store.update(initial.revision, () => ({ schemaVersion: 1, bindings: { 'T-0001': binding() } }))
    await received
    expect(seen.sort()).toEqual(['git', 'ssh'])
    releaseGit()
    await saving
    f.store.subscribeLocalChanges(() => { throw new Error('SSH unavailable') })
    const before = await f.store.read()
    await f.store.update(before.revision, (document) => ({ ...document, bindings: { ...document.bindings, 'T-0002': binding('two') } }))
    expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'SSH unavailable' }))
    expect((await f.store.read()).document.bindings['T-0002']).toEqual(binding('two'))
  })

  it('recovers an interrupted durable batch with the original signed operations instead of exposing partial success', async () => {
    const f = await fixture()
    await f.store.initialize()
    const first = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: binding() } })
    const second = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0002', target: binding('two') } })
    const state = JSON.parse(await readFile(join(f.stateDirectory, 'store.json'), 'utf8')) as unknown
    const journal = { schemaVersion: 1, workspaceId, operations: [first, second], state }
    await writeFile(join(f.stateDirectory, 'pending-operations.json'), JSON.stringify(journal))
    await appendRecord(f.outboxRoot, first)
    const bindingsDirectory = join(f.outboxRoot, '.taskcontinuum', 'records', 'v1', 'bindings')
    const outside = join(f.home, 'outside')
    await mkdir(bindingsDirectory, { recursive: true })
    await mkdir(outside)
    const obstruction = join(bindingsDirectory, 'T-0002')
    await symlink(outside, obstruction, process.platform === 'win32' ? 'junction' : 'dir')
    expect(journal.operations).toHaveLength(2)
    expect(f.changed).not.toHaveBeenCalled()
    await expect(f.store.read()).rejects.toThrow('filesystem links')
    await rm(obstruction, { recursive: true })
    const recovered = await f.store.read()
    expect(recovered.document.bindings).toEqual({ 'T-0001': binding(), 'T-0002': binding('two') })
    expect(recovered.records.map((record) => record.operationId).sort()).toEqual(journal.operations.map((record) => record.operationId).sort())
    expect(await readdir(f.stateDirectory)).not.toContain('pending-operations.json')
    expect(f.changed).toHaveBeenCalledTimes(1)
  })

  it('detects deleted or mutated accepted canonical history even if the outbox retains the original record', async () => {
    const f = await fixture()
    const before = await f.store.initialize()
    const saved = await f.store.update(before.revision, () => ({ schemaVersion: 1, bindings: { 'T-0001': binding() } }))
    const record = saved.records[0]
    await appendRecord(f.recordsRoot, record)
    await f.store.read()
    await rm(join(f.recordsRoot, recordPath(record)))
    await expect(f.store.read()).rejects.toThrow('removed')
    await appendRecord(f.recordsRoot, record)
    await writeFile(join(f.recordsRoot, recordPath(record)), serializeRecord(record).replace('machine-2', 'machine-X'))
    await expect(f.store.read()).rejects.toThrow('hash')
  })

  it('detects a removed pending local operation and permits outbox retirement only after canonical publication', async () => {
    const f = await fixture()
    const before = await f.store.initialize()
    const saved = await f.store.update(before.revision, () => ({ schemaVersion: 1, bindings: { 'T-0001': binding() } }))
    const record = saved.records[0]
    const file = join(f.outboxRoot, recordPath(record))
    await rm(file)
    await expect(f.store.read()).rejects.toThrow('local operation was removed')
    await appendRecord(f.outboxRoot, record)
    await appendRecord(f.recordsRoot, record)
    await f.store.read()
    await rm(file)
    expect((await f.store.read()).document.bindings['T-0001']).toEqual(binding())
  })

  it('applies typed setting diffs with their original revision and suppresses same-value refresh echoes', async () => {
    const f = await fixture()
    const initial = await f.store.initialize()
    const saved = await f.store.updateSettings(initial.revision, { autoLink: false, connectTimeoutMs: 5000 })
    const count = saved.records.length
    expect(count).toBe(2)
    expect(saved.resolution.settings.workspace).toEqual({ autoLink: false, connectTimeoutMs: 5000 })
    const noChange = await f.store.updateSettings(saved.revision, { autoLink: false })
    expect(noChange.records).toHaveLength(count)
    expect(f.changed).toHaveBeenCalledTimes(1)
    await expect(f.store.updateSettings(initial.revision, { autoLink: true })).rejects.toThrow('changed')
    await expect(f.store.updateSettings(saved.revision, { pollIntervalMs: 10 } as unknown as RemoteSettingChanges)).rejects.toThrow('typed')
    await expect(f.store.updateSettings(saved.revision, { connectTimeoutMs: 500 })).rejects.toThrow()
    const removed = await f.store.updateSettings(saved.revision, { connectTimeoutMs: null })
    expect(removed.resolution.settings.workspace).toEqual({ autoLink: false })
  })

  it('allows identity route refresh and grant renewal without treating stale grants as corrupt history', async () => {
    const f = await fixture()
    await f.store.initialize()
    const payload = (device: typeof a) => ({
      action: 'publish' as const, deviceId: device.actor.deviceId,
      identity: { username: '工程师 Jane', machineName: 'machine', clientPublicKey: device.publicKey, hostPublicKey: device.publicKey, clientKeyId: device.actor.keyId, hostKeyId: device.actor.keyId },
      routes: [{ kind: 'dev-tunnel' as const, tunnelId: 'test-route.use', sshPort: 2200, controlPort: 2201 }],
    })
    const withoutUsername: Extract<DevicePayload, { action: 'publish' }> = payload(a)
    delete withoutUsername.identity.username
    await expect(f.store.append('device', withoutUsername)).rejects.toThrow('username')
    const withoutControlPort: Extract<DevicePayload, { action: 'publish' }> = payload(a)
    delete withoutControlPort.routes[0].controlPort
    await expect(f.store.append('device', withoutControlPort)).rejects.toThrow('controlPort')
    expect(await readRecords(f.outboxRoot)).toEqual([])
    const own = await f.store.append('device', payload(a))
    const peer = await operation({ kind: 'device', payload: payload(b) }, b)
    await appendRecord(f.recordsRoot, peer)
    const issued = Date.now()
    const grantPayload = {
      action: 'grant' as const, issuerId: a.actor.deviceId, recipientId: b.actor.deviceId, grantId: randomUUID(),
      issuerIdentityRef: own.operationId, recipientIdentityRef: peer.operationId,
      capability: 'ah-link' as const, issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + 3600000).toISOString(),
      routeRef: { identityRef: own.operationId, routeIndex: 0 },
    }
    const grant = await f.store.append('invitation', grantPayload)
    const refreshed = await f.store.append('device', { ...payload(a), routes: [{ ...payload(a).routes[0], controlPort: 2202 }] })
    const stale = await f.store.read()
    expect(stale.resolution.invitations).toEqual({})
    expect(stale.resolution.blocked).toBe(false)
    const renewed = await f.store.append('invitation', { ...grantPayload, grantId: randomUUID(), issuerIdentityRef: refreshed.operationId, routeRef: { identityRef: refreshed.operationId, routeIndex: 0 } })
    expect(renewed.parents).toEqual([grant.operationId])
    expect(Object.values((await f.store.read()).resolution.invitations)).toEqual([renewed])
    await f.store.append('device', { action: 'remove', deviceId: a.actor.deviceId })
    await expect(f.store.append('device', payload(a))).rejects.toThrow('reenrollment')
    await expect(f.store.append('binding', { action: 'set', taskId: 'T-0002', target: { provider: 'github-copilot', sessionId: 'legacy-new' } })).rejects.toThrow('Agent Host')
  })

  it('exposes settings, public exports, pending operations and exact synced reconciliation without echoing overlays', async () => {
    let overlay!: BindingOverlay
    const f = await fixture(b, (paths) => {
      overlay = new BindingOverlay({ workspaceId, recipientId: b.actor.deviceId, trust, markerFile: join(paths.stateDirectory, 'pending-overlay.json') })
      return { overlay }
    })
    const initial = await f.store.initialize()
    expect(await f.store.getRecords()).toEqual([])
    expect(await f.store.exportRecords()).toEqual([])
    expect(await f.store.getSettings()).toMatchObject({ revision: initial.revision, values: { autoLink: true, tunnelEnabled: true, connectTimeoutMs: 45000 } })
    const saved = await f.store.updateSettings(initial.revision, { autoLink: false })
    const pending = await f.store.getPendingRecords()
    expect(pending).toHaveLength(1)
    expect(await f.store.exportRecords(true)).toEqual([{ path: recordPath(pending[0]).replaceAll('\\', '/'), content: serializeRecord(pending[0]) }])
    expect(await f.store.status()).toMatchObject({ pendingOperationIds: [pending[0].operationId], conflicts: [], blocked: false })
    expect((await f.store.getSettings()).values.autoLink).toBe(false)
    await appendRecord(f.recordsRoot, pending[0])
    const synced = await f.store.reconcileSynced()
    expect(synced.revision).not.toBe(saved.revision)
    expect(await f.store.getPendingRecords()).toEqual([])
    const received = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: binding('received') } })
    expect((await f.store.receiveOverlay(notice(received), a.actor.deviceId)).result).toBe('provisional')
    expect((await f.store.status()).provisionalTasks).toEqual(['T-0001'])
    expect(await f.store.getRecords()).toEqual(pending)
    expect(await f.store.exportRecords()).toHaveLength(1)
    expect(await f.store.getPendingRecords()).toEqual([])
    await appendRecord(f.recordsRoot, received)
    expect((await f.store.reconcileSynced()).provisional).toEqual([])
    expect(await f.store.getRecords()).toHaveLength(2)
    expect((await f.store.status()).pendingOperationIds).toEqual([])
    expect(f.changed).toHaveBeenCalledTimes(1)
    const forged = await createRecord({ kind: 'binding', workspaceId, actor: a.actor, payload: { action: 'delete', taskId: 'T-0002' } }, () => Buffer.alloc(64))
    await appendRecord(f.recordsRoot, forged)
    await expect(f.store.exportRecords()).rejects.toThrow('unauthorized')
    expect(await f.store.status()).toMatchObject({ blocked: true, conflicts: [{ entityKey: 'binding:T-0002', state: 'blocked' }] })
  })
})

describe('SSH binding overlay and exact canonical reconciliation', () => {
  async function receiving() {
    let time = 0
    const requestSync = vi.fn(async () => undefined)
    const onChange = vi.fn()
    let overlay!: BindingOverlay
    const f = await fixture(b, (paths) => {
      overlay = new BindingOverlay({ workspaceId, recipientId: b.actor.deviceId, trust, markerFile: join(paths.stateDirectory, 'pending-overlay.json'), now: () => time, requestSync, onChange })
      return { overlay }
    })
    await f.store.initialize()
    disposers.push(await registerRepositorySessionLinksBackend(f.workspaceRoot, f.store))
    const base = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: binding('old') } })
    await appendRecord(f.recordsRoot, base)
    const before = await f.store.read()
    const changed = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: binding('new') }, parents: [base.operationId] })
    return { ...f, base, before, change: changed, overlay, requestSync, onChange, advance: (milliseconds: number) => { time += milliseconds } }
  }

  it('uses the same explicit migration policy for canonical and provisional dependency validation', async () => {
    const f = await fixture(b, (paths) => ({
      overlay: new BindingOverlay({ workspaceId, recipientId: b.actor.deviceId, trust, markerFile: join(paths.stateDirectory, 'pending-overlay.json') }),
    }))
    const legacy = await migrateRepositorySessionLinks(f.workspaceRoot, { 'T-0001': { provider: 'github-copilot', sessionId: 'historic-ownerless' } })
    const initialized = await f.store.initialize(legacy.revision)
    const imported = initialized.records[0]
    await appendRecord(f.recordsRoot, imported)
    const changed = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: binding('modern') }, parents: [imported.operationId] })
    expect((await f.store.receiveOverlay(notice(changed, [imported]), a.actor.deviceId)).result).toBe('provisional')
    expect((await f.store.read()).document.bindings['T-0001']).toEqual(binding('modern'))
    expect((await f.store.getRecords()).some((record) => record.operationId === changed.operationId)).toBe(false)
    expect(f.changed).toHaveBeenCalledTimes(1)
  })

  it('routes a received binding before Git arrives and never creates local authorization receipts or an echoed edit', async () => {
    const f = await receiving()
    const owner = target().owner
    await recordLocalLink(f.stateDirectory, f.workspaceRoot, 'T-0001', binding('old'), owner)
    const receiptsFile = join(f.stateDirectory, 'local-session-link-receipts.json')
    const receipts = await readFile(receiptsFile, 'utf8')
    const ack = await f.store.acceptNotification(notice(f.change), a.actor.deviceId)
    expect(ack.result).toBe('provisional')
    const effective = await readRepositorySessionLinks(f.workspaceRoot)
    expect(effective.document.bindings['T-0001']).toEqual(binding('new'))
    expect(effective.revision).not.toBe(f.before.revision)
    expect(await locallyLinkedAgentHostSessions(f.stateDirectory, f.workspaceRoot, owner)).toEqual([])
    expect(await readFile(receiptsFile, 'utf8')).toBe(receipts)
    expect(await readRecords(f.outboxRoot)).toEqual([])
    expect(f.changed).not.toHaveBeenCalled()
    expect(f.requestSync).toHaveBeenCalled()
    await expect(f.store.update(f.before.revision, () => ({ schemaVersion: 1, bindings: {} }))).rejects.toThrow('overlay')
    await expect(f.store.update(effective.revision, () => ({ schemaVersion: 1, bindings: {} }))).rejects.toThrow('closure')
  })

  it('retains a provisional binding when pull precedes push and retires only on the exact canonical operation', async () => {
    const f = await receiving()
    await f.store.acceptNotification(notice(f.change), a.actor.deviceId)
    expect((await f.store.read()).provisional).toEqual(['T-0001'])
    const unrelated = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0002', target: binding('two') } })
    await appendRecord(f.recordsRoot, unrelated)
    const during = await f.store.read()
    expect(during.provisional).toEqual(['T-0001'])
    expect(during.document.bindings['T-0001']).toEqual(binding('new'))
    await appendRecord(f.recordsRoot, f.change)
    const after = await f.store.read()
    expect(after.document.bindings['T-0001']).toEqual(binding('new'))
    expect(after.provisional).toEqual([])
    expect(after.awaitingSync).toEqual([])
    expect(after.revision).not.toBe(during.revision)
    expect((await f.store.acceptNotification(notice(f.change), a.actor.deviceId)).result).toBe('already-synced')
    expect(f.changed).not.toHaveBeenCalled()
  })

  it('deduplicates delivery without extending expiry, hides superseded routing, and resumes only after exact sync', async () => {
    const f = await receiving()
    await f.store.acceptNotification(notice(f.change), a.actor.deviceId)
    f.advance(59000)
    expect((await f.store.acceptNotification(notice(f.change), a.actor.deviceId)).result).toBe('provisional')
    f.advance(1000)
    const expired = await f.store.read()
    expect(expired.provisional).toEqual([])
    expect(expired.document.bindings['T-0001']).toBeUndefined()
    expect(expired.resolution.bindings['T-0001']).toBeUndefined()
    expect(expired.awaitingSync).toEqual([{ operationId: f.change.operationId, taskId: 'T-0001' }])
    expect((await f.store.acceptNotification(notice(f.change), a.actor.deviceId)).result).toBe('awaiting-sync')
    const unrelated = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: binding('other') }, parents: [f.base.operationId] }, b)
    await appendRecord(f.recordsRoot, unrelated)
    expect((await f.store.read()).document.bindings['T-0001']).toBeUndefined()
    await appendRecord(f.recordsRoot, f.change)
    const conflict = await f.store.read()
    expect(conflict.awaitingSync).toEqual([])
    expect(conflict.document.bindings['T-0001']).toBeUndefined()
    expect(conflict.resolution.entities['binding:T-0001'].state).toBe('needs-resolution')
  })

  it('restores only bounded unresolved markers after restart, not cached provisional authorization', async () => {
    const f = await receiving()
    await f.store.acceptNotification(notice(f.change), a.actor.deviceId)
    await f.store.close()
    const requestSync = vi.fn()
    const overlay = new BindingOverlay({ workspaceId, recipientId: b.actor.deviceId, trust, markerFile: join(f.stateDirectory, 'pending-overlay.json'), requestSync })
    const reopened = new RemoteConfigStore({ ...f.options, overlay })
    stores.push(reopened)
    const snapshot = await reopened.read()
    expect(snapshot.document.bindings['T-0001']).toBeUndefined()
    expect(snapshot.provisional).toEqual([])
    expect(snapshot.awaitingSync).toHaveLength(1)
    expect(requestSync).toHaveBeenCalled()
    expect((await reopened.acceptNotification(notice(f.change), a.actor.deviceId)).result).toBe('awaiting-sync')
    await appendRecord(f.recordsRoot, f.change)
    expect((await reopened.read()).document.bindings['T-0001']).toEqual(binding('new'))
  })

  it('does not renew expired routing through another notice, and supports explicit cancellation', async () => {
    const f = await receiving()
    await f.store.acceptNotification(notice(f.change), a.actor.deviceId)
    f.advance(60000)
    await f.store.read()
    const successor = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: binding('successor') }, parents: [f.change.operationId] })
    expect((await f.store.acceptNotification(notice(successor, [f.change]), a.actor.deviceId)).result).toBe('awaiting-sync')
    expect((await f.store.read()).document.bindings['T-0001']).toBeUndefined()
    await f.overlay.cancel(f.change.operationId)
    expect((await f.store.read()).document.bindings['T-0001']).toEqual(binding('old'))
  })

  it('handles out-of-order notices, deletion and a canonical causal successor without reviving ancestors', async () => {
    const f = await receiving()
    const remove = await operation({ kind: 'binding', payload: { action: 'delete', taskId: 'T-0001' }, parents: [f.change.operationId] })
    expect((await f.store.acceptNotification(notice(remove, [f.change]), a.actor.deviceId)).result).toBe('provisional')
    expect((await f.store.read()).document.bindings['T-0001']).toBeUndefined()
    expect((await f.store.acceptNotification(notice(f.change), a.actor.deviceId)).result).toBe('provisional')
    expect((await f.store.read()).document.bindings['T-0001']).toBeUndefined()
    for (const record of [f.change, remove]) await appendRecord(f.recordsRoot, record)
    const synced = await f.store.read()
    expect(synced.document.bindings['T-0001']).toBeUndefined()
    expect(synced.provisional).toEqual([])
    expect(synced.resolution.entities['binding:T-0001'].state).toBe('deleted')
  })

  it('blocks concurrent same-task and global same-session claims instead of giving the overlay precedence', async () => {
    const f = await receiving()
    const otherTask = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0002', target: binding('new') } }, b)
    await appendRecord(f.recordsRoot, otherTask)
    expect((await f.store.acceptNotification(notice(f.change), a.actor.deviceId)).result).toBe('conflict')
    expect((await f.store.read()).document.bindings).toEqual({})
    const other = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: binding('other') }, parents: [f.base.operationId] }, b)
    await appendRecord(f.recordsRoot, other)
    const conflict = await f.store.read()
    expect(conflict.document.bindings['T-0001']).toBeUndefined()
    expect(conflict.document.bindings['T-0002']).toBeUndefined()
    expect(conflict.provisional).toEqual(['T-0001'])
  })

  it('rejects wrong scope, forged actors and dependency smuggling without changing routing', async () => {
    const f = await receiving()
    const original = (await f.store.read()).revision
    for (const request of [
      { ...notice(f.change), recipientId: a.actor.deviceId },
      { ...notice(f.change), workspaceId: a.actor.deviceId },
      { ...notice(f.change), privateToken: 'forbidden' },
      { ...notice(f.change), operation: { ...f.change, createdAt: '2020-01-01T00:00:00.000Z' } },
    ]) expect((await f.store.acceptNotification(request, a.actor.deviceId)).result).toBe('rejected')
    expect((await f.store.acceptNotification(notice(f.change), b.actor.deviceId)).result).toBe('rejected')
    const unrelated = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0003', target: binding('unrelated') } })
    expect((await f.store.acceptNotification(notice(f.change, [unrelated]), a.actor.deviceId)).result).toBe('rejected')
    expect((await f.store.read()).revision).toBe(original)
    expect((await f.store.read()).document.bindings['T-0001']).toEqual(binding('old'))
  })

  it('requests synchronization for missing or over-budget closures and honors current trust revocation', async () => {
    const f = await receiving()
    const missing = await operation({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: binding('unavailable') }, parents: ['e'.repeat(64)] })
    expect((await f.store.acceptNotification(notice(missing), a.actor.deviceId)).result).toBe('awaiting-sync')
    expect((await f.store.acceptNotification({ ...notice(f.change), huge: 'x'.repeat(262144) }, a.actor.deviceId)).result).toBe('awaiting-sync')
    expect((await f.store.read()).document.bindings['T-0001']).toEqual(binding('old'))
    await f.store.acceptNotification(notice(f.change), a.actor.deviceId)
    const denied = { ...trust, trustedKey: () => undefined }
    const overlay = new BindingOverlay({ workspaceId, recipientId: b.actor.deviceId, trust: denied })
    const ack = await overlay.accept(notice(f.change), a.actor.deviceId, [f.base])
    expect(ack.result).toBe('rejected')
    expect((await overlay.reconcile([f.base])).records).toEqual([])
    await overlay.close()
  })
})
