// @vitest-environment node
import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/shared/taskDocuments/config'
import { readTaskWorkspace } from '../src/main/workspaceReader'
import { createWorkspaceRepositorySchema, repositoryPushRequestSchema, WorkspaceRepositoryService } from '../src/main/workspaceRepository'
import { repositoryFixture } from './workspace-repository-fixture'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

const remote = 'https://github.com/lianc_microsoft/browser-chosen-name.git'

async function created() {
  const fixture = await repositoryFixture()
  const root = await fixture.service.create({ parentPath: fixture.root, name: 'real-tasks' })
  return { ...fixture, parent: fixture.root, root, workspace: await readTaskWorkspace(root) }
}

function expectReadOnly(calls: Awaited<ReturnType<typeof repositoryFixture>>['calls']) {
  expect(calls.every((call) => call.program === 'git')).toBe(true)
  for (const call of calls) {
    expect(call.args.some((arg) => ['add', 'commit', 'commit-tree', 'update-ref', 'push', 'fetch', 'pull', 'credential', 'set-url'].includes(arg))).toBe(false)
    expect(call.args.some((arg) => arg.startsWith('credential.helper='))).toBe(false)
    expect(call.timeout).toBeGreaterThan(0)
    expect(call.timeout).toBeLessThanOrEqual(60000)
    expect(call.gitEnvironment.GIT_TERMINAL_PROMPT).toBe('0')
    expect(call.gitEnvironment.GIT_NO_LAZY_FETCH).toBe('1')
    expect(call.gitEnvironment.GCM_INTERACTIVE).toBe('Never')
  }
}

describe('local task repository creation', () => {
  it('commits the real empty task protocol, survives cloning and leaves Git configuration untouched', async () => {
    const fixture = await repositoryFixture()
    const before = await readFile(fixture.config)
    const root = await fixture.service.create({ parentPath: fixture.root, name: 'my-tasks' })
    const snapshot = await readTaskWorkspace(root)
    expect(snapshot.tasks).toEqual([])
    expect(snapshot.warnings).toEqual([])
    expect(snapshot.diagnostics).toEqual([])
    const config = Config.parse(JSON.parse(await readFile(join(root, '.agentdesk', 'config.json'), 'utf8')))
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
    expect(await readFile(fixture.config)).toEqual(before)
    expect(fixture.calls.every((call) => call.program === 'git')).toBe(true)
    const clone = join(fixture.root, 'clone')
    await fixture.git(fixture.root, 'clone', '--quiet', '--no-local', '--', root, clone)
    expect((await readTaskWorkspace(clone)).tasks).toEqual([])
    expect(await readdir(join(clone, 'tasks'))).toEqual(['.gitkeep'])
    expect(await fixture.git(root, 'check-ignore', '.env', '.agentdesk/index.json', '.agentdesk/jobs/job.json', '.taskcontinuum/local/credentials.json')).toContain('.taskcontinuum/local/credentials.json')
  }, 30000)

  it('isolates parent history, staging, source environment, hooks, templates, filters and signing', async () => {
    const fixture = await repositoryFixture()
    await fixture.git(fixture.root, 'init', '--quiet', '--initial-branch=parent')
    await writeFile(join(fixture.root, 'parent.txt'), 'parent history\n')
    await fixture.git(fixture.root, 'add', '--', 'parent.txt')
    await fixture.git(fixture.root, 'commit', '--quiet', '-m', 'Parent history')
    await writeFile(join(fixture.root, 'staged.txt'), 'retain staging\n')
    await fixture.git(fixture.root, 'add', '--', 'staged.txt')
    await fixture.git(fixture.root, 'config', '--local', 'user.name', 'Parent Identity')
    const template = join(fixture.root, 'configured-template')
    await mkdir(join(template, 'hooks'), { recursive: true })
    for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'reference-transaction']) {
      await writeFile(join(template, 'hooks', name), '#!/bin/sh\nprintf unexpected > hook-ran\nexit 73\n', { mode: 0o755 })
    }
    await writeFile(join(template, 'config'), '[onboarding]\ntemplate=must-not-be-copied\n')
    await writeFile(join(template, 'sentinel'), 'must-not-be-copied')
    const attributes = join(fixture.root, 'attributes')
    await writeFile(attributes, '* filter=blocked\n')
    for (const [key, value] of Object.entries({
      'init.templateDir': template, 'init.defaultBranch': 'unexpected',
      'core.hooksPath': join(template, 'hooks'), 'core.attributesFile': attributes,
      'filter.blocked.clean': 'false', 'filter.blocked.required': 'true',
      'commit.gpgSign': 'true', 'gpg.program': 'false',
    })) await fixture.git(fixture.root, 'config', '--file', fixture.config, key, value)
    const globalConfig = await readFile(fixture.config)
    const parentConfig = await readFile(join(fixture.root, '.git', 'config'))
    const parentIndex = await readFile(join(fixture.root, '.git', 'index'))
    const parentHead = await fixture.git(fixture.root, 'rev-parse', 'HEAD')
    const injected = {
      GIT_DIR: join(fixture.root, '.git'), GIT_WORK_TREE: fixture.root, GIT_INDEX_FILE: join(fixture.root, '.git', 'index'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: fixture.root,
      GIT_NAMESPACE: 'unsafe', GIT_ALTERNATE_OBJECT_DIRECTORIES: fixture.root, GIT_TRACE: '1',
      GH_HOST: 'example.invalid', GH_REPO: 'other/repo', GCM_INTERACTIVE: 'Always', GCM_TRACE: '1',
    }
    for (const [key, value] of Object.entries(injected)) vi.stubEnv(key, value)
    const root = await fixture.service.create({ parentPath: fixture.root, name: 'isolated-tasks' })
    expect(await fixture.git(root, 'branch', '--show-current')).toBe('main')
    expect(await fixture.git(root, 'rev-list', '--count', 'HEAD')).toBe('1')
    expect(await fixture.git(root, 'log', '-1', '--format=%an')).toBe('Repository Fixture')
    expect(await fixture.git(root, 'status', '--porcelain')).toBe('')
    expect(await fixture.git(root, 'config', '--local', '--list')).not.toContain('onboarding.')
    expect(await readFile(fixture.config)).toEqual(globalConfig)
    expect(await readFile(join(fixture.root, '.git', 'config'))).toEqual(parentConfig)
    expect(await readFile(join(fixture.root, '.git', 'index'))).toEqual(parentIndex)
    expect(await fixture.git(fixture.root, 'rev-parse', 'HEAD')).toBe(parentHead)
    expect(await readdir(join(root, '.git'))).not.toContain('sentinel')
    expect(await readdir(root)).not.toContain('hook-ran')
    for (const call of fixture.calls) {
      for (const key of Object.keys(injected).filter((key) => !['GIT_INDEX_FILE', 'GCM_INTERACTIVE'].includes(key))) expect(call.gitEnvironment).not.toHaveProperty(key)
      expect(call.gitEnvironment.GIT_INDEX_FILE).not.toBe(injected.GIT_INDEX_FILE)
      expect(call.gitEnvironment.GCM_INTERACTIVE).toBe('Never')
      expect(call.args).toContain('commit.gpgSign=false')
    }
  }, 30000)

  it('rejects unsafe input, missing parents and collisions without commands or overwriting files', async () => {
    const fixture = await repositoryFixture()
    for (const name of ['', '.', '..', '../escape', '..\\escape', '/escape', '\\escape', '-repo', '--help', 'CON', 'con.txt', 'AUX', 'NUL', 'COM1', 'LPT9.txt', 'name.', 'name ', 'a:b', 'a/b', 'a\\b', 'name.git', 'x'.repeat(61), 12, null]) {
      await expect(fixture.service.create({ parentPath: fixture.root, name } as never)).rejects.toThrow()
    }
    for (const value of [null, [], {}, { parentPath: 7, name: 'name' }, { parentPath: fixture.root, name: 'valid', extra: true }, { parentPath: 'relative', name: 'name' }]) expect(createWorkspaceRepositorySchema.safeParse(value).success).toBe(false)
    expect(fixture.calls).toEqual([])
    await mkdir(join(fixture.root, 'existing'))
    await writeFile(join(fixture.root, 'existing', 'user.txt'), 'never replace')
    await expect(fixture.service.create({ parentPath: fixture.root, name: 'existing' })).rejects.toThrow('already exists')
    await expect(fixture.service.create({ parentPath: join(fixture.root, 'missing'), name: 'new' })).rejects.toThrow('parent folder')
    expect(await readFile(join(fixture.root, 'existing', 'user.txt'), 'utf8')).toBe('never replace')
  })

  it('preflights identity and missing Git before reserving a folder, then safely retries', async () => {
    const fixture = await repositoryFixture()
    await writeFile(fixture.config, '')
    await expect(fixture.service.create({ parentPath: fixture.root, name: 'retry' })).rejects.toThrow('user.name and user.email')
    expect(await readdir(fixture.root)).toEqual(['fixture-git-config'])
    const unavailable = new WorkspaceRepositoryService(async () => { throw Object.assign(new Error('Install Git and restart Task Continuum.'), { code: 'ENOENT' }) })
    await expect(unavailable.create({ parentPath: fixture.root, name: 'missing-git' })).rejects.toThrow('Install Git')
    await writeFile(fixture.config, '[user]\nname=Configured Person\nemail=person@example.invalid\n')
    expect(await fixture.service.create({ parentPath: fixture.root, name: 'retry' })).toBe(join(fixture.root, 'retry'))
  }, 30000)

  it('preserves a competing directory and retains partial creation without committing unrelated staging', async () => {
    const fixture = await repositoryFixture()
    fixture.network.before = async (call) => {
      if (call.args.at(-1) === 'user.email') {
        await mkdir(join(fixture.root, 'raced'))
        await writeFile(join(fixture.root, 'raced', 'user.txt'), 'raced data')
      }
    }
    await expect(fixture.service.create({ parentPath: fixture.root, name: 'raced' })).rejects.toThrow('already exists')
    expect(await readFile(join(fixture.root, 'raced', 'user.txt'), 'utf8')).toBe('raced data')
    const root = join(fixture.root, 'raced-index')
    fixture.network.before = async (call) => {
      if (call.args.includes('commit-tree')) {
        await writeFile(join(root, 'unrelated.txt'), 'do not commit automatically')
        await fixture.git(root, 'add', '--', 'unrelated.txt')
      }
    }
    await expect(fixture.service.create({ parentPath: fixture.root, name: 'raced-index' })).rejects.toThrow('retained')
    expect(await fixture.git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('unrelated.txt')
    expect(await fixture.git(root, 'ls-files')).toBe('unrelated.txt')
  }, 30000)
})

describe('browser creation and read-only manual push guidance', () => {
  it('validates push requests and rejects credential-bearing or injected URLs before running Git', async () => {
    expect(repositoryPushRequestSchema.safeParse({ workspaceId: 'a'.repeat(64), remoteUrl: remote }).success).toBe(true)
    for (const value of [{ workspaceId: 'bad', remoteUrl: remote }, { workspaceId: 'a'.repeat(64), remoteUrl: '' }, { workspaceId: 'a'.repeat(64), remoteUrl: ' \t ' }, { workspaceId: 'a'.repeat(64), remoteUrl: 'x'.repeat(2049) }, { workspaceId: 'a'.repeat(64), remoteUrl: remote, private: true }]) {
      expect(repositoryPushRequestSchema.safeParse(value).success).toBe(false)
    }
    const fixture = await repositoryFixture()
    const workspace = { id: 'a'.repeat(64), name: 'tasks', title: 'Tasks', root: fixture.root }
    for (const url of ['', '--upload-pack=evil', 'https://token@github.com/owner/repo', 'https://user:token@github.com/owner/repo', 'https://github.com/owner/repo?token=secret', 'https://github.com/owner/repo#hash', 'https://github.com/owner/repo\n', 'https://github.com/owner/repo\r', 'https://github.com/owner/repo;evil', 'https://github.com/owner/$(evil)', 'https://github.com/owner/repo/extra', 'https://github.com/owner/..', 'https://github.com/settings/repo', 'https://github.com/owner/.git', 'https://github.com/owner/-option', 'https://github.com/owner/repo%0a', 'https://github.com.evil/owner/repo', 'http://github.com/owner/repo', 'ssh://root@github.com/owner/repo', 'ssh://git@github.com:22/owner/repo', 'git@github.com:owner/repo\n']) {
      await expect(fixture.service.preparePush(workspace, url)).rejects.toThrow('plain GitHub')
    }
    expect(fixture.calls).toEqual([])
  })

  it('uses the browser for account/name/visibility and reports only local helper classifications', async () => {
    const fixture = await created()
    fixture.calls.length = 0
    expect(fixture.service.creationUrl({ ...fixture.workspace, name: 'tasks & account=wrong' })).toBe('https://github.com/new?name=tasks%20%26%20account%3Dwrong')
    expect(fixture.calls).toEqual([])
    expect(await fixture.service.status(fixture.workspace)).toEqual({
      workspaceId: fixture.workspace.id, name: 'real-tasks', branch: 'main', remoteUrl: null, credentialHelper: 'none',
    })
    for (const [helper, expected] of [['manager', 'gcm'], ['manager-core', 'gcm'], ['"C:/Program Files/Git/bin/git-credential-manager.exe"', 'gcm'], ['/usr/local/bin/git-credential-manager', 'gcm'], ['osxkeychain', 'configured'], ['!echo private-fixture-marker', 'configured']]) {
      await fixture.git(fixture.root, 'config', '--file', fixture.config, 'credential.helper', helper)
      const status = await fixture.service.status(fixture.workspace)
      expect(status.credentialHelper).toBe(expected)
      expect(JSON.stringify(status)).not.toContain('private-fixture-marker')
      expect(status).not.toHaveProperty('published')
      expect(status).not.toHaveProperty('github')
    }
    expectReadOnly(fixture.calls)
    expect(fixture.calls.some((call) => call.args.includes('ls-remote'))).toBe(false)
    expect(fixture.calls.filter((call) => call.args.includes('--list')).every((call) => call.args.includes('--name-only'))).toBe(true)
  }, 30000)

  it('generates quoted current-branch commands for EMU HTTPS/SSH and never changes local data', async () => {
    const fixture = await created()
    const root = join(fixture.parent, "user's $tasks folder")
    await rename(fixture.root, root)
    const workspace = { ...fixture.workspace, root }
    const record = await readFile(join(root, '.git', 'taskcontinuum-onboarding.json'))
    const config = await readFile(join(root, '.git', 'config'))
    const index = await readFile(join(root, '.git', 'index'))
    fixture.calls.length = 0
    for (const url of [remote, 'git@github.com:lianc_microsoft/browser-chosen-name.git', 'ssh://git@github.com/lianc_microsoft/browser-chosen-name.git']) {
      const plan = await fixture.service.preparePush(workspace, url)
      expect(plan.repositoryUrl).toBe('https://github.com/lianc_microsoft/browser-chosen-name')
      expect(plan.remoteUrl).toBe(url)
      expect(plan.branch).toBe('main')
      expect(plan.commands).toContain(`remote add -- origin '${url}'`)
      expect(plan.commands).toContain("push --no-follow-tags --recurse-submodules=no -u -- origin 'refs/heads/main:refs/heads/main'")
      expect(plan.commands).toContain(process.platform === 'win32' ? "user''s $tasks folder" : "user'\\''s $tasks folder")
      expect(plan.commands).toContain(process.platform === 'win32' ? 'if ($LASTEXITCODE -eq 0)' : '&&\n')
      expect(plan.commands.split('\n')).toHaveLength(2)
    }
    await fixture.git(root, 'switch', '--quiet', '-c', 'release/next')
    const plan = await fixture.service.preparePush(workspace, remote)
    expect(plan.branch).toBe('release/next')
    expect(plan.commands).toContain("'refs/heads/release/next:refs/heads/release/next'")
    expect(await readFile(join(root, '.git', 'config'))).toEqual(config)
    expect(await readFile(join(root, '.git', 'index'))).toEqual(index)
    expect(await readFile(join(root, '.git', 'taskcontinuum-onboarding.json'))).toEqual(record)
    expectReadOnly(fixture.calls)
  }, 30000)

  it('guides existing repositories with matching origin without relying on an onboarding record', async () => {
    const fixture = await created()
    await rm(join(fixture.root, '.git', 'taskcontinuum-onboarding.json'))
    await fixture.git(fixture.root, 'remote', 'add', 'origin', remote)
    await fixture.git(fixture.root, 'config', '--local', 'remote.origin.pushurl', remote)
    await fixture.git(fixture.root, 'config', '--file', fixture.config, 'filter.lfs.clean', 'false')
    fixture.calls.length = 0
    const plan = await fixture.service.preparePush(fixture.workspace, remote)
    expect(plan.commands).not.toContain('remote add')
    expect(plan.commands.split('\n')).toHaveLength(1)
    expect((await fixture.service.status(fixture.workspace)).remoteUrl).toBe(remote)
    expectReadOnly(fixture.calls)
  }, 30000)

  it('stops copied commands when adding origin fails and preserves quoted arguments', async () => {
    const fixture = await created()
    const root = join(fixture.parent, "user's $tasks folder")
    await rename(fixture.root, root)
    const plan = await fixture.service.preparePush({ ...fixture.workspace, root }, remote)
    for (const exitCode of [1, 0]) {
      // Shadow Git inside a profile-free shell: no actual Git, credentials or network are used.
      const script = plan.shell === 'powershell'
        ? `$script:gitCalls = @()\nfunction git { $script:gitCalls += ,@($args); $global:LASTEXITCODE = ${exitCode} }\n${plan.commands}\nConvertTo-Json -InputObject @($script:gitCalls) -Compress`
        : `git() { for arg; do printf '<%s>' "$arg"; done; printf '\\n'; return ${exitCode}; }\n${plan.commands}\n:`
      const { stdout } = await promisify(execFile)(
        plan.shell === 'powershell' ? 'powershell.exe' : 'sh',
        plan.shell === 'powershell' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script] : ['-c', script],
        { timeout: 10000, windowsHide: true },
      )
      if (plan.shell === 'powershell') {
        const calls = JSON.parse(stdout) as string[][]
        expect(calls).toHaveLength(exitCode === 0 ? 2 : 1)
        // PowerShell consumes the parameter separator when invoking a function rather than a native executable.
        expect(calls[0]).toEqual(['-C', root, 'remote', 'add', 'origin', remote])
        if (exitCode === 0) expect(calls[1]).toEqual(['-C', root, 'push', '--no-follow-tags', '--recurse-submodules=no', '-u', 'origin', 'refs/heads/main:refs/heads/main'])
      } else {
        const calls = stdout.trim().split('\n')
        expect(calls).toHaveLength(exitCode === 0 ? 2 : 1)
        expect(calls[0]).toBe(`<-C><${root}><remote><add><--><origin><${remote}>`)
        if (exitCode === 0) expect(calls[1]).toContain('<push>')
      }
    }
    expect(await fixture.git(root, 'remote')).toBe('')
  }, 30000)

  it('rejects remote mismatches, URL rewrites, mirror mode, multiple URLs and conflicting upstreams', async () => {
    const fixture = await created()
    await fixture.git(fixture.root, 'remote', 'add', 'origin', remote)
    await expect(fixture.service.preparePush(fixture.workspace, 'https://github.com/another/wrong.git')).rejects.toThrow('does not match')
    for (const [key, value] of [
      ['remote.origin.pushurl', 'https://github.com/another/wrong.git'],
      ['remote.origin.mirror', 'true'], ['push.mirror', 'true'], ['remote.origin.push', 'refs/heads/main:refs/heads/wrong'],
      ['url.https://github.com/another/.insteadOf', 'https://github.com/'],
      ['url.https://github.com/another/.pushInsteadOf', 'https://github.com/'],
      ['branch.main.remote', 'upstream'],
    ]) {
      await fixture.git(fixture.root, 'config', '--local', key, value)
      await expect(fixture.service.preparePush(fixture.workspace, remote)).rejects.toThrow()
      await fixture.git(fixture.root, 'config', '--local', '--unset-all', key)
    }
    await fixture.git(fixture.root, 'config', '--local', '--add', 'remote.origin.url', remote)
    await expect(fixture.service.status(fixture.workspace)).rejects.toThrow('ambiguous')
    expect(fixture.calls.some((call) => call.args.includes('ls-remote') || call.args.includes('push'))).toBe(false)
  }, 60000)

  it('rejects dirty, detached, unborn and parent-only repositories instead of staging or guessing', async () => {
    const fixture = await created()
    fixture.calls.length = 0
    await writeFile(join(fixture.root, 'private.txt'), 'do not stage')
    await expect(fixture.service.preparePush(fixture.workspace, remote)).rejects.toThrow('uncommitted')
    await rm(join(fixture.root, 'private.txt'))
    await fixture.git(fixture.root, 'checkout', '--quiet', '--detach')
    await expect(fixture.service.preparePush(fixture.workspace, remote)).rejects.toThrow('detached')
    const empty = join(fixture.parent, 'empty')
    await mkdir(empty)
    await fixture.git(empty, 'init', '--quiet', '--initial-branch=main')
    await expect(fixture.service.preparePush({ ...fixture.workspace, root: empty }, remote)).rejects.toThrow('no commit')
    const child = join(empty, 'child')
    await mkdir(child)
    expect((await fixture.service.status({ ...fixture.workspace, root: child })).branch).toBeNull()
    await expect(fixture.service.preparePush({ ...fixture.workspace, root: child }, remote)).rejects.toThrow('no local Git')
    expectReadOnly(fixture.calls)
  }, 30000)

  it('rejects linked root and Git directories, filters and arbitrary credential commands', async () => {
    const fixture = await created()
    const linked = join(fixture.parent, 'linked')
    await symlink(fixture.root, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(fixture.service.preparePush({ ...fixture.workspace, root: linked }, remote)).rejects.toThrow('directories')
    await fixture.git(fixture.root, 'remote', 'add', 'origin', remote)
    await fixture.git(fixture.root, 'config', '--local', 'filter.unsafe.clean', 'echo should-not-run')
    await writeFile(join(fixture.root, '.gitattributes'), '* filter=unsafe\n')
    await expect(fixture.service.preparePush(fixture.workspace, remote)).rejects.toThrow('filters')
    await rm(join(fixture.root, '.gitattributes'))
    await fixture.git(fixture.root, 'config', '--local', '--unset', 'filter.unsafe.clean')
    await fixture.git(fixture.root, 'config', '--local', 'credential.helper', '!echo private-fixture-marker')
    await expect(fixture.service.verifyPublication(fixture.workspace, remote)).rejects.toThrow('arbitrary shell')
    await fixture.git(fixture.root, 'config', '--local', 'credential.helper', 'C:/safe\necho private-fixture-marker\n/git-credential-manager.exe')
    await expect(fixture.service.verifyPublication(fixture.workspace, remote)).rejects.toThrow('arbitrary shell')
    expect(fixture.calls.some((call) => call.args.includes('ls-remote'))).toBe(false)
    await rename(join(fixture.root, '.git'), join(fixture.parent, 'linked-git'))
    await symlink(join(fixture.parent, 'linked-git'), join(fixture.root, '.git'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(fixture.service.status(fixture.workspace)).rejects.toThrow('directories')
  }, 30000)
})

describe('explicit read-only publication verification', () => {
  it('retains GCM, verifies actual branch HEAD, ignores tracking refs and never writes publication state', async () => {
    const fixture = await created()
    await fixture.git(fixture.root, 'config', '--file', fixture.config, 'credential.helper', 'manager')
    await fixture.git(fixture.root, 'remote', 'add', 'origin', remote)
    await fixture.git(fixture.root, 'switch', '--quiet', '-c', 'reviewed/branch')
    const head = await fixture.git(fixture.root, 'rev-parse', 'HEAD')
    const recordFile = join(fixture.root, '.git', 'taskcontinuum-onboarding.json')
    const record = JSON.parse(await readFile(recordFile, 'utf8'))
    record.publication = { owner: 'old-owner', published: true }
    await writeFile(recordFile, JSON.stringify(record))
    const beforeRecord = await readFile(recordFile)
    await fixture.git(fixture.root, 'update-ref', 'refs/remotes/origin/reviewed/branch', head)
    const config = await readFile(join(fixture.root, '.git', 'config'))
    const global = await readFile(fixture.config)
    fixture.calls.length = 0
    expect(await fixture.service.status(fixture.workspace)).toMatchObject({ credentialHelper: 'gcm', remoteUrl: remote })
    expect(fixture.calls.some((call) => call.args.includes('ls-remote'))).toBe(false)
    await expect(fixture.service.verifyPublication(fixture.workspace, remote)).rejects.toThrow('not on GitHub')
    fixture.network.refs.set('refs/heads/reviewed/branch', head)
    fixture.network.refs.set('refs/heads/unrelated', 'a'.repeat(40))
    expect(await fixture.service.verifyPublication(fixture.workspace, remote)).toEqual({ url: 'https://github.com/lianc_microsoft/browser-chosen-name' })
    expect((await new WorkspaceRepositoryService(fixture.run).status(fixture.workspace)).remoteUrl).toBe(remote)
    expect(await readFile(recordFile)).toEqual(beforeRecord)
    expect(await readFile(join(fixture.root, '.git', 'config'))).toEqual(config)
    expect(await readFile(fixture.config)).toEqual(global)
    expectReadOnly(fixture.calls)
    const network = fixture.calls.filter((call) => call.args.includes('ls-remote'))
    expect(network).toHaveLength(2)
    expect(network[0].args.slice(-5)).toEqual(['ls-remote', '--refs', '--', remote, 'refs/heads/reviewed/branch'])
  }, 60000)

  it('sanitizes authentication/network failures and rejects a remote branch at another commit', async () => {
    const fixture = await created()
    await fixture.git(fixture.root, 'remote', 'add', 'origin', remote)
    fixture.network.response = { code: 128, stdout: 'private-fixture-marker', stderr: 'https://private-fixture-marker@github.com/' }
    await expect(fixture.service.verifyPublication(fixture.workspace, remote)).rejects.toThrow(/GCM.*EMU.*SSO/)
    await expect(fixture.service.verifyPublication(fixture.workspace, remote)).rejects.not.toThrow('private-fixture-marker')
    fixture.network.response = undefined
    fixture.network.refs.set('refs/heads/main', 'a'.repeat(40))
    await expect(fixture.service.verifyPublication(fixture.workspace, remote)).rejects.toThrow('does not match the local commit')
  }, 30000)

  it.each(['branch', 'head', 'origin', 'pushurl'])('rejects a concurrent %s change during the explicit remote check', async (kind) => {
    const fixture = await created()
    await fixture.git(fixture.root, 'remote', 'add', 'origin', remote)
    const head = await fixture.git(fixture.root, 'rev-parse', 'HEAD')
    fixture.network.refs.set('refs/heads/main', head)
    fixture.network.before = async (call) => {
      if (!call.args.includes('ls-remote')) return
      if (kind === 'branch') await fixture.git(fixture.root, 'switch', '--quiet', '-c', 'another')
      if (kind === 'head') await fixture.git(fixture.root, 'commit', '--quiet', '--allow-empty', '-m', 'Concurrent reviewed commit')
      if (kind === 'origin') await fixture.git(fixture.root, 'remote', 'set-url', 'origin', 'https://github.com/another/wrong.git')
      if (kind === 'pushurl') await fixture.git(fixture.root, 'config', '--local', 'remote.origin.pushurl', 'https://github.com/another/wrong.git')
    }
    await expect(fixture.service.verifyPublication(fixture.workspace, remote)).rejects.toThrow(/changed|does not match/)
    expect(fixture.calls.filter((call) => call.args.includes('ls-remote'))).toHaveLength(1)
    expect(fixture.calls.some((call) => call.args.includes('push'))).toBe(false)
  }, 30000)
})
