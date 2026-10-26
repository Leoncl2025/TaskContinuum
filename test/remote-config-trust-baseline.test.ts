// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRecord, recordPath, serializeRecord } from '../src/main/remoteConfig/records'
import {
  approvalBody, assertMigrationReady, baselineAllowsRecord, baselineDescriptor, baselineFile, baselineGrant,
  baselinePlanSchema, bytesHash, documentSigningBytes, migrationGateFile, readBaselinePin, validateBaselineFiles,
  type BaselinePin,
} from '../src/main/remoteConfig/trustBaseline'
import { immutableRecordSigner, immutableWorkspaceId } from './immutable-bindings-fixture'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tc-runtime-baseline-'))
  roots.push(root)
  const workspace = join(root, 'workspace'), directory = join(root, 'state')
  await mkdir(join(workspace, '.taskcontinuum'), { recursive: true })
  await mkdir(join(directory, 'store'), { recursive: true })
  const devices = [1, 2, 3, 4].map(immutableRecordSigner)
  const at = '2026-10-24T01:00:00.000Z'
  const publications = await Promise.all(devices.map((device) => createRecord({
    kind: 'device', workspaceId: immutableWorkspaceId, actor: device.actor, createdAt: at,
    payload: {
      action: 'publish', deviceId: device.actor.deviceId,
      identity: {
        username: 'fixture', machineName: `Fixture-${device.actor.deviceId}`,
        clientPublicKey: device.publicKey, hostPublicKey: device.publicKey,
        clientKeyId: device.actor.keyId, hostKeyId: device.actor.keyId,
      },
      routes: [{ kind: 'dev-tunnel', tunnelId: 'fixture.test', sshPort: 2200, controlPort: 2201 }],
    },
  }, device.sign)))
  const grant = (issuer: number, recipient: number) => createRecord({
    kind: 'invitation', workspaceId: immutableWorkspaceId, actor: devices[issuer].actor, createdAt: at,
    payload: {
      action: 'grant', capability: 'ah-link',
      issuerId: devices[issuer].actor.deviceId, recipientId: devices[recipient].actor.deviceId,
      grantId: '50000000-0000-4000-8000-000000000002', issuedAt: at, lifetime: 'until-revoked',
      issuerIdentityRef: publications[issuer].operationId, recipientIdentityRef: publications[recipient].operationId,
      routeRef: { identityRef: publications[issuer].operationId, routeIndex: 0 },
    },
  }, devices[issuer].sign)
  const retired = await grant(0, 1)
  const preserved = publications.slice(0, 3).map((record) => ({
    path: recordPath(record).replaceAll('\\', '/'), operationId: record.operationId, sha256: bytesHash(serializeRecord(record)),
  }))
  const plan = baselinePlanSchema.parse({
    schemaVersion: 1, kind: 'taskcontinuum-trust-migration',
    migrationId: '50000000-0000-4000-8000-000000000001',
    codeCommit: 'a'.repeat(40), createdAt: at, workspaceId: immutableWorkspaceId, sourceCommit: 'b'.repeat(40),
    repositoryHash: 'c'.repeat(64), workspaceRelativePath: '', sourceRecordsHash: 'd'.repeat(64), bindingHash: 'e'.repeat(64),
    preserved, retiredIds: [retired.operationId],
    devices: devices.slice(0, 3).map((device, index) => ({
      deviceId: device.actor.deviceId, clientPublicKey: device.publicKey, hostPublicKey: device.publicKey,
      disposition: index === 2 ? 'fenced' : 'participating', evidenceHash: 'f'.repeat(64),
    })),
    coordinatorId: devices[0].actor.deviceId,
    grants: [{ issuerId: devices[0].actor.deviceId, recipientId: devices[1].actor.deviceId, canSend: false }],
    changes: [],
  })
  const pin: BaselinePin = {
    schemaVersion: 1, plan, baselineCommit: '1'.repeat(40), authorizationCommit: '2'.repeat(40),
    approvals: devices.slice(0, 2).map((device) => ({
      deviceId: device.actor.deviceId,
      signature: device.sign(documentSigningBytes('TrustMigrationApproval', approvalBody(plan))).toString('base64'),
    })),
  }
  const descriptor = baselineDescriptor(plan)
  const files = new Map([
    ['.taskcontinuum/workspace.json', { content: JSON.stringify(descriptor) }],
    ...publications.slice(0, 3).map((record): [string, { content: string }] => [
      recordPath(record).replaceAll('\\', '/'), { content: serializeRecord(record) },
    ]),
  ])
  const store = {
    schemaVersion: 1, workspaceId: immutableWorkspaceId, initialized: true,
    canonicalIds: preserved.map((record) => record.operationId), localIds: [],
  }
  await writeFile(join(workspace, '.taskcontinuum', 'workspace.json'), JSON.stringify(descriptor))
  await writeFile(join(directory, baselineFile), JSON.stringify(pin))
  await writeFile(join(directory, 'store', 'store.json'), JSON.stringify(store))
  return { workspace, directory, devices, publications, grant, retired, pin, files, store }
}

describe('runtime trust baseline protection without the migration CLI', () => {
  it('opens a fresh workspace without requiring a baseline or creating migration state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tc-fresh-trust-'))
    roots.push(root)
    await expect(assertMigrationReady(root, root)).resolves.toBeUndefined()
    await expect(readBaselinePin(root)).resolves.toBeUndefined()
    await expect(readFile(join(root, baselineFile))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains signed approvals, exact preserved bytes and directed read-only policy', async () => {
    const f = await fixture()
    await expect(assertMigrationReady(f.workspace, f.directory)).resolves.toEqual(f.pin)
    expect(() => validateBaselineFiles(f.files, f.pin)).not.toThrow()
    expect(baselineGrant(f.pin, f.devices[0].actor.deviceId, f.devices[1].actor.deviceId)?.canSend).toBe(false)
    expect(baselineGrant(f.pin, f.devices[1].actor.deviceId, f.devices[0].actor.deviceId)).toBeUndefined()
    expect(baselineAllowsRecord(f.pin, await f.grant(0, 1))).toBe(true)
    expect(baselineAllowsRecord(f.pin, await f.grant(1, 0))).toBe(false)
    expect(baselineAllowsRecord(f.pin, f.publications[2])).toBe(true)
    const fencedEdit = await createRecord({
      kind: 'alias', workspaceId: immutableWorkspaceId, actor: f.devices[2].actor,
      payload: { action: 'set', deviceId: f.devices[2].actor.deviceId, alias: 'Unapproved change' },
    }, f.devices[2].sign)
    expect(baselineAllowsRecord(f.pin, fencedEdit)).toBe(false)
    expect(baselineAllowsRecord(f.pin, f.publications[3])).toBe(false)
    expect(baselineAllowsRecord(f.pin, f.retired)).toBe(false)
  })

  it('rejects missing approvals and policy changes signed by the original plan only', async () => {
    const f = await fixture()
    await writeFile(join(f.directory, baselineFile), JSON.stringify({ ...f.pin, approvals: f.pin.approvals.slice(0, 1) }))
    await expect(readBaselinePin(f.directory)).rejects.toThrow('Every participating device')
    const changed = structuredClone(f.pin)
    changed.plan.grants[0].canSend = true
    await writeFile(join(f.directory, baselineFile), JSON.stringify(changed))
    await expect(readBaselinePin(f.directory)).rejects.toThrow('signature')
  })

  it('keeps interrupted installations blocked without removing their gate', async () => {
    const f = await fixture()
    const gate = join(f.directory, migrationGateFile)
    const bytes = JSON.stringify({ migrationId: f.pin.plan.migrationId })
    await writeFile(gate, bytes)
    await expect(assertMigrationReady(f.workspace, f.directory)).rejects.toThrow('This build cannot complete it')
    expect(await readFile(gate, 'utf8')).toBe(bytes)
  })

  it('rejects a reset accepted frontier or a descriptor from another baseline', async () => {
    const f = await fixture()
    const storeFile = join(f.directory, 'store', 'store.json')
    await writeFile(storeFile, JSON.stringify({ ...f.store, canonicalIds: [] }))
    await expect(assertMigrationReady(f.workspace, f.directory)).rejects.toThrow('frontier')
    await writeFile(storeFile, JSON.stringify(f.store))
    const descriptor = baselineDescriptor(f.pin.plan)
    await writeFile(join(f.workspace, '.taskcontinuum', 'workspace.json'), JSON.stringify({
      ...descriptor, trustBaseline: { migrationId: f.pin.plan.migrationId, planHash: '0'.repeat(64) },
    }))
    await expect(assertMigrationReady(f.workspace, f.directory)).rejects.toThrow('does not match')
  })

  it('rejects removed or altered preserved records and reintroduced retired records', async () => {
    const f = await fixture()
    const path = f.pin.plan.preserved[0].path
    const missing = new Map(f.files)
    missing.delete(path)
    expect(() => validateBaselineFiles(missing, f.pin)).toThrow('removed or changed')
    const changed = new Map(f.files)
    changed.set(path, { content: f.files.get(path)!.content + '\n' })
    expect(() => validateBaselineFiles(changed, f.pin)).toThrow('removed or changed')
    const reintroduced = new Map(f.files)
    reintroduced.set(recordPath(f.retired).replaceAll('\\', '/'), { content: serializeRecord(f.retired) })
    expect(() => validateBaselineFiles(reintroduced, f.pin)).toThrow('outside the approved')
  })
})
