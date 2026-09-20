// @vitest-environment node
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, lstat, mkdir, readFile, realpath, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitReplica } from '../src/main/remoteConfig/git'
import type { GitPublication } from '../src/main/remoteConfig/git'
import { createRecord, readRecords, recordPath, serializeRecord } from '../src/main/remoteConfig/records'
import { immutableRecordSigner } from './immutable-bindings-fixture'

const execute = promisify(execFile)
const roots: string[] = []
const replicas: GitReplica[] = []
const BRANCH = 'team/remote-configuration'
const DEVICE = '11111111-1111-4111-8111-111111111111'

afterEach(async () => {
  await Promise.all(replicas.splice(0).map((replica) => replica.close()))
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function record(label: string): GitPublication {
  const content = JSON.stringify({ schemaVersion: 1, kind: 'device', label }) + '\n'
  return { path: `.taskcontinuum/records/v1/devices/${DEVICE}/${createHash('sha256').update(content).digest('hex')}.json`, content }
}
async function present(file: string): Promise<boolean> {
  try { await access(file); return true } catch { return false }
}
async function git(root: string, ...args: string[]): Promise<string> {
  const bare = await present(join(root, 'objects')) && await present(join(root, 'HEAD')) ? ['--git-dir', root] : []
  return (await execute('git', ['--no-pager', ...bare, '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true', '-c', 'core.autocrlf=false', ...args], {
    cwd: root, timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost' },
  })).stdout.trim()
}
async function writeRecord(root: string, file: GitPublication): Promise<void> {
  const pieces = file.path.split('/')
  await mkdir(join(root, ...pieces.slice(0, -1)), { recursive: true })
  await writeFile(join(root, ...pieces), file.content)
}
async function fixture(count = 1, workspaceDirectory = '') {
  const root = resolve('.runtime', 'remote-config-git', `case ${randomUUID()}`)
  roots.push(root)
  await mkdir(root, { recursive: true })
  const config = join(root, 'global-config')
  await writeFile(config, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  const remote = join(root, 'remote.git')
  const seed = join(root, 'seed')
  await git(root, 'init', '--bare', '--quiet', `--initial-branch=${BRANCH}`, remote)
  await mkdir(seed)
  await git(seed, 'init', '--quiet', `--initial-branch=${BRANCH}`)
  await writeFile(join(seed, 'README.md'), 'Original task prose.\n')
  if (workspaceDirectory) {
    const configuration = join(seed, ...workspaceDirectory.split('/'), '.agentdesk')
    await mkdir(configuration, { recursive: true })
    await writeFile(join(configuration, 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Nested task workspace' }))
  }
  await git(seed, 'add', '--', '.')
  await git(seed, 'commit', '--quiet', '-m', 'Initial workspace')
  await git(seed, 'remote', 'add', 'upstream', remote)
  await git(seed, 'push', '--quiet', '--set-upstream', 'upstream', BRANCH)
  const clients: string[] = []
  for (let index = 0; index < count; index++) {
    const client = join(root, `client-${index}`)
    await git(root, 'clone', '--quiet', '--origin', 'upstream', '--branch', BRANCH, '--', remote, client)
    clients.push(await realpath(client))
  }
  async function replica(index = 0, prepare = true) {
    const value = await GitReplica.open({ workspaceRoot: join(clients[index], ...workspaceDirectory.split('/')), stateDirectory: join(root, `state-${index}`), prepare })
    replicas.push(value)
    return value
  }
  return { root, remote, seed, clients, replica }
}

describe('single selected checkout Git synchronization', () => {
  it('supports an AgentDesk folder below the repository root without moving its metadata', async () => {
    const folder = 'Project With Spaces [AD]/Planning'
    const setup = await fixture(2, folder)
    const first = await setup.replica(0)
    const second = await setup.replica(1)
    const before = await git(setup.clients[0], 'rev-parse', 'HEAD')
    const file = record('nested-workspace')
    const descriptor = { path: '.taskcontinuum/workspace.json', content: JSON.stringify({ workspaceId: randomUUID() }) + '\n' }
    expect(first.root).toBe(join(setup.clients[0], ...folder.split('/')))
    expect(first.repositoryRoot).toBe(setup.clients[0])
    expect(first.workspaceRelativePath).toBe(folder)
    const pulled = vi.fn(async (root: string) => { expect(root).toBe(first.root) })
    const result = await first.sync([descriptor, file], { onPulled: pulled })
    expect(result.publishedPaths).toEqual([descriptor.path, file.path])
    expect(await git(setup.remote, 'diff', '--name-only', before, BRANCH)).toBe(
      [descriptor.path, file.path].map((path) => `${folder}/${path}`).sort().join('\n'),
    )
    expect(await git(setup.remote, 'show', `${BRANCH}:${folder}/${file.path}`)).toBe(file.content.trim())
    await second.sync()
    expect(await readFile(join(second.root, ...file.path.split('/')), 'utf8')).toBe(file.content)
    expect(await present(join(setup.clients[0], '.taskcontinuum'))).toBe(false)
    expect(await git(setup.clients[0], 'status', '--porcelain')).toBe('')
    expect(await readFile(join(setup.clients[0], 'README.md'), 'utf8')).toBe('Original task prose.\n')
    await first.close()
    const restored = await setup.replica(0, false)
    expect((await restored.sync()).head).toBe(result.head)
  }, 60000)

  it('publishes only the generated task below a nested workspace using a repository-relative remote', async () => {
    const setup = await fixture(1, 'Project')
    const checkout = setup.clients[0]
    await git(checkout, 'remote', 'set-url', 'upstream', '../remote.git')
    const app = await setup.replica()
    const directory = 'tasks/T-0001-nested'
    const files = [`${directory}/task.json`, `${directory}/Plan.md`]
    await mkdir(join(app.root, ...directory.split('/')), { recursive: true })
    await writeFile(join(app.root, ...files[0].split('/')), JSON.stringify({ id: 'T-0001', title: 'Nested task' }))
    await writeFile(join(app.root, ...files[1].split('/')), '# Plan\n')
    const before = await git(checkout, 'rev-parse', 'HEAD')
    await app.publishCreatedTask('T-0001', directory, files)
    expect(await git(setup.remote, 'diff', '--name-only', before, BRANCH)).toBe(files.map((path) => `Project/${path}`).sort().join('\n'))
    expect(await git(checkout, 'status', '--porcelain')).toBe('')
    expect(await present(join(checkout, 'tasks'))).toBe(false)
    expect(await git(checkout, 'remote', 'get-url', 'upstream')).toBe('../remote.git')
  }, 60000)

  it.each(['unstaged', 'staged', 'untracked'] as const)('preserves %s user work outside the selected nested folder', async (mode) => {
    const setup = await fixture(1, 'Project')
    const app = await setup.replica()
    const checkout = setup.clients[0]
    const userFile = join(checkout, mode === 'untracked' ? 'outside.txt' : 'README.md')
    await writeFile(userFile, 'Do not publish or overwrite this user work.\n')
    if (mode === 'staged') await git(checkout, 'add', '--', 'README.md')
    const head = await git(checkout, 'rev-parse', 'HEAD')
    const index = await readFile(join(checkout, '.git', 'index'))
    await expect(app.sync([record('blocked')])).rejects.toMatchObject({ code: 'busy' })
    expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(head)
    expect(await git(setup.remote, 'rev-parse', BRANCH)).toBe(head)
    expect(await readFile(join(checkout, '.git', 'index'))).toEqual(index)
    expect(await readFile(userFile, 'utf8')).toBe('Do not publish or overwrite this user work.\n')
  }, 60000)

  it('protects ignored incoming paths elsewhere in the parent checkout', async () => {
    const setup = await fixture(1, 'Project')
    const app = await setup.replica()
    const checkout = setup.clients[0]
    await writeFile(join(checkout, '.git', 'info', 'exclude'), 'outside.txt\n')
    await writeFile(join(checkout, 'outside.txt'), 'Ignored private local content')
    const head = await git(checkout, 'rev-parse', 'HEAD')
    await writeFile(join(setup.seed, 'outside.txt'), 'Incoming tracked content')
    await git(setup.seed, 'add', '--', 'outside.txt')
    await git(setup.seed, 'commit', '--quiet', '-m', 'Add a file outside the task project')
    await git(setup.seed, 'push', '--quiet')
    await expect(app.sync()).rejects.toMatchObject({ code: 'busy', message: expect.stringContaining('overwrite a local or ignored file') })
    expect(await readFile(join(checkout, 'outside.txt'), 'utf8')).toBe('Ignored private local content')
    expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(head)
  }, 60000)

  it('detects configured checkout filters outside the selected nested folder', async () => {
    const setup = await fixture(1, 'Project')
    const checkout = setup.clients[0]
    await writeFile(join(checkout, '.gitattributes'), 'README.md filter=outside\n')
    await git(checkout, 'add', '.gitattributes')
    await git(checkout, 'commit', '--quiet', '-m', 'Add root attributes')
    await git(checkout, 'push', '--quiet')
    await git(checkout, 'config', 'filter.outside.clean', 'this-filter-must-not-run')
    const app = await setup.replica(0, false)
    await expect(app.sync()).rejects.toMatchObject({ code: 'busy', message: expect.stringContaining('configured Git filter') })
  }, 60000)

  it('keeps private synchronization state outside the entire parent checkout', async () => {
    const setup = await fixture(1, 'Project')
    const stateDirectory = join(setup.clients[0], 'private-state')
    await expect(GitReplica.open({ workspaceRoot: join(setup.clients[0], 'Project'), stateDirectory })).rejects.toMatchObject({
      code: 'git', message: expect.stringContaining('outside the user checkout'),
    })
    expect(await present(stateDirectory)).toBe(false)
  }, 60000)

  it('stops if the selected folder becomes a different Git repository after enrollment', async () => {
    const setup = await fixture(1, 'Project')
    const app = await setup.replica()
    const head = await git(setup.clients[0], 'rev-parse', 'HEAD')
    await git(app.root, 'init', '--quiet', '--initial-branch=other')
    await expect(app.sync([record('wrong-repository')])).rejects.toMatchObject({ code: 'upstream-changed' })
    expect(await git(setup.remote, 'rev-parse', BRANCH)).toBe(head)
    expect(await git(setup.clients[0], 'rev-parse', 'HEAD')).toBe(head)
  }, 60000)

  it('rejects an upstream symbolic-link replacement of the selected folder before changing the checkout', async () => {
    const setup = await fixture(1, 'Project')
    const app = await setup.replica()
    const head = await git(setup.clients[0], 'rev-parse', 'HEAD')
    const configuration = await readFile(join(app.root, '.agentdesk', 'config.json'), 'utf8')
    const target = join(setup.root, 'link-target.txt')
    await writeFile(target, '../outside-project')
    const oid = await git(setup.seed, 'hash-object', '-w', target)
    await git(setup.seed, 'rm', '-r', '--cached', '--', 'Project')
    await git(setup.seed, 'update-index', '--add', '--cacheinfo', `120000,${oid},Project`)
    await git(setup.seed, 'commit', '--quiet', '-m', 'Replace project tree with a link')
    await git(setup.seed, 'push', '--quiet')
    await expect(app.sync()).rejects.toMatchObject({ code: 'integrity', message: expect.stringContaining('not a symbolic link or submodule') })
    expect(await git(setup.clients[0], 'rev-parse', 'HEAD')).toBe(head)
    expect(await readFile(join(app.root, '.agentdesk', 'config.json'), 'utf8')).toBe(configuration)
  }, 60000)

  it('supports a nested workspace in a linked Git worktree with a .git file', async () => {
    const setup = await fixture(0, 'Project')
    const checkout = join(setup.root, 'linked-checkout')
    await git(setup.seed, 'worktree', 'add', '--quiet', '-b', 'nested-worktree', checkout)
    await git(checkout, 'branch', '--set-upstream-to', `upstream/${BRANCH}`)
    expect((await lstat(join(checkout, '.git'))).isFile()).toBe(true)
    const app = await GitReplica.open({ workspaceRoot: join(checkout, 'Project'), stateDirectory: join(setup.root, 'linked-state') })
    replicas.push(app)
    const file = record('linked-worktree')
    await app.sync([file])
    expect(await git(setup.remote, 'show', `${BRANCH}:Project/${file.path}`)).toBe(file.content.trim())
    expect(await readFile(join(app.root, ...file.path.split('/')), 'utf8')).toBe(file.content)
  }, 60000)

  it('serializes sibling workspaces and validates each folder independently', async () => {
    const setup = await fixture(1, 'Project')
    const checkout = setup.clients[0]
    const sibling = join(checkout, 'AnotherProject')
    await mkdir(join(sibling, '.agentdesk'), { recursive: true })
    await writeFile(join(sibling, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Another workspace' }))
    await git(checkout, 'add', '--', 'AnotherProject')
    await git(checkout, 'commit', '--quiet', '-m', 'Add a second task workspace')
    await git(checkout, 'push', '--quiet')
    const first = await setup.replica()
    const second = await GitReplica.open({ workspaceRoot: sibling, stateDirectory: join(setup.root, 'sibling-state') })
    replicas.push(second)
    const firstFile = record('first-workspace'), secondFile = record('second-workspace')
    await Promise.all([first.sync([firstFile]), second.sync([secondFile])])
    expect(await present(join(first.root, ...secondFile.path.split('/')))).toBe(false)
    expect(await present(join(second.root, ...firstFile.path.split('/')))).toBe(false)
    await writeRecord(first.root, { ...firstFile, content: '{"label":"modified immutable record"}' })
    await git(checkout, 'add', '--', `Project/${firstFile.path}`)
    await git(checkout, 'commit', '--quiet', '-m', 'Modify only the first workspace metadata')
    await git(checkout, 'push', '--quiet')
    await second.sync()
    await expect(first.sync()).rejects.toMatchObject({ code: 'integrity' })
  }, 60000)

  it.each(['autocrlf', 'attributes'] as const)('preserves signed records when Git materializes CRLF via %s', async (mode) => {
    const setup = await fixture()
    const root = setup.clients[0]
    await git(root, 'config', 'core.autocrlf', mode === 'autocrlf' ? 'true' : 'false')
    if (mode === 'attributes') {
      await writeFile(join(setup.seed, '.gitattributes'), '*.json text eol=crlf\n')
      await git(setup.seed, 'add', '.gitattributes')
      await git(setup.seed, 'commit', '--quiet', '-m', 'Use Windows JSON line endings')
      await git(setup.seed, 'push', '--quiet')
    }
    const author = immutableRecordSigner(7)
    const workspaceId = randomUUID()
    const signed = await createRecord({
      kind: 'setting', workspaceId, actor: author.actor,
      payload: { action: 'set', scope: 'workspace', settingKey: 'autoLink', value: false },
    }, author.sign)
    const file = { path: recordPath(signed).split(sep).join('/'), content: serializeRecord(signed) }
    const descriptor = { path: '.taskcontinuum/workspace.json', content: JSON.stringify({ workspaceId }, null, 2) + '\n' }
    const app = await setup.replica()
    const prose = await readFile(join(root, 'README.md'))
    const validation = async (checkout: string) => {
      expect(await readRecords(checkout, {
        workspaceId, trustedKey: new Map([[author.actor.deviceId, author.publicKey]]), authorize: () => true,
      })).toEqual([signed])
    }
    await app.sync([descriptor, file], { validateReplica: validation })
    const bytes = await readFile(join(root, ...file.path.split('/')), 'utf8')
    expect(bytes).toBe(file.content.replace(/\n/g, '\r\n'))
    expect(await git(setup.remote, 'show', `${BRANCH}:${file.path}`)).toBe(file.content.trim())
    await app.close()
    const restored = await setup.replica(0, false)
    await restored.sync([descriptor, file], { validateReplica: validation })
    expect(await readFile(join(root, ...file.path.split('/')), 'utf8')).toBe(bytes)
    expect(await readFile(join(root, 'README.md'))).toEqual(prose)
    expect(await git(root, 'config', '--local', '--get', 'core.autocrlf')).toBe(mode === 'autocrlf' ? 'true' : 'false')
    expect(await git(root, '-c', `core.autocrlf=${mode === 'autocrlf'}`, 'status', '--porcelain')).toBe('')
  }, 60000)

  it('uses the canonical selected root and creates no clone, worktree, or AD copy', async () => {
    const setup = await fixture()
    const app = await setup.replica()
    expect(app.root).toBe(setup.clients[0])
    expect(app.remote).toBe('upstream')
    expect(app.upstreamRef).toBe(`refs/heads/${BRANCH}`)
    const before = await git(app.root, 'rev-parse', 'HEAD')
    const file = record('only-publication')
    const result = await app.sync([file])
    expect(await git(app.root, 'status', '--porcelain')).toBe('')
    expect(await git(app.root, 'rev-parse', 'HEAD')).toBe(result.head)
    expect(await git(app.root, 'rev-parse', '@{upstream}')).toBe(result.head)
    expect(await git(setup.remote, 'diff', '--name-only', before, BRANCH)).toBe(file.path)
    expect(await readFile(join(app.root, 'README.md'), 'utf8')).toBe('Original task prose.\n')
    const all = await readdir(join(setup.root, 'state-0'), { recursive: true })
    expect(all.some((path) => /replica|README|\.git$/.test(path))).toBe(false)
    expect((await git(app.root, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(1)
    expect((await app.sync([file])).head).toBe(result.head)
  }, 60000)

  it('opens offline and detached without moving HEAD or touching dirty user files', async () => {
    const setup = await fixture()
    const app = await setup.replica()
    const file = record('offline')
    await app.sync([file])
    await app.close()
    await git(app.root, 'switch', '--quiet', '--detach')
    await writeFile(join(app.root, 'README.md'), 'Unstaged user work')
    await rename(setup.remote, `${setup.remote}-offline`)
    const reopened = await GitReplica.open({ workspaceRoot: app.root, stateDirectory: join(setup.root, 'state-0'), prepare: false })
    replicas.push(reopened)
    expect(reopened.root).toBe(app.root)
    expect(await readFile(join(app.root, 'README.md'), 'utf8')).toBe('Unstaged user work')
    expect(await readFile(join(app.root, ...file.path.split('/')), 'utf8')).toBe(file.content)
    await expect(reopened.sync()).rejects.toMatchObject({ code: 'upstream' })
  }, 60000)

  it.each(['unstaged', 'staged', 'untracked', 'metadata', 'merge', 'rebase', 'cherry-pick', 'index-lock', 'assume-unchanged'] as const)(
    'pauses on %s work without staging, stashing, resetting, committing, or pushing it', async (kind) => {
      const setup = await fixture()
      const app = await setup.replica()
      const before = await git(app.root, 'rev-parse', 'HEAD')
      if (kind === 'unstaged' || kind === 'staged' || kind === 'assume-unchanged') {
        await writeFile(join(app.root, 'README.md'), 'Private task edits')
        if (kind === 'staged') await git(app.root, 'add', 'README.md')
        if (kind === 'assume-unchanged') await git(app.root, 'update-index', '--assume-unchanged', 'README.md')
      } else if (kind === 'untracked') await writeFile(join(app.root, 'private.txt'), 'Private')
      else if (kind === 'metadata') await writeRecord(app.root, record('not-in-outbox'))
      else if (kind === 'rebase') await mkdir(join(app.root, '.git', 'rebase-merge'))
      else await writeFile(join(app.root, '.git', kind === 'merge' ? 'MERGE_HEAD' : kind === 'cherry-pick' ? 'CHERRY_PICK_HEAD' : 'index.lock'), before)
      const status = await git(app.root, 'status', '--porcelain')
      await expect(app.sync([record('deferred')])).rejects.toMatchObject({ code: 'busy' })
      expect(await git(app.root, 'status', '--porcelain')).toBe(status)
      expect(await git(app.root, 'rev-parse', 'HEAD')).toBe(before)
      expect(await git(setup.remote, 'rev-parse', BRANCH)).toBe(before)
      expect(await git(app.root, 'stash', 'list')).toBe('')
    }, 60000,
  )

  it('does not publish any user ahead commit, including an additive metadata-only commit', async () => {
    const setup = await fixture()
    const app = await setup.replica()
    const remoteBefore = await git(setup.remote, 'rev-parse', BRANCH)
    await writeRecord(app.root, record('user-committed-not-app-owned'))
    await git(app.root, 'add', '.taskcontinuum')
    await git(app.root, 'commit', '--quiet', '-m', 'Publish Task Continuum public configuration')
    const userHead = await git(app.root, 'rev-parse', 'HEAD')
    await expect(app.sync([record('queued')])).rejects.toMatchObject({ code: 'busy' })
    expect(await git(app.root, 'rev-parse', 'HEAD')).toBe(userHead)
    expect(await git(setup.remote, 'rev-parse', BRANCH)).toBe(remoteBefore)
  }, 60000)

  it('retries real push races and converges without publishing unrelated commits', async () => {
    const setup = await fixture(2)
    const a = await setup.replica(0)
    const b = await setup.replica(1)
    const first = record('first')
    const second = record('racing')
    let raced = false
    const result = await a.sync([first], { validateReplica: async () => {
      if (!raced) { raced = true; await b.sync([second]) }
    } })
    expect(result.attempts).toBe(2)
    await b.sync()
    for (const app of [a, b]) {
      for (const file of [first, second]) expect(await readFile(join(app.root, ...file.path.split('/')), 'utf8')).toBe(file.content)
      expect(await git(app.root, 'status', '--porcelain')).toBe('')
    }
  }, 120000)

  it('bounds push races and retries a durably journaled app commit after restart', async () => {
    const setup = await fixture(2)
    const a = await setup.replica(0)
    const b = await setup.replica(1)
    let races = 0
    const pending = record('pending-restart')
    await expect(a.sync([pending], { validateReplica: async () => { await b.sync([record(`race-${++races}`)]) } })).rejects.toMatchObject({ code: 'push-rejected' })
    expect(races).toBe(3)
    await a.close()
    const reopened = await setup.replica(0, false)
    await reopened.sync()
    expect(await git(setup.remote, 'show', `${BRANCH}:${pending.path}`)).toBe(pending.content.trim())
  }, 180000)

  it('recovers a pending publication after offline push without reauthoring signed records', async () => {
    const setup = await fixture()
    const app = await setup.replica()
    const file = record('offline-push')
    await expect(app.sync([file], { validateReplica: async () => { await rename(setup.remote, `${setup.remote}-offline`) } })).rejects.toMatchObject({ code: 'git' })
    const pendingHead = await git(app.root, 'rev-parse', 'HEAD')
    await app.close()
    await rename(`${setup.remote}-offline`, setup.remote)
    const reopened = await setup.replica(0, false)
    await reopened.sync()
    expect(await git(setup.remote, 'show', `${BRANCH}:${file.path}`)).toBe(file.content.trim())
    expect(await git(setup.remote, 'rev-parse', BRANCH)).toBe(pendingHead)
  }, 90000)

  it.each(['modify', 'remove', 'reverted-modification'] as const)('retains immutable history rejection for %s', async (kind) => {
    const setup = await fixture()
    const app = await setup.replica()
    const file = record('immutable')
    await app.sync([file])
    await git(setup.seed, 'pull', '--quiet', '--ff-only')
    if (kind === 'remove') await git(setup.seed, 'rm', '--quiet', file.path)
    else { await writeRecord(setup.seed, { ...file, content: '{"changed":true}\n' }); await git(setup.seed, 'add', file.path) }
    await git(setup.seed, 'commit', '--quiet', '-m', 'Tampering')
    if (kind === 'reverted-modification') { await writeRecord(setup.seed, file); await git(setup.seed, 'commit', '--quiet', '-am', 'Revert tampering') }
    await git(setup.seed, 'push', '--quiet')
    await expect(app.sync()).rejects.toMatchObject({ code: 'integrity' })
    expect(await readFile(join(app.root, ...file.path.split('/')), 'utf8')).toBe(file.content)
  }, 60000)

  it('fences rollback independently on every previously accepted target across restart', async () => {
    const setup = await fixture()
    const app = await setup.replica()
    const original = await git(app.root, 'rev-parse', 'HEAD')
    const feature = await app.sync([record('feature-accepted')])
    await git(setup.seed, 'switch', '--quiet', '-c', 'main')
    await writeFile(join(setup.seed, 'README.md'), 'Main prose')
    await git(setup.seed, 'commit', '--quiet', '-am', 'Main changes')
    await git(setup.seed, 'push', '--quiet', '-u', 'upstream', 'main')
    const mainOriginal = await git(setup.seed, 'rev-parse', 'HEAD')
    await git(app.root, 'fetch', '--quiet', 'upstream')
    await git(app.root, 'switch', '--quiet', '-c', 'main', '--track', 'upstream/main')
    const main = await app.sync([record('main-accepted')])
    await app.close()
    await git(app.root, 'switch', '--quiet', BRANCH)
    const reopened = await setup.replica(0, false)
    await git(setup.remote, 'update-ref', `refs/heads/${BRANCH}`, original)
    await expect(reopened.sync()).rejects.toMatchObject({ code: 'integrity' })
    await git(setup.remote, 'update-ref', `refs/heads/${BRANCH}`, feature.head)
    await reopened.sync()
    expect(await git(app.root, 'show', `HEAD:${record('main-accepted').path}`)).toBe(record('main-accepted').content.trim())
    expect(await git(setup.remote, 'rev-parse', 'main')).toBe(main.head)
    await git(app.root, 'switch', '--quiet', 'main')
    await git(setup.remote, 'update-ref', 'refs/heads/main', mainOriginal)
    await expect(reopened.sync()).rejects.toMatchObject({ code: 'integrity' })
    await git(setup.remote, 'update-ref', 'refs/heads/main', main.head)
    await reopened.sync()
  }, 120000)

  it.each(['branch', 'same-target branch', 'detached HEAD', 'upstream', 'URL'] as const)('fences asynchronous %s changes before publication', async (kind) => {
    const setup = await fixture()
    const app = await setup.replica()
    const before = await git(setup.remote, 'rev-parse', BRANCH)
    await expect(app.sync([record('fenced')], { onPulled: async () => {
      if (kind === 'branch') await git(app.root, 'switch', '--quiet', '-c', 'during-validation')
      else if (kind === 'same-target branch') await git(app.root, 'switch', '--quiet', '-c', 'during-validation', '--track', `upstream/${BRANCH}`)
      else if (kind === 'detached HEAD') await git(app.root, 'switch', '--quiet', '--detach')
      else if (kind === 'upstream') await git(app.root, 'branch', '--unset-upstream')
      else await git(app.root, 'remote', 'set-url', 'upstream', join(setup.root, 'other.git'))
    } })).rejects.toMatchObject({ code: 'upstream-changed' })
    expect(await git(setup.remote, 'rev-parse', BRANCH)).toBe(before)
  }, 60000)

  it('rejects unsafe publications and immutable collisions without leaking secrets', async () => {
    const setup = await fixture()
    const app = await setup.replica()
    const file = record('existing')
    const descriptor = { path: '.taskcontinuum/workspace.json', content: JSON.stringify({ workspaceId: DEVICE }) }
    await app.sync([descriptor, file])
    for (const bad of [
      { path: 'README.md', content: '{}' }, { path: '../outside.json', content: '{}' },
      { path: '.taskcontinuum\\records\\v1\\bad.json', content: '{}' },
      { ...descriptor, content: JSON.stringify({ workspaceId: randomUUID() }) },
      { ...file, content: '{' }, { ...file, content: '{"token":"secret-not-for-errors"}' },
      { ...file, content: '{"privateKey":"secret-not-for-errors"}' },
      { ...file, content: JSON.stringify({ url: 'https://username:secret-not-for-errors@example.invalid/repo' }) },
      { ...file, content: '{"command":"execute-me"}' }, { ...file, content: '{"changed":true}' },
    ]) {
      await expect(app.sync([bad])).rejects.toSatisfy((error: unknown) => error instanceof Error
        && 'code' in error && error.code === 'integrity'
        && !error.message.includes('secret-not-for-errors') && !error.message.includes('execute-me'))
    }
    expect(await readFile(join(app.root, ...file.path.split('/')), 'utf8')).toBe(file.content)
  }, 60000)

  it.each(['fetch', 'push'] as const)('pins the %s repository URL across an offline reopen', async (direction) => {
    const setup = await fixture()
    const app = await setup.replica()
    const file = record('never-send-to-unreviewed-remote')
    await app.sync([file])
    const before = await git(setup.remote, 'rev-parse', BRANCH)
    const other = join(setup.root, 'unreviewed.git')
    await git(setup.root, 'init', '--quiet', '--bare', other)
    await git(app.root, 'remote', 'set-url', ...(direction === 'push' ? ['--push'] : []), 'upstream', other)
    await expect(app.assertUpstream()).rejects.toMatchObject({ code: 'upstream-changed' })
    await app.close()
    const restored = await GitReplica.open({ workspaceRoot: app.root, stateDirectory: join(setup.root, 'state-0'), prepare: false })
    replicas.push(restored)
    expect(await readFile(join(restored.root, ...file.path.split('/')), 'utf8')).toBe(file.content)
    await expect(restored.sync([record('blocked')])).rejects.toMatchObject({ code: 'upstream-changed' })
    expect(await git(other, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('')
    expect(await git(setup.remote, 'rev-parse', BRANCH)).toBe(before)
  }, 60000)

  it('retains an unpublished app record after switching to a different tracked target', async () => {
    const setup = await fixture()
    const app = await setup.replica()
    const before = await git(setup.remote, 'rev-parse', BRANCH)
    const file = record('pending-across-branch-switch')
    await expect(app.sync([file], { validateReplica: async () => { throw new Error('Validation interrupted') } })).rejects.toThrow('Validation interrupted')
    await git(setup.seed, 'switch', '--quiet', '-c', 'main')
    await git(setup.seed, 'push', '--quiet', '-u', 'upstream', 'main')
    await git(app.root, 'fetch', '--quiet', 'upstream')
    await git(app.root, 'switch', '--quiet', '-c', 'main', '--track', 'upstream/main')
    await app.close()
    const restored = await setup.replica(0, false)
    await restored.sync()
    expect(await git(setup.remote, 'show', `main:${file.path}`)).toBe(file.content.trim())
    expect(await git(setup.remote, 'rev-parse', BRANCH)).toBe(before)
  }, 90000)

  it('does not recreate a remote branch deleted between fetch and push', async () => {
    const setup = await fixture()
    const app = await setup.replica()
    await expect(app.sync([record('deleted-during-validation')], { onPulled: async () => {
      await git(setup.remote, 'update-ref', '-d', `refs/heads/${BRANCH}`)
    } })).rejects.toMatchObject({ code: 'upstream' })
    expect(await git(setup.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('')
  }, 60000)

  it('ignores unused filter configuration but pauses when checkout paths use it', async () => {
    const setup = await fixture()
    const app = await setup.replica()
    for (const hook of ['pre-commit', 'post-commit', 'pre-push', 'post-checkout', 'post-merge']) await writeFile(join(app.root, '.git', 'hooks', hook), '#!/bin/sh\nprintf invoked > hook-invoked.txt\nexit 73\n', { mode: 0o755 })
    await git(app.root, 'config', 'filter.untrusted.smudge', 'invalid-taskcon-fixture-command')
    await git(app.root, 'config', 'filter.untrusted.required', 'true')
    await app.sync([record('unused-filter-allowed')])
    await writeFile(join(app.root, '.git', 'info', 'attributes'), '*.json filter=untrusted\n')
    await expect(app.sync([record('filter-paused')])).rejects.toThrow('Workspace files require a configured Git filter')
    await rm(join(app.root, '.git', 'info', 'attributes'))
    await app.sync([record('hooks-disabled')])
    expect(await git(app.root, 'config', '--get', 'filter.untrusted.smudge')).toBe('invalid-taskcon-fixture-command')
    expect(await present(join(app.root, 'hook-invoked.txt'))).toBe(false)
  }, 60000)

  it('rejects filters introduced by the incoming tree before updating the checkout', async () => {
    const setup = await fixture()
    const app = await setup.replica()
    const before = await git(app.root, 'rev-parse', 'HEAD')
    await git(app.root, 'config', 'filter.untrusted.smudge', 'invalid-taskcon-fixture-command')
    await git(app.root, 'config', 'filter.untrusted.required', 'true')
    await writeFile(join(setup.seed, '.gitattributes'), '*.txt filter=untrusted\n')
    await writeFile(join(setup.seed, 'filtered.txt'), 'This incoming file requires a checkout filter.\n')
    await git(setup.seed, 'add', '.gitattributes', 'filtered.txt')
    await git(setup.seed, 'commit', '--quiet', '-m', 'Add filtered input')
    await git(setup.seed, 'push', '--quiet')
    await expect(app.sync()).rejects.toThrow('Incoming files require a configured Git filter')
    expect(await git(app.root, 'rev-parse', 'HEAD')).toBe(before)
    expect(await present(join(app.root, '.gitattributes'))).toBe(false)
    expect(await present(join(app.root, 'filtered.txt'))).toBe(false)
  }, 60000)

  it('rejects callback writes and retains pending metadata without pushing', async () => {
    const setup = await fixture()
    const app = await setup.replica()
    const before = await git(setup.remote, 'rev-parse', BRANCH)
    await expect(app.sync([record('callback')], { validateReplica: async (root) => { await writeFile(join(root, 'README.md'), 'Concurrent user edits') } })).rejects.toMatchObject({ code: 'busy' })
    expect(await git(setup.remote, 'rev-parse', BRANCH)).toBe(before)
    expect(await readFile(join(app.root, 'README.md'), 'utf8')).toBe('Concurrent user edits')
  }, 60000)

  it('serializes owners and safely recovers only dead process locks', async () => {
    const setup = await fixture()
    const a = await setup.replica()
    const b = await setup.replica()
    await Promise.all([a.sync([record('a')]), b.sync([record('b')])])
    const lock = join(a.root, '.git', 'taskcontinuum-sync.lock')
    await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname() }))
    await expect(a.sync()).rejects.toMatchObject({ code: 'busy' })
    expect(await present(lock)).toBe(true)
    await rm(lock)
    const child = await execute(process.execPath, ['-p', 'process.pid'], { cwd: setup.root, timeout: 10000 })
    await writeFile(lock, JSON.stringify({ pid: Number(child.stdout.trim()), host: hostname() }))
    await b.sync()
    expect(await present(lock)).toBe(false)
  }, 90000)

  it('does not recreate a deleted remote branch or guess an upstream', async () => {
    const setup = await fixture()
    const app = await setup.replica()
    await git(setup.remote, 'update-ref', '-d', `refs/heads/${BRANCH}`)
    await expect(app.sync([record('deleted')])).rejects.toMatchObject({ code: 'upstream' })
    await git(app.root, 'switch', '--quiet', '--detach')
    await expect(app.sync()).rejects.toMatchObject({ code: 'upstream' })
    expect(await git(setup.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('')
  }, 60000)

  it('supports cancellation and bounds command output and execution time', async () => {
    const setup = await fixture()
    const app = await setup.replica()
    const controller = new AbortController()
    await expect(app.sync([record('cancelled')], { signal: controller.signal, validateReplica: async () => { controller.abort() } })).rejects.toMatchObject({ code: 'cancelled' })
    await expect(GitReplica.open({ workspaceRoot: app.root, stateDirectory: join(setup.root, 'timeout'), commandTimeoutMs: 1 })).rejects.toMatchObject({ code: 'timeout' })
    await expect(GitReplica.open({ workspaceRoot: app.root, stateDirectory: join(app.root, 'unsafe') })).rejects.toMatchObject({ code: 'git' })
    for (let i = 0; i < 30; i++) await writeRecord(setup.seed, record(`bounded-${i}`))
    await git(setup.seed, 'add', '.taskcontinuum')
    await git(setup.seed, 'commit', '--quiet', '-m', 'Output bound')
    await git(setup.seed, 'push', '--quiet')
    const bounded = await GitReplica.open({ workspaceRoot: app.root, stateDirectory: join(setup.root, 'state-0'), maxOutputBytes: 1024, prepare: false })
    replicas.push(bounded)
    await expect(bounded.sync()).rejects.toMatchObject({ code: 'output-limit' })
  }, 90000)

  it.each(['git', 'checkout', 'marker'] as const)('rejects unsupported %s state without reading, migrating, or deleting the old checkout', async (kind) => {
    const setup = await fixture()
    const workspaceRoot = setup.clients[0]
    const stateDirectory = join(setup.root, 'state-0')
    const id = createHash('sha256').update(JSON.stringify([workspaceRoot, setup.remote, setup.remote])).digest('hex')
    const directory = join(stateDirectory, `${kind === 'marker' ? 'checkout-v2' : kind === 'checkout' ? 'checkout' : 'git'}-${id}`)
    if (kind === 'marker') {
      const app = await setup.replica()
      await app.close()
      expect(JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'))).toMatchObject({ version: 2, mode: 'selected-checkout' })
    }
    const oldRoot = join(directory, 'replica')
    await mkdir(oldRoot, { recursive: true })
    const marker = kind === 'marker' ? '{"version":1}' : 'Old marker must not be parsed or reused'
    await writeFile(join(directory, 'owner.json'), marker)
    await writeFile(join(oldRoot, 'private-user-work.txt'), 'Do not remove or modify this')
    const before = await readdir(stateDirectory, { recursive: true })
    const head = await git(workspaceRoot, 'rev-parse', 'HEAD')
    await expect(GitReplica.open({ workspaceRoot, stateDirectory, prepare: false })).rejects.toMatchObject({
      code: 'unsupported-format',
      message: expect.stringContaining('fresh synchronization state directory'),
    })
    expect(await readdir(stateDirectory, { recursive: true })).toEqual(before)
    expect(await readFile(join(directory, 'owner.json'), 'utf8')).toBe(marker)
    expect(await readFile(join(oldRoot, 'private-user-work.txt'), 'utf8')).toBe('Do not remove or modify this')
    expect(await git(workspaceRoot, 'rev-parse', 'HEAD')).toBe(head)
  }, 60000)
})
