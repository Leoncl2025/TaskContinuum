// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalJson, createRecord, parseRecord } from '../src/main/remoteConfig/records'
import { bytesHash, contentHash } from '../src/main/remoteConfig/trustBaseline'
import { migrationRecordPath, parseMigrationRecord, validateLegacyHistory, type MigrationFile } from '../src/main/migration/legacyRecords'
import { immutableRecordSigner, immutableWorkspaceId } from './immutable-bindings-fixture'

async function fixture() {
  const a = immutableRecordSigner(1), b = immutableRecordSigner(2)
  const at = '2026-10-24T01:00:00.000Z'
  const devices = await Promise.all([a, b].map((device) => createRecord({
    kind: 'device', actor: device.actor, workspaceId: immutableWorkspaceId, createdAt: at,
    payload: { action: 'publish', deviceId: device.actor.deviceId,
      identity: { machineName: 'fixture', username: 'fixture', clientPublicKey: device.publicKey, hostPublicKey: device.publicKey, clientKeyId: device.actor.keyId, hostKeyId: device.actor.keyId },
      routes: [{ kind: 'dev-tunnel', tunnelId: 'fixture.test', sshPort: 2200, controlPort: 2201 }] },
  }, device.sign)))
  const body = {
    schemaVersion: 1 as const, kind: 'invitation' as const, workspaceId: immutableWorkspaceId, actor: a.actor,
    nonce: randomUUID(), createdAt: at, parents: [],
    payload: { action: 'grant' as const, capability: 'ah-link' as const, issuerId: a.actor.deviceId, recipientId: b.actor.deviceId, grantId: randomUUID(),
      issuerIdentityRef: devices[0].operationId, recipientIdentityRef: devices[1].operationId, issuedAt: at, expiresAt: '2026-10-25T01:00:00.000Z',
      routeRef: { identityRef: devices[0].operationId, routeIndex: 0 } },
  }
  const signed = { ...body, signature: { algorithm: 'ed25519' as const, value: a.sign(Buffer.from(`TaskCon.RemoteConfig.v1\n${canonicalJson(body)}`)).toString('base64') } }
  const legacy = { ...signed, operationId: contentHash(signed) }
  const file = (input: unknown): MigrationFile => {
    const record = parseMigrationRecord(input), content = canonicalJson(record) + '\n'
    return { path: migrationRecordPath(record), record, content, sha256: bytesHash(content) }
  }
  const trust = { workspaceId: immutableWorkspaceId, now: Date.parse(at), pins: Object.fromEntries([a, b].map((d) => [d.actor.deviceId, { clientPublicKey: d.publicKey, hostPublicKey: d.publicKey, blocked: false }])) }
  return { a, b, devices, legacy, signed, file, trust }
}

describe('legacy format stays in the one-time tool', () => {
  it('verifies a correctly signed old grant without making the normal parser accept it', async () => {
    const f = await fixture()
    const checked = await validateLegacyHistory([...f.devices, f.legacy].map(f.file), f.trust)
    expect(checked.relationships).toMatchObject([{ eligible: true, revoked: false }])
    expect(checked.retained).toHaveLength(2)
    expect(() => parseRecord(f.legacy)).toThrow('unsupported')
    expect(() => parseMigrationRecord({ ...f.legacy, payload: { ...f.legacy.payload, expiresAt: null } })).toThrow()
  })

  it('rejects legacy signatures even when a tampered content hash has been recalculated', async () => {
    const f = await fixture()
    const signed = { ...f.signed, payload: { ...f.signed.payload, grantId: randomUUID() } }
    const changed = { ...signed, operationId: contentHash(signed) }
    await expect(validateLegacyHistory([...f.devices, changed].map(f.file), f.trust)).rejects.toThrow('signature')
  })

  it('requires complete dependencies and does not accept a changed local key pin', async () => {
    const f = await fixture()
    await expect(validateLegacyHistory([f.devices[0], f.legacy].map(f.file), f.trust)).rejects.toThrow('dependency')
    f.trust.pins[f.a.actor.deviceId].clientPublicKey = f.b.publicKey
    await expect(validateLegacyHistory([...f.devices, f.legacy].map(f.file), f.trust)).rejects.toThrow('key')
  })

  it('keeps revocation decisions inactive and rejects concurrent identity or alias heads', async () => {
    const f = await fixture()
    const revoke = await createRecord({
      kind: 'invitation', actor: f.a.actor, workspaceId: immutableWorkspaceId, createdAt: f.legacy.createdAt, parents: [f.legacy.operationId],
      payload: { action: 'revoke', issuerId: f.legacy.payload.issuerId, recipientId: f.legacy.payload.recipientId, grantId: f.legacy.payload.grantId,
        issuerIdentityRef: f.legacy.payload.issuerIdentityRef, recipientIdentityRef: f.legacy.payload.recipientIdentityRef, revokes: f.legacy.operationId },
    }, f.a.sign)
    const checked = await validateLegacyHistory([...f.devices, f.legacy, revoke].map(f.file), f.trust)
    expect(checked.relationships).toMatchObject([{ eligible: false, revoked: true }])
    const aliases = await Promise.all(['one', 'two'].map((alias) => createRecord({
      kind: 'alias', actor: f.a.actor, workspaceId: immutableWorkspaceId, createdAt: f.legacy.createdAt,
      payload: { action: 'set', deviceId: f.a.actor.deviceId, alias },
    }, f.a.sign)))
    await expect(validateLegacyHistory([...f.devices, ...aliases, f.legacy].map(f.file), f.trust)).rejects.toThrow('conflict')
  })
})
