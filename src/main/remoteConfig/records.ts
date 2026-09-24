import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import {
  remoteConfigDefaults, remoteConfigLimits, remoteConfigRecordsPath,
  type RemoteActor, type RemoteConfigDiagnostic, type RemoteRecord, type RemoteRecordBody,
  type RemoteRecordHeader, type RemoteRecordKind, type RemoteSettings, type ResolvedRemoteConfig,
} from '../../shared/remoteConfig'
import type { SessionLink } from '../../shared/sessionBindings'
import { devTunnelIdSchema, sshFingerprint, sshPublicKeySchema } from '../devTunnel/protocol'
import { sessionLinkKey, sessionLinkSchema, sessionLinkTaskIdSchema } from '../sessionLinkSchema'
import { remoteClientSchema, remoteMachineSchema } from '../vscodeRemoteProtocol'
import { matchesGitText } from '../shared/gitText'

export class RemoteConfigError extends Error {
  constructor(readonly code: string, message: string, readonly entityKey?: string, readonly operationId?: string) {
    super(message)
    this.name = 'RemoteConfigError'
  }
}

export const operationIdSchema = z.string().regex(/^[a-f0-9]{64}$/)
const uuidSchema = z.uuid().regex(/^[a-f0-9-]+$/)
const fingerprintSchema = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/)
const timestampSchema = z.iso.datetime({ offset: false })
const actorSchema = z.object({ deviceId: uuidSchema, keyId: fingerprintSchema }).strict()
const publicUsernameSchema = remoteClientSchema.shape.username.refine((value) => !/[\r\n\0]|-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----|openssh-key-v1/.test(value), 'Only a single-line public username is supported.')
const identitySchema = z.object({
  machineName: remoteMachineSchema, clientPublicKey: sshPublicKeySchema, hostPublicKey: sshPublicKeySchema,
  clientKeyId: fingerprintSchema, hostKeyId: fingerprintSchema,
  username: publicUsernameSchema.optional(),
}).strict().superRefine((identity, context) => {
  if (sshFingerprint(identity.clientPublicKey) !== identity.clientKeyId || sshFingerprint(identity.hostPublicKey) !== identity.hostKeyId) {
    context.addIssue({ code: 'custom', message: 'Public key fingerprints do not match the identity.' })
  }
})
const routeSchema = z.object({
  kind: z.literal('dev-tunnel'), tunnelId: devTunnelIdSchema,
  sshPort: z.number().int().min(1024).max(65535), controlPort: z.number().int().min(1024).max(65535).optional(),
}).strict()
export const devicePublicationSchema = z.object({
  action: z.literal('publish'), deviceId: uuidSchema,
  identity: identitySchema.safeExtend({ username: publicUsernameSchema }),
  routes: z.array(routeSchema.required({ controlPort: true })).min(1).max(8),
}).strict()
const devicePayloadSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('publish'), deviceId: uuidSchema, identity: identitySchema, routes: z.array(routeSchema).min(1).max(8) }).strict(),
  z.object({ action: z.literal('remove'), deviceId: uuidSchema }).strict(),
])
const invitationIdentity = {
  issuerId: uuidSchema, recipientId: uuidSchema, grantId: uuidSchema,
  issuerIdentityRef: operationIdSchema, recipientIdentityRef: operationIdSchema,
}
const invitationPayloadSchema = z.discriminatedUnion('action', [
  z.object({
    ...invitationIdentity, action: z.literal('grant'), capability: z.literal('ah-link'),
    issuedAt: timestampSchema, expiresAt: timestampSchema,
    routeRef: z.object({ identityRef: operationIdSchema, routeIndex: z.number().int().min(0).max(7) }).strict(),
  }).strict(),
  z.object({ ...invitationIdentity, action: z.literal('revoke'), revokes: operationIdSchema }).strict(),
]).superRefine((value, context) => {
  if (value.issuerId === value.recipientId) context.addIssue({ code: 'custom', message: 'An invitation must address another device.' })
  if (value.action === 'grant' && (value.routeRef.identityRef !== value.issuerIdentityRef || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt))) {
    context.addIssue({ code: 'custom', message: 'An invitation must reference its issuer route and a positive lifetime.' })
  }
})
const bindingPayloadSchema = z.discriminatedUnion('action', [
  z.object({
    schemaVersion: z.literal('2.1'), action: z.literal('set'), taskId: sessionLinkTaskIdSchema.max(64),
    targets: z.array(sessionLinkSchema).min(1).max(1000),
  }).strict().superRefine((value, context) => {
    const claims = new Set<string>()
    for (const target of value.targets) {
      const key = sessionLinkKey(target)
      if (claims.has(key)) context.addIssue({ code: 'custom', message: 'A binding payload cannot claim the same session more than once.' })
      claims.add(key)
    }
  }),
  z.object({ schemaVersion: z.literal('2.1'), action: z.literal('delete'), taskId: sessionLinkTaskIdSchema.max(64) }).strict(),
])
export const settingKeySchema = z.enum(['autoLink', 'tunnelEnabled', 'connectTimeoutMs'])
const settingPayloadSchema = z.object({
  action: z.enum(['set', 'delete']), scope: z.enum(['workspace', 'device']), deviceId: uuidSchema.optional(),
  settingKey: settingKeySchema, value: z.union([z.boolean(), z.number().int().min(1000).max(120000)]).optional(),
}).strict().superRefine((value, context) => {
  if ((value.scope === 'device') !== (value.deviceId !== undefined)) context.addIssue({ code: 'custom', message: 'Only device settings require a deviceId.' })
  if (value.action === 'delete' ? value.value !== undefined : value.settingKey === 'connectTimeoutMs' ? typeof value.value !== 'number' : typeof value.value !== 'boolean') {
    context.addIssue({ code: 'custom', message: 'The setting value must match the operation and setting key.' })
  }
})
const header = {
  schemaVersion: z.literal(1), workspaceId: uuidSchema, nonce: uuidSchema, actor: actorSchema,
  parents: z.array(operationIdSchema).max(remoteConfigLimits.parents).refine((ids) => ids.every((id, index) => index === 0 || ids[index - 1] < id), 'Parents must be sorted and unique.'),
  createdAt: timestampSchema,
}
const signature = z.object({
  algorithm: z.literal('ed25519'),
  value: z.string().length(88).refine((value) => Buffer.from(value, 'base64').length === 64 && Buffer.from(value, 'base64').toString('base64') === value, 'Invalid Ed25519 signature encoding.'),
}).strict()
const bodySchema = z.discriminatedUnion('kind', [
  z.object({ ...header, kind: z.literal('device'), payload: devicePayloadSchema }).strict(),
  z.object({ ...header, kind: z.literal('invitation'), payload: invitationPayloadSchema }).strict(),
  z.object({ ...header, kind: z.literal('binding'), payload: bindingPayloadSchema }).strict(),
  z.object({ ...header, kind: z.literal('setting'), payload: settingPayloadSchema }).strict(),
])
export const remoteRecordSchema = z.discriminatedUnion('kind', [
  z.object({ ...header, kind: z.literal('device'), payload: devicePayloadSchema, operationId: operationIdSchema, signature }).strict(),
  z.object({ ...header, kind: z.literal('invitation'), payload: invitationPayloadSchema, operationId: operationIdSchema, signature }).strict(),
  z.object({ ...header, kind: z.literal('binding'), payload: bindingPayloadSchema, operationId: operationIdSchema, signature }).strict(),
  z.object({ ...header, kind: z.literal('setting'), payload: settingPayloadSchema, operationId: operationIdSchema, signature }).strict(),
])

/** RFC 8785's JSON subset: only safe integers, scalar Unicode and plain JSON objects. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>()
  let nodes = 0
  function encode(item: unknown, depth: number): string {
    if (++nodes > 200000 || depth > 24) throw new RemoteConfigError('resource-limit', 'Canonical JSON exceeds its structural limit.')
    if (item === null || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'string') {
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item)) throw new RemoteConfigError('invalid-json', 'Unpaired Unicode surrogates are not supported.')
      return JSON.stringify(item)
    }
    if (typeof item === 'number' && Number.isSafeInteger(item)) return JSON.stringify(item)
    if (typeof item !== 'object' || !item || seen.has(item)) throw new RemoteConfigError('invalid-json', 'Only acyclic plain JSON values and safe integers are supported.')
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new RemoteConfigError('invalid-json', 'Only plain JSON objects are supported.')
    seen.add(item)
    let result: string
    if (Array.isArray(item)) {
      const values = Array.from(item, (child) => encode(child, depth + 1))
      result = `[${values.join(',')}]`
    } else {
      const object = item as Record<string, unknown>
      if (Object.getOwnPropertySymbols(object).length || Object.values(Object.getOwnPropertyDescriptors(object)).some((property) => !('value' in property))) throw new RemoteConfigError('invalid-json', 'Symbols and accessor properties are not plain JSON data.')
      result = `{${Object.keys(object).sort().map((key) => {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new RemoteConfigError('invalid-json', 'Prototype properties are not supported.')
        return `${encode(key, depth + 1)}:${encode(object[key], depth + 1)}`
      }).join(',')}}`
    }
    seen.delete(item)
    return result
  }
  return encode(value, 0)
}

function hash(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex') }
function bodyOf(record: RemoteRecord): RemoteRecordBody {
  return { schemaVersion: record.schemaVersion, kind: record.kind, workspaceId: record.workspaceId, nonce: record.nonce, actor: record.actor, parents: record.parents, createdAt: record.createdAt, payload: record.payload } as RemoteRecordBody
}
export function recordSigningBytes(body: RemoteRecordBody): Buffer {
  return Buffer.from(`TaskCon.RemoteConfig.v1\n${canonicalJson(body)}`, 'utf8')
}
export type RecordSigner = (bytes: Buffer) => Buffer | string | Promise<Buffer | string>
export type RecordInput<K extends RemoteRecordKind = RemoteRecordKind> = {
  [Kind in RemoteRecordKind]: { kind: Kind; payload: RemoteRecordBody<Kind>['payload']; workspaceId: string; actor: RemoteActor } & Partial<Pick<RemoteRecordHeader, 'schemaVersion' | 'nonce' | 'createdAt' | 'parents'>>
}[K]

export async function createRecord<K extends RemoteRecordKind>(input: RecordInput<K> & { kind: K }, sign: RecordSigner): Promise<RemoteRecord<K>> {
  canonicalJson(input)
  const body = bodySchema.parse({ schemaVersion: 1, nonce: randomUUID(), createdAt: new Date().toISOString(), ...input, parents: [...new Set(input.parents ?? [])].sort() }) as RemoteRecordBody
  const signed = await sign(recordSigningBytes(body))
  const value = typeof signed === 'string' ? signed : signed.toString('base64')
  const unsignedId = { ...body, signature: signature.parse({ algorithm: 'ed25519', value }) }
  return parseRecord({ ...unsignedId, operationId: hash(unsignedId) }) as RemoteRecord<K>
}

/** Parses and checks the content hash, not authorization. Use verifyRecord before trusting it. */
export function parseRecord(input: unknown): RemoteRecord {
  const encoded = canonicalJson(input)
  if (Buffer.byteLength(encoded) > remoteConfigLimits.recordBytes) throw new RemoteConfigError('resource-limit', 'A remote configuration record exceeds the 32 KiB limit.')
  let record: RemoteRecord
  try { record = remoteRecordSchema.parse(input) as RemoteRecord }
  catch { throw new RemoteConfigError('invalid-record', 'A remote configuration record has an invalid or unknown schema. Task session bindings require v2.1; previous bindings are unsupported and are not migrated. Use a fresh workspace binding configuration to link existing native sessions again.') }
  if (canonicalJson(record) !== encoded) throw new RemoteConfigError('noncanonical-record', 'A signed record cannot contain values that require schema normalization.', entityKey(record), record.operationId)
  if (hash({ ...bodyOf(record), signature: record.signature }) !== record.operationId) throw new RemoteConfigError('hash-mismatch', 'An immutable record hash does not match its content.', entityKey(record), record.operationId)
  return record
}

export type Awaitable<T> = T | Promise<T>
export type RecordKeySource = ((actor: RemoteActor, record: RemoteRecord) => Awaitable<string | undefined>) | ReadonlyMap<string, string>
export interface RecordTrust {
  workspaceId: string
  /** Already admitted keys only. Maps use deviceId, or deviceId:keyId for explicitly retained key history. */
  trustedKey: RecordKeySource
  /** Enforce enrolled editor, task-existence and binding-target policy as appropriate for this operation. */
  authorize(record: RemoteRecord): Awaitable<boolean>
  allowKeyRotation?(record: RemoteRecord<'device'>, previous: RemoteRecord<'device'>): Awaitable<boolean>
  allowDeviceReactivation?(record: RemoteRecord<'device'>): Awaitable<boolean>
  maximumInvitationLifetimeMs?: number
  now?: () => number
  /** Changes whenever any dynamic trust callback result can change; absent means no authorization caching. */
  authorizationVersion?(): string
}

export function bindingTargets(payload: RemoteRecord<'binding'>['payload']): SessionLink[] {
  if (payload.action !== 'set') return []
  return payload.targets
}

export function verifyRecordSignature(input: unknown, publicKey: string): RemoteRecord {
  const record = parseRecord(input)
  const key = sshPublicKeySchema.parse(publicKey)
  if (sshFingerprint(key) !== record.actor.keyId) throw new RemoteConfigError('untrusted-key', 'The enrolled signing fingerprint does not match the record.', entityKey(record), record.operationId)
  const raw = Buffer.from(key.split(' ')[1], 'base64').subarray(19)
  const parsed = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
  if (!verify(null, recordSigningBytes(bodyOf(record)), parsed, Buffer.from(record.signature.value, 'base64'))) throw new RemoteConfigError('invalid-signature', 'The remote record signature is invalid.', entityKey(record), record.operationId)
  return record
}

export async function verifyRecord(input: unknown, trust: RecordTrust): Promise<RemoteRecord> {
  const record = parseRecord(input)
  const deny = (message: string): never => { throw new RemoteConfigError('unauthorized', message, entityKey(record), record.operationId) }
  if (record.workspaceId !== trust.workspaceId) deny('The record belongs to a different enrolled workspace.')
  const key = typeof trust.trustedKey === 'function' ? await trust.trustedKey(record.actor, record)
    : trust.trustedKey.get(`${record.actor.deviceId}:${record.actor.keyId}`) ?? trust.trustedKey.get(record.actor.deviceId)
  if (!key) deny('The record author is not trusted for this workspace and fingerprint.')
  verifyRecordSignature(record, key!)
  if (record.kind === 'device' && record.actor.deviceId !== record.payload.deviceId) deny('Only the owning device can publish or remove its identity.')
  if (record.kind === 'invitation') {
    if (record.actor.deviceId !== record.payload.issuerId) deny('Only the invitation issuer can grant or revoke access.')
    if (record.payload.action === 'grant') {
      const lifetime = Date.parse(record.payload.expiresAt) - Date.parse(record.payload.issuedAt)
      if (lifetime > (trust.maximumInvitationLifetimeMs ?? 24 * 60 * 60 * 1000) || Date.parse(record.payload.issuedAt) > (trust.now?.() ?? Date.now()) + 60000) deny('The invitation exceeds the locally enrolled lifetime policy.')
    }
  }
  if (record.kind === 'binding' && record.payload.action === 'set') {
    if (bindingTargets(record.payload).some((target) => !uuidSchema.safeParse(target.owner.clientId).success)) deny('Published owner identities must use canonical lowercase UUIDs.')
  }
  if (record.kind === 'setting' && record.payload.scope === 'device' && record.actor.deviceId !== record.payload.deviceId) deny('Only the owning device can change its device settings.')
  if (!await trust.authorize(record)) deny('The enrolled policy does not authorize this operation, task or target.')
  return record
}

export function entityKey(record: Pick<RemoteRecord, 'kind' | 'payload'>): string {
  const value = record as RemoteRecord
  if (value.kind === 'device') return `device:${value.payload.deviceId}`
  if (value.kind === 'invitation') return `invitation:${value.payload.issuerId}:${value.payload.recipientId}`
  if (value.kind === 'binding') return `binding:${value.payload.taskId}`
  return `setting:${value.payload.scope === 'workspace' ? 'workspace' : value.payload.deviceId}:${value.payload.settingKey}`
}

export function recordDependencies(record: RemoteRecord): string[] {
  const dependencies = [...record.parents]
  if (record.kind === 'invitation') {
    dependencies.push(record.payload.issuerIdentityRef, record.payload.recipientIdentityRef)
    if (record.payload.action === 'revoke') dependencies.push(record.payload.revokes)
  }
  return [...new Set(dependencies)].sort()
}

export function unionRecords(...groups: readonly (readonly RemoteRecord[])[]): RemoteRecord[] {
  const records = new Map<string, RemoteRecord>()
  for (const group of groups) for (const item of group) {
    const record = parseRecord(item)
    const previous = records.get(record.operationId)
    if (previous && canonicalJson(previous) !== canonicalJson(record)) throw new RemoteConfigError('id-collision', 'An operation ID has different immutable content.', entityKey(record), record.operationId)
    records.set(record.operationId, record)
    if (records.size > remoteConfigLimits.records) throw new RemoteConfigError('resource-limit', 'Remote configuration exceeds the 10,000-record limit.')
  }
  return [...records.values()].sort((left, right) => left.operationId < right.operationId ? -1 : 1)
}

export function recordClosure(record: RemoteRecord, available: readonly RemoteRecord[], maximum: number = remoteConfigLimits.notificationDependencies): RemoteRecord[] {
  const records = new Map(available.map((item) => [item.operationId, item]))
  const result = new Map<string, RemoteRecord>()
  const pending = recordDependencies(record)
  while (pending.length) {
    const id = pending.pop()!
    if (id === record.operationId) throw new RemoteConfigError('causal-cycle', 'The record dependency graph has a cycle.', entityKey(record), record.operationId)
    if (result.has(id)) continue
    const dependency = records.get(id)
    if (!dependency) throw new RemoteConfigError('missing-dependency', 'The complete operation dependency closure is not yet available.', entityKey(record), record.operationId)
    result.set(id, dependency)
    if (result.size > maximum) throw new RemoteConfigError('resource-limit', 'The operation dependency closure exceeds its delivery limit.', entityKey(record), record.operationId)
    pending.push(...recordDependencies(dependency))
  }
  return [...result.values()].sort((left, right) => left.operationId < right.operationId ? -1 : 1)
}

export function recordPath(input: RemoteRecord): string {
  const record = parseRecord(input)
  const name = `${record.operationId}.json`
  if (record.kind === 'device') return join(remoteConfigRecordsPath, 'devices', record.payload.deviceId, name)
  if (record.kind === 'invitation') return join(remoteConfigRecordsPath, 'invitations', record.payload.issuerId, record.payload.recipientId, name)
  if (record.kind === 'binding') return join(remoteConfigRecordsPath, 'bindings', record.payload.taskId, name)
  return join(remoteConfigRecordsPath, 'settings', record.payload.scope === 'workspace' ? 'workspace' : record.payload.deviceId, record.payload.settingKey, name)
}
export function serializeRecord(record: RemoteRecord): string { return `${canonicalJson(parseRecord(record))}\n` }

export async function resolveRecords(inputs: readonly unknown[], trust: RecordTrust): Promise<ResolvedRemoteConfig> {
  if (inputs.length > remoteConfigLimits.records) throw new RemoteConfigError('resource-limit', 'Remote configuration exceeds the 10,000-record limit.')
  const records = new Map<string, RemoteRecord>()
  const invalid = new Set<string>()
  const blockedEntities = new Set<string>()
  const diagnostics: RemoteConfigDiagnostic[] = []
  let globalBlock = false
  let totalBytes = 0
  function diagnostic(code: string, message: string, record?: RemoteRecord) {
    diagnostics.push({ code, message, ...(record ? { entityKey: entityKey(record), operationId: record.operationId } : {}) })
    if (record) { invalid.add(record.operationId); blockedEntities.add(entityKey(record)) }
    else globalBlock = true
  }
  for (const input of inputs) {
    let record: RemoteRecord | undefined
    try {
      const encoded = canonicalJson(input)
      totalBytes += Buffer.byteLength(encoded)
      if (totalBytes > remoteConfigLimits.totalBytes) throw new RemoteConfigError('resource-limit', 'Remote configuration exceeds the 64 MiB limit.')
      // Retain a structurally recognizable invalid entity so it cannot fall back to an old value.
      const shape = remoteRecordSchema.safeParse(input)
      if (shape.success) record = shape.data as RemoteRecord
      record = parseRecord(input)
      const prior = records.get(record.operationId)
      if (prior && canonicalJson(prior) !== encoded) throw new RemoteConfigError('id-collision', 'An operation ID has different immutable content.')
      records.set(record.operationId, record)
      await verifyRecord(record, trust)
    } catch (error) {
      if (error instanceof RemoteConfigError && error.code === 'resource-limit') throw error
      if (record) records.set(record.operationId, record)
      diagnostic(error instanceof RemoteConfigError ? error.code : 'invalid-record', error instanceof Error ? error.message : 'Invalid remote record.', record)
    }
  }
  const ordered = [...records.values()].sort((left, right) => left.operationId < right.operationId ? -1 : 1)
  for (const record of ordered) {
    for (const parent of record.parents) {
      const previous = records.get(parent)
      if (!previous) diagnostic('missing-dependency', 'The operation has an unavailable causal parent. Synchronize its complete history.', record)
      else if (entityKey(previous) !== entityKey(record)) diagnostic('wrong-parent', 'Causal parents must belong to the same entity.', record)
    }
    for (const dependency of recordDependencies(record)) {
      if (!records.has(dependency)) diagnostic('missing-dependency', 'The operation dependency closure is incomplete.', record)
    }
    if (record.kind === 'invitation') {
      const value = record.payload
      const issuer = records.get(value.issuerIdentityRef)
      const recipient = records.get(value.recipientIdentityRef)
      if (issuer?.kind !== 'device' || issuer.payload.action !== 'publish' || issuer.payload.deviceId !== value.issuerId
        || recipient?.kind !== 'device' || recipient.payload.action !== 'publish' || recipient.payload.deviceId !== value.recipientId) diagnostic('invalid-identity-reference', 'The invitation must reference the exact issuer and recipient public identities.', record)
      else if (value.action === 'grant' && !issuer.payload.routes[value.routeRef.routeIndex]) diagnostic('invalid-route-reference', 'The invitation route is not present in its issuer identity.', record)
      if (value.action === 'revoke') {
        const grant = records.get(value.revokes)
        if (grant?.kind !== 'invitation' || grant.payload.action !== 'grant' || grant.payload.grantId !== value.grantId || entityKey(grant) !== entityKey(record)) diagnostic('invalid-revocation', 'The revocation must reference the exact grant for this issuer and recipient.', record)
      }
    }
    if (record.kind === 'device' && record.payload.action === 'publish') {
      for (const parent of record.parents) {
        const previous = records.get(parent)
        if (previous?.kind === 'device' && previous.payload.action === 'publish'
          && (previous.payload.identity.clientKeyId !== record.payload.identity.clientKeyId || previous.payload.identity.hostKeyId !== record.payload.identity.hostKeyId)
          && !await trust.allowKeyRotation?.(record, previous)) diagnostic('key-rotation-required', 'A changed device key requires explicit enrolled rotation authorization.', record)
      }
    }
    if (record.kind === 'binding' && record.payload.action === 'set') {
      for (const parent of record.parents) {
        const previous = records.get(parent)
        if (previous?.kind === 'binding' && previous.payload.action === 'set') {
          const oldTargets = bindingTargets(previous.payload)
          const newTargets = bindingTargets(record.payload)
          const removed = oldTargets.filter((old) => !newTargets.some((target) => sessionLinkKey(target) === sessionLinkKey(old)))
          const added = newTargets.filter((target) => !oldTargets.some((old) => sessionLinkKey(old) === sessionLinkKey(target)))
          for (const old of removed) {
            if (added.some((target) => old.provider === target.provider && old.sessionId === target.sessionId
              && old.owner.clientId !== target.owner.clientId)) {
              diagnostic('ownership-transfer', 'A binding edit cannot transfer session ownership.', record)
            }
          }
        }
      }
    }
  }
  const remaining = new Map<string, number>()
  const children = new Map<string, RemoteRecord[]>()
  const ready: RemoteRecord[] = []
  for (const record of ordered) {
    const dependencies = recordDependencies(record).filter((id) => records.has(id))
    remaining.set(record.operationId, dependencies.length)
    if (!dependencies.length) ready.push(record)
    for (const id of dependencies) children.set(id, [...children.get(id) ?? [], record])
  }
  for (let index = 0; index < ready.length; index++) {
    const record = ready[index]
    for (const child of children.get(record.operationId) ?? []) {
      if (invalid.has(record.operationId) && !invalid.has(child.operationId)) diagnostic('invalid-dependency', 'The operation depends on an invalid or unauthorized record.', child)
      const count = remaining.get(child.operationId)! - 1
      remaining.set(child.operationId, count)
      if (!count) ready.push(child)
    }
  }
  for (const record of ordered) if (remaining.get(record.operationId)) diagnostic('causal-cycle', 'The immutable operation graph contains or depends on a cycle.', record)
  const resolution: ResolvedRemoteConfig = {
    revision: '', records: ordered, entities: {}, heads: {}, devices: {}, invitations: {}, bindings: {},
    settings: { workspace: {}, devices: {} }, diagnostics, blocked: globalBlock || diagnostics.length > 0,
  }
  for (const record of ordered) {
    const key = entityKey(record)
    const entity = resolution.entities[key] ??= { key, kind: record.kind, state: 'active', heads: [], records: [] }
    entity.records.push(record)
  }
  for (const entity of Object.values(resolution.entities)) {
    const ancestors = new Set(entity.records.flatMap((record) => record.parents))
    const heads = entity.records.filter((record) => !ancestors.has(record.operationId))
    entity.heads = heads.map((record) => record.operationId)
    resolution.heads[entity.key] = entity.heads
    if (globalBlock || blockedEntities.has(entity.key) || !heads.length) { entity.state = 'blocked'; continue }
    const removals = entity.records.filter((record) => record.kind === 'device' && record.payload.action === 'remove')
    if (removals.length && !heads.every((record) => record.kind === 'device' && record.payload.action === 'publish' && trust.allowDeviceReactivation)) {
      entity.state = 'deleted'
      entity.value = removals[0]
      continue
    }
    if (removals.length) {
      const reactivated = await Promise.all(heads.map((record) => record.kind === 'device' && record.payload.action === 'publish' ? trust.allowDeviceReactivation!(record) : false))
      if (!reactivated.every(Boolean)) { entity.state = 'deleted'; entity.value = removals[0]; continue }
    }
    let candidates = heads
    if (entity.kind === 'invitation') {
      const revoked = new Set(entity.records.flatMap((record) => record.kind === 'invitation' && record.payload.action === 'revoke' ? [record.payload.grantId] : []))
      candidates = heads.filter((record) => record.kind !== 'invitation' || record.payload.action !== 'grant' || !revoked.has(record.payload.grantId))
      if (!candidates.length || candidates.every((record) => record.payload.action === 'revoke')) { entity.state = 'deleted'; continue }
    }
    const semantic = new Set(candidates.map((record) => canonicalJson(record.payload)))
    if (semantic.size !== 1) { entity.state = 'needs-resolution'; diagnostics.push({ code: 'concurrent-values', message: 'Concurrent incompatible values need an explicit resolution using all observed heads.', entityKey: entity.key }); continue }
    const selected = candidates[0]
    entity.value = selected
    if (selected.payload.action === 'delete' || selected.payload.action === 'remove' || selected.payload.action === 'revoke') { entity.state = 'deleted'; continue }
    if (selected.kind === 'device') {
      if (devicePublicationSchema.safeParse(selected.payload).success) resolution.devices[selected.payload.deviceId] = selected
      else diagnostics.push({
        code: 'incomplete-device-publication',
        message: 'Automatic linking is unavailable: publish the public username and a scoped controlPort on every route. No username or SSH target is inferred.',
        entityKey: entity.key, operationId: selected.operationId,
      })
    }
    if (selected.kind === 'setting' && selected.payload.action === 'set') {
      const scope = selected.payload.scope === 'workspace' ? resolution.settings.workspace : resolution.settings.devices[selected.payload.deviceId] ??= {}
      Object.assign(scope, { [selected.payload.settingKey]: selected.payload.value })
    }
  }
  for (const entity of Object.values(resolution.entities)) {
    const record = entity.value
    if (entity.state !== 'active' || !record) continue
    if (record.kind === 'invitation' && record.payload.action === 'grant') {
      const value = record.payload
      const issuer = resolution.entities[`device:${value.issuerId}`]
      const recipient = resolution.entities[`device:${value.recipientId}`]
      if (issuer?.state !== 'active' || recipient?.state !== 'active' || !issuer.heads.includes(value.issuerIdentityRef) || !recipient.heads.includes(value.recipientIdentityRef)) {
        entity.state = 'blocked'
        diagnostics.push({ code: 'stale-identity', message: 'The invitation refers to a removed, conflicting or superseded identity.', entityKey: entity.key, operationId: record.operationId })
      } else if (!resolution.devices[value.issuerId] || !resolution.devices[value.recipientId]) {
        entity.state = 'blocked'
        diagnostics.push({ code: 'incomplete-link-metadata', message: 'Automatic linking requires complete public username and scoped control-port metadata for both enrolled identities.', entityKey: entity.key, operationId: record.operationId })
      } else if (Date.parse(value.expiresAt) <= (trust.now?.() ?? Date.now())) entity.state = 'expired'
      else resolution.invitations[entity.key] = record
    }
    if (record.kind === 'binding' && record.payload.action === 'set') {
      const targets = bindingTargets(record.payload)
      const ownerEntities = targets.map((target) => resolution.entities[`device:${target.owner.clientId}`]).filter(Boolean)
      const actorEntity = resolution.entities[`device:${record.actor.deviceId}`]
      if (ownerEntities.some((owner) => owner.state !== 'active') || (actorEntity && actorEntity.state !== 'active')) {
        entity.state = 'blocked'
        diagnostics.push({ code: 'unavailable-device', message: 'The binding owner or author identity is removed, invalid or conflicting.', entityKey: entity.key })
      } else resolution.bindings[record.payload.taskId] = targets
    }
  }
  const claims = new Map<string, Set<string>>()
  for (const entity of Object.values(resolution.entities)) {
    if (entity.kind !== 'binding' || (entity.state !== 'active' && entity.state !== 'needs-resolution')) continue
    for (const record of entity.records) {
      if (!entity.heads.includes(record.operationId) || record.kind !== 'binding' || record.payload.action !== 'set') continue
      for (const target of bindingTargets(record.payload)) {
        const key = sessionLinkKey(target)
        const tasks = claims.get(key) ?? new Set<string>()
        tasks.add(record.payload.taskId)
        claims.set(key, tasks)
      }
    }
  }
  for (const claimants of claims.values()) if (claimants.size > 1) {
    const tasks = [...claimants].sort()
    for (const taskId of tasks) {
      delete resolution.bindings[taskId]
      resolution.entities[`binding:${taskId}`].state = 'needs-resolution'
      diagnostics.push({ code: 'duplicate-session', message: `This session is claimed by multiple tasks: ${tasks.join(', ')}. No claim is active.`, entityKey: `binding:${taskId}` })
    }
  }
  if (Object.keys(resolution.bindings).length > 1000) throw new RemoteConfigError('resource-limit', 'The session link limit is 1,000 tasks.')
  if (Object.values(resolution.bindings).reduce((count, links) => count + links.length, 0) > 1000) throw new RemoteConfigError('resource-limit', 'The session link limit is 1,000 sessions.')
  // Stale grants and removed owners are inactive derived state, not corrupt immutable history.
  resolution.blocked = globalBlock || blockedEntities.size > 0
  resolution.diagnostics = [...new Map(diagnostics.map((entry) => [canonicalJson(entry), entry])).entries()].sort(([left], [right]) => left < right ? -1 : 1).map(([, entry]) => entry)
  resolution.revision = hash({ records: ordered.map((record) => record.operationId), entities: Object.values(resolution.entities).map((entity) => [entity.key, entity.state, entity.heads]), diagnostics: resolution.diagnostics })
  return resolution
}

export function resolvedSettings(resolution: ResolvedRemoteConfig, deviceId: string): RemoteSettings {
  if (resolution.blocked) return { autoLink: false, tunnelEnabled: false, connectTimeoutMs: 1000 }
  const values: RemoteSettings = { ...remoteConfigDefaults, ...resolution.settings.workspace, ...resolution.settings.devices[deviceId] }
  for (const key of ['autoLink', 'tunnelEnabled', 'connectTimeoutMs'] as const) {
    for (const scope of ['workspace', deviceId]) {
      const entity = resolution.entities[`setting:${scope}:${key}`]
      if (entity?.state === 'blocked' || entity?.state === 'needs-resolution') {
        if (key === 'connectTimeoutMs') values[key] = 1000
        else values[key] = false
      }
    }
  }
  return values
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}
export async function checkedDirectory(root: string, parts: readonly string[], create = false): Promise<string | undefined> {
  const canonical = await realpath(root)
  let directory = canonical
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[/\\]/.test(part)) throw new RemoteConfigError('unsafe-path', 'Invalid remote configuration path component.')
    directory = join(directory, part)
    if (create) {
      try { await mkdir(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    let info
    try { info = await lstat(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(canonical, await realpath(directory))) throw new RemoteConfigError('unsafe-path', 'Remote configuration directories cannot be filesystem links or leave their storage root.')
  }
  return directory
}
export async function readCheckedFile(root: string, file: string, maximum: number): Promise<Buffer> {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !inside(await realpath(root), await realpath(file))) throw new RemoteConfigError('unsafe-path', 'Remote configuration must use regular contained files, not symbolic or hard links.')
  if (info.size > maximum) throw new RemoteConfigError('resource-limit', 'A remote configuration file exceeds its byte limit.')
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const actual = await handle.stat()
    if (!actual.isFile() || actual.nlink !== 1 || actual.ino !== info.ino || actual.dev !== info.dev || actual.size > maximum) throw new RemoteConfigError('unsafe-path', 'The remote configuration file changed during validation.')
    const buffer = Buffer.alloc(Math.min(maximum + 1, actual.size + 1))
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maximum) throw new RemoteConfigError('resource-limit', 'A remote configuration file exceeds its byte limit.')
    const after = await handle.stat()
    if (after.nlink !== 1 || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs) throw new RemoteConfigError('immutable-mutation', 'The immutable file changed while being read.')
    return buffer.subarray(0, length)
  } finally { await handle.close() }
}

export async function readRecords(root: string, trust?: RecordTrust): Promise<RemoteRecord[]> {
  let base: string | undefined
  try { base = await checkedDirectory(root, ['.taskcontinuum', 'records', 'v1']) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  if (!base) return []
  const result: RemoteRecord[] = []
  let totalBytes = 0
  let entries = 0
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 4) throw new RemoteConfigError('unsafe-path', 'The record store has an unexpected directory depth.')
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : 1)) {
      if (++entries > remoteConfigLimits.records * 5) throw new RemoteConfigError('resource-limit', 'The record store has too many directory entries.')
      const file = join(directory, entry.name)
      const info = await lstat(file)
      if (info.isSymbolicLink()) throw new RemoteConfigError('unsafe-path', 'The record store cannot contain filesystem links.')
      if (info.isDirectory()) {
        const parts = relative(await realpath(root), file).split(sep)
        await checkedDirectory(root, parts)
        await visit(file, depth + 1)
      } else {
        if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) throw new RemoteConfigError('invalid-path', 'The record store contains a non-operation file.')
        if (result.length >= remoteConfigLimits.records) throw new RemoteConfigError('resource-limit', 'Remote configuration exceeds the 10,000-record limit.')
        const content = await readCheckedFile(root, file, remoteConfigLimits.recordBytes)
        totalBytes += content.byteLength
        if (totalBytes > remoteConfigLimits.totalBytes) throw new RemoteConfigError('resource-limit', 'Remote configuration exceeds the 64 MiB limit.')
        let input: unknown
        try { input = JSON.parse(content.toString('utf8')) } catch { throw new RemoteConfigError('invalid-json', 'An immutable operation file is not valid JSON.') }
        const record = trust ? await verifyRecord(input, trust) : parseRecord(input)
        if (relative(await realpath(root), file) !== recordPath(record)) throw new RemoteConfigError('invalid-path', 'The immutable operation filename, entity path and payload disagree.', entityKey(record), record.operationId)
        if (!matchesGitText(content, serializeRecord(record))) throw new RemoteConfigError('noncanonical-record', 'Immutable operation bytes must use canonical JSON with one trailing LF or CRLF newline.', entityKey(record), record.operationId)
        result.push(record)
      }
    }
  }
  await visit(base, 0)
  return result.sort((left, right) => left.operationId < right.operationId ? -1 : 1)
}

/** Create-only persistence; authorization is required by the store before this low-level call. */
export async function appendRecord(root: string, input: RemoteRecord, trust?: RecordTrust): Promise<{ created: boolean; path: string }> {
  const record = trust ? await verifyRecord(input, trust) : parseRecord(input)
  const path = recordPath(record)
  const parts = path.split(sep)
  const directory = (await checkedDirectory(root, parts.slice(0, -1), true))!
  const file = join(directory, parts.at(-1)!)
  const content = Buffer.from(serializeRecord(record))
  async function existing() {
    const before = await readCheckedFile(root, file, remoteConfigLimits.recordBytes)
    if (!matchesGitText(before, content.toString('utf8'))) throw new RemoteConfigError('id-collision', 'An immutable operation already exists with different bytes beyond LF/CRLF line endings.', entityKey(record), record.operationId)
    return { created: false, path }
  }
  try { return await existing() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const staging = (await checkedDirectory(root, ['.taskcontinuum', 'records'], true))!
  const temporary = join(staging, `.pending-${randomUUID()}`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    await checkedDirectory(root, parts.slice(0, -1))
    try { await link(temporary, file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return await existing()
    }
  } finally { await rm(temporary, { force: true }) }
  if (!inside(await realpath(root), await realpath(dirname(file)))) throw new RemoteConfigError('unsafe-path', 'The record store moved outside its root while writing.')
  await existing()
  return { created: true, path }
}

/** Mutable local state only; never use this for Git-tracked immutable records. */
export async function writeLocalState(directory: string, name: string, value: unknown): Promise<void> {
  if (!name || /[/\\]/.test(name) || name === '.' || name === '..') throw new RemoteConfigError('unsafe-path', 'Local state requires a single filename.')
  await mkdir(directory, { recursive: true })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new RemoteConfigError('unsafe-path', 'Local state must use a real directory.')
  const root = await realpath(directory)
  const file = join(root, name)
  const content = `${canonicalJson(value)}\n`
  if (Buffer.byteLength(content) > remoteConfigLimits.totalBytes) throw new RemoteConfigError('resource-limit', 'Local state exceeds its byte limit.')
  async function check() {
    try { await readCheckedFile(root, file, remoteConfigLimits.totalBytes) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  await check()
  const temporary = join(root, `.state-${randomUUID()}`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
    if (await realpath(directory) !== root) throw new RemoteConfigError('unsafe-path', 'Local state moved during its write.')
    await check()
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}
