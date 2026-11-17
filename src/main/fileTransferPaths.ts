import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { FileTransferError } from '../shared/fileTransfer'

export function sameFilePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export function withinFilePath(parent: string, child: string): boolean {
  const path = relative(process.platform === 'win32' ? parent.toLowerCase() : parent,
    process.platform === 'win32' ? child.toLowerCase() : child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export function localTransferPath(path: string): string {
  const denied = () => new FileTransferError('ACCESS_DENIED', 'Only ordinary local paths are allowed.')
  if (!isAbsolute(path) || [...path].some((char) => char.charCodeAt(0) < 32) || /^[\\/]{2}/.test(path)) throw denied()
  if (process.platform === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(path) || path.slice(2).includes(':')
      || path.slice(3).split(/[\\/]/).some((part) => /[. ]$/.test(part) || /[<>"|?*]/.test(part)
        || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) throw denied()
  } else if (path.includes('\\') || path.includes(':')) throw denied()
  return resolve(path)
}

export async function assertTransferAncestors(path: string): Promise<void> {
  const root = parse(path).root
  let current = root
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = resolve(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new FileTransferError('ACCESS_DENIED', 'Linked file paths are not allowed.')
  }
  if (!sameFilePath(await realpath(path), path)) throw new FileTransferError('ACCESS_DENIED', 'Linked file paths are not allowed.')
}

export function assertPublicTransferPath(directory: string, absolute: string): void {
  const parts = absolute.toLowerCase().split(/[\\/]/)
  const discovery = process.env.TASKCONTINUUM_AGENT_HOST_DISCOVERY
  if (withinFilePath(directory, absolute) || parts.includes('.ssh')
    || discovery && withinFilePath(resolve(discovery), absolute)
    || parts.some((part, index) => part === 'local-endpoint' && parts[index + 1] === 'entries')) {
    throw new FileTransferError('ACCESS_DENIED', 'Application credentials and private storage cannot be transferred.')
  }
}

export function assertTransferSavePath(directory: string, absolute: string): void {
  assertPublicTransferPath(directory, absolute)
  if (absolute.toLowerCase().split(/[\\/]/).some((part) => ['.git', '.taskcontinuum', '.agentdesk', '.todoplus'].includes(part))) {
    throw new FileTransferError('ACCESS_DENIED', 'Repository control and application policy files are not save destinations.')
  }
}
