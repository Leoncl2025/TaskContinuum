import { createHash } from 'node:crypto'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { remoteConfigLimits } from '../../shared/remoteConfig'
import { checkedDirectory, RemoteConfigError } from './records'

export interface AuthorizationTransactionLock { dev: bigint; ino: bigint }

/** Metadata is only a cache invalidator; a changed input always needs the full verified store read. */
export async function authorizationInputs(recordsRoot: string, outboxRoot: string, stateDirectory: string, ownedLock?: AuthorizationTransactionLock): Promise<string> {
  const rows: string[] = []
  let entries = 0
  async function stamp(path: string, directory: boolean): Promise<boolean> {
    let info
    try { info = await lstat(path, { bigint: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      rows.push(`${path}:missing`)
      return false
    }
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n)) {
      throw new RemoteConfigError('unsafe-path', 'Authorization inputs must be real directories and single-link regular files.')
    }
    rows.push(`${path}:${info.dev}:${info.ino}:${info.mode}:${info.nlink}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`)
    return true
  }
  async function tree(root: string): Promise<void> {
    if (!await stamp(root, true)) return
    rows.push(`${root}:canonical:${await realpath(root)}`)
    const base = await checkedDirectory(root, ['.taskcontinuum', 'records', 'v1'])
    if (!base) { rows.push(`${root}:no-records`); return }
    async function visit(directory: string, depth: number): Promise<void> {
      if (depth > 4) throw new RemoteConfigError('unsafe-path', 'The record store has an unexpected directory depth.')
      if (!await stamp(directory, true)) throw new RemoteConfigError('authorization-changed', 'Authorization inputs changed while being checked.')
      const children = await readdir(directory, { withFileTypes: true })
      entries += children.length
      if (entries > remoteConfigLimits.records * 10) throw new RemoteConfigError('resource-limit', 'Authorization inputs exceed the record entry limit.')
      const files = children.filter((child) => !child.isDirectory())
      // Visit directories serially so recursive branches cannot multiply the I/O budget.
      for (let index = 0; index < files.length; index += 16) {
        await Promise.all(files.slice(index, index + 16).map(async (child) => {
          const path = join(directory, child.name)
          if (!await stamp(path, false)) throw new RemoteConfigError('authorization-changed', 'Authorization inputs changed while being checked.')
        }))
      }
      for (const child of children) if (child.isDirectory()) await visit(join(directory, child.name), depth + 1)
    }
    await visit(base, 0)
  }
  await tree(recordsRoot)
  await tree(outboxRoot)
  const canonicalState = await realpath(stateDirectory)
  const state = await lstat(stateDirectory, { bigint: true })
  if (!state.isDirectory() || state.isSymbolicLink()) throw new RemoteConfigError('unsafe-path', 'Authorization state directory must not be a filesystem link.')
  // Creating/removing store.lock changes the directory timestamps on every full read.
  rows.push(`${stateDirectory}:${canonicalState}:${state.dev}:${state.ino}:${state.mode}`)
  await Promise.all(['store.json', 'pending-operations.json'].map((name) => stamp(join(stateDirectory, name), false)))
  try {
    const lock = await lstat(join(stateDirectory, 'store.lock'), { bigint: true })
    if (!ownedLock || !lock.isFile() || lock.isSymbolicLink() || lock.nlink !== 1n || lock.dev !== ownedLock.dev || lock.ino !== ownedLock.ino) {
      throw new RemoteConfigError('store-busy', 'A configuration transaction is in progress. Retry authorization after it finishes.')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (ownedLock) throw new RemoteConfigError('store-busy', 'The configuration transaction lock was removed during validation.')
  }
  return createHash('sha256').update(rows.sort().join('\n')).digest('hex')
}
