import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { app, safeStorage } from 'electron'
import { baselinePlanSchema, planHash } from '../remoteConfig/trustBaseline'
import { RemoteConfigError } from '../remoteConfig/records'
import { acquireStoreLock } from '../remoteConfig/storeLock'
import { adoptHost, cutoverReceiptSchema, publishCutover, verifyMigratedHost } from './cutover'
import { assertOutside, regularJson, signedInspection } from './local'
import { createMigrationPlan } from './model'
import { prepareHost } from './prepare'
import { assertPrivateDestination, protectedDirectory, putJsonExact } from './storage'

declare const __TC_MIGRATION_CODE_COMMIT__: string
declare const __TC_MIGRATION_BUILD_CLEAN__: boolean
const help = `Task Continuum one-time trust migration (Windows)

Read-only:
  inspect --workspace PATH --profile PATH --helper-data PATH --out REPORT
  plan --reports REPORT [--reports REPORT] --decisions FILE --helper-data PATH --out PLAN

Only AFTER approval, verified shutdown and explicit device fencing:
  prepare-host --workspace PATH --profile PATH --helper-data PATH --checkpoint PATH --report REPORT --plan PLAN --approve PLAN_SHA256 --out PUBLIC_BUNDLE
  publish-cutover --workspace PATH --profile PATH --helper-data PATH --checkpoint PATH --bundles PUBLIC_BUNDLE [--bundles PUBLIC_BUNDLE] --plan PLAN --approve PLAN_SHA256 --out RECEIPT
  adopt-host --workspace PATH --profile PATH --helper-data PATH --checkpoint PATH --receipt RECEIPT --plan PLAN --approve PLAN_SHA256
  verify-host --workspace PATH --profile PATH --helper-data PATH --checkpoint PATH --receipt RECEIPT --plan PLAN --approve PLAN_SHA256

No default paths, coordinator election, process termination, force push or automatic rollback.
Do not share the checkpoint directory: it contains this machine's protected private backup.
`

async function main(): Promise<void> {
  if (!process.versions.electron) throw new RemoteConfigError('migration-launch', 'Launch with npm run migrate:trust; do not run the Electron entry point in plain Node.')
  const parsed = parseArgs({
    args: process.argv.slice(2), allowPositionals: true, strict: true,
    options: {
      workspace: { type: 'string' }, profile: { type: 'string' }, 'helper-data': { type: 'string' }, out: { type: 'string' },
      reports: { type: 'string', multiple: true }, decisions: { type: 'string' }, checkpoint: { type: 'string' },
      report: { type: 'string' }, plan: { type: 'string' }, approve: { type: 'string' },
      bundles: { type: 'string', multiple: true }, receipt: { type: 'string' }, help: { type: 'boolean' },
    },
  })
  const [command] = parsed.positionals
  if (parsed.values.help || command === 'help' || !command) { console.log(help); app.exit(0); return }
  if (parsed.positionals.length !== 1 || !['inspect', 'plan', 'prepare-host', 'publish-cutover', 'adopt-host', 'verify-host'].includes(command)) {
    throw new RemoteConfigError('migration-command', 'Unknown migration command. Run help; no state was changed.')
  }
  if (!__TC_MIGRATION_BUILD_CLEAN__) throw new RemoteConfigError('migration-version', 'This helper was built from an uncommitted working tree. Rebuild the approved clean commit before inspecting or migrating a real profile.')
  const values = parsed.values
  if (['inspect', 'plan', 'prepare-host', 'publish-cutover'].includes(command) && !values.out) throw new RemoteConfigError('migration-output', 'Supply --out before starting this command.')
  function required(value: string | undefined, name: string): string {
    if (!value) throw new RemoteConfigError('migration-argument', `An explicit --${name} is required.`)
    return value
  }
  function path(value: string | undefined, name: string): string {
    const result = required(value, name)
    if (!isAbsolute(result)) throw new RemoteConfigError('migration-argument', `--${name} must be an absolute local path.`)
    return resolve(result)
  }
  const helper = path(values['helper-data'], 'helper-data')
  const workspace = command === 'plan' ? undefined : path(values.workspace, 'workspace')
  const profile = command === 'plan' ? undefined : path(values.profile, 'profile')
  const output = values.out ? path(values.out, 'out') : undefined
  if (profile) assertOutside(profile, helper)
  if (workspace) assertOutside(workspace, helper)
  await assertPrivateDestination(helper)
  if (output) {
    if (workspace) assertOutside(workspace, output)
    if (profile) assertOutside(profile, output)
    await assertPrivateDestination(dirname(output))
  }
  await protectedDirectory(helper)
  app.setName('Task Continuum')
  app.setPath('userData', helper)
  if (!app.requestSingleInstanceLock()) throw new RemoteConfigError('migration-running', 'Another migration helper owns the selected helper directory.')
  await app.whenReady()
  const read = (value: string | undefined, name: string) => regularJson(path(value, name), 32 * 1024 * 1024)
  const codeCommit = __TC_MIGRATION_CODE_COMMIT__
  let result: unknown
  if (command === 'plan') {
    if (!values.reports?.length) throw new RemoteConfigError('migration-argument', 'At least the coordinator signed report is required.')
    const reports = await Promise.all(values.reports.map((file) => read(file, 'reports')))
    const plan = createMigrationPlan(reports, await read(values.decisions, 'decisions'))
    if (plan.codeCommit !== codeCommit) throw new RemoteConfigError('migration-version', 'All inspection reports must use this exact built code commit.')
    result = plan
    console.log(JSON.stringify({ status: 'WAITING_FOR_APPROVAL', migrationId: plan.migrationId, codeCommit, planHash: planHash(plan),
      preservedRecords: plan.preserved.length, retiredRecords: plan.retiredIds.length, grants: plan.grants.length, changes: plan.changes }))
  } else {
    const options = {
      workspaceRoot: workspace!, profileRoot: profile!, codeCommit,
      protector: { available: () => safeStorage.isEncryptionAvailable(), decrypt: (bytes: Buffer) => safeStorage.decryptString(bytes) },
    }
    if (command === 'inspect') {
      result = await signedInspection(options)
      console.log(JSON.stringify({ status: 'PRECHECK_OK', codeCommit, note: 'Signed inspection only; no authorization or live migration was performed.' }))
    } else {
      const plan = baselinePlanSchema.parse(await read(values.plan, 'plan'))
      const approvedHash = required(values.approve, 'approve')
      if (plan.codeCommit !== codeCommit || planHash(plan) !== approvedHash) throw new RemoteConfigError('migration-approval', 'The approved fixed commit or plan digest differs from this command.')
      const checkpointRoot = path(values.checkpoint, 'checkpoint')
      assertOutside(options.workspaceRoot, checkpointRoot)
      assertOutside(options.profileRoot, checkpointRoot)
      await assertPrivateDestination(checkpointRoot)
      await protectedDirectory(checkpointRoot)
      const lock = await acquireStoreLock(checkpointRoot, plan.workspaceId)
      try {
        const context = { ...options, checkpointRoot, approvedHash }
        if (command === 'prepare-host') result = await prepareHost({ ...context, plan, report: await read(values.report, 'report') })
        else if (command === 'publish-cutover') {
          if (!values.bundles?.length) throw new RemoteConfigError('migration-participants', 'Every participating device must provide a signed prepared bundle.')
          result = await publishCutover(context, await Promise.all(values.bundles.map((file) => read(file, 'bundles'))))
        } else {
          const receipt = cutoverReceiptSchema.parse(await read(values.receipt, 'receipt'))
          result = command === 'adopt-host' ? await adoptHost(context, receipt) : await verifyMigratedHost(context, receipt)
        }
      } finally { await lock.release() }
      console.log(JSON.stringify({ status: 'WAITING_FOR_CUTOVER', command, codeCommit, migrationId: plan.migrationId, planHash: approvedHash,
        note: 'No application was started and no end-to-end authentication was performed. MIGRATED_VERIFIED still requires the approved pilot acceptance.' }))
    }
  }
  if (output) {
    await mkdir(resolve(output, '..'), { recursive: true, mode: 0o700 })
    await putJsonExact(output, result)
  } else if (command === 'inspect' || command === 'plan' || command === 'prepare-host' || command === 'publish-cutover') {
    throw new RemoteConfigError('migration-output', 'Supply --out for the requested public report, plan, prepared bundle or receipt.')
  }
  app.exit(0)
}
void main().catch((error: unknown) => {
  const known = error instanceof RemoteConfigError
  console.error(JSON.stringify({ status: 'FAILED_STOPPED', code: known ? error.code : 'migration-validation',
    message: known ? error.message : 'Migration validation or I/O failed. Preserve the checkpoint and original data; no automatic rollback was attempted.' }))
  app.exit(1)
})
