import path from 'node:path'
import { lstatSync } from 'node:fs'
import { z } from 'zod'
import { remoteConfigFormat, remoteConfigLimits, remoteConfigRecordsPath, type RemoteRecord } from '../../shared/remoteConfig'
import { entityKey, parseRecord, recordDependencies, recordPath, RemoteConfigError, serializeRecord, verifyRecordSignature } from '../remoteConfig/records'
import { issue, type Issue } from '../../shared/taskDocuments/common.js'
import { Job } from '../../shared/taskDocuments/job.js'
import { DocumentFiles } from './files.js'
import { buildGraph } from './graph.js'
import { loadWorkspace } from './workspace.js'
import { scan, type Finding } from './scan.js'

export interface DocumentDiagnostic {
  severity: 'error' | 'warn' | 'info'
  code: string
  message: string
  taskId?: string
  path?: string
  line?: number
  related?: string[]
}

export interface ScanFinding extends Finding { path: string }

const remoteDescriptorPath = '.taskcontinuum/workspace.json'
// This public descriptor shape mirrors service.ts without importing its live runtime.
const remoteDescriptorSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('taskcontinuum-workspace'),
  workspaceId: z.uuid(), remoteConfigFormat: z.literal(remoteConfigFormat),
}).strict()

/** The shared read-only document gate. Filters never remove workspace-wide errors. */
export function validateDocuments(root: string, only?: string, files = new DocumentFiles(root)) {
  const workspace = loadWorkspace(files.root, files)
  const graph = buildGraph(workspace)
  const issues: Issue[] = [...workspace.issues, ...workspace.tasks.flatMap((task) => task.issues), ...graph.issues]
  const jobsDirectory = path.join(files.root, workspace.config.bridge.jobs.dir)
  try {
    if (files.existsSync(jobsDirectory)) {
      const ids = new Set<string>()
      for (const file of files.readdirSync(jobsDirectory)) {
        if (!file.endsWith('.json')) continue
        const relative = path.relative(files.root, path.join(jobsDirectory, file))
        try {
          const parsed = Job.safeParse(JSON.parse(files.readFileSync(path.join(jobsDirectory, file), 'utf8')))
          if (!parsed.success) {
            for (const error of parsed.error.issues) issues.push(issue('SCHEMA_INVALID', `${error.path.join('.')}: ${error.message}`, { path: relative }))
          } else {
            if (ids.has(parsed.data.id) || file !== `${parsed.data.id}.json`) issues.push(issue('SCHEMA_INVALID', 'Duplicate job ID or job filename does not match its ID.', { path: relative }))
            ids.add(parsed.data.id)
          }
        } catch (error) {
          issues.push(issue('SCHEMA_INVALID', message(error), { path: relative }))
        }
      }
    }
  } catch (error) { issues.push(issue('SCHEMA_INVALID', message(error), { path: workspace.config.bridge.jobs.dir })) }
  const remoteIssues = validateRemoteDocuments(files)
  workspace.issues.push(...remoteIssues)
  issues.push(...remoteIssues)
  if (only && !workspace.tasks.some((task) => task.task.id === only)) {
    issues.push(issue('SCHEMA_INVALID', `Task ${only} was not found.`, { path: only }))
  }
  return {
    workspace, graph, files,
    issues: issues.filter((item) => !only || !item.taskId || item.taskId === only || item.related?.includes(only)),
  }
}

export function scanDocuments(files: DocumentFiles, workspace: ReturnType<typeof loadWorkspace>) {
  const findings: ScanFinding[] = []
  const issues: DocumentDiagnostic[] = []
  const visited = new Set<string>()
  // Scan all task material, including templates, broken/archived tasks, and jobs/config.
  const pending = [workspace.config.paths.tasks, workspace.config.paths.archive, workspace.config.paths.templates, workspace.config.bridge.jobs.dir, '.taskcontinuum']
  for (const directory of pending) {
    const stack = [directory]
    while (stack.length) {
      const relative = stack.pop()!
      try {
        const absolute = files.contained(path.join(files.root, relative))
        if (visited.has(absolute) || !files.existsSync(absolute)) continue
        visited.add(absolute)
        for (const entry of files.readdirSync(absolute, { withFileTypes: true })) {
          const child = path.join(relative, entry.name)
          if (entry.isSymbolicLink()) {
            // Validate containment, then fail closed rather than follow cycles or aliases.
            files.contained(path.join(files.root, child))
            throw new Error(`Symbolic links are not scanned: ${child}`)
          }
          if (entry.isDirectory()) stack.push(child)
          else if (/\.(md|txt|json)$/i.test(entry.name)) files.readFileSync(path.join(files.root, child), 'utf8')
        }
      } catch (error) {
        issues.push({ severity: 'error', code: 'SCAN_READ_FAILED', message: message(error), path: relative })
      }
    }
  }
  for (const [file, text] of files.texts) {
    for (const finding of scan(text)) findings.push({ ...finding, path: path.relative(files.root, file) })
  }
  return { findings, issues }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** Public consistency only: a self-published key is never treated as locally admitted. */
function validateRemoteDocuments(files: DocumentFiles): Issue[] {
  const issues: Issue[] = []
  const records = new Map<string, { record: RemoteRecord; file: string }>()
  let workspaceId: string | undefined
  let foundRecords = false
  let count = 0
  const fail = (file: string, code: string, detail: string) => {
    issues.push(issue('SCHEMA_INVALID', `Remote consistency [${code}]: ${detail}`, { path: file }))
  }
  const safeFile = (relative: string, maximum: number): string => {
    const absolute = files.contained(path.join(files.root, relative))
    let ancestor = absolute
    while (ancestor !== files.root) {
      const info = lstatSync(ancestor)
      if (info.isSymbolicLink()) throw new RemoteConfigError('unsafe-path', 'Public remote metadata cannot contain filesystem links.')
      if (ancestor === absolute && (!info.isFile() || info.nlink !== 1)) throw new RemoteConfigError('unsafe-path', 'Public remote records must be regular files without hard links.')
      if (ancestor === absolute && info.size > maximum) throw new RemoteConfigError('resource-limit', `Public metadata exceeds the ${maximum}-byte limit.`)
      ancestor = path.dirname(ancestor)
    }
    const text = files.readFileSync(absolute, 'utf8')
    if (Buffer.byteLength(text) > maximum) throw new RemoteConfigError('resource-limit', `Public metadata exceeds the ${maximum}-byte limit.`)
    return text
  }
  const report = (file: string, error: unknown) => {
    if (error instanceof RemoteConfigError) fail(file, error.code, error.message)
    else if (error instanceof SyntaxError) fail(file, 'invalid-json', 'Public metadata is not valid JSON.')
    else fail(file, 'read-failed', message(error))
  }
  try {
    if (files.existsSync(path.join(files.root, remoteDescriptorPath))) {
      const parsed = remoteDescriptorSchema.safeParse(JSON.parse(safeFile(remoteDescriptorPath, 4096)))
      if (!parsed.success) fail(remoteDescriptorPath, 'invalid-descriptor', 'The public workspace descriptor has an invalid or unsupported schema.')
      else workspaceId = parsed.data.workspaceId
    }
  } catch (error) { report(remoteDescriptorPath, error) }
  const stack = [{ directory: remoteConfigRecordsPath, depth: 0 }]
  while (stack.length) {
    const { directory, depth } = stack.pop()!
    try {
      const absolute = files.contained(path.join(files.root, directory))
      if (!files.existsSync(absolute)) continue
      if (depth > 4) throw new RemoteConfigError('invalid-path', 'The record store exceeds its supported directory depth.')
      if (lstatSync(absolute).isSymbolicLink()) throw new RemoteConfigError('unsafe-path', 'Public records cannot use linked directories.')
      for (const entry of files.readdirSync(absolute, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        try {
          if (entry.isSymbolicLink()) throw new RemoteConfigError('unsafe-path', 'Public records cannot use filesystem links.')
          if (entry.isDirectory()) { stack.push({ directory: file, depth: depth + 1 }); continue }
          foundRecords = true
          if (++count > remoteConfigLimits.records) throw new RemoteConfigError('resource-limit', 'Remote configuration exceeds the record limit.')
          const text = safeFile(file, remoteConfigLimits.recordBytes)
          if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) throw new RemoteConfigError('invalid-path', 'Record files must be named by their operation hash.')
          const record = parseRecord(JSON.parse(text))
          if (path.normalize(recordPath(record)) !== path.normalize(file)) throw new RemoteConfigError('invalid-path', 'Record filename, entity path and payload do not match.')
          if (text !== serializeRecord(record)) throw new RemoteConfigError('noncanonical-record', 'Record bytes must use canonical JSON followed by one newline.')
          if (workspaceId && record.workspaceId !== workspaceId) throw new RemoteConfigError('workspace-mismatch', 'Record workspaceId does not match the public descriptor.')
          if (records.has(record.operationId)) throw new RemoteConfigError('duplicate-operation', 'The operation ID appears more than once.')
          records.set(record.operationId, { record, file })
        } catch (error) { report(file, error) }
      }
    } catch (error) { report(directory, error) }
  }
  if (foundRecords && !workspaceId) fail(remoteDescriptorPath, 'missing-descriptor', 'Remote records require a valid public workspace descriptor.')

  const actorKeys = new Map<string, string>()
  const verified = new Set<string>()
  const actorKey = (record: RemoteRecord) => `${record.actor.deviceId}:${record.actor.keyId}`
  for (const { record, file } of records.values()) {
    if (record.kind !== 'device' || record.payload.action !== 'publish') continue
    try {
      if (record.actor.deviceId !== record.payload.deviceId || record.actor.keyId !== record.payload.identity.clientKeyId) {
        throw new RemoteConfigError('actor-mismatch', 'Device publication must be self-signed by its declared client key.')
      }
      verifyRecordSignature(record, record.payload.identity.clientPublicKey)
      actorKeys.set(actorKey(record), record.payload.identity.clientPublicKey)
      verified.add(record.operationId)
    } catch (error) { report(file, error) }
  }
  for (const { record, file } of records.values()) {
    if (!verified.has(record.operationId) && !(record.kind === 'device' && record.payload.action === 'publish')) {
      const key = actorKeys.get(actorKey(record))
      if (!key) fail(file, 'unknown-key', 'No self-consistent public device publication supplies the actor signing key; local trust is not consulted.')
      else {
        try {
          verifyRecordSignature(record, key)
          verified.add(record.operationId)
        } catch (error) { report(file, error) }
      }
    }
    if (record.kind === 'device' && record.actor.deviceId !== record.payload.deviceId ||
      record.kind === 'invitation' && record.actor.deviceId !== record.payload.issuerId ||
      record.kind === 'setting' && record.payload.scope === 'device' && record.actor.deviceId !== record.payload.deviceId) {
      fail(file, 'actor-mismatch', 'The record actor does not match its payload owner.')
    }
    for (const dependency of recordDependencies(record)) {
      const previous = records.get(dependency)?.record
      if (!previous) fail(file, 'missing-reference', `Public record reference ${dependency} is missing or invalid.`)
      else if (record.parents.includes(dependency) && entityKey(previous) !== entityKey(record)) {
        fail(file, 'wrong-parent', 'Causal parents must belong to the same public entity.')
      }
    }
    if (record.kind === 'invitation') {
      const payload = record.payload
      const issuer = records.get(payload.issuerIdentityRef)?.record
      const recipient = records.get(payload.recipientIdentityRef)?.record
      if (issuer?.kind !== 'device' || issuer.payload.action !== 'publish' || issuer.payload.deviceId !== payload.issuerId ||
        recipient?.kind !== 'device' || recipient.payload.action !== 'publish' || recipient.payload.deviceId !== payload.recipientId) {
        fail(file, 'invalid-identity-reference', 'Invitation references must identify the exact issuer and recipient publications.')
      } else if (payload.action === 'grant' && !issuer.payload.routes[payload.routeRef.routeIndex]) {
        fail(file, 'invalid-route-reference', 'The invitation route is absent from its referenced identity.')
      }
      if (payload.action === 'revoke') {
        const grant = records.get(payload.revokes)?.record
        if (grant?.kind !== 'invitation' || grant.payload.action !== 'grant' || grant.payload.grantId !== payload.grantId || entityKey(grant) !== entityKey(record)) {
          fail(file, 'invalid-revocation', 'The revocation does not reference the exact grant for this device pair.')
        }
      }
    }
  }
  return issues
}
