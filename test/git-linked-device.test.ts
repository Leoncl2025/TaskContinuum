// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { VSCodeDeviceHost } from '../src/main/vscodeDeviceHost'
import { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import { RemoteVSCodeManager } from '../src/main/vscodeRemoteClient'
import { newSshKeyPair, openSessionSshBridge, startSessionSshHost } from '../src/main/devTunnel/sessionSsh'
import { startVSCodeChatCompanion } from '../src/main/vscodeChatCompanion'
import { resolveDeviceSession, revokeRemoteVSCode } from '../src/main/vscodeChatClient'
import { VSCodeSessionStore } from '../src/main/vscodeSessions'
import { deviceInvitationSchema } from '../src/main/vscodeDeviceProtocol'
import { updateRepositorySessionLink, readRepositorySessionLinks } from '../src/main/repositorySessionLinks'
import { canonicalPolicyRoot, locallyLinkedSessions, recordLocalLink } from '../src/main/linkedSessionPolicy'
import { vsCodeChatResource } from '../src/shared/vscodeChat'

it('opens Git-pulled owner links over one SSH device without manual session share or relinking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuum-git-device-'))
  const tasksB = join(root, 'tasks-b'), tasksA = join(root, 'tasks-a'), profileB = join(root, 'profile-b')
  const storage = join(root, 'storage'), workspaceStorageId = 'a'.repeat(32)
  const history = join(storage, workspaceStorageId, 'chatSessions')
  await Promise.all([mkdir(tasksB), mkdir(join(tasksA, '.taskcontinuum'), { recursive: true }), mkdir(history, { recursive: true })])
  for (const name of ['first', 'second', 'secret']) await writeFile(join(history, `${name}.json`), JSON.stringify({ customTitle: name, inputState: { mode: { id: 'agent', kind: 'agent' } }, requests: [{ requestId: 'old', message: name, response: [{ value: `Answer ${name}` }], result: {} }] }))
  const dispatch = vi.fn(async () => ({ state: 'submitted' as const, nativeRequestId: 'new' }))
  const opened = new Set<string>()
  const open = vi.fn(async (resource: string) => { opened.add(resource) })
  const bridge = await startVSCodeChatCompanion({ storageRoot: storage, workspaceStorageId, discoveryDirectory: join(storage, workspaceStorageId, 'taskcontinuum.vscode-bridge', 'bridges'), vscodeVersion: '1.137.0', open, isOpen: async (resource) => opened.has(resource), autoOpenOnSend: true, dispatch })
  const owner = { clientId: randomUUID(), machineName: hostname() }
  const participant = { clientId: randomUUID(), username: 'Alice', machineName: 'A' }
  const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
  const store = new VSCodeSessionStore([storage])
  const host = new VSCodeDeviceHost(profileB, protector, (...args) => resolveDeviceSession(store, ...args), (invitation) => revokeRemoteVSCode(store, invitation.identity, invitation.grant.id), (folder) => locallyLinkedSessions(profileB, folder, owner))
  const ssh = await startSessionSshHost(newSshKeyPair())
  const key = newSshKeyPair()
  const transport = vi.fn(async (invitation, signal) => openSessionSshBridge(createConnection(ssh.port, '127.0.0.1'), { key, hostPublicKey: ssh.publicKey, grantId: invitation.id, targetPort: invitation.port, signal }))
  const client = new VSCodeDeviceClient(join(root, 'profile-a'), protector, transport, async () => {})
  const manager = new RemoteVSCodeManager(join(root, 'profile-a'), { devices: client, identity: async () => participant })
  async function link(taskId: string, sessionId: string, confirm = true) {
    const saved = await updateRepositorySessionLink(tasksB, taskId, sessionId, (await readRepositorySessionLinks(tasksB)).revision, workspaceStorageId, undefined, owner)
    if (confirm) await recordLocalLink(profileB, tasksB, taskId, saved.document.bindings[taskId], owner)
    await writeFile(join(tasksA, '.taskcontinuum', 'session-bindings.json'), await readFile(join(tasksB, '.taskcontinuum', 'session-bindings.json')))
  }
  const first = { nativeSessionId: 'first', workspaceStorageId }
  try {
    const pair = await host.pair(participant, key.publicKey)
    await host.setWorkspace(pair.id, await canonicalPolicyRoot(tasksB), true)
    const port = await host.start()
    ssh.allow(pair.id, key.publicKey, port, pair.expiresAt, true)
    await client.import(tasksA, deviceInvitationSchema.parse({ schemaVersion: 2, provider: 'vscode-copilot-device', id: pair.id, ownerId: await host.ownerId(), ownerClientId: owner.clientId, machineName: hostname(), participant, token: pair.token, expiresAt: pair.expiresAt, port,
      devTunnel: { kind: 'dev-tunnel', tunnelId: `taskcontinuum-${'f'.repeat(32)}.jpe1`, sshPort: ssh.port, hostPublicKey: ssh.publicKey, clientPublicKey: key.publicKey } }), true)
    expect(transport).not.toHaveBeenCalled()
    await link('T-0001', 'first')
    const target = await manager.resolveTarget(tasksA, first)
    expect(target.remoteMachineName).toBe(owner.machineName)
    expect(JSON.stringify(await manager.read(tasksA, target))).toContain('Answer first')
    expect(open).not.toHaveBeenCalled()
    expect(await manager.read(tasksA, target)).toMatchObject({ sessionOpen: false, canSend: false, canPrepareSend: true })
    await manager.connectTarget(tasksA, target)
    expect(open).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    await manager.send(tasksA, target, randomUUID(), 'Explicit user request')
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(open).toHaveBeenLastCalledWith(vsCodeChatResource('first'))
    await link('T-0002', 'second')
    expect(JSON.stringify(await manager.read(tasksA, await manager.resolveTarget(tasksA, { ...first, nativeSessionId: 'second' })))).toContain('Answer second')
    await manager.open(tasksA, await manager.resolveTarget(tasksA, { ...first, nativeSessionId: 'second' }))
    expect(open).toHaveBeenLastCalledWith(vsCodeChatResource('second'))
    expect(transport).toHaveBeenCalledOnce()
    await link('T-0003', 'secret', false)
    await expect(manager.read(tasksA, await manager.resolveTarget(tasksA, { ...first, nativeSessionId: 'secret' }))).rejects.toThrow()
    expect((await manager.list(tasksA)).map((item) => item.title)).not.toContain('secret')
    await expect(manager.open(tasksA, await manager.resolveTarget(tasksA, { ...first, nativeSessionId: 'secret' }))).rejects.toThrow()
    const before = await readRepositorySessionLinks(tasksB)
    await updateRepositorySessionLink(tasksB, 'T-0001', null, before.revision)
    expect(await manager.read(tasksA, target)).toMatchObject({ connectionState: 'offline', canSend: false })
    await expect(manager.open(tasksA, target)).rejects.toThrow()
    await expect(manager.send(tasksA, target, randomUUID(), 'Must not execute')).rejects.toThrow()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledTimes(2)
    await host.setWorkspace(pair.id, await canonicalPolicyRoot(tasksB), null)
    const second = await manager.resolveTarget(tasksA, { ...first, nativeSessionId: 'second' })
    expect(await manager.read(tasksA, second)).toMatchObject({ connectionState: 'offline', canSend: false })
    const tampered = await readRepositorySessionLinks(tasksA)
    tampered.document.bindings['T-0002'].owner!.clientId = randomUUID()
    await writeFile(join(tasksA, '.taskcontinuum', 'session-bindings.json'), JSON.stringify(tampered.document))
    await expect(manager.read(tasksA, second)).rejects.toThrow('Pair with session owner')
  } finally { manager.close(); await host.close(); await ssh.close(); await bridge.close(); await rm(root, { recursive: true, force: true }) }
}, 20000)