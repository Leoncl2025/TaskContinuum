// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { VSCodeDeviceHost } from '../src/main/vscodeDeviceHost'
import { newSshKeyPair } from '../src/main/devTunnel/sessionSsh'
import { deviceRequest } from '../src/main/vscodeDeviceHttp'
import { deviceCatalogSchema } from '../src/main/vscodeDeviceProtocol'
import { startVSCodeChatCompanion } from '../src/main/vscodeChatCompanion'
import { resolveDeviceSession, revokeRemoteVSCode } from '../src/main/vscodeChatClient'
import { VSCodeSessionStore } from '../src/main/vscodeSessions'

describe('device-scoped original session gateway', () => {
  it('pairs once, discovers approved sessions lazily, persists pairing and enforces revoke/read-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-device-host-'))
    const storage = join(root, 'storage')
    const workspaceStorageId = 'b'.repeat(32)
    const history = join(storage, workspaceStorageId, 'chatSessions')
    await mkdir(history, { recursive: true })
    for (const name of ['first', 'second', 'private']) await writeFile(join(history, `${name}.json`), JSON.stringify({ customTitle: name, inputState: { mode: { id: 'agent', kind: 'agent' } }, requests: [{ requestId: 'old', message: `History ${name}`, response: [{ value: 'Answer' }], result: {} }] }))
    const dispatch = vi.fn(async () => ({ state: 'submitted' as const, nativeRequestId: 'new' }))
    const createBridge = () => startVSCodeChatCompanion({ storageRoot: storage, workspaceStorageId, discoveryDirectory: join(storage, workspaceStorageId, 'taskcontinuum.vscode-bridge', 'bridges'), vscodeVersion: '1.136.1', open: async () => {}, dispatch })
    let bridge = await createBridge()
    const store = new VSCodeSessionStore([storage])
    const resolve = vi.fn((...args: Parameters<typeof resolveDeviceSession> extends [unknown, ...infer Rest] ? Rest : never) => resolveDeviceSession(store, ...args))
    const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
    const createHost = () => new VSCodeDeviceHost(join(root, 'profile'), protector, resolve, (invitation) => revokeRemoteVSCode(store, invitation.identity, invitation.grant.id))
    let host = createHost()
    const participant = { clientId: randomUUID(), username: 'Alice', machineName: 'A' }
    try {
      const pair = await host.pair(participant, newSshKeyPair().publicKey)
      const port = await host.start()
      const call = (path: string, body: unknown) => deviceRequest(port, port, pair.token, path, body, AbortSignal.timeout(5000))
      expect(deviceCatalogSchema.parse(await call('/device/sessions', {})).sessions).toEqual([])
      await host.approve(pair.id, { nativeSessionId: 'first', workspaceStorageId }, false)
      const first = deviceCatalogSchema.parse(await call('/device/sessions', {}))
      expect(first.sessions.map((session) => session.title)).toEqual(['first'])
      expect(first.sessions[0].execution.machineName).toBe(hostname())
      expect(JSON.stringify(first)).not.toContain('History first')
      await host.approve(pair.id, { nativeSessionId: 'second', workspaceStorageId }, true)
      expect(deviceCatalogSchema.parse(await call('/device/sessions', {})).sessions).toHaveLength(2)
      await expect(call('/device/session/read', { identity: { nativeSessionId: 'private', workspaceStorageId } })).rejects.toThrow('revoked')
      await expect(call('/device/session/send', { identity: { nativeSessionId: 'first', workspaceStorageId }, id: randomUUID(), text: 'Denied' })).rejects.toThrow('revoked')
      const view = await call('/device/session/read', { identity: { nativeSessionId: 'first', workspaceStorageId } })
      expect(JSON.stringify(view)).toContain('History first')
      await call('/device/session/send', { identity: { nativeSessionId: 'second', workspaceStorageId }, id: randomUUID(), text: 'Allowed' })
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
      await host.close()
      host = createHost()
      expect(await host.start()).toBe(port)
      expect((await host.list())[0].id).toBe(pair.id)
      expect(deviceCatalogSchema.parse(await call('/device/sessions', {})).sessions).toHaveLength(2)
      expect(deviceCatalogSchema.parse(await call('/device/sessions', {})).sessions[0].grant.id).toBe(first.sessions[0].grant.id)
      await bridge.close()
      bridge = await createBridge()
      const renewed = deviceCatalogSchema.parse(await call('/device/sessions', {}))
      expect(renewed.sessions).toHaveLength(2)
      expect(renewed.sessions[0].instanceId).toBe(bridge.descriptor.instanceId)
      expect(renewed.sessions[0].grant.id).not.toBe(first.sessions[0].grant.id)
      await host.revokeSession(pair.id, { nativeSessionId: 'second', workspaceStorageId })
      await expect(call('/device/session/read', { identity: { nativeSessionId: 'second', workspaceStorageId } })).rejects.toThrow('revoked')
      await host.revoke(pair.id)
      await expect(call('/device/sessions', {})).rejects.toThrow('revoked')
      expect(await readFile(join(root, 'profile', 'remote-vscode-device-host.json'), 'utf8')).not.toContain(pair.token)
    } finally { await host.close(); await bridge.close(); await rm(root, { recursive: true, force: true }) }
  })
})