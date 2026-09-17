import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { devNull } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { Config } from '../shared/taskDocuments/config'
import { workspaceRepositoryNameLimit } from '../shared/workspace'
import type { CreateWorkspaceRepositoryRequest, RepositoryCredentialHelper, WorkspaceDescriptor, WorkspaceRepositoryPushPlan, WorkspaceRepositoryStatus } from '../shared/workspace'

const nameSchema = z.string().min(1).max(workspaceRepositoryNameLimit)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use a repository name starting with a letter or number, followed by letters, numbers, dots, hyphens or underscores.')
  .refine((name) => !name.endsWith('.') && !name.toLowerCase().endsWith('.git') && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name), 'Choose a name that is not reserved on Windows and does not end in a dot or .git.')
export const workspaceRepositoryIdSchema = z.string().regex(/^[a-f\d]{64}$/)
export const createWorkspaceRepositorySchema = z.object({
  parentPath: z.string().min(1).max(4096).refine((path) => isAbsolute(path) && ![...path].some((character) => character.charCodeAt(0) < 32) && !/^\\\\[?.]\\/.test(path), 'Choose an existing absolute parent folder.'),
  name: nameSchema,
}).strict()
export const repositoryPushRequestSchema = z.object({
  workspaceId: workspaceRepositoryIdSchema,
  remoteUrl: z.string().min(1).max(2048).refine((value) => value.trim().length > 0, 'Enter a GitHub repository URL.'),
}).strict()

const oidSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/)
const identitySchema = z.object({ dev: z.string(), ino: z.string() }).strict()
const recordSchema = z.object({
  version: z.literal(1),
  root: z.string(),
  name: nameSchema,
  branch: z.literal('main'),
  git: identitySchema,
  initialHead: oidSchema,
}).strict()
type RepositoryRecord = z.infer<typeof recordSchema>
type FileIdentity = z.infer<typeof identitySchema>

export interface RepositoryCommandOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeout: number
}
export interface RepositoryCommandResult { code: number; stdout: string; stderr: string }
export type RepositoryCommand = (program: 'git', args: string[], options: RepositoryCommandOptions) => Promise<RepositoryCommandResult>

export const executeRepositoryCommand: RepositoryCommand = (program, args, options) => new Promise((resolveCommand, reject) => {
  const child = execFile(program, args, { ...options, encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error ? error.code : 0
    if (typeof code !== 'number') {
      if (code === 'ENOENT') reject(Object.assign(new Error('Install Git and restart Task Continuum.'), { code: 'ENOENT' }))
      else reject(new Error('Git did not finish within its execution or output limit. Check connectivity and retry; local files are retained.'))
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
    ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false',
    GCM_INTERACTIVE: 'Never', PAGER: '',
    LC_ALL: 'C', ...extra,
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
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

async function saveRecord(record: RepositoryRecord): Promise<void> {
  await assertDirectory(join(record.root, '.git'), record.git)
  const content = JSON.stringify(recordSchema.parse(record), null, 2) + '\n'
  const file = recordPath(record.root)
  await writeFile(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
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

function githubUrl(value: string): { repositoryUrl: string; identity: string } {
  const match = /^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9](?:[A-Za-z0-9_-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,104})$/.exec(value)
  const name = match?.[3].replace(/\.git$/, '')
  if (value.length > 2048 || hasControlCharacters(value) || !match || !name || name.length > 100 || /^[-.]/.test(name) || name.endsWith('.') || name.toLowerCase().endsWith('.git')
    || /^(?:settings|new|login|logout|signup|organizations|orgs|users|account|marketplace|features|topics|collections|events|sponsors|security|about|contact|pricing|apps|codespaces|notifications|pulls|issues|explore|search)$/i.test(match[2])) {
    throw new Error('Use a plain GitHub.com HTTPS or SSH repository URL, without credentials, query strings or extra paths. Copy the clone URL from your GitHub repository.')
  }
  const repositoryUrl = `https://github.com/${match[2]}/${name}`
  return { repositoryUrl, identity: `${match[1].startsWith('https:') ? 'https' : 'ssh'}:${repositoryUrl.toLowerCase()}` }
}

type GitConfig = Array<{ key: string; value: string }>

function values(config: GitConfig, key: string): string[] {
  return config.filter((entry) => entry.key === key).map((entry) => entry.value)
}

function credentialHelper(config: GitConfig): RepositoryCredentialHelper {
  const helpers = config.filter(({ key }) => /^credential(?:\..+)?\.helper$/.test(key)).map(({ value }) => value)
  const effective = helpers.slice(helpers.lastIndexOf('') + 1)
  if (!effective.length) return 'none'
  return effective.some(isGcm) ? 'gcm' : 'configured'
}

function isGcm(helper: string): boolean {
  if (/^manager(?:-core)?$/.test(helper)) return true
  const quoted = helper.startsWith('"') && helper.endsWith('"')
  const path = quoted ? helper.slice(1, -1) : helper
  return /^(?:[A-Za-z]:[\\/]|\/)[A-Za-z0-9 _./\\:-]*[\\/]git-credential-manager(?:-core)?(?:\.exe)?$/.test(path)
    && (quoted || !path.includes(' '))
}

function quote(value: string, shell: WorkspaceRepositoryPushPlan['shell']): string {
  return `'${value.replace(/'/g, shell === 'powershell' ? "''" : "'\\''")}'`
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
      '-c', 'protocol.allow=never', '-c', `protocol.https.allow=${options.network ? 'always' : 'never'}`,
      '-c', `protocol.ssh.allow=${options.network ? 'always' : 'never'}`,
      ...(options.network ? ['-c', 'credential.interactive=false', '-c', 'http.followRedirects=false', '-c', `core.sshCommand=ssh -F ${devNull} -o BatchMode=yes -o StrictHostKeyChecking=yes`] : []),
      ...args,
    ], { cwd: options.cwd ?? root, env: environment(options.env), timeout: options.network ? 60000 : 15000 })
    if (result.code !== 0 && !options.allowFailure) throw new Error(options.network
      ? 'Git could not verify GitHub. Check network access and the repository URL, then authenticate in terminal Git with your existing GCM/credential helper (or SSH key). For enterprise managed users, select your EMU account and complete organization SSO. Retry verification after a successful terminal push; local files are retained.'
      : `Git ${args[0]} failed. Check repository permissions and Git installation; local files are retained.`)
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
      await saveRecord({ version: 1, root, name: request.name, branch: 'main', git: gitIdentity, initialHead: head })
      return root
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : 'Repository initialization failed.'} The newly created folder was retained at ${root}. Inspect it before retrying with a new name; no existing repository was changed.`)
    }
  }

  private async configuration(root: string): Promise<GitConfig> {
    const names = (await this.git(root, ['config', '--null', '--list', '--name-only'])).stdout.split('\0').filter(Boolean)
    // Never dump unrelated config values: headers, cookies and proxy URLs can contain credentials.
    const result = await this.git(root, ['config', '--null', '--get-regexp', '^(core\\.bare|remote\\.origin\\.(url|pushurl|mirror)|push\\.mirror|branch\\..*\\.(remote|merge)|credential(\\..+)?\\.helper)$'], { allowFailure: true })
    if (result.code !== 0 && result.code !== 1) throw new Error('Git configuration could not be read. Review repository settings in terminal Git.')
    const selected = result.stdout.split('\0').filter(Boolean).map((entry) => {
      const separator = entry.indexOf('\n')
      return { key: separator < 0 ? entry : entry.slice(0, separator), value: separator < 0 ? '' : entry.slice(separator + 1) }
    })
    return [...names.filter((key) => !selected.some((entry) => entry.key === key)).map((key) => ({ key, value: '' })), ...selected]
  }

  private async local(root: string) {
    if (!isAbsolute(root) || hasControlCharacters(root)) throw new Error('Choose an ordinary absolute repository folder without control characters.')
    const rootIdentity = await directoryIdentity(root)
    await assertDirectory(root, rootIdentity)
    const gitIdentity = await directoryIdentity(join(root, '.git'))
    await assertDirectory(join(root, '.git'), gitIdentity)
    if (await exists(join(root, '.git', 'commondir'))) throw new Error('Linked or shared Git directories require manual terminal Git review.')
    const configFile = await lstat(join(root, '.git', 'config'))
    if (!configFile.isFile() || configFile.isSymbolicLink() || configFile.nlink !== 1) throw new Error('Linked Git configuration requires manual terminal Git review.')
    const config = await this.configuration(root)
    if (config.some(({ key }) => /^url\..*\.(?:insteadof|pushinsteadof)$|^core\.(?:worktree|bare|gitproxy)$|^remote\..*\.(?:vcs|uploadpack|receivepack)$/.test(key)
      && !(key === 'core.bare' && values(config, key).every((value) => value === 'false')))) {
      throw new Error('Unsafe or redirected Git configuration detected. Review URL rewrites, repository paths and remote commands in terminal Git; no configuration was changed.')
    }
    const top = (await this.git(root, ['rev-parse', '--show-toplevel'])).stdout
    if (!samePath(root, top)) throw new Error('This workspace must have its own ordinary Git repository, not a parent repository or linked worktree.')
    const branchResult = await this.git(root, ['symbolic-ref', '--quiet', 'HEAD'], { allowFailure: true })
    if (branchResult.code !== 0 && branchResult.code !== 1) throw new Error('The repository branch could not be read.')
    const branch = branchResult.code === 0 && branchResult.stdout.startsWith('refs/heads/') ? branchResult.stdout.slice(11) : null
    if (branch && ((await this.git(root, ['check-ref-format', `refs/heads/${branch}`], { allowFailure: true })).code !== 0 || hasControlCharacters(branch))) throw new Error('The repository branch is unsafe. Select a valid branch in terminal Git.')
    const headResult = await this.git(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true })
    if (![0, 1, 128].includes(headResult.code)) throw new Error('The repository commit could not be read.')
    const head = headResult.code === 0 ? oidSchema.parse(headResult.stdout) : null
    const origin = values(config, 'remote.origin.url')
    const pushUrls = values(config, 'remote.origin.pushurl')
    if (origin.length > 1 || pushUrls.length > 1 || (!origin.length && config.some(({ key }) => key.startsWith('remote.origin.')))) {
      throw new Error('The origin remote has ambiguous fetch or push URLs. Review origin in terminal Git; existing remotes are never overwritten.')
    }
    let remoteUrl: string | null = null
    if (origin.length) {
      remoteUrl = origin[0]
      const expected = githubUrl(remoteUrl).identity
      const fetch = (await this.git(root, ['remote', 'get-url', '--all', '--', 'origin'])).stdout
      const push = (await this.git(root, ['remote', 'get-url', '--push', '--all', '--', 'origin'])).stdout
      if (githubUrl(fetch).identity !== expected || githubUrl(push).identity !== expected || (pushUrls.length && githubUrl(pushUrls[0]).identity !== expected)) {
        throw new Error('The origin fetch or push URL does not match. Review origin in terminal Git; existing remotes are never overwritten.')
      }
    }
    if (config.some(({ key, value }) => key === 'remote.origin.push' || (key === 'remote.origin.mirror' && value !== 'false') || (key === 'push.mirror' && value !== 'false'))) {
      throw new Error('Custom push refspecs or mirror configuration require manual terminal Git review. No remote was changed.')
    }
    await assertDirectory(root, rootIdentity)
    await assertDirectory(join(root, '.git'), gitIdentity)
    return { branch, head, remoteUrl, config, rootIdentity, gitIdentity }
  }

  async status(workspace: WorkspaceDescriptor): Promise<WorkspaceRepositoryStatus> {
    if (!await exists(join(workspace.root, '.git'))) {
      return { workspaceId: workspace.id, name: workspace.name, branch: null, remoteUrl: null, credentialHelper: 'none' }
    }
    const local = await this.local(workspace.root)
    return { workspaceId: workspace.id, name: workspace.name, branch: local.branch, remoteUrl: local.remoteUrl, credentialHelper: credentialHelper(local.config) }
  }

  creationUrl(workspace: WorkspaceDescriptor): string {
    return `https://github.com/new?name=${encodeURIComponent(workspace.name)}`
  }

  private async ready(workspace: WorkspaceDescriptor, remoteUrl: string) {
    const intended = githubUrl(remoteUrl)
    if (!await exists(join(workspace.root, '.git'))) throw new Error('This workspace has no local Git repository. Initialize and commit it in terminal Git first.')
    const local = await this.local(workspace.root)
    if (!local.branch) throw new Error('The repository has a detached HEAD. Check out the intended branch in terminal Git before continuing.')
    if (!local.head) throw new Error('The repository has no commit. Review and commit files in terminal Git first; Task Continuum will not stage your files.')
    if (local.remoteUrl && githubUrl(local.remoteUrl).identity !== intended.identity) throw new Error('The existing origin does not match the intended GitHub repository. Check the URL in terminal Git; existing remotes are never overwritten.')
    // Listing index entries does not run filters or descend into submodule repositories.
    const entries = (await this.git(workspace.root, ['ls-files', '--stage', '--cached', '--others', '--full-name', '-z'])).stdout.split('\0').filter(Boolean)
    if (entries.some((entry) => entry.startsWith('160000 '))) {
      throw new Error('Repositories with submodules require manual terminal Git review before publication verification.')
    }
    const attributes = entries.some((entry) => /(?:^|[/\t])\.gitattributes$/i.test(entry)) || await exists(join(workspace.root, '.git', 'info', 'attributes'))
    if (attributes && local.config.some(({ key }) => /^filter\..+\.(?:clean|smudge|process|required)$/.test(key))) {
      throw new Error('Configured Git filters require manual terminal Git review. No filters or shell commands were executed.')
    }
    const upstream = values(local.config, `branch.${local.branch}.remote`)
    const merge = values(local.config, `branch.${local.branch}.merge`)
    if ((upstream.length || merge.length) && (upstream.length !== 1 || merge.length !== 1 || upstream[0] !== 'origin' || merge[0] !== `refs/heads/${local.branch}`)) {
      throw new Error('The branch has a different or ambiguous upstream. Review its upstream in terminal Git before preparing a push.')
    }
    if ((await this.git(workspace.root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])).stdout) {
      throw new Error('The repository has uncommitted files. Review and commit them in terminal Git first; Task Continuum will not stage your files.')
    }
    return { ...local, branch: local.branch, head: local.head, intended }
  }

  async preparePush(workspace: WorkspaceDescriptor, remoteUrl: string): Promise<WorkspaceRepositoryPushPlan> {
    const local = await this.ready(workspace, remoteUrl)
    const shell = process.platform === 'win32' ? 'powershell' : 'posix'
    const git = `git -C ${quote(workspace.root, shell)}`
    const push = `${git} push --no-follow-tags --recurse-submodules=no -u -- origin ${quote(`refs/heads/${local.branch}:refs/heads/${local.branch}`, shell)}`
    const add = `${git} remote add -- origin ${quote(remoteUrl, shell)}`
    const commands = local.remoteUrl ? push : shell === 'powershell'
      ? `${add}\nif ($LASTEXITCODE -eq 0) { ${push} }`
      : `${add} &&\n${push}`
    return { workspaceId: workspace.id, branch: local.branch, head: local.head, remoteUrl: local.remoteUrl ?? remoteUrl, repositoryUrl: local.intended.repositoryUrl, shell, commands }
  }

  async verifyPublication(workspace: WorkspaceDescriptor, remoteUrl: string): Promise<{ url: string }> {
    const before = await this.ready(workspace, remoteUrl)
    if (!before.remoteUrl) throw new Error('No origin remote exists yet. Run the reviewed terminal commands to add origin and push, then retry verification.')
    if (before.config.some(({ key, value }) => /^core\.sshcommand$|^ssh\.variant$|^http(?:\..+)?\.(?:extraheader|cookiefile|savecookies|proxy|sslverify)$/.test(key)
      || (/^credential(?:\..+)?\.helper$/.test(key) && value !== '' && !isGcm(value) && !/^(?:cache(?: --timeout=\d+)?|store|osxkeychain|wincred|libsecret)$/.test(value)))) {
      throw new Error('Custom transport or credential commands require manual terminal Git verification. Use standard Git/GCM configuration; Task Continuum will not run arbitrary shell commands.')
    }
    const ref = `refs/heads/${before.branch}`
    // Use the validated URL, not the mutable remote name. A second local snapshot fences concurrent changes.
    const result = await this.git(workspace.root, ['ls-remote', '--refs', '--', before.remoteUrl, ref], { network: true })
    const after = await this.ready(workspace, remoteUrl)
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('The local branch, commit, origin or Git configuration changed during verification. Review it and explicitly retry.')
    const refs = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split('\t'))
    const matches = refs.filter((entry) => entry.length === 2 && entry[1] === ref)
    if (!matches.length) throw new Error('The current branch is not on GitHub yet. Run the reviewed terminal push with your Git/GCM account and complete EMU organization SSO, then retry verification.')
    if (matches.length !== 1 || matches[0][0] !== before.head) throw new Error('The GitHub branch does not match the local commit. Review terminal Git status and push the intended branch, then retry; do not force-push without reviewing remote history.')
    return { url: before.intended.repositoryUrl }
  }
}
