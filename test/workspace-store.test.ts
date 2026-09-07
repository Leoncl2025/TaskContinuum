import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/main/workspaceStore'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-history-'))
  roots.push(root)
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

  it('can return to demo mode without forgetting recently opened folders', async () => {
    const { first, profile, store } = await fixture()
    await store.openFolder(first)
    await store.useDemo()
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
})