import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { devNull } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { Config } from '../shared/taskDocuments/config'
import { workspaceRepositoryNameLimit } from '../shared/workspace'
import type { CreateWorkspaceRepositoryRequest, WorkspaceDescriptor, WorkspaceRepositoryStatus } from '../shared/workspace'

const nameSchema = z.string().min(1).max(workspaceRepositoryNameLimit)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use a repository name starting with a letter or number, followed by letters, numbers, dots, hyphens or underscores.')
  .refine((name) => !name.endsWith('.') && !name.toLowerCase().endsWith('.git') && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name), 'Choose a name that is not reserved on Windows and does not end in a dot or .git.')
export const workspaceRepositoryIdSchema = z.string().regex(/^[a-f\d]{64}$/)
export const createWorkspaceRepositorySchema = z.object({
  parentPath: z.string().min(1).max(4096).refine((path) => isAbsolute(path) && ![...path].some((character) => character.charCodeAt(0) < 32) && !/^\\\\[?.]\\/.test(path), 'Choose an existing absolute parent folder.'),
  name: nameSchema,
}).strict()
export const publishWorkspaceRepositorySchema = z.object({
  workspaceId: workspaceRepositoryIdSchema,
  private: z.boolean().default(true),
}).strict()

const oidSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/)
const loginSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/)
const identitySchema = z.object({ dev: z.string(), ino: z.string() }).strict()
const publicationSchema = z.object({
  owner: loginSchema,
  private: z.boolean(),
  head: oidSchema,
  repositoryId: z.number().int().positive().optional(),
  url: z.string().optional(),
  published: z.boolean().default(false),
}).strict()
const recordSchema = z.object({
  version: z.literal(1),
  root: z.string(),
  name: nameSchema,
  branch: z.literal('main'),
  git: identitySchema,
  initialHead: oidSchema,
  publication: publicationSchema.optional(),
}).strict()
type RepositoryRecord = z.infer<typeof recordSchema>
type FileIdentity = z.infer<typeof identitySchema>

const githubRepositorySchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  full_name: z.string(),
  html_url: z.string(),
  clone_url: z.string(),
  private: z.boolean(),
  owner: z.object({ login: loginSchema }),
})
type GitHubRepository = z.infer<typeof githubRepositorySchema>

export interface RepositoryCommandOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeout: number
}
export interface RepositoryCommandResult { code: number; stdout: string; stderr: string }
export type RepositoryCommand = (program: 'git' | 'gh', args: string[], options: RepositoryCommandOptions) => Promise<RepositoryCommandResult>

export const executeRepositoryCommand: RepositoryCommand = (program, args, options) => new Promise((resolveCommand, reject) => {
  const child = execFile(program, args, { ...options, encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error ? error.code : 0
    if (typeof code !== 'number') {
      if (code === 'ENOENT') reject(Object.assign(new Error(`Install ${program === 'git' ? 'Git' : 'GitHub CLI (gh)'} and restart Task Continuum.`), { code: 'ENOENT' }))
      else reject(new Error(`${program === 'git' ? 'Git' : 'GitHub CLI'} did not finish within its execution or output limit. Check connectivity and retry; local files are retained.`))
      return
    }
    resolveCommand({ code, stdout: stdout.trim(), stderr: stderr.trim() })
  })
  child.stdin?.end()
})

function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^GIT_|^GH_(?:HOST|REPO|DEBUG|PROMPT_DISABLED)$|^GCM_(?:TRACE.*|INTERACTIVE)$/i.test(key)) delete env[key]
  return {
    ...env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false',
    GCM_INTERACTIVE: 'Never', GH_PROMPT_DISABLED: '1', GH_PAGER: '', PAGER: '',
    LC_ALL: 'C', ...extra,
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function directoryIdentity(path: string): Promise<FileIdentity> {
  const stat = await lstat(path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Repository folders must be ordinary directories, not filesystem links.')
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

async function assertDirectory(path: string, expected: FileIdentity): Promise<void> {
  const actual = await directoryIdentity(path)
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || !samePath(path, await realpath(path))) throw new Error('The repository folder changed during the operation. Nothing else will be published.')
}

function recordPath(root: string): string { return join(root, '.git', 'taskcontinuum-onboarding.json') }

async function readRecord(root: string): Promise<RepositoryRecord | null> {
  const file = recordPath(root)
  if (!await exists(file)) return null
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) throw new Error('The local repository onboarding record is unsafe. Review the repository before publishing with GitHub CLI.')
  const record = recordSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  if (!samePath(record.root, root)) throw new Error('The repository onboarding record belongs to another folder.')
  await assertDirectory(join(root, '.git'), record.git)
  return record
}

async function saveRecord(record: RepositoryRecord, create = false): Promise<void> {
  await assertDirectory(join(record.root, '.git'), record.git)
  const content = JSON.stringify(recordSchema.parse(record), null, 2) + '\n'
  const file = recordPath(record.root)
  if (create) {
    await writeFile(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return
  }
  await readRecord(record.root)
  const staging = `${file}.${randomUUID()}.staging`
  try {
    await writeFile(staging, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await assertDirectory(join(record.root, '.git'), record.git)
    await rename(staging, file)
  } finally { await rm(staging, { force: true }) }
}

function skeleton(name: string, owner: string): Record<string, string> {
  const config = Config.parse({
    schemaVersion: '1.0.0', workspace: name,
    levels: ['epic', 'feature', 'story', 'task', 'subtask'].map((id, rank) => ({ id, rank, title: id[0].toUpperCase() + id.slice(1) })),
    columns: [
      { id: 'backlog', title: 'Backlog', statuses: ['backlog', 'analyzing', 'designing', 'ready'] },
      { id: 'active', title: 'In progress', statuses: ['in-progress', 'in-review', 'blocked'] },
      { id: 'done', title: 'Done', statuses: ['done', 'dropped'] },
    ],
    members: [{ id: 'owner', name: owner.slice(0, 60), kind: 'human' }],
    bridge: { vscodeExtension: { enabled: false, autoInject: false }, sync: { defaultSources: [] } },
  })
  return {
    '.agentdesk/config.json': JSON.stringify(config, null, 2) + '\n',
    'tasks/.gitkeep': '',
    '.gitignore': [
      '/.agentdesk/index.json', '/.agentdesk/jobs/', '/.agentdesk/cache/', '/.agentdesk/logs/',
      '/.taskcontinuum/local/', '/.taskcontinuum/cache/', '/.taskcontinuum/runtime/', '/.taskcontinuum/logs/',
      '/.taskcontinuum/*.local.json', '/.taskcontinuum/*.key', '/.runtime/',
      '.env', '.env.*', '!.env.example', '*.log', '*.local', '*.tmp', '.DS_Store', 'Thumbs.db', '',
    ].join('\n'),
  }
}

function githubUrl(value: string): string {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(value)
  if (!match || !loginSchema.safeParse(match[1]).success || !nameSchema.safeParse(match[2]).success) throw new Error('The remote is not a plain GitHub repository URL. Review its credentials and upstream before publishing.')
  return `https://github.com/${match[1]}/${match[2]}`
}

function checkedGitHubRepository(value: string, owner: string, name: string, isPrivate: boolean): GitHubRepository {
  let json: unknown
  try { json = JSON.parse(value) } catch { throw new Error('GitHub did not return a verifiable repository. No push was attempted; retry after checking GitHub CLI.') }
  const parsed = githubRepositorySchema.safeParse(json)
  if (!parsed.success) throw new Error('GitHub did not return a verifiable repository. No push was attempted; retry after checking GitHub CLI.')
  const repo = parsed.data
  const expected = `${owner}/${name}`.toLowerCase()
  if (repo.full_name.toLowerCase() !== expected || repo.owner.login.toLowerCase() !== owner.toLowerCase() || repo.name.toLowerCase() !== name.toLowerCase()
    || repo.private !== isPrivate || repo.html_url.toLowerCase() !== `https://github.com/${expected}`
    || repo.clone_url.toLowerCase() !== `https://github.com/${expected}.git`) {
    throw new Error('The GitHub repository account, name, URL or visibility changed. No push was attempted; review it before retrying.')
  }
  return repo
}

export class WorkspaceRepositoryService {
  constructor(private readonly run: RepositoryCommand = executeRepositoryCommand) {}

  private async git(root: string, args: string[], options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv; network?: boolean; cwd?: string } = {}): Promise<RepositoryCommandResult> {
    const result = await this.run('git', [
      '--no-pager', '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs',
      '--git-dir', join(root, '.git'), '--work-tree', root,
      '-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true',
      '-c', `core.attributesFile=${devNull}`, '-c', `core.excludesFile=${devNull}`,
      '-c', 'commit.gpgSign=false', '-c', 'user.useConfigOnly=true', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
      ...(options.network ? ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', '-c', 'credential.interactive=false'] : []),
      ...args,
    ], { cwd: options.cwd ?? root, env: environment(options.env), timeout: options.network ? 60000 : 15000 })
    if (result.code !== 0 && !options.allowFailure) throw new Error(`Git ${args[0]} failed. Check repository permissions${options.network ? ', network access and gh auth login' : ' and Git installation'}; local files are retained.`)
    return result
  }

  private async config(root: string, key: string, cwd?: string): Promise<string | null> {
    const result = await this.git(root, ['config', '--get-all', key], { allowFailure: true, cwd })
    if (result.code === 1) return null
    if (result.code !== 0) throw new Error('Git configuration could not be read. Check the configured Git identity and repository permissions.')
    return result.stdout
  }

  async create(value: CreateWorkspaceRepositoryRequest): Promise<string> {
    const request = createWorkspaceRepositorySchema.parse(value)
    let parent: string
    try { parent = await realpath(request.parentPath) } catch {
      throw new Error('The parent folder does not exist or cannot be accessed. Choose an existing absolute folder.')
    }
    const parentIdentity = await directoryIdentity(parent)
    const root = join(parent, request.name)
    if (await exists(root)) throw new Error('A file or folder with this repository name already exists. Choose a different name; nothing was overwritten.')
    const name = await this.config(root, 'user.name', parent)
    const email = await this.config(root, 'user.email', parent)
    if (!name?.trim() || !email?.trim() || [...name + email].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw new Error('Git identity is missing or invalid. Configure user.name and user.email in Git (for example, git config --global user.name "Your Name" and git config --global user.email "you@example.com"), then retry. No repository folder was created.')
    }
    await assertDirectory(parent, parentIdentity)
    if (!samePath(parent, await realpath(request.parentPath))) throw new Error('The selected parent folder changed. Choose the parent folder again.')
    try { await mkdir(root) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A file or folder with this repository name already exists. Nothing was overwritten.')
      throw new Error('The repository folder could not be created. Check the parent folder permissions and repository name.')
    }
    const rootIdentity = await directoryIdentity(root)
    try {
      await assertDirectory(root, rootIdentity)
      await mkdir(join(root, '.git'))
      const gitIdentity = await directoryIdentity(join(root, '.git'))
      await this.git(root, ['init', '--quiet', '--initial-branch=main', '--template='])
      await assertDirectory(join(root, '.git'), gitIdentity)
      await mkdir(join(root, '.agentdesk'))
      await mkdir(join(root, 'tasks'))
      const files = skeleton(request.name, name)
      for (const [path, content] of Object.entries(files)) {
        await assertDirectory(root, rootIdentity)
        await writeFile(join(root, ...path.split('/')), content, { encoding: 'utf8', flag: 'wx' })
      }
      // A private index and an immutable tree keep concurrently staged user files out of the initial commit.
      const index = join(root, '.git', `taskcontinuum-initial-index-${randomUUID()}`)
      const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email }
      let head: string
      try {
        await this.git(root, ['add', '--', ...Object.keys(files)], { env })
        const tree = oidSchema.parse((await this.git(root, ['write-tree'], { env })).stdout)
        head = oidSchema.parse((await this.git(root, ['commit-tree', tree, '-m', 'Initialize task repository'], { env })).stdout)
        await assertDirectory(root, rootIdentity)
        await assertDirectory(join(root, '.git'), gitIdentity)
        await this.git(root, ['update-ref', 'refs/heads/main', head, '0'.repeat(head.length)])
        await link(index, join(root, '.git', 'index'))
      } finally { await rm(index, { force: true }) }
      await saveRecord({ version: 1, root, name: request.name, branch: 'main', git: gitIdentity, initialHead: head }, true)
      return root
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : 'Repository initialization failed.'} The newly created folder was retained at ${root}. Inspect it before retrying with a new name; no existing repository was changed.`)
    }
  }

  private async github(): Promise<WorkspaceRepositoryStatus['github']> {
    const options = { cwd: process.cwd(), env: environment(), timeout: 15000 }
    let version: RepositoryCommandResult
    try { version = await this.run('gh', ['--version'], options) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { installed: false, authenticated: false }
      throw error
    }
    if (version.code !== 0) throw new Error('GitHub CLI could not start. Reinstall gh and restart Task Continuum.')
    const auth = await this.run('gh', ['auth', 'status', '--hostname', 'github.com'], options)
    if (auth.code !== 0) {
      if (/not logged|no accounts|authentication|token.*(?:invalid|expired)|failed to log in|gh auth login/i.test(auth.stdout + auth.stderr)) return { installed: true, authenticated: false }
      throw new Error('GitHub authentication could not be checked. Check your network and run gh auth status or gh auth login.')
    }
    const user = await this.run('gh', ['api', '--hostname', 'github.com', 'user', '--jq', '.login'], options)
    if (user.code !== 0) throw new Error('The current GitHub account could not be verified. Check your network and run gh auth login.')
    const parsed = loginSchema.safeParse(user.stdout)
    if (!parsed.success) throw new Error('GitHub CLI returned an invalid account name. Run gh auth status and retry.')
    return { installed: true, authenticated: true, login: parsed.data }
  }

  private async local(root: string) {
    await directoryIdentity(join(root, '.git'))
    const top = (await this.git(root, ['rev-parse', '--show-toplevel'])).stdout
    if (!samePath(root, top)) throw new Error('This workspace does not have its own Git repository. Parent repositories and linked worktrees cannot be published here.')
    const branch = await this.git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })
    if (branch.code !== 0 && branch.code !== 1) throw new Error('The repository branch could not be read.')
    const head = await this.git(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true })
    if (head.code !== 0 && head.code !== 128 && head.code !== 1) throw new Error('The repository commit could not be read.')
    const remotes = (await this.git(root, ['remote'])).stdout.split(/\r?\n/).filter(Boolean)
    return { branch: branch.code === 0 ? branch.stdout : null, head: head.code === 0 ? oidSchema.parse(head.stdout) : null, remotes }
  }

  async status(workspace: WorkspaceDescriptor): Promise<WorkspaceRepositoryStatus> {
    let branch: string | null = null
    let remoteUrl: string | null = null
    let published = false
    if (await exists(join(workspace.root, '.git'))) {
      const local = await this.local(workspace.root)
      branch = local.branch
      const remote = local.remotes.includes('origin') ? 'origin' : local.remotes.length === 1 ? local.remotes[0] : null
      if (remote) {
        const urls = (await this.git(workspace.root, ['remote', 'get-url', '--all', '--', remote])).stdout
        remoteUrl = githubUrl(urls)
      }
      const record = await readRecord(workspace.root)
      published = !!record?.publication?.published && record.branch === branch && record.publication.url === remoteUrl
      if (!record && remote && branch && remoteUrl) {
        const tracking = await this.git(workspace.root, ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`])
        if (tracking.stdout) {
          const known = await this.git(workspace.root, ['rev-parse', '--verify', tracking.stdout], { allowFailure: true })
          published = known.code === 0
        }
      }
    }
    return { workspaceId: workspace.id, name: workspace.name, branch, remoteUrl, published, github: await this.github() }
  }

  private async assertPublishable(record: RepositoryRecord, head: string): Promise<void> {
    await assertDirectory(join(record.root, '.git'), record.git)
    const local = await this.local(record.root)
    if (local.branch !== record.branch || local.head !== head) throw new Error('The repository branch or commit changed. Switch back to the intended branch and commit before retrying publication.')
    const roots = (await this.git(record.root, ['rev-list', '--max-parents=0', head])).stdout
    if (roots !== record.initialHead) throw new Error('The repository history changed or contains unrelated history. Review it and publish manually with GitHub CLI.')
    if ((await this.git(record.root, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout) throw new Error('The repository has uncommitted files. Review and commit them with Git before publishing; Task Continuum will not stage your files.')
    if (local.remotes.length) {
      if (!record.publication?.repositoryId || local.remotes.length !== 1 || local.remotes[0] !== 'origin' || !record.publication.url) throw new Error('The repository already has a remote or its remote changed. Existing remotes are never overwritten.')
      const expected = `${record.publication.url}.git`
      for (const args of [['remote', 'get-url', '--all', '--', 'origin'], ['remote', 'get-url', '--push', '--all', '--', 'origin']]) {
        if ((await this.git(record.root, args)).stdout !== expected) throw new Error('The repository remote or push URL changed. Restore the intended GitHub remote before retrying.')
      }
      if (await this.config(record.root, 'remote.origin.mirror') || await this.config(record.root, 'remote.origin.push')
        || await this.config(record.root, 'remote.origin.pushurl')
        || await this.config(record.root, 'remote.origin.fetch') !== '+refs/heads/*:refs/remotes/origin/*') {
        throw new Error('The repository remote configuration changed. Review its fetch and push settings before retrying.')
      }
    }
    const upstreamRemote = await this.config(record.root, 'branch.main.remote')
    const upstreamBranch = await this.config(record.root, 'branch.main.merge')
    if ((upstreamRemote !== null || upstreamBranch !== null) && (upstreamRemote !== 'origin' || upstreamBranch !== 'refs/heads/main' || !record.publication?.repositoryId)) {
      throw new Error('The repository upstream changed. Restore the intended main branch upstream before retrying.')
    }
  }

  private async remoteRepository(record: RepositoryRecord): Promise<GitHubRepository | null> {
    const publication = record.publication!
    const result = await this.run('gh', ['api', '--hostname', 'github.com', `repos/${publication.owner}/${record.name}`], { cwd: record.root, env: environment(), timeout: 30000 })
    if (result.code !== 0) {
      if (/HTTP 404\b/.test(result.stderr)) return null
      throw new Error('GitHub repository access failed. Check your network, account and gh auth login; the local repository is intact.')
    }
    return checkedGitHubRepository(result.stdout, publication.owner, record.name, publication.private)
  }

  private async publishedHead(record: RepositoryRecord): Promise<boolean> {
    const result = await this.git(record.root, ['ls-remote', '--refs', 'origin'], { network: true })
    const lines = result.stdout.split(/\r?\n/).filter(Boolean)
    if (lines.length === 0) return false
    if (lines.length !== 1 || lines[0] !== `${record.publication!.head}\trefs/heads/main`) throw new Error('The GitHub repository history changed. No force push will be attempted; review the remote before retrying.')
    return true
  }

  private async confirmRemote(record: RepositoryRecord): Promise<GitHubRepository> {
    const remote = await this.remoteRepository(record)
    if (!remote || remote.id !== record.publication!.repositoryId || remote.html_url !== record.publication!.url) throw new Error('The GitHub repository was removed or replaced. No further push was attempted; review it before retrying.')
    return remote
  }

  async publish(workspace: WorkspaceDescriptor, isPrivate: boolean): Promise<{ url: string }> {
    const record = await readRecord(workspace.root)
    if (!record) throw new Error('Only repositories created by Task Continuum can be published here. Existing repositories are not modified; publish them explicitly with GitHub CLI.')
    if (record.name !== workspace.name) throw new Error('The repository name changed. Review it before publishing with GitHub CLI.')
    const local = await this.local(record.root)
    const head = record.publication?.head ?? local.head
    if (!head) throw new Error('The repository has no initial commit. Configure your Git identity and create a task repository first.')
    await this.assertPublishable(record, head)
    const account = await this.github()
    if (!account.installed) throw new Error('Install GitHub CLI (gh), restart Task Continuum, then run gh auth login before publishing.')
    if (!account.authenticated || !account.login) throw new Error('Sign in with gh auth login, then retry publishing. Local creation does not require GitHub.')
    if (record.publication && (record.publication.owner !== account.login || record.publication.private !== isPrivate)) {
      throw new Error('A previous publish attempt used a different GitHub account or visibility. Retry with that account and visibility; no existing remote will be replaced.')
    }
    const retry = !!record.publication
    record.publication ??= { owner: account.login, private: isPrivate, head, published: false }
    let remote = await this.remoteRepository(record)
    if (record.publication.repositoryId) {
      if (!remote || remote.id !== record.publication.repositoryId || remote.html_url !== record.publication.url) throw new Error('The GitHub repository was removed or replaced. No push was attempted; review it before retrying.')
    } else {
      if (remote) throw new Error(retry
        ? 'A GitHub repository exists, but the previous creation result could not be verified. Inspect it with GitHub CLI before retrying; the local repository is intact.'
        : 'A repository with this name already exists on your GitHub account. It will not be overwritten; choose another local repository name.')
      await this.assertPublishable(record, head)
      await saveRecord(record)
      // gh owns authentication; this creates only the remote, never stages files or changes Git/account configuration.
      const created = await this.run('gh', ['api', '--hostname', 'github.com', 'user/repos', '--method', 'POST', '--raw-field', `name=${record.name}`, '--field', `private=${isPrivate}`], { cwd: record.root, env: environment(), timeout: 60000 })
      if (created.code !== 0) throw new Error('GitHub repository creation failed or could not be confirmed. Check the account, network and gh auth login, then retry; the local repository is intact.')
      remote = checkedGitHubRepository(created.stdout, account.login, record.name, isPrivate)
      record.publication.repositoryId = remote.id
      record.publication.url = remote.html_url
      await saveRecord(record)
    }
    await this.assertPublishable(record, head)
    if ((await this.local(record.root)).remotes.length === 0) await this.git(record.root, ['remote', 'add', 'origin', remote.clone_url])
    await this.confirmRemote(record)
    await this.assertPublishable(record, head)
    if (!await this.publishedHead(record)) {
      await this.assertPublishable(record, head)
      await this.git(record.root, ['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', 'origin', `${head}:refs/heads/main`], { network: true })
      if (!await this.publishedHead(record)) throw new Error('GitHub did not confirm the published main branch. Retry to verify it; the local repository is intact.')
    }
    remote = await this.confirmRemote(record)
    await this.assertPublishable(record, head)
    const tracking = await this.git(record.root, ['rev-parse', '--verify', 'refs/remotes/origin/main'], { allowFailure: true })
    if (tracking.code === 0 && tracking.stdout !== head) throw new Error('The local remote-tracking branch changed. Review it before finishing publication.')
    if (tracking.code !== 0 && tracking.code !== 128 && tracking.code !== 1) throw new Error('The local remote-tracking branch could not be verified.')
    if (tracking.code !== 0) await this.git(record.root, ['update-ref', 'refs/remotes/origin/main', head, '0'.repeat(head.length)])
    await this.git(record.root, ['branch', '--set-upstream-to=origin/main', 'main'])
    await this.assertPublishable(record, head)
    record.publication.published = true
    await saveRecord(record)
    return { url: remote.html_url }
  }
}
