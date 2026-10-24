import { z } from 'zod'
import {
  baselinePlanSchema, contentHash, documentSignatureSchema, preservedFileSchema, verifyDocument,
  type BaselinePlan,
} from '../remoteConfig/trustBaseline'
import { operationIdSchema, RemoteConfigError } from '../remoteConfig/records'
import { sshPublicKeySchema } from '../devTunnel/protocol'

const id = z.uuid()
const directed = { issuerId: id, recipientId: id }
export const hostReportSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('taskcontinuum-migration-inspection'),
  codeCommit: z.string().regex(/^[a-f0-9]{40}$/), capturedAt: z.iso.datetime(),
  workspaceId: id, sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  repositoryHash: operationIdSchema, workspaceRelativePath: z.string().max(4096),
  sourceRecordsHash: operationIdSchema, bindingHash: operationIdSchema, localSealHash: operationIdSchema,
  preserved: z.array(preservedFileSchema).max(10000), retiredIds: z.array(operationIdSchema).max(10000),
  localDeviceId: id, enabled: z.boolean(), admitNewDevices: z.boolean(),
  devices: z.array(z.object({
    deviceId: id, clientPublicKey: sshPublicKeySchema, hostPublicKey: sshPublicKeySchema,
    state: z.enum(['active', 'deleted']), blocked: z.boolean(),
  }).strict()).min(1).max(32),
  relationships: z.array(z.object({ ...directed, eligible: z.boolean(), revoked: z.boolean(), headId: operationIdSchema }).strict()).max(992),
  incoming: z.array(z.object({ recipientId: id, canSend: z.boolean() }).strict()).max(32),
  outgoing: z.array(z.object({ issuerId: id, enabled: z.boolean() }).strict()).max(32),
  localOwnedBindings: z.number().int().nonnegative(), confirmedLocalBindings: z.number().int().nonnegative(),
  publicRecords: z.number().int().nonnegative(), acceptedRecords: z.number().int().nonnegative(),
  outboxRecords: z.number().int().nonnegative(), unpublishedRecords: z.literal(0),
}).strict()
export type HostReport = z.infer<typeof hostReportSchema>
export const signedHostReportSchema = z.object({ report: hostReportSchema, signature: documentSignatureSchema }).strict()
export type SignedHostReport = z.infer<typeof signedHostReportSchema>
export const migrationDecisionsSchema = z.object({
  migrationId: id, coordinatorId: id,
  grants: z.array(z.object({ ...directed, canSend: z.boolean(), changeReason: z.string().min(1).max(500).optional() }).strict()).max(992),
  fenced: z.array(z.object({ deviceId: id, evidenceHash: operationIdSchema, reason: z.string().min(1).max(500) }).strict()).max(32),
  removalReason: z.string().min(1).max(500).optional(),
}).strict()
export type MigrationDecisions = z.infer<typeof migrationDecisionsSchema>

export function verifyHostReport(input: unknown): SignedHostReport {
  const signed = signedHostReportSchema.parse(input)
  const own = signed.report.devices.find((d) => d.deviceId === signed.report.localDeviceId)
  if (!own) throw new RemoteConfigError('migration-identity', 'The inspection author is absent from the preserved public identities.')
  verifyDocument('TrustMigrationInspection', signed.report, signed.signature, own.clientPublicKey)
  if (signed.report.localOwnedBindings !== signed.report.confirmedLocalBindings) throw new RemoteConfigError('migration-receipts', 'Owner-confirmation receipts do not cover the existing local bindings.')
  return signed
}
export function createMigrationPlan(inputs: unknown[], decisionsInput: unknown, now = new Date().toISOString()): BaselinePlan {
  const reports = inputs.map(verifyHostReport)
  const decisions = migrationDecisionsSchema.parse(decisionsInput)
  const first = reports.find((r) => r.report.localDeviceId === decisions.coordinatorId)?.report
  if (!first) throw new RemoteConfigError('migration-coordinator', 'The explicitly designated coordinator must provide its own signed inspection.')
  const byDevice = new Map(reports.map((r) => [r.report.localDeviceId, r]))
  if (byDevice.size !== reports.length || new Set(decisions.fenced.map((f) => f.deviceId)).size !== decisions.fenced.length) {
    throw new RemoteConfigError('migration-participants', 'Duplicate device inspection or fencing decision.')
  }
  const common = (r: HostReport) => ({
    codeCommit: r.codeCommit, workspaceId: r.workspaceId, sourceCommit: r.sourceCommit, repositoryHash: r.repositoryHash,
    workspaceRelativePath: r.workspaceRelativePath, sourceRecordsHash: r.sourceRecordsHash, bindingHash: r.bindingHash,
    preserved: r.preserved, retiredIds: r.retiredIds,
    devices: r.devices.map(({ blocked: _blocked, ...device }) => { void _blocked; return device }),
  })
  for (const { report } of reports) {
    if (contentHash(common(report)) !== contentHash(common(first))) throw new RemoteConfigError('migration-source', 'Participants disagree about source code, Git history, device keys or effective bindings.')
    if (Date.parse(now) - Date.parse(report.capturedAt) > 3600000 || Date.parse(report.capturedAt) > Date.parse(now) + 60000) {
      throw new RemoteConfigError('migration-stale', 'Signed inspections must be at most one hour old when the plan is assembled.')
    }
  }
  const devices: BaselinePlan['devices'] = first.devices.map((device) => {
    const fenced = decisions.fenced.find((d) => d.deviceId === device.deviceId)
    const report = byDevice.get(device.deviceId)
    if (fenced && report || !fenced && !report) throw new RemoteConfigError('migration-participants', 'Every known device needs exactly one signed inspection or an explicit, evidenced fencing decision; offline is not safe by default.')
    return { deviceId: device.deviceId, clientPublicKey: device.clientPublicKey, hostPublicKey: device.hostPublicKey,
      disposition: fenced ? 'fenced' : 'participating', evidenceHash: fenced?.evidenceHash ?? contentHash(report!.report) }
  })
  if (reports.some((r) => !devices.some((d) => d.deviceId === r.report.localDeviceId))
    || decisions.fenced.some((r) => !devices.some((d) => d.deviceId === r.deviceId))) throw new RemoteConfigError('migration-participants', 'The decision includes an unknown device.')
  const changes: BaselinePlan['changes'] = decisions.fenced.map((f) => ({ kind: 'fence-device', issuerId: f.deviceId, recipientId: f.deviceId, reason: f.reason }))
  for (const { report } of reports) if (report.admitNewDevices) {
    changes.push({ kind: 'freeze-auto-admission', issuerId: report.localDeviceId, recipientId: report.localDeviceId,
      reason: 'The migration baseline limits automatic admission to its approved device keys and directed grants; future additions need separate review.' })
  }
  const currentlyAllowed = (issuerId: string, recipientId: string) => {
    const issuer = byDevice.get(issuerId)?.report, recipient = byDevice.get(recipientId)?.report
    const relationship = issuer?.relationships.find((r) => r.issuerId === issuerId && r.recipientId === recipientId)
    const policy = issuer?.incoming.find((p) => p.recipientId === recipientId)
    const route = recipient?.outgoing.find((p) => p.issuerId === issuerId)
    const pinsAllow = issuer?.devices.find((d) => d.deviceId === recipientId)?.blocked === false
      && recipient?.devices.find((d) => d.deviceId === issuerId)?.blocked === false
    return { allowed: !!issuer?.enabled && !!recipient?.enabled && !!relationship?.eligible && !!policy && route?.enabled === true && pinsAllow, canSend: policy?.canSend ?? false }
  }
  for (const grant of decisions.grants) {
    if (reports.some(({ report }) => report.devices.some((device) => [grant.issuerId, grant.recipientId].includes(device.deviceId)
      && (device.blocked || device.state !== 'active')))) throw new RemoteConfigError('migration-revoked', 'Migration cannot reinstate a locally revoked or removed identity, even with a generic change reason.')
    const current = currentlyAllowed(grant.issuerId, grant.recipientId)
    if (!current.allowed) {
      if (!grant.changeReason) throw new RemoteConfigError('migration-new-trust', 'The selected grant is not currently authorized by both public and private policy. A separately reviewed trust change is required.')
      changes.push({ kind: 'new-trust', issuerId: grant.issuerId, recipientId: grant.recipientId, reason: grant.changeReason })
    }
    if (grant.canSend && !current.canSend) {
      if (!grant.changeReason) throw new RemoteConfigError('migration-permission-increase', 'A read-only grant cannot become read/send without a separately reviewed permission change.')
      changes.push({ kind: 'increase-send', issuerId: grant.issuerId, recipientId: grant.recipientId, reason: grant.changeReason })
    }
  }
  for (const relationship of first.relationships) {
    if (!currentlyAllowed(relationship.issuerId, relationship.recipientId).allowed
      || decisions.grants.some((g) => g.issuerId === relationship.issuerId && g.recipientId === relationship.recipientId)) continue
    if (!decisions.removalReason) throw new RemoteConfigError('migration-trust-removal', 'An existing authorized relationship would be removed. Review that change explicitly.')
    changes.push({ kind: 'remove-trust', issuerId: relationship.issuerId, recipientId: relationship.recipientId, reason: decisions.removalReason })
  }
  return baselinePlanSchema.parse({
    schemaVersion: 1, kind: 'taskcontinuum-trust-migration', migrationId: decisions.migrationId,
    createdAt: now, ...common(first), devices, coordinatorId: decisions.coordinatorId,
    grants: decisions.grants.map(({ changeReason: _reason, ...grant }) => { void _reason; return grant }),
    changes,
  })
}
