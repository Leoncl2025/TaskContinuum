import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, readdir, rename, rm, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { matchesGitText } from '../shared/gitText'

export interface GitPublication {
  path: string
  content: string
}

export interface GitReplicaOptions {
  workspaceRoot: string
  stateDirectory: string
  /** Defaults to true. False validates/restores only local state, without fetching. */
  prepare?: boolean
  commandTimeoutMs?: number
  maxOutputBytes?: number
}

export interface GitSyncOptions {
  signal?: AbortSignal
  /** Read-only reconciliation of the pulled tree and preserved app records, before pushing. */
  onPulled?(root: string): Promise<void>
  validateReplica?(root: string): Promise<void>
}

export interface GitSyncResult {
  head: string
  publishedPaths: string[]
  attempts: number
}

export type GitSyncErrorCode = 'upstream' | 'upstream-changed' | 'git' | 'authentication' | 'push-rejected' | 'integrity' | 'unsupported-format' | 'busy' | 'timeout' | 'output-limit' | 'cancelled'

export class GitSyncError extends Error {
  constructor(readonly code: GitSyncErrorCode, message: string) {
    super(message)
    this.name = 'GitSyncError'
  }
}

const REF_PREFIX = 'refs/taskcontinuum/checkout-v2'
const ACCEPTED_REF = `${REF_PREFIX}/accepted`
const DESCRIPTOR = '.taskcontinuum/workspace.json'
const RECORDS = '.taskcontinuum/records/v1/'
const MAX_FILE_BYTES = 256 * 1024
const MAX_PUBLICATIONS = 10000
const PUSH_ATTEMPTS = 3
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const OPERATION = '[a-f0-9]{64}\\.json'
const RECORD_PATH = new RegExp(`^\\.taskcontinuum/records/v1/(?:devices/${UUID}|invitations/${UUID}/${UUID}|bindings/T-[0-9]{4,}|settings/(?:workspace|${UUID})/(?:autoLink|tunnelEnabled|connectTimeoutMs))/${OPERATION}$`)
const queues = new Map<string, Promise<unknown>>()

interface GitResult {
  code: number
  stdout: Buffer
  stderr: Buffer
}

interface Upstream {
  sourceBranch: string
  remote: string
  branch: string
  trackingRef: string
  fetchUrl: string
  pushUrl: string
}

interface Blob {
  oid: string
  content: string
}

function cancelled(): GitSyncError {
  return new GitSyncError('cancelled', 'Remote synchronization was cancelled; pending records are retained.')
}

function integrity(message: string): never {
  throw new GitSyncError('integrity', message)
}

function unsupportedFormat(): never {
  throw new GitSyncError('unsupported-format', 'The saved Git replica format is unsupported. Preserve your old files and explicitly enroll the selected workspace with a fresh synchronization state directory. Old replica contents will not be loaded, migrated, deleted, or overwritten.')
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function managedPath(path: string): boolean {
  return path === DESCRIPTOR || RECORD_PATH.test(path)
}

function validateContent(path: string, content: string): void {
  if (!managedPath(path)) integrity('Publication is outside the immutable public configuration allowlist.')
  if (Buffer.byteLength(content) > MAX_FILE_BYTES || content.includes('\0')) integrity('A public configuration record exceeds its size or encoding limit.')
  let value: unknown
  try { value = JSON.parse(content) } catch { integrity('Public configuration must be valid JSON; the original bytes were retained.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) integrity('Public configuration must contain a JSON object.')
  const suspiciousKey = /^(?:.*private.*|password|passphrase|.*secret.*|.*token.*|credential.*|authorization|cookie|sshconfig|proxycommand|remotecommand|command|shell)$/i
  const pending: unknown[] = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string') {
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|\b(?:AccountKey|SharedAccessKey|Password)\s*=\s*[^;\s]+/i.test(item)) {
        integrity('A public configuration record contains credential-like data; nothing was published.')
      }
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(item)) {
        try {
          const url = new URL(item)
          if (url.password || (url.protocol !== 'ssh:' && url.username) || [...url.searchParams.keys()].some((key) => suspiciousKey.test(key))) integrity('Public configuration may not contain credential-bearing URLs.')
        } catch (error) { if (error instanceof GitSyncError) throw error }
      }
    } else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (suspiciousKey.test(key)) integrity('A public configuration record contains a private or executable field; nothing was published.')
        pending.push(child)
      }
    }
  }
}

function publications(files: readonly GitPublication[]): Map<string, string> {
  if (files.length > MAX_PUBLICATIONS) integrity('The public configuration publication exceeds its record limit.')
  const result = new Map<string, string>()
  let bytes = 0
  for (const file of files) {
    if (typeof file.path !== 'string' || typeof file.content !== 'string') integrity('Public configuration publications require relative paths and UTF-8 content.')
    validateContent(file.path, file.content)
    bytes += Buffer.byteLength(file.content)
    if (bytes > 8 * 1024 * 1024) integrity('The public configuration publication exceeds its byte limit.')
    if (result.has(file.path) && result.get(file.path) !== file.content) integrity('An immutable path has two different contents in the same publication.')
    result.set(file.path, file.content)
  }
  return result
}

function remoteUrl(value: string, workspaceRoot: string): string {
  if (!value || value.length > 8192 || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || value.startsWith('-') || /^[A-Za-z][A-Za-z0-9+.-]*::/.test(value)) {
    throw new GitSyncError('upstream', 'The upstream URL is not a supported Git transport.')
  }
  if (isAbsolute(value)) return resolve(value)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL
    try { url = new URL(value) } catch { throw new GitSyncError('upstream', 'The upstream URL is invalid.') }
    if (!['file:', 'http:', 'https:', 'ssh:', 'git:'].includes(url.protocol) || url.password || (['http:', 'https:', 'git:'].includes(url.protocol) && url.username) || url.search || url.hash) {
      throw new GitSyncError('upstream', 'Use a standard upstream URL and the existing credential helper, not embedded credentials or transport commands.')
    }
    if (url.protocol === 'ssh:' && (!url.hostname || url.hostname.startsWith('-') || (url.username && !/^[A-Za-z0-9._-]+$/.test(url.username)))) throw new GitSyncError('upstream', 'The SSH upstream host or username is invalid.')
    return url.toString()
  }
  if (/^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[a-fA-F0-9:]+\]):[^\0-\x20]+$/.test(value)) return value
  if (value.includes(':')) throw new GitSyncError('upstream', 'The upstream URL is not a supported Git transport.')
  return resolve(workspaceRoot, value)
}

function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|NAMESPACE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|EXTERNAL_DIFF|TRACE.*|CURL_VERBOSE|PREFIX)$/i.test(key)) delete env[key]
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'false',
    GIT_SEQUENCE_EDITOR: 'false',
    GIT_MERGE_AUTOEDIT: 'no',
    GIT_LITERAL_PATHSPECS: '1',
    LC_ALL: 'C',
    ...extra,
  }
}

function failure(result: GitResult, operation: string): GitSyncError {
  const text = Buffer.concat([result.stdout, result.stderr]).toString('utf8')
  if (/authentication failed|could not read (?:username|password)|terminal prompts disabled|permission denied \(publickey\)|invalid username or token/i.test(text)) {
    return new GitSyncError('authentication', 'Git authentication failed. Check the trusted credential helper and repository access; pending records are retained.')
  }
  return new GitSyncError('git', `Git ${operation} failed. Check upstream availability and repository access; pending records are retained.`)
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function regularFile(file: string): Promise<void> {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) integrity('Git synchronization state must use app-owned regular files.')
}

async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(action)
  queues.set(key, next)
  try { return await next } finally { if (queues.get(key) === next) queues.delete(key) }
}

export class GitReplica {
  readonly root: string
  get remote(): string { return this.upstream.remote }
  get branch(): string { return this.upstream.branch }
  get upstreamUrl(): string { return this.upstream.fetchUrl }
  get upstreamRef(): string { return `refs/heads/${this.branch}` }
  private readonly abort = new AbortController()
  private readonly hooks: string
  private readonly timeout: number
  private readonly maximum: number
  private readonly directory: string
  private pending: Promise<unknown> = Promise.resolve()
  private closed = false
  private upstream: Upstream
  private cycle?: Upstream
  private gitDirectory = ''
  private retainedPublications: GitPublication[] = []

  private constructor(
    private readonly workspaceRoot: string,
    stateDirectory: string,
    private readonly owner: Upstream,
    options: GitReplicaOptions,
  ) {
    const id = createHash('sha256').update(JSON.stringify([workspaceRoot, owner.fetchUrl, owner.pushUrl])).digest('hex')
    this.directory = join(stateDirectory, `checkout-v2-${id}`)
    this.root = workspaceRoot
    this.upstream = { ...owner }
    this.hooks = join(stateDirectory, 'git-hooks-disabled')
    this.timeout = options.commandTimeoutMs ?? 30000
    this.maximum = options.maxOutputBytes ?? 8 * 1024 * 1024
  }

  private async git(
    cwd: string,
    args: string[],
    options: { signal?: AbortSignal; input?: string | Buffer; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
  ): Promise<GitResult> {
    const signal = options.signal ? AbortSignal.any([options.signal, this.abort.signal]) : this.abort.signal
    if (signal.aborted) throw cancelled()
    const argv = [
      '--no-pager', '--no-optional-locks', '--literal-pathspecs',
      '-c', `core.hooksPath=${this.hooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true',
      '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
      '-c', 'protocol.http.allow=always', '-c', 'protocol.https.allow=always',
      '-c', 'protocol.ssh.allow=always', '-c', 'protocol.git.allow=always',
      '-c', 'submodule.recurse=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
      '-c', 'fetch.writeCommitGraph=false', '-c', 'color.ui=false',
      '-c', 'commit.gpgSign=false', '-c', 'merge.verifySignatures=false',
      ...args,
    ]
    const result = await new Promise<GitResult>((fulfill, reject) => {
      const child = spawn('git', argv, {
        cwd, env: environment(options.env), shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      })
      const output: Buffer[] = []
      const errors: Buffer[] = []
      let size = 0
      let stopped: GitSyncError | undefined
      const terminate = (error: GitSyncError) => {
        if (stopped) return
        stopped = error
        if (!child.pid) return
        if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
          killer.on('error', () => { child.kill() })
        } else {
          try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
        }
      }
      const onAbort = () => terminate(cancelled())
      const timer = setTimeout(() => terminate(new GitSyncError('timeout', 'Git synchronization timed out; pending records are retained.')), this.timeout)
      timer.unref?.()
      signal.addEventListener('abort', onAbort, { once: true })
      const collect = (chunks: Buffer[], chunk: Buffer) => {
        size += chunk.length
        if (size > this.maximum) terminate(new GitSyncError('output-limit', 'Git output exceeded its bounded limit; pending records are retained.'))
        else chunks.push(chunk)
      }
      child.stdout.on('data', (chunk: Buffer) => collect(output, chunk))
      child.stderr.on('data', (chunk: Buffer) => collect(errors, chunk))
      child.stdin.on('error', () => { /* A failed Git command can close stdin before consuming input. */ })
      child.once('error', () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        reject(stopped ?? new GitSyncError('git', 'Git could not be started. Install Git and retry synchronization.'))
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        if (stopped) reject(stopped)
        else fulfill({ code: code ?? -1, stdout: Buffer.concat(output), stderr: Buffer.concat(errors) })
      })
      if (signal.aborted) onAbort()
      child.stdin.end(options.input)
    })
    if (result.code && !options.allowFailure) throw failure(result, args[0])
    return result
  }

  private async text(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
    return (await this.git(cwd, args, { signal })).stdout.toString('utf8').trim()
  }

  private async readUpstream(signal?: AbortSignal): Promise<Upstream> {
    const symbolic = await this.git(this.workspaceRoot, ['symbolic-ref', '--quiet', 'HEAD'], { signal, allowFailure: true })
    if (symbolic.code === 1) throw new GitSyncError('upstream', 'Select an existing local branch with a configured remote upstream to resume synchronization. Detached HEAD cannot publish configuration.')
    if (symbolic.code) throw failure(symbolic, 'source branch inspection')
    const sourceBranch = symbolic.stdout.toString('utf8').trim()
    if (!sourceBranch.startsWith('refs/heads/')) throw new GitSyncError('upstream', 'Select an existing local branch with a tracked upstream before enabling synchronization.')
    const fields = (await this.text(this.workspaceRoot, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)', sourceBranch], signal)).split('\0')
    const [remote, branchRef, trackingRef] = fields
    if (fields.length !== 3 || !remote || remote === '.' || remote.startsWith('-') || !/^[A-Za-z0-9._/-]+$/.test(remote) || !branchRef?.startsWith('refs/heads/') || !trackingRef?.startsWith('refs/remotes/')) {
      throw new GitSyncError('upstream', 'The selected branch must track an existing remote branch. No default branch is assumed.')
    }
    const branch = branchRef.slice('refs/heads/'.length)
    await this.git(this.workspaceRoot, ['check-ref-format', branchRef], { signal })
    const urls = async (push: boolean) => {
      const result = await this.git(this.workspaceRoot, ['remote', 'get-url', ...(push ? ['--push'] : []), '--all', '--', remote], { signal, allowFailure: true })
      if (result.code) throw new GitSyncError('upstream', 'The configured upstream remote is unavailable. Configure an existing remote upstream to resume synchronization.')
      return result.stdout.toString('utf8').trim().split('\n')
    }
    const fetch = await urls(false)
    const push = await urls(true)
    if (fetch.length !== 1 || push.length !== 1) throw new GitSyncError('upstream', 'Automatic synchronization requires one fetch URL and one push URL for the selected upstream.')
    return { sourceBranch, remote, branch, trackingRef, fetchUrl: remoteUrl(fetch[0], this.workspaceRoot), pushUrl: remoteUrl(push[0], this.workspaceRoot) }
  }

  /**
   * By default fetches/materializes the current branch's upstream, but never pushes.
   * prepare:false validates/restores only local state, even when the remote is offline.
   */
  static async open(options: GitReplicaOptions): Promise<GitReplica> {
    const timeout = options.commandTimeoutMs ?? 30000
    const maximum = options.maxOutputBytes ?? 8 * 1024 * 1024
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000 || !Number.isSafeInteger(maximum) || maximum < 1024 || maximum > 32 * 1024 * 1024) {
      throw new GitSyncError('git', 'Git command limits must be positive and bounded.')
    }
    const workspaceRoot = await realpath(options.workspaceRoot)
    let ancestor = resolve(options.stateDirectory)
    const suffix: string[] = []
    while (!await exists(ancestor)) {
      suffix.unshift(basename(ancestor))
      const parent = dirname(ancestor)
      if (parent === ancestor) throw new GitSyncError('git', 'The synchronization state directory has no accessible parent directory.')
      ancestor = parent
    }
    const destination = resolve(await realpath(ancestor), ...suffix)
    if (isWithin(workspaceRoot, destination)) throw new GitSyncError('git', 'The synchronization state directory must be outside the user checkout.')
    await mkdir(destination, { recursive: true })
    const stateDirectory = await realpath(destination)
    if (isWithin(workspaceRoot, stateDirectory)) throw new GitSyncError('git', 'The synchronization state directory must be outside the user checkout.')
    const stateEntries = await readdir(stateDirectory)
    if (stateEntries.some((entry) => /^(?:git|checkout)-[a-f0-9]{64}$/.test(entry))) unsupportedFormat()
    const probe = new GitReplica(workspaceRoot, stateDirectory, {} as Upstream, options)
    const top = await probe.text(workspaceRoot, ['rev-parse', '--show-toplevel'])
    if (await realpath(top) !== workspaceRoot) throw new GitSyncError('upstream', 'Select the repository root as the workspace for Git synchronization.')
    let upstream: Upstream | undefined
    // Reopening local records must work while detached/offline. Identity is still
    // fenced by the persistent enrollment marker, not by the current Git config.
    for (const entry of stateEntries) {
      if (!/^checkout-v2-[a-f0-9]{64}$/.test(entry)) continue
      const marker = join(stateDirectory, entry, 'owner.json')
      if (!await exists(marker)) {
        if ((await readdir(join(stateDirectory, entry))).length) integrity('The checkout state directory is not empty and has no recognized ownership marker.')
        continue
      }
      await regularFile(marker)
      if ((await lstat(marker)).size > 65536) integrity('The checkout ownership marker exceeds its size limit.')
      const markerContent = await readFile(marker, 'utf8')
      let metadata: unknown
      try { metadata = JSON.parse(markerContent) } catch { integrity('The checkout ownership marker is invalid JSON.') }
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) integrity('The checkout ownership marker is invalid.')
      const owner = metadata as Record<string, unknown>
      if (owner.version !== 2 || owner.mode !== 'selected-checkout') unsupportedFormat()
      if (owner.workspaceRoot === workspaceRoot && typeof owner.fetchUrl === 'string' && typeof owner.pushUrl === 'string' && typeof owner.remote === 'string' && typeof owner.branch === 'string') {
        const candidate: Upstream = { sourceBranch: '', trackingRef: '', remote: owner.remote, branch: owner.branch, fetchUrl: remoteUrl(owner.fetchUrl, workspaceRoot), pushUrl: remoteUrl(owner.pushUrl, workspaceRoot) }
        const expected = new GitReplica(workspaceRoot, stateDirectory, candidate, options)
        if (expected.directory !== join(stateDirectory, entry)) integrity('The checkout state path does not match its owner.')
        if (upstream) integrity('Multiple checkout enrollments exist. Review the saved repository identity before synchronizing.')
        upstream = candidate
      } else integrity('The checkout ownership marker does not match this workspace.')
    }
    upstream ??= await probe.readUpstream()
    const hooks = join(stateDirectory, 'git-hooks-disabled')
    try { await writeFile(hooks, '', { flag: 'wx', mode: 0o600 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    // A regular file cannot contain a hook executable.
    await regularFile(hooks)
    const replica = new GitReplica(workspaceRoot, stateDirectory, upstream, options)
    replica.gitDirectory = await realpath(await replica.text(workspaceRoot, ['rev-parse', '--absolute-git-dir']))
    await replica.lock(async () => {
      await replica.initialize()
      const retained = join(replica.directory, 'publications.json')
      if (await exists(retained)) {
        await regularFile(retained)
        if ((await lstat(retained)).size > 16 * 1024 * 1024) integrity('Retained publication metadata exceeds its size limit.')
        replica.retainedPublications = [...publications(JSON.parse(await readFile(retained, 'utf8')) as GitPublication[])].map(([path, content]) => ({ path, content }))
      }
      if (options.prepare !== false) {
        await replica.selectUpstream()
        try { await replica.prepare(new Map()) } finally { replica.cycle = undefined }
      }
    })
    return replica
  }

  private lock<T>(action: () => Promise<T>): Promise<T> {
    const work = serialized(this.root, async () => {
      if (this.closed) throw cancelled()
      await mkdir(this.directory, { recursive: true })
      if (await realpath(this.directory) !== this.directory) integrity('The replica state directory may not be redirected through a symbolic link.')
      const recognized = await this.checkOwner(false)
      const file = join(this.gitDirectory, 'taskcontinuum-sync.lock')
      let handle
      try { handle = await open(file, 'wx', 0o600) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!recognized) throw new GitSyncError('busy', 'An existing synchronization lock has no recognized replica owner. Its state was not removed.')
        // Serialize stale-owner recovery too: two reclaimers must not unlink a newly
        // acquired live lock after both observed the same dead process.
        const recoveryPath = join(this.gitDirectory, 'taskcontinuum-sync-recovery.lock')
        const recovery = await open(recoveryPath, 'wx', 0o600).catch(() => {
          throw new GitSyncError('busy', 'Another process is recovering the synchronization lock. Retry or review local state if this persists.')
        })
        try {
          try { handle = await open(file, 'wx', 0o600) } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure
            await regularFile(file)
            const info = await lstat(file)
            if (info.size > 1024) throw new GitSyncError('busy', 'The replica has an invalid synchronization lock. Review local state before retrying.')
            let owner: { pid?: number; host?: string } | null
            try { owner = JSON.parse(await readFile(file, 'utf8')) as typeof owner } catch { throw new GitSyncError('busy', 'Another process owns the replica synchronization lock.') }
            if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || owner.host !== hostname()) throw new GitSyncError('busy', 'Another process owns the replica synchronization lock.')
            try { process.kill(owner.pid!, 0); throw new GitSyncError('busy', 'Another process is synchronizing this upstream.') } catch (failure) {
              if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw new GitSyncError('busy', 'Another process is synchronizing this upstream.')
            }
            await rm(file)
            handle = await open(file, 'wx', 0o600).catch(() => { throw new GitSyncError('busy', 'Another process is synchronizing this upstream.') })
          }
        } finally { await this.releaseLock(recoveryPath, recovery) }
      }
      if (!handle) throw new GitSyncError('busy', 'Another process is synchronizing this upstream.')
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), nonce: randomUUID() }))
        await handle.sync()
        return await action()
      } finally { await this.releaseLock(file, handle) }
    })
    this.pending = work.catch(() => undefined)
    return work
  }

  private async initialize(): Promise<void> {
    const marker = join(this.directory, 'owner.json')
    await this.checkDirectories()
    if (!await this.checkOwner(false)) await writeFile(marker, this.ownerIdentity(), { flag: 'wx', mode: 0o600 })
  }

  private async saveState(name: string, value: unknown): Promise<void> {
    const target = join(this.directory, name)
    const staging = `${target}.${randomUUID()}`
    const handle = await open(staging, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    try { await rename(staging, target) } finally { await rm(staging, { force: true }) }
  }

  private ownerIdentity(): string {
    return JSON.stringify({ version: 2, mode: 'selected-checkout', workspaceRoot: this.workspaceRoot, remote: this.owner.remote, branch: this.owner.branch, fetchUrl: this.owner.fetchUrl, pushUrl: this.owner.pushUrl })
  }

  private async checkOwner(required: boolean): Promise<boolean> {
    const file = join(this.directory, 'owner.json')
    if (!await exists(file)) {
      if (required) integrity('The replica has no recognized ownership marker.')
      return false
    }
    await regularFile(file)
    if ((await lstat(file)).size > 65536 || await readFile(file, 'utf8') !== this.ownerIdentity()) integrity('The replica ownership metadata does not match the selected upstream.')
    return true
  }

  private async releaseLock(file: string, handle: FileHandle): Promise<void> {
    try {
      const held = await handle.stat()
      const current = await lstat(file)
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || held.ino !== current.ino || held.dev !== current.dev) integrity('Synchronization lock ownership changed; the replacement lock was not removed.')
    } finally { await handle.close() }
    await rm(file)
  }

  private async checkDirectories(): Promise<void> {
    for (const directory of [this.root, this.gitDirectory]) {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) integrity('The workspace or its Git metadata must not be redirected through a symbolic link.')
    }
    for (const path of ['.taskcontinuum', '.taskcontinuum/records', '.taskcontinuum/records/v1']) {
      const directory = join(this.root, ...path.split('/'))
      if (await exists(directory)) {
        const info = await lstat(directory)
        if (!info.isDirectory() || info.isSymbolicLink()) integrity('The replica configuration directory must not be a linked path.')
      }
    }
  }

  private async checkManagedPaths(paths: Iterable<string>): Promise<void> {
    const checked = new Set<string>()
    for (const path of paths) {
      const parts = path.split('/')
      let directory = this.root
      for (const part of parts.slice(0, -1)) {
        directory = join(directory, part)
        if (checked.has(directory)) continue
        if (await exists(directory)) {
          const info = await lstat(directory)
          if (!info.isDirectory() || info.isSymbolicLink()) integrity('The replica configuration directory must not be a linked path.')
        }
        checked.add(directory)
      }
      const file = join(this.root, ...parts)
      if (await exists(file)) await regularFile(file)
    }
  }

  private targetRef(target = this.upstream): string {
    const id = createHash('sha256').update(JSON.stringify([target.fetchUrl, target.pushUrl, target.branch])).digest('hex')
    return `${REF_PREFIX}/targets/${id}/accepted`
  }

  private sameUpstream(current: Upstream): boolean {
    const selected = this.cycle
    return !!selected && current.sourceBranch === selected.sourceBranch && current.remote === selected.remote
      && current.branch === selected.branch && current.trackingRef === selected.trackingRef
      && current.fetchUrl === selected.fetchUrl && current.pushUrl === selected.pushUrl
  }

  private checkRepository(current: Upstream): void {
    if (current.fetchUrl !== this.owner.fetchUrl || current.pushUrl !== this.owner.pushUrl) {
      throw new GitSyncError('upstream-changed', 'The upstream fetch or push repository URL changed. Review workspace enrollment before sending configuration to a different repository.')
    }
  }

  private async selectUpstream(signal?: AbortSignal): Promise<void> {
    const current = await this.readUpstream(signal)
    this.checkRepository(current)
    this.upstream = current
    this.cycle = { ...current }
  }

  /** Local availability and repository pinning; only an active cycle pins the branch mapping. */
  async assertUpstream(signal?: AbortSignal): Promise<void> {
    if (this.closed || signal?.aborted) throw cancelled()
    const message = 'The workspace branch or upstream changed during synchronization. Retry to follow the current branch; pending configuration is retained.'
    let current: Upstream
    try { current = await this.readUpstream(signal) } catch (error) {
      if (!this.cycle) throw error
      if (error instanceof GitSyncError && ['cancelled', 'timeout', 'output-limit'].includes(error.code)) throw error
      throw new GitSyncError('upstream-changed', message)
    }
    this.checkRepository(current)
    if (this.cycle && !this.sameUpstream(current)) throw new GitSyncError('upstream-changed', message)
  }

  private async restoreLocal(signal?: AbortSignal): Promise<Map<string, Blob>> {
    const head = await this.ref('HEAD', signal)
    if (!head) throw new GitSyncError('upstream', 'The selected checkout needs an existing commit and tracked upstream.')
    const records = await this.tree(head, signal)
    await this.checkManagedPaths(records.keys())
    return records
  }

  private async ref(name: string, signal?: AbortSignal): Promise<string | undefined> {
    const value = await this.git(this.root, ['rev-parse', '--verify', '--quiet', name], { signal, allowFailure: true })
    if (value.code === 1) return undefined
    if (value.code) throw failure(value, 'reference lookup')
    const oid = value.stdout.toString('utf8').trim()
    if (!OID.test(oid)) integrity('The replica contains an invalid Git reference.')
    return oid
  }

  private async ancestor(before: string, after: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.git(this.root, ['merge-base', '--is-ancestor', before, after], { signal, allowFailure: true })
    if (result.code > 1) throw failure(result, 'ancestry check')
    return result.code === 0
  }

  private async history(revision: string, managedOnly: boolean, signal?: AbortSignal): Promise<void> {
    const args = ['log', '--format=', '--name-status', '-z', '--root', '--no-renames', '--no-ext-diff', '--no-textconv', '--diff-merges=separate', revision, '--']
    if (managedOnly) args.push(DESCRIPTOR, RECORDS)
    const tokens = (await this.git(this.root, args, { signal })).stdout.toString('utf8').split('\0').filter(Boolean)
    for (let index = 0; index < tokens.length; index += 2) {
      if (tokens[index].trim() !== 'A' || !managedPath(tokens[index + 1] ?? '')) integrity('An immutable configuration record was changed or removed in Git history. Synchronization is blocked.')
    }
  }

  private async tree(revision: string, signal?: AbortSignal): Promise<Map<string, Blob>> {
    const listing = (await this.git(this.root, ['ls-tree', '-r', '-z', '-l', '--full-tree', revision, '--', '.taskcontinuum'], { signal })).stdout.toString('utf8')
    const entries: { path: string; oid: string; size: number }[] = []
    for (const row of listing.split('\0').filter(Boolean)) {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\s+(-|\d+)\t(.+)$/.exec(row)
      if (!match) integrity('The upstream configuration tree could not be validated.')
      const [, mode, kind, oid, size, path] = match
      const relevant = path === DESCRIPTOR || path.startsWith(RECORDS) || ['.taskcontinuum', '.taskcontinuum/records', '.taskcontinuum/records/v1'].includes(path)
      if (!relevant) continue
      if (!managedPath(path) || mode !== '100644' || kind !== 'blob' || !OID.test(oid) || Number(size) > MAX_FILE_BYTES) integrity('The upstream contains an invalid, linked, executable, or oversized public configuration file.')
      entries.push({ path, oid, size: Number(size) })
      if (entries.length > MAX_PUBLICATIONS) integrity('The upstream configuration exceeds its record limit.')
    }
    const result = new Map<string, Blob>()
    if (!entries.length) return result
    const data = (await this.git(this.root, ['cat-file', '--batch'], { signal, input: entries.map((entry) => entry.oid).join('\n') + '\n' })).stdout
    let offset = 0
    for (const entry of entries) {
      const end = data.indexOf(10, offset)
      const header = data.subarray(offset, end).toString('ascii')
      if (end < offset || header !== `${entry.oid} blob ${entry.size}` || data[end + 1 + entry.size] !== 10) integrity('The upstream configuration blob could not be read safely.')
      const bytes = data.subarray(end + 1, end + 1 + entry.size)
      const content = bytes.toString('utf8')
      if (!Buffer.from(content, 'utf8').equals(bytes)) integrity('Public configuration must use valid UTF-8.')
      validateContent(entry.path, content)
      result.set(entry.path, { oid: entry.oid, content })
      offset = end + entry.size + 2
    }
    if (offset !== data.length) integrity('The upstream configuration batch contains unexpected bytes.')
    return result
  }

  private async prepare(requested: Map<string, string>, signal?: AbortSignal): Promise<{ head: string; remoteHead: string; records: Map<string, Blob> }> {
    await this.assertUpstream(signal)
    await this.checkOwner(true)
    await this.checkDirectories()
    const before = await this.checkoutSnapshot(signal)
    if (!before.head) throw new GitSyncError('busy', `${before.reason} Synchronization is paused; pending metadata is retained. Commit or move your work and retry.`)
    const previousRecords = await this.restoreLocal(signal)
    const accepted = await this.ref(ACCEPTED_REF, signal)
    const previous = await this.ref('HEAD', signal)
    const targetAccepted = await this.ref(this.targetRef(), signal)
    const fetched = await this.git(this.root, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--', this.upstream.fetchUrl, this.upstreamRef], { signal, allowFailure: true })
    if (fetched.code) {
      if (/couldn't find remote ref|remote ref .* not found/i.test(fetched.stderr.toString('utf8'))) {
        throw new GitSyncError('upstream', 'The selected upstream branch no longer exists. Switch to a branch with an existing remote upstream to resume synchronization; no branch was created.')
      }
      throw failure(fetched, 'fetch')
    }
    const remoteHead = await this.ref('FETCH_HEAD', signal)
    if (!remoteHead) throw new GitSyncError('upstream', 'The selected upstream branch no longer exists.')
    if (targetAccepted && !await this.ancestor(targetAccepted, remoteHead, signal)) integrity('The upstream history was rewritten or rolled back. The accepted configuration frontier for this target was retained.')
    await this.history(targetAccepted ? `${targetAccepted}..${remoteHead}` : remoteHead, true, signal)
    // Never publish user commits merely because their tree is metadata-only.
    // Only the exact commit durably journaled by this engine may be replayed.
    if (previous && !await this.ancestor(previous, remoteHead, signal)) {
      const journalFile = join(this.directory, this.pendingName())
      if (!await exists(journalFile)) throw new GitSyncError('busy', 'The selected checkout has unpublished or diverging user commits. Push or reconcile them yourself; automatic synchronization is paused.')
      await regularFile(journalFile)
      const journal = JSON.parse(await readFile(journalFile, 'utf8')) as { head?: string; base?: string; branch?: string }
      if (journal.head !== previous || journal.branch !== this.upstream.sourceBranch || !journal.base || !OID.test(journal.base)) throw new GitSyncError('busy', 'HEAD is not the recorded pending Task Continuum commit. Reconcile unpublished user commits before retrying.')
      const parents = await this.text(this.root, ['rev-list', '--parents', '-n', '1', previous], signal)
      if (parents !== `${previous} ${journal.base}`) integrity('The pending publication has unexpected ancestry.')
      await this.history(`${journal.base}..${previous}`, false, signal)
      if (!await this.ancestor(journal.base, remoteHead, signal)) integrity('The upstream no longer contains the pending publication base.')
    }
    const remote = await this.tree(remoteHead, signal)
    const pending = new Map<string, string>()
    for (const file of this.retainedPublications) pending.set(file.path, file.content)
    // Keep already accepted records across a switch to another upstream branch.
    const knownRefs = (await this.text(this.root, ['for-each-ref', '--format=%(objectname)', `${REF_PREFIX}/targets`], signal)).split('\n').filter(Boolean)
    for (const oid of knownRefs) {
      for (const [path, blob] of await this.tree(oid, signal)) {
        if (pending.has(path) && pending.get(path) !== blob.content) integrity('Accepted histories contain conflicting immutable records.')
        pending.set(path, blob.content)
      }
    }
    if (previous) {
      for (const [path, blob] of previousRecords) {
        if (pending.has(path) && pending.get(path) !== blob.content) integrity('The checkout conflicts with accepted immutable records.')
        pending.set(path, blob.content)
      }
    }
    for (const [path, content] of requested) {
      if (pending.has(path) && pending.get(path) !== content) integrity('A pending immutable record has different content under the same path.')
      pending.set(path, content)
    }
    this.retainedPublications = [...pending].map(([path, content]) => ({ path, content }))
    await this.saveState('publications.json', this.retainedPublications)
    const additions: GitPublication[] = []
    for (const [path, content] of pending) {
      const existing = remote.get(path)
      if (existing && existing.content !== content) integrity('Two different immutable records use the same path. No text merge or overwrite was attempted.')
      if (!existing) additions.push({ path, content })
    }
    if (!additions.length && remoteHead === previous) {
      await this.assertUpstream(signal)
      await this.verifyCheckout(remoteHead, remote, signal)
      if (accepted !== remoteHead || targetAccepted !== remoteHead) {
        const zero = '0'.repeat(remoteHead.length)
        await this.git(this.root, ['update-ref', '--stdin'], {
          signal,
          input: `start\nupdate ${ACCEPTED_REF} ${remoteHead} ${accepted ?? zero}\nupdate ${this.targetRef()} ${remoteHead} ${targetAccepted ?? zero}\nprepare\ncommit\n`,
        })
      }
      return { head: remoteHead, remoteHead, records: remote }
    }
    let head = remoteHead
    if (additions.length) {
      // Replay only additive app records onto the fetched tree. Git plumbing never invokes
      // checkout filters, merge drivers, hooks, signing tools, or a shell for these commits.
      const index = join(this.directory, `index-${randomUUID()}`)
      const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'Task Continuum', GIT_AUTHOR_EMAIL: 'taskcontinuum@localhost', GIT_COMMITTER_NAME: 'Task Continuum', GIT_COMMITTER_EMAIL: 'taskcontinuum@localhost' }
      try {
        await this.git(this.root, ['read-tree', remoteHead], { signal, env })
        let input = ''
        for (const file of additions) {
          const oid = (await this.git(this.root, ['hash-object', '-w', '--stdin'], { signal, input: file.content })).stdout.toString('utf8').trim()
          if (!OID.test(oid)) integrity('A publication could not be stored as a Git blob.')
          input += `100644 ${oid}\t${file.path}\0`
        }
        await this.git(this.root, ['update-index', '-z', '--index-info'], { signal, input, env })
        const tree = (await this.git(this.root, ['write-tree'], { signal, env })).stdout.toString('utf8').trim()
        if (!OID.test(tree)) integrity('The publication tree could not be validated.')
        const changes = (await this.git(this.root, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--no-renames', remoteHead, tree], { signal })).stdout.toString('utf8').split('\0').filter(Boolean)
        const expected = new Set(additions.map((file) => file.path))
        for (let n = 0; n < changes.length; n += 2) {
          if (changes[n] !== 'A' || !expected.delete(changes[n + 1])) integrity('The proposed Git commit contains a non-publication path or an immutable modification.')
        }
        if (expected.size) integrity('The publication tree is missing a captured record.')
        const reuse = previous && previous !== remoteHead && await this.text(this.root, ['rev-parse', `${previous}^{tree}`], signal) === tree
          && await this.text(this.root, ['rev-list', '--parents', '-n', '1', previous], signal) === `${previous} ${remoteHead}`
        head = reuse ? previous! : (await this.git(this.root, ['commit-tree', tree, '-p', remoteHead, '-m', 'Publish Task Continuum public configuration'], { signal, env })).stdout.toString('utf8').trim()
        if (!OID.test(head)) integrity('The publication commit could not be validated.')
      } finally { await rm(index, { force: true }); await rm(`${index}.lock`, { force: true }) }
    }
    const finalTree = await this.tree(head, signal)
    await this.checkManagedPaths(finalTree.keys())
    const latest = await this.checkoutSnapshot(signal)
    if (!latest.head || latest.head !== before.head || latest.mapping !== before.mapping) throw new GitSyncError('busy', 'The selected checkout changed during synchronization; no user work was reset or stashed.')
    if (head !== previous && await this.usesCheckoutFilter(signal, head)) throw new GitSyncError('busy', 'Incoming files require a configured Git filter. Refresh the checkout explicitly before synchronizing; pending metadata is retained.')
    await this.assertUpstream(signal)
    const headLockPath = join(this.gitDirectory, 'HEAD.lock')
    const headLock = await open(headLockPath, 'wx', 0o600).catch(() => { throw new GitSyncError('busy', 'A user Git operation acquired HEAD. Retry when it has completed.') })
    try {
      await this.assertUpstream(signal)
      if (await this.ref('HEAD', signal) !== previous) throw new GitSyncError('busy', 'HEAD changed before checkout update. User work was retained.')
      if (head !== previous) {
        const incoming = (await this.text(this.root, ['diff-tree', '--no-commit-id', '--name-only', '--diff-filter=A', '-r', '-z', previous!, head], signal)).split('\0').filter(Boolean)
        for (const path of incoming) {
          if (await exists(join(this.root, ...path.split('/')))) throw new GitSyncError('busy', 'An incoming Git path would overwrite a local or ignored file. Move that file and retry synchronization.')
        }
        await this.saveState(this.pendingName(), { head, base: remoteHead, branch: this.upstream.sourceBranch })
        // Two-tree read-tree refuses to overwrite work added since the preflight.
        // It updates this checkout only; Git's real index lock serializes writers.
        const checkout = await this.git(this.root, ['read-tree', '-m', '-u', previous!, head], { signal, allowFailure: true })
        if (checkout.code) throw new GitSyncError('busy', 'Git could not safely update the selected checkout. Preserve/reconcile local changes and retry.')
      }
    } finally { await this.releaseLock(headLockPath, headLock) }
    await this.assertUpstream(signal)
    const zero = '0'.repeat(head.length)
    await this.git(this.root, ['update-ref', '--stdin'], {
      signal,
      input: `start\nupdate ${this.upstream.sourceBranch} ${head} ${previous ?? zero}\nupdate ${ACCEPTED_REF} ${remoteHead} ${accepted ?? zero}\nupdate ${this.targetRef()} ${remoteHead} ${targetAccepted ?? zero}\nprepare\ncommit\n`,
    })
    await this.verifyCheckout(head, finalTree, signal)
    return { head, remoteHead, records: finalTree }
  }

  private pendingName(): string {
    return `pending-${createHash('sha256').update(this.upstream.sourceBranch).digest('hex')}.json`
  }

  private async verifyCheckout(head: string, records: Map<string, Blob>, signal?: AbortSignal): Promise<void> {
    await this.checkDirectories()
    if (await this.ref('HEAD', signal) !== head) integrity('The workspace changed during configuration reconciliation; nothing was published.')
    const snapshot = await this.checkoutSnapshot(signal)
    if (!snapshot.head) throw new GitSyncError('busy', `${snapshot.reason} Pending metadata is retained; nothing was pushed.`)
    for (const [path, blob] of records) {
      const file = join(this.root, ...path.split('/'))
      let parent = dirname(file)
      while (parent !== this.root) {
        const info = await lstat(parent)
        if (!info.isDirectory() || info.isSymbolicLink()) integrity('A workspace configuration directory is linked or invalid.')
        parent = dirname(parent)
      }
      await regularFile(file)
      if (!matchesGitText(await readFile(file), blob.content)) integrity(`Workspace configuration ${path} differs from its committed Git content, beyond LF/CRLF line endings. Synchronization is paused; local files were retained.`)
    }
  }

  async sync(files: readonly GitPublication[] = [], options: GitSyncOptions = {}): Promise<GitSyncResult> {
    const requested = publications(files)
    return this.lock(async () => {
      await this.selectUpstream(options.signal)
      try {
        for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
          if (options.signal?.aborted || this.abort.signal.aborted) throw cancelled()
          const { head, remoteHead, records } = await this.prepare(requested, options.signal)
          await options.onPulled?.(this.root)
          if (options.signal?.aborted || this.abort.signal.aborted) throw cancelled()
          await options.validateReplica?.(this.root)
          if (options.signal?.aborted || this.abort.signal.aborted) throw cancelled()
          await this.assertUpstream(options.signal)
          if (options.onPulled || options.validateReplica) await this.verifyCheckout(head, records, options.signal)
          if (head !== remoteHead) {
            // The commit is additive on remoteHead. Its exact lease also prevents
            // recreating a target deleted after fetch, without permitting a rewrite.
            const result = await this.git(this.root, ['push', '--porcelain', '--no-verify', '--recurse-submodules=no', `--force-with-lease=${this.upstreamRef}:${remoteHead}`, '--', this.upstream.pushUrl, `${head}:${this.upstreamRef}`], { signal: options.signal, allowFailure: true })
            if (result.code) {
              const text = Buffer.concat([result.stdout, result.stderr]).toString('utf8')
              const advertisedRace = /\[rejected\].*\((?:fetch first|non-fast-forward|stale info)\)/i.test(text)
              const receiveRace = /\[remote rejected\]/i.test(text)
                && /cannot lock ref .*: is at [a-f0-9]{40,64} but expected [a-f0-9]{40,64}/i.test(text)
              if (advertisedRace || receiveRace) {
                if (attempt < PUSH_ATTEMPTS) continue
                throw new GitSyncError('push-rejected', 'The upstream advanced during all three publication attempts. Pending records are retained for the next synchronization tick.')
              }
              throw failure(result, 'push')
            }
            await this.git(this.root, ['update-ref', '--stdin'], {
              signal: options.signal,
              input: `start\nupdate ${ACCEPTED_REF} ${head} ${remoteHead}\nupdate ${this.targetRef()} ${head} ${remoteHead}\nprepare\ncommit\n`,
            })
          }
          await rm(join(this.directory, this.pendingName()), { force: true })
          const tracking = await this.ref(this.upstream.trackingRef, options.signal)
          if (tracking && await this.ancestor(tracking, head, options.signal)) await this.git(this.root, ['update-ref', this.upstream.trackingRef, head, tracking], { signal: options.signal, allowFailure: true })
          return { head, publishedPaths: [...requested.keys()], attempts: attempt }
        }
        throw new GitSyncError('push-rejected', 'Publication retry budget exhausted; pending records are retained.')
      } finally { this.cycle = undefined }
    })
  }

  async publishCreatedTask(taskId: string, directory: string, files: readonly string[]): Promise<void> {
    if (!/^T-\d{4}$/.test(taskId) || !directory.split('/').at(-1)?.startsWith(`${taskId}-`)
      || !files.length || files.length > 32 || new Set(files).size !== files.length
      // eslint-disable-next-line no-control-regex -- Reject control bytes in generated Git paths.
      || files.some((file) => !file.startsWith(`${directory}/`) || file.includes('\\') || /[\0-\x1f\x7f]/.test(file)
        || file.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'))) {
      throw new GitSyncError('integrity', 'Only the files generated for this new task may be published.')
    }
    return this.lock(async () => {
      await this.selectUpstream()
      try {
        const allowed = new Set(files)
        const before = await this.checkoutSnapshot(undefined, allowed)
        if (!before.head) throw new GitSyncError('busy', `${before.reason} The new task is local; finish your other Git work before committing and pushing it.`)
        await this.checkManagedPaths(files)
        for (const path of files) await regularFile(join(this.root, ...path.split('/')))
        const tracked = await this.text(this.root, ['ls-tree', '-r', '--name-only', before.head, '--', ...files])
        if (tracked) integrity('A generated task path is already committed. No existing task was published.')
        await this.git(this.root, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--', this.upstream.fetchUrl, this.upstreamRef])
        if (await this.ref('FETCH_HEAD') !== before.head) {
          throw new GitSyncError('busy', 'The local branch and upstream differ. Pull or push your existing commits in terminal Git, then publish this already-created task; do not create it again.')
        }
        await this.assertUpstream()
        const current = await this.checkoutSnapshot(undefined, allowed)
        if (current.head !== before.head || current.mapping !== before.mapping) throw new GitSyncError('busy', 'The workspace changed before task publication. The new task was retained locally.')
        await this.git(this.root, ['add', '--', ...files])
        await this.assertUpstream()
        if (await this.ref('HEAD') !== before.head) throw new GitSyncError('busy', 'HEAD changed before committing the task. Review the staged task files in terminal Git.')
        await this.git(this.root, ['commit', '--only', '--no-verify', '-m', `Create task ${taskId}`, '--', ...files], {
          env: {
            GIT_AUTHOR_NAME: 'Task Continuum', GIT_AUTHOR_EMAIL: 'taskcontinuum@localhost',
            GIT_COMMITTER_NAME: 'Task Continuum', GIT_COMMITTER_EMAIL: 'taskcontinuum@localhost',
          },
        })
        const head = await this.ref('HEAD')
        if (!head || await this.text(this.root, ['rev-list', '--parents', '-n', '1', head]) !== `${head} ${before.head}`) {
          throw new GitSyncError('busy', 'The task commit has unexpected ancestry. Nothing was pushed; review local commits in terminal Git.')
        }
        const changes = (await this.text(this.root, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--no-renames', before.head, head])).split('\0').filter(Boolean)
        const remaining = new Set(files)
        for (let index = 0; index < changes.length; index += 2) {
          if (changes[index] !== 'A' || !remaining.delete(changes[index + 1])) integrity('The task commit contains unexpected changes. Nothing was pushed.')
        }
        if (remaining.size) integrity('The task commit does not contain every generated file. Nothing was pushed.')
        await this.assertUpstream()
        const ready = await this.checkoutSnapshot()
        if (ready.head !== head) throw new GitSyncError('busy', 'The workspace changed after committing the task. The commit is local; review it before pushing.')
        const pushed = await this.git(this.root, ['push', '--porcelain', '--no-verify', '--no-follow-tags', '--recurse-submodules=no',
          `--force-with-lease=${this.upstreamRef}:${before.head}`, '--', this.upstream.pushUrl, `${head}:${this.upstreamRef}`], { allowFailure: true })
        if (pushed.code) throw new GitSyncError('push-rejected', `Task ${taskId} was committed locally (${head.slice(0, 8)}), but the push failed. Check Git authentication, network access and upstream changes, then push the existing commit in terminal Git.`)
        const tracking = await this.ref(this.upstream.trackingRef)
        if (tracking === before.head) await this.git(this.root, ['update-ref', this.upstream.trackingRef, head, tracking])
      } finally { this.cycle = undefined }
    })
  }

  private async usesCheckoutFilter(signal?: AbortSignal, revision?: string): Promise<boolean> {
    const configured = await this.git(this.workspaceRoot, ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'], { signal, allowFailure: true })
    if (configured.code === 1) return false
    if (configured.code) throw failure(configured, 'filter configuration inspection')
    const filters = new Set(configured.stdout.toString('utf8').trim().split(/\r?\n/).map((key) => key.replace(/^filter\./, '').replace(/\.(clean|smudge|process)$/, '')))
    const paths = (await this.git(this.workspaceRoot, revision
      ? ['ls-tree', '-r', '--name-only', '-z', '--full-tree', revision]
      : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { signal })).stdout
    if (!paths.length) return false
    const required = async (cached = false, env?: NodeJS.ProcessEnv) => {
      const result = await this.git(this.workspaceRoot, ['check-attr', '-z', ...(cached ? ['--cached'] : []), '--stdin', 'filter'], { signal, input: paths, env })
      const attributes = result.stdout.toString('utf8').split('\0')
      for (let index = 2; index < attributes.length; index += 3) {
        if (attributes[index] !== 'unspecified' && attributes[index] !== 'unset' && filters.has(attributes[index])) return true
      }
      return false
    }
    if (await required()) return true
    if (!revision) return false
    const index = join(this.directory, `attributes-${randomUUID()}`)
    const env = { GIT_INDEX_FILE: index }
    try {
      await this.git(this.workspaceRoot, ['read-tree', revision], { signal, env })
      return await required(true, env)
    } finally { await rm(index, { force: true }); await rm(`${index}.lock`, { force: true }) }
  }

  private async checkoutSnapshot(signal?: AbortSignal, allowedUntracked?: ReadonlySet<string>): Promise<{ head?: string; mapping?: string; trackingRef?: string; reason?: string }> {
    const current = await this.readUpstream(signal)
    if (!this.sameUpstream(current)) throw new GitSyncError('upstream-changed', 'The workspace branch or upstream changed before checkout refresh. Retry synchronization on the current branch.')
    const gitDirectory = await this.text(this.workspaceRoot, ['rev-parse', '--absolute-git-dir'], signal)
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG', 'BISECT_START', 'index.lock', 'HEAD.lock']) {
      if (await exists(join(gitDirectory, marker))) return { reason: 'A user Git operation is in progress.' }
    }
    if (await this.usesCheckoutFilter(signal)) return { reason: 'Workspace files require a configured Git filter; refresh the checkout explicitly before synchronizing.' }
    const status = await this.text(this.workspaceRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], signal)
    if (status.split('\0').filter(Boolean).some((entry) => !entry.startsWith('?? ') || !allowedUntracked?.has(entry.slice(3)))) {
      return { reason: 'The user checkout has staged, unstaged, or untracked work.' }
    }
    const flags = await this.text(this.root, ['ls-files', '-v', '-z'], signal)
    if (flags.split('\0').some((line) => /^[a-zS]/.test(line))) return { reason: 'The checkout uses assume-unchanged or skip-worktree index entries. Clear them before automatic synchronization.' }
    return { head: await this.text(this.workspaceRoot, ['rev-parse', '--verify', 'HEAD'], signal), mapping: JSON.stringify(current), trackingRef: current.trackingRef }
  }

  async close(): Promise<void> {
    this.closed = true
    this.abort.abort()
    await this.pending
  }
}
