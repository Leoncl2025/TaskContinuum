// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { startVSCodeChatCompanion } from '../src/main/vscodeChatCompanion'
import { RemoteVSCodeManager } from '../src/main/vscodeRemoteClient'
import { remoteInvitationFileSchema, remoteInvitationSchema } from '../src/main/vscodeRemoteProtocol'
import { DevTunnelCli } from '../src/main/devTunnel/cli'
import { DeviceSshKeys } from '../src/main/devTunnel/identity'
import { ManagedDevTunnels } from '../src/main/devTunnel/manager'
import type { TunnelCloud } from '../src/main/devTunnel/cloud'

describe('managed original VS Code access', () => {
  it('binds invitations to device keys and uses managed SSH without alias fallback or replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-managed-original-'))
    const workspace = join(root, 'tasks')
    const storage = join(root, 'source')
    const identity = { nativeSessionId: 'original', workspaceStorageId: 'a'.repeat(32) }
    const directory = join(storage, identity.workspaceStorageId, 'chatSessions')
    await Promise.all([mkdir(workspace), mkdir(directory, { recursive: true })])
    const source = JSON.stringify({ customTitle: 'Original on B', inputState: { mode: { id: 'agent', kind: 'agent' } }, requests: [{ requestId: 'old', message: 'Original history', result: {} }] })
    const sourceFile = join(directory, 'original.json')
    await writeFile(sourceFile, source)
    const dispatch = vi.fn(async () => ({ state: 'submitted' as const, nativeRequestId: 'one' }))
    const bridge = await startVSCodeChatCompanion({ storageRoot: storage, workspaceStorageId: identity.workspaceStorageId, discoveryDirectory: join(root, 'bridge', 'bridges'), vscodeVersion: '1.136.1', open: async () => {}, dispatch })
    const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
    const cli = new DevTunnelCli(async (args) => args[0] === 'user' ? { status: 'Logged in', provider: 'microsoft', username: 'owner@example.test', tenantId: 'tenant', objectId: 'owner' } : { tunnel: { tunnelId: `taskcontinuum-${'b'.repeat(32)}.jpe1`, accessControl: [], hostConnections: 0 } })
    let port = 0
    const cloud: TunnelCloud = {
      host: async (_id, value) => { port = value; return { close: async () => {}, connected: () => true } },
      connect: async () => { const stream = createConnection(port, '127.0.0.1'); return { stream, close: async () => { stream.destroy() }, connected: () => !stream.destroyed } },
    }
    const owner = new ManagedDevTunnels(join(root, 'owner'), new DeviceSshKeys(join(root, 'owner'), protector), cli, cloud)
    const receiver = new ManagedDevTunnels(join(root, 'receiver'), new DeviceSshKeys(join(root, 'receiver'), protector), cli, cloud)
    const participant = { clientId: randomUUID(), username: 'Alice', machineName: 'Machine-A' }
    const fallback = vi.fn()
    const options = { identity: async () => participant, tunnel: fallback, devTunnel: receiver.connect.bind(receiver), devTunnelPublicKey: async () => (await receiver.keys.get('client')).publicKey }
    const manager = new RemoteVSCodeManager(join(root, 'profile'), options)
    try {
      await owner.publish()
      const response = await fetch(`http://127.0.0.1:${bridge.descriptor.port}/remote/grant`, { method: 'POST', headers: { Authorization: `Bearer ${bridge.descriptor.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...identity, participant, canSend: true }) })
      const invitation = remoteInvitationSchema.parse(await response.json())
      const devTunnel = owner.authorize(invitation.grant, (await receiver.keys.get('client')).publicKey, invitation.port)
      const file = remoteInvitationFileSchema.parse({ ...invitation, devTunnel })
      const entry = await manager.importInvitation(workspace, file)
      expect(entry).toMatchObject({ transport: 'dev-tunnel', tunnelId: devTunnel.tunnelId, state: 'disconnected' })
      expect(JSON.stringify(entry)).not.toContain(invitation.token)
      await manager.connect(workspace, entry.id)
      expect((await manager.read(workspace, entry.target)).messages[0].text).toBe('Original history')
      const commandId = randomUUID()
      await manager.send(workspace, entry.target, commandId, 'Continue once')
      await manager.send(workspace, entry.target, commandId, 'Continue once')
      expect(dispatch).toHaveBeenCalledTimes(1)
      await manager.disconnect(workspace, entry.id)
      expect(await manager.read(workspace, entry.target)).toMatchObject({ connectionState: 'offline', canSend: false })
      const restarted = new RemoteVSCodeManager(join(root, 'profile'), options)
      expect((await restarted.list(workspace))[0].state).toBe('disconnected')
      expect(await restarted.read(workspace, entry.target)).toMatchObject({ canSend: false })
      restarted.close()
      await expect(manager.importInvitation(workspace, { ...file, devTunnel: { ...devTunnel, clientPublicKey: (await owner.keys.get('host')).publicKey } })).rejects.toThrow('SSH identity')
      owner.revoke(invitation.grant.id)
      await expect(manager.connect(workspace, entry.id)).rejects.toThrow('SSH')
      expect(fallback).not.toHaveBeenCalled()
      expect(await readFile(sourceFile, 'utf8')).toBe(source)
    } finally { manager.close(); await receiver.close(); await owner.close(); await bridge.close(); await rm(root, { recursive: true, force: true }) }
  })
})