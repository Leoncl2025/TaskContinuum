import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { RemoteRecord } from '../../shared/remoteConfig'
import {
  canonicalJson, parseRecord, readRecords, recordPath, RemoteConfigError, resolveRecords, serializeRecord,
} from '../remoteConfig/records'
import {
  baselineDescriptor, baselineFile, baselinePinSchema, bytesHash, contentHash, gitCommitSchema, migrationGateFile, planHash,
  validateBaselineFiles, verifyApprovals, type BaselinePin, type BaselinePlan,
} from '../remoteConfig/trustBaseline'
import {
  assertNoProfileProcess, gitPublicFiles, gitText, inspectRepository, isAncestor, migrationGit, remoteHead, repositoryPath,
  type MigrationRepository,
} from './git'
import { existing, regularJson, treeStamps } from './local'
import { readMigrationFiles } from './legacyRecords'
import {
  assertOriginalIdentity, gatedRuntime, migrationGate, readPreparation, validatePreparedBundle,
  type MigrationFault, type Preparation, type PreparedBundle, type PrepareOptions,
} from './prepare'
import { protectedDirectory, putExact, putJsonExact } from './storage'

export const cutoverReceiptSchema = z.object({
  schemaVersion: z.literal(1), checkpoint: baselinePinSchema,
  bundles: z.array(z.unknown()).min(1).max(32),
}).strict()
export type CutoverReceipt = z.infer<typeof cutoverReceiptSchema>
export interface CutoverOptions extends Pick<PrepareOptions, 'workspaceRoot' | 'profileRoot' | 'checkpointRoot' | 'codeCommit' | 'approvedHash' | 'assertStopped'> {
  fault?: MigrationFault
}
async function preservedSource(checkpoint: string): Promise<RemoteRecord[]> {
  return (await readMigrationFiles(join(checkpoint, 'workspace-backup')))
    .filter((file) => file.record.kind !== 'invitation').map((file) => parseRecord(file.record))
}
async function validateBundles(plan: BaselinePlan, inputs: unknown[], source: RemoteRecord[]): Promise<PreparedBundle[]> {
  const bundles: PreparedBundle[] = []
  for (const input of inputs) bundles.push(await validatePreparedBundle(plan, input, source))
  verifyApprovals(plan, bundles.map((b) => b.approval))
  return bundles
}
async function commitTree(repository: MigrationRepository, parent: string, files: Map<string, string | null>, plan: BaselinePlan, checkpoint: string, label: string): Promise<string> {
  const index = join(checkpoint, `git-index-${randomUUID()}`)
  const env = {
    GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'Task Continuum', GIT_AUTHOR_EMAIL: 'taskcontinuum@localhost',
    GIT_COMMITTER_NAME: 'Task Continuum', GIT_COMMITTER_EMAIL: 'taskcontinuum@localhost',
    GIT_AUTHOR_DATE: plan.createdAt, GIT_COMMITTER_DATE: plan.createdAt,
  }
  try {
    await migrationGit(repository.repositoryRoot, ['read-tree', parent], { env })
    let input = ''
    for (const [path, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      const oid = content === null ? '0'.repeat(40) : (await migrationGit(repository.repositoryRoot, ['hash-object', '-w', '--stdin'], { input: content })).stdout.trim()
      gitCommitSchema.parse(oid)
      input += `${content === null ? '0' : '100644'} ${oid}\t${repositoryPath(repository, path)}\0`
    }
    await migrationGit(repository.repositoryRoot, ['update-index', '-z', '--index-info'], { input, env })
    const tree = (await migrationGit(repository.repositoryRoot, ['write-tree'], { env })).stdout.trim()
    const message = `Task Continuum trust migration: ${label}\n\nMigration-ID: ${plan.migrationId}\nPlan-SHA256: ${planHash(plan)}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`
    return gitCommitSchema.parse((await migrationGit(repository.repositoryRoot, ['commit-tree', tree, '-p', parent, '-m', message], { env })).stdout.trim())
  } finally {
    if (await existing(index)) await rm(index)
  }
}
async function assertPreparedState(preparation: Preparation): Promise<void> {
  await assertOriginalIdentity(preparation)
  const directory = join(preparation.profileRoot, preparation.relativeSync)
  if (canonicalJson(await regularJson(join(directory, migrationGateFile))) !== canonicalJson(migrationGate(preparation.plan))
    || canonicalJson(await regularJson(join(directory, 'runtime.json'))) !== canonicalJson(gatedRuntime(preparation.plan))) {
    throw new RemoteConfigError('migration-not-stopped', 'This host has not been durably gated for the approved migration.')
  }
  const unchanged = (await treeStamps(directory)).filter((s) => s.path !== 'runtime.json' && s.path !== migrationGateFile)
  if (contentHash(unchanged) !== contentHash(preparation.syncStamps.filter((s) => s.path !== 'runtime.json'))) {
    throw new RemoteConfigError('migration-changed', 'Accepted history or pending operations changed after this host prepared.')
  }
}
async function validateSource(repository: MigrationRepository, plan: BaselinePlan): Promise<Map<string, { content: string }>> {
  if (repository.repositoryHash !== plan.repositoryHash || repository.relativePath !== plan.workspaceRelativePath) throw new RemoteConfigError('migration-upstream', 'The selected repository is not the approved source.')
  const files = await gitPublicFiles(repository, plan.sourceCommit)
  const rows = [...files].filter(([path]) => path.startsWith('.taskcontinuum/records/v1/'))
  const hash = contentHash(rows.map(([path, f]) => [path, bytesHash(f.content)]).sort((a, b) => a[0].localeCompare(b[0])))
  if (hash !== plan.sourceRecordsHash) throw new RemoteConfigError('migration-source', 'The approved Git source record manifest differs.')
  return files
}
async function buildCommits(repository: MigrationRepository, preparation: Preparation, bundles: PreparedBundle[], checkpoint: string): Promise<BaselinePin> {
  const plan = preparation.plan
  const source = await validateSource(repository, plan)
  const changes = new Map<string, string | null>()
  changes.set('.taskcontinuum/workspace.json', JSON.stringify(baselineDescriptor(plan), null, 2) + '\n')
  for (const [path, file] of source) {
    if (!path.startsWith('.taskcontinuum/records/v1/')) continue
    const value: unknown = JSON.parse(file.content)
    if (value && typeof value === 'object' && 'operationId' in value && typeof value.operationId === 'string' && plan.retiredIds.includes(value.operationId)) changes.set(path, null)
  }
  if (changes.size !== plan.retiredIds.length + 1) throw new RemoteConfigError('migration-source', 'The exact retired operations are not all present in the approved source.')
  const baselineCommit = await commitTree(repository, plan.sourceCommit, changes, plan, checkpoint, 'approved baseline')
  const additions = new Map<string, string>()
  for (const bundle of bundles) for (const input of bundle.grants) {
    const record = parseRecord(input)
    const path = recordPath(record).replaceAll('\\', '/')
    if (source.has(path) || additions.has(path)) throw new RemoteConfigError('migration-grants', 'A new grant collides with existing immutable history.')
    additions.set(path, serializeRecord(record))
  }
  const authorizationCommit = await commitTree(repository, baselineCommit, additions, plan, checkpoint, 'device-signed grants')
  const pin = baselinePinSchema.parse({ schemaVersion: 1, plan, baselineCommit, authorizationCommit, approvals: bundles.map((b) => b.approval) })
  validateBaselineFiles(await gitPublicFiles(repository, baselineCommit), pin)
  validateBaselineFiles(await gitPublicFiles(repository, authorizationCommit), pin)
  return pin
}
export async function publishCutover(options: CutoverOptions, inputs: unknown[]): Promise<CutoverReceipt> {
  await (options.assertStopped ?? (() => assertNoProfileProcess(options.profileRoot)))()
  const preparation = await readPreparation(options)
  if (preparation.report.localDeviceId !== preparation.plan.coordinatorId) throw new RemoteConfigError('migration-coordinator', 'Only the explicitly approved coordinator may publish the shared cutover.')
  await assertPreparedState(preparation)
  const repository = await inspectRepository(options.workspaceRoot, false)
  if (repository.head !== preparation.plan.sourceCommit || await gitText(repository.repositoryRoot, 'status', '--porcelain=v1')) {
    throw new RemoteConfigError('migration-changed', 'The coordinator source checkout changed; no shared history was rewritten.')
  }
  const bundles = await validateBundles(preparation.plan, inputs, await preservedSource(options.checkpointRoot))
  const checkpoint = await buildCommits(repository, preparation, bundles, options.checkpointRoot)
  const receipt = { schemaVersion: 1 as const, checkpoint, bundles }
  await putJsonExact(join(options.checkpointRoot, 'cutover-public.json'), receipt)
  await options.fault?.('commits-created')
  const remote = await remoteHead(repository)
  if (remote !== checkpoint.authorizationCommit) {
    if (remote !== preparation.plan.sourceCommit) throw new RemoteConfigError('migration-upstream', 'The shared upstream advanced or changed after approval; it was not overwritten.')
    await migrationGit(repository.repositoryRoot, ['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', '--', repository.remote, `${checkpoint.authorizationCommit}:${repository.remoteBranch}`])
  }
  if (await remoteHead(repository) !== checkpoint.authorizationCommit) throw new RemoteConfigError('migration-publication', 'The cutover publication could not be confirmed. Keep participants stopped and inspect the same receipt.')
  await options.fault?.('published')
  return receipt
}
async function validateReceipt(repository: MigrationRepository, preparation: Preparation, input: unknown, checkpointRoot: string): Promise<CutoverReceipt> {
  const receipt = cutoverReceiptSchema.parse(input)
  if (planHash(receipt.checkpoint.plan) !== planHash(preparation.plan)) throw new RemoteConfigError('migration-baseline', 'The received cutover uses another migration plan.')
  const bundles = await validateBundles(preparation.plan, receipt.bundles, await preservedSource(checkpointRoot))
  const expected = await buildCommits(repository, preparation, bundles, checkpointRoot)
  if (canonicalJson(expected) !== canonicalJson(receipt.checkpoint)) throw new RemoteConfigError('migration-baseline', 'The baseline or authorization commit differs from the exact approved cutover.')
  return receipt
}
async function verifyAppendOnly(repository: MigrationRepository, pin: BaselinePin, head: string): Promise<void> {
  if (!await isAncestor(repository, pin.authorizationCommit, head)) throw new RemoteConfigError('migration-rollback', 'The checkout does not descend from the exact authorized cutover.')
  const tokens = (await migrationGit(repository.repositoryRoot, [
    'log', '--format=', '--name-status', '-z', '--no-renames', '--diff-merges=separate',
    `${pin.authorizationCommit}..${head}`, '--', repositoryPath(repository, '.taskcontinuum/workspace.json'), repositoryPath(repository, '.taskcontinuum/records'),
  ])).stdout.split('\0').filter(Boolean)
  for (let i = 0; i < tokens.length; i += 2) {
    const path = tokens[i + 1]
    if (tokens[i].trim() !== 'A' || !path?.startsWith(repositoryPath(repository, '.taskcontinuum/records/v1/'))) {
      throw new RemoteConfigError('migration-rollback', 'History after the approved cutover changed or removed immutable configuration.')
    }
  }
  validateBaselineFiles(await gitPublicFiles(repository, head), pin)
}
const applyJournalSchema = z.object({
  schemaVersion: z.literal(1), planHash: z.string().regex(/^[a-f0-9]{64}$/),
  targetCommit: gitCommitSchema, baselineCommit: gitCommitSchema, authorizationCommit: gitCommitSchema,
}).strict()
async function advanceCheckout(repository: MigrationRepository, source: string, target: string, fault?: MigrationFault): Promise<void> {
  const head = await gitText(repository.repositoryRoot, 'rev-parse', 'HEAD')
  if (head !== source && head !== target) throw new RemoteConfigError('migration-changed', 'The selected branch moved outside the recorded source and target.')
  if (await gitText(repository.repositoryRoot, 'ls-files', '--others', '--exclude-standard')) throw new RemoteConfigError('migration-dirty', 'Untracked user files appeared during cutover.')
  const cleanTarget = (await migrationGit(repository.repositoryRoot, ['diff-index', '--cached', '--quiet', target, '--'], { allowFailure: true })).code === 0
    && (await migrationGit(repository.repositoryRoot, ['diff-files', '--quiet'], { allowFailure: true })).code === 0
  if (head === target) {
    if (!cleanTarget) throw new RemoteConfigError('migration-dirty', 'The adopted checkout has user modifications.')
    return
  }
  const lockPath = join(await gitText(repository.repositoryRoot, 'rev-parse', '--absolute-git-dir'), 'HEAD.lock')
  const lock = await open(lockPath, 'wx', 0o600)
  try {
    if (await gitText(repository.repositoryRoot, 'symbolic-ref', 'HEAD') !== repository.sourceBranch || await gitText(repository.repositoryRoot, 'rev-parse', 'HEAD') !== source) {
      throw new RemoteConfigError('migration-changed', 'The branch changed before the approved checkout update.')
    }
    if (!cleanTarget) {
      if (await gitText(repository.repositoryRoot, 'status', '--porcelain=v1')) throw new RemoteConfigError('migration-dirty', 'The original checkout changed; no reset was attempted.')
      const additions = (await migrationGit(repository.repositoryRoot, ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=A', '-r', '-z', source, target])).stdout.split('\0').filter(Boolean)
      for (const path of additions) if (await existing(join(repository.repositoryRoot, ...path.split('/')))) throw new RemoteConfigError('migration-dirty', 'An incoming path would overwrite a local or ignored file.')
      await migrationGit(repository.repositoryRoot, ['read-tree', '-m', '-u', source, target])
      await fault?.('checkout-written')
    }
  } finally { await lock.close(); await rm(lockPath) }
  if (await gitText(repository.repositoryRoot, 'symbolic-ref', 'HEAD') !== repository.sourceBranch) throw new RemoteConfigError('migration-changed', 'The selected branch changed during checkout installation.')
  await migrationGit(repository.repositoryRoot, ['update-ref', repository.sourceBranch, target, source])
}
async function stageLocal(preparation: Preparation, receipt: CutoverReceipt, repository: MigrationRepository, target: string, checkpoint: string): Promise<string> {
  const stage = join(checkpoint, 'new-sync')
  await protectedDirectory(stage)
  const backup = join(checkpoint, 'profile-backup', preparation.relativeSync)
  for (const stamp of preparation.syncStamps) {
    const path = stamp.path.replaceAll('\\', '/')
    if (path.startsWith('records-cache/') || path.startsWith('outbox/') || ['runtime.json', 'store/store.json', 'store/store.lock'].includes(path)
      || path === `${preparation.relativeReplica}/publications.json`) continue
    await putExact(join(stage, stamp.path), await readFile(join(backup, stamp.path), 'utf8'))
  }
  const publicFiles = await gitPublicFiles(repository, target)
  const records = [...publicFiles].filter(([path]) => path.startsWith('.taskcontinuum/records/v1/'))
  for (const [path, file] of records) {
    const content = preparation.plan.preserved.some((f) => f.path === path)
      ? await readFile(join(backup, 'records-cache', ...path.split('/')), 'utf8') : file.content
    if (content.replaceAll('\r\n', '\n') !== file.content.replaceAll('\r\n', '\n')) throw new RemoteConfigError('migration-preservation', 'A retained cached operation differs from its approved Git blob.')
    await putExact(join(stage, 'records-cache', ...path.split('/')), content)
  }
  await mkdir(join(stage, 'outbox'), { recursive: true, mode: 0o700 })
  const keptLocal = preparation.store.localIds.filter((id) => !preparation.plan.retiredIds.includes(id))
  for (const [path, file] of records) {
    const record = parseRecord(JSON.parse(file.content))
    if (keptLocal.includes(record.operationId) || record.actor.deviceId === preparation.report.localDeviceId && receipt.bundles.some((b) => {
      const bundle = b as PreparedBundle
      return bundle.grants.some((g) => parseRecord(g).operationId === record.operationId)
    })) {
      const original = join(backup, 'outbox', ...path.split('/'))
      const content = preparation.plan.preserved.some((f) => f.path === path) && await existing(original) ? await readFile(original, 'utf8') : file.content
      if (content.replaceAll('\r\n', '\n') !== file.content.replaceAll('\r\n', '\n')) throw new RemoteConfigError('migration-preservation', 'A retained outbox operation differs from its approved Git blob.')
      await putExact(join(stage, 'outbox', ...path.split('/')), content)
      if (!keptLocal.includes(record.operationId)) keptLocal.push(record.operationId)
    }
  }
  await putJsonExact(join(stage, 'runtime.json'), { ...preparation.runtime, schemaVersion: 3 })
  await putJsonExact(join(stage, 'store', 'store.json'), { ...preparation.store, canonicalIds: records.map(([, f]) => parseRecord(JSON.parse(f.content)).operationId).sort(), localIds: keptLocal.sort() })
  await putJsonExact(join(stage, preparation.relativeReplica, 'publications.json'), [...publicFiles].map(([path, f]) => ({ path, content: f.content })))
  await putJsonExact(join(stage, baselineFile), receipt.checkpoint)
  await putJsonExact(join(stage, migrationGateFile), migrationGate(preparation.plan))
  return stage
}
export async function verifyMigratedHost(options: CutoverOptions, input: unknown) {
  const preparation = await readPreparation(options)
  const receipt = cutoverReceiptSchema.parse(input)
  const repository = await inspectRepository(options.workspaceRoot, false)
  const active = join(options.profileRoot, preparation.relativeSync)
  const pin = baselinePinSchema.parse(await regularJson(join(active, baselineFile)))
  if (canonicalJson(pin) !== canonicalJson(receipt.checkpoint) || planHash(pin.plan) !== options.approvedHash) throw new RemoteConfigError('migration-baseline', 'The installed checkpoint differs from the approved cutover.')
  verifyApprovals(pin.plan, pin.approvals)
  await verifyAppendOnly(repository, pin, repository.head)
  await assertOriginalIdentity(preparation)
  const publicFiles = await gitPublicFiles(repository, repository.head)
  const cache = await readRecords(join(active, 'records-cache')), outbox = await readRecords(join(active, 'outbox'))
  const cacheIds = new Set(cache.map((r) => r.operationId))
  const publicRecords = [...publicFiles].filter(([p]) => p.startsWith('.taskcontinuum/records/v1/')).map(([, f]) => parseRecord(JSON.parse(f.content)))
  if (cache.length !== publicRecords.length || publicRecords.some((r) => !cacheIds.has(r.operationId))
    || outbox.some((r) => !cacheIds.has(r.operationId) || pin.plan.retiredIds.includes(r.operationId))) throw new RemoteConfigError('migration-cache', 'The installed cache or outbox does not match the verified baseline.')
  const resolution = await resolveRecords(cache, {
    workspaceId: pin.plan.workspaceId, trustedKey: (actor) => pin.plan.devices.find((d) => d.deviceId === actor.deviceId)?.clientPublicKey,
    authorize: () => true,
  })
  if (resolution.blocked || resolution.diagnostics.length) throw new RemoteConfigError('migration-conflict', 'The installed new-format configuration does not resolve cleanly.')
  const bindings = Object.entries(resolution.bindings).flatMap(([taskId, targets]) => targets.map((b) => [taskId, b.owner.clientId, b.sessionId, b.chatId]))
  const bindingHash = contentHash(bindings.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))))
  if (bindingHash !== pin.plan.bindingHash) throw new RemoteConfigError('migration-bindings', 'Effective session bindings changed during cutover. No owner receipt or session was recreated.')
  for (const file of pin.plan.preserved) {
    const stamp = preparation.workspaceBackup.find((s) => s.path.replaceAll('\\', '/') === file.path)
    if (!stamp || bytesHash(await readFile(join(options.workspaceRoot, ...file.path.split('/')))) !== stamp.sha256) throw new RemoteConfigError('migration-preservation', 'A preserved public record changed its original on-disk bytes.')
    for (const area of ['records-cache', 'outbox']) {
      const originalPath = join(area, ...file.path.split('/'))
      const original = preparation.syncStamps.find((s) => s.path === originalPath)
      if (original && bytesHash(await readFile(join(active, originalPath))) !== original.sha256) throw new RemoteConfigError('migration-preservation', 'A retained cached or pending record changed its original on-disk bytes.')
    }
  }
  const runtime = z.object({ schemaVersion: z.literal(3) }).passthrough().parse(await regularJson(join(active, 'runtime.json')))
  const store = z.object({ canonicalIds: z.array(z.string()), localIds: z.array(z.string()) }).passthrough().parse(await regularJson(join(active, 'store', 'store.json')))
  if (store.canonicalIds.length !== cache.length || store.canonicalIds.some((id) => !cacheIds.has(id)) || store.localIds.some((id) => !cacheIds.has(id))) throw new RemoteConfigError('migration-cache', 'The installed accepted-operation frontier is incomplete.')
  return { status: 'WAITING_FOR_CUTOVER' as const, migrationId: pin.plan.migrationId, baselineCommit: pin.baselineCommit, authorizationCommit: pin.authorizationCommit,
    currentHead: repository.head, preservedRecords: pin.plan.preserved.length, retiredRecords: pin.plan.retiredIds.length,
    activeRecords: cache.length, outboxRecords: outbox.length, bindingHash, bindings: bindings.length,
    runtimeSchema: runtime.schemaVersion, identityAndPolicyFilesUnchanged: true, authenticationTested: false, restartTested: false }
}
export async function adoptHost(options: CutoverOptions, input: unknown) {
  const stop = options.assertStopped ?? (() => assertNoProfileProcess(options.profileRoot))
  await stop()
  const preparation = await readPreparation(options)
  const repository = await inspectRepository(options.workspaceRoot, false)
  const receipt = await validateReceipt(repository, preparation, input, options.checkpointRoot)
  const active = join(options.profileRoot, preparation.relativeSync), archive = join(options.checkpointRoot, 'retired-sync')
  if (await existing(join(active, baselineFile)) && !await existing(join(active, migrationGateFile))) return verifyMigratedHost(options, receipt)
  const journalFile = join(options.checkpointRoot, 'apply-journal.json')
  let target: string
  if (await existing(journalFile)) {
    const journal = applyJournalSchema.parse(await regularJson(journalFile))
    if (journal.planHash !== options.approvedHash || journal.baselineCommit !== receipt.checkpoint.baselineCommit || journal.authorizationCommit !== receipt.checkpoint.authorizationCommit) {
      throw new RemoteConfigError('migration-baseline', 'The interrupted local installation belongs to another cutover.')
    }
    target = journal.targetCommit
  } else {
    await assertPreparedState(preparation)
    await migrationGit(repository.repositoryRoot, ['fetch', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--', repository.remote, repository.remoteBranch])
    target = await gitText(repository.repositoryRoot, 'rev-parse', 'FETCH_HEAD')
    await verifyAppendOnly(repository, receipt.checkpoint, target)
    await putJsonExact(journalFile, { schemaVersion: 1, planHash: options.approvedHash, targetCommit: target, baselineCommit: receipt.checkpoint.baselineCommit, authorizationCommit: receipt.checkpoint.authorizationCommit })
  }
  await verifyAppendOnly(repository, receipt.checkpoint, target)
  await assertOriginalIdentity(preparation)
  await advanceCheckout(repository, preparation.plan.sourceCommit, target, options.fault)
  await options.fault?.('checkout-updated')
  const stage = join(options.checkpointRoot, 'new-sync')
  if (!await existing(join(active, baselineFile))) await stageLocal(preparation, receipt, repository, target, options.checkpointRoot)
  await options.fault?.('staged')
  await stop()
  if (!await existing(archive)) {
    await assertPreparedState(preparation)
    await rename(active, archive)
  }
  await options.fault?.('archived')
  if (!await existing(active)) await rename(stage, active)
  else if (!await existing(join(active, baselineFile))) throw new RemoteConfigError('migration-interrupted', 'An unexpected process recreated the active state directory. Nothing was overwritten.')
  await options.fault?.('installed')
  const updates = [
    { ref: `${repository.refPrefix}/baselines/${preparation.plan.migrationId}`, next: receipt.checkpoint.baselineCommit, prior: undefined },
    ...preparation.anchors.filter((a) => a.ref === `${repository.refPrefix}/accepted` || a.ref === repository.targetRef).map((a) => ({ ref: a.ref, next: target, prior: a.oid })),
  ]
  for (const update of updates) {
    const read = await migrationGit(repository.repositoryRoot, ['rev-parse', '--verify', '--quiet', update.ref], { allowFailure: true })
    if (read.code > 1) throw new RemoteConfigError('migration-anchor', 'An accepted Git reference could not be inspected.')
    const current = read.code ? undefined : read.stdout.trim()
    if (current === update.next) continue
    if (current !== update.prior) throw new RemoteConfigError('migration-anchor', 'An accepted Git reference changed after preparation; it was not reset.')
    await migrationGit(repository.repositoryRoot, ['update-ref', update.ref, update.next, current ?? '0'.repeat(40)])
  }
  await options.fault?.('anchored')
  const verified = await verifyMigratedHost(options, receipt)
  const gate = join(active, migrationGateFile)
  if (canonicalJson(await regularJson(gate)) !== canonicalJson(migrationGate(preparation.plan))) throw new RemoteConfigError('migration-interrupted', 'The migration gate changed during final verification.')
  await putJsonExact(join(options.checkpointRoot, 'installed.json'), verified)
  await rm(gate)
  return verified
}
