import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/main/workspaceStore'
import { sessionLinksPath } from '../src/shared/sessionBindings'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-workspace-links-'))
  directories.push(root)
  const taskDirectory = join(root, 'tasks', 'T-0002-session-links')
  await mkdir(taskDirectory, { recursive: true })
  await mkdir(join(root, '.agentdesk'))
  await writeFile(join(root, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Link test' }))
  const taskFile = join(taskDirectory, 'task.json')
  const original = JSON.stringify({ schemaVersion: '1.0', id: 'T-0002', title: 'Session links', type: 'feature', status: 'backlog', priority: 'P2', relations: { level: 'task', parent: null } })
  await writeFile(taskFile, original)
  const store = new WorkspaceStore(join(root, 'profile'))
  const workspace = (await store.openFolder(root)).current!
  return { root, taskFile, original, store, workspace }
}

describe('workspace-scoped repository link writes', () => {
  it('writes only link metadata for a known task in the selected workspace', async () => {
    const { root, taskFile, original, store, workspace } = await fixture()
    const saved = await store.updateSessionLink({ workspaceId: workspace.id, taskId: 'T-0002', sessionId: 'native-session', expectedRevision: null })
    expect((await store.getSessionLinks(workspace.id)).revision).toBe(saved.revision)
    expect(JSON.parse(await readFile(join(root, sessionLinksPath), 'utf8')).bindings['T-0002'].sessionId).toBe('native-session')
    expect(await readFile(taskFile, 'utf8')).toBe(original)
    const newProfile = new WorkspaceStore(join(root, 'another-profile'))
    await newProfile.openFolder(root)
    expect(await newProfile.getSessionLinks(workspace.id)).toEqual(saved)
  })

  it('rejects stale workspace IDs, arbitrary paths, and nonexistent tasks', async () => {
    const { root, store, workspace } = await fixture()
    const request = { workspaceId: workspace.id, taskId: 'T-0002', sessionId: 'native-session', expectedRevision: null }
    await expect(store.updateSessionLink({ ...request, taskId: 'T-0999' })).rejects.toThrow('no longer exists')
    await expect(store.getSessionLinks(root)).rejects.toThrow('active workspace changed')
    await store.useDemo()
    await expect(store.updateSessionLink(request)).rejects.toThrow('active workspace changed')
  })

  it('persists the original VS Code source and identity across desktop profiles', async () => {
    const { root, taskFile, original, store, workspace } = await fixture()
    const saved = await store.updateSessionLink({ workspaceId: workspace.id, taskId: 'T-0002', sessionId: 'original-chat', vscodeWorkspaceStorageId: 'a'.repeat(32), expectedRevision: null })
    expect(saved.document.bindings['T-0002']).toEqual({ provider: 'vscode-copilot', sessionId: 'original-chat', workspaceStorageId: 'a'.repeat(32) })
    const next = new WorkspaceStore(join(root, 'another-profile'))
    await next.openFolder(root)
    expect(await next.getSessionLinks(workspace.id)).toEqual(saved)
    expect(await readFile(taskFile, 'utf8')).toBe(original)
  })

  it('validates every migrated task and removes metadata without deleting native sessions', async () => {
    const { store, workspace } = await fixture()
    await expect(store.migrateSessionLinks({ workspaceId: workspace.id, bindings: { 'T-0999': { provider: 'github-copilot', sessionId: 'missing-task' } } })).rejects.toThrow('no longer exists')
    const migrated = await store.migrateSessionLinks({ workspaceId: workspace.id, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'native-session' } } })
    const removed = await store.updateSessionLink({ workspaceId: workspace.id, taskId: 'T-0002', sessionId: null, expectedRevision: migrated.revision })
    expect(removed.document.bindings).toEqual({})
  })
})