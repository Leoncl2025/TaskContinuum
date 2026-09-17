import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceStore } from '../src/main/workspaceStore'
import { readTaskWorkspace } from '../src/main/workspaceReader'
import { repositoryFixture } from './workspace-repository-fixture'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = resolve('.runtime', 'workspace-history-tests', randomUUID())
  roots.push(root)
  await mkdir(root, { recursive: true })
  async function workspace(name: string) {
    const directory = join(root, name)
    await mkdir(join(directory, 'tasks'), { recursive: true })
    await mkdir(join(directory, '.agentdesk'))
    await writeFile(join(directory, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: name }))
    return directory
  }
  const first = await workspace('TaskContinuum-ad')
  const second = await workspace('Another-workspace')
  const profile = join(root, 'profile')
  return { first, second, profile, store: new WorkspaceStore(profile) }
}

describe('selected and recent workspaces', () => {
  it('starts with no selected workspace, recent folders or seeded tasks', async () => {
    const { store, profile } = await fixture()
    expect(await store.getState()).toEqual({ current: null, recent: [] })
    expect(await new WorkspaceStore(profile).getState()).toEqual({ current: null, recent: [] })
  })

  it('switches known roots, retains recents, and restores the last workspace after restart', async () => {
    const { first, second, profile, store } = await fixture()
    const initial = await store.openFolder(first)
    await store.openFolder(second)
    const switched = await store.openRecent(initial.current!.id)
    expect(switched.current?.name).toBe('TaskContinuum-ad')
    expect(switched.recent.map((entry) => entry.name)).toEqual(['TaskContinuum-ad', 'Another-workspace'])
    expect((await new WorkspaceStore(profile).getState()).current?.root).toBe(first)
    expect(JSON.parse(await readFile(join(profile, 'workspaces.json'), 'utf8')).currentId).toBe(initial.current!.id)
  })

  it('keeps the current workspace when a folder is invalid or a recent ID is untrusted', async () => {
    const { first, second, store } = await fixture()
    const initial = await store.openFolder(first)
    await expect(store.openFolder(join(second, 'tasks'))).rejects.toThrow('AgentDesk workspace')
    await expect(store.openRecent(second)).rejects.toThrow('recent list')
    expect((await store.getState()).current?.id).toBe(initial.current?.id)
  })

  it('closes the selected workspace without forgetting recently opened folders', async () => {
    const { first, profile, store } = await fixture()
    await store.openFolder(first)
    await store.closeWorkspace()
    const restored = await new WorkspaceStore(profile).getState()
    expect(restored.current).toBeNull()
    expect(restored.recent).toHaveLength(1)
  })

  it('reports missing startup folders without crashing or silently displaying stale tasks', async () => {
    const { first, profile, store } = await fixture()
    await store.openFolder(first)
    await rm(first, { recursive: true })
    const restored = await new WorkspaceStore(profile).getState()
    expect(restored.current).toBeNull()
    expect(restored.warning).toContain('previous workspace could not be opened')
    expect(restored.recent).toHaveLength(1)
  })

  it('persists a folder selected by the launch environment for ordinary restarts', async () => {
    const { first, profile } = await fixture()
    expect((await new WorkspaceStore(profile, first).getState()).current?.name).toBe('TaskContinuum-ad')
    expect((await new WorkspaceStore(profile).getState()).current?.root).toBe(first)
  })

  it('restores an explicitly empty older saved selection without selecting a recent folder', async () => {
    const { first, profile, store } = await fixture()
    await store.openFolder(first)
    const file = join(profile, 'workspaces.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(file, JSON.stringify({ ...saved, currentId: null }))
    const restored = await new WorkspaceStore(profile).getState()
    expect(restored.current).toBeNull()
    expect(restored.recent).toHaveLength(1)
  })

  it('persists creation and recent selection across restart, without invoking GitHub', async () => {
    const setup = await repositoryFixture()
    const profile = join(setup.root, 'profile')
    const store = new WorkspaceStore(profile, undefined, undefined, setup.service)
    const created = await store.createRepository({ parentPath: setup.root, name: 'created-tasks' })
    expect(created.current?.tasks).toEqual([])
    expect(created.recent.map((entry) => entry.name)).toEqual(['created-tasks'])
    expect((await new WorkspaceStore(profile).getState()).current?.id).toBe(created.current?.id)
    expect(setup.calls.every((call) => call.program === 'git' && !call.args.includes('ls-remote'))).toBe(true)
  }, 30000)

  it('surfaces selection save failures without deleting a successfully created repository or replacing current state', async () => {
    const { first, profile } = await fixture()
    const setup = await repositoryFixture()
    const store = new WorkspaceStore(profile, undefined, undefined, setup.service)
    const before = await store.openFolder(first)
    await rm(join(profile, 'workspaces.json'))
    await mkdir(join(profile, 'workspaces.json'))
    await expect(store.createRepository({ parentPath: setup.root, name: 'recoverable-tasks' })).rejects.toThrow('Use Open existing to recover')
    expect((await store.getState()).current?.id).toBe(before.current?.id)
    expect((await readTaskWorkspace(join(setup.root, 'recoverable-tasks'))).tasks).toEqual([])
    expect(setup.calls.every((call) => call.program === 'git' && !call.args.includes('ls-remote'))).toBe(true)
    await rm(join(profile, 'workspaces.json'), { recursive: true })
    expect((await store.openFolder(join(setup.root, 'recoverable-tasks'))).current?.name).toBe('recoverable-tasks')
  }, 30000)

  it('validates repository inputs and fences status, browser, command planning and verification to the selected workspace', async () => {
    const { first, second, profile } = await fixture()
    const setup = await repositoryFixture()
    const status = vi.spyOn(setup.service, 'status')
    const remoteUrl = 'https://github.com/fixture_emu/tasks.git'
    const verify = vi.spyOn(setup.service, 'verifyPublication').mockResolvedValue({ url: 'https://github.com/fixture_emu/tasks' })
    const creation = vi.spyOn(setup.service, 'creationUrl').mockReturnValue('https://github.com/new?name=tasks')
    const prepare = vi.spyOn(setup.service, 'preparePush').mockImplementation(async (workspace) => ({
      workspaceId: workspace.id, branch: 'main', head: 'a'.repeat(40), remoteUrl, repositoryUrl: 'https://github.com/fixture_emu/tasks',
      shell: 'powershell', commands: 'git push',
    }))
    const store = new WorkspaceStore(profile, undefined, undefined, setup.service)
    const initial = await store.openFolder(first)
    for (const id of [null, first, 'a'.repeat(64)]) {
      await expect(store.getRepositoryStatus(id)).rejects.toThrow()
      await expect(store.getRepositoryCreationUrl(id)).rejects.toThrow()
      await expect(store.getRepositoryPushPlan({ workspaceId: id, remoteUrl })).rejects.toThrow()
      await expect(store.verifyRepositoryPublication({ workspaceId: id, remoteUrl })).rejects.toThrow()
    }
    for (const value of [null, {}, { workspaceId: initial.current!.id, remoteUrl: 1 }, { workspaceId: initial.current!.id, remoteUrl, extra: 'untrusted' }]) {
      await expect(store.getRepositoryPushPlan(value)).rejects.toThrow()
      await expect(store.verifyRepositoryPublication(value)).rejects.toThrow()
    }
    for (const value of [null, {}, { parentPath: setup.root, name: '../escape' }, { parentPath: 1, name: 'valid' }]) await expect(store.createRepository(value)).rejects.toThrow()
    expect(status).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(creation).not.toHaveBeenCalled()
    await store.getRepositoryCreationUrl(initial.current!.id)
    await store.getRepositoryPushPlan({ workspaceId: initial.current!.id, remoteUrl })
    await store.verifyRepositoryPublication({ workspaceId: initial.current!.id, remoteUrl })
    expect(creation).toHaveBeenCalledExactlyOnceWith(initial.current)
    expect(prepare).toHaveBeenCalledExactlyOnceWith(initial.current, remoteUrl)
    expect(verify).toHaveBeenCalledExactlyOnceWith(initial.current, remoteUrl)
    await store.openFolder(second)
    await expect(store.getRepositoryCreationUrl(initial.current!.id)).rejects.toThrow('active workspace changed')
    await expect(store.getRepositoryPushPlan({ workspaceId: initial.current!.id, remoteUrl })).rejects.toThrow('active workspace changed')
    await expect(store.verifyRepositoryPublication({ workspaceId: initial.current!.id, remoteUrl })).rejects.toThrow('active workspace changed')
    await expect(store.getRepositoryStatus(initial.current!.id)).rejects.toThrow('active workspace changed')
    expect(verify).toHaveBeenCalledTimes(1)
    await store.closeWorkspace()
    await expect(store.getRepositoryStatus(initial.current!.id)).rejects.toThrow('active workspace changed')
  })

  it('serializes read-only verification with workspace switching and rejects stale requests after the switch', async () => {
    const { first, second, profile } = await fixture()
    const setup = await repositoryFixture()
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    const verify = vi.spyOn(setup.service, 'verifyPublication').mockImplementation(async () => {
      started()
      await gate
      return { url: 'https://github.com/fixture-owner/tasks' }
    })
    const store = new WorkspaceStore(profile, undefined, undefined, setup.service)
    const initial = await store.openFolder(first)
    const request = { workspaceId: initial.current!.id, remoteUrl: 'https://github.com/fixture_emu/tasks.git' }
    const verifying = store.verifyRepositoryPublication(request)
    await entered
    let switched = false
    const switching = store.openFolder(second).then((state) => { switched = true; return state })
    await Promise.resolve()
    expect(switched).toBe(false)
    release()
    await verifying
    expect((await switching).current?.root).toBe(second)
    await expect(store.verifyRepositoryPublication(request)).rejects.toThrow('active workspace changed')
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('creates and reloads a canonical task without changing Git history or another workspace', async () => {
    const setup = await repositoryFixture()
    const profile = join(setup.root, 'profile')
    const store = new WorkspaceStore(profile, undefined, undefined, setup.service)
    const opened = await store.createRepository({ parentPath: setup.root, name: 'task-creation' })
    const workspace = opened.current!
    const before = await setup.git(workspace.root, 'rev-parse', 'HEAD')
    const context = await store.getTaskCreationContext(workspace.id)
    expect(context.workspaceId).toBe(workspace.id)
    expect(context.members.length).toBeGreaterThan(0)
    const created = await store.createTask({ workspaceId: workspace.id, draft: { title: 'Create a first real task', description: 'Keep the task files canonical.' } })
    expect(created.taskId).toBe('T-0001')
    expect(created.state.current?.tasks.map((task) => task.id)).toEqual(['T-0001'])
    expect(created.state.current?.tasks[0].title).toBe('Create a first real task')
    expect(await setup.git(workspace.root, 'rev-parse', 'HEAD')).toBe(before)
    expect((await new WorkspaceStore(profile).getState()).current?.tasks[0].id).toBe('T-0001')
    await store.closeWorkspace()
    await expect(store.createTask({ workspaceId: workspace.id, draft: { title: 'Stale request' } })).rejects.toThrow('active workspace changed')
    await expect(store.getTaskCreationContext(workspace.id)).rejects.toThrow('active workspace changed')
    await expect(store.getTaskAgentInstructions({ workspaceId: workspace.id, goal: 'Stale request' })).rejects.toThrow('active workspace changed')
    expect((await readTaskWorkspace(workspace.root)).tasks).toHaveLength(1)
  }, 30000)
})