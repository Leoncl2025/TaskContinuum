import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface GitPublication {
  path: string
  content: string
}

export interface GitReplicaOptions {
  workspaceRoot: string
  stateDirectory: string
  /** Reopen this previously owned checkout without relying on the current source branch. */
  cachedRoot?: string
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
  refreshUserCheckout?: boolean
}

export interface GitSyncResult {
  head: string
  publishedPaths: string[]
  attempts: number
  userCheckout: { state: 'refreshed' | 'unchanged' | 'deferred'; reason?: string }
}

export type GitSyncErrorCode = 'upstream' | 'upstream-changed' | 'git' | 'authentication' | 'push-rejected' | 'integrity' | 'busy' | 'timeout' | 'output-limit' | 'cancelled'

export class GitSyncError extends Error {
  constructor(readonly code: GitSyncErrorCode, message: string) {
    super(message)
    this.name = 'GitSyncError'
  }
}

const ACCEPTED_REF = 'refs/taskcontinuum/accepted'
const FRONTIERS_REF = 'refs/taskcontinuum/frontiers-v1'
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

  private constructor(
    private readonly workspaceRoot: string,
    stateDirectory: string,
    private readonly owner: Upstream,
    options: GitReplicaOptions,
  ) {
    const id = createHash('sha256').update(JSON.stringify([workspaceRoot, owner.fetchUrl, owner.pushUrl])).digest('hex')
    this.directory = options.cachedRoot ? dirname(resolve(options.cachedRoot)) : join(stateDirectory, `git-${id}`)
    this.root = join(this.directory, 'replica')
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
    const hooks = join(stateDirectory, 'git-hooks-disabled')
    try { await writeFile(hooks, '', { flag: 'wx', mode: 0o600 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await regularFile(hooks)
    // This is a regular file, not a directory in which a hook executable can appear.
    const probe = new GitReplica(workspaceRoot, stateDirectory, {} as Upstream, options)
    const readOwner = async (cached: string): Promise<Upstream> => {
      if (!isWithin(stateDirectory, cached) || await realpath(cached) !== cached) integrity('The cached replica must remain inside its app-owned state directory.')
      const marker = join(dirname(cached), 'owner.json')
      await regularFile(marker)
      if ((await lstat(marker)).size > 65536) integrity('The cached replica ownership marker exceeds its size limit.')
      let metadata: unknown
      try { metadata = JSON.parse(await readFile(marker, 'utf8')) } catch { integrity('The cached replica has an invalid ownership marker.') }
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) integrity('The cached replica has an invalid ownership marker.')
      const fields = metadata as Record<string, unknown>
      if (fields.version !== 1 || fields.workspaceRoot !== workspaceRoot || typeof fields.remote !== 'string'
        || !/^[A-Za-z0-9._/-]+$/.test(fields.remote) || fields.remote === '.' || fields.remote.startsWith('-')
        || typeof fields.branch !== 'string' || typeof fields.fetchUrl !== 'string' || typeof fields.pushUrl !== 'string') {
        integrity('The cached replica ownership marker does not match this workspace.')
      }
      await probe.git(stateDirectory, ['check-ref-format', `refs/heads/${fields.branch}`])
      const owner = {
        sourceBranch: '', trackingRef: '', remote: fields.remote, branch: fields.branch,
        fetchUrl: remoteUrl(fields.fetchUrl, workspaceRoot), pushUrl: remoteUrl(fields.pushUrl, workspaceRoot),
      }
      const identities = [
        [workspaceRoot, owner.fetchUrl, owner.pushUrl],
        [workspaceRoot, owner.remote, owner.branch, owner.fetchUrl, owner.pushUrl],
      ]
      if (!identities.some((identity) => cached === join(stateDirectory, `git-${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`, 'replica'))) {
        integrity('The cached replica path does not match its ownership marker.')
      }
      return owner
    }
    let upstream: Upstream
    let cachedRoot = options.cachedRoot ? resolve(options.cachedRoot) : undefined
    if (cachedRoot) {
      upstream = await readOwner(cachedRoot)
    } else {
      const top = await probe.text(workspaceRoot, ['rev-parse', '--show-toplevel'])
      if (await realpath(top) !== workspaceRoot) throw new GitSyncError('upstream', 'Select the repository root as the workspace for Git synchronization.')
      upstream = await probe.readUpstream()
      const stable = new GitReplica(workspaceRoot, stateDirectory, upstream, options).root
      const legacyId = createHash('sha256').update(JSON.stringify([workspaceRoot, upstream.remote, upstream.branch, upstream.fetchUrl, upstream.pushUrl])).digest('hex')
      for (const candidate of [stable, join(stateDirectory, `git-${legacyId}`, 'replica')]) {
        if (await exists(join(dirname(candidate), 'owner.json'))) {
          cachedRoot = candidate
          upstream = await readOwner(candidate)
          break
        }
      }
    }
    const replica = new GitReplica(workspaceRoot, stateDirectory, upstream, { ...options, cachedRoot })
    if (cachedRoot && replica.root !== cachedRoot) integrity('The cached replica path does not match its ownership marker.')
    await replica.lock(async () => {
      await replica.initialize()
      if (options.prepare === false) {
        await replica.restoreLocal()
      } else {
        await replica.selectUpstream()
        try { await replica.prepare(new Map()) } finally { replica.cycle = undefined }
      }
    })
    return replica
  }

  private lock<T>(action: () => Promise<T>): Promise<T> {
    const work = serialized(this.directory, async () => {
      if (this.closed) throw cancelled()
      await mkdir(this.directory, { recursive: true })
      if (await realpath(this.directory) !== this.directory) integrity('The replica state directory may not be redirected through a symbolic link.')
      const recognized = await this.checkOwner(false)
      const file = join(this.directory, 'lock.json')
      let handle
      try { handle = await open(file, 'wx', 0o600) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!recognized) throw new GitSyncError('busy', 'An existing synchronization lock has no recognized replica owner. Its state was not removed.')
        // Serialize stale-owner recovery too: two reclaimers must not unlink a newly
        // acquired live lock after both observed the same dead process.
        const recoveryPath = join(this.directory, 'lock-recovery')
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
    if (await this.checkOwner(false)) {
      await this.checkDirectories()
      return
    }
    if (await exists(this.root) && (await readdir(this.root)).length) integrity('The replica destination is not empty or app-owned.')
    const template = join(this.directory, 'empty-template')
    await mkdir(template, { recursive: true })
    if ((await readdir(template)).length) integrity('The replica initialization template must remain empty.')
    const format = await this.text(this.workspaceRoot, ['rev-parse', '--show-object-format'])
    if (!['sha1', 'sha256'].includes(format)) integrity('The upstream uses an unsupported Git object format.')
    await this.git(this.directory, ['init', '--quiet', `--initial-branch=${this.branch}`, `--object-format=${format}`, `--template=${template}`, '--', this.root])
    for (const [key, value] of [
      ['remote.origin.url', this.upstream.fetchUrl], ['remote.origin.pushurl', this.upstream.pushUrl],
      ['core.sparseCheckout', 'true'], ['core.sparseCheckoutCone', 'false'], ['core.longpaths', 'true'],
    ]) await this.git(this.root, ['config', '--local', key, value])
    await mkdir(join(this.root, '.git', 'info'), { recursive: true })
    await writeFile(join(this.root, '.git', 'info', 'sparse-checkout'), `/${DESCRIPTOR}\n/${RECORDS}\n`)
    await writeFile(join(this.root, '.git', 'info', 'attributes'), '* -filter -ident -text -working-tree-encoding -diff -merge\n')
    await writeFile(marker, this.ownerIdentity(), { flag: 'wx', mode: 0o600 })
  }

  private ownerIdentity(): string {
    return JSON.stringify({ version: 1, workspaceRoot: this.workspaceRoot, remote: this.owner.remote, branch: this.owner.branch, fetchUrl: this.owner.fetchUrl, pushUrl: this.owner.pushUrl })
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
    for (const directory of [this.root, join(this.root, '.git'), join(this.root, '.git', 'info')]) {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) integrity('The replica or its Git metadata is linked outside app-owned storage.')
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
    return `refs/taskcontinuum/targets/${id}/accepted`
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
    const accepted = await this.ref(ACCEPTED_REF, signal)
    const head = await this.ref('HEAD', signal)
    if (Boolean(accepted) !== Boolean(head)) integrity('The replica frontier is inconsistent. Pending records were not discarded.')
    if (!head || !accepted) {
      if (await this.ref(FRONTIERS_REF, signal)) integrity('The replica frontier is inconsistent. Pending records were not discarded.')
      if (await this.text(this.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal)) integrity('The uninitialized replica contains unexpected local files.')
      return new Map()
    }
    const frontierVersion = await this.ref(FRONTIERS_REF, signal)
    if (frontierVersion && frontierVersion !== head) integrity('The replica configuration head changed outside synchronization. Pending records were retained.')
    if (!await this.ancestor(accepted, head, signal)) integrity('The replica has unexpected local history; automatic publication is blocked.')
    await this.history(`${accepted}..${head}`, false, signal)
    const records = await this.tree(head, signal)
    await this.checkManagedPaths(records.keys())
    await this.git(this.root, ['read-tree', '-m', '-u', head], { signal })
    await this.verifyCheckout(head, records, signal)
    if (!frontierVersion) {
      // Old caches had one frontier, belonging to their creation target. Migrate it
      // locally before any retargeting; source-branch policy files are obsolete.
      await this.git(this.root, ['update-ref', '--stdin'], {
        signal,
        input: `start\ncreate ${this.targetRef(this.owner)} ${accepted}\ncreate ${FRONTIERS_REF} ${head}\nprepare\ncommit\n`,
      })
    }
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
    const remote = await this.tree(remoteHead, signal)
    const pending = new Map<string, string>()
    if (previous) {
      for (const [path, blob] of previousRecords) pending.set(path, blob.content)
    }
    for (const [path, content] of requested) {
      if (pending.has(path) && pending.get(path) !== content) integrity('A pending immutable record has different content under the same path.')
      pending.set(path, content)
    }
    const additions: GitPublication[] = []
    for (const [path, content] of pending) {
      const existing = remote.get(path)
      if (existing && existing.content !== content) integrity('Two different immutable records use the same path. No text merge or overwrite was attempted.')
      if (!existing) additions.push({ path, content })
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
        head = (await this.git(this.root, ['commit-tree', tree, '-p', remoteHead, '-m', 'Publish Task Continuum public configuration'], { signal, env })).stdout.toString('utf8').trim()
        if (!OID.test(head)) integrity('The publication commit could not be validated.')
      } finally { await rm(index, { force: true }); await rm(`${index}.lock`, { force: true }) }
    }
    const finalTree = await this.tree(head, signal)
    await this.checkManagedPaths(finalTree.keys())
    const zero = '0'.repeat(head.length)
    await this.git(this.root, ['update-ref', '--stdin'], {
      signal,
      input: `start\nupdate HEAD ${head} ${previous ?? zero}\nupdate ${ACCEPTED_REF} ${remoteHead} ${accepted ?? zero}\nupdate ${this.targetRef()} ${remoteHead} ${targetAccepted ?? zero}\nupdate ${FRONTIERS_REF} ${head} ${previous ?? zero}\nprepare\ncommit\n`,
    })
    // Sparse checkout is confined to the app-owned replica, never the user's index.
    await this.git(this.root, ['read-tree', '-m', '-u', head], { signal })
    await this.verifyCheckout(head, finalTree, signal)
    return { head, remoteHead, records: finalTree }
  }

  private async verifyCheckout(head: string, records: Map<string, Blob>, signal?: AbortSignal): Promise<void> {
    await this.checkDirectories()
    if (await this.ref('HEAD', signal) !== head) integrity('The replica changed during configuration reconciliation; nothing was published.')
    if (await this.text(this.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal)) integrity('The replica contains uncommitted or untracked data. Only committed immutable records may be consumed or published.')
    for (const [path, blob] of records) {
      const file = join(this.root, ...path.split('/'))
      let parent = dirname(file)
      while (parent !== this.root) {
        const info = await lstat(parent)
        if (!info.isDirectory() || info.isSymbolicLink()) integrity('A replica configuration directory is linked or invalid.')
        parent = dirname(parent)
      }
      await regularFile(file)
      if (await readFile(file, 'utf8') !== blob.content) integrity('The replica checkout differs from its immutable Git records.')
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
          if (options.onPulled || options.validateReplica) await this.verifyCheckout(head, records, options.signal)
          await this.assertUpstream(options.signal)
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
          if (options.refreshUserCheckout === false) await this.assertUpstream(options.signal)
          const userCheckout = options.refreshUserCheckout === false
            ? { state: 'deferred' as const, reason: 'User checkout refresh was not requested.' }
            : await this.refreshUserCheckout(head, options.signal)
          return { head, publishedPaths: [...requested.keys()], attempts: attempt, userCheckout }
        }
        throw new GitSyncError('push-rejected', 'Publication retry budget exhausted; pending records are retained.')
      } finally { this.cycle = undefined }
    })
  }

  private async checkoutSnapshot(signal?: AbortSignal): Promise<{ head?: string; mapping?: string; trackingRef?: string; reason?: string }> {
    const current = await this.readUpstream(signal)
    if (!this.sameUpstream(current)) throw new GitSyncError('upstream-changed', 'The workspace branch or upstream changed before checkout refresh. Retry synchronization on the current branch.')
    const gitDirectory = await this.text(this.workspaceRoot, ['rev-parse', '--absolute-git-dir'], signal)
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG', 'BISECT_START', 'index.lock', 'HEAD.lock']) {
      if (await exists(join(gitDirectory, marker))) return { reason: 'A user Git operation is in progress.' }
    }
    const status = await this.text(this.workspaceRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], signal)
    if (status) return { reason: 'The user checkout has staged, unstaged, or untracked work.' }
    const filters = await this.git(this.workspaceRoot, ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(smudge|process)$'], { signal, allowFailure: true })
    if (!filters.code && filters.stdout.length) return { reason: 'The user checkout requires a configured checkout helper; refresh it explicitly.' }
    if (filters.code > 1) throw failure(filters, 'configuration inspection')
    return { head: await this.text(this.workspaceRoot, ['rev-parse', '--verify', 'HEAD'], signal), mapping: JSON.stringify(current), trackingRef: current.trackingRef }
  }

  private async refreshUserCheckout(head: string, signal?: AbortSignal): Promise<GitSyncResult['userCheckout']> {
    try {
      const before = await this.checkoutSnapshot(signal)
      if (!before.head) return { state: 'deferred', reason: before.reason }
      if (before.head === head) return { state: 'unchanged' }
      await this.git(this.workspaceRoot, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance', '--no-write-fetch-head', '--', this.root, head], { signal })
      const ancestor = await this.git(this.workspaceRoot, ['merge-base', '--is-ancestor', before.head, head], { signal, allowFailure: true })
      if (ancestor.code === 1) return { state: 'deferred', reason: 'The user checkout has unpublished or diverging commits.' }
      if (ancestor.code) throw failure(ancestor, 'checkout ancestry check')
      const latest = await this.checkoutSnapshot(signal)
      if (!latest.head || latest.head !== before.head || latest.mapping !== before.mapping) return { state: 'deferred', reason: latest.reason ?? 'The user checkout changed during synchronization.' }
      await this.assertUpstream(signal)
      const result = await this.git(this.workspaceRoot, ['-c', 'merge.autostash=false', 'merge', '--ff-only', '--no-edit', '--no-autostash', '--no-overwrite-ignore', head], { signal, allowFailure: true })
      if (result.code) return { state: 'deferred', reason: 'Git could not safely fast-forward the user checkout; its work was not reset, stashed, or rebased.' }
      const tracking = await this.git(this.workspaceRoot, ['rev-parse', '--verify', '--quiet', before.trackingRef!], { signal, allowFailure: true })
      const old = tracking.stdout.toString('utf8').trim()
      if (!tracking.code && OID.test(old)) {
        const forward = await this.git(this.workspaceRoot, ['merge-base', '--is-ancestor', old, head], { signal, allowFailure: true })
        if (!forward.code) await this.git(this.workspaceRoot, ['update-ref', before.trackingRef!, head, old], { signal, allowFailure: true })
      }
      return { state: 'refreshed' }
    } catch (error) {
      if (error instanceof GitSyncError && ['cancelled', 'upstream-changed', 'upstream'].includes(error.code)) throw error
      return { state: 'deferred', reason: 'The user checkout could not be safely refreshed. Replica synchronization succeeded.' }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.abort.abort()
    await this.pending
  }
}
