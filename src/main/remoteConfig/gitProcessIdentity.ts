import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export const windowsCreationTicks = /^[1-9]\d{17}$/
let currentCreationTicks: Promise<string | undefined> | undefined

export async function readProcessCreationTicks(pid: number): Promise<string | undefined> {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return undefined

  const powerShellHome = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')
  // CIM can read kernel creation times even when Get-Process.StartTime is inaccessible.
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $p=CimCmdlets\\Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}' -Property CreationDate -OperationTimeoutSec 3; if ($null -ne $p.CreationDate) { $p.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) }`
  try {
    const { stdout, stderr } = await execute(join(powerShellHome, 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], {
      windowsHide: true, timeout: 5000, maxBuffer: 4096,
      env: { ...process.env, PSModulePath: join(powerShellHome, 'Modules') },
    })
    const ticks = stdout.trim()
    return !stderr.trim() && windowsCreationTicks.test(ticks) ? ticks : undefined
  } catch {
    // Permission errors or unavailable process metadata cannot establish that the PID was reused.
    return undefined
  }
}

export function ownProcessCreationTicks(): Promise<string | undefined> {
  return currentCreationTicks ??= readProcessCreationTicks(process.pid)
}
