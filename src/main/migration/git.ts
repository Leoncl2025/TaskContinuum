import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { gitEnvironment, normalizeGitRemoteUrl } from '../remoteConfig/git'
import { RemoteConfigError } from '../remoteConfig/records'
import { contentHash, gitCommitSchema } from '../remoteConfig/trustBaseline'

const execute = promisify(execFile)
export interface MigrationRepository {
  workspaceRoot: string
  repositoryRoot: string
  relativePath: string
  sourceBranch: string
  remote: string
  remoteBranch: string
  trackingRef: string
  fetchUrl: string
  pushUrl: string
  repositoryHash: string
  head: string
  refPrefix: string
  targetRef: string
}
export async function migrationGit(root: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true', ...args], {
      cwd: root, windowsHide: true, shell: false, env: gitEnvironment(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let size = 0, exceeded = false, timedOut = false
    const timeout = setTimeout(() => { timedOut = true; child.kill() }, 120000)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 80 * 1024 * 1024) { exceeded = true; child.kill() } else chunks.push(chunk)
    })
    child.stderr.resume()
    child.on('error', (error) => { clearTimeout(timeout); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (exceeded || timedOut || code !== 0 && !options.allowFailure) {
        reject(new RemoteConfigError('migration-git', `Git ${args[0]} failed${timedOut ? ' (timeout)' : exceeded ? ' (output limit)' : ''}. Migration stopped; no fallback or force push was attempted.`))
      } else resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString('utf8') })
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') reject(error) })
    child.stdin.end(options.input)
  })
}
export async function gitText(root: string, ...args: string[]): Promise<string> { return (await migrationGit(root, args)).stdout.trim() }
export async function inspectRepository(workspace: string, requireSource = true): Promise<MigrationRepository> {
  const workspaceRoot = await realpath(workspace)
  const repositoryRoot = await realpath(await gitText(workspaceRoot, 'rev-parse', '--show-toplevel'))
  const selected = relative(repositoryRoot, workspaceRoot)
  if (isAbsolute(selected) || selected === '..' || selected.startsWith(`..${sep}`)) throw new RemoteConfigError('unsafe-path', 'The workspace must remain in its selected Git checkout.')
  const sourceBranch = await gitText(repositoryRoot, 'symbolic-ref', '--quiet', 'HEAD')
  const fields = (await gitText(repositoryRoot, 'for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)', sourceBranch)).split('\0')
  const [remote, remoteBranch, trackingRef] = fields
  if (fields.length !== 3 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote) || !remoteBranch?.startsWith('refs/heads/') || !trackingRef?.startsWith('refs/remotes/')) {
    throw new RemoteConfigError('migration-upstream', 'An existing tracked upstream is required; no branch is inferred.')
  }
  const urls = await Promise.all([false, true].map(async (push) => {
    const rows = (await gitText(repositoryRoot, 'remote', 'get-url', ...(push ? ['--push'] : []), '--all', '--', remote)).split('\n')
    if (rows.length !== 1) throw new RemoteConfigError('migration-upstream', 'Migration requires one fetch URL and one push URL.')
    return normalizeGitRemoteUrl(rows[0], repositoryRoot)
  }))
  const [fetchUrl, pushUrl] = urls
  const head = gitCommitSchema.parse(await gitText(repositoryRoot, 'rev-parse', 'HEAD'))
  const relativePath = selected.split(sep).join('/')
  const prefix = 'refs/taskcontinuum/checkout-v2'
  const refPrefix = relativePath ? `${prefix}/workspaces/${hashText(relativePath)}` : prefix
  const targetRef = `${refPrefix}/targets/${hashText(JSON.stringify([fetchUrl, pushUrl, remoteBranch.slice(11)]))}/accepted`
  const result = { workspaceRoot, repositoryRoot, relativePath, sourceBranch, remote, remoteBranch, trackingRef, fetchUrl, pushUrl,
    repositoryHash: contentHash([fetchUrl, pushUrl]), head, refPrefix, targetRef }
  if (requireSource) {
    const gitDirectory = await gitText(repositoryRoot, 'rev-parse', '--absolute-git-dir')
    for (const name of ['HEAD.lock', 'index.lock', 'taskcontinuum-sync.lock', 'taskcontinuum-sync-recovery.lock']) {
      try {
        await lstat(join(gitDirectory, name))
        throw new RemoteConfigError('migration-lock', 'An existing Git operation or synchronization lock must be resolved by its owner; migration never removes it.')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    if (await gitText(repositoryRoot, 'status', '--porcelain=v1', '--untracked-files=all')) throw new RemoteConfigError('migration-dirty', 'The entire task checkout must be clean. User changes will not be stashed, reset or overwritten.')
    if (await remoteHead(result) !== head || await gitText(repositoryRoot, 'rev-parse', trackingRef) !== head) {
      throw new RemoteConfigError('migration-unpublished', 'The selected checkout and its real upstream must have the same source commit.')
    }
  }
  return result
}
function hashText(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function repositoryPath(repository: MigrationRepository, path: string): string {
  return repository.relativePath ? `${repository.relativePath}/${path}` : path
}
export async function remoteHead(repository: MigrationRepository): Promise<string> {
  const rows = (await gitText(repository.repositoryRoot, 'ls-remote', '--exit-code', '--heads', '--', repository.remote, repository.remoteBranch)).split('\n')
  const fields = rows[0]?.split(/\s+/)
  if (rows.length !== 1 || fields?.[1] !== repository.remoteBranch) throw new RemoteConfigError('migration-upstream', 'The exact selected upstream branch is unavailable.')
  return gitCommitSchema.parse(fields[0])
}
export async function gitPublicFiles(repository: MigrationRepository, revision: string): Promise<Map<string, { content: string }>> {
  gitCommitSchema.parse(revision)
  const listing = (await migrationGit(repository.repositoryRoot, ['ls-tree', '-r', '-z', revision, '--', repositoryPath(repository, '.taskcontinuum')])).stdout
  const entries = listing.split('\0').filter(Boolean).flatMap((row) => {
    const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(row)
    if (!match) throw new RemoteConfigError('migration-git', 'Invalid public Git tree.')
    const [, mode, kind, oid, fullPath] = match
    const path = repository.relativePath ? fullPath.slice(repository.relativePath.length + 1) : fullPath
    if (path !== '.taskcontinuum/workspace.json' && !path.startsWith('.taskcontinuum/records/')) return []
    if (mode !== '100644' || kind !== 'blob' || path.includes('..') || path.includes('\\')) throw new RemoteConfigError('unsafe-path', 'Public history contains a linked or unsupported path.')
    return [{ path, oid }]
  })
  if (entries.length > 10001) throw new RemoteConfigError('resource-limit', 'The public history exceeds its record budget.')
  const bytes = Buffer.from((await migrationGit(repository.repositoryRoot, ['cat-file', '--batch'], { input: entries.map((e) => e.oid).join('\n') + '\n' })).stdout, 'utf8')
  const result = new Map<string, { content: string }>()
  let offset = 0
  for (const entry of entries) {
    const end = bytes.indexOf(10, offset)
    const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(bytes.subarray(offset, end).toString('ascii'))
    if (!match || match[1] !== entry.oid) throw new RemoteConfigError('migration-git', 'Public Git blobs could not be read completely.')
    const size = Number(match[2])
    if (size > 32768 || bytes[end + size + 1] !== 10) throw new RemoteConfigError('resource-limit', 'A public migration blob exceeds its original size limit.')
    result.set(entry.path, { content: bytes.subarray(end + 1, end + size + 1).toString('utf8') })
    offset = end + size + 2
  }
  if (offset !== bytes.length) throw new RemoteConfigError('migration-git', 'Unexpected bytes in public Git history.')
  return result
}
export async function isAncestor(repository: MigrationRepository, before: string, after: string): Promise<boolean> {
  const result = await migrationGit(repository.repositoryRoot, ['merge-base', '--is-ancestor', gitCommitSchema.parse(before), gitCommitSchema.parse(after)], { allowFailure: true })
  if (result.code > 1) throw new RemoteConfigError('migration-git', 'Git ancestry could not be verified.')
  return result.code === 0
}
export async function assertNoProfileProcess(profile: string): Promise<void> {
  if (process.platform !== 'win32') throw new RemoteConfigError('migration-platform', 'The first migration CLI supports Windows process and protected-backup checks only. This platform must not bypass those checks.')
  const encoded = Buffer.from(profile).toString('base64')
  const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.ProcessId -ne ${process.pid} -and @('electron.exe','TaskContinuum.exe') -contains $_.Name -and $_.CommandLine -and $_.CommandLine.IndexOf($p,[StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`
  if (await windowsProbe(script)) throw new RemoteConfigError('migration-running', 'An Electron/Task Continuum process still references this profile. Stop the verified instance externally; this tool never terminates it.')
}
export async function windowsProbe(script: string): Promise<string> {
  const systemRoot = process.env.SystemRoot
  if (process.platform !== 'win32' || !systemRoot) throw new RemoteConfigError('migration-platform', 'Windows operating-system checks are unavailable.')
  const home = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
  const output = await execute(join(home, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 15000, maxBuffer: 16384, env: { ...process.env, PSModulePath: join(home, 'Modules') },
  })
  return output.stdout.trim()
}
