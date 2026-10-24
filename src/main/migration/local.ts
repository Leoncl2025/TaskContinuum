import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { hostname } from 'node:os'
import ssh2 from 'ssh2'
import { z } from 'zod'
import type { KeyProtector } from '../devTunnel/identity'
import { sshPublicKeySchema } from '../devTunnel/protocol'
import { readLocalSessionLinkReceipts } from '../linkedSessionPolicy'
import { enrollmentsSchema } from '../remoteConfig/enrollment'
import { checkoutOwnerIdentity } from '../remoteConfig/git'
import { canonicalJson, readCheckedFile, resolvedSettings, RemoteConfigError, type RecordSigner } from '../remoteConfig/records'
import {
  baselinePlanSchema, bytesHash, contentHash, documentSigningBytes, planHash, readWorkspaceDescriptor,
  type BaselinePlan,
} from '../remoteConfig/trustBaseline'
import { readJsonBounded } from '../shared/storage'
import { devicePeerSchema } from '../vscodeDeviceClient'
import { deviceHostStateSchema } from '../vscodeDeviceHost'
import { gitPublicFiles, gitText, inspectRepository, isAncestor, type MigrationRepository } from './git'
import { migrationManifest, readMigrationFiles, validateLegacyHistory, type MigrationFile } from './legacyRecords'
import { hostReportSchema, type HostReport, type SignedHostReport } from './model'

const savedKeySchema = z.object({ schemaVersion: z.literal(1), publicKey: sshPublicKeySchema, encryptedPrivateKey: z.string().min(1).max(16384) }).strict()
export const migrationStoreSchema = z.object({
  schemaVersion: z.literal(1), workspaceId: z.uuid(), initialized: z.literal(true),
  canonicalIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10000).refine((ids) => new Set(ids).size === ids.length),
  localIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10000).refine((ids) => new Set(ids).size === ids.length).default([]),
}).strict()
export const migrationRuntimeSchema = z.object({
  schemaVersion: z.literal(2), workspaceId: z.uuid(), recordsRoot: z.string(),
  controlPort: z.number().int().min(1024).max(65535).optional(),
  managedPairs: z.record(z.uuid(), z.uuid()).default({}),
}).strict()
export interface MigrationHostOptions {
  workspaceRoot: string
  profileRoot: string
  codeCommit: string
  protector: Pick<KeyProtector, 'available' | 'decrypt'>
  now?: () => number
}
export interface FileStamp { path: string; sha256: string }
export interface HostInspection {
  report: HostReport
  repository: MigrationRepository
  profileRoot: string
  syncDirectory: string
  replicaDirectory: string
  files: MigrationFile[]
  outbox: MigrationFile[]
  profileStamps: FileStamp[]
  syncStamps: FileStamp[]
  anchors: Array<{ ref: string; oid: string }>
  runtime: z.infer<typeof migrationRuntimeSchema>
  store: z.infer<typeof migrationStoreSchema>
}
export function normalizedRoot(root: string): string { return process.platform === 'win32' ? root.toLowerCase() : root }
export function syncDirectory(profile: string, root: string): string {
  return join(profile, 'workspace-sync', createHash('sha256').update(normalizedRoot(root)).digest('hex'))
}
export function assertOutside(root: string, target: string): void {
  const child = relative(root, target)
  if (!child || !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)) throw new RemoteConfigError('unsafe-path', 'Migration output and backups must be outside the source repository and profile.')
}
export async function regularJson(file: string, maximum = 8 * 1024 * 1024): Promise<unknown> {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new RemoteConfigError('unsafe-path', 'Migration requires single-link regular state files.')
  return readJsonBounded(file, maximum)
}
export async function existing(file: string): Promise<boolean> {
  try { await lstat(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
export async function fileHash(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}
export async function treeStamps(root: string): Promise<FileStamp[]> {
  const result: FileStamp[] = []
  async function visit(directory: string, depth: number): Promise<void> {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || depth > 32) throw new RemoteConfigError('unsafe-path', 'Migration snapshots must not traverse filesystem links or unbounded directories.')
    for (const name of (await readdir(directory)).sort()) {
      const file = join(directory, name), info = await lstat(file)
      if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1) throw new RemoteConfigError('unsafe-path', 'A migration snapshot contains a linked file.')
      if (info.isDirectory()) await visit(file, depth + 1)
      else {
        if (!info.isFile() || result.length >= 100000) throw new RemoteConfigError('resource-limit', 'The protected snapshot has too many or unsupported files.')
        result.push({ path: relative(root, file), sha256: await fileHash(file) })
      }
    }
  }
  await visit(root, 0)
  return result.sort((a, b) => a.path.localeCompare(b.path))
}
const preservedProfileFiles = [
  'remote-vscode-identity.json', 'dev-tunnel-client-identity.json', 'dev-tunnel-host-identity.json',
  'remote-vscode-device-host.json', 'remote-vscode-devices.json', 'git-workspace-enrollments.json',
  'local-session-link-receipts.json', 'agent-host-consents.json', 'workspaces.json',
]
export async function profileIdentityStamps(profile: string): Promise<FileStamp[]> {
  const result: FileStamp[] = []
  for (const name of preservedProfileFiles) {
    const file = join(profile, name)
    await regularJson(file)
    result.push({ path: name, sha256: bytesHash(await readFile(file)) })
  }
  return result
}
async function readOutbox(root: string): Promise<MigrationFile[]> {
  if (!await existing(join(root, '.taskcontinuum', 'records', 'v1'))) {
    if ((await readdir(root)).length) throw new RemoteConfigError('migration-outbox', 'Unrecognized pending outbox content; nothing was discarded.')
    return []
  }
  return readMigrationFiles(root)
}
async function unlockedKey(profile: string, purpose: 'client' | 'host', protector: MigrationHostOptions['protector']) {
  if (!protector.available()) throw new RemoteConfigError('migration-secure-storage', 'OS secure storage must unlock this device locally; private keys cannot be supplied by another machine.')
  const stored = savedKeySchema.parse(await regularJson(join(profile, `dev-tunnel-${purpose}-identity.json`), 20000))
  const parsed = ssh2.utils.parseKey(protector.decrypt(Buffer.from(stored.encryptedPrivateKey, 'base64')))
  if (parsed instanceof Error || Array.isArray(parsed) || parsed.type !== 'ssh-ed25519'
    || parsed.getPublicSSH().toString('base64') !== stored.publicKey.split(' ')[1]) throw new RemoteConfigError('migration-key', 'The existing local private key does not match its saved public identity; no key was generated.')
  return parsed
}
export async function existingSigner(profile: string, protector: MigrationHostOptions['protector']): Promise<RecordSigner> {
  const parsed = await unlockedKey(profile, 'client', protector)
  return (bytes) => {
    const signature = parsed.sign(bytes)
    if (signature instanceof Error) throw new RemoteConfigError('migration-signature', 'The existing device could not sign the migration document.')
    return signature
  }
}
async function assertBindingTasks(root: string, taskIds: string[]): Promise<void> {
  const config = z.object({ paths: z.object({ tasks: z.string().min(1) }).default({ tasks: 'tasks' }) })
    .passthrough().parse(JSON.parse((await readCheckedFile(root, join(root, '.agentdesk', 'config.json'), 1048576)).toString('utf8')))
  if (isAbsolute(config.paths.tasks)) throw new RemoteConfigError('migration-task', 'The task directory must remain inside the selected workspace.')
  const tasks = await realpath(join(root, config.paths.tasks))
  const child = relative(root, tasks)
  if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) throw new RemoteConfigError('migration-task', 'The configured task directory escapes the workspace.')
  const found = new Set<string>()
  for (const entry of await readdir(tasks, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(tasks, entry.name, 'task.json')
    if (!await existing(file)) continue
    const task = z.object({ id: z.string() }).passthrough().parse(JSON.parse((await readCheckedFile(root, file, 1048576)).toString('utf8')))
    if (found.has(task.id)) throw new RemoteConfigError('migration-task', 'Duplicate task IDs must be resolved before preserving bindings.')
    found.add(task.id)
  }
  if (taskIds.some((id) => !found.has(id))) throw new RemoteConfigError('migration-task', 'A bound task is missing from the actual selected workspace.')
}
export async function inspectHost(options: MigrationHostOptions): Promise<HostInspection> {
  const repository = await inspectRepository(options.workspaceRoot)
  const profileRoot = await realpath(options.profileRoot)
  assertOutside(repository.repositoryRoot, profileRoot)
  const directory = syncDirectory(profileRoot, repository.workspaceRoot)
  const profileStamps = await profileIdentityStamps(profileRoot)
  const syncStamps = await treeStamps(directory)
  for (const name of ['trust-migration.json', 'trust-baseline.json', 'store\\pending-operations.json', 'settings.json.export']) {
    if (await existing(join(directory, ...name.split('\\')))) throw new RemoteConfigError('migration-pending', 'An existing migration or unfinished local operation must be resumed explicitly, not discarded.')
  }
  const descriptor = await readWorkspaceDescriptor(repository.workspaceRoot)
  if (!descriptor || descriptor.schemaVersion !== 1) throw new RemoteConfigError('migration-source', 'This tool migrates one original workspace baseline exactly once.')
  const enrollments = enrollmentsSchema.parse(await regularJson(join(profileRoot, 'git-workspace-enrollments.json')))
  const enrollment = enrollments.workspaces.find((row) => row.root === normalizedRoot(repository.workspaceRoot))
  if (!enrollment || enrollment.workspaceId !== descriptor.workspaceId) throw new RemoteConfigError('migration-identity', 'Local enrollment and public workspace identity disagree.')
  const local = z.object({ clientId: z.uuid() }).strict().parse(await regularJson(join(profileRoot, 'remote-vscode-identity.json')))
  const runtime = migrationRuntimeSchema.parse(await regularJson(join(directory, 'runtime.json')))
  const store = migrationStoreSchema.parse(await regularJson(join(directory, 'store', 'store.json')))
  if (runtime.workspaceId !== descriptor.workspaceId || store.workspaceId !== descriptor.workspaceId
    || runtime.recordsRoot !== join(directory, 'records-cache')) throw new RemoteConfigError('migration-state', 'The existing store or cache is bound to another workspace.')
  const oldLock = join(directory, 'store', 'store.lock')
  if (await existing(oldLock)) {
    const lock = z.object({ schemaVersion: z.literal(1), workspaceId: z.uuid(), pid: z.number().int().positive().max(2147483647), host: z.string(), nonce: z.uuid() }).strict().parse(await regularJson(oldLock, 1024))
    if (lock.workspaceId !== descriptor.workspaceId || lock.host !== hostname()) throw new RemoteConfigError('migration-lock', 'The retained store lock belongs to another host or workspace; it was not removed.')
    try {
      process.kill(lock.pid, 0)
      throw new RemoteConfigError('migration-running', 'The original store lock has a live owner. Stop that verified instance before migration.')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  const settings = await regularJson(join(directory, 'settings.json'))
  const settingsBase = await regularJson(join(directory, 'settings.json.baseline'))
  if (canonicalJson(settings) !== canonicalJson(settingsBase)) throw new RemoteConfigError('migration-settings', 'An uncommitted local settings edit must be resolved before migration.')
  const overlay = z.object({ schemaVersion: z.literal(1), workspaceId: z.uuid(), markers: z.array(z.unknown()) }).strict().parse(await regularJson(join(directory, 'store', 'binding-overlays.json')))
  if (overlay.workspaceId !== descriptor.workspaceId || overlay.markers.length) throw new RemoteConfigError('migration-overlay', 'Pending binding notifications must be synchronized before migration.')
  for (const purpose of ['client', 'host'] as const) {
    const key = savedKeySchema.parse(await regularJson(join(profileRoot, `dev-tunnel-${purpose}-identity.json`), 20000))
    const pin = enrollment.pins[local.clientId]
    if (!pin || key.publicKey !== (purpose === 'client' ? pin.clientPublicKey : pin.hostPublicKey)) throw new RemoteConfigError('migration-key', 'Existing device keys differ from the enrolled identity.')
    await unlockedKey(profileRoot, purpose, options.protector)
  }
  const publicFiles = await readMigrationFiles(repository.workspaceRoot)
  const gitFiles = await gitPublicFiles(repository, repository.head)
  const files = publicFiles.map((file) => {
    const git = gitFiles.get(file.path)
    if (!git || git.content.replaceAll('\r\n', '\n') !== file.content.replaceAll('\r\n', '\n')) throw new RemoteConfigError('migration-dirty', 'Public record bytes differ from the source Git tree.')
    return { ...file, content: git.content, sha256: bytesHash(git.content) }
  })
  const cache = await readMigrationFiles(runtime.recordsRoot)
  const outbox = await readOutbox(join(directory, 'outbox'))
  const byId = new Map(files.map((f) => [f.record.operationId, f]))
  const equal = (file: MigrationFile) => byId.get(file.record.operationId)?.content.replaceAll('\r\n', '\n') === file.content.replaceAll('\r\n', '\n')
  if (cache.length !== files.length || !cache.every(equal) || !outbox.every(equal)
    || store.canonicalIds.length !== files.length || store.canonicalIds.some((id) => !byId.has(id))
    || store.localIds.some((id) => !byId.has(id))) throw new RemoteConfigError('migration-unpublished', 'Accepted, cached or pending history differs from the shared source. Synchronize the exact original records; no missing history is ignored.')
  const replicaNames = (await readdir(directory)).filter((name) => /^checkout-v2-[a-f0-9]{64}$/.test(name))
  if (replicaNames.length !== 1) throw new RemoteConfigError('migration-replica', 'Exactly one recognized checkout owner is required.')
  const replicaDirectory = join(directory, replicaNames[0])
  const owner = z.object({
    version: z.literal(2), mode: z.literal('selected-checkout'), workspaceRoot: z.string(), repositoryRoot: z.string().optional(),
    workspaceRelativePath: z.string().optional(), remote: z.string(), branch: z.string(), fetchUrl: z.string(), pushUrl: z.string(),
  }).strict().parse(await regularJson(join(replicaDirectory, 'owner.json')))
  if (normalizedRoot(owner.workspaceRoot) !== normalizedRoot(repository.workspaceRoot) || owner.fetchUrl !== repository.fetchUrl || owner.pushUrl !== repository.pushUrl
    || owner.branch !== repository.remoteBranch.slice(11)) throw new RemoteConfigError('migration-upstream', 'The private checkout owner does not match the selected upstream.')
  if (await readFile(join(replicaDirectory, 'owner.json'), 'utf8') !== checkoutOwnerIdentity(repository.workspaceRoot, repository.repositoryRoot, owner)) {
    throw new RemoteConfigError('migration-replica', 'The checkout owner marker would be rejected by the normal runtime; its original bytes were not changed.')
  }
  if ((await readdir(replicaDirectory)).some((name) => name !== 'owner.json' && name !== 'publications.json')) throw new RemoteConfigError('migration-pending', 'The checkout replica has pending or unrecognized state.')
  const retained = z.array(z.object({ path: z.string(), content: z.string() }).strict()).max(10001).parse(await regularJson(join(replicaDirectory, 'publications.json'), 16 * 1024 * 1024))
  for (const row of retained) {
    if (gitFiles.get(row.path)?.content !== row.content) throw new RemoteConfigError('migration-unpublished', 'Retained Git publications contain unpublished or conflicting original records.')
  }
  const anchors = (await gitText(repository.repositoryRoot, 'for-each-ref', '--format=%(refname) %(objectname)', repository.refPrefix)).split('\n').filter(Boolean).map((line) => {
    const [ref, oid] = line.split(' ')
    return { ref, oid }
  })
  if (!anchors.some((a) => a.ref === `${repository.refPrefix}/accepted`) || !anchors.some((a) => a.ref === repository.targetRef)) throw new RemoteConfigError('migration-anchor', 'The existing accepted Git anchors are missing.')
  for (const anchor of anchors) {
    if (!await isAncestor(repository, anchor.oid, repository.head)) throw new RemoteConfigError('migration-rollback', 'An accepted Git anchor is not an ancestor of the selected source.')
  }
  const now = options.now?.() ?? Date.now()
  const checked = await validateLegacyHistory(files, { workspaceId: descriptor.workspaceId, pins: enrollment.pins, now })
  for (const device of Object.values(checked.projection.devices)) {
    if (device.payload.action !== 'publish') continue
    const pin = enrollment.pins[device.payload.deviceId]
    if (!pin || pin.clientPublicKey !== device.payload.identity.clientPublicKey || pin.hostPublicKey !== device.payload.identity.hostPublicKey) throw new RemoteConfigError('migration-key', 'A public device identity changed its client or host key.')
  }
  if (!options.protector.available()) throw new RemoteConfigError('migration-secure-storage', 'OS secure storage is required to inspect private permissions locally.')
  const decrypt = async (name: string) => {
    const envelope = z.object({ encrypted: z.string().min(1) }).strict().parse(await regularJson(join(profileRoot, name)))
    return JSON.parse(options.protector.decrypt(Buffer.from(envelope.encrypted, 'base64'))) as unknown
  }
  const host = deviceHostStateSchema.parse(await decrypt('remote-vscode-device-host.json'))
  const peers = z.array(devicePeerSchema).max(32).parse(await decrypt('remote-vscode-devices.json'))
  const root = normalizedRoot(repository.workspaceRoot)
  const incoming = host.pairs.flatMap((pair) => {
    const policy = pair.workspaces.find((w) => normalizedRoot(w.root) === root)
    if (!policy) return []
    if (enrollment.pins[pair.participant.clientId]?.clientPublicKey !== pair.publicKey) throw new RemoteConfigError('migration-key', 'A private pairing differs from its pinned public identity.')
    return [{ recipientId: pair.participant.clientId, canSend: policy.canSend }]
  })
  const outgoing = peers.filter((peer) => normalizedRoot(peer.root) === root).map((peer) => {
    const issuerId = peer.invitation.ownerClientId
    if (!issuerId || enrollment.pins[issuerId]?.hostPublicKey !== peer.invitation.devTunnel.hostPublicKey
      || peer.invitation.participant.clientId !== local.clientId) throw new RemoteConfigError('migration-key', 'An imported private route does not identify its exact pinned owner and recipient.')
    return { issuerId, enabled: peer.enabled }
  })
  if (new Set(incoming.map((p) => p.recipientId)).size !== incoming.length || new Set(outgoing.map((p) => p.issuerId)).size !== outgoing.length) {
    throw new RemoteConfigError('migration-conflict', 'Duplicate private routes or policies require owner review.')
  }
  const receipts = await readLocalSessionLinkReceipts(profileRoot)
  const bindings = Object.entries(checked.projection.bindings).flatMap(([taskId, targets]) => targets.map((target) => ({ taskId, ...target })))
  await assertBindingTasks(repository.workspaceRoot, Object.keys(checked.projection.bindings))
  const owned = bindings.filter((b) => b.owner.clientId === local.clientId)
  const confirmed = owned.filter((b) => receipts.some((r) => normalizedRoot(r.root) === root && r.taskId === b.taskId
    && r.owner.clientId === b.owner.clientId && r.identity.sessionId === b.sessionId && r.identity.chatId === b.chatId))
  if (owned.length !== confirmed.length) throw new RemoteConfigError('migration-receipts', 'Existing local bindings lack their exact owner-confirmation receipts. Migration never manufactures receipts.')
  const effectiveSettings = resolvedSettings(checked.projection, local.clientId)
  const report = hostReportSchema.parse({
    schemaVersion: 1, kind: 'taskcontinuum-migration-inspection', codeCommit: options.codeCommit, capturedAt: new Date(now).toISOString(),
    workspaceId: descriptor.workspaceId, sourceCommit: repository.head, repositoryHash: repository.repositoryHash, workspaceRelativePath: repository.relativePath,
    sourceRecordsHash: migrationManifest(files),
    bindingHash: contentHash(bindings.map((b) => [b.taskId, b.owner.clientId, b.sessionId, b.chatId]).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))),
    localSealHash: contentHash({ profileStamps, syncStamps, anchors }),
    preserved: checked.retained.map((f) => ({ path: f.path, operationId: f.record.operationId, sha256: f.sha256 })),
    retiredIds: files.filter((f) => f.record.kind === 'invitation').map((f) => f.record.operationId).sort(),
    localDeviceId: local.clientId,
    enabled: enrollment.enabled && effectiveSettings.autoLink && effectiveSettings.tunnelEnabled,
    admitNewDevices: enrollment.admitNewDevices,
    devices: Object.entries(enrollment.pins).sort(([a], [b]) => a.localeCompare(b)).map(([deviceId, pin]) => {
      const state = checked.projection.entities[`device:${deviceId}`]?.state
      if (state !== 'active' && state !== 'deleted') throw new RemoteConfigError('migration-identity', 'Every enrolled identity must have a complete accepted public history.')
      return { deviceId, clientPublicKey: pin.clientPublicKey, hostPublicKey: pin.hostPublicKey, state, blocked: pin.blocked }
    }),
    relationships: checked.relationships, incoming, outgoing,
    localOwnedBindings: owned.length, confirmedLocalBindings: confirmed.length, publicRecords: files.length,
    acceptedRecords: store.canonicalIds.length, outboxRecords: outbox.length, unpublishedRecords: 0,
  })
  if (contentHash(profileStamps) !== contentHash(await profileIdentityStamps(profileRoot)) || contentHash(syncStamps) !== contentHash(await treeStamps(directory))) {
    throw new RemoteConfigError('migration-changed', 'The profile changed during inspection. No coherent snapshot was captured.')
  }
  return { report, repository, profileRoot, syncDirectory: directory, replicaDirectory, files, outbox, profileStamps, syncStamps, anchors, runtime, store }
}
export async function signedInspection(options: MigrationHostOptions): Promise<SignedHostReport> {
  const inspection = await inspectHost(options)
  const sign = await existingSigner(inspection.profileRoot, options.protector)
  const signature = await sign(documentSigningBytes('TrustMigrationInspection', inspection.report))
  return { report: inspection.report, signature: typeof signature === 'string' ? signature : signature.toString('base64') }
}
export function assertPlanMatchesHost(input: unknown, inspection: HostInspection, approvedHash: string): BaselinePlan {
  const plan = baselinePlanSchema.parse(input)
  if (planHash(plan) !== approvedHash || plan.codeCommit !== inspection.report.codeCommit) throw new RemoteConfigError('migration-approval', 'The explicit approved plan hash or fixed code commit does not match.')
  const device = plan.devices.find((d) => d.deviceId === inspection.report.localDeviceId)
  const report = inspection.report
  if (!device || device.disposition !== 'participating' || device.evidenceHash !== contentHash(report)
    || plan.sourceRecordsHash !== report.sourceRecordsHash || plan.sourceCommit !== report.sourceCommit || plan.bindingHash !== report.bindingHash
    || plan.repositoryHash !== report.repositoryHash || plan.workspaceId !== report.workspaceId
    || contentHash(plan.preserved) !== contentHash(report.preserved) || contentHash(plan.retiredIds) !== contentHash(report.retiredIds)) {
    throw new RemoteConfigError('migration-changed', 'The exact approved local inspection no longer matches. Reinspect and approve a new plan; do not skip changed state.')
  }
  return plan
}
