import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { SessionLink, SessionLinksDocument, SessionLinksSnapshot, SessionOwner } from '../shared/sessionBindings'
import { sessionLinksPath } from '../shared/sessionBindings'
import { remoteConfigFormat } from '../shared/remoteConfig'
import { agentHostTargetSchema } from './agentHostProtocol'
import type { AgentHostTarget } from '../shared/agentHost'
import { readTaskWorkspace } from './workspaceReader'
import { sessionLinkSchema, sessionLinkTaskIdSchema as taskIdSchema, sessionLinkIdSchema as sessionIdSchema, sessionLinkKey as linkKey, sessionLinksDocumentSchema as documentSchema } from './sessionLinkSchema'
import { readCheckedFile } from './remoteConfig/records'
export { sessionOwnerSchema, sessionLinkSchema, sessionLinkKey } from './sessionLinkSchema'

export interface RepositorySessionLinksBackend {
  read(): Promise<SessionLinksSnapshot>
  update(expectedRevision: string | null, transform: (before: SessionLinksDocument) => SessionLinksDocument | Promise<SessionLinksDocument>, beforeWrite?: () => Promise<void>): Promise<SessionLinksSnapshot>
  writeBinding?(taskId: string, target: SessionLink | null, expectedRevision: string | null, beforeWrite?: () => Promise<void>): Promise<SessionLinksSnapshot>
}
const backends = new Map<string, RepositorySessionLinksBackend>()

async function canonicalRoot(root: string): Promise<string> {
  const canonical = await realpath(root)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

export async function registerRepositorySessionLinksBackend(root: string, backend: RepositorySessionLinksBackend): Promise<() => void> {
  const canonical = await canonicalRoot(root)
  if (backends.has(canonical)) throw new Error('This workspace already has a session links backend.')
  backends.set(canonical, backend)
  let registered = true
  return () => {
    if (!registered) return
    registered = false
    if (backends.get(canonical) === backend) backends.delete(canonical)
  }
}

function bindingSnapshot(snapshot: SessionLinksSnapshot): SessionLinksSnapshot {
  return { document: snapshot.document, revision: snapshot.revision, ...(snapshot.localOwner ? { localOwner: snapshot.localOwner } : {}) }
}
const maximumBytes = 512 * 1024

function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

async function checkedPaths(folder: string, create: boolean) {
  const root = await realpath(folder)
  const directory = join(root, '.taskcontinuum')
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, await realpath(directory))) throw new Error('Session link storage must be a real directory inside the workspace.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (create) await mkdir(directory)
  }
  const file = join(root, sessionLinksPath)
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || !inside(root, await realpath(file))) throw new Error('Session links must use a regular workspace file, not a filesystem link.')
    if (info.size > maximumBytes) throw new Error('The session link file exceeds the 512 KB limit.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { directory, file }
}

function parse(text: string): SessionLinksDocument {
  try { return documentSchema.parse(JSON.parse(text)) } catch {
    throw new Error('The repository session link file is invalid or contains a merge conflict. Fix it before changing bindings.')
  }
}

async function assertLegacyFallbackAllowed(root: string): Promise<void> {
  const { directory } = await checkedPaths(root, false)
  let content: Buffer
  try { content = await readCheckedFile(root, join(directory, 'workspace.json'), 4096) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  let descriptor: unknown
  try { descriptor = JSON.parse(content.toString('utf8')) }
  catch { throw new Error('The workspace descriptor is invalid. Restore its remote configuration enrollment before accessing session bindings; legacy fallback is disabled.') }
  if (descriptor && typeof descriptor === 'object' && 'remoteConfigFormat' in descriptor && descriptor.remoteConfigFormat === remoteConfigFormat) {
    throw new Error('This workspace uses immutable remote configuration. Its enrolled binding backend is not ready. Restore enrollment before reading or changing bindings; session-bindings.json is archival only.')
  }
  throw new Error('The workspace descriptor has an unsupported remote configuration format. Restore its enrollment before accessing session bindings; legacy fallback is disabled.')
}

export async function readRepositorySessionLinks(root: string): Promise<SessionLinksSnapshot> {
  const canonical = await canonicalRoot(root)
  const backend = backends.get(canonical)
  if (backend) return bindingSnapshot(await backend.read())
  await assertLegacyFallbackAllowed(root)
  const snapshot = await readLegacyRepositorySessionLinks(root)
  const current = backends.get(canonical)
  if (current) return bindingSnapshot(await current.read())
  await assertLegacyFallbackAllowed(root)
  const ready = backends.get(canonical)
  return ready ? bindingSnapshot(await ready.read()) : snapshot
}

/** Migration/archive inspection only; this intentionally bypasses the effective routing backend. */
export async function readLegacyRepositorySessionLinks(root: string): Promise<SessionLinksSnapshot> {
  const { file } = await checkedPaths(root, false)
  let content: Buffer
  try { content = await readFile(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { document: { schemaVersion: 1, bindings: {} }, revision: null }
    throw error
  }
  if (content.byteLength > maximumBytes) throw new Error('The session link file exceeds the 512 KB limit.')
  return { document: parse(content.toString('utf8')), revision: createHash('sha256').update(content).digest('hex') }
}

export async function updateRepositorySessionLink(root: string, taskId: string, sessionId: string | null, expectedRevision: string | null, vscodeWorkspaceStorageId?: string, vscodeRemoteMachineName?: string, owner?: SessionOwner): Promise<SessionLinksSnapshot> {
  taskIdSchema.parse(taskId)
  if (sessionId !== null) sessionIdSchema.parse(sessionId)
  if (vscodeRemoteMachineName !== undefined && vscodeWorkspaceStorageId === undefined) throw new Error('A remote VS Code binding requires its original workspace identity.')
  const selected: SessionLink | null = sessionId === null ? null : sessionLinkSchema.parse(vscodeWorkspaceStorageId === undefined
    ? { provider: 'github-copilot', sessionId, ...(owner ? { owner } : {}) }
    : { provider: 'vscode-copilot', sessionId, workspaceStorageId: vscodeWorkspaceStorageId, ...(owner ? { owner } : vscodeRemoteMachineName ? { remoteMachineName: vscodeRemoteMachineName } : {}) })
  return updateLink(root, taskId, selected, expectedRevision)
}

export function updateRepositoryAgentHostLink(root: string, taskId: string, target: AgentHostTarget, expectedRevision: string | null): Promise<SessionLinksSnapshot> {
  taskIdSchema.parse(taskId)
  return updateLink(root, taskId, sessionLinkSchema.parse({ ...agentHostTargetSchema.parse(target), provider: 'agent-host' }), expectedRevision)
}

export function bindRepositoryAgentHostCreation(root: string, taskId: string, target: AgentHostTarget, expectedRevision: string | null, authorize?: () => Promise<void>): Promise<SessionLinksSnapshot> {
  taskIdSchema.parse(taskId)
  const selected = sessionLinkSchema.parse({ ...agentHostTargetSchema.parse(target), provider: 'agent-host' })
  const check = async () => {
    if (!(await readTaskWorkspace(root)).tasks.some((task) => task.id === taskId)) throw new Error('The task does not exist in this workspace. No binding was written.')
    await authorize?.()
  }
  return writeRepositorySessionLinks(root, expectedRevision, async (before) => {
    await check()
    const prior = before.bindings[taskId]
    if (prior && JSON.stringify(prior) !== JSON.stringify(selected)) throw new Error('The task already has a different session binding. Creation cannot replace it.')
    const existingTask = Object.entries(before.bindings).find(([id, link]) => id !== taskId && linkKey(link) === linkKey(selected))?.[0]
    if (existingTask) throw new Error(`This session is already linked to ${existingTask}. Detach it there before moving it.`)
    return { schemaVersion: 1, bindings: { ...before.bindings, [taskId]: selected } }
  }, check)
}

async function updateLink(root: string, taskId: string, selected: SessionLink | null, expectedRevision: string | null): Promise<SessionLinksSnapshot> {
  const backend = backends.get(await canonicalRoot(root))
  if (backend?.writeBinding) return bindingSnapshot(await backend.writeBinding(taskId, selected, expectedRevision))
  return writeRepositorySessionLinks(root, expectedRevision, (before) => {
    const prior = before.bindings[taskId]
    if (prior?.owner && selected && prior.sessionId === selected.sessionId && prior.provider === selected.provider && prior.owner.clientId !== selected.owner?.clientId) throw new Error('Session ownership cannot be changed by linking. Ownership transfer is not supported.')
    if (selected) {
      const existingTask = Object.entries(before.bindings).find(([id, link]) => id !== taskId && linkKey(link) === linkKey(selected))?.[0]
      if (existingTask) throw new Error(`This session is already linked to ${existingTask}. Detach it there before moving it.`)
    }
    const bindings = { ...before.bindings }
    if (selected === null) delete bindings[taskId]
    else bindings[taskId] = selected
    return { schemaVersion: 1, bindings }
  })
}

export async function migrateRepositorySessionLinks(root: string, bindings: Record<string, SessionLink>): Promise<SessionLinksSnapshot> {
  const document = documentSchema.parse({ schemaVersion: 1, bindings })
  if (!Object.keys(document.bindings).length) throw new Error('There are no local session links to save.')
  return writeRepositorySessionLinks(root, null, () => document)
}

export async function writeRepositorySessionLinks(root: string, expectedRevision: string | null, update: (before: SessionLinksDocument) => SessionLinksDocument | Promise<SessionLinksDocument>, beforeCommit?: () => Promise<void>): Promise<SessionLinksSnapshot> {
  if (expectedRevision !== null && !/^[a-f\d]{64}$/.test(expectedRevision)) throw new Error('Invalid session link revision.')
  const canonical = await canonicalRoot(root)
  const backend = backends.get(canonical)
  if (backend) return bindingSnapshot(await backend.update(expectedRevision, update, beforeCommit))
  async function requireLegacyWriter() {
    if (backends.has(canonical)) throw new Error('The enrolled binding backend changed during this legacy edit. Reload and retry; no legacy changes were written.')
    await assertLegacyFallbackAllowed(root)
    if (backends.has(canonical)) throw new Error('The enrolled binding backend changed during this legacy edit. Reload and retry; no legacy changes were written.')
  }
  await requireLegacyWriter()
  const { directory, file } = await checkedPaths(root, true)
  const lockPath = join(directory, 'session-bindings.lock')
  let lock
  try { lock = await open(lockPath, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Session links are being edited by another process. Retry after it finishes. A stale session-bindings.lock may be removed only after all app instances have stopped.')
    throw error
  }
  const temporary = join(directory, `session-bindings.${randomUUID()}.tmp`)
  try {
    const before = await readLegacyRepositorySessionLinks(root)
    if (before.revision !== expectedRevision) throw new Error('Session links changed on disk. Reload the bindings and retry; no changes were written.')
    await requireLegacyWriter()
    const changed = documentSchema.parse(await update(before.document))
    const document: SessionLinksDocument = { schemaVersion: 1, bindings: Object.fromEntries(Object.entries(changed.bindings).sort(([left], [right]) => left.localeCompare(right))) }
    await requireLegacyWriter()
    if (JSON.stringify(document) === JSON.stringify(before.document)) return before
    const content = JSON.stringify(document, null, 2) + '\n'
    if (Buffer.byteLength(content) > maximumBytes) throw new Error('The session link file exceeds the 512 KB limit.')
    await writeTemporary(temporary, content)
    if ((await readLegacyRepositorySessionLinks(root)).revision !== before.revision) throw new Error('Session links changed on disk. Reload the bindings and retry; no changes were written.')
    try { await writeTemporary(join(directory, '.gitignore'), 'session-bindings.lock\nsession-bindings.*.tmp\n') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (beforeCommit) {
      await beforeCommit()
      if ((await readLegacyRepositorySessionLinks(root)).revision !== before.revision) throw new Error('Session links changed on disk. Reload the bindings and retry; no changes were written.')
      await beforeCommit()
    }
    await requireLegacyWriter()
    await rename(temporary, file)
    return { document, revision: createHash('sha256').update(content).digest('hex') }
  } finally {
    try { await rm(temporary, { force: true }) } finally {
      await lock.close()
      await rm(lockPath, { force: true })
    }
  }
}

async function writeTemporary(file: string, content: string): Promise<void> {
  const handle = await open(file, 'wx', 0o600)
  try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
}