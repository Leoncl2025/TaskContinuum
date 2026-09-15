import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { initialWorkspaceId, LocalEnrollments } from '../src/main/remoteConfig/enrollment'
import { newSshKeyPair } from '../src/main/devTunnel/sessionSsh'
import { sshFingerprint } from '../src/main/devTunnel/protocol'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'taskcon-enrollment-'))
  roots.push(root)
  return { root, store: new LocalEnrollments(root) }
}

describe('local Git enrollment trust', () => {
  it('derives the same initial workspace identity for concurrent clones of one upstream', () => {
    expect(initialWorkspaceId('origin', 'main')).toBe(initialWorkspaceId('origin', 'main'))
    expect(initialWorkspaceId('origin', 'main')).not.toBe(initialWorkspaceId('origin', 'other'))
  })

  it('requires explicit local enrollment and pins admitted keys across restarts', async () => {
    const { root, store } = await setup()
    const id = randomUUID()
    const client = newSshKeyPair()
    const host = newSshKeyPair()
    await expect(store.admit(root, id, client.publicKey, host.publicKey)).rejects.toThrow('disabled')
    await store.enable(root, randomUUID(), false)
    await expect(store.admit(root, id, client.publicKey, host.publicKey)).rejects.toThrow('awaits')
    await store.admit(root, id, client.publicKey, host.publicKey, true)
    const restored = new LocalEnrollments(root)
    expect(await restored.trustedKey(root, id, sshFingerprint(client.publicKey))).toBe(client.publicKey)
    await expect(restored.admit(root, id, newSshKeyPair().publicKey, host.publicKey)).rejects.toThrow('changed')
    await restored.revoke(root, id)
    expect(await restored.trustedKey(root, id, sshFingerprint(client.publicKey))).toBeUndefined()
    await expect(restored.admit(root, id, client.publicKey, host.publicKey, true)).rejects.toThrow('revoked')
    await expect(restored.admit(root, randomUUID(), client.publicKey, host.publicKey, true)).rejects.toThrow('different device ID')
  })

  it('admits new identities only under the opted-in policy and never changes workspace identity', async () => {
    const { root, store } = await setup()
    const workspaceId = randomUUID()
    await store.enable(root, workspaceId, true)
    const id = randomUUID()
    const key = newSshKeyPair()
    await store.admit(root, id, key.publicKey, key.publicKey)
    await expect(store.enable(root, randomUUID(), true)).rejects.toThrow('changed')
    await store.disable(root)
    expect(await store.trustedKey(root, id, sshFingerprint(key.publicKey))).toBeUndefined()
    await store.enable(root, workspaceId, true)
    expect(await store.trustedKey(root, id, sshFingerprint(key.publicKey))).toBe(key.publicKey)
  })

  it('persists pause and denial even after the enrolled checkout is deleted', async () => {
    const { root, store } = await setup()
    const workspace = join(root, 'checkout')
    await mkdir(workspace)
    await store.enable(workspace, randomUUID(), true)
    const deviceId = randomUUID()
    const key = newSshKeyPair()
    await store.admit(workspace, deviceId, key.publicKey, key.publicKey)
    await rm(workspace, { recursive: true })
    await store.revoke(workspace, deviceId)
    await store.disable(workspace)
    expect((await store.list())[0]).toMatchObject({ enabled: false, pins: { [deviceId]: { blocked: true } } })
  })
})
