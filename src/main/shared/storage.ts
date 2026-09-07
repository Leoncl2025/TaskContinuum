import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { hostname, userInfo } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import type { SharedActor, SharedSessionDescriptor } from '../../shared/sharedSessions'
import { descriptorSchema } from './schemas'

export async function readJsonBounded(file: string, maximum = 1024 * 1024): Promise<unknown> {
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maximum) throw new Error('The selected data file exceeds its size limit.')
    const text = await handle.readFile('utf8')
    if (Buffer.byteLength(text) > maximum) throw new Error('The selected data file exceeds its size limit.')
    return JSON.parse(text) as unknown
  } finally { await handle.close() }
}

export async function writeJsonAtomic(file: string, value: unknown, exclusive = false): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  if (exclusive) {
    const handle = await open(file, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
    return
  }
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
}

const identitySchema = z.object({ machineId: z.uuid(), userId: z.uuid() }).strict()
export async function localIdentity(directory: string): Promise<SharedActor> {
  const file = join(directory, 'shared-identity.json')
  let identity: z.infer<typeof identitySchema>
  try { identity = identitySchema.parse(await readJsonBounded(file)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    identity = { machineId: randomUUID(), userId: randomUUID() }
    try { await writeJsonAtomic(file, identity, true) } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure
      identity = identitySchema.parse(await readJsonBounded(file))
    }
  }
  return { kind: 'user', id: identity.userId, name: userInfo().username, machineId: identity.machineId, machineName: hostname() }
}

export interface SharedRoutes {
  schemaVersion: 1
  workspaceId: string
  sessions: SharedSessionDescriptor[]
  active: Record<string, string>
}
const routesSchema = z.object({ schemaVersion: z.literal(1), workspaceId: z.uuid(), sessions: z.array(descriptorSchema).max(1000), active: z.record(z.string().regex(/^T-\d{4,}$/), z.uuid()) }).strict().superRefine((value, context) => {
  const ids = new Set<string>()
  for (const session of value.sessions) {
    if (ids.has(session.id) || session.workspaceId !== value.workspaceId) context.addIssue({ code: 'custom', message: 'Shared session identity mismatch.' })
    ids.add(session.id)
  }
  for (const [taskId, id] of Object.entries(value.active)) if (!value.sessions.some((session) => session.id === id && session.taskId === taskId)) context.addIssue({ code: 'custom', message: 'Invalid active shared-session route.' })
})

async function repositoryDirectory(folder: string): Promise<string> {
  const root = await realpath(folder)
  const directory = join(root, '.taskcontinuum')
  await mkdir(directory, { recursive: true })
  const info = await lstat(directory)
  const child = relative(root, await realpath(directory))
  if (!info.isDirectory() || info.isSymbolicLink() || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Shared routes must be stored inside the workspace, not a linked directory.')
  return directory
}

export async function readSharedRoutes(root: string): Promise<SharedRoutes | null> {
  const directory = join(root, '.taskcontinuum')
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid shared-session route directory.')
    const file = join(directory, 'shared-sessions.json')
    const fileInfo = await lstat(file)
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink > 1) throw new Error('Shared routes must use a regular file.')
    return routesSchema.parse(await readJsonBounded(file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function registerSharedRoute(root: string, session: SharedSessionDescriptor, activate: boolean): Promise<SharedRoutes> {
  descriptorSchema.parse(session)
  const directory = await repositoryDirectory(root)
  const lockFile = join(directory, 'shared-sessions.lock')
  const lock = await open(lockFile, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new Error('Shared session routes are being updated. Retry after the other writer exits.')
    throw error
  })
  try {
    const file = join(directory, 'shared-sessions.json')
    const before = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    const previous = await readSharedRoutes(root)
    if (previous && previous.workspaceId !== session.workspaceId) throw new Error('This enrollment belongs to a different workspace. Open its repository clone first.')
    if (activate && previous?.active[session.taskId] && previous.active[session.taskId] !== session.id) throw new Error('A different shared session already owns the task route. Refresh instead of replacing its owner.')
    const prior = previous?.sessions.find((item) => item.id === session.id)
    if (prior && JSON.stringify(descriptorSchema.parse(prior)) !== JSON.stringify(descriptorSchema.parse(session))) throw new Error('The shared session route conflicts with repository metadata.')
    const value = routesSchema.parse({ schemaVersion: 1, workspaceId: session.workspaceId, sessions: prior ? previous!.sessions : [...previous?.sessions ?? [], session], active: { ...previous?.active, ...(activate ? { [session.taskId]: session.id } : {}) } })
    const changed = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (before !== changed) throw new Error('Shared session routes changed on disk. Refresh and retry.')
    await writeJsonAtomic(file, value)
    const ignoreFile = join(directory, '.gitignore')
    const ignoreInfo = await lstat(ignoreFile).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (ignoreInfo && (!ignoreInfo.isFile() || ignoreInfo.isSymbolicLink() || ignoreInfo.nlink > 1)) throw new Error('The shared metadata ignore file must be a regular file.')
    const ignore = await readFile(ignoreFile, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error })
    const rules = ['shared-sessions.lock', 'shared-sessions.json.*.tmp']
    const missing = rules.filter((rule) => !ignore.split(/\r?\n/).includes(rule))
    if (missing.length) {
      const handle = await open(ignoreFile, 'a', 0o600)
      try { await handle.writeFile(`${ignore && !ignore.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`) } finally { await handle.close() }
    }
    return value
  } finally { await lock.close(); await rm(lockFile, { force: true }) }
}