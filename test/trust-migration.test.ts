// @vitest-environment node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitReplica } from '../src/main/remoteConfig/git'
import { appendRecord, canonicalJson, createRecord, parseRecord, readRecords } from '../src/main/remoteConfig/records'
import {
  assertMigrationReady, baselineDescriptor, baselineGrant, contentHash, documentSigningBytes, planHash,
} from '../src/main/remoteConfig/trustBaseline'
import { adoptHost, publishCutover, verifyMigratedHost } from '../src/main/migration/cutover'
import { gitText, inspectRepository, remoteHead } from '../src/main/migration/git'
import { existing, profileIdentityStamps, signedInspection, treeStamps } from '../src/main/migration/local'
import { createMigrationPlan } from '../src/main/migration/model'
import { prepareHost, type MigrationFault } from '../src/main/migration/prepare'
import { migrationRecordPath, readMigrationFiles } from '../src/main/migration/legacyRecords'
import { migrationFixture, writeFixtureJson } from './trust-migration-fixture'
import { PeerControlServer } from '../src/main/remoteConfig/peerControl'
import { RemoteSyncScheduler } from '../src/main/remoteConfig/scheduler'
import { WorkspaceSyncService, type WorkspaceSyncOptions } from '../src/main/remoteConfig/service'
import { deviceHostStateSchema } from '../src/main/vscodeDeviceHost'
import { z } from 'zod'
import { hostname } from 'node:os'
import { migrationRuntimeSchema } from '../src/main/migration/local'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup(before?: (fixture: Awaited<ReturnType<typeof migrationFixture>>) => Promise<void>) {
  const f = await migrationFixture((root) => roots.push(root))
  await before?.(f)
  const reports = await Promise.all(f.hosts.map((host) => signedInspection(host)))
  const decisions = {
    migrationId: '50000000-0000-4000-8000-000000000001', coordinatorId: f.devices[0].id,
    grants: [
      { issuerId: f.devices[0].id, recipientId: f.devices[1].id, canSend: false },
      { issuerId: f.devices[1].id, recipientId: f.devices[0].id, canSend: true },
    ],
    fenced: [{ deviceId: f.devices[2].id, evidenceHash: 'f'.repeat(64), reason: 'Fixture: original revoked device; repository publication access fenced and owner confirmed.' }],
  }
  const plan = createMigrationPlan(reports, decisions, new Date(f.now).toISOString())
  const contexts = f.hosts.map((host, index) => ({ ...host, plan, report: reports[index], approvedHash: planHash(plan) }))
  return { ...f, reports, decisions, plan, contexts }
}
async function prepared(before?: (fixture: Awaited<ReturnType<typeof migrationFixture>>) => Promise<void>) {
  const f = await setup(before)
  const bundles = []
  for (const context of f.contexts) bundles.push(await prepareHost(context))
  return { ...f, bundles }
}

describe('one-time durable trust migration', () => {
  it('inspects signed legacy history, private permissions and exact owner receipts without writing the profile', async () => {
    const f = await migrationFixture((root) => roots.push(root))
    const before = await Promise.all(f.hosts.map((h) => treeStamps(h.profileRoot)))
    const reports = await Promise.all(f.hosts.map((h) => signedInspection(h)))
    expect(reports[0].report.publicRecords).toBe(11)
    expect(reports[0].report.preserved).toHaveLength(6)
    expect(reports[0].report.retiredIds).toHaveLength(5)
    expect(reports[0].report.incoming).toEqual([{ recipientId: f.devices[1].id, canSend: false }])
    expect(reports[1].report.localOwnedBindings).toBe(1)
    expect(reports[1].report.confirmedLocalBindings).toBe(1)
    expect(reports[0].report.relationships.find((r) => r.recipientId === f.devices[2].id)?.revoked).toBe(true)
    expect(JSON.stringify(reports)).not.toMatch(/encryptedPrivateKey|-----BEGIN|"token"|profileRoot/)
    expect(await Promise.all(f.hosts.map((h) => treeStamps(h.profileRoot)))).toEqual(before)
    await expect(readRecords(f.hosts[0].workspaceRoot)).rejects.toThrow('unsupported')
  }, 120000)

  it('rejects implicit permanent grants, missing devices, changed versions and read-only elevation', async () => {
    const f = await setup()
    expect(() => createMigrationPlan([f.reports[0]], f.decisions)).toThrow('Every known device')
    expect(() => createMigrationPlan(f.reports, { ...f.decisions, fenced: [] })).toThrow('Every known device')
    const grants = f.decisions.grants.map((g) => ({ ...g, canSend: true }))
    expect(() => createMigrationPlan(f.reports, { ...f.decisions, grants })).toThrow('read-only')
    const increased = createMigrationPlan(f.reports, { ...f.decisions, grants: grants.map((g) => ({ ...g, changeReason: 'Explicit fixture-only send upgrade for review.' })) })
    expect(increased.changes.some((c) => c.kind === 'increase-send')).toBe(true)
    expect(() => createMigrationPlan(f.reports, { ...f.decisions, grants: [...f.decisions.grants, {
      issuerId: f.devices[0].id, recipientId: f.devices[2].id, canSend: true, changeReason: 'Must not revive revoked fixture.',
    }] })).toThrow('revoked')
    const changed = { ...f.reports[1].report, codeCommit: 'b'.repeat(40) }
    const signature = await f.devices[1].sign(documentSigningBytes('TrustMigrationInspection', changed))
    const signed = { report: changed, signature: typeof signature === 'string' ? signature : signature.toString('base64') }
    expect(() => createMigrationPlan([f.reports[0], signed], f.decisions)).toThrow('disagree')
  }, 120000)

  it('requires unchanged accepted/outbox history, exact receipts, approved hashes and a stopped host', async () => {
    const f = await setup()
    await expect(prepareHost({ ...f.contexts[0], approvedHash: '0'.repeat(64) })).rejects.toThrow('approved')
    await expect(prepareHost({ ...f.contexts[0], assertStopped: async () => { throw new Error('Fixture host still running') } })).rejects.toThrow('still running')
    expect(await existing(join(f.hosts[0].directory, 'trust-migration.json'))).toBe(false)
    const cache = join(f.hosts[0].directory, 'records-cache', ...migrationRecordPath(f.records[0]).split('/'))
    const bytes = await readFile(cache)
    await rm(cache)
    await expect(signedInspection(f.hosts[0])).rejects.toThrow('Accepted, cached or pending history')
    await writeFile(cache, bytes)
    await writeFixtureJson(join(f.hosts[1].profileRoot, 'local-session-link-receipts.json'), { schemaVersion: 2, receipts: [] })
    await expect(signedInspection(f.hosts[1])).rejects.toThrow('owner-confirmation')
  }, 120000)

  it('preserves identity, aliases, bindings, read-only scopes and signed bytes through separate baseline and grant commits', async () => {
    const f = await prepared(async (fixture) => {
      await writeFixtureJson(join(fixture.hosts[0].directory, 'store', 'store.lock'), {
        schemaVersion: 1, workspaceId: fixture.records[0].workspaceId, pid: 2147483000, host: hostname(), nonce: '50000000-0000-4000-8000-000000000099',
      })
      for (const host of fixture.hosts) for (const record of fixture.records.filter((r) => r.kind !== 'invitation')) {
        const path = migrationRecordPath(record)
        for (const area of ['records-cache', 'outbox']) {
          const file = join(host.directory, area, ...path.split('/'))
          if (await existing(file)) await writeFile(file, canonicalJson(record) + '\r\n')
        }
      }
    })
    const originals = await Promise.all(f.hosts.map((h) => profileIdentityStamps(h.profileRoot)))
    expect(await remoteHead(f.hosts[0].repository)).toBe(f.sourceCommit)
    await expect(assertMigrationReady(f.hosts[0].workspaceRoot, f.hosts[0].directory)).rejects.toThrow('prepared')
    expect(f.bundles.map((b) => b.grants.length)).toEqual([1, 1])
    await expect(publishCutover(f.contexts[1], f.bundles)).rejects.toThrow('coordinator')
    await expect(publishCutover(f.contexts[0], f.bundles.slice(0, 1))).rejects.toThrow('Every participating')
    const receipt = await publishCutover(f.contexts[0], f.bundles)
    const { baselineCommit, authorizationCommit } = receipt.checkpoint
    expect(baselineCommit).not.toBe(authorizationCommit)
    expect(await gitText(f.hosts[0].repository.repositoryRoot, 'rev-parse', `${baselineCommit}^`)).toBe(f.sourceCommit)
    expect(await gitText(f.hosts[0].repository.repositoryRoot, 'rev-parse', `${authorizationCommit}^`)).toBe(baselineCommit)
    expect(await gitText(f.hosts[0].repository.repositoryRoot, 'rev-parse', 'HEAD')).toBe(f.sourceCommit)
    expect(await publishCutover(f.contexts[0], f.bundles)).toEqual(receipt)
    for (let index = 0; index < f.contexts.length; index++) {
      const context = f.contexts[index]
      const result = await adoptHost(context, receipt)
      expect(result).toMatchObject({ status: 'WAITING_FOR_CUTOVER', preservedRecords: 6, retiredRecords: 5, activeRecords: 8, bindings: 1, runtimeSchema: 3, authenticationTested: false })
      expect(await profileIdentityStamps(context.profileRoot)).toEqual(originals[index])
      expect(await existing(join(context.checkpointRoot, 'retired-sync'))).toBe(true)
      if (index === 0) {
        expect(await existing(join(context.checkpointRoot, 'retired-sync', 'store', 'store.lock'))).toBe(true)
        expect(await existing(join(context.directory, 'store', 'store.lock'))).toBe(false)
      }
      expect(migrationRuntimeSchema.safeParse(JSON.parse(await readFile(join(context.directory, 'runtime.json'), 'utf8'))).success).toBe(false)
      expect((await readRecords(context.workspaceRoot)).every((r) => r.kind !== 'invitation' || r.payload.action !== 'grant' || r.payload.lifetime === 'until-revoked')).toBe(true)
      expect((await readRecords(join(context.directory, 'outbox'))).some((r) => f.plan.retiredIds.includes(r.operationId))).toBe(false)
      expect(await gitText(context.repository.repositoryRoot, 'status', '--porcelain=v1')).toBe('')
      const pin = await assertMigrationReady(context.workspaceRoot, context.directory)
      expect(baselineGrant(pin, f.devices[0].id, f.devices[1].id)?.canSend).toBe(false)
      expect(baselineGrant(pin, f.devices[0].id, f.devices[2].id)).toBeUndefined()
      expect(await readFile(join(context.repository.repositoryRoot, 'notes.txt'), 'utf8')).toBe('Keep original task data.\n')
      const replica = await GitReplica.open({ workspaceRoot: context.workspaceRoot, stateDirectory: context.directory, prepare: false })
      try { expect((await replica.sync()).head).toBe(authorizationCommit) } finally { await replica.close() }
      const before = await treeStamps(context.directory)
      expect(await adoptHost(context, receipt)).toMatchObject({ baselineCommit, authorizationCommit })
      expect(await treeStamps(context.directory)).toEqual(before)
    }
    expect(await remoteHead(f.hosts[0].repository)).toBe(authorizationCommit)
  }, 180000)

  it.each(['backed-up', 'gated'] as const)('resumes preparation after %s without duplicate signing or resetting state', async (phase) => {
    const f = await setup()
    const context = f.contexts[0]
    let interrupted = false
    const fault: MigrationFault = async (current) => {
      if (!interrupted && current === phase) { interrupted = true; throw new Error('Fixture interruption') }
    }
    await expect(prepareHost({ ...context, fault })).rejects.toThrow('Fixture interruption')
    const bundle = await prepareHost(context)
    expect(await prepareHost(context)).toEqual(bundle)
    expect(bundle.grants).toHaveLength(1)
    expect(await remoteHead(context.repository)).toBe(f.sourceCommit)
  }, 120000)

  it.each(['commits-created', 'published'] as const)('resumes publication after %s without another baseline or rewriting Git history', async (phase) => {
    const f = await prepared()
    let interrupted = false
    await expect(publishCutover({ ...f.contexts[0], fault: async (current) => {
      if (!interrupted && current === phase) { interrupted = true; throw new Error('Fixture interruption') }
    } }, f.bundles)).rejects.toThrow('Fixture interruption')
    const receipt = await publishCutover(f.contexts[0], f.bundles)
    expect(await remoteHead(f.hosts[0].repository)).toBe(receipt.checkpoint.authorizationCommit)
    expect(await gitText(f.hosts[0].repository.repositoryRoot, 'rev-list', '--count', `${f.sourceCommit}..${receipt.checkpoint.authorizationCommit}`)).toBe('2')
  }, 180000)

  it.each(['checkout-written', 'checkout-updated', 'staged', 'archived', 'installed', 'anchored'] as const)('resumes installation after %s while preserving the original private backup', async (phase) => {
    const f = await prepared()
    const receipt = await publishCutover(f.contexts[0], f.bundles)
    const context = f.contexts[0]
    const backupBefore = await treeStamps(join(context.checkpointRoot, 'profile-backup'))
    let interrupted = false
    await expect(adoptHost({ ...context, fault: async (current) => {
      if (!interrupted && current === phase) { interrupted = true; throw new Error('Fixture interruption') }
    } }, receipt)).rejects.toThrow('Fixture interruption')
    const result = await adoptHost(context, receipt)
    expect(result.activeRecords).toBe(8)
    expect(result.bindings).toBe(1)
    expect(await treeStamps(join(context.checkpointRoot, 'profile-backup'))).toEqual(backupBefore)
    expect(await existing(join(context.directory, 'trust-migration.json'))).toBe(false)
  }, 180000)

  it('rejects a wrong baseline, forged bundle, altered backup and user work without bypasses', async () => {
    const f = await prepared()
    const forged = { ...f.bundles[1], deviceId: f.devices[0].id }
    await expect(publishCutover(f.contexts[0], [f.bundles[0], forged])).rejects.toThrow()
    const receipt = await publishCutover(f.contexts[0], f.bundles)
    await expect(adoptHost(f.contexts[0], { ...receipt, checkpoint: { ...receipt.checkpoint, baselineCommit: f.sourceCommit } })).rejects.toThrow('baseline')
    await writeFile(join(f.hosts[0].repository.repositoryRoot, 'notes.txt'), 'User edit must survive.\n')
    await expect(adoptHost(f.contexts[0], receipt)).rejects.toThrow('checkout changed')
    expect(await readFile(join(f.hosts[0].repository.repositoryRoot, 'notes.txt'), 'utf8')).toBe('User edit must survive.\n')
    const backup = join(f.contexts[1].checkpointRoot, 'profile-backup', 'remote-vscode-identity.json')
    await writeFixtureJson(backup, { clientId: f.devices[0].id })
    await expect(adoptHost(f.contexts[1], receipt)).rejects.toThrow('backup')
  }, 180000)

  it('fails closed when retired history reappears or an old branch is selected after installation', async () => {
    const f = await prepared()
    const receipt = await publishCutover(f.contexts[0], f.bundles)
    const context = f.contexts[0]
    await adoptHost(context, receipt)
    const old = f.records.find((r) => r.kind === 'invitation')!
    const path = join(context.directory, 'outbox', ...migrationRecordPath(old).split('/'))
    await writeFixtureJson(path, old)
    await expect(verifyMigratedHost(context, receipt)).rejects.toThrow('unsupported')
    await rm(path)
    await gitText(context.repository.repositoryRoot, 'branch', 'old-client', f.sourceCommit)
    await gitText(context.repository.repositoryRoot, 'switch', 'old-client')
    await expect(assertMigrationReady(context.workspaceRoot, context.directory)).rejects.toThrow('baseline')
    const legacyDescriptor = JSON.parse(await readFile(join(context.workspaceRoot, '.taskcontinuum', 'workspace.json'), 'utf8')) as { schemaVersion: number }
    expect(legacyDescriptor.schemaVersion).toBe(1)
    expect(baselineDescriptor(f.plan).schemaVersion).toBe(2)
  }, 180000)

  it('retains all non-invitation operation hashes in the signed plan and rejects source tampering', async () => {
    const f = await setup()
    const files = await readMigrationFiles(f.hosts[0].workspaceRoot)
    expect(f.plan.preserved.map((p) => p.operationId).sort()).toEqual(files.filter((p) => p.record.kind !== 'invitation').map((p) => p.record.operationId).sort())
    const record = files.find((f) => f.record.kind === 'alias')!
    await writeFile(join(f.hosts[0].workspaceRoot, ...record.path.split('/')), record.content.replace('Existing alias', 'Tampered alias'))
    await expect(signedInspection(f.hosts[0])).rejects.toThrow('clean')
    expect(contentHash(f.plan.preserved)).toMatch(/^[a-f0-9]{64}$/)
    expect((await inspectRepository(f.hosts[1].workspaceRoot)).head).toBe(f.sourceCommit)
  }, 120000)

  it('does not confuse the baseline with a later legitimate device-signed authorization commit', async () => {
    const f = await prepared()
    const receipt = await publishCutover(f.contexts[0], f.bundles)
    const first = f.contexts[0], later = f.contexts[1]
    await adoptHost(first, receipt)
    const previous = parseRecord(f.bundles[0].grants[0])
    if (previous.kind !== 'invitation' || previous.payload.action !== 'grant') throw new Error('Fixture grant')
    const grant = await createRecord({
      kind: 'invitation', workspaceId: f.plan.workspaceId, actor: previous.actor,
      parents: [previous.operationId], payload: previous.payload,
    }, f.devices[0].sign)
    await appendRecord(first.workspaceRoot, grant)
    await gitText(first.repository.repositoryRoot, 'add', '--', 'Work/.taskcontinuum')
    await gitText(first.repository.repositoryRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Explicit later fixture authorization')
    await gitText(first.repository.repositoryRoot, 'push', '--quiet')
    const laterHead = await gitText(first.repository.repositoryRoot, 'rev-parse', 'HEAD')
    const result = await adoptHost(later, receipt)
    expect(result.baselineCommit).toBe(receipt.checkpoint.baselineCommit)
    expect(result.authorizationCommit).toBe(receipt.checkpoint.authorizationCommit)
    expect(result.currentHead).toBe(laterHead)
    expect(result.activeRecords).toBe(9)
    expect(result.bindings).toBe(1)
  }, 180000)

  it('rejects an old writer appending retired signed records to the shared Git branch', async () => {
    const f = await prepared()
    const receipt = await publishCutover(f.contexts[0], f.bundles)
    const context = f.contexts[0]
    await adoptHost(context, receipt)
    const writer = join(f.root, 'old-writer')
    await gitText(f.root, 'clone', '--quiet', '--config', 'core.autocrlf=false', f.remote, writer)
    await gitText(writer, 'config', 'core.autocrlf', 'false')
    const old = f.records.find((r) => r.kind === 'invitation')!
    const path = join(writer, 'Work', ...migrationRecordPath(old).split('/'))
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, canonicalJson(old) + '\n')
    await gitText(writer, 'add', '--', 'Work/.taskcontinuum')
    await gitText(writer, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Old fixture writer reintroduces retired record')
    await gitText(writer, 'push', '--quiet')
    const before = await treeStamps(join(context.directory, 'records-cache'))
    const replica = await GitReplica.open({ workspaceRoot: context.workspaceRoot, stateDirectory: context.directory, prepare: false })
    try { await expect(replica.sync()).rejects.toThrow('unsupported') } finally { await replica.close() }
    expect(await treeStamps(join(context.directory, 'records-cache'))).toEqual(before)
    expect(await gitText(context.repository.repositoryRoot, 'rev-parse', 'HEAD')).toBe(receipt.checkpoint.authorizationCommit)
  }, 180000)

  it('does not auto-convert expired history when time advances in an isolated clock', async () => {
    const f = await setup()
    const later = f.now + 86400000 * 2
    const reports = await Promise.all(f.hosts.map((host) => signedInspection({ ...host, now: () => later })))
    expect(reports[0].report.relationships.every((r) => !r.eligible)).toBe(true)
    expect(() => createMigrationPlan(reports, f.decisions, new Date(later).toISOString())).toThrow('not currently authorized')
    expect(await remoteHead(f.hosts[0].repository)).toBe(f.sourceCommit)
  }, 120000)

  it('keeps migrated read-only scopes and stable public grants across runtime reloads and simulated days', async () => {
    const f = await prepared(async (fixture) => {
      const file = join(fixture.hosts[0].directory, 'runtime.json')
      const runtime = z.object({ managedPairs: z.record(z.string(), z.string()) }).passthrough().parse(JSON.parse(await readFile(file, 'utf8')))
      await writeFixtureJson(file, { ...runtime, managedPairs: {} })
    })
    const receipt = await publishCutover(f.contexts[0], f.bundles)
    const context = f.contexts[0]
    await adoptHost(context, receipt)
    const envelope = z.object({ encrypted: z.string() }).parse(JSON.parse(await readFile(join(context.profileRoot, 'remote-vscode-device-host.json'), 'utf8')))
    const hostState = deviceHostStateSchema.parse(JSON.parse(Buffer.from(envelope.encrypted, 'base64').toString('utf8')))
    const setWorkspace = vi.fn<WorkspaceSyncOptions['host']['setWorkspace']>().mockResolvedValue(undefined)
    const pair = vi.fn<WorkspaceSyncOptions['host']['pair']>().mockResolvedValue(hostState.pairs[0])
    vi.spyOn(PeerControlServer.prototype, 'start').mockResolvedValue({ port: 2300 })
    vi.spyOn(RemoteSyncScheduler.prototype, 'request').mockImplementation(() => {})
    const time = vi.spyOn(Date, 'now')
    const before = (await readRecords(join(context.directory, 'records-cache'))).map((r) => r.operationId).sort()
    for (const days of [0, 2, 31, 365]) {
      time.mockReturnValue(f.now + days * 86400000)
      const service = new WorkspaceSyncService({
        directory: context.profileRoot,
        identity: async () => ({ clientId: f.devices[0].id, username: 'fixture', machineName: f.devices[0].name }),
        keys: { get: async (purpose) => f.devices[0][purpose] },
        tunnels: {
          publish: async () => {},
          publicEndpoint: () => ({ tunnelId: 'fixture-0.test', sshPort: 2200, hostPublicKey: f.devices[0].host.publicKey }),
          authorize: (_grant, publicKey) => ({ kind: 'dev-tunnel', tunnelId: 'fixture-0.test', sshPort: 2200, hostPublicKey: f.devices[0].host.publicKey, clientPublicKey: publicKey }),
          authorizeTrust: (_id, publicKey) => ({ kind: 'dev-tunnel', tunnelId: 'fixture-0.test', sshPort: 2200, hostPublicKey: f.devices[0].host.publicKey, clientPublicKey: publicKey }),
          revoke: () => {},
          connect: async () => { throw new Error('Fixture peer is offline; do not make a real network connection.') },
        },
        host: {
          pair, setWorkspace, list: async () => structuredClone(hostState.pairs), start: async () => 3001,
          ownerId: async () => hostState.ownerId, revoke: async () => {},
        },
        devices: {
          publicIdentities: async () => [],
          import: vi.fn<WorkspaceSyncOptions['devices']['import']>().mockRejectedValue(new Error('Fixture network disabled')),
          connectOwner: async () => {}, disconnectOwner: async () => {},
          reconnectOwner: async () => false, ownerConnected: async () => false,
        },
        onChange: () => {},
      })
      try {
        await service.restore()
        service.startRestored()
        await service.whenConnectionsSettled(context.workspaceRoot)
        expect((await service.status(context.workspaceRoot)).settings?.autoLink).toBe(true)
      } finally { await service.close() }
      expect((await readRecords(join(context.directory, 'records-cache'))).map((r) => r.operationId).sort()).toEqual(before)
      expect((await readRecords(join(context.directory, 'outbox'))).filter((r) => r.kind === 'invitation')).toHaveLength(1)
    }
    expect(setWorkspace).toHaveBeenCalledWith(hostState.pairs[0].id, context.workspaceRoot.toLowerCase(), false)
    expect(setWorkspace.mock.calls.some((args) => args[2] === true)).toBe(false)
    expect(pair.mock.results.length).toBeGreaterThan(0)
    expect(await remoteHead(context.repository)).toBe(receipt.checkpoint.authorizationCommit)
  }, 180000)
})
