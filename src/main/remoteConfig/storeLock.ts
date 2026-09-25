import { randomUUID } from 'node:crypto'
import { lstat, open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import type { AuthorizationTransactionLock } from './authorizationInputs'
import { readCheckedFile, RemoteConfigError } from './records'

const ownerSchema = z.object({
  schemaVersion: z.literal(1), workspaceId: z.uuid(), pid: z.number().int().positive().max(2147483647),
  host: z.string().min(1).max(255), nonce: z.uuid(),
}).strict()

interface HeldLock {
  identity: AuthorizationTransactionLock
  release(): Promise<void>
}
export interface StoreLock extends HeldLock { recovered: boolean }

function busy(message: string): RemoteConfigError { return new RemoteConfigError('store-busy', message) }
function manualRecovery(file: string): string {
  return `Stop all Task Continuum instances using this data directory before backing up ${basename(file)}; do not delete configuration or pending operations.`
}

async function assertHeld(file: string, handle: FileHandle, content?: string): Promise<void> {
  const held = await handle.stat({ bigint: true })
  let current
  try { current = await lstat(file, { bigint: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw busy('The configuration lock was removed while in use. No replacement lock was removed.')
  }
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || current.dev !== held.dev || current.ino !== held.ino
    || content !== undefined && (await readCheckedFile(dirname(file), file, 1024)).toString('utf8') !== content) {
    throw busy('Configuration lock ownership changed. The replacement lock was not removed.')
  }
}

async function createLock(file: string, workspaceId: string): Promise<HeldLock | undefined> {
  let handle
  try { handle = await open(file, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
    throw error
  }
  let content: string | undefined
  let releasing: Promise<void> | undefined
  const release = () => releasing ??= (async () => {
    try { await assertHeld(file, handle, content) } finally { await handle.close() }
    await rm(file)
  })()
  try {
    const value = JSON.stringify(ownerSchema.parse({ schemaVersion: 1, workspaceId, pid: process.pid, host: hostname(), nonce: randomUUID() }))
    await handle.writeFile(value, 'utf8')
    await handle.sync()
    content = value
    const held = await handle.stat({ bigint: true })
    await assertHeld(file, handle, content)
    return { identity: { dev: held.dev, ino: held.ino }, release }
  } catch (error) {
    await release()
    throw error
  }
}

async function removeExitedOwner(file: string, workspaceId: string): Promise<void> {
  const info = await lstat(file, { bigint: true })
  const content = await readCheckedFile(dirname(file), file, 1024)
  let value: unknown
  try { value = JSON.parse(content.toString('utf8')) as unknown } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw busy(`The configuration lock has no readable owner (legacy, incomplete or corrupt lock). ${manualRecovery(file)}`)
  }
  const parsed = ownerSchema.safeParse(value)
  if (!parsed.success) throw busy(`The configuration lock owner format is unsupported. ${manualRecovery(file)}`)
  const owner = parsed.data
  if (owner.workspaceId !== workspaceId || owner.host !== hostname()) {
    throw busy(`The configuration lock belongs to another workspace or machine. ${manualRecovery(file)}`)
  }
  try { process.kill(owner.pid, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw busy(`The configuration lock owner's process status could not be verified (PID ${owner.pid}). The lock was retained.`)
    }
    const current = await lstat(file, { bigint: true })
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || current.dev !== info.dev || current.ino !== info.ino
      || !(await readCheckedFile(dirname(file), file, 1024)).equals(content)) {
      throw busy('The configuration lock changed during recovery. Retry; the replacement lock was not removed.')
    }
    await rm(file)
    return
  }
  throw busy(`A live process (PID ${owner.pid}) holds the configuration lock. Close its Task Continuum instance or let the operation finish; the lock was not removed.`)
}

export async function acquireStoreLock(directory: string, workspaceId: string): Promise<StoreLock> {
  const file = join(directory, 'store.lock')
  const direct = await createLock(file, workspaceId)
  if (direct) return { ...direct, recovered: false }
  // A separate exclusive guard prevents two reclaimers from deleting a new owner's lock.
  const recoveryFile = join(directory, 'store-recovery.lock')
  const recovery = await createLock(recoveryFile, workspaceId)
  if (!recovery) throw busy(`Configuration lock recovery is already in progress or was interrupted. Retry. If it persists: ${manualRecovery(recoveryFile)}`)
  let acquired: HeldLock | undefined
  let recovered = false
  try {
    try {
      acquired = await createLock(file, workspaceId)
      if (!acquired) {
        await removeExitedOwner(file, workspaceId)
        recovered = true
        acquired = await createLock(file, workspaceId)
        if (!acquired) throw busy('Another process acquired the configuration lock during recovery. Retry after it finishes.')
      }
    } finally { await recovery.release() }
    return { ...acquired, recovered }
  } catch (error) {
    await acquired?.release()
    throw error
  }
}
