import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceStore } from '../src/main/workspaceStore'
import { locallyLinkedAgentHostSessions } from '../src/main/linkedSessionPolicy'
import { readClientIdentity } from '../src/main/clientIdentity'
import type { AgentHostTarget } from '../src/shared/agentHost'
import { agentHostTargetFixture, createImmutableBindingsFixture } from './immutable-bindings-fixture'

const directories: string[] = []
const backends: Array<Awaited<ReturnType<typeof createImmutableBindingsFixture>>> = []
afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(legacyContent?: string) {
  const root = await mkdtemp(join(tmpdir(), 'taskcontinuum-workspace-links-'))
  directories.push(root)
  const taskDirectory = join(root, 'tasks', 'T-0002-session-links')
  await mkdir(taskDirectory, { recursive: true })
  await mkdir(join(root, '.agentdesk'))
  await writeFile(join(root, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Link test' }))
  const taskFile = join(taskDirectory, 'task.json')
  const original = JSON.stringify({ schemaVersion: '1.0', id: 'T-0002', title: 'Session links', type: 'feature', status: 'backlog', priority: 'P2', relations: { level: 'task', parent: null } })
  await writeFile(taskFile, original)
  const legacyFile = join(root, '.taskcontinuum', 'session-bindings.json')
  if (legacyContent !== undefined) {
    await mkdir(join(root, '.taskcontinuum'), { recursive: true })
    await writeFile(legacyFile, legacyContent)
  }
  const history = join(root, 'code', 'a'.repeat(32), 'chatSessions')
  await mkdir(history, { recursive: true })
  const sessionFile = join(history, 'original-chat.json')
  const sessionContent = JSON.stringify({ requests: [] })
  await writeFile(sessionFile, sessionContent)
  const profile = join(root, 'profile')
  const { clientId, machineName } = await readClientIdentity(profile)
  const target = agentHostTargetFixture('original', { clientId, machineName })
  const verifyAgentHost = vi.fn(async (_root: string, value: AgentHostTarget) => value)
  const store = new WorkspaceStore(profile, undefined, verifyAgentHost)
  const workspace = (await store.openFolder(root)).current!
  const backend = await createImmutableBindingsFixture(root)
  backends.push(backend)
  const request = { workspaceId: workspace.id, taskId: 'T-0002', sessionId: target.sessionId, agentHost: { hostId: target.hostId, chatId: target.chatId }, owner: target.owner, expectedRevision: backend.snapshot.revision }
  return { root, profile, taskFile, original, legacyFile, sessionFile, sessionContent, store, workspace, target, request, backend, verifyAgentHost }
}

describe('workspace-scoped immutable Agent Host links', () => {
  it('verifies an explicit AHP target before writing a signed binding and a local receipt', async () => {
    const { profile, root, workspace, store, target, request, backend, legacyFile, verifyAgentHost } = await fixture()
    verifyAgentHost.mockRejectedValueOnce(new Error('Host unavailable.'))
    await expect(store.updateSessionLink(request)).rejects.toThrow('unavailable')
    expect((await store.getSessionLinks(workspace.id)).revision).toBe(backend.snapshot.revision)
    expect((await backend.store.read()).records).toEqual([])
    const saved = await store.updateSessionLink(request)
    expect(verifyAgentHost).toHaveBeenLastCalledWith(root, target)
    expect(saved.document.bindings['T-0002']).toEqual({ provider: 'agent-host', ...target })
    expect(await locallyLinkedAgentHostSessions(profile, root, target.owner)).toEqual([target])
    expect((await backend.store.read()).records).toEqual([expect.objectContaining({
      kind: 'binding', payload: { action: 'set', taskId: 'T-0002', target: { provider: 'agent-host', ...target } },
      signature: { algorithm: 'ed25519', value: expect.any(String) },
    })])
    await expect(readFile(legacyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['hostId', 'sessionId', 'chatId', 'owner'] as const)('rejects a verifier that changes the selected %s', async (field) => {
    const { store, request, target, verifyAgentHost, backend } = await fixture()
    const changed = {
      ...target,
      [field]: field === 'owner' ? { clientId: '00000000-0000-4000-8000-000000000099', machineName: 'Another-machine' }
        : field === 'hostId' ? 'different-host' : field === 'chatId' ? 'ahp-chat:/different' : 'copilotcli:/different',
    }
    verifyAgentHost.mockResolvedValue(changed)
    await expect(store.updateSessionLink(request)).rejects.toThrow('identity changed')
    expect((await backend.store.read()).records).toEqual([])
  })

  it('requires an available verifier and a schema-valid verified target', async () => {
    const { root, profile, store, request, target, verifyAgentHost, backend } = await fixture()
    const unavailable = new WorkspaceStore(profile)
    await unavailable.openFolder(root)
    await expect(unavailable.updateSessionLink(request)).rejects.toThrow('verifier is unavailable')
    verifyAgentHost.mockResolvedValue({ ...target, chatId: 'not-an-agent-host-chat' })
    await expect(store.updateSessionLink(request)).rejects.toThrow()
    expect((await backend.store.read()).records).toEqual([])
  })

  it('retains task/session files and reads only immutable bindings across desktop profiles', async () => {
    const content = '{malformed old session configuration'
    const { root, store, workspace, request, target, taskFile, original, legacyFile, sessionFile, sessionContent, backend } = await fixture(content)
    expect((await store.getSessionLinks(workspace.id)).document.bindings).toEqual({})
    const saved = await store.updateSessionLink(request)
    expect((await store.getSessionLinks(workspace.id)).revision).toBe(saved.revision)
    expect(await readFile(taskFile, 'utf8')).toBe(original)
    expect(await readFile(legacyFile, 'utf8')).toBe(content)
    expect(await readFile(sessionFile, 'utf8')).toBe(sessionContent)
    const newProfile = join(root, 'another-profile')
    const next = new WorkspaceStore(newProfile)
    await next.openFolder(root)
    const loaded = await next.getSessionLinks(workspace.id)
    expect(loaded.document).toEqual(saved.document)
    expect(loaded.localOwner?.clientId).not.toBe(target.owner.clientId)
    expect(await locallyLinkedAgentHostSessions(newProfile, root, target.owner)).toEqual([])
    expect((await backend.store.read()).records).toHaveLength(1)
  })

  it('rejects SDK, VS Code, ownerless, mixed and ambiguous detach requests without discovering legacy sessions', async () => {
    const content = JSON.stringify({ schemaVersion: 1, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'native-session' } } })
    const { store, workspace, request, backend, verifyAgentHost, legacyFile } = await fixture(content)
    const oldRequest = { workspaceId: workspace.id, taskId: 'T-0002', sessionId: 'native-session', expectedRevision: request.expectedRevision }
    for (const value of [
      oldRequest,
      { ...oldRequest, vscodeWorkspaceStorageId: 'a'.repeat(32) },
      { ...oldRequest, vscodeWorkspaceStorageId: 'a'.repeat(32), vscodeRemoteMachineName: 'Machine-B' },
      { ...request, owner: undefined },
      { ...request, agentHost: undefined },
      { ...request, vscodeWorkspaceStorageId: 'a'.repeat(32) },
      { ...request, vscodeRemoteMachineName: 'Machine-B' },
      { ...request, sessionId: null },
      { workspaceId: workspace.id, taskId: 'T-0002', sessionId: null, owner: request.owner, expectedRevision: request.expectedRevision },
      { workspaceId: workspace.id, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'native-session' } } },
    ]) await expect(store.updateSessionLink(value)).rejects.toThrow()
    expect(store).not.toHaveProperty('migrateSessionLinks')
    expect((await store.getSessionLinks(workspace.id)).document.bindings).toEqual({})
    expect((await backend.store.read()).records).toEqual([])
    expect(verifyAgentHost).not.toHaveBeenCalled()
    expect(await readFile(legacyFile, 'utf8')).toBe(content)
  })

  it('fails reads, writes and detach explicitly when the new backend is unavailable', async () => {
    const content = JSON.stringify({ schemaVersion: 1, bindings: { 'T-0002': { provider: 'github-copilot', sessionId: 'old-session' } } })
    const { store, workspace, request, backend, legacyFile } = await fixture(content)
    backend.unregister()
    await expect(store.getSessionLinks(workspace.id)).rejects.toThrow('Enable Automatic workspace links')
    await expect(store.updateSessionLink(request)).rejects.toThrow('Enable Automatic workspace links')
    await expect(store.updateSessionLink({ workspaceId: workspace.id, taskId: 'T-0002', sessionId: null, expectedRevision: request.expectedRevision })).rejects.toThrow('Enable Automatic workspace links')
    expect(await readFile(legacyFile, 'utf8')).toBe(content)
    expect((await backend.store.read()).records).toEqual([])
  })

  it('rejects stale workspace IDs, arbitrary paths and nonexistent attachment tasks', async () => {
    const { root, store, workspace, request, backend } = await fixture()
    await expect(store.updateSessionLink({ ...request, taskId: 'T-0999' })).rejects.toThrow('no longer exists')
    await expect(store.updateSessionLink({ ...request, root })).rejects.toThrow()
    await expect(store.getSessionLinks(root)).rejects.toThrow('active workspace changed')
    await expect(store.updateSessionLink({ ...request, workspaceId: 'a'.repeat(64) })).rejects.toThrow('active workspace changed')
    expect((await store.getSessionLinks(workspace.id)).document.bindings).toEqual({})
    await store.closeWorkspace()
    await expect(store.updateSessionLink(request)).rejects.toThrow('active workspace changed')
    expect((await backend.store.read()).records).toEqual([])
  })

  it('keeps revision conflicts unchanged and detaches deleted tasks without deleting session history', async () => {
    const { root, profile, store, workspace, request, target, backend, taskFile, sessionFile, sessionContent, verifyAgentHost } = await fixture()
    const saved = await store.updateSessionLink(request)
    const detach = { workspaceId: workspace.id, taskId: 'T-0002', sessionId: null, expectedRevision: request.expectedRevision }
    await expect(store.updateSessionLink(detach)).rejects.toThrow('changed on disk')
    expect((await store.getSessionLinks(workspace.id)).document).toEqual(saved.document)
    expect(await locallyLinkedAgentHostSessions(profile, root, target.owner)).toEqual([target])
    await rm(taskFile)
    const removed = await store.updateSessionLink({ ...detach, expectedRevision: saved.revision })
    expect(removed.document.bindings).toEqual({})
    expect(await locallyLinkedAgentHostSessions(profile, root, target.owner)).toEqual([])
    expect(await readFile(sessionFile, 'utf8')).toBe(sessionContent)
    expect((await backend.store.read()).records).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'binding', payload: { action: 'set', taskId: 'T-0002', target: { provider: 'agent-host', ...target } } }),
      expect.objectContaining({ kind: 'binding', payload: { action: 'delete', taskId: 'T-0002' } }),
    ]))
    expect(verifyAgentHost).toHaveBeenCalledOnce()
  })
})
