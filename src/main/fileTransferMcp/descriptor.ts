import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { FILE_MCP_DESCRIPTOR, FileTransferError, localFileEndpointSchema } from '../../shared/fileTransfer'
import type { z } from 'zod'

export type LocalFileEndpoint = z.infer<typeof localFileEndpointSchema>
const execute = promisify(execFile)
const MAX_DESCRIPTOR_BYTES = 1024

export function defaultDataDirectory(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.TASKCONTINUUM_DATA_DIR) return env.TASKCONTINUUM_DATA_DIR
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Task Continuum')
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Task Continuum')
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Task Continuum')
}

function privateFile(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_DESCRIPTOR_BYTES
    || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
    throw new FileTransferError('ACCESS_DENIED', 'Unsafe local bridge descriptor.')
  }
}

async function windowsPermissions(file: string, set: boolean): Promise<void> {
  if (process.platform !== 'win32') return
  // PowerShell receives only the path, never the bearer token or descriptor contents.
  const script = `
$ErrorActionPreference = 'Stop'
$file = $env:TASKCONTINUUM_DESCRIPTOR_FILE
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
${set ? `
$acl = [System.Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')
$acl.AddAccessRule($rule)
[System.IO.File]::SetAccessControl($file, $acl)
` : ''}
$acl = [System.IO.File]::GetAccessControl($file)
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 1 }
$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
$allowed = $false
foreach ($rule in $rules) {
  if ($rule.AccessControlType -eq 'Allow') {
    if ($rule.IdentityReference.Value -ne $sid.Value) { exit 1 }
    if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadData) -ne 0) { $allowed = $true }
  }
}
if (-not $allowed) { exit 1 }
`
  try {
    await execute(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, TASKCONTINUUM_DESCRIPTOR_FILE: file }, windowsHide: true, timeout: 10_000, maxBuffer: 4096 })
  } catch { throw new FileTransferError('ACCESS_DENIED', 'Local bridge descriptor must be private to its owner.') }
}

async function checkDirectory(directory: string): Promise<void> {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()
    || (process.platform !== 'win32' && ((info.mode & 0o022) !== 0 || info.uid !== process.getuid?.()))) {
    throw new FileTransferError('ACCESS_DENIED', 'Unsafe local bridge directory.')
  }
}

export async function readEndpoint(directory: string): Promise<LocalFileEndpoint> {
  try {
    await checkDirectory(directory)
    const file = join(directory, FILE_MCP_DESCRIPTOR)
    const before = await lstat(file)
    privateFile(before)
    await windowsPermissions(file, false)
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const info = await handle.stat()
      privateFile(info)
      if (info.ino !== before.ino || info.dev !== before.dev) throw new Error('Descriptor changed')
      const buffer = Buffer.alloc(MAX_DESCRIPTOR_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > MAX_DESCRIPTOR_BYTES) throw new Error('Descriptor too large')
      const after = await lstat(file)
      privateFile(after)
      if (info.ino !== after.ino || info.dev !== after.dev) throw new Error('Descriptor changed')
      return localFileEndpointSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')))
    } finally { await handle.close() }
  } catch (error) {
    if (error instanceof FileTransferError) throw error
    throw new FileTransferError('UNAVAILABLE', 'No valid local file transfer bridge is available.')
  }
}

export async function writeEndpoint(directory: string, endpoint: LocalFileEndpoint): Promise<void> {
  const file = join(directory, FILE_MCP_DESCRIPTOR)
  const pending = join(directory, `.${FILE_MCP_DESCRIPTOR}.${randomUUID()}`)
  try {
    const content = JSON.stringify(localFileEndpointSchema.parse(endpoint))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await checkDirectory(directory)
    try {
      privateFile(await lstat(file))
      await windowsPermissions(file, false)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const handle = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      await windowsPermissions(pending, true)
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    await rename(pending, file)
  } catch {
    throw new FileTransferError('ACCESS_DENIED', 'Could not publish a private local bridge descriptor.')
  } finally { await unlink(pending).catch(() => {}) }
}

export async function removeEndpoint(directory: string, endpoint: LocalFileEndpoint): Promise<void> {
  try {
    const current = await readEndpoint(directory)
    if (current.token === endpoint.token && current.port === endpoint.port) await unlink(join(directory, FILE_MCP_DESCRIPTOR))
  } catch { /* A replacement or inaccessible descriptor belongs to its current owner. */ }
}
