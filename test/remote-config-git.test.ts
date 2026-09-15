// @vitest-environment node
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitReplica } from '../src/main/remoteConfig/git'
import type { GitPublication } from '../src/main/remoteConfig/git'

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

function record(label: string, device = DEVICE): GitPublication {
  const content = JSON.stringify({ schemaVersion: 1, kind: 'device', label }) + '\n'
  const id = createHash('sha256').update(content).digest('hex')
  return { path: `.taskcontinuum/records/v1/devices/${device}/${id}.json`, content }
}

async function git(root: string, ...args: string[]): Promise<string> {
  const bare = await present(join(root, 'objects')) && await present(join(root, 'HEAD')) ? ['--git-dir', root] : []
  const result = await execute('git', ['--no-pager', ...bare, '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true', ...args], {
    cwd: root,
    timeout: 20000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: {
      ...process.env, GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost',
    },
  })
  return result.stdout.trim()
}

async function writeRecord(root: string, file: GitPublication): Promise<void> {
  const pieces = file.path.split('/')
  await mkdir(join(root, ...pieces.slice(0, -1)), { recursive: true })
  await writeFile(join(root, ...pieces), file.content)
}

async function present(file: string): Promise<boolean> {
  try { await access(file); return true } catch { return false }
}

async function fixture(count = 2) {
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
  await writeFile(join(seed, 'staged.txt'), 'Original staged fixture.\n')
  await git(seed, 'add', '--', 'README.md', 'staged.txt')
  await git(seed, 'commit', '--quiet', '-m', 'Initial workspace')
  await git(seed, 'remote', 'add', 'upstream', remote)
  await git(seed, 'push', '--quiet', '--set-upstream', 'upstream', BRANCH)
  const clients: string[] = []
  for (let index = 0; index < count; index++) {
    const client = join(root, `client-${index}`)
    await git(root, 'clone', '--quiet', '--origin', 'upstream', '--branch', BRANCH, '--', remote, client)
    clients.push(client)
  }
  async function replica(index: number, prepare = true) {
    const value = await GitReplica.open({ workspaceRoot: clients[index], stateDirectory: join(root, `state-${index}`), prepare })
    replicas.push(value)
    return value
  }
  return { root, remote, seed, config, clients, replica }
}

describe('app-owned Git configuration replica', () => {
  it('opens with prepare:false without fetching and exposes the same upstream identity across remote names', async () => {
    const setup = await fixture()
    const descriptor = {
      path: '.taskcontinuum/workspace.json',
      content: JSON.stringify({ schemaVersion: 1, kind: 'taskcontinuum-workspace', workspaceId: randomUUID(), remoteConfigFormat: 'immutable-operations-v1' }) + '\n',
    }
    await writeRecord(setup.seed, descriptor)
    await git(setup.seed, 'add', '--', descriptor.path)
    await git(setup.seed, 'commit', '--quiet', '-m', 'Existing published workspace identity')
    await git(setup.seed, 'push', '--quiet')
    await git(setup.clients[1], 'remote', 'rename', 'upstream', 'alternate')
    await git(setup.clients[1], 'remote', 'set-url', 'alternate', join('..', 'remote.git'))
    const offline = `${setup.remote}-offline`
    await rename(setup.remote, offline)
    const a = await setup.replica(0, false)
    const b = await GitReplica.open({ workspaceRoot: setup.clients[1], stateDirectory: join(setup.root, 'state-1'), prepare: false })
    replicas.push(b)
    expect(a.remote).not.toBe(b.remote)
    expect([a.upstreamUrl, a.branch]).toEqual([b.upstreamUrl, b.branch])
    expect(a.upstreamUrl).toBe(setup.remote)
    for (const app of [a, b]) {
      expect(await present(join(app.root, '.taskcontinuum', 'workspace.json'))).toBe(false)
      await expect(git(app.root, 'rev-parse', '--verify', 'HEAD')).rejects.toThrow()
    }
    await rename(offline, setup.remote)
    await Promise.all([a.sync([], { refreshUserCheckout: false }), b.sync([], { refreshUserCheckout: false })])
    for (const app of [a, b]) expect(await readFile(join(app.root, '.taskcontinuum', 'workspace.json'), 'utf8')).toBe(descriptor.content)
  }, 90000)

  it('restores cached canonical state offline and blocks publication until the enrolled upstream is selected', async () => {
    const setup = await fixture(1)
    const app = await setup.replica(0)
    const file = record('available-while-paused')
    const result = await app.sync([file], { refreshUserCheckout: false })
    await app.close()
    await rename(setup.remote, `${setup.remote}-offline`)
    await git(setup.clients[0], 'switch', '--quiet', '--detach')
    const options = {
      workspaceRoot: setup.clients[0], stateDirectory: join(setup.root, 'state-0'),
      cachedRoot: app.root, prepare: false,
    }
    await expect(GitReplica.open(options)).rejects.toMatchObject({ code: 'upstream-changed' })
    await git(setup.clients[0], 'switch', '--quiet', BRANCH)
    const restored = await GitReplica.open(options)
    replicas.push(restored)
    expect(restored.root).toBe(app.root)
    expect(await readFile(join(restored.root, ...file.path.split('/')), 'utf8')).toBe(file.content)
    expect(await git(restored.root, 'rev-parse', 'HEAD')).toBe(result.head)
    await restored.assertUpstream()
    await expect(restored.sync([], { refreshUserCheckout: false })).rejects.toMatchObject({ code: 'git' })
    expect(await readFile(join(restored.root, ...file.path.split('/')), 'utf8')).toBe(file.content)
  }, 90000)

  it('uses the existing tracked upstream, publishes only exact paths, and fast-forwards a clean user checkout', async () => {
    const { replica, remote, clients } = await fixture(1)
    const sourceHead = await git(clients[0], 'rev-parse', 'HEAD')
    const app = await replica(0)
    expect(app.root).not.toBe(clients[0])
    expect(app.remote).toBe('upstream')
    expect(app.branch).toBe(BRANCH)
    expect(app.upstreamUrl).toBe(remote)
    expect(app.upstreamRef).toBe(`refs/heads/${BRANCH}`)
    expect(await present(join(app.root, 'README.md'))).toBe(false)
    const file = record('A identity')
    const descriptor = {
      path: '.taskcontinuum/workspace.json',
      content: JSON.stringify({ schemaVersion: 1, kind: 'taskcontinuum-workspace', workspaceId: DEVICE, remoteConfigFormat: 'immutable-operations-v1' }) + '\n',
    }
    const result = await app.sync([descriptor, file])
    expect(result.userCheckout).toEqual({ state: 'refreshed' })
    expect(result.publishedPaths).toEqual([descriptor.path, file.path])
    expect(result.attempts).toBe(1)
    expect(await git(remote, 'show', `${BRANCH}:${file.path}`)).toBe(file.content.trim())
    expect(await git(remote, 'diff', '--name-only', sourceHead, BRANCH)).toBe([file.path, descriptor.path].sort().join('\n'))
    expect(await readFile(join(clients[0], 'README.md'), 'utf8')).toBe('Original task prose.\n')
    expect(await git(app.root, 'status', '--porcelain')).toBe('')
    expect(await git(clients[0], 'rev-parse', '@{upstream}')).toBe(result.head)
    expect(await git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe(`refs/heads/${BRANCH}`)
    const second = await app.sync([descriptor, file])
    expect(second.head).toBe(result.head)
    expect(second.userCheckout.state).toBe('unchanged')
  }, 60000)

  it('does not require a clean user worktree and never stages or rewrites user edits', async () => {
    const { replica, clients, remote } = await fixture(1)
    await writeFile(join(clients[0], 'README.md'), 'Unstaged task edits.\n')
    await writeFile(join(clients[0], 'staged.txt'), 'Staged task edits.\n')
    await git(clients[0], 'add', '--', 'staged.txt')
    await writeFile(join(clients[0], 'untracked.txt'), 'Untracked user work.\n')
    const unapproved = record('not-in-the-durable-outbox')
    await writeRecord(clients[0], unapproved)
    const before = await git(clients[0], 'status', '--porcelain')
    const sourceHead = await git(clients[0], 'rev-parse', 'HEAD')
    const app = await replica(0)
    const file = record('dirty-user-safe')
    const result = await app.sync([file])
    expect(result.userCheckout.state).toBe('deferred')
    expect(result.userCheckout.reason).toContain('staged')
    expect(await git(clients[0], 'status', '--porcelain')).toBe(before)
    expect(await git(clients[0], 'rev-parse', 'HEAD')).toBe(sourceHead)
    expect(await readFile(join(clients[0], 'README.md'), 'utf8')).toBe('Unstaged task edits.\n')
    expect(await readFile(join(clients[0], 'staged.txt'), 'utf8')).toBe('Staged task edits.\n')
    expect(await readFile(join(clients[0], 'untracked.txt'), 'utf8')).toBe('Untracked user work.\n')
    expect(await present(join(clients[0], ...file.path.split('/')))).toBe(false)
    expect(await readFile(join(app.root, ...file.path.split('/')), 'utf8')).toBe(file.content)
    await expect(git(remote, 'cat-file', '-e', `${BRANCH}:${unapproved.path}`)).rejects.toThrow()
  }, 60000)

  it('preserves unpublished user commits, changed branches, and in-progress operations', async () => {
    const { replica, clients } = await fixture(3)
    await writeFile(join(clients[0], 'README.md'), 'Unpublished work.\n')
    await git(clients[0], 'commit', '--quiet', '-am', 'Private user commit')
    const privateHead = await git(clients[0], 'rev-parse', 'HEAD')
    const apps = await Promise.all([replica(0), replica(1), replica(2)])
    await git(clients[1], 'switch', '--quiet', '--create', 'my-other-work')
    await writeFile(join(clients[2], '.git', 'MERGE_HEAD'), `${await git(clients[2], 'rev-parse', 'HEAD')}\n`)
    const first = await apps[0].sync([record('not-user-commit')])
    expect(first.userCheckout.reason).toContain('unpublished')
    expect(await git(clients[0], 'rev-parse', 'HEAD')).toBe(privateHead)
    await expect(apps[1].sync()).rejects.toMatchObject({ code: 'upstream-changed' })
    expect(await git(clients[1], 'branch', '--show-current')).toBe('my-other-work')
    expect((await apps[2].sync()).userCheckout.reason).toContain('in progress')
    expect(await present(join(clients[2], '.git', 'MERGE_HEAD'))).toBe(true)
  }, 90000)

  it('converges across three independent clones and retries a real concurrent push rejection', async () => {
    const { replica, remote } = await fixture(3)
    const [a, b, c] = await Promise.all([replica(0), replica(1), replica(2)])
    const files = [record('A-to-B'), record('B-to-A'), record('C-to-A')]
    let advanced = false
    const raced = await a.sync([files[0]], {
      refreshUserCheckout: false,
      validateReplica: async () => {
        if (!advanced) {
          advanced = true
          await Promise.all([
            b.sync([files[1]], { refreshUserCheckout: false }),
            c.sync([files[2]], { refreshUserCheckout: false }),
          ])
        }
      },
    })
    expect(raced.attempts).toBeGreaterThan(1)
    await Promise.all([a.sync(), b.sync(), c.sync()])
    for (const app of [a, b, c]) {
      for (const file of files) expect(await readFile(join(app.root, ...file.path.split('/')), 'utf8')).toBe(file.content)
      expect(await git(app.root, 'status', '--porcelain')).toBe('')
    }
    expect(await git(a.root, 'rev-parse', 'HEAD')).toBe(await git(b.root, 'rev-parse', 'HEAD'))
    expect(await git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe(`refs/heads/${BRANCH}`)
  }, 120000)

  it('bounds push-race recovery to three attempts and retains records for a later cycle', async () => {
    const { replica, remote } = await fixture()
    const a = await replica(0)
    const b = await replica(1)
    const upstreamCheck = vi.spyOn(a, 'assertUpstream')
    let races = 0
    const pending = record('retry-after-three-races')
    await expect(a.sync([pending], {
      refreshUserCheckout: false,
      validateReplica: async () => {
        races++
        await b.sync([record(`competitor-${races}`)], { refreshUserCheckout: false })
      },
    })).rejects.toMatchObject({ code: 'push-rejected' })
    expect(races).toBe(3)
    expect(upstreamCheck).toHaveBeenCalledTimes(6)
    expect(await readFile(join(a.root, ...pending.path.split('/')), 'utf8')).toBe(pending.content)
    const recovered = await a.sync([pending], { refreshUserCheckout: false })
    expect(recovered.attempts).toBe(1)
    expect(recovered.publishedPaths).toEqual([pending.path])
    expect(await git(remote, 'show', `${BRANCH}:${pending.path}`)).toBe(pending.content.trim())
  }, 120000)

  it('recovers an app commit after an offline push and process restart without recreating records', async () => {
    const setup = await fixture(1)
    const app = await setup.replica(0)
    const file = record('durable-pending')
    const offline = `${setup.remote}-offline`
    await expect(app.sync([file], {
      refreshUserCheckout: false,
      validateReplica: async () => { await rename(setup.remote, offline) },
    })).rejects.toMatchObject({ code: 'git' })
    await app.close()
    await rename(offline, setup.remote)
    const reopened = await setup.replica(0)
    expect(reopened.root).toBe(app.root)
    await reopened.sync([], { refreshUserCheckout: false })
    expect(await git(setup.remote, 'show', `${BRANCH}:${file.path}`)).toBe(file.content.trim())
    const firstHead = await git(setup.remote, 'rev-parse', BRANCH)
    const repeated = await reopened.sync([file], { refreshUserCheckout: false })
    expect(repeated.head).toBe(firstHead)
    expect(repeated.publishedPaths).toEqual([file.path])
  }, 90000)

  it.each(['modify', 'remove', 'revert-modification'] as const)('blocks historical immutable %s, including changes reverted before the next poll', async (operation) => {
    const { replica, seed } = await fixture(1)
    const app = await replica(0)
    const file = record('immutable-history')
    await app.sync([file], { refreshUserCheckout: false })
    await git(seed, 'pull', '--quiet', '--ff-only')
    if (operation === 'remove') await git(seed, 'rm', '--quiet', '--', file.path)
    else {
      await writeRecord(seed, { ...file, content: '{"changed":true}\n' })
      await git(seed, 'add', '--', file.path)
    }
    await git(seed, 'commit', '--quiet', '-m', 'Tamper with history')
    if (operation === 'revert-modification') {
      await writeRecord(seed, file)
      await git(seed, 'commit', '--quiet', '-am', 'Restore bytes without erasing the tamper')
    }
    await git(seed, 'push', '--quiet')
    await expect(app.sync()).rejects.toMatchObject({ code: 'integrity' })
    expect(await readFile(join(app.root, ...file.path.split('/')), 'utf8')).toBe(file.content)
  }, 90000)

  it('retains the accepted frontier across upstream rollback and recovers when the proper history returns', async () => {
    const { replica, remote, clients } = await fixture(1)
    const original = await git(clients[0], 'rev-parse', 'HEAD')
    const app = await replica(0)
    const file = record('accepted-frontier')
    const result = await app.sync([file], { refreshUserCheckout: false })
    await git(remote, 'update-ref', `refs/heads/${BRANCH}`, original)
    await expect(app.sync()).rejects.toMatchObject({ code: 'integrity' })
    await app.close()
    const stale = await replica(0, false)
    expect(await readFile(join(stale.root, ...file.path.split('/')), 'utf8')).toBe(file.content)
    await expect(stale.sync()).rejects.toMatchObject({ code: 'integrity' })
    await stale.close()
    await git(remote, 'update-ref', `refs/heads/${BRANCH}`, result.head)
    const reopened = await replica(0)
    expect((await reopened.sync([file], { refreshUserCheckout: false })).head).toBe(result.head)
  }, 90000)

  it('rejects immutable collisions, unsafe paths, invalid JSON, executable fields and credentials without leaking their bytes', async () => {
    const { replica } = await fixture(1)
    const app = await replica(0)
    const file = record('same-id')
    const descriptor = { path: '.taskcontinuum/workspace.json', content: JSON.stringify({ workspaceId: DEVICE }) }
    await app.sync([descriptor, file], { refreshUserCheckout: false })
    const rejected = [
      { path: '../../outside.json', content: '{}' },
      { path: '.taskcontinuum\\records\\v1\\bad.json', content: '{}' },
      { path: 'README.md', content: '{}' },
      { ...descriptor, content: JSON.stringify({ workspaceId: randomUUID() }) },
      { ...file, content: '{"changed":true}' },
      { ...record('bad-json'), content: '{broken' },
      { ...record('private'), content: '{"privateKey":"not-for-git"}' },
      { ...record('token'), content: '{"token":"not-for-git"}' },
      { ...record('command'), content: '{"command":"do-not-run"}' },
      { ...record('url'), content: '{"url":"https://user:not-for-git@example.invalid/repo"}' },
    ]
    for (const proposal of rejected) {
      try {
        await app.sync([proposal])
        throw new Error('Expected publication to be rejected')
      } catch (error) {
        expect(error).toMatchObject({ code: 'integrity' })
        expect((error as Error).message).not.toContain('not-for-git')
        expect((error as Error).message).not.toContain('do-not-run')
      }
    }
  }, 60000)

  it('disables hooks and configured repository filters while staging only byte-exact public records', async () => {
    const { replica, seed, clients } = await fixture(1)
    await writeFile(join(seed, '.gitattributes'), '*.json filter=untrusted\n')
    await git(seed, 'add', '--', '.gitattributes')
    await git(seed, 'commit', '--quiet', '-m', 'Attributes fixture')
    await git(seed, 'push', '--quiet')
    await git(clients[0], 'pull', '--quiet', '--ff-only')
    for (const hook of ['pre-commit', 'post-commit', 'pre-push', 'post-checkout', 'post-merge']) {
      await writeFile(join(clients[0], '.git', 'hooks', hook), '#!/bin/sh\nprintf invoked > hook-invoked.txt\nexit 73\n', { mode: 0o755 })
    }
    await git(clients[0], 'config', 'filter.untrusted.clean', 'invalid-taskcon-fixture-command')
    await git(clients[0], 'config', 'filter.untrusted.smudge', 'invalid-taskcon-fixture-command')
    const app = await replica(0)
    await mkdir(join(app.root, '.git', 'hooks'), { recursive: true })
    for (const hook of ['pre-commit', 'post-commit', 'pre-push', 'post-checkout', 'post-merge']) {
      await writeFile(join(app.root, '.git', 'hooks', hook), '#!/bin/sh\nprintf invoked > hook-invoked.txt\nexit 73\n', { mode: 0o755 })
    }
    await git(app.root, 'config', 'filter.untrusted.clean', 'invalid-taskcon-fixture-command')
    await git(app.root, 'config', 'filter.untrusted.smudge', 'invalid-taskcon-fixture-command')
    const file = record('hooks-disabled')
    const result = await app.sync([file])
    expect(result.userCheckout.state).toBe('deferred')
    expect(await present(join(app.root, 'hook-invoked.txt'))).toBe(false)
    expect(await present(join(clients[0], 'hook-invoked.txt'))).toBe(false)
    expect(await readFile(join(app.root, ...file.path.split('/')), 'utf8')).toBe(file.content)
    await git(clients[0], 'config', '--unset-all', 'filter.untrusted.clean')
    await git(clients[0], 'config', '--unset-all', 'filter.untrusted.smudge')
    expect((await app.sync()).userCheckout.state).toBe('refreshed')
    expect(await present(join(clients[0], 'hook-invoked.txt'))).toBe(false)
  }, 90000)

  it('rejects detached or untracked source branches without guessing main or publishing a new branch', async () => {
    const { replica, clients, remote } = await fixture(1)
    await git(clients[0], 'switch', '--quiet', '--detach')
    await expect(replica(0)).rejects.toMatchObject({ code: expect.stringMatching(/upstream|git/) })
    await git(clients[0], 'switch', '--quiet', '--create', 'not-tracked')
    await expect(replica(0)).rejects.toMatchObject({ code: 'upstream' })
    expect(await git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe(`refs/heads/${BRANCH}`)
  }, 60000)

  it('blocks publication after a source-branch switch even when the new branch tracks the same upstream', async () => {
    const setup = await fixture(1)
    const app = await setup.replica(0)
    const before = await git(setup.remote, 'rev-parse', BRANCH)
    await git(setup.clients[0], 'switch', '--quiet', '--create', 'another-local-branch', '--track', `upstream/${BRANCH}`)
    await expect(app.assertUpstream()).rejects.toMatchObject({ code: 'upstream-changed' })
    const file = record('must-not-publish-from-another-branch')
    await expect(app.sync([file])).rejects.toMatchObject({ code: 'upstream-changed' })
    expect(await git(setup.remote, 'rev-parse', BRANCH)).toBe(before)
    expect(await present(join(app.root, ...file.path.split('/')))).toBe(false)
    await app.close()
    await expect(GitReplica.open({
      workspaceRoot: setup.clients[0], stateDirectory: join(setup.root, 'state-0'), cachedRoot: app.root, prepare: false,
    })).rejects.toMatchObject({ code: 'upstream-changed' })
    expect(await git(setup.remote, 'rev-parse', BRANCH)).toBe(before)
  }, 60000)

  it('checks the original source branch again after reconciliation, before pushing captured records', async () => {
    const setup = await fixture(1)
    const app = await setup.replica(0)
    const before = await git(setup.remote, 'rev-parse', BRANCH)
    const file = record('branch-changed-after-fetch')
    await expect(app.sync([file], {
      refreshUserCheckout: false,
      onPulled: async () => { await git(setup.clients[0], 'switch', '--quiet', '--create', 'changed-during-validation', '--track', `upstream/${BRANCH}`) },
    })).rejects.toMatchObject({ code: 'upstream-changed' })
    expect(await git(setup.remote, 'rev-parse', BRANCH)).toBe(before)
    expect(await readFile(join(app.root, ...file.path.split('/')), 'utf8')).toBe(file.content)
    await git(setup.clients[0], 'switch', '--quiet', BRANCH)
    const recovered = await app.sync([file], { refreshUserCheckout: false })
    expect(recovered.publishedPaths).toEqual([file.path])
    expect(await git(setup.remote, 'show', `${BRANCH}:${file.path}`)).toBe(file.content.trim())
  }, 90000)

  it('serializes multiple owners of the same replica and safely reclaims a dead process lock', async () => {
    const setup = await fixture(1)
    const a = await setup.replica(0)
    const b = await setup.replica(0)
    expect(a.root).toBe(b.root)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((done) => { release = done })
    const running = new Promise<void>((done) => { entered = done })
    const callbacks: string[] = []
    const first = a.sync([record('shared-owner-a')], {
      refreshUserCheckout: false,
      validateReplica: async () => { callbacks.push('a'); entered(); await gate },
    })
    await running
    const second = b.sync([record('shared-owner-b')], {
      refreshUserCheckout: false,
      validateReplica: async () => { callbacks.push('b') },
    })
    expect(callbacks).toEqual(['a'])
    release()
    await Promise.all([first, second])
    expect(callbacks).toEqual(['a', 'b'])
    await Promise.all([a.close(), b.close()])
    const child = await execute(process.execPath, ['-p', 'process.pid'], { cwd: setup.root, timeout: 10000 })
    const lock = join(dirname(a.root), 'lock.json')
    await writeFile(lock, JSON.stringify({ pid: Number(child.stdout.trim()), host: hostname() }))
    const recovered = await setup.replica(0)
    expect(await present(lock)).toBe(false)
    expect((await recovered.sync([], { refreshUserCheckout: false })).publishedPaths).toEqual([])
  }, 90000)

  it('refuses unsafe state locations and untracked replica data, and never recreates a deleted upstream branch', async () => {
    const setup = await fixture(1)
    const unsafe = join(setup.clients[0], 'private-replica')
    await expect(GitReplica.open({ workspaceRoot: setup.clients[0], stateDirectory: unsafe })).rejects.toMatchObject({ code: 'git' })
    expect(await present(unsafe)).toBe(false)
    const app = await setup.replica(0)
    const unexpected = record('untracked-replica-record')
    await writeRecord(app.root, unexpected)
    await expect(app.sync([], { refreshUserCheckout: false })).rejects.toMatchObject({ code: 'integrity' })
    await rm(join(app.root, ...unexpected.path.split('/')))
    await git(setup.remote, 'update-ref', '-d', `refs/heads/${BRANCH}`)
    await expect(app.sync([record('branch-removed')], { refreshUserCheckout: false })).rejects.toMatchObject({ code: 'git' })
    expect(await git(setup.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe('')
  }, 90000)

  it('reconciles pulled records before pushing and rejects mutations made by a read-only callback', async () => {
    const setup = await fixture()
    const [a, b] = await Promise.all([setup.replica(0), setup.replica(1)])
    const remoteRecord = record('pulled-core-record')
    const localRecord = record('publish-after-reconciliation')
    const descriptor = { path: '.taskcontinuum/workspace.json', content: JSON.stringify({ workspaceId: DEVICE }) }
    await b.sync([descriptor, remoteRecord], { refreshUserCheckout: false })
    const onPulled = vi.fn(async (root: string) => {
      expect(root).toBe(a.root)
      expect(JSON.parse(await readFile(join(root, '.taskcontinuum', 'workspace.json'), 'utf8')).workspaceId).toBe(DEVICE)
      expect(await readFile(join(root, ...remoteRecord.path.split('/')), 'utf8')).toBe(remoteRecord.content)
      expect(await readFile(join(root, ...localRecord.path.split('/')), 'utf8')).toBe(localRecord.content)
      await expect(git(setup.remote, 'cat-file', '-e', `${BRANCH}:${localRecord.path}`)).rejects.toThrow()
    })
    const result = await a.sync([localRecord], { onPulled, refreshUserCheckout: false })
    expect(onPulled).toHaveBeenCalledTimes(1)
    expect(result.publishedPaths).toEqual([localRecord.path])
    const changed = record('callback-must-not-change-the-validated-tree')
    await expect(a.sync([changed], {
      refreshUserCheckout: false,
      onPulled: async (root) => { await writeRecord(root, { ...changed, content: '{"modified":true}\n' }) },
    })).rejects.toMatchObject({ code: 'integrity' })
    expect(await git(setup.remote, 'rev-parse', BRANCH)).toBe(result.head)
  }, 90000)

  it('does not reclaim a lock or clean a clone with a mismatched ownership marker', async () => {
    const setup = await fixture(1)
    const app = await setup.replica(0)
    await app.close()
    const directory = dirname(app.root)
    const marker = join(directory, 'owner.json')
    const lock = join(directory, 'lock.json')
    await writeFile(marker, '{"version":1,"workspaceRoot":"a-different-workspace"}')
    await writeFile(lock, 'An unrelated owner keeps this lock.\n')
    await expect(setup.replica(0)).rejects.toMatchObject({ code: 'integrity' })
    expect(await readFile(lock, 'utf8')).toBe('An unrelated owner keeps this lock.\n')
    expect(await present(join(app.root, '.git', 'HEAD'))).toBe(true)
  }, 60000)

  it('supports cancellation and enforces finite Git command output and time limits', async () => {
    const { replica, root, clients, seed } = await fixture(1)
    const app = await replica(0)
    const controller = new AbortController()
    await expect(app.sync([record('cancelled')], {
      signal: controller.signal,
      validateReplica: async () => { controller.abort() },
    })).rejects.toMatchObject({ code: 'cancelled' })
    await expect(GitReplica.open({ workspaceRoot: clients[0], stateDirectory: join(root, 'timeout-state'), commandTimeoutMs: 1 })).rejects.toMatchObject({ code: 'timeout' })
    for (let n = 0; n < 30; n++) await writeRecord(seed, record(`bounded-output-${n}`))
    await git(seed, 'add', '--', '.taskcontinuum')
    await git(seed, 'commit', '--quiet', '-m', 'Bounded output fixture')
    await git(seed, 'push', '--quiet')
    const bounded = await GitReplica.open({ workspaceRoot: clients[0], stateDirectory: join(root, 'bounded-state'), maxOutputBytes: 1024, prepare: false })
    replicas.push(bounded)
    await expect(bounded.sync([], { refreshUserCheckout: false })).rejects.toMatchObject({ code: 'output-limit' })
  }, 90000)
})
