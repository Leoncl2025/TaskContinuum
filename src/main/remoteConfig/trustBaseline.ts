import { createHash, createPublicKey, verify } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { RemoteRecord } from '../../shared/remoteConfig'
import { sshFingerprint, sshPublicKeySchema } from '../devTunnel/protocol'
import { readJsonBounded } from '../shared/storage'
import { canonicalJson, operationIdSchema, parseRecord, readCheckedFile, RemoteConfigError, verifyRecordSignature } from './records'

export const baselineFile = 'trust-baseline.json'
export const migrationGateFile = 'trust-migration.json'
export const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/)
export const documentSignatureSchema = z.string().regex(/^[A-Za-z0-9+/]{86}==$/)
const deviceId = z.uuid().regex(/^[a-f0-9-]+$/)
const grantSchema = z.object({ issuerId: deviceId, recipientId: deviceId, canSend: z.boolean() }).strict()
export const preservedFileSchema = z.object({
  path: z.string().regex(/^\.taskcontinuum\/records\/v1\/(?:devices|aliases|bindings|settings)\//).max(512),
  operationId: operationIdSchema, sha256: operationIdSchema,
}).strict()
export const baselinePlanSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('taskcontinuum-trust-migration'),
  migrationId: z.uuid(), codeCommit: gitCommitSchema, createdAt: z.iso.datetime(),
  workspaceId: deviceId, sourceCommit: gitCommitSchema,
  repositoryHash: operationIdSchema, workspaceRelativePath: z.string().max(4096),
  sourceRecordsHash: operationIdSchema, bindingHash: operationIdSchema,
  preserved: z.array(preservedFileSchema).max(10000),
  retiredIds: z.array(operationIdSchema).max(10000),
  devices: z.array(z.object({
    deviceId, clientPublicKey: sshPublicKeySchema, hostPublicKey: sshPublicKeySchema,
    disposition: z.enum(['participating', 'fenced']),
    evidenceHash: operationIdSchema,
  }).strict()).min(1).max(32),
  coordinatorId: deviceId,
  grants: z.array(grantSchema).max(992),
  changes: z.array(z.object({
    kind: z.enum(['new-trust', 'increase-send', 'remove-trust', 'fence-device', 'freeze-auto-admission']),
    issuerId: deviceId, recipientId: deviceId, reason: z.string().min(1).max(500),
  }).strict()).max(2048),
}).strict().superRefine((plan, context) => {
  const unique = (values: string[]) => new Set(values).size === values.length
  if (!unique(plan.devices.map((d) => d.deviceId)) || !unique(plan.preserved.map((f) => f.operationId))
    || !unique(plan.preserved.map((f) => f.path)) || !unique(plan.retiredIds)
    || !unique(plan.grants.map((g) => `${g.issuerId}:${g.recipientId}`))) {
    context.addIssue({ code: 'custom', message: 'Migration identities, operations and directed grants must be unique.' })
  }
  const participants = new Set(plan.devices.filter((d) => d.disposition === 'participating').map((d) => d.deviceId))
  if (!participants.has(plan.coordinatorId)) context.addIssue({ code: 'custom', message: 'The designated coordinator must participate.' })
  for (const grant of plan.grants) {
    if (grant.issuerId === grant.recipientId || !participants.has(grant.issuerId) || !participants.has(grant.recipientId)) {
      context.addIssue({ code: 'custom', message: 'Only distinct participating devices can receive migration grants.' })
    }
  }
  if (plan.preserved.some((f) => plan.retiredIds.includes(f.operationId))) context.addIssue({ code: 'custom', message: 'Preserved and retired operations must be disjoint.' })
})
export type BaselinePlan = z.infer<typeof baselinePlanSchema>
export type BaselineGrant = z.infer<typeof grantSchema>
export const baselineApprovalSchema = z.object({ deviceId, signature: documentSignatureSchema }).strict()
export type BaselineApproval = z.infer<typeof baselineApprovalSchema>
export const baselinePinSchema = z.object({
  schemaVersion: z.literal(1), plan: baselinePlanSchema,
  baselineCommit: gitCommitSchema, authorizationCommit: gitCommitSchema,
  approvals: z.array(baselineApprovalSchema).min(1).max(32),
}).strict()
export type BaselinePin = z.infer<typeof baselinePinSchema>
const descriptorFields = {
  kind: z.literal('taskcontinuum-workspace'), workspaceId: deviceId,
  remoteConfigFormat: z.literal('immutable-operations-v1'),
}
export const workspaceDescriptorSchema = z.discriminatedUnion('schemaVersion', [
  z.object({ schemaVersion: z.literal(1), ...descriptorFields }).strict(),
  z.object({
    schemaVersion: z.literal(2), ...descriptorFields,
    trustBaseline: z.object({ migrationId: z.uuid(), planHash: operationIdSchema }).strict(),
  }).strict(),
])
export type WorkspaceDescriptor = z.infer<typeof workspaceDescriptorSchema>

export function contentHash(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex') }
export function bytesHash(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex') }
export function planHash(plan: BaselinePlan): string { return contentHash(baselinePlanSchema.parse(plan)) }
export function documentSigningBytes(domain: string, document: unknown): Buffer {
  return Buffer.from(`TaskCon.${domain}.v1\n${canonicalJson(document)}`, 'utf8')
}
export function verifyDocument(domain: string, document: unknown, signature: string, publicKey: string): void {
  documentSignatureSchema.parse(signature)
  const key = sshPublicKeySchema.parse(publicKey)
  const raw = Buffer.from(key.split(' ')[1], 'base64').subarray(19)
  const parsed = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
  if (!verify(null, documentSigningBytes(domain, document), parsed, Buffer.from(signature, 'base64'))) {
    throw new RemoteConfigError('invalid-signature', 'The migration document signature is invalid.')
  }
}
export function approvalBody(plan: BaselinePlan) {
  return { migrationId: plan.migrationId, planHash: planHash(plan), codeCommit: plan.codeCommit, sourceCommit: plan.sourceCommit }
}
export function verifyApprovals(plan: BaselinePlan, approvals: BaselineApproval[]): void {
  const expected = plan.devices.filter((d) => d.disposition === 'participating')
  if (approvals.length !== expected.length || new Set(approvals.map((a) => a.deviceId)).size !== approvals.length) {
    throw new RemoteConfigError('migration-participants', 'Every participating device must approve this exact migration; missing or duplicate approvals are not accepted.')
  }
  for (const device of expected) {
    const approval = approvals.find((a) => a.deviceId === device.deviceId)
    if (!approval) throw new RemoteConfigError('migration-participants', 'A participating device has not prepared and approved this migration.')
    verifyDocument('TrustMigrationApproval', approvalBody(plan), approval.signature, device.clientPublicKey)
  }
}
export function baselineDescriptor(plan: BaselinePlan): WorkspaceDescriptor {
  return { schemaVersion: 2, kind: 'taskcontinuum-workspace', workspaceId: plan.workspaceId,
    remoteConfigFormat: 'immutable-operations-v1', trustBaseline: { migrationId: plan.migrationId, planHash: planHash(plan) } }
}
export async function readWorkspaceDescriptor(root: string): Promise<WorkspaceDescriptor | undefined> {
  try { return workspaceDescriptorSchema.parse(JSON.parse((await readCheckedFile(root, join(root, '.taskcontinuum', 'workspace.json'), 8192)).toString('utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export async function readBaselinePin(directory: string): Promise<BaselinePin | undefined> {
  try {
    const pin = baselinePinSchema.parse(await readJsonBounded(join(directory, baselineFile), 8 * 1024 * 1024))
    verifyApprovals(pin.plan, pin.approvals)
    return pin
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export function assertBaselineDescriptor(descriptor: unknown, pin: BaselinePin | undefined): void {
  const parsed = descriptor === undefined ? undefined : workspaceDescriptorSchema.parse(descriptor)
  if (pin ? canonicalJson(parsed ?? null) !== canonicalJson(baselineDescriptor(pin.plan)) : parsed?.schemaVersion === 2) {
    throw new RemoteConfigError('migration-baseline', 'The workspace trust baseline does not match the approved local checkpoint. Run the approved migration tool; do not reset the profile.')
  }
}
export async function assertMigrationReady(root: string, directory: string): Promise<BaselinePin | undefined> {
  try {
    await readJsonBounded(join(directory, migrationGateFile), 8192)
    throw new RemoteConfigError('migration-incomplete', 'A trust migration is prepared or interrupted. Keep Task Continuum stopped and resume the same approved migration tool.')
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const pin = await readBaselinePin(directory)
  if (pin) {
    const state = z.object({
      schemaVersion: z.literal(1), workspaceId: z.literal(pin.plan.workspaceId), initialized: z.literal(true),
      canonicalIds: z.array(operationIdSchema).max(10000), localIds: z.array(operationIdSchema).max(10000),
    }).strict().parse(await readJsonBounded(join(directory, 'store', 'store.json'), 2 * 1024 * 1024))
    if (state.canonicalIds.length !== new Set(state.canonicalIds).size || pin.plan.preserved.some((f) => !state.canonicalIds.includes(f.operationId))) {
      throw new RemoteConfigError('migration-state', 'The migrated accepted-operation frontier is missing or was reset.')
    }
  }
  let descriptor: unknown
  try { descriptor = JSON.parse((await readCheckedFile(root, join(root, '.taskcontinuum', 'workspace.json'), 8192)).toString('utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (pin || descriptor && typeof descriptor === 'object' && 'schemaVersion' in descriptor && descriptor.schemaVersion === 2) assertBaselineDescriptor(descriptor, pin)
  return pin
}
export function baselineGrant(pin: BaselinePin | undefined, issuerId: string, recipientId: string): BaselineGrant | undefined {
  return pin?.plan.grants.find((grant) => grant.issuerId === issuerId && grant.recipientId === recipientId)
}
export function baselineAllowsRecord(pin: BaselinePin | undefined, record: RemoteRecord): boolean {
  if (!pin) return true
  const device = pin.plan.devices.find((d) => d.deviceId === record.actor.deviceId)
  if (!device || sshFingerprint(device.clientPublicKey) !== record.actor.keyId || pin.plan.retiredIds.includes(record.operationId)) return false
  if (pin.plan.preserved.some((f) => f.operationId === record.operationId)) return true
  if (device.disposition !== 'participating') return false
  if (record.kind === 'invitation' && record.payload.action === 'grant') return !!baselineGrant(pin, record.payload.issuerId, record.payload.recipientId)
  return true
}
export function validateBaselineFiles(files: ReadonlyMap<string, { content: string }>, pin: BaselinePin): void {
  const descriptor = files.get('.taskcontinuum/workspace.json')
  assertBaselineDescriptor(descriptor ? JSON.parse(descriptor.content) : undefined, pin)
  for (const preserved of pin.plan.preserved) {
    const file = files.get(preserved.path)
    if (!file || bytesHash(file.content) !== preserved.sha256) throw new RemoteConfigError('migration-preservation', 'A baseline-preserved operation was removed or changed.')
  }
  for (const [path, file] of files) {
    if (!path.startsWith('.taskcontinuum/records/v1/')) continue
    const record = parseRecord(JSON.parse(file.content))
    if (!baselineAllowsRecord(pin, record)) throw new RemoteConfigError('migration-policy', 'An operation is outside the approved migration participants or trust relationships.')
    const device = pin.plan.devices.find((d) => d.deviceId === record.actor.deviceId)!
    verifyRecordSignature(record, device.clientPublicKey)
  }
}
