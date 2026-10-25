import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { RemoteConfigError } from '../remoteConfig/records'
import { bytesHash, contentHash } from '../remoteConfig/trustBaseline'
import { writeJsonAtomic, writeTextAtomic } from '../shared/storage'
import { existing, fileHash, treeStamps, type FileStamp } from './local'
import { windowsProbe } from './git'

export async function assertPrivateDestination(directory: string): Promise<void> {
  let parent = resolve(directory)
  while (true) {
    if (await existing(join(parent, '.git')) || await existing(join(parent, 'HEAD')) && await existing(join(parent, 'objects'))) {
      throw new RemoteConfigError('migration-output', 'Migration reports, helper data and private checkpoints must be outside every Git repository.')
    }
    if (await existing(parent) && await realpath(parent) !== parent) throw new RemoteConfigError('unsafe-path', 'The migration destination must not pass through filesystem links.')
    const next = dirname(parent)
    if (next === parent) return
    parent = next
  }
}
export async function protectedDirectory(directory: string): Promise<void> {
  if (!isAbsolute(directory)) throw new RemoteConfigError('unsafe-path', 'Protected migration directories must be absolute.')
  const present = await existing(directory)
  if (present) {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new RemoteConfigError('unsafe-path', 'A protected migration directory was redirected.')
  }
  if (await realpath(dirname(directory)) !== dirname(directory)) throw new RemoteConfigError('unsafe-path', 'The backup parent must be a real directory, not a filesystem link.')
  if (!present) await mkdir(directory, { mode: 0o700 })
  if (process.platform === 'win32') {
    const sid = await windowsProbe('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value')
    if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new RemoteConfigError('migration-backup', 'The current Windows identity could not be verified.')
    const encoded = Buffer.from(directory).toString('base64')
    // Node can add explicit Administrators access; disabling inheritance alone retains it.
    const initialize = present ? '' : `
$a=New-Object Security.AccessControl.DirectorySecurity
$a.SetOwner((New-Object Security.Principal.SecurityIdentifier('${sid}')))
$a.SetAccessRuleProtection($true,$false)
foreach($s in @('${sid}','S-1-5-18')){
  $identity=New-Object Security.Principal.SecurityIdentifier($s)
  $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
}
[IO.Directory]::SetAccessControl($p,$a)
`
    const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); ${initialize}
$a=[IO.Directory]::GetAccessControl($p); if(-not $a.AreAccessRulesProtected){throw 'Unprotected backup inheritance'}; foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin @('${sid}','S-1-5-18')){throw 'Backup has unrelated access'}}`
    await windowsProbe(script)
  } else {
    if (present && ((await lstat(directory)).mode & 0o077) !== 0) throw new RemoteConfigError('migration-backup', 'An existing migration directory is not private to its owner.')
    if (!present) await chmod(directory, 0o700)
  }
}
export async function putExact(file: string, content: string): Promise<void> {
  if (await existing(file)) {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await readFile(file, 'utf8') !== content) {
      throw new RemoteConfigError('migration-interrupted', 'An existing migration output differs from the expected bytes. Preserve it and stop.')
    }
    return
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeTextAtomic(file, content, true)
}
export async function putJsonExact(file: string, value: unknown): Promise<void> {
  await putExact(file, JSON.stringify(value, null, 2) + '\n')
}
export async function replaceExpected(file: string, expectedHash: string, value: unknown): Promise<void> {
  const desired = JSON.stringify(value, null, 2) + '\n'
  const bytes = await readFile(file)
  if (bytes.toString('utf8') === desired) return
  if (bytesHash(bytes) !== expectedHash) throw new RemoteConfigError('migration-changed', 'A migration-controlled file changed since the verified checkpoint.')
  await writeJsonAtomic(file, value)
}
export async function copyVerifiedTree(source: string, destination: string): Promise<FileStamp[]> {
  const before = await treeStamps(source)
  await protectedDirectory(destination)
  for (const stamp of before) {
    const child = relative(source, join(source, stamp.path))
    if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) throw new RemoteConfigError('unsafe-path', 'A backup path escapes its source.')
    const file = join(destination, stamp.path)
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    if (!await existing(file)) await pipeline(createReadStream(join(source, stamp.path)), createWriteStream(file, { flags: 'wx', mode: 0o600 }))
    if (await fileHash(file) !== stamp.sha256) throw new RemoteConfigError('migration-backup', 'A backup file differs from its verified source.')
  }
  if (contentHash(before) !== contentHash(await treeStamps(source)) || contentHash(before) !== contentHash(await treeStamps(destination))) {
    throw new RemoteConfigError('migration-backup', 'The source changed during protected backup. Migration has not been authorized to proceed.')
  }
  return before
}
