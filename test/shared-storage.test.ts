import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SharedSessionDescriptor } from '../src/shared/sharedSessions'
import { localIdentity, readSharedRoutes, registerSharedRoute } from '../src/main/shared/storage'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'shared-routes-')); roots.push(root); return root }
function session(): SharedSessionDescriptor {
  return { schemaVersion: 1, id: randomUUID(), workspaceId: randomUUID(), taskId: 'T-0001', mode: 'live', createdAt: new Date().toISOString(), owner: { machineId: 'B', machineName: 'Machine B', agentId: 'agent-B', nativeSessionId: 'native-B', epoch: 1 } }
}

describe('stable shared-session routes', () => {
  it('retains workspace and session identity across repository clones without credentials', async () => {
    const source = await directory()
    const value = session()
    const routes = await registerSharedRoute(source, value, true)
    const text = await readFile(join(source, '.taskcontinuum', 'shared-sessions.json'), 'utf8')
    expect(text).not.toContain(source)
    expect(text).not.toContain('token')
    const clone = await directory()
    await mkdir(join(clone, '.taskcontinuum'))
    await writeFile(join(clone, '.taskcontinuum', 'shared-sessions.json'), text)
    expect(await readSharedRoutes(clone)).toEqual(routes)
  })

  it('records independent fork lineage without stealing the active owner route', async () => {
    const root = await directory()
    const source = session()
    await registerSharedRoute(root, source, true)
    const fork = { ...source, id: randomUUID(), parent: { sessionId: source.id, checkpointId: randomUUID(), mode: 'semantic' as const } }
    const result = await registerSharedRoute(root, fork, false)
    expect(result.sessions).toHaveLength(2)
    expect(result.active['T-0001']).toBe(source.id)
    await expect(registerSharedRoute(root, fork, true)).rejects.toThrow('different shared session')
    await expect(registerSharedRoute(root, { ...session(), taskId: 'T-0002' }, false)).rejects.toThrow('different workspace')
  })

  it('keeps local participant IDs stable without copying them into routing metadata', async () => {
    const root = await directory()
    const first = await localIdentity(root)
    expect(await localIdentity(root)).toEqual(first)
    const other = await localIdentity(await directory())
    expect(other.machineId).not.toBe(first.machineId)
  })
})