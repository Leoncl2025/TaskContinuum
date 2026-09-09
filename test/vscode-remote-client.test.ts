// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { RemoteVSCodeManager } from '../src/main/vscodeRemoteClient'
import { startVSCodeChatCompanion } from '../src/main/vscodeChatCompanion'
import { remoteInvitationSchema } from '../src/main/vscodeRemoteProtocol'
import { openSshTunnel } from '../src/main/shared/ssh'
import { startSshFixture } from './ssh-fixture'

describe('remote original-session client', () => {
  it('reads without local history, isolates profiles and workspaces, and keeps a read-only offline cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-remote-client-'))
    const workspace = join(root, 'tasks-a')
    const otherWorkspace = join(root, 'tasks-b')
    const profile = join(root, 'client-profile')
    const ownerStorage = join(root, 'owner-storage')
    const identity = { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32) }
    const history = join(ownerStorage, identity.workspaceStorageId, 'chatSessions')
    await Promise.all([mkdir(workspace), mkdir(otherWorkspace), mkdir(history, { recursive: true })])
    const file = join(history, 'original.json')
    const source = JSON.stringify({ customTitle: 'Work on B', inputState: { mode: { id: 'agent', kind: 'agent' } }, requests: [{ requestId: 'old', message: 'Owner history', response: [{ value: 'Owner answer' }], result: {} }] })
    await writeFile(file, source)
    const dispatch = vi.fn(async () => ({ state: 'submitted' as const, nativeRequestId: 'native-new' }))
    const bridge = await startVSCodeChatCompanion({ storageRoot: ownerStorage, workspaceStorageId: identity.workspaceStorageId, discoveryDirectory: join(ownerStorage, identity.workspaceStorageId, 'taskcontinuum.vscode-bridge', 'bridges'), vscodeVersion: '1.136.1', open: async () => {}, dispatch })
    const participant = { clientId: randomUUID(), username: 'Alice', machineName: 'Machine-A' }
    const ssh = await startSshFixture(join(root, 'ssh'), bridge.descriptor.port)
    const tunnelClose = vi.fn()
    const tunnel = vi.fn(async (host: string, port: number, signal: AbortSignal) => {
      const opened = await openSshTunnel(host, port, ssh.config, signal)
      expect(opened.port).not.toBe(bridge.descriptor.port)
      return { port: opened.port, close: () => { tunnelClose(); opened.close() } }
    })
    const manager = new RemoteVSCodeManager(profile, { identity: async () => participant, tunnel })
    try {
      const headers = { Authorization: `Bearer ${bridge.descriptor.token}`, 'Content-Type': 'application/json' }
      const response = await fetch(`http://127.0.0.1:${bridge.descriptor.port}/remote/grant`, { method: 'POST', headers, body: JSON.stringify({ ...identity, participant, canSend: true }) })
      const invitation = remoteInvitationSchema.parse(await response.json())
      const enrollment = await manager.importInvitation(workspace, invitation, 'owner-machine')
      expect(JSON.stringify(enrollment)).not.toContain(invitation.token)
      expect(tunnel).not.toHaveBeenCalled()
      expect(await manager.read(workspace, enrollment.target)).toMatchObject({ messages: [], connectionState: 'offline', canSend: false, bridgeError: expect.stringContaining('No verified cached history') })
      expect(await manager.list(otherWorkspace)).toEqual([])
      await expect(manager.connect(otherWorkspace, enrollment.id)).rejects.toThrow('selected task workspace')
      await manager.connect(workspace, enrollment.id)
      expect(tunnel).toHaveBeenCalledWith('owner-machine', bridge.descriptor.port, expect.any(AbortSignal))
      expect(ssh.forwardedConnections()).toBeGreaterThan(0)
      expect((await manager.read(workspace, enrollment.target)).messages.map((message) => message.text)).toEqual(['Owner history', 'Owner answer'])
      const commandId = randomUUID()
      expect(await manager.send(workspace, enrollment.target, commandId, 'Work remotely')).toMatchObject({ participant, nativeSessionId: identity.nativeSessionId })
      await vi.waitFor(async () => expect((await manager.read(workspace, enrollment.target)).deliveries?.[0].state).toBe('submitted'))
      await manager.send(workspace, enrollment.target, commandId, 'Work remotely')
      expect(dispatch).toHaveBeenCalledTimes(1)
      await manager.disconnect(workspace, enrollment.id)
      expect(tunnelClose).toHaveBeenCalledTimes(1)
      const cached = await manager.read(workspace, enrollment.target)
      expect(cached).toMatchObject({ connectionState: 'offline', canSend: false, execution: invitation.execution })
      expect(cached.messages[0].text).toBe('Owner history')
      await expect(manager.send(workspace, enrollment.target, randomUUID(), 'Offline')).rejects.toThrow('No message was queued or sent')
      const restarted = new RemoteVSCodeManager(profile, { identity: async () => participant, tunnel })
      expect((await restarted.list(workspace))[0]).toMatchObject({ id: enrollment.id, state: 'disconnected' })
      expect((await restarted.read(workspace, enrollment.target)).messages[0].text).toBe('Owner history')
      await expect(restarted.importInvitation(workspace, { ...invitation, grant: { ...invitation.grant, participant: { ...participant, clientId: randomUUID() } } }, 'owner-machine')).rejects.toThrow('different client identity')
      await expect(restarted.importInvitation(workspace, invitation, '-oProxyCommand=bad')).rejects.toThrow()
      await expect(restarted.importInvitation(workspace, { ...invitation, grant: { ...invitation.grant, expiresAt: '2020-01-01T00:00:00Z' } }, 'owner-machine')).rejects.toThrow('expired')
      let pendingSignal: AbortSignal | undefined
      const cancelled = new RemoteVSCodeManager(profile, { identity: async () => participant, tunnel: async (_host, _port, signal) => {
        pendingSignal = signal
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      } })
      const connecting = cancelled.connect(workspace, enrollment.id)
      const rejected = expect(connecting).rejects.toThrow('cancelled')
      await vi.waitFor(() => expect(pendingSignal).toBeDefined())
      await cancelled.disconnect(workspace, enrollment.id)
      await rejected
      expect(pendingSignal?.aborted).toBe(true)
      cancelled.close()
      await manager.connect(workspace, enrollment.id)
      await fetch(`http://127.0.0.1:${bridge.descriptor.port}/remote/revoke`, { method: 'POST', headers, body: JSON.stringify({ ...identity, grantId: invitation.grant.id }) })
      expect(await manager.read(workspace, enrollment.target)).toMatchObject({ connectionState: 'offline', canSend: false, bridgeError: expect.stringContaining('revoked') })
      await manager.forget(workspace, enrollment.id)
      expect(await manager.list(workspace)).toEqual([])
      expect(await readFile(file, 'utf8')).toBe(source)
      restarted.close()
    } finally { manager.close(); await ssh.close(); await bridge.close(); await rm(root, { recursive: true, force: true }) }
  }, 20000)
})