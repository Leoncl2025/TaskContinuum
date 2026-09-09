// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { VSCodeDeviceHost } from '../src/main/vscodeDeviceHost'
import { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import { RemoteVSCodeManager } from '../src/main/vscodeRemoteClient'
import { newSshKeyPair, openSessionSshBridge, startSessionSshHost } from '../src/main/devTunnel/sessionSsh'
import { startVSCodeChatCompanion } from '../src/main/vscodeChatCompanion'
import { remoteInvitationSchema } from '../src/main/vscodeRemoteProtocol'
import { deviceInvitationSchema } from '../src/main/vscodeDeviceProtocol'

describe('client-scoped SSH sessions', () => {
  it('uses one SSH connection for two originals, reconnects reads and never replays a send', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-device-client-'))
    const workspaceStorageId = 'c'.repeat(32)
    const storage = join(root, 'storage')
    const history = join(storage, workspaceStorageId, 'chatSessions')
    const tasks = join(root, 'tasks')
    const otherTasks = join(root, 'other-tasks')
    await Promise.all([mkdir(history, { recursive: true }), mkdir(tasks), mkdir(otherTasks)])
    for (const name of ['first', 'second']) await writeFile(join(history, `${name}.json`), JSON.stringify({ customTitle: name, inputState: { mode: { id: 'agent', kind: 'agent' } }, requests: [{ requestId: 'old', message: `History ${name}`, response: [{ value: 'Answer' }], result: {} }] }))
    const dispatch = vi.fn(async () => ({ state: 'submitted' as const, nativeRequestId: 'new' }))
    const bridge = await startVSCodeChatCompanion({ storageRoot: storage, workspaceStorageId, discoveryDirectory: join(root, 'bridges'), vscodeVersion: '1.136.1', open: async () => {}, dispatch })
    const headers = { Authorization: `Bearer ${bridge.descriptor.token}`, 'Content-Type': 'application/json' }
    const resolve = vi.fn(async (identity, participant, canSend, prior) => prior ?? remoteInvitationSchema.parse(await (await fetch(`http://127.0.0.1:${bridge.descriptor.port}/remote/grant`, { method: 'POST', headers, body: JSON.stringify({ ...identity, participant, canSend }) })).json()))
    const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
    const host = new VSCodeDeviceHost(join(root, 'owner'), protector, resolve)
    const clientKey = newSshKeyPair()
    const ssh = await startSessionSshHost(newSshKeyPair())
    const participant = { clientId: randomUUID(), username: 'Alice', machineName: 'A' }
    const opened: { close(): void }[] = []
    const transport = vi.fn(async (invitation, signal) => {
      const result = await openSessionSshBridge(createConnection(ssh.port, '127.0.0.1'), { key: clientKey, hostPublicKey: ssh.publicKey, grantId: invitation.id, targetPort: invitation.port, signal })
      opened.push(result)
      return result
    })
    let client = new VSCodeDeviceClient(join(root, 'client'), protector, transport, async (invitation) => {
      if (invitation.participant.clientId !== participant.clientId) throw new Error('Wrong device')
    })
    let manager = new RemoteVSCodeManager(join(root, 'client'), { devices: client })
    try {
      const pair = await host.pair(participant, clientKey.publicKey)
      const port = await host.start()
      ssh.allow(pair.id, clientKey.publicKey, port, pair.expiresAt, true)
      const invitation = deviceInvitationSchema.parse({ schemaVersion: 2, provider: 'vscode-copilot-device', id: pair.id, ownerId: await host.ownerId(), machineName: hostname(), participant, token: pair.token, expiresAt: pair.expiresAt, port,
        devTunnel: { kind: 'dev-tunnel', tunnelId: `taskcontinuum-${'a'.repeat(32)}.jpe1`, sshPort: ssh.port, hostPublicKey: ssh.publicKey, clientPublicKey: clientKey.publicKey } })
      await client.import(tasks, invitation)
      expect(transport).not.toHaveBeenCalled()
      const device = (await client.list(tasks))[0]
      expect(await client.list(otherTasks)).toEqual([])
      await expect(client.connect(otherTasks, device.id)).rejects.toThrow('task workspace')
      await host.approve(pair.id, { nativeSessionId: 'first', workspaceStorageId }, true)
      await client.connect(tasks, device.id)
      const first = (await manager.list(tasks))[0]
      expect(first.deviceId).toBe(device.id)
      expect(await manager.read(tasks, first.target)).toMatchObject({ connectionState: 'connected', messages: [expect.objectContaining({ text: 'History first' }), expect.anything()] })
      await host.approve(pair.id, { nativeSessionId: 'second', workspaceStorageId }, false)
      await client.connect(tasks, device.id)
      const second = (await manager.list(tasks)).find((item) => item.title === 'second')!
      await manager.connect(tasks, second.id)
      expect(transport).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(await manager.read(tasks, second.target))).toContain('History second')
      await expect(manager.send(tasks, second.target, randomUUID(), 'Denied')).rejects.toThrow('send access')
      await manager.send(tasks, first.target, randomUUID(), 'One explicit send')
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
      opened[0].close()
      expect(await manager.read(tasks, first.target)).toMatchObject({ connectionState: 'offline', canSend: false })
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10000)
      try {
        expect(await manager.read(tasks, first.target)).toMatchObject({ connectionState: 'connected' })
        expect(transport).toHaveBeenCalledTimes(2)
        expect(dispatch).toHaveBeenCalledTimes(1)
      } finally { clock.mockRestore() }
      await host.revokeSession(pair.id, { nativeSessionId: 'second', workspaceStorageId })
      await client.connect(tasks, device.id)
      expect(await manager.read(tasks, second.target)).toMatchObject({ connectionState: 'offline', canSend: false })
      expect(await manager.read(tasks, first.target)).toMatchObject({ connectionState: 'connected' })
      expect(transport).toHaveBeenCalledTimes(2)
      await client.disconnect(tasks, device.id)
      manager.close()
      client = new VSCodeDeviceClient(join(root, 'client'), protector, transport, async () => {})
      manager = new RemoteVSCodeManager(join(root, 'client'), { devices: client })
      expect(await manager.read(tasks, first.target)).toMatchObject({ connectionState: 'offline', canSend: false })
      expect(transport).toHaveBeenCalledTimes(2)
      await client.connect(tasks, device.id)
      expect(await manager.read(tasks, first.target)).toMatchObject({ connectionState: 'connected' })
      await host.revoke(pair.id)
      await expect(manager.send(tasks, first.target, randomUUID(), 'Revoked')).rejects.toThrow('revoked')
      expect(dispatch).toHaveBeenCalledTimes(1)
      await client.forget(tasks, device.id)
      expect(await manager.list(tasks)).toEqual([])
    } finally { manager.close(); await host.close(); await ssh.close(); await bridge.close(); await rm(root, { recursive: true, force: true }) }
  }, 20000)
})