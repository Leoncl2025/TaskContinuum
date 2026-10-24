import { lstat, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { z } from 'zod'
import type { RemoteRecord } from '../../shared/remoteConfig'
import { sshFingerprint } from '../devTunnel/protocol'
import {
  canonicalJson, entityKey, operationIdSchema, parseRecord, readCheckedFile, recordDependencies,
  remoteRecordHeaderSchema, remoteRecordSignatureSchema, RemoteConfigError, resolveRecords, verifyRecord, type RecordTrust,
} from '../remoteConfig/records'
import { bytesHash, contentHash, verifyDocument } from '../remoteConfig/trustBaseline'

const uuid = z.uuid().regex(/^[a-f0-9-]+$/)
const legacyInvitationSchema = z.object({
  ...remoteRecordHeaderSchema.shape, kind: z.literal('invitation'),
  payload: z.object({
    action: z.literal('grant'), capability: z.literal('ah-link'), issuerId: uuid, recipientId: uuid, grantId: uuid,
    issuerIdentityRef: operationIdSchema, recipientIdentityRef: operationIdSchema,
    issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
    routeRef: z.object({ identityRef: operationIdSchema, routeIndex: z.number().int().min(0).max(7) }).strict(),
  }).strict(), operationId: operationIdSchema, signature: remoteRecordSignatureSchema,
}).strict()
export type LegacyInvitation = z.infer<typeof legacyInvitationSchema>
export type MigrationRecord = RemoteRecord | LegacyInvitation
export interface MigrationFile { path: string; content: string; record: MigrationRecord; sha256: string }
export interface LegacyTrust {
  workspaceId: string
  pins: Record<string, { clientPublicKey: string; hostPublicKey: string; blocked: boolean; acceptedOperations?: string[] }>
  now: number
}

export function parseMigrationRecord(input: unknown): MigrationRecord {
  if (input && typeof input === 'object' && 'kind' in input && input.kind === 'invitation'
    && 'payload' in input && input.payload && typeof input.payload === 'object' && 'expiresAt' in input.payload) {
    const record = legacyInvitationSchema.parse(input)
    const { operationId, ...signed } = record
    if (canonicalJson(input) !== canonicalJson(record) || contentHash(signed) !== operationId) throw new RemoteConfigError('hash-mismatch', 'A legacy invitation has changed signed content.')
    const lifetime = Date.parse(record.payload.expiresAt) - Date.parse(record.payload.issuedAt)
    if (record.payload.issuerId === record.payload.recipientId || record.payload.routeRef.identityRef !== record.payload.issuerIdentityRef
      || lifetime <= 0 || lifetime > 86400000) throw new RemoteConfigError('invalid-record', 'A legacy invitation violates the original 24-hour lifetime or identity policy.')
    return record
  }
  return parseRecord(input)
}
export function migrationRecordPath(record: MigrationRecord): string {
  const p = record.payload
  const suffix = record.kind === 'device' ? ['devices', record.payload.deviceId]
    : record.kind === 'alias' ? ['aliases', record.payload.deviceId]
      : record.kind === 'binding' ? ['bindings', record.payload.taskId]
        : record.kind === 'setting' ? ['settings', record.payload.scope === 'workspace' ? 'workspace' : record.payload.deviceId!, record.payload.settingKey]
          : ['invitations', 'issuerId' in p ? p.issuerId : '', 'recipientId' in p ? p.recipientId : '']
  return ['.taskcontinuum', 'records', 'v1', ...suffix, `${record.operationId}.json`].join('/')
}
export function migrationDependencies(record: MigrationRecord): string[] {
  return record.kind === 'invitation' && 'expiresAt' in record.payload
    ? [...new Set([...record.parents, record.payload.issuerIdentityRef, record.payload.recipientIdentityRef])].sort()
    : recordDependencies(record as RemoteRecord)
}
export function migrationEntity(record: MigrationRecord): string {
  return record.kind === 'invitation' ? `invitation:${record.payload.issuerId}:${record.payload.recipientId}` : entityKey(record)
}
export async function readMigrationFiles(root: string): Promise<MigrationFile[]> {
  const base = join(root, '.taskcontinuum', 'records', 'v1')
  const result: MigrationFile[] = []
  let total = 0
  async function visit(directory: string, depth: number): Promise<void> {
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory() || depth > 4) throw new RemoteConfigError('unsafe-path', 'Migration record directories must be real, bounded directories.')
    for (const entry of (await readdir(directory)).sort()) {
      const path = join(directory, entry)
      const info = await lstat(path)
      if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1) throw new RemoteConfigError('unsafe-path', 'Migration will not traverse linked record files.')
      if (info.isDirectory()) { await visit(path, depth + 1); continue }
      if (!info.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry)) throw new RemoteConfigError('invalid-path', 'Unexpected file in immutable history.')
      const bytes = await readCheckedFile(root, path, 32768)
      total += bytes.length
      if (result.length >= 10000 || total > 64 * 1024 * 1024) throw new RemoteConfigError('resource-limit', 'Migration history exceeds the existing record budget.')
      const content = bytes.toString('utf8')
      const record = parseMigrationRecord(JSON.parse(content))
      const name = relative(root, path).split(sep).join('/')
      if (migrationRecordPath(record) !== name || ![`${canonicalJson(record)}\n`, `${canonicalJson(record)}\r\n`].includes(content)) {
        throw new RemoteConfigError('noncanonical-record', 'Migration record bytes or path differ from the signed operation.')
      }
      result.push({ path: name, content, record, sha256: bytesHash(bytes) })
    }
  }
  try { await visit(base, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (result.length) throw new RemoteConfigError('missing-dependency', 'The history changed during migration inspection.')
    throw new RemoteConfigError('missing-history', 'No complete immutable history exists at the selected migration source.')
  }
  return result.sort((a, b) => a.path.localeCompare(b.path))
}
export function migrationManifest(files: readonly MigrationFile[]): string {
  return contentHash(files.map((f) => [f.path, f.sha256]).sort((a, b) => a[0].localeCompare(b[0])))
}
export async function validateLegacyHistory(files: MigrationFile[], trust: LegacyTrust) {
  const records = new Map(files.map((file) => [file.record.operationId, file.record]))
  if (records.size !== files.length) throw new RemoteConfigError('id-collision', 'Duplicate migration operation IDs.')
  const modernTrust: RecordTrust = {
    workspaceId: trust.workspaceId, now: () => trust.now,
    trustedKey: (actor) => trust.pins[actor.deviceId]?.clientPublicKey,
    authorize: (record) => {
      const pin = trust.pins[record.actor.deviceId]
      return !!pin && (!pin.blocked || !!pin.acceptedOperations?.includes(record.operationId))
    },
  }
  const groups = new Map<string, MigrationRecord[]>()
  for (const record of records.values()) {
    const pin = trust.pins[record.actor.deviceId]
    if (!pin || sshFingerprint(pin.clientPublicKey) !== record.actor.keyId || record.workspaceId !== trust.workspaceId
      || pin.blocked && !pin.acceptedOperations?.includes(record.operationId)) throw new RemoteConfigError('untrusted-key', 'Migration history includes an unapproved author or changed signing key.')
    if (record.kind === 'invitation' && 'expiresAt' in record.payload) {
      const { operationId: _operationId, signature, ...body } = record
      void _operationId
      verifyDocument('RemoteConfig', body, signature.value, pin.clientPublicKey)
      if (record.actor.deviceId !== record.payload.issuerId || Date.parse(record.payload.issuedAt) > trust.now + 60000) throw new RemoteConfigError('unauthorized', 'Legacy invitation author or issuance time is invalid.')
    } else await verifyRecord(record as RemoteRecord, modernTrust)
    const key = migrationEntity(record)
    groups.set(key, [...groups.get(key) ?? [], record])
    for (const dependency of migrationDependencies(record)) if (!records.has(dependency)) throw new RemoteConfigError('missing-dependency', 'Migration requires every signed dependency; missing history is never ignored.')
    for (const id of record.parents) if (migrationEntity(records.get(id)!) !== key) throw new RemoteConfigError('wrong-parent', 'Migration causal parents belong to another entity.')
    if (record.kind === 'invitation') {
      const p = record.payload, issuer = records.get(p.issuerIdentityRef), recipient = records.get(p.recipientIdentityRef)
      if (issuer?.kind !== 'device' || issuer.payload.action !== 'publish' || issuer.payload.deviceId !== p.issuerId
        || recipient?.kind !== 'device' || recipient.payload.action !== 'publish' || recipient.payload.deviceId !== p.recipientId
        || p.action === 'grant' && !issuer.payload.routes[p.routeRef.routeIndex]) throw new RemoteConfigError('invalid-identity-reference', 'An invitation does not reference its exact published identities and route.')
      if (p.action === 'revoke') {
        const grant = records.get(p.revokes)
        if (grant?.kind !== 'invitation' || grant.payload.action !== 'grant' || grant.payload.grantId !== p.grantId || migrationEntity(grant) !== key) {
          throw new RemoteConfigError('invalid-revocation', 'A revocation does not identify its exact grant.')
        }
      }
    }
  }
  const remaining = new Map<string, number>(), children = new Map<string, string[]>(), ready: string[] = []
  for (const record of records.values()) {
    const dependencies = migrationDependencies(record)
    remaining.set(record.operationId, dependencies.length)
    if (!dependencies.length) ready.push(record.operationId)
    for (const id of dependencies) children.set(id, [...children.get(id) ?? [], record.operationId])
  }
  for (let index = 0; index < ready.length; index++) for (const id of children.get(ready[index]) ?? []) {
    const count = remaining.get(id)! - 1
    remaining.set(id, count)
    if (!count) ready.push(id)
  }
  if (ready.length !== records.size) throw new RemoteConfigError('causal-cycle', 'Migration history contains or depends on a causal cycle.')
  const retained = files.filter((file) => file.record.kind !== 'invitation')
  const projection = await resolveRecords(retained.map((file) => file.record), modernTrust)
  if (projection.blocked || projection.diagnostics.length) throw new RemoteConfigError('migration-conflict', 'Non-invitation history has unresolved identity, binding or setting conflicts.')
  for (const history of groups.values()) {
    const parents = new Set(history.flatMap((r) => r.parents))
    const heads = history.filter((r) => !parents.has(r.operationId))
    if (new Set(heads.map((r) => canonicalJson(r.payload))).size > 1) throw new RemoteConfigError('migration-conflict', 'Concurrent immutable heads require explicit resolution before migration.')
  }
  const relationships = [...groups.values()].flatMap((history) => {
    if (history[0].kind !== 'invitation') return []
    const parents = new Set(history.flatMap((r) => r.parents))
    const head = history.find((r) => !parents.has(r.operationId))!
    if (head.kind !== 'invitation') return []
    const p = head.payload
    const revoked = history.some((r) => r.kind === 'invitation' && r.payload.action === 'revoke' && r.payload.grantId === p.grantId)
    const issuer = projection.entities[`device:${p.issuerId}`], recipient = projection.entities[`device:${p.recipientId}`]
    const eligible = p.action === 'grant' && !revoked && issuer?.state === 'active' && recipient?.state === 'active'
      && issuer.heads.includes(p.issuerIdentityRef) && recipient.heads.includes(p.recipientIdentityRef)
      && !trust.pins[p.issuerId]?.blocked && !trust.pins[p.recipientId]?.blocked
      && (!('expiresAt' in p) || Date.parse(p.expiresAt) > trust.now)
    return [{ issuerId: p.issuerId, recipientId: p.recipientId, eligible, revoked, headId: head.operationId }]
  })
  return { projection, relationships, retained }
}
