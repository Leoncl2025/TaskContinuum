// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHostCreationClient } from '../src/main/agentHostCreationClient'
import { readRepositorySessionLinks, updateRepositorySessionLink } from '../src/main/repositorySessionLinks'
import { canonicalPolicyRoot } from '../src/main/linkedSessionPolicy'
import { writeJsonAtomic } from '../src/main/shared/storage'
import type { AgentHostCreateRequest, AgentHostCreation, AgentHostWorker } from '../src/shared/agentHostCreation'
import type { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'

const directories: string[] = []
const clients: AgentHostCreationClient[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'continuum-create-client-'))
  directories.push(root)
  const taskDirectory = join(root, 'tasks', 'T-0007-creation')
  await mkdir(taskDirectory, { recursive: true })
  await mkdir(join(root, '.agentdesk'))
  await writeFile(join(root, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Creation client fixture' }))
  const taskFile = join(taskDirectory, 'task.json')
  await writeFile(taskFile, JSON.stringify({ schemaVersion: '1.0', id: 'T-0007', title: 'Create session', type: 'feature', status: 'backlog', priority: 'P2', relations: { level: 'task', parent: null } }))
  const request: AgentHostCreateRequest = { operationId: randomUUID(), taskId: 'T-0007', workerId: randomUUID(), workspaceId: 'b'.repeat(64), hostId: 'creation-host-123', expectedRevision: null }
  const owner = { clientId: randomUUID(), machineName: 'Worker-B' }
  const worker: AgentHostWorker = { id: request.workerId, owner, state: 'connected',
    hosts: [{ hostId: request.hostId, name: 'Copilot', available: true }],
    workspaces: [{ id: request.workspaceId, name: 'Worker workspace', canSend: true, taskState: 'available', expectedRevision: null }] }
  const sessionId = `copilotcli:/${randomUUID()}`
  const result: AgentHostCreation = { operationId: request.operationId, taskId: request.taskId, workerId: request.workerId, workspaceId: request.workspaceId, hostId: request.hostId, state: 'ready',
    session: { hostId: request.hostId, sessionId, chatId: `ahp-chat://default/${Buffer.from(sessionId).toString('base64url')}`, owner, provider: 'copilotcli', title: 'Created on B', updatedAt: new Date().toISOString(), canSend: true } }
  const devices = {
    agentHostWorkers: vi.fn(async () => [worker]), agentHostWorker: vi.fn(async () => worker),
    agentHostCreate: vi.fn(async (_root, _request, authorize) => { await authorize(); return result }),
    agentHostCreationStatus: vi.fn(async () => result),
    agentHostBindCreation: vi.fn(async (_root, _request, _revision, authorize) => { await authorize(); return result }),
  } satisfies Pick<VSCodeDeviceClient, 'agentHostWorkers' | 'agentHostWorker' | 'agentHostCreate' | 'agentHostCreationStatus' | 'agentHostBindCreation'>
  const profile = join(root, 'profile')
  const client = new AgentHostCreationClient(profile, devices)
  clients.push(client)
  return { root, profile, taskFile, request, result, worker, devices, client, authorize: vi.fn(async () => {}) }
}

describe('durable remote creation on the caller', () => {
  it('persists only the acknowledged identity and never creates while listing', async () => {
    const setup = await fixture()
    const originalTask = await readFile(setup.taskFile, 'utf8')
    expect(await setup.client.workers(setup.root, setup.request.taskId)).toEqual([setup.worker])
    expect(await setup.client.list(setup.root, setup.request.taskId)).toEqual([])
    expect(setup.devices.agentHostCreate).not.toHaveBeenCalled()
    const created = await setup.client.create(setup.root, setup.request, setup.authorize)
    expect(created.error).toBeUndefined()
    expect(created.state).toBe('ready')
    expect((await readRepositorySessionLinks(setup.root)).document.bindings['T-0007']).toEqual({ provider: 'agent-host', hostId: setup.result.session!.hostId, sessionId: setup.result.session!.sessionId, chatId: setup.result.session!.chatId, owner: setup.result.session!.owner })
    expect(await readFile(setup.taskFile, 'utf8')).toBe(originalTask)
    expect(setup.devices.agentHostCreate).toHaveBeenCalledOnce()
    expect(await setup.client.list(setup.root, setup.request.taskId)).toEqual([])
  })

  it.each(['read-only', 'offline', 'unsupported', 'bound', 'revision'])('does not dispatch when selection is %s', async (reason) => {
    const setup = await fixture()
    if (reason === 'read-only') setup.worker.workspaces[0].canSend = false
    if (reason === 'offline') setup.worker.state = 'offline'
    if (reason === 'unsupported') setup.worker.hosts[0].available = false
    if (reason === 'bound') setup.worker.workspaces[0].taskState = 'bound'
    if (reason === 'revision') setup.worker.workspaces[0].expectedRevision = 'c'.repeat(64)
    await expect(setup.client.create(setup.root, setup.request, setup.authorize)).rejects.toThrow()
    expect(setup.devices.agentHostCreate).not.toHaveBeenCalled()
    expect((await readRepositorySessionLinks(setup.root)).revision).toBeNull()
  })

  it('retains acknowledged native lazy initialization separately from a completed binding', async () => {
    const setup = await fixture()
    setup.result.nativeLifecycle = 'creating'
    const created = await setup.client.create(setup.root, setup.request, setup.authorize)
    expect(created).toMatchObject({ state: 'ready', nativeLifecycle: 'creating', session: setup.result.session })
    await setup.client.close()
    const restarted = new AgentHostCreationClient(setup.profile, setup.devices)
    clients.push(restarted)
    expect(await restarted.status(setup.root, setup.request.operationId, setup.authorize)).toMatchObject({ state: 'ready', nativeLifecycle: 'creating' })
    expect(setup.devices.agentHostCreate).toHaveBeenCalledOnce()
  })

  it('records uncertain delivery before dispatch and recovers the same operation after restart', async () => {
    const setup = await fixture()
    setup.devices.agentHostCreate.mockImplementationOnce(async (_root, _request, authorize) => {
      await authorize()
      expect((await setup.client.list(setup.root, setup.request.taskId))[0].operationId).toBe(setup.request.operationId)
      throw new Error('Connection lost after dispatch')
    })
    expect((await setup.client.create(setup.root, setup.request, setup.authorize)).state).toBe('uncertain')
    expect((await readRepositorySessionLinks(setup.root)).revision).toBeNull()
    await setup.client.close()
    const restarted = new AgentHostCreationClient(setup.profile, setup.devices)
    clients.push(restarted)
    await expect(restarted.create(setup.root, { ...setup.request, operationId: randomUUID() }, setup.authorize)).rejects.toThrow('unresolved')
    expect((await restarted.status(setup.root, setup.request.operationId, setup.authorize)).state).toBe('ready')
    expect(setup.devices.agentHostCreate).toHaveBeenCalledOnce()
    expect(setup.devices.agentHostCreationStatus).toHaveBeenCalledOnce()
  })

  it('recovers a crash after worker readiness was saved but before the caller assignment', async () => {
    const setup = await fixture()
    const canonical = await canonicalPolicyRoot(setup.root)
    const scope = createHash('sha256').update(canonical).digest('hex')
    await writeJsonAtomic(join(setup.profile, 'agent-host-creations', 'client', scope, `${setup.request.operationId}.json`), {
      schemaVersion: 1, root: canonical, createdAt: new Date().toISOString(),
      request: setup.request, owner: setup.worker.owner, expectedRevision: null,
      result: setup.result, localBound: false, bindingBlocked: false,
    })
    const history = await setup.client.list(setup.root, setup.request.taskId)
    expect(history).toMatchObject([{ state: 'created-unbound', session: setup.result.session }])
    expect(history[0].error).toContain('caller assignment')
    expect((await readRepositorySessionLinks(setup.root)).revision).toBeNull()
    const recovered = await setup.client.status(setup.root, setup.request.operationId, setup.authorize)
    expect(recovered.state).toBe('ready')
    expect((await readRepositorySessionLinks(setup.root)).document.bindings['T-0007'].sessionId).toBe(setup.result.session!.sessionId)
    expect(setup.devices.agentHostCreationStatus).toHaveBeenCalledOnce()
    expect(setup.devices.agentHostCreate).not.toHaveBeenCalled()
  })

  it('deduplicates repeated requests and rejects changed parameters for an operation ID', async () => {
    const setup = await fixture()
    const result = await Promise.all([setup.client.create(setup.root, setup.request, setup.authorize), setup.client.create(setup.root, setup.request, setup.authorize)])
    expect(result.every((item) => item.state === 'ready')).toBe(true)
    expect(setup.devices.agentHostCreate).toHaveBeenCalledOnce()
    await expect(setup.client.create(setup.root, { ...setup.request, hostId: 'different-host-123' }, setup.authorize)).rejects.toThrow('different creation parameters')
  })

  it('rejects another unresolved operation even from another client instance', async () => {
    const setup = await fixture()
    setup.devices.agentHostCreate.mockImplementationOnce(async (_root, _request, authorize) => { await authorize(); return { ...setup.result, state: 'creating', session: undefined } })
    expect((await setup.client.create(setup.root, setup.request, setup.authorize)).state).toBe('creating')
    const second = new AgentHostCreationClient(setup.profile, setup.devices)
    clients.push(second)
    await expect(second.create(setup.root, { ...setup.request, operationId: randomUUID() }, setup.authorize)).rejects.toThrow('unresolved')
    expect(setup.devices.agentHostCreate).toHaveBeenCalledOnce()
  })

  it('preserves binding conflicts and retries binding explicitly without another create', async () => {
    const setup = await fixture()
    setup.devices.agentHostCreate.mockImplementationOnce(async (_root, _request, authorize) => {
      await authorize()
      await updateRepositorySessionLink(setup.root, 'T-0099', 'unrelated-session', null)
      return setup.result
    })
    expect((await setup.client.create(setup.root, setup.request, setup.authorize)).state).toBe('created-unbound')
    expect((await setup.client.status(setup.root, setup.request.operationId, setup.authorize)).state).toBe('created-unbound')
    expect((await readRepositorySessionLinks(setup.root)).document.bindings['T-0007']).toBeUndefined()
    expect((await setup.client.bind(setup.root, setup.request.operationId, setup.authorize)).state).toBe('ready')
    const links = await readRepositorySessionLinks(setup.root)
    expect(links.document.bindings['T-0099'].sessionId).toBe('unrelated-session')
    expect(links.document.bindings['T-0007'].sessionId).toBe(setup.result.session!.sessionId)
    expect(setup.devices.agentHostCreate).toHaveBeenCalledOnce()
    expect(setup.devices.agentHostBindCreation).toHaveBeenCalledOnce()
  })

  it('does not overwrite another task binding or rebind an intentionally detached completed operation', async () => {
    const setup = await fixture()
    await setup.client.create(setup.root, setup.request, setup.authorize)
    const bound = await readRepositorySessionLinks(setup.root)
    await updateRepositorySessionLink(setup.root, 'T-0007', null, bound.revision)
    await setup.client.status(setup.root, setup.request.operationId, setup.authorize)
    expect((await readRepositorySessionLinks(setup.root)).document.bindings['T-0007']).toBeUndefined()
    expect(setup.devices.agentHostCreate).toHaveBeenCalledOnce()
  })

  it.each(['operation', 'owner', 'host'])('does not persist a mismatched %s identity', async (changed) => {
    const setup = await fixture()
    const wrong = structuredClone(setup.result)
    if (changed === 'operation') wrong.operationId = randomUUID()
    if (changed === 'owner') wrong.session!.owner.clientId = randomUUID()
    if (changed === 'host') wrong.session!.hostId = 'different-host-123'
    setup.devices.agentHostCreate.mockImplementationOnce(async (_root, _request, authorize) => { await authorize(); return wrong })
    const result = await setup.client.create(setup.root, setup.request, setup.authorize)
    expect(result.state).toBe('uncertain')
    expect((await readRepositorySessionLinks(setup.root)).revision).toBeNull()
    expect((await setup.client.list(setup.root, setup.request.taskId))[0].session).toBeUndefined()
  })

  it('checks the captured workspace again after preparation, without dispatch or a wrong binding', async () => {
    const setup = await fixture()
    let moved = false
    setup.devices.agentHostWorker.mockImplementationOnce(async () => { moved = true; return setup.worker })
    await expect(setup.client.create(setup.root, setup.request, async () => { if (moved) throw new Error('Workspace changed') })).rejects.toThrow('Workspace changed')
    expect(setup.devices.agentHostCreate).not.toHaveBeenCalled()
    expect((await readRepositorySessionLinks(setup.root)).revision).toBeNull()
  })
})
