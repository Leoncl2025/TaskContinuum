import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import type { SessionLink, SessionLinksDocument, SessionLinksSnapshot, SessionOwner } from '../shared/sessionBindings'
import { sessionLinksPath } from '../shared/sessionBindings'
import { remoteMachineSchema } from './vscodeRemoteProtocol'

const taskIdSchema = z.string().regex(/^T-\d{4,}$/)
const sessionIdSchema = z.string().min(1).max(240).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
export const sessionOwnerSchema = z.object({ clientId: z.uuid(), machineName: remoteMachineSchema }).strict()
export const sessionLinkSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('github-copilot'), sessionId: sessionIdSchema, owner: sessionOwnerSchema.optional() }).strict(),
  z.object({ provider: z.literal('vscode-copilot'), sessionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/), workspaceStorageId: z.string().regex(/^[a-f0-9]{32}$/), remoteMachineName: remoteMachineSchema.optional(), owner: sessionOwnerSchema.optional() }).strict(),
])
function linkKey(link: SessionLink): string {
  return `${link.provider}:${link.owner?.clientId ?? (link.provider === 'vscode-copilot' ? link.remoteMachineName?.toLowerCase() ?? '' : '')}:${link.provider === 'vscode-copilot' ? `${link.workspaceStorageId}:` : ''}${link.sessionId}`
}
const documentSchema = z.object({
  schemaVersion: z.literal(1),
  bindings: z.record(taskIdSchema, sessionLinkSchema),
}).strict().superRefine((value, context) => {
  const sessions = new Set<string>()
  for (const binding of Object.values(value.bindings)) {
    if (sessions.has(linkKey(binding))) context.addIssue({ code: 'custom', message: 'A session can be linked to only one task.' })
    sessions.add(linkKey(binding))
  }
  if (Object.keys(value.bindings).length > 1000) context.addIssue({ code: 'custom', message: 'The session link limit is 1,000 tasks.' })
})
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

export async function readRepositorySessionLinks(root: string): Promise<SessionLinksSnapshot> {
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

async function writeRepositorySessionLinks(root: string, expectedRevision: string | null, update: (before: SessionLinksDocument) => SessionLinksDocument): Promise<SessionLinksSnapshot> {
  if (expectedRevision !== null && !/^[a-f\d]{64}$/.test(expectedRevision)) throw new Error('Invalid session link revision.')
  const { directory, file } = await checkedPaths(root, true)
  const lockPath = join(directory, 'session-bindings.lock')
  let lock
  try { lock = await open(lockPath, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Session links are being edited by another process. Retry after it finishes. A stale session-bindings.lock may be removed only after all app instances have stopped.')
    throw error
  }
  const temporary = join(directory, `session-bindings.${randomUUID()}.tmp`)
  try {
    const before = await readRepositorySessionLinks(root)
    if (before.revision !== expectedRevision) throw new Error('Session links changed on disk. Reload the bindings and retry; no changes were written.')
    const changed = documentSchema.parse(update(before.document))
    const document: SessionLinksDocument = { schemaVersion: 1, bindings: Object.fromEntries(Object.entries(changed.bindings).sort(([left], [right]) => left.localeCompare(right))) }
    if (JSON.stringify(document) === JSON.stringify(before.document)) return before
    const content = JSON.stringify(document, null, 2) + '\n'
    if (Buffer.byteLength(content) > maximumBytes) throw new Error('The session link file exceeds the 512 KB limit.')
    await writeTemporary(temporary, content)
    if ((await readRepositorySessionLinks(root)).revision !== before.revision) throw new Error('Session links changed on disk. Reload the bindings and retry; no changes were written.')
    try { await writeTemporary(join(directory, '.gitignore'), 'session-bindings.lock\nsession-bindings.*.tmp\n') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
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