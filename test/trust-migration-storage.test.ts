// @vitest-environment node
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { windowsProbe } from '../src/main/migration/git'
import { protectedDirectory } from '../src/main/migration/storage'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function destination() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tc-migration-acl-')))
  roots.push(root)
  return join(root, 'private')
}

function pathScript(directory: string): string {
  return `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(directory).toString('base64')}'));`
}

async function descriptor(directory: string): Promise<string> {
  return windowsProbe(`${pathScript(directory)} [IO.Directory]::GetAccessControl($p).GetSecurityDescriptorSddlForm('All')`)
}

describe.skipIf(process.platform !== 'win32')('Windows migration private directory ACLs', () => {
  it('creates owner/SYSTEM-only access and preserves the ACL and data on reentry', async () => {
    const directory = await destination()
    await protectedDirectory(directory)
    const security = await windowsProbe(`${pathScript(directory)}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$a=[IO.Directory]::GetAccessControl($p)
if(-not $a.AreAccessRulesProtected -or $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'Unprotected owner'}
$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if($rules.Count -ne 2){throw 'Unexpected ACL entries'}
foreach($s in @($sid,'S-1-5-18')){
  $r=@($rules | Where-Object {$_.IdentityReference.Value -eq $s})
  if($r.Count -ne 1 -or $r[0].AccessControlType -ne 'Allow' -or $r[0].FileSystemRights -ne 'FullControl' -or $r[0].InheritanceFlags -ne 'ContainerInherit,ObjectInherit'){throw 'Missing private access'}
}
'PRIVATE'`)
    expect(security).toBe('PRIVATE')
    await writeFile(join(directory, 'fixture.txt'), 'Preserve this checkpoint fixture.\n')
    const before = await descriptor(directory)
    await protectedDirectory(directory)
    expect(await descriptor(directory)).toBe(before)
    expect(await readFile(join(directory, 'fixture.txt'), 'utf8')).toBe('Preserve this checkpoint fixture.\n')
  }, 30000)

  it('rejects existing unrelated access without silently repairing the ACL', async () => {
    const directory = await destination()
    await protectedDirectory(directory)
    await windowsProbe(`${pathScript(directory)}
$a=[IO.Directory]::GetAccessControl($p)
$other=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($other,'ReadAndExecute','Allow')))
[IO.Directory]::SetAccessControl($p,$a)`)
    const before = await descriptor(directory)
    await expect(protectedDirectory(directory)).rejects.toThrow('Backup has unrelated access')
    expect(await descriptor(directory)).toBe(before)
  }, 30000)

  it('rejects existing inherited permissions without modifying them', async () => {
    const directory = await destination()
    await mkdir(directory)
    const before = await descriptor(directory)
    await expect(protectedDirectory(directory)).rejects.toThrow('Unprotected backup inheritance')
    expect(await descriptor(directory)).toBe(before)
  }, 30000)
})
