import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute, join, dirname, resolve } from 'node:path'
import { z } from 'zod'
import { GitReplica } from './git'
import type { GitPublication, GitReplicaOptions, GitSyncOptions, GitSyncResult } from './git'
import { readCheckedFile, writeLocalState } from './records'

const execute = promisify(execFile)
const ownerSchema = z.object({
  version: z.literal(1), workspaceRoot: z.string(), sourceBranch: z.string().optional(),
  remote: z.string(), branch: z.string(), trackingRef: z.string().optional(), fetchUrl: z.string(), pushUrl: z.string(),
}).strict()
const branchPolicySchema = z.object({ sourceBranch: z.string().startsWith('refs/heads/'), trackingRef: z.string().startsWith('refs/remotes/') }).strict()
type Owner = z.infer<typeof ownerSchema> & z.infer<typeof branchPolicySchema>
export interface WorkspaceGitOptions extends GitReplicaOptions { prepare?: boolean; cachedRoot?: string }
function normalizedPath(value: string): string { return process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value) }
function normalizedUrl(value: string, root: string): string {
  if (isAbsolute(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(?:[^/\s]+@)?[^/\\\s]+:[^\\\s]+$/.test(value)) return value
  return resolve(root, value)
}

/** Adds a local-only restart path and branch fencing around the isolated Git engine. */
export class WorkspaceGitReplica {
  readonly root: string
  readonly remote: string
  readonly branch: string
  readonly upstreamUrl: string
  private inner?: GitReplica
  private opening?: Promise<GitReplica>
  private closed = false

  private constructor(private readonly options: WorkspaceGitOptions, private readonly owner: Owner, root: string, inner?: GitReplica) {
    this.root = root
    this.remote = owner.remote
    this.branch = owner.branch
    this.upstreamUrl = owner.fetchUrl
    this.inner = inner
  }

  static async open(options: WorkspaceGitOptions): Promise<WorkspaceGitReplica> {
    let inner: GitReplica | undefined
    const root = options.prepare === false ? options.cachedRoot : (inner = await GitReplica.open({ ...options, prepare: false })).root
    if (!root) throw new Error('A cached replica root is required for network-free restoration.')
    const ownerFile = join(dirname(root), 'owner.json')
    const owner = ownerSchema.parse(JSON.parse((await readCheckedFile(options.stateDirectory, ownerFile, 8192)).toString('utf8')))
    if (normalizedPath(owner.workspaceRoot) !== normalizedPath(options.workspaceRoot)) throw new Error('The cached replica belongs to another workspace.')
    let branchPolicy: z.infer<typeof branchPolicySchema> | undefined
    try { branchPolicy = branchPolicySchema.parse(JSON.parse((await readCheckedFile(options.stateDirectory, join(dirname(root), 'workspace-branch.json'), 4096)).toString('utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (!branchPolicy) {
      if (options.prepare === false && (!owner.sourceBranch || !owner.trackingRef)) throw new Error('The cached replica has no reviewed source-branch policy. Reenable it explicitly.')
      const probe = new WorkspaceGitReplica(options, { ...owner, sourceBranch: '', trackingRef: '' }, root, inner)
      const sourceBranch = owner.sourceBranch ?? await probe.local(['symbolic-ref', '--quiet', 'HEAD'])
      const trackingRef = owner.trackingRef ?? await probe.local(['for-each-ref', '--format=%(upstream)', sourceBranch])
      branchPolicy = branchPolicySchema.parse({ sourceBranch, trackingRef })
      await writeLocalState(dirname(root), 'workspace-branch.json', branchPolicy)
    }
    const replica = new WorkspaceGitReplica(options, { ...owner, ...branchPolicy }, root, inner)
    try {
      await replica.assertUpstream()
      if (options.prepare !== false && inner) {
        await inner.sync([], {
          refreshUserCheckout: false,
          validateReplica: async (checkout) => {
            await replica.assertUpstream()
            const heads = (await replica.local(['rev-parse', 'HEAD', 'FETCH_HEAD'], checkout)).split(/\r?\n/)
            if (heads.length !== 2 || heads[0] !== heads[1]) throw new Error('Bootstrap found pending publication commits. Restore the existing enrollment before publishing them.')
          },
        })
      }
      return replica
    } catch (error) { await inner?.close(); throw error }
  }

  private async local(args: string[], cwd = this.options.workspaceRoot): Promise<string> {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|NAMESPACE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|PREFIX)$/i.test(key)) delete env[key]
    const result = await execute('git', [
      '--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false',
      ...args,
    ], { cwd, windowsHide: true, timeout: 10000, maxBuffer: 32768, env: { ...env, GIT_TERMINAL_PROMPT: '0' } })
    return result.stdout.trim()
  }

  async assertUpstream(): Promise<void> {
    if (this.closed) throw new Error('The workspace Git replica is closed.')
    const branch = await this.local(['symbolic-ref', '--quiet', 'HEAD'])
    if (branch !== this.owner.sourceBranch) throw new Error('The workspace branch changed. Switch back or review the enrollment before publishing configuration.')
    const upstream = await this.local(['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)', branch])
    if (upstream !== `${this.owner.remote}\0refs/heads/${this.owner.branch}\0${this.owner.trackingRef}`) throw new Error('The workspace upstream changed. Review the enrollment before publishing configuration.')
    const fetch = await this.local(['remote', 'get-url', '--all', '--', this.owner.remote])
    const push = await this.local(['remote', 'get-url', '--push', '--all', '--', this.owner.remote])
    if (normalizedUrl(fetch, this.options.workspaceRoot) !== this.owner.fetchUrl || normalizedUrl(push, this.options.workspaceRoot) !== this.owner.pushUrl) {
      throw new Error('The workspace remote changed. Review the enrollment before publishing configuration.')
    }
  }

  async sync(files: readonly GitPublication[] = [], options: GitSyncOptions = {}): Promise<GitSyncResult> {
    await this.assertUpstream()
    if (!this.inner) {
      this.opening ??= GitReplica.open({ ...this.options, prepare: false }).finally(() => { this.opening = undefined })
      const inner = await this.opening
      if (inner.root !== this.root || this.closed) { await inner.close(); throw new Error('The restored replica changed or was closed.') }
      this.inner = inner
    }
    return this.inner.sync(files, {
      ...options,
      validateReplica: async (root) => {
        await options.validateReplica?.(root)
        await this.assertUpstream()
      },
    })
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.opening) {
      const result = await Promise.allSettled([this.opening])
      if (result[0].status === 'fulfilled') await result[0].value.close()
    }
    await this.inner?.close()
  }
}
