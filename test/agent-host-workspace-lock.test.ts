// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { registerWorkspaceBridge } from '../src/main/workspaceBridge'
import { bindRepositoryAgentHostCreation } from '../src/main/repositorySessionLinks'
import type { WorkspaceState } from '../src/shared/workspace'
import { agentHostTargetFixture, createImmutableBindingsFixture } from './immutable-bindings-fixture'
import { deferred, writeCreationTaskWorkspace } from './agent-host-creation-fixture'

const ipc = vi.hoisted(() => ({
  profile: '',
  handlers: new Map<string, (_event: unknown, value?: unknown) => Promise<unknown>>(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => ipc.profile, getAppPath: () => 'Q:\\TaskContinuum', isPackaged: false },
  ipcMain: { handle: (channel: string, handler: (_event: unknown, value?: unknown) => Promise<unknown>) => { ipc.handlers.set(channel, handler) } },
}))
afterEach(() => { ipc.handlers.clear(); vi.unstubAllEnvs() })

it.each(['read', 'write', 'close'] as const)('does not deadlock creation binding against a workspace %s', async (action) => {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-workspace-lock-'))
  const workspace = join(directory, 'workspace')
  ipc.profile = join(directory, 'profile')
  await writeCreationTaskWorkspace(workspace)
  const backend = await createImmutableBindingsFixture(workspace)
  const validating = deferred(), queued = deferred(), proceed = deferred(), escape = deferred()
  const target = agentHostTargetFixture('created')
  const window = {} as BrowserWindow
  vi.stubEnv('TASKCONTINUUM_WORKSPACE', workspace)
  const bridge = registerWorkspaceBridge(() => window, async (_root, selected) => {
    queued.resolve()
    await backend.store.read()
    return selected
  })
  const invoke = (channel: string, value?: unknown) => ipc.handlers.get(`workspace:${channel}`)!({}, value)
  let binding: Promise<unknown> | undefined, pending: Promise<unknown> | undefined, closing: Promise<unknown> | undefined
  try {
    const state = await invoke('state') as WorkspaceState
    const originalUpdate = backend.store.update.bind(backend.store)
    vi.spyOn(backend.store, 'update').mockImplementation((revision, transform, beforeWrite) => originalUpdate(revision, transform, async () => {
      validating.resolve()
      await proceed.promise
      await beforeWrite?.()
    }))
    const originalRead = backend.store.read.bind(backend.store)
    vi.spyOn(backend.store, 'read').mockImplementation(() => {
      const reading = originalRead()
      queued.resolve()
      return reading
    })
    let written = false, failed: unknown, finished = false
    const taskBefore = await readFile(join(workspace, 'tasks', 'T-0007', 'task.json'), 'utf8')
    binding = bindRepositoryAgentHostCreation(workspace, 'T-0007', target, backend.snapshot.revision, async () => {
      // Escape is test cleanup only, so a regression fails without hanging Vitest.
      const current = await Promise.race([bridge.currentRoot(), escape.promise.then(() => workspace)])
      if (current !== workspace) throw new Error('The workspace changed.')
    }).then(() => { written = true }, (error: unknown) => { failed = error })
    await validating.promise
    pending = (action === 'write'
      ? invoke('update-session-link', { workspaceId: state.current!.id, taskId: 'T-0007', sessionId: target.sessionId,
        agentHost: { chatId: target.chatId }, owner: target.owner, expectedRevision: backend.snapshot.revision })
      : invoke('session-links', state.current!.id)).then(() => { finished = true }, (error: unknown) => {
        if (action !== 'write') throw error
        expect(error).toMatchObject({ code: 'stale-revision' })
        finished = true
      })
    await queued.promise
    if (action === 'close') closing = invoke('close')
    proceed.resolve()
    await expect.poll(() => (written || failed !== undefined) && finished, { timeout: 2000 }).toBe(true)
    if (action === 'close') {
      expect(failed).toBeInstanceOf(Error)
      expect((failed as Error).message).toContain('workspace selection is changing')
      expect((await closing as WorkspaceState).current).toBeNull()
      await expect(bridge.currentRoot()).rejects.toThrow('Open a real task workspace')
    } else {
      expect(failed).toBeUndefined()
      expect(await bridge.currentRoot()).toBe(workspace)
      expect((await invoke('state') as WorkspaceState).current?.id).toBe(state.current!.id)
    }
    const saved = await backend.store.read()
    expect(saved.document.bindings['T-0007'] ?? []).toEqual(action === 'close' ? [] : [{ provider: 'agent-host', ...target }])
    expect(saved.records).toHaveLength(action === 'close' ? 0 : 1)
    expect(await readFile(join(workspace, 'tasks', 'T-0007', 'task.json'), 'utf8')).toBe(taskBefore)
  } finally {
    proceed.resolve()
    escape.resolve()
    await Promise.allSettled([binding, pending, closing])
    await backend.close()
    await rm(directory, { recursive: true, force: true })
  }
})
