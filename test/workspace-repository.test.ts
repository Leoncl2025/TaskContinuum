// @vitest-environment node
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/shared/taskDocuments/config'
import { readTaskWorkspace } from '../src/main/workspaceReader'
import { createWorkspaceRepositorySchema, WorkspaceRepositoryService } from '../src/main/workspaceRepository'
import { WorkspaceStore } from '../src/main/workspaceStore'
import { repositoryFixture } from './workspace-repository-fixture'

afterEach(() => { vi.unstubAllEnvs() })

async function created() {
  const fixture = await repositoryFixture()
  const root = await fixture.service.create({ parentPath: fixture.root, name: 'real-tasks' })
  return { ...fixture, parent: fixture.root, root, workspace: await readTaskWorkspace(root) }
}

describe('local task repository creation', () => {
  it('creates and commits the real task protocol, with an empty tasks directory that survives cloning', async () => {
    const fixture = await repositoryFixture()
    const before = await readFile(fixture.config, 'utf8')
    const root = await fixture.service.create({ parentPath: fixture.root, name: 'my-tasks' })
    const snapshot = await readTaskWorkspace(root)
    expect(snapshot.tasks).toEqual([])
    expect(snapshot.warnings).toEqual([])
    expect(snapshot.diagnostics).toEqual([])
    const config = Config.parse(JSON.parse(await readFile(join(root, '.agentdesk', 'config.json'), 'utf8')))
    expect(config.schemaVersion).toBe('1.0.0')
    expect(config.workspace).toBe('my-tasks')
    expect(config.members).toEqual([{ id: 'owner', name: 'Repository Fixture', kind: 'human' }])
    expect(config.bridge.jobs.autoApply).toBe(false)
    expect(config.bridge.sync.defaultSources).toEqual([])
    expect((await lstat(join(root, '.git'))).isDirectory()).toBe(true)
    expect(await fixture.git(root, 'branch', '--show-current')).toBe('main')
    expect((await fixture.git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).split(/\r?\n/)).toEqual(['.agentdesk/config.json', '.gitignore', 'tasks/.gitkeep'])
    expect(await fixture.git(root, 'log', '-1', '--format=%an <%ae>')).toBe('Repository Fixture <repository-fixture@example.invalid>')
    expect(await fixture.git(root, 'status', '--porcelain')).toBe('')
    expect(await fixture.git(root, 'remote')).toBe('')
    expect(await readFile(fixture.config, 'utf8')).toBe(before)
    expect(fixture.calls.some((call) => call.program === 'gh')).toBe(false)
    const clone = join(fixture.root, 'clone')
    await fixture.git(fixture.root, 'clone', '--quiet', '--no-local', '--', root, clone)
    expect((await readTaskWorkspace(clone)).tasks).toEqual([])
    expect((await readTaskWorkspace(clone)).warnings).toEqual([])
    expect(await readdir(join(clone, 'tasks'))).toEqual(['.gitkeep'])
    expect(await fixture.git(root, 'check-ignore', '.env', '.agentdesk/index.json', '.agentdesk/jobs/job.json', '.taskcontinuum/local/credentials.json')).toContain('.taskcontinuum/local/credentials.json')
  }, 30000)

  it('creates its own main repository inside a parent repository without touching parent history, staging or injected Git paths', async () => {
    const fixture = await repositoryFixture()
    await fixture.git(fixture.root, 'init', '--quiet', '--initial-branch=parent')
    await writeFile(join(fixture.root, 'parent.txt'), 'parent content\n')
    await fixture.git(fixture.root, 'add', '--', 'parent.txt')
    await fixture.git(fixture.root, 'commit', '--quiet', '-m', 'Parent history')
    await writeFile(join(fixture.root, 'parent-staged.txt'), 'parent staged content\n')
    await fixture.git(fixture.root, 'add', '--', 'parent-staged.txt')
    const head = await fixture.git(fixture.root, 'rev-parse', 'HEAD')
    const index = await readFile(join(fixture.root, '.git', 'index'))
    for (const [key, value] of Object.entries({
      GIT_DIR: join(fixture.root, '.git'), GIT_WORK_TREE: fixture.root, GIT_INDEX_FILE: join(fixture.root, '.git', 'index'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: fixture.root,
      GIT_NAMESPACE: 'unsafe', GIT_ALTERNATE_OBJECT_DIRECTORIES: fixture.root, GIT_TRACE: '1',
      GH_HOST: 'example.invalid', GH_REPO: 'other/repo',
    })) vi.stubEnv(key, value)
    const root = await fixture.service.create({ parentPath: fixture.root, name: 'child-tasks' })
    expect(await fixture.git(fixture.root, 'rev-parse', 'HEAD')).toBe(head)
    expect(await readFile(join(fixture.root, '.git', 'index'))).toEqual(index)
    expect(await fixture.git(root, 'rev-list', '--count', 'HEAD')).toBe('1')
    expect(await fixture.git(root, 'branch', '--show-current')).toBe('main')
    for (const call of fixture.calls) {
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_NAMESPACE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_TRACE', 'GH_HOST', 'GH_REPO']) expect(call.gitEnvironment).not.toHaveProperty(key)
      expect(call.timeout).toBeGreaterThan(0)
      expect(call.gitEnvironment.GIT_TERMINAL_PROMPT).toBe('0')
      expect(call.gitEnvironment.GIT_INDEX_FILE).not.toBe(join(fixture.root, '.git', 'index'))
    }
  }, 30000)

  it('ignores custom templates, executable hooks, signing and parent-local configuration during creation', async () => {
    const fixture = await repositoryFixture()
    await fixture.git(fixture.root, 'init', '--quiet', '--initial-branch=parent')
    await writeFile(join(fixture.root, 'parent.txt'), 'parent history\n')
    await fixture.git(fixture.root, 'add', '--', 'parent.txt')
    await fixture.git(fixture.root, 'commit', '--quiet', '-m', 'Parent history')
    await writeFile(join(fixture.root, 'staged.txt'), 'retain parent staging\n')
    await fixture.git(fixture.root, 'add', '--', 'staged.txt')
    await fixture.git(fixture.root, 'config', '--local', 'user.name', 'Parent Identity')
    await fixture.git(fixture.root, 'config', '--local', 'user.email', 'parent@example.invalid')
    await fixture.git(fixture.root, 'config', '--local', 'onboarding.parent', 'must-stay-local')
    const hooks = join(fixture.root, 'configured-hooks')
    const template = join(fixture.root, 'configured-template')
    await mkdir(hooks)
    await mkdir(join(template, 'hooks'), { recursive: true })
    const hook = '#!/bin/sh\nprintf unexpected > onboarding-hook-ran\nexit 73\n'
    for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'reference-transaction']) {
      await writeFile(join(hooks, name), hook, { mode: 0o755 })
      await writeFile(join(template, 'hooks', name), hook, { mode: 0o755 })
    }
    await writeFile(join(template, 'config'), '[onboarding]\ntemplate=must-not-be-copied\n')
    await writeFile(join(template, 'template-sentinel'), 'must-not-be-copied')
    const signer = join(fixture.root, 'must-not-run-gpg')
    await writeFile(signer, '#!/bin/sh\nprintf unexpected > onboarding-signer-ran\nexit 74\n', { mode: 0o755 })
    const attributes = join(fixture.root, 'configured-attributes')
    const excludes = join(fixture.root, 'configured-excludes')
    await writeFile(attributes, '* filter=blocked\n')
    await writeFile(excludes, '*\n')
    for (const [key, value] of Object.entries({
      'init.templateDir': template, 'init.defaultBranch': 'unexpected',
      'core.hooksPath': hooks, 'core.attributesFile': attributes, 'core.excludesFile': excludes,
      'filter.blocked.clean': 'false', 'filter.blocked.required': 'true',
      'commit.gpgSign': 'true', 'user.signingKey': 'fixture-only', 'gpg.program': signer,
    })) await fixture.git(fixture.root, 'config', '--file', fixture.config, key, value)
    const globalConfig = await readFile(fixture.config)
    const parentConfig = await readFile(join(fixture.root, '.git', 'config'))
    const parentIndex = await readFile(join(fixture.root, '.git', 'index'))
    const parentHead = await fixture.git(fixture.root, 'rev-parse', 'HEAD')
    const root = await fixture.service.create({ parentPath: fixture.root, name: 'isolated-tasks' })
    expect(await fixture.git(root, 'branch', '--show-current')).toBe('main')
    expect(await fixture.git(root, 'rev-list', '--count', 'HEAD')).toBe('1')
    expect(await fixture.git(root, 'log', '-1', '--format=%an <%ae>')).toBe('Repository Fixture <repository-fixture@example.invalid>')
    expect(await fixture.git(root, 'cat-file', '-p', 'HEAD')).not.toMatch(/^gpgsig /m)
    expect(await fixture.git(root, 'config', '--local', '--list')).not.toContain('onboarding.')
    expect(await fixture.git(root, 'status', '--porcelain')).toBe('')
    expect((await readTaskWorkspace(root)).tasks).toEqual([])
    expect(await readFile(fixture.config)).toEqual(globalConfig)
    expect(await readFile(join(fixture.root, '.git', 'config'))).toEqual(parentConfig)
    expect(await readFile(join(fixture.root, '.git', 'index'))).toEqual(parentIndex)
    expect(await fixture.git(fixture.root, 'rev-parse', 'HEAD')).toBe(parentHead)
    expect(await readdir(join(root, '.git'))).not.toContain('template-sentinel')
    for (const directory of [fixture.root, join(fixture.root, '.git'), root, join(root, '.git')]) {
      const entries = await readdir(directory)
      expect(entries).not.toContain('onboarding-hook-ran')
      expect(entries).not.toContain('onboarding-signer-ran')
    }
    expect(fixture.calls.every((call) => call.program === 'git' && call.args.includes('commit.gpgSign=false'))).toBe(true)
    expect(fixture.calls.find((call) => call.args.includes('init'))?.args).toContain('--template=')
  }, 30000)

  it('rejects traversal, option-like, non-string, reserved and colliding names without changing the destination', async () => {
    const fixture = await repositoryFixture()
    for (const name of ['', '.', '..', '../escape', '..\\escape', '/escape', '\\escape', '-repo', '--help', 'CON', 'con.txt', 'AUX', 'NUL', 'COM1', 'LPT9.txt', 'name.', 'name ', 'a:b', 'a/b', 'a\\b', 'name.git', 'x'.repeat(61), 12, null]) {
      await expect(fixture.service.create({ parentPath: fixture.root, name } as never)).rejects.toThrow()
    }
    for (const value of [null, [], {}, { parentPath: 7, name: 'name' }, { parentPath: fixture.root, name: 'valid', extra: true }, { parentPath: 'relative', name: 'name' }]) expect(createWorkspaceRepositorySchema.safeParse(value).success).toBe(false)
    expect(fixture.calls).toEqual([])
    await mkdir(join(fixture.root, 'existing'))
    await writeFile(join(fixture.root, 'existing', 'user.txt'), 'never replace this')
    await expect(fixture.service.create({ parentPath: fixture.root, name: 'existing' })).rejects.toThrow('already exists')
    await writeFile(join(fixture.root, 'existing-file'), 'never replace this either')
    await expect(fixture.service.create({ parentPath: fixture.root, name: 'existing-file' })).rejects.toThrow('already exists')
    await expect(fixture.service.create({ parentPath: join(fixture.root, 'missing'), name: 'new' })).rejects.toThrow('parent folder')
    await expect(fixture.service.create({ parentPath: join(fixture.root, 'existing-file'), name: 'new' })).rejects.toThrow('directories')
    expect(await readFile(join(fixture.root, 'existing', 'user.txt'), 'utf8')).toBe('never replace this')
    expect(await readFile(join(fixture.root, 'existing-file'), 'utf8')).toBe('never replace this either')
  })

  it('preflights identity and missing Git before reserving a destination, allowing a safe retry', async () => {
    const fixture = await repositoryFixture()
    await writeFile(fixture.config, '')
    await expect(fixture.service.create({ parentPath: fixture.root, name: 'retry' })).rejects.toThrow('user.name and user.email')
    expect(await readdir(fixture.root)).toEqual(['fixture-git-config'])
    const unavailable = new WorkspaceRepositoryService(async () => { throw Object.assign(new Error('Install Git and restart Task Continuum.'), { code: 'ENOENT' }) })
    await expect(unavailable.create({ parentPath: fixture.root, name: 'missing-git' })).rejects.toThrow('Install Git')
    expect(await readdir(fixture.root)).toEqual(['fixture-git-config'])
    await writeFile(fixture.config, '[user]\nname=Configured Person\nemail=person@example.invalid\n')
    expect(await fixture.service.create({ parentPath: fixture.root, name: 'retry' })).toBe(join(fixture.root, 'retry'))
  }, 30000)

  it('does not clobber a directory that wins a creation race after preflight', async () => {
    const fixture = await repositoryFixture()
    fixture.github.before = async (call) => {
      if (call.args.at(-1) === 'user.email') {
        await mkdir(join(fixture.root, 'raced'))
        await writeFile(join(fixture.root, 'raced', 'user.txt'), 'raced user data')
      }
    }
    await expect(fixture.service.create({ parentPath: fixture.root, name: 'raced' })).rejects.toThrow('already exists')
    expect(await readdir(join(fixture.root, 'raced'))).toEqual(['user.txt'])
    expect(await readFile(join(fixture.root, 'raced', 'user.txt'), 'utf8')).toBe('raced user data')
  })

  it('retains an owned partial folder and any concurrent user files after a late Git failure', async () => {
    const fixture = await repositoryFixture()
    fixture.github.before = async (call) => {
      if (call.args.includes('init')) {
        await writeFile(join(fixture.root, 'partial', 'user.txt'), 'concurrent data')
        return { code: 1, stdout: '', stderr: 'Simulated initialization failure.' }
      }
    }
    await expect(fixture.service.create({ parentPath: fixture.root, name: 'partial' })).rejects.toThrow('retained')
    expect(await readFile(join(fixture.root, 'partial', 'user.txt'), 'utf8')).toBe('concurrent data')
    expect(fixture.calls.some((call) => call.program === 'gh')).toBe(false)
  })

  it('never commits concurrently staged unrelated files and never overwrites an existing index', async () => {
    const fixture = await repositoryFixture()
    const root = join(fixture.root, 'raced-index')
    fixture.github.before = async (call) => {
      if (call.args.includes('commit-tree')) {
        await writeFile(join(root, 'unrelated.txt'), 'do not commit automatically')
        await fixture.git(root, 'add', '--', 'unrelated.txt')
      }
    }
    await expect(fixture.service.create({ parentPath: fixture.root, name: 'raced-index' })).rejects.toThrow('retained')
    expect(await fixture.git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('unrelated.txt')
    expect(await fixture.git(root, 'ls-files')).toBe('unrelated.txt')
    expect(await readFile(join(root, 'unrelated.txt'), 'utf8')).toBe('do not commit automatically')
  }, 30000)
})

describe('explicit GitHub publication', () => {
  it('does not mistake a parent Git repository for an existing workspace repository or modify it', async () => {
    const fixture = await repositoryFixture()
    await fixture.git(fixture.root, 'init', '--quiet', '--initial-branch=parent')
    const root = join(fixture.root, 'existing-workspace')
    await mkdir(root)
    const workspace = { id: 'a'.repeat(64), name: 'existing-workspace', title: 'Existing workspace', root }
    expect(await fixture.service.status(workspace)).toMatchObject({ branch: null, remoteUrl: null, published: false })
    const calls = fixture.calls.length
    await expect(fixture.service.publish(workspace, true)).rejects.toThrow('Existing repositories are not modified')
    expect(fixture.calls).toHaveLength(calls)
    expect(await fixture.git(fixture.root, 'branch', '--show-current')).toBe('parent')
  })

  it('reports installation, authentication, account and local status without publishing', async () => {
    const fixture = await created()
    expect(await fixture.service.status(fixture.workspace)).toEqual({
      workspaceId: fixture.workspace.id, name: 'real-tasks', branch: 'main', remoteUrl: null, published: false,
      github: { installed: true, authenticated: true, login: 'fixture-owner' },
    })
    fixture.github.installed = false
    expect((await fixture.service.status(fixture.workspace)).github).toEqual({ installed: false, authenticated: false })
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('Install GitHub CLI')
    fixture.github.installed = true
    fixture.github.authenticated = false
    expect((await fixture.service.status(fixture.workspace)).github).toEqual({ installed: true, authenticated: false })
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('gh auth login')
    fixture.github.authError = 'Connection timed out while contacting GitHub.'
    await expect(fixture.service.status(fixture.workspace)).rejects.toThrow('network')
    expect(fixture.calls.some((call) => call.args.includes('POST') || call.args.includes('push'))).toBe(false)
  }, 30000)

  it.each([true, false])('publishes only after an explicit action with private=%s, a pinned main commit and a verified URL', async (isPrivate) => {
    const fixture = await created()
    const before = await readFile(fixture.config, 'utf8')
    const start = fixture.calls.length
    const result = await fixture.service.publish(fixture.workspace, isPrivate)
    expect(result).toEqual({ url: 'https://github.com/fixture-owner/real-tasks' })
    const calls = fixture.calls.slice(start)
    expect(calls.filter((call) => call.args.includes('POST'))).toHaveLength(1)
    expect(calls.find((call) => call.args.includes('POST'))?.args).toContain(`private=${isPrivate}`)
    expect(calls.some((call) => call.program === 'git' && call.args.includes('add') && !call.args.includes('remote'))).toBe(false)
    const push = calls.find((call) => call.args.includes('push'))
    expect(push?.args.at(-1)).toBe(`${await fixture.git(fixture.root, 'rev-parse', 'HEAD')}:refs/heads/main`)
    expect(push?.args).not.toContain('--force')
    expect(push?.args).toContain('--no-follow-tags')
    expect(push?.args).toContain('credential.helper=!gh auth git-credential')
    expect(push?.gitEnvironment.GIT_TERMINAL_PROMPT).toBe('0')
    expect(push?.gitEnvironment.GH_PROMPT_DISABLED).toBe('1')
    expect(await fixture.git(fixture.root, 'remote', 'get-url', 'origin')).toBe(`${result.url}.git`)
    expect(await fixture.git(fixture.root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')).toBe('origin/main')
    expect((await fixture.service.status(fixture.workspace)).published).toBe(true)
    expect(await readFile(fixture.config, 'utf8')).toBe(before)
    expect(await fixture.git(fixture.root, 'status', '--porcelain')).toBe('')
    const record = JSON.parse(await readFile(join(fixture.root, '.git', 'taskcontinuum-onboarding.json'), 'utf8'))
    expect(record.publication).toMatchObject({ owner: 'fixture-owner', private: isPrivate, repositoryId: 12345, published: true })
  }, 30000)

  it('preserves a remotely created repository after push failure and resumes after a restart without another creation', async () => {
    const fixture = await repositoryFixture()
    const profile = join(fixture.root, 'profile')
    const store = new WorkspaceStore(profile, undefined, undefined, fixture.service)
    const state = await store.createRepository({ parentPath: fixture.root, name: 'persistent-tasks' })
    const id = state.current!.id
    fixture.github.pushFailures = 1
    await expect(store.publishRepository({ workspaceId: id })).rejects.toThrow('local files are retained')
    expect((await store.getState()).current?.id).toBe(id)
    expect((await store.getRepositoryStatus(id)).published).toBe(false)
    expect((await store.getRepositoryStatus(id)).remoteUrl).toBe('https://github.com/fixture-owner/persistent-tasks')
    const restarted = new WorkspaceStore(profile, undefined, undefined, new WorkspaceRepositoryService(fixture.run))
    expect((await restarted.getState()).current?.id).toBe(id)
    expect(await restarted.publishRepository({ workspaceId: id, private: true })).toEqual({ url: 'https://github.com/fixture-owner/persistent-tasks' })
    expect(fixture.calls.filter((call) => call.args.includes('POST'))).toHaveLength(1)
    expect(fixture.calls.filter((call) => call.args.includes('push'))).toHaveLength(2)
    expect(fixture.github.repository?.private).toBe(true)
  }, 30000)

  it('recovers a lost push acknowledgement by verifying the remote rather than pushing again', async () => {
    const fixture = await created()
    fixture.github.pushFailures = 1
    fixture.github.acknowledgeFailedPush = true
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('Git push failed')
    expect(await new WorkspaceRepositoryService(fixture.run).publish(fixture.workspace, true)).toEqual({ url: 'https://github.com/fixture-owner/real-tasks' })
    expect(fixture.calls.filter((call) => call.args.includes('POST'))).toHaveLength(1)
    expect(fixture.calls.filter((call) => call.args.includes('push'))).toHaveLength(1)
  }, 30000)

  it('rejects dirty files, another branch, existing remotes and an existing GitHub name without staging or overwriting', async () => {
    const fixture = await created()
    await writeFile(join(fixture.root, 'private.txt'), 'not for automatic staging')
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('uncommitted')
    expect(fixture.calls.some((call) => call.program === 'gh')).toBe(false)
    await fixture.git(fixture.root, 'add', '--', 'private.txt')
    await fixture.git(fixture.root, 'commit', '--quiet', '-m', 'Explicitly reviewed user content')
    await fixture.git(fixture.root, 'switch', '--quiet', '-c', 'other')
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('branch or commit changed')
    await fixture.git(fixture.root, 'switch', '--quiet', 'main')
    await fixture.git(fixture.root, 'remote', 'add', 'user-remote', 'https://github.com/another/unrelated.git')
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('already has a remote')
    expect(await fixture.git(fixture.root, 'remote', 'get-url', 'user-remote')).toBe('https://github.com/another/unrelated.git')
    await fixture.git(fixture.root, 'remote', 'remove', 'user-remote')
    fixture.github.repository = {
      id: 987, name: 'real-tasks', full_name: 'fixture-owner/real-tasks', html_url: 'https://github.com/fixture-owner/real-tasks',
      clone_url: 'https://github.com/fixture-owner/real-tasks.git', private: true, owner: { login: 'fixture-owner' },
    }
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('already exists')
    expect(fixture.calls.some((call) => call.args.includes('POST') || call.args.includes('push'))).toBe(false)
  }, 30000)

  it('fences retry account, visibility, head, remote, push URL and upstream changes', async () => {
    const fixture = await created()
    fixture.github.pushFailures = 1
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('Git push failed')
    await expect(fixture.service.publish(fixture.workspace, false)).rejects.toThrow('account or visibility')
    fixture.github.login = 'another-user'
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('account or visibility')
    fixture.github.login = 'fixture-owner'
    await fixture.git(fixture.root, 'config', '--local', 'remote.origin.pushurl', 'https://github.com/another/unrelated.git')
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('push URL changed')
    await fixture.git(fixture.root, 'config', '--local', '--unset', 'remote.origin.pushurl')
    await fixture.git(fixture.root, 'config', '--local', 'branch.main.remote', 'other')
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('upstream changed')
    await fixture.git(fixture.root, 'config', '--local', '--unset', 'branch.main.remote')
    await writeFile(join(fixture.root, 'reviewed.txt'), 'new content after the publish attempt')
    await fixture.git(fixture.root, 'add', '--', 'reviewed.txt')
    await fixture.git(fixture.root, 'commit', '--quiet', '-m', 'Changed after publication started')
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('branch or commit changed')
    expect(fixture.calls.filter((call) => call.args.includes('POST'))).toHaveLength(1)
    expect(fixture.calls.filter((call) => call.args.includes('push'))).toHaveLength(1)
  }, 60000)

  it('rejects replaced GitHub repositories and unexpected remote history on retry', async () => {
    const fixture = await created()
    fixture.github.pushFailures = 1
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('Git push failed')
    fixture.github.repository!.id = 999
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('removed or replaced')
    fixture.github.repository!.id = 12345
    fixture.github.refs.set('refs/heads/main', 'a'.repeat(40))
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('history changed')
    expect(fixture.calls.filter((call) => call.args.includes('push'))).toHaveLength(1)
  }, 30000)

  it('rechecks remote identity around the push instead of reporting success for a replaced repository', async () => {
    const fixture = await created()
    fixture.github.before = async (call) => {
      if (call.args.includes('push')) fixture.github.repository!.id = 999
    }
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('removed or replaced')
    const record = JSON.parse(await readFile(join(fixture.root, '.git', 'taskcontinuum-onboarding.json'), 'utf8'))
    expect(record.publication.published).toBe(false)
    expect(record.publication.repositoryId).toBe(12345)
    expect((await readTaskWorkspace(fixture.root)).tasks).toEqual([])
  }, 30000)

  it.each(['', '{}', '{"html_url":""}'])('does not invent a successful URL from a malformed creation result: %j', async (stdout) => {
    const fixture = await created()
    fixture.github.createResponse = { code: 0, stdout, stderr: '' }
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('verifiable repository')
    expect(await fixture.git(fixture.root, 'remote')).toBe('')
    expect(fixture.calls.some((call) => call.args.includes('push'))).toBe(false)
    expect((await readTaskWorkspace(fixture.root)).tasks).toEqual([])
  }, 30000)

  it('fences a repository changed while the remote is being created, keeping the new remote recoverable', async () => {
    const fixture = await created()
    fixture.github.before = async (call) => {
      if (call.args.includes('POST')) await fixture.git(fixture.root, 'switch', '--quiet', '-c', 'changed-during-create')
    }
    await expect(fixture.service.publish(fixture.workspace, true)).rejects.toThrow('branch or commit changed')
    expect(fixture.github.repository?.id).toBe(12345)
    expect(fixture.calls.some((call) => call.args.includes('push'))).toBe(false)
    fixture.github.before = undefined
    await fixture.git(fixture.root, 'switch', '--quiet', 'main')
    expect(await fixture.service.publish(fixture.workspace, true)).toEqual({ url: 'https://github.com/fixture-owner/real-tasks' })
    expect(fixture.calls.filter((call) => call.args.includes('POST'))).toHaveLength(1)
  }, 30000)
})
