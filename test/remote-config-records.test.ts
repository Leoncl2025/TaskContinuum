import { createHash, randomUUID, verify } from 'node:crypto'
import { link, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DevicePayload, RemoteRecord } from '../src/shared/remoteConfig'
import type { SessionLink } from '../src/shared/sessionBindings'
import {
  appendRecord, canonicalJson, createRecord, entityKey, parseRecord, readRecords, recordClosure, recordPath,
  resolvedSettings, resolveRecords, serializeRecord, verifyRecord, type RecordInput, type RecordTrust,
} from '../src/main/remoteConfig/records'
import { immutableRecordSigner as signer, signedBindingFixture } from './immutable-bindings-fixture'

const workspaceId = '10000000-0000-4000-8000-000000000001'
const at = '2026-09-14T09:00:00.000Z'
const a = signer(1)
const b = signer(2)
const c = signer(3)
const trust: RecordTrust = {
  workspaceId, trustedKey: (actor) => [a, b, c].find((device) => device.actor.deviceId === actor.deviceId)?.publicKey,
  authorize: () => true, now: () => Date.parse(at),
}
async function make(input: Omit<RecordInput, 'actor' | 'workspaceId'>, author = a): Promise<RemoteRecord> {
  return createRecord({ ...input, actor: author.actor, workspaceId, createdAt: at } as RecordInput, author.sign)
}
function target(session = 'one', owner = b): SessionLink {
  return { provider: 'agent-host', owner: { clientId: owner.actor.deviceId, machineName: `machine-${owner.actor.deviceId.at(-1)}` }, hostId: 'host-main', sessionId: `copilotcli:/${session}`, chatId: `ahp-chat:/${session}` }
}
function identity(device = a): DevicePayload {
  return {
    action: 'publish', deviceId: device.actor.deviceId,
    identity: { username: 'test-user', machineName: 'test-machine', clientPublicKey: device.publicKey, hostPublicKey: device.publicKey, clientKeyId: device.actor.keyId, hostKeyId: device.actor.keyId },
    routes: [{ kind: 'dev-tunnel', tunnelId: 'test-route.use', sshPort: 2200, controlPort: 2201 }],
  }
}
const directories: string[] = []
async function folder(): Promise<string> {
  const directory = join(process.cwd(), 'artifacts', `remote-records-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  directories.push(directory)
  return directory
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

describe('canonical signed immutable remote records', () => {
  it('canonicalizes sorted JSON without lossy coercion or non-JSON values', () => {
    expect(canonicalJson({ z: [1, -0, true, null], a: { z: '😀', a: 'line\nbreak' } })).toBe('{"a":{"a":"line\\nbreak","z":"😀"},"z":[1,0,true,null]}')
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    for (const value of [undefined, NaN, Infinity, 1.5, new Date(), cycle, ['\uD800'], [undefined], JSON.parse('{"__proto__":{}}')]) {
      expect(() => canonicalJson(value)).toThrow()
    }
  })

  it('signs canonical bytes once and deduplicates parent ordering and retries', async () => {
    const nonce = randomUUID()
    const first = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target() }, nonce, parents: ['c'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)] })
    const second = await make({ parents: ['b'.repeat(64), 'c'.repeat(64)], nonce, payload: { target: target(), taskId: 'T-0001', action: 'set' }, kind: 'binding' })
    expect(second).toEqual(first)
    expect(first.parents).toEqual(['b'.repeat(64), 'c'.repeat(64)])
    expect(await verifyRecord(first, trust)).toEqual(first)
    expect(first.operationId).toMatch(/^[a-f0-9]{64}$/)
    expect(serializeRecord(first)).toBe(canonicalJson(first) + '\n')
  })

  it('rejects forged signatures, changed content, unknown fields and untrusted keys', async () => {
    const good = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target() } })
    await expect(verifyRecord({ ...good, createdAt: '2026-09-14T08:00:00.000Z' }, trust)).rejects.toThrow('hash')
    const forged = await createRecord({ kind: 'binding', payload: { action: 'delete', taskId: 'T-0001' }, workspaceId, actor: a.actor }, () => Buffer.alloc(64))
    await expect(verifyRecord(forged, trust)).rejects.toThrow('signature')
    await expect(verifyRecord(good, { ...trust, trustedKey: () => b.publicKey })).rejects.toThrow('fingerprint')
    await expect(verifyRecord(good, { ...trust, trustedKey: () => undefined })).rejects.toThrow('not trusted')
    await expect(verifyRecord(good, { ...trust, workspaceId: b.actor.deviceId })).rejects.toThrow('different')
    await expect(verifyRecord({ ...good, privateKey: 'not-permitted' }, trust)).rejects.toThrow('schema')
    await expect(verifyRecord({ ...good, schemaVersion: 2 }, trust)).rejects.toThrow('schema')
    if (good.kind === 'binding' && good.payload.action === 'set' && good.payload.target.owner) {
      const normalized = { ...good, payload: { ...good.payload, target: { ...good.payload.target, owner: { ...good.payload.target.owner, machineName: ' machine-2 ' } } } }
      await expect(verifyRecord(normalized, trust)).rejects.toThrow('normalization')
    }
  })

  it('accepts only explicitly injected map pins and verifies their fingerprint and editor policy', async () => {
    const record = await make({ kind: 'binding', payload: { action: 'delete', taskId: 'T-0001' } })
    expect(await verifyRecord(record, { ...trust, trustedKey: new Map([[a.actor.deviceId, a.publicKey]]) })).toEqual(record)
    expect(await verifyRecord(record, { ...trust, trustedKey: new Map([[`${a.actor.deviceId}:${a.actor.keyId}`, a.publicKey]]) })).toEqual(record)
    await expect(verifyRecord(record, { ...trust, trustedKey: new Map() })).rejects.toThrow('not trusted')
    await expect(verifyRecord(record, { ...trust, trustedKey: new Map([[a.actor.deviceId, b.publicKey]]) })).rejects.toThrow('fingerprint')
    await expect(verifyRecord(record, { ...trust, trustedKey: new Map([[a.actor.deviceId, a.publicKey]]), authorize: () => false })).rejects.toThrow('does not authorize')
  })

  it.each([
    { name: 'GitHub Copilot', target: { provider: 'github-copilot', sessionId: 'original', owner: target().owner } },
    { name: 'VS Code Copilot', target: { provider: 'vscode-copilot', sessionId: 'original', workspaceStorageId: 'a'.repeat(32), owner: target().owner } },
    { name: 'ownerless Agent Host', target: { provider: 'agent-host', hostId: 'host-main', sessionId: 'copilotcli:/original', chatId: 'ahp-chat:/original' } },
  ])('rejects $name in correctly signed historical records instead of enabling legacy compatibility', async ({ target: value }) => {
    const invalid: unknown = value
    const author = signer(1)
    const old = signedBindingFixture(invalid, author, workspaceId)
    const { operationId, signature, ...body } = old
    const bytes = Buffer.from(`TaskCon.RemoteConfig.v1\n${canonicalJson(body)}`, 'utf8')
    expect(verify(null, bytes, author.verificationKey, Buffer.from(signature.value, 'base64'))).toBe(true)
    expect(operationId).toBe(createHash('sha256').update(canonicalJson({ ...body, signature })).digest('hex'))
    expect(() => parseRecord(old)).toThrow('schema')
    await expect(verifyRecord(old, trust)).rejects.toThrow('schema')
    const resolved = await resolveRecords([old], trust)
    expect(resolved.bindings).toEqual({})
    expect(resolved.blocked).toBe(true)
    expect(resolved.diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid-record' }))
    await expect(Reflect.apply(createRecord, undefined, [{
      kind: 'binding', workspaceId, actor: author.actor, payload: { action: 'set', taskId: 'T-0001', target: invalid },
    }, author.sign])).rejects.toThrow()
    const modern = signedBindingFixture(target(), author, workspaceId)
    expect(await verifyRecord(modern, trust)).toEqual(modern)
  })

  it('excludes bearer credentials, private key fields, arbitrary commands and SSH setting dictionaries', async () => {
    const good = await make({ kind: 'device', payload: identity() })
    for (const payload of [
      { ...good.payload, privateKey: 'secret' },
      { ...identity(), routes: [{ kind: 'dev-tunnel', tunnelId: 'test-route.use', sshPort: 2200, token: 'secret' }] },
      { ...identity(), identity: { ...(identity() as Extract<DevicePayload, { action: 'publish' }>).identity, encryptedPrivateKey: 'secret' } },
      { ...identity(), identity: { ...(identity() as Extract<DevicePayload, { action: 'publish' }>).identity, username: '-----BEGIN PRIVATE KEY----- secret' } },
    ]) await expect(createRecord({ kind: 'device', payload, workspaceId, actor: a.actor } as RecordInput, a.sign)).rejects.toThrow()
    for (const settingKey of ['sshConfig', 'pollIntervalMs', 'privateKey', 'command']) {
      await expect(createRecord({ kind: 'setting', workspaceId, actor: a.actor, payload: { action: 'set', scope: 'workspace', settingKey, value: 15000 } } as unknown as RecordInput, a.sign)).rejects.toThrow()
    }
  })

  it('unions different entity edits identically across independent replicas and orderings', async () => {
    const first = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target('one') } })
    const second = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0002', target: target('two') } }, b)
    const setting = await make({ kind: 'setting', payload: { action: 'set', scope: 'workspace', settingKey: 'autoLink', value: false } }, c)
    const left = await folder()
    const right = await folder()
    for (const root of [left, right]) for (const record of root === left ? [first, second, setting] : [setting, second, first]) await appendRecord(root, record, trust)
    const resolved = await resolveRecords(await readRecords(left), trust)
    expect(await resolveRecords(await readRecords(right), trust)).toEqual(resolved)
    expect(Object.keys(resolved.bindings).sort()).toEqual(['T-0001', 'T-0002'])
    expect(resolved.bindings['T-0001']).toEqual(target('one'))
    expect(resolved.bindings['T-0002']).toEqual(target('two'))
    expect(resolvedSettings(resolved, a.actor.deviceId).autoLink).toBe(false)
  })

  it('keeps same-task conflicts, set/delete races and late offline edits without selecting a clock winner', async () => {
    const base = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target('old') } })
    const left = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target('new') }, parents: [base.operationId] })
    const right = await make({ kind: 'binding', payload: { action: 'delete', taskId: 'T-0001' }, parents: [base.operationId] }, b)
    const conflicted = await resolveRecords([base, right, left], trust)
    expect(conflicted.bindings).toEqual({})
    expect(conflicted.entities['binding:T-0001'].state).toBe('needs-resolution')
    expect(conflicted.heads['binding:T-0001']).toEqual([left.operationId, right.operationId].sort())
    const resolution = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target('resolved') }, parents: conflicted.heads['binding:T-0001'] })
    expect((await resolveRecords([resolution, right, base, left], trust)).bindings['T-0001']).toEqual(target('resolved'))
    const late = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target('offline') }, parents: [base.operationId] }, c)
    expect((await resolveRecords([resolution, right, base, left, late], trust)).bindings).toEqual({})
  })

  it('coalesces equal semantic heads while preserving every operation and tombstone', async () => {
    const one = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target() } })
    const two = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target() } }, b)
    const equal = await resolveRecords([one, two, one], trust)
    expect(equal.records).toHaveLength(2)
    expect(equal.heads['binding:T-0001']).toHaveLength(2)
    expect(equal.bindings['T-0001']).toEqual(target())
    const remove = await make({ kind: 'binding', payload: { action: 'delete', taskId: 'T-0001' }, parents: equal.heads['binding:T-0001'] })
    const deleted = await resolveRecords([remove, two, one], trust)
    expect(deleted.bindings).toEqual({})
    expect(deleted.entities['binding:T-0001'].state).toBe('deleted')
    expect(deleted.records).toHaveLength(3)
  })

  it('disables every task claiming one canonical session, including different chat IDs', async () => {
    const one = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target() } })
    const two = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0002', target: { ...target(), chatId: 'ahp-chat:/different' } } }, b)
    const separate = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0003', target: target('separate') } })
    const conflicted = await resolveRecords([one, two, separate], trust)
    expect(Object.keys(conflicted.bindings)).toEqual(['T-0003'])
    expect(conflicted.entities['binding:T-0001'].state).toBe('needs-resolution')
    expect(conflicted.entities['binding:T-0002'].state).toBe('needs-resolution')
    const remove = await make({ kind: 'binding', payload: { action: 'delete', taskId: 'T-0001' }, parents: [one.operationId] })
    expect((await resolveRecords([one, two, separate, remove], trust)).bindings['T-0002']).toEqual({ ...target(), chatId: 'ahp-chat:/different' })
    const concurrent = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target('other') } }, b)
    expect((await resolveRecords([one, two, concurrent], trust)).bindings).toEqual({})
  })

  it('fails closed for unavailable and cross-entity causal dependencies, but preserves unaffected entities', async () => {
    const good = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target() } })
    const old = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0002', target: target('old') } })
    const missing = await make({ kind: 'binding', payload: { action: 'delete', taskId: 'T-0002' }, parents: ['e'.repeat(64)] })
    const resolution = await resolveRecords([good, old, missing], trust)
    expect(resolution.bindings).toEqual({ 'T-0001': target() })
    expect(resolution.entities['binding:T-0002'].state).toBe('blocked')
    expect(() => recordClosure(missing, [good, old])).toThrow('closure')
    const wrong = await make({ kind: 'binding', payload: { action: 'delete', taskId: 'T-0002' }, parents: [good.operationId] })
    expect((await resolveRecords([good, old, wrong], trust)).entities['binding:T-0002'].state).toBe('blocked')
    expect((await resolveRecords([good, { ...old, schemaVersion: 2 }], trust)).bindings).toEqual({})
    expect(await resolveRecords([missing, old, good], trust)).toEqual(resolution)
  })

  it('enforces task, owner and writer permission callbacks and forbids implicit ownership transfer', async () => {
    const base = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target() } })
    expect((await resolveRecords([base], { ...trust, authorize: () => false })).bindings).toEqual({})
    const changed = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target('one', c) }, parents: [base.operationId] })
    expect((await resolveRecords([base, changed], trust)).diagnostics.some((entry) => entry.code === 'ownership-transfer')).toBe(true)
    const wrongDevice = await make({ kind: 'device', payload: identity(b) })
    await expect(verifyRecord(wrongDevice, trust)).rejects.toThrow('owning device')
    const wrongSetting = await make({ kind: 'setting', payload: { action: 'set', scope: 'device', deviceId: b.actor.deviceId, settingKey: 'autoLink', value: true } })
    await expect(verifyRecord(wrongSetting, trust)).rejects.toThrow('owning device')
  })

  it('blocks safety-setting conflicts rather than falling through to permissive defaults', async () => {
    const yes = await make({ kind: 'setting', payload: { action: 'set', scope: 'workspace', settingKey: 'autoLink', value: true } })
    const no = await make({ kind: 'setting', payload: { action: 'delete', scope: 'workspace', settingKey: 'autoLink' } }, b)
    const device = await make({ kind: 'setting', payload: { action: 'set', scope: 'device', deviceId: a.actor.deviceId, settingKey: 'autoLink', value: true } })
    const resolution = await resolveRecords([yes, no, device], trust)
    expect(resolution.entities[entityKey(yes)].state).toBe('needs-resolution')
    expect(resolvedSettings(resolution, a.actor.deviceId).autoLink).toBe(false)
    expect((await resolveRecords([device, no, yes], trust)).revision).toBe(resolution.revision)
  })

  it('uses exact identity revisions, recipient proof and sticky grant revocation with deliberate regrant', async () => {
    const issuer = await make({ kind: 'device', payload: identity(a) })
    const recipient = await make({ kind: 'device', payload: identity(b) }, b)
    const payload = {
      action: 'grant' as const, issuerId: a.actor.deviceId, recipientId: b.actor.deviceId, grantId: randomUUID(),
      issuerIdentityRef: issuer.operationId, recipientIdentityRef: recipient.operationId,
      capability: 'ah-link' as const, issuedAt: at, expiresAt: '2026-09-14T10:00:00.000Z',
      routeRef: { identityRef: issuer.operationId, routeIndex: 0 },
    }
    const grant = await make({ kind: 'invitation', payload })
    expect(Object.values((await resolveRecords([issuer, recipient, grant], trust)).invitations)).toEqual([grant])
    const revoke = await make({ kind: 'invitation', parents: [grant.operationId], payload: {
      action: 'revoke', issuerId: payload.issuerId, recipientId: payload.recipientId, grantId: payload.grantId,
      issuerIdentityRef: issuer.operationId, recipientIdentityRef: recipient.operationId, revokes: grant.operationId,
    } })
    const replay = await make({ kind: 'invitation', payload, parents: [grant.operationId] })
    expect((await resolveRecords([replay, revoke, issuer, recipient, grant], trust)).invitations).toEqual({})
    const regrant = await make({ kind: 'invitation', payload: { ...payload, grantId: randomUUID() }, parents: [revoke.operationId, replay.operationId] })
    expect(Object.values((await resolveRecords([regrant, replay, revoke, issuer, recipient, grant], trust)).invitations)).toEqual([regrant])
    const expired = await resolveRecords([issuer, recipient, grant], { ...trust, now: () => Date.parse('2026-09-14T10:00:01.000Z') })
    expect(expired.invitations).toEqual({})
    expect(expired.entities[entityKey(grant)].state).toBe('expired')
    await expect(verifyRecord(grant, { ...trust, maximumInvitationLifetimeMs: 1000 })).rejects.toThrow('lifetime')
  })

  it('does not reactivate removed identities, and requires explicit policy for key rotation', async () => {
    const original = await make({ kind: 'device', payload: identity(a) })
    const remove = await make({ kind: 'device', payload: { action: 'remove', deviceId: a.actor.deviceId }, parents: [original.operationId] })
    const republish = await make({ kind: 'device', payload: identity(a), parents: [remove.operationId] })
    const binding = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target('one', a) } }, b)
    const blocked = await resolveRecords([original, remove, republish, binding], trust)
    expect(blocked.devices[a.actor.deviceId]).toBeUndefined()
    expect(blocked.bindings).toEqual({})
    const payload = identity(a) as Extract<DevicePayload, { action: 'publish' }>
    payload.identity = { ...payload.identity, clientPublicKey: c.publicKey, clientKeyId: c.actor.keyId }
    const rotated = await make({ kind: 'device', payload, parents: [original.operationId] })
    expect((await resolveRecords([original, rotated], trust)).entities[entityKey(original)].state).toBe('blocked')
    expect((await resolveRecords([original, rotated], { ...trust, allowKeyRotation: () => true })).devices[a.actor.deviceId]).toEqual(rotated)
  })

  it('retains incomplete historical identities but blocks automatic links with an actionable diagnostic', async () => {
    for (const missing of ['username', 'controlPort'] as const) {
      const payload = identity(a) as Extract<DevicePayload, { action: 'publish' }>
      if (missing === 'username') delete payload.identity.username
      else delete payload.routes[0].controlPort
      const old = await make({ kind: 'device', payload })
      const peer = await make({ kind: 'device', payload: identity(b) }, b)
      const grant = await make({ kind: 'invitation', payload: {
        action: 'grant', issuerId: a.actor.deviceId, recipientId: b.actor.deviceId, grantId: randomUUID(),
        issuerIdentityRef: old.operationId, recipientIdentityRef: peer.operationId, capability: 'ah-link',
        issuedAt: at, expiresAt: '2026-09-14T10:00:00.000Z', routeRef: { identityRef: old.operationId, routeIndex: 0 },
      } })
      const bound = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target() } })
      expect(await verifyRecord(old, trust)).toEqual(old)
      const before = await resolveRecords([old, peer, grant, bound], trust)
      expect(before.records).toContainEqual(old)
      expect(before.blocked).toBe(false)
      expect(before.devices[a.actor.deviceId]).toBeUndefined()
      expect(before.devices[b.actor.deviceId]).toEqual(peer)
      expect(before.invitations).toEqual({})
      expect(before.diagnostics).toContainEqual(expect.objectContaining({ code: 'incomplete-device-publication', entityKey: `device:${a.actor.deviceId}` }))
      expect(before.diagnostics).toContainEqual(expect.objectContaining({ code: 'incomplete-link-metadata' }))
      expect(before.bindings['T-0001']).toEqual(target())
      const current = await make({ kind: 'device', payload: identity(a), parents: [old.operationId] })
      const refreshed = await resolveRecords([old, current, peer, grant, bound], trust)
      expect(refreshed.devices[a.actor.deviceId]).toEqual(current)
      expect(refreshed.records).toContainEqual(old)
      expect(refreshed.diagnostics.some((diagnostic) => diagnostic.code === 'incomplete-device-publication')).toBe(false)
      expect(refreshed.invitations).toEqual({})
    }
  })

  it('creates exact hash-addressed files only once and refuses collisions, mutations and moved entity paths', async () => {
    const root = await folder()
    expect(await readRecords(join(root, 'not-yet-created-outbox'))).toEqual([])
    const record = await make({ kind: 'binding', payload: { action: 'set', taskId: 'T-0001', target: target() } })
    expect((await appendRecord(root, record, trust)).created).toBe(true)
    expect((await appendRecord(root, record, trust)).created).toBe(false)
    expect(await readRecords(root, trust)).toEqual([record])
    const file = join(root, recordPath(record))
    await writeFile(file, `${canonicalJson(record)} \n`)
    await expect(appendRecord(root, record)).rejects.toThrow('different bytes')
    await expect(readRecords(root)).rejects.toThrow('canonical')
    await writeFile(file, serializeRecord(record))
    await rename(file, join(dirname(file), 'f'.repeat(64) + '.json'))
    await expect(readRecords(root)).rejects.toThrow('filename')
  })

  it('rejects filesystem links and hard links before reading or writing public records', async () => {
    const root = await folder()
    const outside = await folder()
    await symlink(outside, join(root, '.taskcontinuum'), process.platform === 'win32' ? 'junction' : 'dir')
    const record = await make({ kind: 'binding', payload: { action: 'delete', taskId: 'T-0001' } })
    await expect(appendRecord(root, record)).rejects.toThrow('filesystem links')
    const safe = await folder()
    await appendRecord(safe, record)
    const file = join(safe, recordPath(record))
    await link(file, join(outside, 'hard-linked-record.json'))
    await expect(readRecords(safe)).rejects.toThrow('hard links')
    await expect(appendRecord(safe, record)).rejects.toThrow('hard links')
    expect(await readFile(file, 'utf8')).toBe(serializeRecord(record))
  })

  it('bounds record counts, bytes and notification dependency closures without dropping records', async () => {
    const record = await make({ kind: 'binding', payload: { action: 'delete', taskId: 'T-0001' } })
    await expect(resolveRecords(Array.from({ length: 10001 }, () => record), trust)).rejects.toThrow('10,000')
    await expect(verifyRecord({ ...record, extra: 'x'.repeat(33000) }, trust)).rejects.toThrow('32 KiB')
    const child = await make({ kind: 'binding', payload: { action: 'delete', taskId: 'T-0001' }, parents: [record.operationId] })
    expect(() => recordClosure(child, [record], 0)).toThrow('limit')
    const root = await folder()
    await appendRecord(root, record)
    await writeFile(join(root, recordPath(record)), 'x'.repeat(33000))
    await expect(readRecords(root)).rejects.toThrow('byte limit')
  })
})
