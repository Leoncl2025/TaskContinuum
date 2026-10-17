// @vitest-environment node
import * as crypto from 'node:crypto'
import * as filesystem from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { RemoteConfigStore } from '../src/main/remoteConfig/store'
import { appendRecord, createRecord, readRecords } from '../src/main/remoteConfig/records'
import type { RecordTrust } from '../src/main/remoteConfig/records'
import type { InvitationPayload, InvitationRecord } from '../src/shared/remoteConfig'
import { immutableRecordSigner } from './immutable-bindings-fixture'

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>() }))
vi.mock('node:crypto', async (original) => ({ ...await original<typeof import('node:crypto')>() }))

it.each([50, 400, 1000])('measures cold and warm authority work with two devices and %i explicit trust decisions', async (count) => {
  const home = await filesystem.mkdtemp(join(tmpdir(), 'tc-trust-cost-'))
  const root = join(home, 'workspace'), outbox = join(home, 'outbox'), state = join(home, 'state')
  await Promise.all([root, outbox, state].map((folder) => filesystem.mkdir(folder)))
  const a = immutableRecordSigner(1), b = immutableRecordSigner(2), workspaceId = crypto.randomUUID()
  const trust: RecordTrust = {
    workspaceId, trustedKey: (actor) => actor.deviceId === a.actor.deviceId ? a.publicKey : b.publicKey,
    authorize: () => true, authorizationVersion: () => 'fixed-trust',
  }
  const options = { workspaceRoot: root, recordsRoot: root, outboxRoot: outbox, stateDirectory: state,
    workspaceId, actor: a.actor, sign: a.sign, trust }
  let store = new RemoteConfigStore(options)
  try {
    const devices = []
    for (const owner of [a, b]) {
      const record = await createRecord({ kind: 'device', workspaceId, actor: owner.actor, payload: {
        action: 'publish', deviceId: owner.actor.deviceId, identity: { machineName: 'Fixture', username: 'fixture',
          clientPublicKey: owner.publicKey, hostPublicKey: owner.publicKey, clientKeyId: owner.actor.keyId, hostKeyId: owner.actor.keyId },
        routes: [{ kind: 'dev-tunnel', tunnelId: 'fixture.test', sshPort: 2200, controlPort: 2201 }],
      } }, owner.sign)
      await appendRecord(root, record)
      devices.push(record)
    }
    let previous: InvitationRecord | undefined
    const since = Date.now() - count * 86400000
    for (let index = 0; index < count; index++) {
      const identity = { issuerId: a.actor.deviceId, recipientId: b.actor.deviceId,
        issuerIdentityRef: devices[0].operationId, recipientIdentityRef: devices[1].operationId }
      const payload: InvitationPayload = previous?.payload.action === 'grant' ? {
        ...identity, action: 'revoke', grantId: previous.payload.grantId, revokes: previous.operationId,
      } : {
        ...identity, action: 'grant', grantId: crypto.randomUUID(), capability: 'ah-link',
        issuedAt: new Date(since + index * 86400000).toISOString(),
        lifetime: 'until-revoked',
        routeRef: { identityRef: devices[0].operationId, routeIndex: 0 },
      }
      const record = await createRecord({ kind: 'invitation', workspaceId, actor: a.actor, parents: previous ? [previous.operationId] : [], payload }, a.sign)
      await appendRecord(root, record)
      previous = record
    }
    await store.initialize()
    await store.close()
    store = new RemoteConfigStore(options)
    const originalIds = (await readRecords(root)).map((record) => record.operationId)
    const stat = vi.spyOn(filesystem, 'lstat'), dirs = vi.spyOn(filesystem, 'readdir'), opens = vi.spyOn(filesystem, 'open')
    const parse = vi.spyOn(JSON, 'parse'), signatures = vi.spyOn(crypto, 'verify')
    const measured = async (run: () => Promise<unknown>) => {
      for (const spy of [stat, dirs, opens, parse, signatures]) spy.mockClear()
      const started = performance.now()
      await run()
      return { elapsedMs: Math.round(performance.now() - started), metadataChecks: stat.mock.calls.length,
        directoryReads: dirs.mock.calls.length, fileOpens: opens.mock.calls.length, jsonParses: parse.mock.calls.length,
        signatureVerifications: signatures.mock.calls.length }
    }
    try {
      const cold = await measured(() => store.read())
      const first = await measured(() => store.acquireAuthorization())
      const warm = await measured(async () => { for (let index = 0; index < 100; index++) expect((await store.acquireAuthorization()).current()).toBe(true) })
      const refresh = await measured(() => store.read())
      expect(cold.signatureVerifications).toBe(count + 2)
      expect(first.signatureVerifications).toBe(0)
      expect(warm).toMatchObject({ metadataChecks: 0, directoryReads: 0, fileOpens: 0, jsonParses: 0, signatureVerifications: 0 })
      expect(refresh.signatureVerifications).toBe(0)
      const afterIds = (await readRecords(root)).map((record) => record.operationId)
      expect(afterIds).toEqual(originalIds)
      console.log(JSON.stringify({ devices: 2, retainedTrustDecisions: count, newPublicRecordsDuringMeasurement: afterIds.length - originalIds.length, cold, first, warm100: warm, unchangedRefresh: refresh }))
    } finally { for (const spy of [stat, dirs, opens, parse, signatures]) spy.mockRestore() }
  } finally { await store.close(); await filesystem.rm(home, { recursive: true, force: true }) }
}, 120000)
