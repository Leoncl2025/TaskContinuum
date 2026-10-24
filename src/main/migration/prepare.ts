import { readFile } from 'node:fs/promises'
import { join, parse, relative } from 'node:path'
import { z } from 'zod'
import type { RemoteRecord } from '../../shared/remoteConfig'
import { sshFingerprint } from '../devTunnel/protocol'
import { canonicalJson, createRecord, parseRecord, RemoteConfigError, resolveRecords, verifyRecordSignature, type RecordSigner } from '../remoteConfig/records'
import {
  approvalBody, baselineApprovalSchema, baselinePlanSchema, bytesHash, contentHash, documentSignatureSchema,
  documentSigningBytes, migrationGateFile, planHash, verifyDocument, type BaselinePlan,
} from '../remoteConfig/trustBaseline'
import { assertNoProfileProcess, gitText, inspectRepository } from './git'
import {
  assertOutside, assertPlanMatchesHost, existing, existingSigner, inspectHost, migrationRuntimeSchema, migrationStoreSchema,
  profileIdentityStamps, regularJson, syncDirectory, treeStamps, type MigrationHostOptions,
} from './local'
import { readMigrationFiles } from './legacyRecords'
import { hostReportSchema, verifyHostReport } from './model'
import { assertPrivateDestination, copyVerifiedTree, protectedDirectory, putJsonExact, replaceExpected } from './storage'

const stampSchema = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const preparationSchema = z.object({
  schemaVersion: z.literal(1), plan: baselinePlanSchema, report: hostReportSchema,
  workspaceRoot: z.string(), profileRoot: z.string(), relativeSync: z.string(), relativeReplica: z.string(),
  profileStamps: z.array(stampSchema), syncStamps: z.array(stampSchema),
  profileBackup: z.array(stampSchema), workspaceBackup: z.array(stampSchema),
  repositoryBundleHash: z.string().regex(/^[a-f0-9]{64}$/),
  anchors: z.array(z.object({ ref: z.string(), oid: z.string().regex(/^[a-f0-9]{40}$/) }).strict()),
  runtime: migrationRuntimeSchema, store: migrationStoreSchema,
}).strict()
export type Preparation = z.infer<typeof preparationSchema>
export const preparedBundleSchema = z.object({
  schemaVersion: z.literal(1), planHash: z.string().regex(/^[a-f0-9]{64}$/), deviceId: z.uuid(),
  approval: baselineApprovalSchema, backupHash: z.string().regex(/^[a-f0-9]{64}$/),
  reportHash: z.string().regex(/^[a-f0-9]{64}$/), grants: z.array(z.unknown()).max(31),
  signature: documentSignatureSchema,
}).strict()
export type PreparedBundle = z.infer<typeof preparedBundleSchema>
export type MigrationFault = (phase: 'backed-up' | 'gated' | 'commits-created' | 'published' | 'checkout-written' | 'checkout-updated' | 'staged' | 'archived' | 'installed' | 'anchored') => Promise<void>
export interface PrepareOptions extends MigrationHostOptions {
  checkpointRoot: string
  approvedHash: string
  plan: unknown
  report: unknown
  assertStopped?: () => Promise<void>
  fault?: MigrationFault
}
export function migrationGate(plan: BaselinePlan) {
  return { schemaVersion: 1, migrationId: plan.migrationId, planHash: planHash(plan), state: 'prepared' }
}
export function gatedRuntime(plan: BaselinePlan) {
  return { schemaVersion: 'trust-migration-pending', migrationId: plan.migrationId, planHash: planHash(plan) }
}
export function stableMigrationId(plan: BaselinePlan, label: string): string {
  const hash = bytesHash(`${plan.migrationId}\n${label}`)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
export async function grantInputs(plan: BaselinePlan, source: RemoteRecord[]) {
  const resolution = await resolveRecords(source, {
    workspaceId: plan.workspaceId,
    trustedKey: (actor) => plan.devices.find((d) => d.deviceId === actor.deviceId)?.clientPublicKey,
    authorize: () => true,
  })
  if (resolution.blocked || resolution.diagnostics.length) throw new RemoteConfigError('migration-conflict', 'The preserved baseline does not resolve without conflicts.')
  return plan.grants.map((grant) => {
    const issuer = resolution.devices[grant.issuerId], recipient = resolution.devices[grant.recipientId]
    const device = plan.devices.find((d) => d.deviceId === grant.issuerId)!
    if (!issuer || !recipient || issuer.payload.action !== 'publish' || !issuer.payload.routes[0]?.controlPort) throw new RemoteConfigError('migration-identity', 'A planned grant lacks an active issuer/recipient identity and route.')
    const key = `${grant.issuerId}:${grant.recipientId}`
    return {
      schemaVersion: 1 as const, kind: 'invitation' as const, workspaceId: plan.workspaceId,
      actor: { deviceId: grant.issuerId, keyId: sshFingerprint(device.clientPublicKey) },
      nonce: stableMigrationId(plan, `nonce:${key}`), createdAt: plan.createdAt, parents: [],
      payload: {
        action: 'grant' as const, capability: 'ah-link' as const, issuerId: grant.issuerId, recipientId: grant.recipientId,
        grantId: stableMigrationId(plan, `grant:${key}`), issuerIdentityRef: issuer.operationId, recipientIdentityRef: recipient.operationId,
        issuedAt: plan.createdAt, lifetime: 'until-revoked' as const, routeRef: { identityRef: issuer.operationId, routeIndex: 0 },
      },
    }
  })
}
async function signText(sign: RecordSigner, domain: string, body: unknown): Promise<string> {
  const result = await sign(documentSigningBytes(domain, body))
  return typeof result === 'string' ? result : result.toString('base64')
}
export async function validatePreparedBundle(plan: BaselinePlan, input: unknown, source: RemoteRecord[]): Promise<PreparedBundle> {
  const bundle = preparedBundleSchema.parse(input)
  const device = plan.devices.find((d) => d.deviceId === bundle.deviceId && d.disposition === 'participating')
  if (!device || bundle.planHash !== planHash(plan) || bundle.reportHash !== device.evidenceHash || bundle.approval.deviceId !== bundle.deviceId) {
    throw new RemoteConfigError('migration-approval', 'A prepared device bundle belongs to another plan or identity.')
  }
  verifyDocument('TrustMigrationApproval', approvalBody(plan), bundle.approval.signature, device.clientPublicKey)
  const { signature, ...body } = bundle
  verifyDocument('TrustMigrationPrepared', body, signature, device.clientPublicKey)
  const expected = (await grantInputs(plan, source)).filter((g) => g.actor.deviceId === bundle.deviceId)
  if (expected.length !== bundle.grants.length) throw new RemoteConfigError('migration-grants', 'A prepared device has missing or extra signed grants.')
  const seen = new Set<string>()
  for (const input of bundle.grants) {
    const record = parseRecord(input)
    verifyRecordSignature(record, device.clientPublicKey)
    const { operationId: _id, signature: _signature, ...actual } = record
    void _id; void _signature
    const desired = expected.find((g) => g.nonce === record.nonce)
    if (!desired || seen.has(record.nonce) || canonicalJson(actual) !== canonicalJson(desired)) throw new RemoteConfigError('migration-grants', 'A signed grant differs from the approved exact issuer, recipient, identity or nonce.')
    seen.add(record.nonce)
  }
  return bundle
}
export async function readPreparation(options: Pick<PrepareOptions, 'checkpointRoot' | 'workspaceRoot' | 'profileRoot' | 'codeCommit' | 'approvedHash'>): Promise<Preparation> {
  const state = preparationSchema.parse(await regularJson(join(options.checkpointRoot, 'preparation.json'), 32 * 1024 * 1024))
  if (state.workspaceRoot !== options.workspaceRoot || state.profileRoot !== options.profileRoot || state.plan.codeCommit !== options.codeCommit || planHash(state.plan) !== options.approvedHash
    || join(state.profileRoot, state.relativeSync) !== syncDirectory(state.profileRoot, state.workspaceRoot)
    || !/^checkout-v2-[a-f0-9]{64}$/.test(state.relativeReplica)) throw new RemoteConfigError('migration-checkpoint', 'The private checkpoint does not match this machine, profile, code or approved plan.')
  if (contentHash(state.profileBackup) !== contentHash(await treeStamps(join(options.checkpointRoot, 'profile-backup')))
    || contentHash(state.workspaceBackup) !== contentHash(await treeStamps(join(options.checkpointRoot, 'workspace-backup')))
    || bytesHash(await readFile(join(options.checkpointRoot, 'repository.bundle'))) !== state.repositoryBundleHash) {
    throw new RemoteConfigError('migration-backup', 'A protected backup is missing or has changed; migration cannot resume.')
  }
  return state
}
export async function assertOriginalIdentity(preparation: Preparation): Promise<void> {
  if (contentHash(preparation.profileStamps) !== contentHash(await profileIdentityStamps(preparation.profileRoot))) throw new RemoteConfigError('migration-changed', 'Device identity, keys, permissions or owner receipts changed after preparation.')
}
export async function prepareHost(options: PrepareOptions): Promise<PreparedBundle> {
  const stop = options.assertStopped ?? (() => assertNoProfileProcess(options.profileRoot))
  await stop()
  const plan = baselinePlanSchema.parse(options.plan)
  if (plan.codeCommit !== options.codeCommit || planHash(plan) !== options.approvedHash) throw new RemoteConfigError('migration-approval', 'Supply the exact approved plan hash and run its fixed code version.')
  const checkpoint = options.checkpointRoot
  await assertPrivateDestination(checkpoint)
  assertOutside(options.profileRoot, checkpoint)
  const repository = await inspectRepository(options.workspaceRoot, !await existing(join(checkpoint, 'preparation.json')))
  assertOutside(repository.repositoryRoot, checkpoint)
  if (parse(checkpoint).root.toLowerCase() !== parse(options.profileRoot).root.toLowerCase()) throw new RemoteConfigError('migration-volume', 'The protected checkpoint and profile must be on the same volume for atomic state installation.')
  await protectedDirectory(checkpoint)
  let preparation: Preparation
  if (await existing(join(checkpoint, 'preparation.json'))) preparation = await readPreparation(options)
  else {
    const signed = verifyHostReport(options.report)
    const inspection = await inspectHost(options)
    inspection.report = { ...inspection.report, capturedAt: signed.report.capturedAt }
    if (contentHash(inspection.report) !== contentHash(signed.report)) throw new RemoteConfigError('migration-changed', 'The approved inspection changed before preparation.')
    assertPlanMatchesHost(plan, inspection, options.approvedHash)
    const profileBackup = await copyVerifiedTree(options.profileRoot, join(checkpoint, 'profile-backup'))
    const workspaceBackup = await copyVerifiedTree(options.workspaceRoot, join(checkpoint, 'workspace-backup'))
    const bundleFile = join(checkpoint, 'repository.bundle')
    if (!await existing(bundleFile)) await gitText(repository.repositoryRoot, 'bundle', 'create', bundleFile, '--all')
    await gitText(repository.repositoryRoot, 'bundle', 'verify', bundleFile)
    await stop()
    if (contentHash(inspection.profileStamps) !== contentHash(await profileIdentityStamps(options.profileRoot))
      || contentHash(inspection.syncStamps) !== contentHash(await treeStamps(inspection.syncDirectory))) throw new RemoteConfigError('migration-changed', 'The original state changed while preparing its backup.')
    preparation = preparationSchema.parse({
      schemaVersion: 1, plan, report: inspection.report, workspaceRoot: options.workspaceRoot, profileRoot: options.profileRoot,
      relativeSync: relative(options.profileRoot, inspection.syncDirectory), relativeReplica: relative(inspection.syncDirectory, inspection.replicaDirectory),
      profileStamps: inspection.profileStamps, syncStamps: inspection.syncStamps, profileBackup, workspaceBackup,
      repositoryBundleHash: bytesHash(await readFile(bundleFile)),
      anchors: inspection.anchors, runtime: inspection.runtime, store: inspection.store,
    })
    await putJsonExact(join(checkpoint, 'preparation.json'), preparation)
    await options.fault?.('backed-up')
  }
  await assertOriginalIdentity(preparation)
  const directory = join(preparation.profileRoot, preparation.relativeSync)
  const gate = migrationGate(plan)
  const expected = preparation.syncStamps.filter((s) => s.path !== 'runtime.json')
  const actual = (await treeStamps(directory)).filter((s) => s.path !== 'runtime.json' && s.path !== migrationGateFile)
  if (contentHash(expected) !== contentHash(actual)) throw new RemoteConfigError('migration-changed', 'Cached, pending or accepted records changed after preparation.')
  await putJsonExact(join(directory, migrationGateFile), gate)
  await replaceExpected(join(directory, 'runtime.json'), preparation.syncStamps.find((s) => s.path === 'runtime.json')!.sha256, gatedRuntime(plan))
  await options.fault?.('gated')
  await stop()
  const retained = (await readMigrationFiles(join(checkpoint, 'workspace-backup'))).filter((f) => f.record.kind !== 'invitation').map((f) => parseRecord(f.record))
  const saved = join(checkpoint, 'prepared-public.json')
  if (await existing(saved)) return validatePreparedBundle(plan, await regularJson(saved), retained)
  const sign = await existingSigner(options.profileRoot, options.protector)
  const grants = await Promise.all((await grantInputs(plan, retained)).filter((g) => g.actor.deviceId === preparation.report.localDeviceId).map((input) => createRecord(input, sign)))
  const body = {
    schemaVersion: 1 as const, planHash: options.approvedHash, deviceId: preparation.report.localDeviceId,
    approval: { deviceId: preparation.report.localDeviceId, signature: await signText(sign, 'TrustMigrationApproval', approvalBody(plan)) },
    backupHash: contentHash({ profile: preparation.profileBackup, workspace: preparation.workspaceBackup, gitBundle: bytesHash(await readFile(join(checkpoint, 'repository.bundle'))) }),
    reportHash: contentHash(preparation.report), grants,
  }
  const bundle = { ...body, signature: await signText(sign, 'TrustMigrationPrepared', body) }
  await validatePreparedBundle(plan, bundle, retained)
  await putJsonExact(saved, bundle)
  return bundle
}
