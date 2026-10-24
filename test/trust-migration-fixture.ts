import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ssh2 from 'ssh2'
import { newSshKeyPair } from '../src/main/devTunnel/sessionSsh'
import { sshFingerprint } from '../src/main/devTunnel/protocol'
import { canonicalJson, createRecord, type RecordSigner } from '../src/main/remoteConfig/records'
import { checkoutOwnerIdentity } from '../src/main/remoteConfig/git'
import { bytesHash, contentHash } from '../src/main/remoteConfig/trustBaseline'
import { gitPublicFiles, gitText, inspectRepository } from '../src/main/migration/git'
import { normalizedRoot, syncDirectory, type MigrationHostOptions } from '../src/main/migration/local'
import { migrationRecordPath, type MigrationRecord } from '../src/main/migration/legacyRecords'
import { immutableWorkspaceId } from './immutable-bindings-fixture'

export const migrationTestCode = 'a'.repeat(40)
export const fixtureProtector = { available: () => true, decrypt: (bytes: Buffer) => bytes.toString('utf8') }
export async function writeFixtureJson(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}
export async function migrationFixture(onRoot?: (root: string) => void) {
  const root = await mkdtemp(join(tmpdir(), 'tc-trust-migration-'))
  onRoot?.(root)
  const remote = join(root, 'remote.git')
  const seed = join(root, 'seed')
  await gitText(root, 'init', '--bare', '--quiet', '--initial-branch=team/migration', remote)
  await gitText(root, 'clone', '--quiet', remote, seed)
  await gitText(seed, 'config', 'core.autocrlf', 'false')
  await gitText(seed, 'config', 'user.name', 'Migration fixture')
  await gitText(seed, 'config', 'user.email', 'fixture@localhost')
  const workspace = join(seed, 'Work')
  await writeFixtureJson(join(workspace, '.agentdesk', 'config.json'), { schemaVersion: '1.0', workspace: 'Fixture', paths: { tasks: 'tasks' } })
  await writeFixtureJson(join(workspace, 'tasks', 'T-0001-fixture', 'task.json'), { schemaVersion: '1.0', id: 'T-0001' })
  await writeFile(join(seed, 'notes.txt'), 'Keep original task data.\n')
  const now = Date.now()
  const at = new Date(now - 1000).toISOString()
  const devices = [1, 2, 3].map((index) => {
    const client = newSshKeyPair(), host = newSshKeyPair()
    const parsed = ssh2.utils.parseKey(client.privateKey)
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Fixture SSH key')
    const sign: RecordSigner = (bytes) => { const result = parsed.sign(bytes); if (result instanceof Error) throw result; return result }
    return { id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, name: `Fixture-${index}`, client, host, sign }
  })
  const publications = await Promise.all(devices.map((d, index) => createRecord({
    kind: 'device', workspaceId: immutableWorkspaceId, actor: { deviceId: d.id, keyId: sshFingerprint(d.client.publicKey) }, createdAt: at,
    payload: { action: 'publish', deviceId: d.id,
      identity: { username: 'fixture', machineName: d.name, clientPublicKey: d.client.publicKey, hostPublicKey: d.host.publicKey, clientKeyId: sshFingerprint(d.client.publicKey), hostKeyId: sshFingerprint(d.host.publicKey) },
      routes: [{ kind: 'dev-tunnel', tunnelId: `fixture-${index}.test`, sshPort: 2200 + index, controlPort: 2300 + index }] },
  }, d.sign)))
  const owner = devices[1]
  const binding = await createRecord({
    kind: 'binding', workspaceId: immutableWorkspaceId, actor: { deviceId: owner.id, keyId: sshFingerprint(owner.client.publicKey) }, createdAt: at,
    payload: { schemaVersion: '2.1', action: 'set', taskId: 'T-0001', targets: [{ provider: 'agent-host', owner: { clientId: owner.id, machineName: owner.name }, sessionId: 'copilotcli:/existing-fixture-session', chatId: 'ahp-chat:/existing-fixture-chat' }] },
  }, owner.sign)
  const alias = await createRecord({
    kind: 'alias', workspaceId: immutableWorkspaceId, actor: { deviceId: devices[0].id, keyId: sshFingerprint(devices[0].client.publicKey) }, createdAt: at,
    payload: { action: 'set', deviceId: devices[0].id, alias: 'Existing alias' },
  }, devices[0].sign)
  const removal = await createRecord({
    kind: 'device', workspaceId: immutableWorkspaceId, actor: { deviceId: devices[2].id, keyId: sshFingerprint(devices[2].client.publicKey) }, createdAt: at,
    parents: [publications[2].operationId], payload: { action: 'remove', deviceId: devices[2].id },
  }, devices[2].sign)
  async function legacy(issuer: number, recipient: number, parents: string[] = [], expired = false): Promise<MigrationRecord> {
    const d = devices[issuer]
    const issuedAt = new Date(now - (expired ? 90000000 : 60000)).toISOString()
    const body = {
      schemaVersion: 1 as const, kind: 'invitation' as const, workspaceId: immutableWorkspaceId,
      actor: { deviceId: d.id, keyId: sshFingerprint(d.client.publicKey) }, nonce: randomUUID(), createdAt: issuedAt, parents,
      payload: { action: 'grant' as const, capability: 'ah-link' as const, issuerId: d.id, recipientId: devices[recipient].id, grantId: randomUUID(),
        issuerIdentityRef: publications[issuer].operationId, recipientIdentityRef: publications[recipient].operationId,
        issuedAt, expiresAt: new Date(Date.parse(issuedAt) + 86400000).toISOString(), routeRef: { identityRef: publications[issuer].operationId, routeIndex: 0 } },
    }
    const signed = await d.sign(Buffer.from(`TaskCon.RemoteConfig.v1\n${canonicalJson(body)}`))
    const record = { ...body, signature: { algorithm: 'ed25519' as const, value: typeof signed === 'string' ? signed : signed.toString('base64') } }
    return { ...record, operationId: contentHash(record) }
  }
  const first = await legacy(0, 1, [], true)
  const second = await legacy(0, 1, [first.operationId])
  const reciprocal = await legacy(1, 0)
  const revoked = await legacy(0, 2)
  if (revoked.kind !== 'invitation') throw new Error('Fixture invitation')
  const tombstone = await createRecord({
    kind: 'invitation', workspaceId: immutableWorkspaceId, actor: { deviceId: devices[0].id, keyId: sshFingerprint(devices[0].client.publicKey) },
    createdAt: at, parents: [revoked.operationId],
    payload: { action: 'revoke', issuerId: devices[0].id, recipientId: devices[2].id, grantId: revoked.payload.grantId,
      issuerIdentityRef: publications[0].operationId, recipientIdentityRef: publications[2].operationId, revokes: revoked.operationId },
  }, devices[0].sign)
  const records = [...publications, binding, alias, removal, first, second, reciprocal, revoked, tombstone]
  for (const record of records) {
    const file = join(workspace, ...migrationRecordPath(record).split('/'))
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, canonicalJson(record) + '\n')
  }
  await writeFixtureJson(join(workspace, '.taskcontinuum', 'workspace.json'), { schemaVersion: 1, kind: 'taskcontinuum-workspace', workspaceId: immutableWorkspaceId, remoteConfigFormat: 'immutable-operations-v1' })
  await gitText(seed, 'add', '--', '.')
  await gitText(seed, '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Original signed fixture history')
  await gitText(seed, 'push', '--quiet', '-u', 'origin', 'team/migration')
  const hosts = []
  for (let index = 0; index < 2; index++) {
    const d = devices[index], peer = devices[1 - index]
    const checkout = join(root, `host-${index}`)
    await gitText(root, 'clone', '--quiet', '--config', 'core.autocrlf=false', remote, checkout)
    await gitText(checkout, 'config', 'core.autocrlf', 'false')
    const workspaceRoot = await realpath(join(checkout, 'Work'))
    const repository = await inspectRepository(workspaceRoot)
    const profileRoot = join(root, `profile-${index}`)
    await mkdir(profileRoot)
    const directory = syncDirectory(profileRoot, workspaceRoot)
    await mkdir(join(directory, 'store'), { recursive: true })
    await mkdir(join(directory, 'outbox'), { recursive: true })
    const replicaName = `checkout-v2-${bytesHash(JSON.stringify([workspaceRoot, repository.fetchUrl, repository.pushUrl]))}`
    const replica = join(directory, replicaName)
    await mkdir(replica)
    const pins = Object.fromEntries(devices.map((device, i) => [device.id, { clientPublicKey: device.client.publicKey, hostPublicKey: device.host.publicKey, blocked: i === 2,
      ...(i === 2 ? { acceptedOperations: [publications[2].operationId, removal.operationId] } : {}) }]))
    await writeFixtureJson(join(profileRoot, 'git-workspace-enrollments.json'), { schemaVersion: 1, workspaces: [{ root: normalizedRoot(workspaceRoot), workspaceId: immutableWorkspaceId, enabled: true, admitNewDevices: true, pins }] })
    await writeFixtureJson(join(profileRoot, 'remote-vscode-identity.json'), { clientId: d.id })
    for (const purpose of ['client', 'host'] as const) await writeFixtureJson(join(profileRoot, `dev-tunnel-${purpose}-identity.json`), { schemaVersion: 1, publicKey: d[purpose].publicKey, encryptedPrivateKey: Buffer.from(d[purpose].privateKey).toString('base64') })
    const pairId = randomUUID(), remotePairId = randomUUID()
    const participant = { clientId: peer.id, machineName: peer.name, username: 'fixture' }
    const expiresAt = new Date(now + 86400000 * 29).toISOString()
    const encrypted = (value: unknown) => ({ encrypted: Buffer.from(JSON.stringify(value)).toString('base64') })
    await writeFixtureJson(join(profileRoot, 'remote-vscode-device-host.json'), encrypted({ ownerId: randomUUID(), pairs: [{
      id: pairId, participant, publicKey: peer.client.publicKey, token: randomBytes(32).toString('base64url'), expiresAt,
      workspaces: [{ root: normalizedRoot(workspaceRoot), canSend: index === 1 }],
    }] }))
    await writeFixtureJson(join(profileRoot, 'remote-vscode-devices.json'), encrypted([{
      id: randomUUID(), root: normalizedRoot(workspaceRoot), enabled: true,
      invitation: { schemaVersion: 2, provider: 'vscode-copilot-device', id: remotePairId, ownerId: randomUUID(), ownerClientId: peer.id, machineName: peer.name,
        participant: { clientId: d.id, username: 'fixture', machineName: d.name }, expiresAt, token: randomBytes(32).toString('base64url'), port: 3001,
        devTunnel: { kind: 'dev-tunnel', tunnelId: 'fixture-peer.test', sshPort: 2200, hostPublicKey: peer.host.publicKey, clientPublicKey: d.client.publicKey } },
    }]))
    await writeFixtureJson(join(profileRoot, 'local-session-link-receipts.json'), { schemaVersion: 2, receipts: index === 1 ? [{
      root: normalizedRoot(workspaceRoot), taskId: 'T-0001', owner: { clientId: d.id, machineName: d.name },
      identity: { sessionId: 'copilotcli:/existing-fixture-session', chatId: 'ahp-chat:/existing-fixture-chat' },
    }] : [] })
    await writeFixtureJson(join(profileRoot, 'agent-host-consents.json'), [])
    await writeFixtureJson(join(profileRoot, 'workspaces.json'), { currentId: 'fixture', recent: [] })
    await writeFixtureJson(join(directory, 'runtime.json'), { schemaVersion: 2, workspaceId: immutableWorkspaceId, recordsRoot: join(directory, 'records-cache'), controlPort: 2300 + index, managedPairs: { [peer.id]: pairId } })
    await writeFixtureJson(join(directory, 'settings.json'), { schemaVersion: 1, revision: null, values: { autoLink: true, tunnelEnabled: true, connectTimeoutMs: 45000 } })
    await writeFile(join(directory, 'settings.json.baseline'), await readFile(join(directory, 'settings.json')))
    await writeFixtureJson(join(directory, 'store', 'store.json'), { schemaVersion: 1, workspaceId: immutableWorkspaceId, initialized: true, canonicalIds: records.map((r) => r.operationId).sort(), localIds: records.filter((r) => r.actor.deviceId === d.id).map((r) => r.operationId).sort() })
    await writeFixtureJson(join(directory, 'store', 'binding-overlays.json'), { schemaVersion: 1, workspaceId: immutableWorkspaceId, markers: [] })
    await writeFile(join(directory, 'git-hooks-disabled'), '')
    for (const record of records) {
      const path = migrationRecordPath(record)
      const cache = join(directory, 'records-cache', ...path.split('/'))
      await mkdir(join(cache, '..'), { recursive: true })
      await writeFile(cache, canonicalJson(record) + '\n')
      if (record.actor.deviceId === d.id) {
        const outbox = join(directory, 'outbox', ...path.split('/'))
        await mkdir(join(outbox, '..'), { recursive: true })
        await writeFile(outbox, canonicalJson(record) + '\n')
      }
    }
    await writeFile(join(replica, 'owner.json'), checkoutOwnerIdentity(workspaceRoot, repository.repositoryRoot, { remote: repository.remote, branch: repository.remoteBranch.slice(11), fetchUrl: repository.fetchUrl, pushUrl: repository.pushUrl }))
    await writeFixtureJson(join(replica, 'publications.json'), [...await gitPublicFiles(repository, repository.head)].map(([path, file]) => ({ path, content: file.content })))
    await gitText(repository.repositoryRoot, 'update-ref', `${repository.refPrefix}/accepted`, repository.head)
    await gitText(repository.repositoryRoot, 'update-ref', repository.targetRef, repository.head)
    const options: MigrationHostOptions = { workspaceRoot, profileRoot, codeCommit: migrationTestCode, protector: fixtureProtector, now: () => now }
    hosts.push({ ...options, directory, repository, checkpointRoot: join(root, `checkpoint-${index}`), assertStopped: async () => {}, device: d })
  }
  return { root, remote, seed, workspace, now, records, devices, hosts, sourceCommit: await gitText(seed, 'rev-parse', 'HEAD') }
}
