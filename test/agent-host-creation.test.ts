// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { afterEach, describe, expect, it } from 'vitest'
import { agentHostCreationResultSchema } from '../src/main/agentHostCreationProtocol'
import { agentHostTargetSchema } from '../src/main/agentHostProtocol'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { connectAgentHostWebSocket } from '../src/main/agentHostTransport'
import { bindRepositoryAgentHostCreation, readRepositorySessionLinks, removeRepositorySessionLink, updateRepositoryAgentHostLink } from '../src/main/repositorySessionLinks'
import { canonicalPolicyRoot, locallyLinkedAgentHostSessions } from '../src/main/linkedSessionPolicy'
import { openSessionSshBridge, startSessionSshHost } from '../src/main/devTunnel/sessionSsh'
import { deviceRequest } from '../src/main/vscodeDeviceHttp'
import { createAgentHostCreationCallerFixture, createPairedAgentHostCreationFixture, creationFixtureKey, deferred, writeCreationTaskWorkspace } from './agent-host-creation-fixture'
import { agentHostTargetFixture, createImmutableBindingsFixture } from './immutable-bindings-fixture'

type Fixture = Awaited<ReturnType<typeof createPairedAgentHostCreationFixture>> & { bindings: Awaited<ReturnType<typeof createImmutableBindingsFixture>> }
const fixtures: Fixture[] = []
const backends: Awaited<ReturnType<typeof createImmutableBindingsFixture>>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
  await Promise.all(backends.splice(0).map((backend) => backend.close()))
})
async function fixture(): Promise<Fixture> {
  const value = await createPairedAgentHostCreationFixture()
  const bindings = await createImmutableBindingsFixture(value.workspace)
  backends.push(bindings)
  value.request.expectedRevision = bindings.snapshot.revision
  const worker = Object.assign(value, { bindings })
  fixtures.push(worker)
  return worker
}
async function callerFixture(worker: Fixture) {
  const caller = await createAgentHostCreationCallerFixture(worker)
  backends.push(await createImmutableBindingsFixture(caller.workspace))
  return caller
}
async function ready(worker: Fixture) {
  await expect.poll(async () => (await worker.status()).state, { timeout: 8000, interval: 25 }).toBe('ready')
  return (await worker.status()).session!
}
async function records(worker: Fixture) {
  return JSON.parse(await readFile(join(worker.profile, 'agent-host-creation', 'operations.json'), 'utf8')) as { nativeSessionId: string; nativeAcknowledged?: boolean; nativeLifecycle?: string; pairId: string; phase: string; everReady: boolean; result: { state: string; error?: string }; request: { operationId: string } }[]
}

describe('worker-authoritative native Agent Host creation', () => {
  it('creates with the existing paired workspace send policy, binds on B, and records only portable identity in Git', async () => {
    const worker = await fixture()
    const catalog = await worker.workers()
    expect(catalog).toMatchObject({ deviceId: worker.pair.id, owner: worker.owner, hosts: [{ hostId: worker.native.hostId, available: true }],
      workspaces: [{ id: worker.request.workspaceId, canSend: true, taskState: 'available', expectedRevision: worker.bindings.snapshot.revision }] })
    expect(await locallyLinkedAgentHostSessions(worker.profile, worker.workspace, worker.owner)).toEqual([])
    expect(await worker.begin()).toEqual({ operationId: worker.request.operationId, taskId: 'T-0007', workspaceId: worker.request.workspaceId, hostId: worker.native.hostId, state: 'creating' })
    const session = await ready(worker)
    const links = await readRepositorySessionLinks(worker.workspace)
    expect(links.document.bindings['T-0007']).toEqual({ provider: 'agent-host', ...agentHostTargetSchema.parse({
      owner: worker.owner, sessionId: session.sessionId, chatId: session.chatId,
    }) })
    expect(await locallyLinkedAgentHostSessions(worker.profile, worker.workspace, worker.owner)).toEqual([agentHostTargetSchema.parse({
      owner: session.owner, sessionId: session.sessionId, chatId: session.chatId,
    })])
    expect(session.owner.clientId).toBe(worker.owner.clientId)
    expect(session.owner.clientId).not.toBe(worker.participant.clientId)
    expect(worker.native.creations).toEqual([{ channel: session.sessionId, provider: 'copilotcli', workingDirectories: [pathToFileURL(await canonicalPolicyRoot(worker.workspace)).href],
      config: { isolation: 'folder', autoApprove: 'default', mode: 'interactive' } }])
    expect(worker.native.calls.some((call) => call.method === 'dispatchAction')).toBe(false)
    expect(JSON.stringify(catalog) + JSON.stringify(await worker.status())).not.toContain(worker.workspace)
    expect(JSON.stringify(catalog) + JSON.stringify(await worker.status())).not.toContain(worker.pair.token)
    const immutable = await worker.bindings.store.getRecords()
    expect(immutable).toMatchObject([{ kind: 'binding', payload: { schemaVersion: 2, action: 'set', taskId: 'T-0007', target: links.document.bindings['T-0007'] } }])
    const git = JSON.stringify(immutable)
    expect(git).not.toContain(worker.request.operationId)
    expect(git).not.toContain(worker.workspace)
    expect(git).not.toContain('requestHash')
    await expect(readFile(join(worker.workspace, '.taskcontinuum', 'session-bindings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await worker.workers()).workspaces).toMatchObject([{ taskState: 'bound', expectedRevision: links.revision }])
    expect((await records(worker))[0]).toMatchObject({ pairId: worker.pair.id, nativeSessionId: session.sessionId, result: { state: 'ready' } })
  })

  it('uses the same paired SSH device route and does not permit raw createSession on the scoped AHP stream', async () => {
    const worker = await fixture()
    const ssh = await startSessionSshHost(creationFixtureKey())
    const signal = new AbortController()
    ssh.allow(worker.pair.id, worker.key.publicKey, worker.port, worker.pair.expiresAt, true)
    const bridge = await openSessionSshBridge(createConnection(ssh.port, '127.0.0.1'), { key: worker.key, hostPublicKey: ssh.publicKey, grantId: worker.pair.id, targetPort: worker.port, signal: signal.signal })
    let raw: AhpClient | undefined
    try {
      const result = agentHostCreationResultSchema.parse(await deviceRequest(bridge.port, worker.port, worker.pair.token, '/device/agent-host/create', worker.request, AbortSignal.timeout(10000)))
      expect(result.state).toBe('creating')
      const session = await ready(worker)
      const target = { owner: session.owner, sessionId: session.sessionId, chatId: session.chatId }
      raw = new AhpClient(await connectAgentHostWebSocket(`ws://127.0.0.1:${bridge.port}/device/agent-host?target=${Buffer.from(JSON.stringify(target)).toString('base64url')}`,
        { headers: { Host: `127.0.0.1:${worker.port}`, Authorization: `Bearer ${worker.pair.token}` } }, signal.signal))
      raw.connect()
      await raw.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'] })
      await expect(raw.request('createSession', { channel: `copilotcli:/${randomUUID()}`, provider: 'copilotcli' })).rejects.toThrow()
      expect(worker.native.creations).toHaveLength(1)
      expect(worker.native.calls.filter((call) => call.method === 'dispatchAction')).toEqual([])
    } finally { await raw?.shutdown(); signal.abort(); bridge.close(); await ssh.close() }
  })

  it.each(['none', 'caller', 'worker'] as const)('completes the production caller/device/worker flow over SSH with durable %s conflict recovery', async (conflict) => {
    const worker = await fixture()
    const caller = await callerFixture(worker)
    let raw: AhpClient | undefined
    const authorize = async () => {}
    try {
      const workers = await caller.client.workers(caller.workspace, worker.request.taskId)
      expect(workers).toMatchObject([{ owner: worker.owner, state: 'connected', hosts: [{ hostId: worker.native.hostId, available: true }],
        workspaces: [{ id: worker.request.workspaceId, canSend: true, taskState: 'available' }] }])
      const request = { ...worker.request, workerId: workers[0].id }
      expect(request.workerId).not.toBe(worker.pair.id)
      expect(await caller.client.list(caller.workspace, request.taskId)).toEqual([])
      worker.native.setLifecycle('creating')
      const acknowledgement = worker.native.pauseAcknowledgement()
      expect((await caller.client.create(caller.workspace, request, authorize)).state).toBe('creating')
      await expect.poll(() => worker.native.creations.length).toBe(1)
      expect((await caller.client.list(caller.workspace, request.taskId))[0].operationId).toBe(request.operationId)
      expect((await readRepositorySessionLinks(caller.workspace)).document.bindings).toEqual({})

      const conflictingRoot = conflict === 'caller' ? caller.workspace : worker.workspace
      if (conflict !== 'none') await updateRepositoryAgentHostLink(conflictingRoot, request.taskId,
        agentHostTargetFixture(`${conflict}-existing-session`, worker.owner), (await readRepositorySessionLinks(conflictingRoot)).revision)
      acknowledgement.resolve()
      await expect.poll(async () => (await caller.client.status(caller.workspace, request.operationId, authorize)).state, { timeout: 8000, interval: 25 }).toBe(conflict === 'none' ? 'ready' : 'created-unbound')
      const initial = await caller.client.status(caller.workspace, request.operationId, authorize)
      const identity = initial.session!
      expect(identity).toMatchObject({ sessionId: worker.native.creations[0].channel, owner: worker.owner, provider: 'copilotcli' })
      expect(identity).not.toHaveProperty('hostId')
      await caller.restart()
      expect((await caller.client.workers(caller.workspace, request.taskId))[0].id).toBe(request.workerId)
      expect(caller.connections).toBe(2)

      if (conflict !== 'none') {
        expect((await readRepositorySessionLinks(conflictingRoot)).document.bindings[request.taskId].sessionId).toBe(`copilotcli:/${conflict}-existing-session`)
        const before = await readRepositorySessionLinks(conflictingRoot)
        await removeRepositorySessionLink(conflictingRoot, request.taskId, before.revision)
        expect((await caller.client.status(caller.workspace, request.operationId, authorize)).state).toBe('created-unbound')
        expect((await readRepositorySessionLinks(conflictingRoot)).document.bindings).toEqual({})
        expect(await caller.client.bind(caller.workspace, request.operationId, authorize)).toMatchObject({ state: 'ready', session: identity, workerId: request.workerId })
      }
      expect(await caller.client.status(caller.workspace, request.operationId, authorize)).toMatchObject({ state: 'ready', session: identity, workerId: request.workerId })
      const linksA = await readRepositorySessionLinks(caller.workspace), linksB = await readRepositorySessionLinks(worker.workspace)
      expect(linksA.document.bindings[request.taskId]).toEqual(linksB.document.bindings[request.taskId])
      expect(await locallyLinkedAgentHostSessions(worker.profile, worker.workspace, worker.owner)).toHaveLength(1)
      expect(await locallyLinkedAgentHostSessions(caller.profile, caller.workspace, worker.owner)).toEqual([])
      expect(await caller.client.list(caller.workspace, request.taskId)).toEqual([])
      expect((await caller.client.create(caller.workspace, request, authorize)).session).toEqual(identity)

      const target = { owner: identity.owner, sessionId: identity.sessionId, chatId: identity.chatId }
      raw = new AhpClient(await caller.devices.agentHostTransport(caller.workspace, target, new AbortController().signal))
      raw.connect()
      await raw.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'] })
      expect((await raw.request('subscribe', { channel: identity.chatId })).snapshot?.resource).toBe(identity.chatId)
      expect(worker.native.creations).toHaveLength(1)
      expect(worker.native.calls.filter((call) => call.method === 'dispatchAction')).toEqual([])
    } finally { await raw?.shutdown(); await caller.close() }
  })

  it.each(['read-only', 'out-of-scope', 'expired', 'revoked'] as const)('rejects %s access without any native create', async (mode) => {
    const worker = await fixture()
    if (mode === 'read-only') await worker.host.setWorkspace(worker.pair.id, await canonicalPolicyRoot(worker.workspace), false)
    if (mode === 'out-of-scope') worker.request.workspaceId = 'e'.repeat(64)
    if (mode === 'expired') await worker.expire()
    if (mode === 'revoked') await worker.host.revoke(worker.pair.id)
    await expect(worker.begin()).rejects.toMatchObject({ status: 403 })
    expect(worker.native.creations).toEqual([])
    if (mode === 'read-only') expect((await worker.workers()).workspaces[0]).toMatchObject({ canSend: false, taskState: 'available' })
  })

  it('rechecks send permission after asynchronous native configuration preparation', async () => {
    const worker = await fixture()
    const gate = worker.native.pausePreparation()
    await worker.begin()
    await expect.poll(() => worker.native.calls.some((call) => call.method === 'resolveSessionConfig')).toBe(true)
    await worker.host.setWorkspace(worker.pair.id, await canonicalPolicyRoot(worker.workspace), false)
    gate.resolve()
    await expect.poll(async () => (await records(worker))[0].result.state).toBe('failed')
    expect(worker.native.creations).toEqual([])
    await expect(worker.status()).rejects.toMatchObject({ status: 403 })
    await worker.host.setWorkspace(worker.pair.id, await canonicalPolicyRoot(worker.workspace), true)
    expect((await worker.begin()).state).toBe('failed')
    expect(worker.native.creations).toEqual([])
  })

  it('reserves durably before native dispatch and does not bind after permission loss while awaiting acknowledgement', async () => {
    const worker = await fixture()
    const gate = worker.native.pauseAcknowledgement()
    await worker.begin()
    await expect.poll(() => worker.native.creations.length).toBe(1)
    expect((await records(worker))[0]).toMatchObject({ phase: 'dispatched', nativeSessionId: worker.native.creations[0].channel, request: { operationId: worker.request.operationId } })
    await worker.host.setWorkspace(worker.pair.id, await canonicalPolicyRoot(worker.workspace), false)
    gate.resolve()
    await expect.poll(async () => (await records(worker))[0].result.state).toBe('uncertain')
    expect((await readRepositorySessionLinks(worker.workspace)).document.bindings).toEqual({})
    await expect(worker.status()).rejects.toMatchObject({ status: 403 })
    await worker.host.setWorkspace(worker.pair.id, await canonicalPolicyRoot(worker.workspace), true)
    expect((await ready(worker)).sessionId).toBe(worker.native.creations[0].channel)
    expect(worker.native.creations).toHaveLength(1)
    await worker.host.revoke(worker.pair.id)
    await expect(worker.status()).rejects.toMatchObject({ status: 403 })
    await expect(worker.begin()).rejects.toMatchObject({ status: 403 })
    await expect(worker.bind(worker.request.expectedRevision)).rejects.toMatchObject({ status: 403 })
  })

  it('deduplicates operation IDs, rejects changed payloads, and reserves a task across competing paired callers', async () => {
    const worker = await fixture()
    const gate = worker.native.pausePreparation()
    const [first, duplicate] = await Promise.all([worker.begin(), worker.begin()])
    expect(first.operationId).toBe(duplicate.operationId)
    await expect(worker.begin({ ...worker.request, hostId: 'different-host-123' })).rejects.toMatchObject({ status: 409 })
    await expect(worker.begin({ ...worker.request, expectedRevision: 'a'.repeat(64) })).rejects.toMatchObject({ status: 409 })
    await expect(worker.begin({ ...worker.request, operationId: randomUUID() })).rejects.toMatchObject({ status: 409 })
    const other = await worker.host.pair({ ...worker.participant, clientId: randomUUID() }, creationFixtureKey().publicKey)
    await worker.host.setWorkspace(other.id, await canonicalPolicyRoot(worker.workspace), true)
    await expect(worker.call('/device/agent-host/create', { ...worker.request, operationId: randomUUID() }, other.token)).rejects.toMatchObject({ status: 409 })
    await expect(worker.call('/device/agent-host/creation-status', { operationId: worker.request.operationId, workspaceId: worker.request.workspaceId }, other.token)).rejects.toMatchObject({ status: 403 })
    expect(worker.native.creations).toEqual([])
    gate.resolve()
    const session = await ready(worker)
    expect((await worker.begin()).session).toEqual(session)
    expect(worker.native.creations).toHaveLength(1)
  })

  it('recovers a lost native acknowledgement from a verified ready session at only the durable exact URI', async () => {
    const worker = await fixture()
    worker.native.setLifecycle('ready')
    worker.native.loseAcknowledgement()
    await worker.begin()
    await expect.poll(async () => (await records(worker))[0].result.state).toBe('uncertain')
    const original = (await records(worker))[0].nativeSessionId
    expect(worker.native.creations).toHaveLength(1)
    await worker.restart()
    const before = worker.native.calls.length
    const session = await ready(worker)
    expect(session.sessionId).toBe(original)
    expect(worker.native.calls.slice(before).filter((call) => call.method === 'subscribe').every((call) => call.params?.channel === original || call.params?.channel === session.chatId)).toBe(true)
    expect(worker.native.calls.slice(before).some((call) => call.method === 'listSessions')).toBe(false)
    expect((await worker.begin()).session?.sessionId).toBe(original)
    expect(worker.native.creations).toHaveLength(1)
  })

  it('keeps a missing post-dispatch session uncertain across restart and never replays create', async () => {
    const worker = await fixture()
    worker.native.loseAcknowledgement(true)
    await worker.begin()
    await expect.poll(async () => (await records(worker))[0].result.state).toBe('uncertain')
    const original = (await records(worker))[0].nativeSessionId
    await worker.restart()
    for (let index = 0; index < 3; index++) expect((await worker.status()).state).toBe('uncertain')
    expect((await worker.begin()).state).toBe('uncertain')
    await expect(worker.begin({ ...worker.request, operationId: randomUUID() })).rejects.toMatchObject({ status: 409 })
    expect(worker.native.creations.map((command) => command.channel)).toEqual([original])
    expect((await readRepositorySessionLinks(worker.workspace)).document.bindings).toEqual({})
  })

  it('treats a persisted pre-dispatch intent as interrupted after restart instead of replaying it', async () => {
    const worker = await fixture()
    const gate = worker.native.pausePreparation()
    await worker.begin()
    await expect.poll(() => worker.native.calls.some((call) => call.method === 'resolveSessionConfig')).toBe(true)
    await worker.restart(async () => {
      const saved = await records(worker)
      saved[0].phase = 'reserved'
      saved[0].result = { ...saved[0].result, state: 'creating', error: undefined }
      await writeFile(join(worker.profile, 'agent-host-creation', 'operations.json'), JSON.stringify(saved))
    })
    gate.resolve()
    expect((await worker.status()).state).toBe('uncertain')
    expect((await worker.begin()).state).toBe('uncertain')
    expect(worker.native.creations).toEqual([])
  })

  it('binds an acknowledged verified provisional session and initializes only on the first explicit paired send', async () => {
    const worker = await fixture()
    worker.native.setLifecycle('creating')
    const caller = await callerFixture(worker)
    let connection: AgentHostConnection | undefined
    try {
      const [selected] = await caller.client.workers(caller.workspace, worker.request.taskId)
      const request = { ...worker.request, workerId: selected.id }
      await caller.client.create(caller.workspace, request, async () => {})
      await expect.poll(async () => (await caller.client.status(caller.workspace, request.operationId, async () => {})).state, { timeout: 8000, interval: 25 }).toBe('ready')
      const result = await worker.status()
      const session = result.session!
      expect(result).toMatchObject({ state: 'ready', nativeLifecycle: 'creating' })
      expect(result.error).toBeUndefined()
      expect((await caller.client.status(caller.workspace, request.operationId, async () => {})).nativeLifecycle).toBe('creating')
      expect((await records(worker))[0]).toMatchObject({ nativeAcknowledged: true, nativeLifecycle: 'creating', nativeSessionId: session.sessionId })
      expect(worker.native.sessions.get(session.sessionId)!.session.lifecycle).toBe('creating')
      expect(worker.native.calls.filter((call) => call.method === 'dispatchAction')).toEqual([])
      const before = await readRepositorySessionLinks(worker.workspace)
      expect((await readRepositorySessionLinks(caller.workspace)).document).toEqual(before.document)
      expect(await locallyLinkedAgentHostSessions(worker.profile, worker.workspace, worker.owner)).toHaveLength(1)
      const target = { sessionId: session.sessionId, chatId: session.chatId, owner: session.owner }
      connection = new AgentHostConnection(target, caller.profile, (signal) => caller.devices.agentHostTransport(caller.workspace, target, signal))
      await connection.open()
      expect(connection.view.canSend).toBe(true)
      const turnId = randomUUID()
      await connection.send(turnId, 'First explicit fixture message', undefined, async () => {})
      expect(worker.native.calls.filter((call) => call.method === 'dispatchAction')).toMatchObject([{ params: {
        channel: session.chatId, action: { type: 'chat/turnStarted', turnId, message: { text: 'First explicit fixture message' } },
      } }])
      expect(worker.native.sessions.get(session.sessionId)!.session.lifecycle).toBe('ready')
      expect(await worker.status()).toMatchObject({ state: 'ready', nativeLifecycle: 'ready' })
      expect((await records(worker))[0].nativeLifecycle).toBe('ready')
      expect(await readRepositorySessionLinks(worker.workspace)).toEqual(before)
      expect(worker.native.creations).toHaveLength(1)
    } finally { await connection?.close(); await caller.close() }
  })

  it.each(['lost', 'non-null'] as const)('keeps a %s native acknowledgement with a provisional session uncertain across restart', async (acknowledgement) => {
    const worker = await fixture()
    worker.native.setLifecycle('creating')
    if (acknowledgement === 'lost') worker.native.loseAcknowledgement()
    else worker.native.setAcknowledgement({})
    await worker.begin()
    await expect.poll(async () => (await records(worker))[0].result.state).toBe('uncertain')
    expect((await records(worker))[0].nativeAcknowledged).toBe(false)
    const original = worker.native.creations[0].channel
    expect(worker.native.sessions.get(original)!.session.lifecycle).toBe('creating')
    await worker.restart()
    for (let index = 0; index < 3; index++) expect(await worker.status()).toMatchObject({ state: 'uncertain', nativeLifecycle: 'creating', error: expect.stringContaining('acknowledgement was not durably confirmed') })
    expect((await worker.begin()).state).toBe('uncertain')
    await expect(worker.bind(worker.request.expectedRevision)).rejects.toMatchObject({ status: 409 })
    await expect(worker.begin({ ...worker.request, operationId: randomUUID() })).rejects.toMatchObject({ status: 409 })
    expect((await readRepositorySessionLinks(worker.workspace)).document.bindings).toEqual({})
    expect(worker.native.creations.map((request) => request.channel)).toEqual([original])
    expect(worker.native.calls.filter((call) => call.method === 'dispatchAction')).toEqual([])
  })

  it.each([false, true])('recovers a verified provisional session only with the durable acknowledgement (legacy record=%s)', async (legacy) => {
    const worker = await fixture()
    worker.native.setLifecycle('creating')
    const read = worker.native.pauseSessionRead()
    await worker.begin()
    await expect.poll(async () => (await records(worker))[0].nativeAcknowledged).toBe(true)
    expect((await readRepositorySessionLinks(worker.workspace)).document.bindings).toEqual({})
    await worker.restart(async () => {
      if (!legacy) return
      const saved = await records(worker)
      delete saved[0].nativeAcknowledged
      await writeFile(join(worker.profile, 'agent-host-creation', 'operations.json'), JSON.stringify(saved))
    })
    read.resolve()
    if (legacy) {
      expect((await worker.status()).state).toBe('uncertain')
      expect((await readRepositorySessionLinks(worker.workspace)).document.bindings).toEqual({})
    } else {
      const session = await ready(worker)
      expect(worker.native.sessions.get(session.sessionId)!.session.lifecycle).toBe('creating')
      expect((await records(worker))[0]).toMatchObject({ nativeAcknowledged: true, nativeLifecycle: 'creating', result: { state: 'ready' } })
      expect(await locallyLinkedAgentHostSessions(worker.profile, worker.workspace, worker.owner)).toHaveLength(1)
    }
    expect(worker.native.creations).toHaveLength(1)
    expect(worker.native.calls.filter((call) => call.method === 'dispatchAction')).toEqual([])
  })

  it.each([false, true])('handles a missing provisional session without recreating or undoing a later detach (detached=%s)', async (detached) => {
    const worker = await fixture()
    worker.native.setLifecycle('creating')
    await worker.begin()
    const session = await ready(worker)
    const native = worker.native.sessions.get(session.sessionId)!
    const before = await readRepositorySessionLinks(worker.workspace)
    worker.native.sessions.clear()
    await worker.restart()
    expect(await worker.status()).toMatchObject({ state: 'uncertain', session })
    expect((await worker.status()).nativeLifecycle).toBeUndefined()
    expect((await worker.begin()).state).toBe('uncertain')
    expect(worker.native.creations).toHaveLength(1)
    expect((await readRepositorySessionLinks(worker.workspace)).document.bindings['T-0007'].sessionId).toBe(session.sessionId)
    if (detached) await removeRepositorySessionLink(worker.workspace, 'T-0007', before.revision)
    worker.native.sessions.set(session.sessionId, native)
    expect(await worker.status()).toMatchObject({ state: detached ? 'created-unbound' : 'ready', nativeLifecycle: 'creating', session })
    expect((await readRepositorySessionLinks(worker.workspace)).document.bindings).toEqual(detached ? {} : before.document.bindings)
    expect(worker.native.creations).toHaveLength(1)
  })

  it('rejects a previously acknowledged provisional session when the Host reports creation failure', async () => {
    const worker = await fixture()
    worker.native.setLifecycle('creating')
    await worker.begin()
    const session = await ready(worker)
    worker.native.setLifecycle('failed')
    expect(await worker.status()).toMatchObject({ state: 'failed', nativeLifecycle: 'failed', session })
    await expect(worker.bind((await readRepositorySessionLinks(worker.workspace)).revision)).rejects.toMatchObject({ status: 409 })
    expect(worker.native.creations).toHaveLength(1)
    expect(worker.native.calls.filter((call) => call.method === 'dispatchAction')).toEqual([])
  })

  it('records a native failed lifecycle without binding or resubmitting the operation', async () => {
    const worker = await fixture()
    worker.native.setLifecycle('failed')
    await worker.begin()
    await expect.poll(async () => (await worker.status()).state).toBe('failed')
    expect((await records(worker))[0]).toMatchObject({ nativeAcknowledged: true, nativeLifecycle: 'failed' })
    expect((await worker.begin()).state).toBe('failed')
    expect((await readRepositorySessionLinks(worker.workspace)).document.bindings).toEqual({})
    expect(worker.native.creations).toHaveLength(1)
  })

  it.each(['directory', 'provider', 'chat-resource', 'read-only', 'missing-default'] as const)('does not bind a native %s mismatch', async (mismatch) => {
    const worker = await fixture()
    worker.native.setLifecycle('creating')
    worker.native.editCreated(({ session, chat }) => {
      if (mismatch === 'directory') session.workingDirectories = [pathToFileURL(worker.root).href]
      if (mismatch === 'provider') session.provider = 'different-provider'
      if (mismatch === 'chat-resource') chat.resource = 'ahp-chat:/unrelated'
      if (mismatch === 'read-only') chat.interactivity = 'read-only' as typeof chat.interactivity
      if (mismatch === 'missing-default') delete session.defaultChat
    })
    await worker.begin()
    await expect.poll(async () => (await worker.status()).state).toBe('uncertain')
    const result = await worker.status()
    expect((await records(worker))[0].nativeAcknowledged).toBe(true)
    expect(result.session).toBeUndefined()
    expect(result.error).toBeTruthy()
    expect(JSON.stringify(result)).not.toContain(worker.root)
    expect((await readRepositorySessionLinks(worker.workspace)).document.bindings).toEqual({})
    await expect(worker.bind(worker.request.expectedRevision)).rejects.toMatchObject({ status: 409 })
    expect(worker.native.creations).toHaveLength(1)
  })

  it.each(['creating', 'ready'] as const)('rejects an acknowledged %s session carrying a creationError', async (lifecycle) => {
    const worker = await fixture()
    worker.native.setLifecycle(lifecycle)
    worker.native.editCreated(({ session }) => { Object.assign(session, { creationError: { message: 'Fixture creation error.' } }) })
    await worker.begin()
    await expect.poll(async () => (await worker.status()).state).toBe('uncertain')
    expect((await records(worker))[0].nativeAcknowledged).toBe(true)
    expect((await worker.status()).error).toContain('creation error')
    expect((await readRepositorySessionLinks(worker.workspace)).document.bindings).toEqual({})
    expect(worker.native.creations).toHaveLength(1)
  })

  it('explicitly resolves folder isolation instead of inheriting a worktree default and preserves other resolved values', async () => {
    const worker = await fixture()
    worker.native.setConfig({ schema: { type: 'object', properties: {
      isolation: { type: 'string', title: 'Isolation', enum: ['folder', 'worktree'] },
      branch: { type: 'string', title: 'Branch' },
      autoApprove: { type: 'string', title: 'Approval', enum: ['default', 'autoApprove'] },
      mode: { type: 'string', title: 'Mode', enum: ['interactive', 'autopilot'] },
    } }, values: { isolation: 'worktree', branch: 'main', autoApprove: 'default', mode: 'interactive' } }, true)
    await worker.begin()
    const session = await ready(worker)
    expect(worker.native.calls.filter((call) => call.method === 'resolveSessionConfig')).toEqual([{
      method: 'resolveSessionConfig', params: { channel: 'ahp-root://', provider: 'copilotcli',
        workingDirectory: pathToFileURL(await canonicalPolicyRoot(worker.workspace)).href, config: { isolation: 'folder' } },
    }])
    expect(worker.native.creations).toEqual([{
      channel: session.sessionId, provider: 'copilotcli', workingDirectories: [pathToFileURL(await canonicalPolicyRoot(worker.workspace)).href],
      config: { isolation: 'folder', branch: 'main', autoApprove: 'default', mode: 'interactive' },
    }])
    expect(worker.native.calls.some((call) => call.method === 'dispatchAction')).toBe(false)
  })

  it.each(['required', 'worktree', 'workspace', 'approval', 'autopilot', 'unknown-default', 'unresolved-default'] as const)('surfaces unsupported %s configuration without permission overrides or a create request', async (mode) => {
    const worker = await fixture()
    const values: Record<string, unknown> = { isolation: 'folder', autoApprove: 'default', mode: 'interactive' }
    if (mode === 'worktree' || mode === 'workspace') values.isolation = mode
    if (mode === 'approval') values.autoApprove = 'autoApprove'
    if (mode === 'autopilot') values.mode = 'autopilot'
    if (mode === 'unknown-default') values.unsupported = 'value'
    if (mode === 'unresolved-default') delete values.isolation
    worker.native.setConfig({ schema: { type: 'object', properties: {
      isolation: { type: 'string', title: 'Isolation' }, autoApprove: { type: 'string', title: 'Approval' }, mode: { type: 'string', title: 'Mode' }, unsupported: { type: 'string', title: 'Unsupported' },
    }, ...(mode === 'required' ? { required: ['unsupported'] } : {}) }, values })
    await worker.begin()
    await expect.poll(async () => (await worker.status()).state).toBe('failed')
    expect((await worker.status()).error).toMatch(/configuration|defaults/)
    expect(worker.native.creations).toEqual([])
    expect(worker.native.calls.some((call) => call.method === 'dispatchAction')).toBe(false)
  })

  it('does not expose native title paths or credentials through creation results', async () => {
    const worker = await fixture()
    worker.native.editCreated(({ session, chat }) => { session.title = worker.workspace; chat.title = worker.pair.token })
    await worker.begin()
    const session = await ready(worker)
    expect(session.title).toBe('New Copilot chat')
    expect(JSON.stringify(await worker.status())).not.toContain(worker.pair.token)
    expect(JSON.stringify(await worker.status())).not.toContain(worker.workspace)
  })

  it('preserves a conflicting B binding, leaves creation unbound, and retries only binding at a refreshed revision', async () => {
    const worker = await fixture()
    worker.native.setLifecycle('creating')
    const acknowledgement = worker.native.pauseAcknowledgement()
    await worker.begin()
    await expect.poll(() => worker.native.creations.length).toBe(1)
    const conflict = await updateRepositoryAgentHostLink(worker.workspace, 'T-0007', agentHostTargetFixture('existing-original', worker.owner), worker.bindings.snapshot.revision)
    acknowledgement.resolve()
    await expect.poll(async () => (await worker.status()).state).toBe('created-unbound')
    const session = (await worker.status()).session!
    expect((await readRepositorySessionLinks(worker.workspace)).document).toEqual(conflict.document)
    expect(await locallyLinkedAgentHostSessions(worker.profile, worker.workspace, worker.owner)).toEqual([])
    await expect(bindRepositoryAgentHostCreation(worker.workspace, 'T-0007', {
      owner: session.owner, sessionId: session.sessionId, chatId: session.chatId,
    }, conflict.revision)).rejects.toThrow('different session binding')
    expect((await worker.bind(conflict.revision)).state).toBe('created-unbound')
    const detached = await removeRepositorySessionLink(worker.workspace, 'T-0007', conflict.revision)
    expect((await worker.status()).state).toBe('created-unbound')
    expect((await readRepositorySessionLinks(worker.workspace)).document.bindings).toEqual({})
    const bound = await worker.bind(detached.revision)
    expect(bound).toMatchObject({ state: 'ready', session })
    expect(worker.native.creations).toHaveLength(1)
  })

  it('preserves the exact created chat when saving its receipt fails, then repairs it without creation', async () => {
    const worker = await fixture()
    const receipt = join(worker.profile, 'local-session-link-receipts.json')
    await mkdir(receipt)
    await worker.begin()
    await expect.poll(async () => (await worker.status()).state).toBe('created-unbound')
    const created = (await worker.status()).session!
    const linked = await readRepositorySessionLinks(worker.workspace)
    expect(linked.document.bindings['T-0007'].sessionId).toBe(created.sessionId)
    await rm(receipt, { recursive: true })
    expect(await worker.bind(linked.revision)).toMatchObject({ state: 'ready', session: created })
    expect(worker.native.creations).toHaveLength(1)
  })

  it('does not silently rebind a ready operation after a later detach, including after restart', async () => {
    const worker = await fixture()
    worker.native.setLifecycle('creating')
    await worker.begin()
    const session = await ready(worker)
    const prior = await readRepositorySessionLinks(worker.workspace)
    const detached = await removeRepositorySessionLink(worker.workspace, 'T-0007', prior.revision)
    await worker.restart()
    expect(await worker.status()).toMatchObject({ state: 'created-unbound', session })
    expect((await worker.begin()).state).toBe('created-unbound')
    expect(await readRepositorySessionLinks(worker.workspace)).toEqual(detached)
    expect(await worker.bind(detached.revision)).toMatchObject({ state: 'ready', session })
    expect(worker.native.creations).toHaveLength(1)
  })

  it.each([false, true])('recovers an interrupted binding only if its exact binding still exists (detached=%s)', async (detached) => {
    const worker = await fixture()
    worker.native.setLifecycle('creating')
    await worker.begin()
    const session = await ready(worker)
    const linked = await readRepositorySessionLinks(worker.workspace)
    if (detached) await removeRepositorySessionLink(worker.workspace, 'T-0007', linked.revision)
    await worker.restart(async () => {
      const saved = await records(worker)
      saved[0].phase = 'binding'
      saved[0].everReady = false
      saved[0].result.state = 'creating'
      await writeFile(join(worker.profile, 'agent-host-creation', 'operations.json'), JSON.stringify(saved))
      await rm(join(worker.profile, 'local-session-link-receipts.json'), { force: true })
    })
    const recovered = await worker.status()
    expect(recovered).toMatchObject({ state: detached ? 'created-unbound' : 'ready', session })
    if (detached) {
      expect((await readRepositorySessionLinks(worker.workspace)).document.bindings).toEqual({})
      expect(await locallyLinkedAgentHostSessions(worker.profile, worker.workspace, worker.owner)).toEqual([])
      expect((await worker.bind((await readRepositorySessionLinks(worker.workspace)).revision)).state).toBe('ready')
    } else expect(await locallyLinkedAgentHostSessions(worker.profile, worker.workspace, worker.owner)).toHaveLength(1)
    expect(worker.native.creations).toHaveLength(1)
  })

  it('rejects worker identity changes during asynchronous preparation and on later result lookup', async () => {
    const worker = await fixture()
    const originalOwner = worker.owner.clientId
    const gate = worker.native.pausePreparation()
    await worker.begin()
    await expect.poll(() => worker.native.calls.some((call) => call.method === 'resolveSessionConfig')).toBe(true)
    worker.owner.clientId = randomUUID()
    gate.resolve()
    await expect.poll(async () => (await records(worker))[0].result.state).toBe('failed')
    expect(worker.native.creations).toEqual([])
    await expect(worker.status()).rejects.toMatchObject({ status: 403 })
    await expect(worker.begin()).rejects.toMatchObject({ status: 403 })
    worker.owner.clientId = originalOwner
    expect((await worker.status()).state).toBe('failed')
  })

  it('will not bind a task deleted while the native session is creating', async () => {
    const worker = await fixture()
    worker.native.setLifecycle('creating')
    const acknowledgement = worker.native.pauseAcknowledgement()
    await worker.begin()
    await expect.poll(() => worker.native.creations.length).toBe(1)
    await rm(join(worker.workspace, 'tasks', 'T-0007'), { recursive: true })
    acknowledgement.resolve()
    await expect.poll(async () => (await worker.status()).state).toBe('created-unbound')
    expect((await readRepositorySessionLinks(worker.workspace)).document.bindings).toEqual({})
    await writeCreationTaskWorkspace(worker.workspace)
    expect((await worker.bind(worker.request.expectedRevision)).state).toBe('ready')
    expect(worker.native.creations).toHaveLength(1)
  })

  it('reports unsupported Hosts and absent tasks, and never substitutes another running Host', async () => {
    const worker = await fixture()
    worker.native.setProvider('unrelated-provider')
    expect((await worker.workers()).hosts[0]).toMatchObject({ hostId: worker.native.hostId, available: false, error: expect.stringContaining('copilotcli') })
    worker.native.setProvider('copilotcli')
    await writeFile(join(worker.discovery, 'host.json'), JSON.stringify({ ...worker.native.endpoint, protocolVersion: '0.8.0' }))
    expect((await worker.workers()).hosts[0]).toMatchObject({ available: false, error: expect.stringContaining('unsupported') })
    await writeFile(join(worker.discovery, 'host.json'), JSON.stringify(worker.native.endpoint))
    worker.native.setProtocol('0.8.0')
    expect((await worker.workers()).hosts[0]).toMatchObject({ available: false, error: expect.stringContaining('0.9.0') })
    worker.native.setProtocol('0.9.0')
    const missingTask = await worker.call('/device/agent-host/workers', { taskId: 'T-9999' })
    expect(missingTask).toMatchObject({ workspaces: [{ taskState: 'missing' }] })
    await expect(worker.begin({ ...worker.request, taskId: 'T-9999' })).rejects.toMatchObject({ status: 409 })
    worker.request.hostId = 'not-the-original-host'
    await worker.begin()
    await expect.poll(async () => (await worker.status()).state).toBe('failed')
    expect(worker.native.creations).toEqual([])
  })

  it('rejects arbitrary workspace paths, extra create grants, and operation result access under a different workspace', async () => {
    const worker = await fixture()
    await expect(worker.call('/device/agent-host/create', { ...worker.request, root: worker.root })).rejects.toMatchObject({ status: 400 })
    await expect(worker.call('/device/agent-host/create', { ...worker.request, canCreate: true })).rejects.toMatchObject({ status: 400 })
    await expect(worker.call('/device/agent-host/create', { ...worker.request, nativeAcknowledged: true })).rejects.toMatchObject({ status: 400 })
    await worker.begin()
    await ready(worker)
    const other = join(worker.root, 'other-workspace')
    await writeCreationTaskWorkspace(other)
    const otherBindings = await createImmutableBindingsFixture(other)
    backends.push(otherBindings)
    await worker.host.setWorkspace(worker.pair.id, await canonicalPolicyRoot(other), true)
    const workspaceId = (await worker.workers()).workspaces.find((workspace) => workspace.id !== worker.request.workspaceId)!.id
    await expect(worker.call('/device/agent-host/creation-status', { operationId: worker.request.operationId, workspaceId })).rejects.toMatchObject({ status: 403 })
    await expect(worker.call('/device/agent-host/creation-bind', { operationId: worker.request.operationId, workspaceId, expectedRevision: otherBindings.snapshot.revision })).rejects.toMatchObject({ status: 403 })
    expect(worker.native.creations).toHaveLength(1)
  })

  it('keeps unavailable authorized workspaces visible without disclosing their paths', async () => {
    const worker = await fixture()
    await rm(worker.workspace, { recursive: true })
    const catalog = await worker.workers()
    expect(catalog.workspaces).toMatchObject([{ id: worker.request.workspaceId, taskState: 'unavailable', error: expect.any(String) }])
    expect(JSON.stringify(catalog)).not.toContain(worker.workspace)
    await expect(worker.begin()).rejects.toMatchObject({ status: 403 })
    expect(worker.native.creations).toEqual([])
  })

  it('removes the same workspace policy using the original input path after canonicalization', async () => {
    const worker = await fixture()
    await worker.host.setWorkspace(worker.pair.id, worker.workspace, true)
    await worker.host.setWorkspace(worker.pair.id, worker.workspace, null)
    expect((await worker.workers()).workspaces).toEqual([])
    await expect(worker.begin()).rejects.toMatchObject({ status: 403 })
    expect(worker.native.creations).toEqual([])
  })

  it('rechecks the optional binding authorization immediately before the immutable commit', async () => {
    const worker = await fixture()
    const root = await canonicalPolicyRoot(worker.workspace)
    const sessionId = `copilotcli:/${randomUUID()}`
    const target = { owner: worker.owner, sessionId, chatId: `ahp-chat://default/${Buffer.from(sessionId).toString('base64url')}` }
    const reached = deferred(), release = deferred()
    let checks = 0
    const pending = bindRepositoryAgentHostCreation(worker.workspace, 'T-0007', target, worker.bindings.snapshot.revision, async () => {
      if (++checks === 3) { reached.resolve(); await release.promise }
      const pair = (await worker.host.list()).find((pair) => pair.id === worker.pair.id)
      if (!pair?.workspaces.some((workspace) => workspace.root === root && workspace.canSend)) throw new Error('Workspace send permission changed before commit.')
    })
    await reached.promise
    await worker.host.setWorkspace(worker.pair.id, root, false)
    release.resolve()
    await expect(pending).rejects.toThrow('permission changed before commit')
    expect(checks).toBe(3)
    expect((await readRepositorySessionLinks(worker.workspace)).document.bindings).toEqual({})
    expect(worker.native.creations).toEqual([])
  })
})
