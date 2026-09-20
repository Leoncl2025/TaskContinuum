// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHostCreationService, agentHostCreationWorkspaceId } from '../src/main/agentHostCreationService'
import { agentHostCreationResultSchema } from '../src/main/agentHostCreationProtocol'
import { AgentHostManager } from '../src/main/agentHostManager'
import { agentHostTargetSchema } from '../src/main/agentHostProtocol'
import { AgentHostRegistry } from '../src/main/agentHostRegistry'
import { canonicalPolicyRoot, locallyLinkedAgentHostSessions } from '../src/main/linkedSessionPolicy'
import { LocalTaskAgentHostWorker } from '../src/main/localTaskAgentHostWorker'
import { readRepositorySessionLinks, removeRepositorySessionLink, updateRepositoryAgentHostLink } from '../src/main/repositorySessionLinks'
import { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import { VSCodeDeviceHost } from '../src/main/vscodeDeviceHost'
import { deviceRequest } from '../src/main/vscodeDeviceHttp'
import type { AgentHostCreateRequest, AgentHostCreation, AgentHostCreationLocation } from '../src/shared/agentHostCreation'
import { creationFixtureKey, startAgentHostCreationFixture, writeCreationTaskWorkspace } from './agent-host-creation-fixture'
import { agentHostTargetFixture, createImmutableBindingsFixture } from './immutable-bindings-fixture'
import { taskSessionLinks } from '../src/shared/sessionBindings'

const cleanups: (() => Promise<void>)[] = []
const polling = { timeout: 10000, interval: 25 }
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(options: { consent?: boolean; bindings?: boolean; pairing?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-local-task-creation-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'workspace'), otherRoot = join(directory, 'other-workspace')
  const profile = join(directory, 'profile'), discovery = join(directory, 'discovery')
  await mkdir(discovery)
  await writeCreationTaskWorkspace(root)
  await writeCreationTaskWorkspace(otherRoot)
  const bindings = options.bindings === false ? undefined : await createImmutableBindingsFixture(root)
  if (bindings) cleanups.push(() => bindings.close())
  const native = await startAgentHostCreationFixture()
  let nativeClosed = false
  const closeNative = async () => { if (!nativeClosed) { nativeClosed = true; await native.close() } }
  cleanups.push(closeNative)
  await writeFile(join(discovery, 'host.json'), JSON.stringify(native.endpoint))
  const owner = { clientId: randomUUID(), machineName: 'Local-task-owner' }
  const protector = {
    available: vi.fn(() => false),
    encrypt: vi.fn((): Buffer => { throw new Error('Local task creation must not encrypt a device pairing.') }),
    decrypt: vi.fn((): string => { throw new Error('Local task creation must not decrypt a device pairing.') }),
  }
  const transport = vi.fn(async (): Promise<never> => { throw new Error('Local task creation must not open a device transport.') })
  const devices = new VSCodeDeviceClient(profile, protector, transport, async () => {})
  const remoteWorkers = vi.spyOn(devices, 'agentHostWorkers')
  const remoteWorker = vi.spyOn(devices, 'agentHostWorker')
  const remoteCreate = vi.spyOn(devices, 'agentHostCreate')
  const remoteStatus = vi.spyOn(devices, 'agentHostCreationStatus')
  const remoteBind = vi.spyOn(devices, 'agentHostBindCreation')
  const deviceList = vi.spyOn(devices, 'list')
  const hostProtector = options.pairing ? {
    available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString(),
  } : protector
  let registry: AgentHostRegistry
  let host: VSCodeDeviceHost
  let manager: AgentHostManager
  let local: LocalTaskAgentHostWorker
  const makeStack = () => {
    registry = new AgentHostRegistry(profile, [discovery], async () => owner)
    // These callbacks deliberately reference objects assigned later in stack setup.
    local = new LocalTaskAgentHostWorker(registry, () => host.taskCreationService, (folder) => manager.hasConsent(folder))
    manager = new AgentHostManager(profile, registry, devices, async () => owner, local)
    host = new VSCodeDeviceHost(profile, hostProtector)
    host.setAgentHostAccess(registry, (folder) => locallyLinkedAgentHostSessions(profile, folder, owner),
      (ownerId, workspaceId) => local.authorize(ownerId, workspaceId))
  }
  makeStack()
  cleanups.push(async () => { await host.close(); await manager.close(); devices.close() })
  // Release gates before waiting for either engine during failed-test cleanup.
  cleanups.push(closeNative)
  if (options.consent !== false) await manager!.allow(root)
  const authorize = vi.fn(async () => {})
  const request: AgentHostCreateRequest = {
    operationId: randomUUID(), workerId: owner.clientId, workspaceId: await agentHostCreationWorkspaceId(root),
    taskId: 'T-0007', hostId: native.hostId, expectedRevision: bindings?.snapshot.revision ?? null,
  }
  return {
    directory, root, otherRoot, profile, discovery, native, owner, bindings, devices, protector, transport,
    remoteWorkers, remoteWorker, remoteCreate, remoteStatus, remoteBind, deviceList, request, authorize,
    get registry() { return registry }, get host() { return host }, get manager() { return manager }, get local() { return local },
    file: join(profile, 'agent-host-creation', 'operations.json'),
    restart: async () => { await host.close(); await manager.close(); makeStack() },
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

function command(request: AgentHostCreateRequest) {
  const { operationId, taskId, workspaceId, hostId, expectedRevision } = request
  return { operationId, taskId, workspaceId, hostId, expectedRevision }
}

function lookup(request: AgentHostCreateRequest) {
  return { operationId: request.operationId, workspaceId: request.workspaceId }
}

async function status(setup: Fixture, request = setup.request) {
  return setup.manager.creations.status(setup.root, request.operationId, setup.authorize)
}

async function settle(setup: Fixture, state: AgentHostCreation['state'], request = setup.request) {
  await expect.poll(async () => (await status(setup, request)).state, polling).toBe(state)
  return status(setup, request)
}

async function create(setup: Fixture, request = setup.request) {
  expect(await setup.manager.creations.create(setup.root, request, setup.authorize)).toMatchObject({ operationId: request.operationId, state: 'creating' })
  return settle(setup, 'ready', request)
}

function target(result: AgentHostCreation) {
  return agentHostTargetSchema.parse({ owner: result.session!.owner, sessionId: result.session!.sessionId, chatId: result.session!.chatId })
}

describe('task-local Agent Host creation through the shared worker', () => {
  it('creates and assigns locally without device discovery, pairing, transport, or an initial send', async () => {
    const setup = await fixture()
    const workers = await setup.manager.creations.workers(setup.root, setup.request.taskId, 'local')
    expect(workers).toMatchObject([{ id: setup.owner.clientId, owner: setup.owner, local: true, state: 'connected',
      hosts: [{ hostId: setup.native.hostId, available: true }],
      workspaces: [{ id: setup.request.workspaceId, taskState: 'available', expectedRevision: setup.request.expectedRevision, canSend: true }] }])
    expect(workers).toHaveLength(1)
    expect(workers[0].workspaces).toHaveLength(1)
    expect(await setup.manager.creations.list(setup.root, setup.request.taskId)).toEqual([])
    expect(setup.native.creations).toEqual([])
    const result = await create(setup)
    const session = target(result)
    expect(session.owner).toEqual(setup.owner)
    expect(setup.native.creations).toEqual([{ channel: session.sessionId, provider: 'copilotcli',
      workingDirectories: [pathToFileURL(await canonicalPolicyRoot(setup.root)).href],
      config: { isolation: 'folder', autoApprove: 'default', mode: 'interactive' } }])
    expect(taskSessionLinks((await readRepositorySessionLinks(setup.root)).document.bindings, setup.request.taskId)).toEqual([{ provider: 'agent-host', ...session }])
    expect(await locallyLinkedAgentHostSessions(setup.profile, setup.root, setup.owner)).toEqual([session])
    expect(JSON.parse(await readFile(setup.file, 'utf8'))).toMatchObject([{ local: true, pairId: setup.owner.clientId, nativeSessionId: session.sessionId }])
    await expect(readFile(join(setup.profile, 'local-session-link-receipts.json'), 'utf8')).resolves.toContain(session.sessionId)
    await expect(readFile(join(setup.root, 'local-session-link-receipts.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const records = JSON.stringify(await setup.bindings!.store.getRecords())
    for (const privateValue of [setup.root, setup.request.operationId, setup.native.endpoint.connectionToken, 'nativeSessionId']) expect(records).not.toContain(privateValue)
    await expect(setup.manager.authorize(setup.root, session)).resolves.toBeUndefined()
    const connection = await setup.manager.connection(setup.root, session)
    await expect(connection.models()).resolves.toEqual([])
    expect(setup.native.calls.filter((call) => call.method === 'dispatchAction')).toEqual([])
    expect(await setup.manager.creations.list(setup.root, setup.request.taskId)).toEqual([])
    for (const spy of [setup.remoteWorkers, setup.remoteWorker, setup.remoteCreate, setup.remoteStatus, setup.remoteBind, setup.deviceList, setup.transport,
      setup.protector.available, setup.protector.encrypt, setup.protector.decrypt]) expect(spy).not.toHaveBeenCalled()
    await expect(setup.manager.creations.workers(setup.root, setup.request.taskId)).rejects.toThrow('Secure storage')
    await expect(setup.manager.creations.workers(setup.root, setup.request.taskId, 'remote')).rejects.toThrow('Secure storage')
    expect(setup.remoteWorkers).toHaveBeenCalledTimes(2)
  }, 20000)

  it('gives separate tasks distinct sessions without reusing or changing the workspace assistant', async () => {
    const setup = await fixture()
    await writeCreationTaskWorkspace(setup.root, 'T-0008')
    const helperRequest = { operationId: randomUUID(), hostId: setup.native.hostId }
    await setup.manager.localCreations.create(setup.root, helperRequest, setup.authorize)
    await expect.poll(async () => (await setup.manager.localCreations.status(setup.root, helperRequest.operationId, setup.authorize)).state, polling).toBe('ready')
    const helper = await setup.manager.localCreations.status(setup.root, helperRequest.operationId, setup.authorize)
    expect((await readRepositorySessionLinks(setup.root)).document.bindings).toEqual({})
    const first = await create(setup)
    const second = await create(setup, { ...setup.request, operationId: randomUUID(), taskId: 'T-0008',
      expectedRevision: (await readRepositorySessionLinks(setup.root)).revision })
    expect(new Set([helper.session!.sessionId, first.session!.sessionId, second.session!.sessionId]).size).toBe(3)
    expect(setup.native.creations).toHaveLength(3)
    expect(await setup.manager.localCreations.list(setup.root, setup.authorize)).toEqual([helper])
    expect(await setup.manager.localCreations.status(setup.root, helperRequest.operationId, setup.authorize)).toEqual(helper)
    const links = (await readRepositorySessionLinks(setup.root)).document.bindings
    expect(taskSessionLinks(links, 'T-0007')).toEqual([{ provider: 'agent-host', ...target(first) }])
    expect(taskSessionLinks(links, 'T-0008')).toEqual([{ provider: 'agent-host', ...target(second) }])
    expect(await setup.manager.creations.list(setup.root, setup.request.taskId)).toEqual([])
  }, 20000)

  it('creates another local session after a completed session is detached and status is reopened', async () => {
    const setup = await fixture()
    const first = await create(setup)
    const firstTarget = target(first)
    const linked = await readRepositorySessionLinks(setup.root)
    await removeRepositorySessionLink(setup.root, setup.request.taskId, linked.revision, firstTarget)
    expect(await status(setup)).toMatchObject({ state: 'ready', session: first.session })
    expect((await readRepositorySessionLinks(setup.root)).document.bindings).toEqual({})
    expect(await setup.manager.creations.list(setup.root, setup.request.taskId)).toEqual([])
    expect(await locallyLinkedAgentHostSessions(setup.profile, setup.root, setup.owner)).toEqual([])

    const secondRequest = {
      ...setup.request,
      operationId: randomUUID(),
      expectedRevision: (await readRepositorySessionLinks(setup.root)).revision,
    }
    const second = await create(setup, secondRequest)
    const secondTarget = target(second)
    expect(firstTarget.sessionId).not.toBe(secondTarget.sessionId)
    expect(taskSessionLinks((await readRepositorySessionLinks(setup.root)).document.bindings, setup.request.taskId)).toEqual([
      { provider: 'agent-host', ...secondTarget },
    ])
    expect(await locallyLinkedAgentHostSessions(setup.profile, setup.root, setup.owner)).toEqual([secondTarget])
    expect(await status(setup)).toMatchObject({ state: 'ready', session: first.session })
    expect(await status(setup, secondRequest)).toMatchObject({ state: 'ready', session: second.session })
    await expect(setup.manager.authorize(setup.root, firstTarget)).rejects.toThrow()
    await expect(setup.manager.authorize(setup.root, secondTarget)).resolves.toBeUndefined()
    expect(setup.native.creations).toHaveLength(2)
  }, 20000)

  it('recovers an unfinished caller assignment after a full stack restart without creating again', async () => {
    const setup = await fixture()
    await setup.manager.creations.create(setup.root, setup.request, setup.authorize)
    await expect.poll(async () => (await setup.host.taskCreationService.status(setup.owner.clientId, lookup(setup.request), 'local')).state, polling).toBe('ready')
    expect(await setup.manager.creations.list(setup.root, setup.request.taskId)).toHaveLength(1)
    await setup.restart()
    const recovered = await settle(setup, 'ready')
    expect(await setup.manager.creations.create(setup.root, setup.request, setup.authorize)).toEqual(recovered)
    expect(await setup.manager.creations.bind(setup.root, setup.request.operationId, setup.authorize)).toEqual(recovered)
    await expect(setup.manager.authorize(setup.root, target(recovered))).resolves.toBeUndefined()
    expect(setup.native.creations).toHaveLength(1)
  }, 20000)

  it('appends beside an existing binding and retries only assignment after a stale revision', async () => {
    const setup = await fixture()
    const gate = setup.native.pauseAcknowledgement()
    await setup.manager.creations.create(setup.root, setup.request, setup.authorize)
    await expect.poll(() => setup.native.creations.length, polling).toBe(1)
    const conflict = agentHostTargetFixture('conflicting-session', setup.owner)
    const changed = await updateRepositoryAgentHostLink(setup.root, setup.request.taskId, conflict, setup.request.expectedRevision)
    gate.resolve()
    const unbound = await settle(setup, 'created-unbound')
    expect(taskSessionLinks((await readRepositorySessionLinks(setup.root)).document.bindings, setup.request.taskId)).toEqual([{ provider: 'agent-host', ...conflict }])
    await setup.restart()
    expect(await status(setup)).toMatchObject({ state: 'created-unbound', session: unbound.session })
    await removeRepositorySessionLink(setup.root, setup.request.taskId, changed.revision, conflict)
    expect(await status(setup)).toMatchObject({ state: 'created-unbound' })
    expect((await readRepositorySessionLinks(setup.root)).document.bindings).toEqual({})
    const bound = await setup.manager.creations.bind(setup.root, setup.request.operationId, setup.authorize)
    expect(bound).toMatchObject({ state: 'ready', session: unbound.session })
    await expect(setup.manager.authorize(setup.root, target(bound))).resolves.toBeUndefined()
    expect(setup.native.creations).toHaveLength(1)
  }, 20000)

  it('blocks creation without consent or an initialized immutable binding backend', async () => {
    const denied = await fixture({ consent: false })
    expect(await denied.manager.creations.workers(denied.root, denied.request.taskId, 'local')).toMatchObject([{ local: true, state: 'blocked', hosts: [] }])
    await expect(denied.manager.creations.create(denied.root, denied.request, denied.authorize)).rejects.toThrow('Enable local Agent Host access')
    await expect(denied.local.create(denied.root, denied.request, denied.authorize)).rejects.toMatchObject({ status: 403 })
    expect(denied.native.creations).toEqual([])
    const missingBackend = await fixture({ bindings: false })
    await expect(missingBackend.manager.creations.create(missingBackend.root, missingBackend.request, missingBackend.authorize)).rejects.toThrow()
    expect(missingBackend.native.creations).toEqual([])
    expect(await missingBackend.manager.creations.list(missingBackend.root, missingBackend.request.taskId)).toEqual([])
  }, 20000)

  it('rejects a missing task but permits creation on an already-bound task', async () => {
    const setup = await fixture()
    const missing = { ...setup.request, taskId: 'T-0999' }
    await expect(setup.manager.creations.create(setup.root, missing, setup.authorize)).rejects.toThrow('no longer exists')
    await expect(setup.local.create(setup.root, missing, setup.authorize)).rejects.toMatchObject({ status: 409 })
    const existing = agentHostTargetFixture('already-bound', setup.owner)
    const changed = await updateRepositoryAgentHostLink(setup.root, setup.request.taskId, existing, setup.request.expectedRevision)
    const bound = { ...setup.request, operationId: randomUUID(), expectedRevision: changed.revision }
    const created = await create(setup, bound)
    expect(setup.native.creations).toHaveLength(1)
    expect(taskSessionLinks((await readRepositorySessionLinks(setup.root)).document.bindings, setup.request.taskId)).toEqual([
      { provider: 'agent-host', ...existing }, { provider: 'agent-host', ...target(created) },
    ])
  }, 20000)

  it('does not substitute an available Host for an unavailable exact selected Host', async () => {
    const setup = await fixture()
    const unavailable = { ...setup.request, hostId: randomUUID() }
    await expect(setup.manager.creations.create(setup.root, unavailable, setup.authorize)).rejects.toThrow('exact selected Host')
    expect(await setup.manager.creations.list(setup.root, setup.request.taskId)).toEqual([])
    await setup.local.create(setup.root, unavailable, setup.authorize)
    await expect.poll(async () => (await setup.local.status(setup.root, unavailable, setup.authorize)).state, polling).toBe('failed')
    expect(setup.native.creations).toEqual([])
  }, 20000)

  it('rejects root, workspace and owner mismatches for local creation and recovery', async () => {
    const setup = await fixture()
    await setup.manager.allow(setup.otherRoot)
    for (const [root, request] of [
      [setup.otherRoot, setup.request],
      [setup.root, { ...setup.request, workspaceId: 'f'.repeat(64) }],
      [setup.root, { ...setup.request, workerId: randomUUID() }],
    ] as const) {
      await expect(setup.local.create(root, request, setup.authorize)).rejects.toMatchObject({ status: 403 })
      await expect(setup.local.status(root, request, setup.authorize)).rejects.toMatchObject({ status: 403 })
      await expect(setup.local.bind(root, request, request.expectedRevision, setup.authorize)).rejects.toMatchObject({ status: 403 })
    }
    expect(setup.native.creations).toEqual([])
    const result = await create(setup)
    await expect(setup.manager.creations.status(setup.otherRoot, setup.request.operationId, setup.authorize)).rejects.toThrow('does not belong')
    await expect(setup.manager.authorize(setup.root, { ...target(result), owner: { ...setup.owner, clientId: randomUUID() } })).rejects.toThrow()
    const originalOwner = setup.owner.clientId
    setup.owner.clientId = randomUUID()
    await expect(setup.host.taskCreationService.status(setup.owner.clientId, lookup(setup.request), 'local')).rejects.toMatchObject({ status: 403 })
    await expect(setup.local.authorize(originalOwner, setup.request.workspaceId)).rejects.toMatchObject({ status: 403 })
    expect(setup.native.creations).toHaveLength(1)
  }, 20000)

  it('keeps a lost native ACK uncertain across restart and cannot bypass the caller reservation by choosing remote', async () => {
    const setup = await fixture()
    setup.native.loseAcknowledgement(true)
    await setup.manager.creations.create(setup.root, setup.request, setup.authorize)
    await settle(setup, 'uncertain')
    expect(setup.native.creations).toHaveLength(1)
    await setup.restart()
    expect(await status(setup)).toMatchObject({ state: 'uncertain' })
    expect(await setup.manager.creations.create(setup.root, setup.request, setup.authorize)).toMatchObject({ state: 'uncertain' })
    for (const workerId of [setup.owner.clientId, randomUUID()]) {
      await expect(setup.manager.creations.create(setup.root, { ...setup.request, workerId, operationId: randomUUID() }, setup.authorize)).rejects.toThrow('unresolved creation')
    }
    expect(setup.remoteWorker).not.toHaveBeenCalled()
    expect(setup.remoteCreate).not.toHaveBeenCalled()
    expect(await setup.manager.creations.list(setup.root, setup.request.taskId)).toMatchObject([{ operationId: setup.request.operationId, state: 'uncertain' }])
    expect((await readRepositorySessionLinks(setup.root)).document.bindings).toEqual({})
    expect(setup.native.creations).toHaveLength(1)
  }, 20000)

  it('isolates recorded local and remote operations even when both authorizers accept the same principal UUID', async () => {
    const setup = await fixture()
    await create(setup)
    const saved = JSON.parse(await readFile(setup.file, 'utf8')) as Record<string, unknown>[]
    const canonicalRoot = await canonicalPolicyRoot(setup.root)
    for (const origin of ['local', 'remote'] as const) {
      const copy = join(setup.directory, `copied-${origin}`)
      const file = join(copy, 'agent-host-creation', 'operations.json')
      await mkdir(join(copy, 'agent-host-creation'), { recursive: true })
      const record = { ...saved[0] }
      if (origin === 'remote') delete record.local
      await writeFile(file, JSON.stringify([record]))
      const remoteAuthorize = vi.fn(async () => canonicalRoot), localAuthorize = vi.fn(async () => canonicalRoot)
      const engine = new AgentHostCreationService(copy, setup.registry, remoteAuthorize, localAuthorize)
      try {
        const wrongOrigin = origin === 'local' ? undefined : 'local'
        const before = await readFile(file, 'utf8')
        await expect(engine.begin(setup.owner.clientId, command(setup.request), wrongOrigin)).rejects.toMatchObject({ status: 403 })
        await expect(engine.status(setup.owner.clientId, { operationId: setup.request.operationId, workspaceId: setup.request.workspaceId }, wrongOrigin)).rejects.toMatchObject({ status: 403 })
        await expect(engine.bind(setup.owner.clientId, { operationId: setup.request.operationId, workspaceId: setup.request.workspaceId,
          expectedRevision: (await readRepositorySessionLinks(setup.root)).revision }, wrongOrigin)).rejects.toMatchObject({ status: 403 })
        expect(await readFile(file, 'utf8')).toBe(before)
        expect(await engine.begin(setup.owner.clientId, command(setup.request), origin)).toMatchObject({ state: 'ready' })
        expect(remoteAuthorize).toHaveBeenCalled()
        expect(localAuthorize).toHaveBeenCalled()
      } finally { await engine.close() }
    }
    expect(setup.native.creations).toHaveLength(1)
  }, 20000)

  it.each(['local', 'remote'] as const)('shares the worker reservation when %s creation starts first', async (first: AgentHostCreationLocation) => {
    const setup = await fixture({ pairing: true })
    const pair = await setup.host.pair({ clientId: randomUUID(), username: 'Remote fixture caller', machineName: 'Other-device' }, creationFixtureKey().publicKey)
    await setup.host.setWorkspace(pair.id, await canonicalPolicyRoot(setup.root), true)
    const port = await setup.host.start()
    const remoteRequest = { ...command(setup.request), operationId: randomUUID() }
    const remoteBegin = () => deviceRequest(port, port, pair.token, '/device/agent-host/create', remoteRequest, AbortSignal.timeout(10000))
    const gate = setup.native.pauseAcknowledgement()
    if (first === 'local') await setup.manager.creations.create(setup.root, setup.request, setup.authorize)
    else expect(agentHostCreationResultSchema.parse(await remoteBegin())).toMatchObject({ state: 'creating' })
    await expect.poll(() => setup.native.creations.length, polling).toBe(1)
    if (first === 'local') await expect(remoteBegin()).rejects.toMatchObject({ status: 409 })
    else expect(await setup.manager.creations.create(setup.root, setup.request, setup.authorize)).toMatchObject({ state: 'uncertain', error: expect.stringContaining('unresolved creation') })
    expect(JSON.parse(await readFile(setup.file, 'utf8'))).toMatchObject([{ pairId: first === 'local' ? setup.owner.clientId : pair.id }])
    expect(JSON.parse(await readFile(setup.file, 'utf8'))).toHaveLength(1)
    gate.resolve()
    if (first === 'local') await settle(setup, 'ready')
    else {
      await expect.poll(async () => agentHostCreationResultSchema.parse(await deviceRequest(port, port, pair.token, '/device/agent-host/creation-status',
        { operationId: remoteRequest.operationId, workspaceId: remoteRequest.workspaceId }, AbortSignal.timeout(10000))).state, polling).toBe('ready')
    }
    expect(setup.native.creations).toHaveLength(1)
    expect(Object.keys((await readRepositorySessionLinks(setup.root)).document.bindings)).toEqual([setup.request.taskId])
  }, 20000)
})
