import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { WorkspaceGitReplica } from '../src/main/remoteConfig/workspaceGit'

const exec = promisify(execFile)
const directories: string[] = []
const replicas: WorkspaceGitReplica[] = []
afterEach(async () => {
  for (const replica of replicas.splice(0)) await replica.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function git(root: string, ...args: string[]) {
  return (await exec('git', ['--no-pager', '-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', ...args], { cwd: root, timeout: 30000 })).stdout.trim()
}
async function fixture(initialDescriptor?: string) {
  const root = resolve('.runtime', 'taskcon-upstream-guard', randomUUID())
  await mkdir(root, { recursive: true })
  directories.push(root)
  const remote = join(root, 'remote.git')
  const workspaceRoot = join(root, 'checkout')
  await git(root, 'init', '--bare', '--initial-branch=main', remote)
  await git(root, 'clone', remote, workspaceRoot)
  await git(workspaceRoot, 'config', 'core.autocrlf', 'false')
  await git(workspaceRoot, 'config', 'user.name', 'Fixture')
  await git(workspaceRoot, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(workspaceRoot, 'README.txt'), 'Fixture')
  if (initialDescriptor) {
    await mkdir(join(workspaceRoot, '.taskcontinuum'))
    await writeFile(join(workspaceRoot, '.taskcontinuum', 'workspace.json'), initialDescriptor)
  }
  await git(workspaceRoot, 'add', '.')
  await git(workspaceRoot, 'commit', '-m', 'Initialize test')
  await git(workspaceRoot, 'push', '-u', 'origin', 'main')
  const options = { workspaceRoot, stateDirectory: join(root, 'state') }
  const replica = await WorkspaceGitReplica.open(options)
  replicas.push(replica)
  return { root, remote, workspaceRoot, options, replica }
}
function descriptor() {
  return [{ path: '.taskcontinuum/workspace.json', content: JSON.stringify({ schemaVersion: 1, kind: 'taskcontinuum-workspace', workspaceId: randomUUID(), remoteConfigFormat: 'immutable-operations-v1' }) + '\n' }]
}

it('loads a previously published workspace identity during bootstrap without publishing', async () => {
  const value = descriptor()[0].content
  const { replica, remote, workspaceRoot } = await fixture(value)
  expect(await readFile(join(replica.root, '.taskcontinuum', 'workspace.json'), 'utf8')).toBe(value)
  expect(await git(remote, '--git-dir', remote, 'rev-parse', 'main')).toBe(await git(workspaceRoot, 'rev-parse', 'HEAD'))
}, 30000)

it('follows the current source branch upstream without requiring reenrollment', async () => {
  const { replica, workspaceRoot, remote } = await fixture()
  const before = await git(remote, '--git-dir', remote, 'rev-parse', 'refs/heads/main')
  await git(workspaceRoot, 'switch', '-c', 'feature')
  await git(workspaceRoot, 'branch', '--set-upstream-to', 'origin/main')
  const files = descriptor()
  await replica.assertUpstream()
  await replica.sync(files)
  expect(await git(remote, '--git-dir', remote, 'rev-parse', 'refs/heads/main')).not.toBe(before)
  expect(await git(remote, '--git-dir', remote, 'show', `main:${files[0].path}`)).toBe(files[0].content.trim())
  expect(await git(workspaceRoot, 'branch', '--show-current')).toBe('feature')
}, 30000)

it('checks the branch again after asynchronous validation and before publication', async () => {
  const { replica, workspaceRoot, remote } = await fixture()
  const before = await git(remote, '--git-dir', remote, 'rev-parse', 'refs/heads/main')
  await expect(replica.sync(descriptor(), { validateReplica: async () => { await git(workspaceRoot, 'switch', '-c', 'during-validation') } })).rejects.toMatchObject({ code: 'upstream-changed' })
  expect(await git(remote, '--git-dir', remote, 'rev-parse', 'refs/heads/main')).toBe(before)
}, 30000)

it('restores selected-checkout configuration without an upstream', async () => {
  const { replica, options, workspaceRoot, remote } = await fixture()
  const files = descriptor()
  await replica.sync(files)
  await replica.close()
  await git(workspaceRoot, 'switch', '-c', 'without-upstream')
  const restored = await WorkspaceGitReplica.open({ ...options, prepare: false })
  replicas.push(restored)
  expect(await readFile(join(restored.root, '.taskcontinuum', 'workspace.json'), 'utf8')).toBe(files[0].content)
  const before = await git(remote, '--git-dir', remote, 'rev-parse', 'main')
  await expect(restored.sync()).rejects.toMatchObject({ code: 'upstream' })
  expect(await git(remote, '--git-dir', remote, 'rev-parse', 'main')).toBe(before)
  await git(workspaceRoot, 'branch', '--set-upstream-to', 'origin/main')
  await restored.sync()
  expect(restored.root).toBe(replica.root)
}, 30000)

it('restores cached configuration without contacting an unavailable remote', async () => {
  const { replica, options, remote } = await fixture()
  await replica.sync(descriptor())
  await replica.close()
  await rename(remote, `${remote}.offline`)
  const restored = await WorkspaceGitReplica.open({ ...options, prepare: false })
  replicas.push(restored)
  expect(restored.root).toBe(replica.root)
  await restored.assertUpstream()
  await expect(restored.sync()).rejects.toThrow()
}, 30000)
