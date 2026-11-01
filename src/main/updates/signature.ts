import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'

export type SignatureVerifier = (file: string, publishers: readonly string[]) => Promise<void>

export function validateWindowsSignature(file: string, publishers: readonly string[], output: string): void {
  if (!publishers.length || publishers.some(name => !name.trim())) throw new Error('No trusted update publishers configured.')
  const signature: unknown = JSON.parse(output.replace(/^\uFEFF/, '').trim())
  if (!signature || typeof signature !== 'object') throw new Error('Missing executable signature information.')
  const data = signature as Record<string, unknown>
  if (data.Status !== 0 || typeof data.Path !== 'string' ||
      resolve(data.Path).toLowerCase() !== resolve(file).toLowerCase() ||
      !publishers.some(name => name === data.Subject || name === data.Name)) {
    throw new Error('The executable signature is invalid or its publisher is not trusted.')
  }
}

// The upstream verifier permits verification failures on old PowerShell versions.
// Updates deliberately fail closed instead, including when PowerShell is unavailable.
export const verifyWindowsSignature: SignatureVerifier = async (file, publishers) => {
  if (!publishers.length || publishers.some(name => !name.trim())) throw new Error('No trusted update publishers configured.')
  const literal = file.replaceAll("'", "''")
  const script = `$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath '${literal}'; [pscustomobject]@{Status=[int]$s.Status;Path=$s.Path;Subject=$s.SignerCertificate.Subject;Name=$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)} | ConvertTo-Json -Compress`
  const output = await new Promise<string>((resolveOutput, reject) => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, env: { ...process.env, PSModulePath: '' } }, (error, stdout, stderr) => {
        if (error || stderr.trim()) reject(new Error(`Signature verification failed: ${error?.message ?? stderr.trim()}`))
        else resolveOutput(stdout)
      })
  })
  validateWindowsSignature(file, publishers, output)
}
