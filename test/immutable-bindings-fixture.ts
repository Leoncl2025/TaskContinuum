import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentHostTarget } from '../src/shared/agentHost'
import type { RemoteRecord } from '../src/shared/remoteConfig'
import type { SessionOwner } from '../src/shared/sessionBindings'
import { sshFingerprint } from '../src/main/devTunnel/protocol'
import { registerRepositorySessionLinksBackend } from '../src/main/repositorySessionLinks'
import { appendRecord, canonicalJson, type RecordTrust } from '../src/main/remoteConfig/records'
import { RemoteConfigStore } from '../src/main/remoteConfig/store'

export const immutableWorkspaceId = '10000000-0000-4000-8000-000000000001'
export const immutableOwner: SessionOwner = { clientId: '00000000-0000-4000-8000-000000000001', machineName: 'Machine-B' }

export function immutableRecordSigner(index: number) {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, index)]), format: 'der', type: 'pkcs8' })
  const verificationKey = createPublicKey(key)
  const raw = verificationKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const publicKey = `ssh-ed25519 ${Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020', 'hex'), raw]).toString('base64')}`
  return {
    actor: { deviceId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, keyId: sshFingerprint(publicKey) },
    publicKey, verificationKey, sign: (bytes: Buffer) => sign(null, bytes, key),
  }
}

export function agentHostTargetFixture(session = 'one', owner = immutableOwner): AgentHostTarget {
  return { owner: { clientId: owner.clientId, machineName: owner.machineName }, sessionId: `copilotcli:/${session}`, chatId: `ahp-chat:/${session}` }
}

// Old signed records must reach the parser as untrusted input, not as SessionLink.
export function signedBindingFixture(target: unknown, author: Pick<ReturnType<typeof immutableRecordSigner>, 'actor' | 'sign'> = immutableRecordSigner(1), workspaceId = immutableWorkspaceId) {
  const body = {
    schemaVersion: 1, workspaceId, kind: 'binding', nonce: randomUUID(), createdAt: '2026-09-14T09:00:00.000Z',
    actor: author.actor, parents: [], payload: { action: 'set', taskId: 'T-0001', target },
  }
  const signingBytes = Buffer.from(`TaskCon.RemoteConfig.v1\n${canonicalJson(body)}`, 'utf8')
  const signed = { ...body, signature: { algorithm: 'ed25519', value: author.sign(signingBytes).toString('base64') } }
  return { ...signed, operationId: createHash('sha256').update(canonicalJson(signed)).digest('hex') }
}

export async function createImmutableBindingsFixture(workspaceRoot: string, options: { initialize?: boolean; workspaceId?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'continuum-immutable-bindings-'))
  const recordsRoot = join(home, 'replica'), outboxRoot = join(home, 'outbox'), stateDirectory = join(home, 'state')
  await Promise.all([workspaceRoot, recordsRoot, outboxRoot, stateDirectory].map((path) => mkdir(path, { recursive: true })))
  const author = immutableRecordSigner(1)
  const workspaceId = options.workspaceId ?? immutableWorkspaceId
  const trust: RecordTrust = {
    workspaceId,
    trustedKey: (actor) => actor.deviceId === author.actor.deviceId && actor.keyId === author.actor.keyId ? author.publicKey : undefined,
    authorize: () => true,
  }
  const store = new RemoteConfigStore({ workspaceRoot, recordsRoot, outboxRoot, stateDirectory, workspaceId, actor: author.actor, sign: author.sign, trust })
  const snapshot = options.initialize === false ? await store.read() : await store.initialize()
  const unregister = await registerRepositorySessionLinksBackend(workspaceRoot, store)
  return {
    store, snapshot, recordsRoot, outboxRoot, stateDirectory, unregister,
    importRecords: async (records: readonly RemoteRecord[]) => {
      for (const record of records) await appendRecord(recordsRoot, record, trust)
      return store.read()
    },
    close: async () => {
      unregister()
      await store.close()
      await rm(home, { recursive: true, force: true })
    },
  }
}
