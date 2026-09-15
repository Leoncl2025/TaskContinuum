// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { VSCodeDeviceHost } from '../src/main/vscodeDeviceHost'
import { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import { newSshKeyPair, openSessionSshBridge, startSessionSshHost } from '../src/main/devTunnel/sessionSsh'
import { deviceInvitationSchema } from '../src/main/vscodeDeviceProtocol'
import { readRepositorySessionLinks, removeRepositorySessionLink, updateRepositoryAgentHostLink } from '../src/main/repositorySessionLinks'
import { canonicalPolicyRoot, locallyLinkedAgentHostSessions, recordLocalLink } from '../src/main/linkedSessionPolicy'
import { AgentHostRegistry } from '../src/main/agentHostRegistry'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { startAgentHostFixture } from './agent-host-fixture'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { modelConfigFixture } from './agent-host-model-fixture'
import { agentHostTargetFixture, createImmutableBindingsFixture } from './immutable-bindings-fixture'

it('streams the exact AHP chat through paired SSH with immutable bindings and receipt-scoped revocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'continuum-ahp-device-'))
  const tasksB = join(root, 'tasks-b'), tasksA = join(root, 'tasks-a'), profileB = join(root, 'profile-b'), discovery = join(root, 'discovery')
  await Promise.all([mkdir(tasksB), mkdir(join(tasksA, '.taskcontinuum'), { recursive: true }), mkdir(discovery)])
  const linksB = await createImmutableBindingsFixture(tasksB), linksA = await createImmutableBindingsFixture(tasksA)
  const fixture = await startAgentHostFixture()
  await writeFile(join(discovery, 'host.json'), JSON.stringify(fixture.endpoint))
  const owner = { clientId: randomUUID(), machineName: hostname() }
  const participant = { clientId: randomUUID(), username: 'Alice', machineName: 'A' }
  const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
  const registry = new AgentHostRegistry(profileB, [discovery], async () => owner)
  const host = new VSCodeDeviceHost(profileB, protector)
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
    const linked = await updateRepositoryAgentHostLink(tasksB, 'T-0001', target, linksB.snapshot.revision)
    await linksA.importRecords(await linksB.store.getRecords())
    expect((await readRepositorySessionLinks(tasksA)).document).toEqual(linked.document)
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
    await removeRepositorySessionLink(tasksB, 'T-0001', linked.revision)
    fixture.action({ type: 'chat/delta', turnId: id, partId: 'answer', content: 'Not shared anymore' })
    await expect.poll(() => connection.view.state).toBe('offline')
    expect(JSON.stringify(connection.view.chat)).not.toContain('Not shared anymore')
    expect(fixture.dispatches).toHaveLength(1)
    await linksA.importRecords(await linksB.store.getRecords())
    expect((await readRepositorySessionLinks(tasksA)).document.bindings).toEqual({})
    await expect(readFile(join(tasksA, '.taskcontinuum', 'session-bindings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await raw?.shutdown(); await connection.close(); client.close(); await host.close(); await registry.close(); await ssh.close(); await fixture.close(); await linksA.close(); await linksB.close(); await rm(root, { recursive: true, force: true }) }
}, 20000)

it.each(['vscode-copilot', 'github-copilot'])('preserves old %s data without importing bindings or granting Agent Host access', async (provider) => {
  const root = await mkdtemp(join(tmpdir(), 'continuum-git-device-'))
  const tasksB = join(root, 'tasks-b'), tasksA = join(root, 'tasks-a'), profileB = join(root, 'profile-b'), profileA = join(root, 'profile-a')
  const owner = { clientId: randomUUID(), machineName: hostname() }
  const old: unknown = { schemaVersion: 1, bindings: { 'T-0001': {
    provider, sessionId: 'original', owner, ...(provider === 'vscode-copilot' ? { workspaceStorageId: 'a'.repeat(32) } : {}),
  } } }
  const content = JSON.stringify(old)
  for (const folder of [tasksA, tasksB]) {
    await mkdir(join(folder, '.taskcontinuum'), { recursive: true })
    await writeFile(join(folder, '.taskcontinuum', 'session-bindings.json'), content)
  }
  const linksB = await createImmutableBindingsFixture(tasksB), linksA = await createImmutableBindingsFixture(tasksA)
  try {
    expect((await readRepositorySessionLinks(tasksA)).document.bindings).toEqual({})
    expect((await readRepositorySessionLinks(tasksB)).document.bindings).toEqual({})
    expect(await linksA.store.getRecords()).toEqual([])
    expect(await linksB.store.getRecords()).toEqual([])
    expect(await locallyLinkedAgentHostSessions(profileB, tasksB, owner)).toEqual([])
    expect(await locallyLinkedAgentHostSessions(profileA, tasksA, owner)).toEqual([])
    const target = agentHostTargetFixture('original', owner)
    const saved = await updateRepositoryAgentHostLink(tasksB, 'T-0001', target, linksB.snapshot.revision)
    await linksA.importRecords(await linksB.store.getRecords())
    expect((await readRepositorySessionLinks(tasksA)).document).toEqual(saved.document)
    expect(await locallyLinkedAgentHostSessions(profileB, tasksB, owner)).toEqual([])
    await recordLocalLink(profileB, tasksB, 'T-0001', saved.document.bindings['T-0001'], owner)
    expect(await locallyLinkedAgentHostSessions(profileB, tasksB, owner)).toEqual([target])
    expect(await locallyLinkedAgentHostSessions(profileA, tasksA, owner)).toEqual([])
    expect(await linksB.store.getRecords()).toMatchObject([{ kind: 'binding', payload: {
      action: 'set', taskId: 'T-0001', target: { provider: 'agent-host', ...target },
    } }])
    for (const folder of [tasksA, tasksB]) expect(await readFile(join(folder, '.taskcontinuum', 'session-bindings.json'), 'utf8')).toBe(content)
  } finally { await linksA.close(); await linksB.close(); await rm(root, { recursive: true, force: true }) }
})