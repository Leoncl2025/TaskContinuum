import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SharedSessionManager } from '../src/main/shared/manager'
import { createSharedCheckpoint } from '../src/main/shared/checkpoint'
import type { SharedSessionDescriptor } from '../src/shared/sharedSessions'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('lets a newly enrolled machine retain a downloaded checkpoint without an owner connection or model call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-offline-checkpoint-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, '.agentdesk'), { recursive: true })
  await mkdir(join(workspace, 'tasks', 'T-0001-task'), { recursive: true })
  await writeFile(join(workspace, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Offline test' }))
  await writeFile(join(workspace, 'tasks', 'T-0001-task', 'task.json'), JSON.stringify({ schemaVersion: '1.0', id: 'T-0001', title: 'Offline test', type: 'feature', status: 'backlog', priority: 'P2', relations: { level: 'task' } }))
  const session: SharedSessionDescriptor = { schemaVersion: 1, id: randomUUID(), workspaceId: randomUUID(), taskId: 'T-0001', mode: 'checkpoint', createdAt: new Date().toISOString(), owner: { machineId: 'B', machineName: 'B', agentId: 'agent-B', nativeSessionId: 'native-B', epoch: 1 } }
  const checkpoint = createSharedCheckpoint(session, [{ sessionId: session.id, epoch: 1, seq: 1, at: new Date().toISOString(), actor: { kind: 'agent', id: 'agent-B', name: 'Copilot', machineId: 'B', machineName: 'B' }, type: 'history', role: 'assistant', text: 'Verified checkpoint from B.' }], { commit: 'a'.repeat(40), branch: 'main', clean: true })
  const file = join(root, 'downloaded-checkpoint.json')
  await writeFile(file, JSON.stringify(checkpoint))
  const profile = join(root, 'profile-C')
  const manager = new SharedSessionManager(profile, 'not-started')
  const preview = await manager.previewCheckpoint(file)
  expect(await manager.list(workspace)).toEqual([])
  const retained = await manager.keepCheckpoint(workspace, preview.token)
  expect(retained.online).toBe(false)
  expect(retained.checkpoint?.id).toBe(checkpoint.payload.checkpointId)
  expect(retained.permissions).toEqual(['read'])
  const restarted = new SharedSessionManager(profile, 'not-started')
  expect((await restarted.list(workspace))[0].id).toBe(session.id)
  expect((await restarted.open(session.id)).events[0].text).toBe('Verified checkpoint from B.')
  await manager.close()
  await restarted.close()
})