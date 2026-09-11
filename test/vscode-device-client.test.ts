// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { VSCodeDeviceHost } from '../src/main/vscodeDeviceHost'
import { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import { RemoteVSCodeManager } from '../src/main/vscodeRemoteClient'
import { newSshKeyPair, openSessionSshBridge, startSessionSshHost } from '../src/main/devTunnel/sessionSsh'
import { startVSCodeChatCompanion } from '../src/main/vscodeChatCompanion'
import { remoteInvitationSchema } from '../src/main/vscodeRemoteProtocol'
import { deviceInvitationSchema } from '../src/main/vscodeDeviceProtocol'
import * as deviceHttp from '../src/main/vscodeDeviceHttp'
import type { VSCodeDispatch } from '../src/main/vscodeChatDelivery'

describe('client-scoped SSH sessions', () => {
  it.each(['timeout', 'cancellation'])('identifies session discovery %s without a generic abort error', async (reason) => {
    const abort = new AbortController()
    const server = createServer((request) => {
      request.resume()
      if (reason === 'cancellation') abort.abort()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test listener unavailable.')
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    const deadline = reason === 'timeout' ? vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(30)) : undefined
    try {
      await expect(deviceHttp.deviceRequest(address.port, address.port, 'test-only', '/device/sessions', {}, abort.signal))
        .rejects.toThrow(reason === 'timeout' ? 'Owner session discovery timed out waiting for the owner' : 'Owner session discovery was cancelled')
      if (deadline) expect(deadline).toHaveBeenCalledWith(15000)
    } finally {
      deadline?.mockRestore()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it.each(['read cancellation', 'read response', 'send cancellation'])('reuses one SSH connection and preserves recovery after a late %s without replay', async (lateResult) => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-device-client-'))
    const workspaceStorageId = 'c'.repeat(32)
    const storage = join(root, 'storage')
    const history = join(storage, workspaceStorageId, 'chatSessions')
    const tasks = join(root, 'tasks')
    const otherTasks = join(root, 'other-tasks')
    await Promise.all([mkdir(history, { recursive: true }), mkdir(tasks), mkdir(otherTasks)])
    for (const name of ['first', 'second']) await writeFile(join(history, `${name}.json`), JSON.stringify({ customTitle: name, inputState: { mode: { id: 'agent', kind: 'agent' } }, requests: [{ requestId: 'old', message: `History ${name}`, response: [{ value: 'Answer' }], result: {} }] }))
    const imageBytes = Buffer.alloc(40 * 1024)
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64').copy(imageBytes)
    const image = { id: randomUUID(), name: 'Remote screenshot.png', mimeType: 'image/png' as const, data: imageBytes.toString('base64') }
    const dispatch = vi.fn<VSCodeDispatch>(async (_identity, delivery, _signal, files) => {
      expect(delivery.images).toMatchObject([{ id: image.id, byteLength: imageBytes.length }])
      expect(await readFile(files![0].path)).toEqual(imageBytes)
      return { state: 'submitted', nativeRequestId: 'new' }
    })
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
      await expect(manager.send(tasks, second.target, randomUUID(), '', [image])).rejects.toThrow('send access')
      expect(await manager.send(tasks, first.target, randomUUID(), '', [image])).toMatchObject({ text: '', images: [{ id: image.id, byteLength: imageBytes.length }] })
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
      const originalRequest = deviceHttp.deviceRequest
      let finishOldRequest!: () => void
      let started!: () => void
      const requestStarted = new Promise<void>((resolve) => { started = resolve })
      let delayed = false
      const sending = lateResult === 'send cancellation'
      const requests = vi.spyOn(deviceHttp, 'deviceRequest').mockImplementation((...args) => {
        if (args[3] === (sending ? '/device/session/send' : '/device/session/read') && !delayed) {
          delayed = true
          const response = lateResult === 'read response' ? originalRequest(...args) : Promise.resolve(undefined)
          return response.then((payload) => new Promise((resolve, reject) => {
            finishOldRequest = () => lateResult === 'read response' ? resolve(payload) : reject(new DOMException('The operation was aborted', 'AbortError'))
            started()
          }))
        }
        return originalRequest(...args)
      })
      const oldRequest = sending
        ? manager.send(tasks, first.target, randomUUID(), 'Never replay this interrupted request').catch((error: unknown) => error)
        : manager.read(tasks, first.target)
      try {
        await requestStarted
        await client.disconnect(tasks, device.id)
        await client.connect(tasks, device.id)
        const connections = transport.mock.calls.length
        expect((await client.list(tasks))[0]).toMatchObject({ state: 'connected', error: undefined })
        finishOldRequest()
        expect(await oldRequest).toMatchObject(sending ? { name: 'AbortError' } : { connectionState: 'offline', canSend: false })
        expect((await client.list(tasks))[0]).toMatchObject({ state: 'connected', error: undefined })
        expect(await manager.read(tasks, first.target)).toMatchObject({ connectionState: 'connected' })
        expect(transport).toHaveBeenCalledTimes(connections)
        expect(dispatch).toHaveBeenCalledTimes(1)
      } finally {
        finishOldRequest?.()
        await oldRequest.catch(() => undefined)
        requests.mockRestore()
      }
      await host.revoke(pair.id)
      await expect(manager.send(tasks, first.target, randomUUID(), 'Revoked')).rejects.toThrow('revoked')
      expect(dispatch).toHaveBeenCalledTimes(1)
      await client.forget(tasks, device.id)
      expect(await manager.list(tasks)).toEqual([])
    } finally { manager.close(); await host.close(); await ssh.close(); await bridge.close(); await rm(root, { recursive: true, force: true }) }
  }, 20000)
})