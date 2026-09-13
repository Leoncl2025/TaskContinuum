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
import { AgentHostRegistry } from '../src/main/agentHostRegistry'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { startAgentHostFixture } from './agent-host-fixture'
import { updateRepositoryAgentHostLink } from '../src/main/repositorySessionLinks'
import { locallyLinkedAgentHostSessions } from '../src/main/linkedSessionPolicy'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { modelConfigFixture } from './agent-host-model-fixture'

it('streams the exact AHP chat through existing paired SSH and revokes access without a Companion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuum-ahp-device-'))
  const tasksB = join(root, 'tasks-b'), tasksA = join(root, 'tasks-a'), profileB = join(root, 'profile-b'), discovery = join(root, 'discovery')
  await Promise.all([mkdir(tasksB), mkdir(join(tasksA, '.taskcontinuum'), { recursive: true }), mkdir(discovery)])
  const fixture = await startAgentHostFixture()
  await writeFile(join(discovery, 'host.json'), JSON.stringify(fixture.endpoint))
  const owner = { clientId: randomUUID(), machineName: hostname() }
  const participant = { clientId: randomUUID(), username: 'Alice', machineName: 'A' }
  const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
  const registry = new AgentHostRegistry(profileB, [discovery], async () => owner)
  const legacyResolve = vi.fn(async () => { throw new Error('No legacy Companion is running.') })
  const host = new VSCodeDeviceHost(profileB, protector, legacyResolve)
  host.setAgentHostAccess(registry, (folder) => locallyLinkedAgentHostSessions(profileB, folder, owner))
  const ssh = await startSessionSshHost(newSshKeyPair())
  const key = newSshKeyPair()
  const transport = vi.fn(async (invitation, signal) => openSessionSshBridge(createConnection(ssh.port, '127.0.0.1'), { key, hostPublicKey: ssh.publicKey, grantId: invitation.id, targetPort: invitation.port, signal }))
  const client = new VSCodeDeviceClient(join(root, 'profile-a'), protector, transport, async () => {})
  const target = { hostId: fixture.hostId, sessionId: fixture.sessionId, chatId: fixture.chatId, owner }
  const connection = new AgentHostConnection(target, join(root, 'profile-a'), (signal) => client.agentHostTransport(tasksA, target, signal))
  let raw: AhpClient | undefined
  try {
    const pair = await host.pair(participant, key.publicKey)
    await host.setWorkspace(pair.id, await canonicalPolicyRoot(tasksB), true)
    const port = await host.start()
    ssh.allow(pair.id, key.publicKey, port, pair.expiresAt, true)
    await client.import(tasksA, deviceInvitationSchema.parse({ schemaVersion: 2, provider: 'vscode-copilot-device', id: pair.id, ownerId: await host.ownerId(), ownerClientId: owner.clientId, machineName: hostname(), participant, token: pair.token, expiresAt: pair.expiresAt, port,
      devTunnel: { kind: 'dev-tunnel', tunnelId: `taskcontinuum-${'f'.repeat(32)}.jpe1`, sshPort: ssh.port, hostPublicKey: ssh.publicKey, clientPublicKey: key.publicKey } }), true)
    const linked = await updateRepositoryAgentHostLink(tasksB, 'T-0001', target, null)
    await writeFile(join(tasksA, '.taskcontinuum/session-bindings.json'), JSON.stringify(linked.document))
    expect((await client.agentHostSessions(tasksA)).sessions).toEqual([])
    await recordLocalLink(profileB, tasksB, 'T-0001', linked.document.bindings['T-0001'], owner)
    expect((await client.agentHostSessions(tasksA)).sessions).toMatchObject([{ ...target, canSend: true }])
    await connection.open()
    const ownerTurnId = randomUUID()
    fixture.action({ type: 'chat/turnStarted', turnId: ownerTurnId, startedAt: new Date().toISOString(), message: { text: 'Started in the owner editor', origin: { kind: 'user' } } })
    fixture.action({ type: 'chat/responsePart', turnId: ownerTurnId, part: { id: 'owner-answer', kind: 'markdown', content: '' } })
    fixture.action({ type: 'chat/delta', turnId: ownerTurnId, partId: 'owner-answer', content: 'Owner output before completion.' })
    await expect.poll(() => connection.view.chat?.activeTurn?.responseParts).toContainEqual({ id: 'owner-answer', kind: 'markdown', content: 'Owner output before completion.' })
    expect(connection.view.chat?.turns).toHaveLength(0)
    expect(connection.view.canSend).toBe(false)
    expect(fixture.dispatches).toHaveLength(0)
    fixture.drop()
    await expect.poll(() => connection.view.state).toBe('offline')
    fixture.action({ type: 'chat/delta', turnId: ownerTurnId, partId: 'owner-answer', content: ' Continued while disconnected.' })
    await connection.open()
    expect(connection.view.chat?.activeTurn).toMatchObject({ id: ownerTurnId, responseParts: [{ id: 'owner-answer', kind: 'markdown', content: 'Owner output before completion. Continued while disconnected.' }] })
    expect(fixture.dispatches).toHaveLength(0)
    fixture.action({ type: 'chat/turnComplete', turnId: ownerTurnId, duration: 1 })
    await expect.poll(() => connection.view.chat?.activeTurn).toBeUndefined()
    expect(connection.view.chat?.turns).toHaveLength(1)
    const selection = { model: { id: 'owner-model', config: { reasoningEffort: 'high', contextSize: 128000 } }, agent: { uri: 'file:///fixture/plan.agent.md' } }
    fixture.draft('', selection)
    const id = randomUUID()
    expect(await connection.models()).toContainEqual({ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli', configSchema: modelConfigFixture })
    const remoteModel = { id: 'gpt-6', config: { thinkingLevel: 'max', contextSize: 872000 } }
    await connection.send(id, 'Original over SSH', undefined, async () => {}, undefined, remoteModel)
    expect(fixture.dispatches).toEqual([expect.objectContaining({ type: 'chat/turnStarted', turnId: id, message: expect.objectContaining({ ...selection, model: remoteModel }) })])
    fixture.action({ type: 'chat/responsePart', turnId: id, part: { id: 'answer', kind: 'markdown', content: '' } })
    fixture.action({ type: 'chat/delta', turnId: id, partId: 'answer', content: 'Incremental remote answer' })
    await expect.poll(() => connection.view.chat?.activeTurn?.responseParts).toContainEqual({ id: 'answer', kind: 'markdown', content: 'Incremental remote answer' })
    expect(fixture.dispatches).toHaveLength(1)
    expect(transport).toHaveBeenCalledOnce()
    expect(legacyResolve).not.toHaveBeenCalled()
    raw = new AhpClient(await client.agentHostTransport(tasksA, target, new AbortController().signal))
    raw.connect()
    await raw.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'] })
    const scoped = (await raw.subscribe(target.sessionId)).result.snapshot
    expect(JSON.stringify(scoped)).not.toContain('Unshared sibling title')
    expect(JSON.stringify(scoped)).not.toContain('private-other')
    const catalog = (await raw.subscribe('ahp-root://')).result.snapshot
    expect(catalog?.state).toEqual({ agents: [{ provider: 'copilotcli', displayName: 'copilotcli', description: '', models: [{ id: 'owner-model', name: 'Owner model', provider: 'copilotcli' }, { id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli', configSchema: modelConfigFixture }] }] })
    expect(JSON.stringify(catalog)).not.toMatch(/private|activeSessions|disabled-model/)
    await expect(raw.subscribe('ahp-chat:/private-other')).rejects.toThrow('not authorized')
    await expect(raw.resourceRead({ uri: 'file:///private.txt' })).rejects.toThrow('not authorized')
    await raw.shutdown()
    await host.setWorkspace(pair.id, await canonicalPolicyRoot(tasksB), false)
    await expect.poll(() => connection.view.state).toBe('offline')
    await connection.open()
    expect(connection.view.canSend).toBe(false)
    await expect(connection.send(randomUUID(), 'Read-only must not send', undefined, async () => {})).rejects.toThrow('read-only')
    await updateRepositorySessionLink(tasksB, 'T-0001', null, linked.revision)
    fixture.action({ type: 'chat/delta', turnId: id, partId: 'answer', content: 'Not shared anymore' })
    await expect.poll(() => connection.view.state).toBe('offline')
    expect(JSON.stringify(connection.view.chat)).not.toContain('Not shared anymore')
    expect(fixture.dispatches).toHaveLength(1)
  } finally { await raw?.shutdown(); await connection.close(); client.close(); await host.close(); await registry.close(); await ssh.close(); await fixture.close(); await rm(root, { recursive: true, force: true }) }
}, 20000)

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