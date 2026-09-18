// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AhpErrorCodes } from '@microsoft/agent-host-protocol'
import { RpcError } from '@microsoft/agent-host-protocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHostManager } from '../src/main/agentHostManager'
import { AgentHostRegistry } from '../src/main/agentHostRegistry'
import { agentHostTargetSchema } from '../src/main/agentHostProtocol'
import { LocalAgentHostCreationService } from '../src/main/localAgentHostCreationService'
import { canonicalPolicyRoot, locallyLinkedAgentHostSessions } from '../src/main/linkedSessionPolicy'
import { registerRepositorySessionLinksBackend } from '../src/main/repositorySessionLinks'
import type { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import type { LocalAgentHostCreation } from '../src/shared/localAgentHostCreation'
import { startAgentHostCreationFixture } from './agent-host-creation-fixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const directory = join(process.cwd(), 'artifacts', 'local-agent-host-creation', randomUUID())
  const root = join(directory, 'empty-workspace'), otherRoot = join(directory, 'other-workspace')
  const profile = join(directory, 'profile'), discovery = join(directory, 'discovery')
  await Promise.all([root, otherRoot, discovery].map((folder) => mkdir(folder, { recursive: true })))
  const native = await startAgentHostCreationFixture()
  await writeFile(join(discovery, 'host.json'), JSON.stringify(native.endpoint))
  const owner = { clientId: randomUUID(), machineName: 'Local-workstation' }
  const registry = new AgentHostRegistry(profile, [discovery], async () => owner)
  const devices = {
    agentHostSessions: vi.fn(async () => { throw new Error('Local creation must not use a remote catalog.') }),
    agentHostTransport: vi.fn(async () => { throw new Error('Local creation must not use a remote transport.') }),
  }
  const manager = new AgentHostManager(profile, registry, devices as unknown as VSCodeDeviceClient, async () => owner)
  const services = [manager.localCreations]
  const authorize = vi.fn(async () => {})
  const request: { operationId: string; hostId: string } = { operationId: randomUUID(), hostId: native.hostId }
  const file = join(profile, 'local-agent-host-creations', 'operations.json')
  const restart = async () => {
    await services.at(-1)!.close()
    const next = new LocalAgentHostCreationService(profile, registry)
    services.push(next)
    return next
  }
  cleanups.push(async () => {
    await native.close()
    await Promise.all(services.map((service) => service.close()))
    await manager.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, root, otherRoot, profile, discovery, native, owner, registry, manager, devices, service: manager.localCreations, request, file, authorize, restart }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

async function settled(setup: Fixture, service = setup.service): Promise<LocalAgentHostCreation> {
  await expect.poll(async () => (await service.list(setup.root, setup.authorize))[0]?.state, { timeout: 10000, interval: 25 }).not.toBe('creating')
  return (await service.list(setup.root, setup.authorize))[0]
}
async function ready(setup: Fixture) {
  expect(await setup.service.create(setup.root, setup.request, setup.authorize)).toMatchObject({ ...setup.request, state: 'creating' })
  const result = await settled(setup)
  expect(result.state).toBe('ready')
  return agentHostTargetSchema.parse({ sessionId: result.session!.sessionId, chatId: result.session!.chatId, owner: result.session!.owner })
}

describe('private workspace-local native planning sessions', () => {
  it('creates in an empty root, authorizes the exact local chat, and sends only the explicitly selected model', async () => {
    const setup = await fixture()
    setup.native.setModels([{ id: 'selected-model', name: 'Selected model', provider: 'copilotcli' }])
    expect(await setup.service.hosts(setup.root, setup.authorize)).toMatchObject([{ hostId: setup.native.hostId, available: true }])
    expect(await setup.service.list(setup.root, setup.authorize)).toEqual([])
    expect(setup.native.creations).toEqual([])
    const target = await ready(setup)
    expect(await readdir(setup.root)).toEqual([])
    expect(await setup.manager.hasConsent(setup.root)).toBe(false)
    await expect(setup.manager.authorize(setup.root, target)).resolves.toBeUndefined()
    await expect(readFile(join(setup.profile, 'local-session-link-receipts.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(setup.native.creations).toEqual([{ channel: target.sessionId, provider: 'copilotcli',
      workingDirectories: [pathToFileURL(await canonicalPolicyRoot(setup.root)).href],
      config: { isolation: 'folder', autoApprove: 'default', mode: 'interactive' } }])
    expect(setup.native.calls.filter((call) => call.method === 'dispatchAction')).toEqual([])
    const serialized = JSON.stringify(await setup.service.list(setup.root, setup.authorize))
    for (const privateValue of [setup.root, setup.discovery, setup.native.endpoint.connectionToken, 'nativeAcknowledged', 'nativeSessionId']) expect(serialized).not.toContain(privateValue)
    const connection = await setup.manager.connection(setup.root, target)
    expect(await connection.models()).toMatchObject([{ id: 'selected-model' }])
    await connection.send(randomUUID(), 'Plan tasks in this empty repository', undefined, () => setup.manager.authorize(setup.root, target), undefined, { id: 'selected-model' })
    expect(setup.native.calls.filter((call) => call.method === 'dispatchAction')).toMatchObject([{ params: { channel: target.chatId,
      action: { type: 'chat/turnStarted', message: { text: 'Plan tasks in this empty repository', model: { id: 'selected-model' } } } } }])
    expect(setup.devices.agentHostSessions).not.toHaveBeenCalled()
    expect(setup.devices.agentHostTransport).not.toHaveBeenCalled()
    const unregister = await registerRepositorySessionLinksBackend(setup.root, {
      read: async () => ({ document: { schemaVersion: 2, bindings: { 'T-0001': { provider: 'agent-host', ...target } } }, revision: 'a'.repeat(64) }),
      update: async () => { throw new Error('Local planning must not write shared bindings.') },
    })
    try { expect(await locallyLinkedAgentHostSessions(setup.profile, setup.root, setup.owner)).toEqual([]) }
    finally { unregister() }
  })

  it('persists the reservation and native identity before dispatch and accepts acknowledged lazy creation', async () => {
    const setup = await fixture()
    setup.native.setLifecycle('creating')
    const wait = setup.native.pausePreparation()
    await setup.service.create(setup.root, setup.request, setup.authorize)
    await expect.poll(() => setup.native.calls.some((call) => call.method === 'resolveSessionConfig')).toBe(true)
    const [record] = JSON.parse(await readFile(setup.file, 'utf8'))
    expect(record).toMatchObject({ request: setup.request, nativeSessionId: expect.stringMatching(/^copilotcli:\//), phase: 'reserved', nativeAcknowledged: false })
    expect(setup.native.creations).toEqual([])
    wait.resolve()
    const created = await settled(setup)
    expect(created).toMatchObject({ state: 'ready', nativeLifecycle: 'creating', session: { sessionId: record.nativeSessionId } })
    expect(JSON.parse(await readFile(setup.file, 'utf8'))[0]).toMatchObject({ phase: 'dispatched', nativeAcknowledged: true })
    const restarted = await setup.restart()
    expect(await restarted.list(setup.root, setup.authorize)).toEqual([created])
    expect(await restarted.status(setup.root, setup.request.operationId, setup.authorize)).toEqual(created)
    expect(await restarted.create(setup.root, setup.request, setup.authorize)).toEqual(created)
    expect(setup.native.creations).toHaveLength(1)
    expect(setup.native.calls.filter((call) => call.method === 'dispatchAction')).toEqual([])
  })

  it.each(['ready', 'creating', 'missing'] as const)('recovers lost ACK with %s native state only by inspecting the reserved identity', async (state) => {
    const setup = await fixture()
    setup.native.setLifecycle(state === 'creating' ? 'creating' : 'ready')
    setup.native.loseAcknowledgement(state === 'missing')
    await setup.service.create(setup.root, setup.request, setup.authorize)
    expect((await settled(setup)).state).toBe('uncertain')
    expect(JSON.parse(await readFile(setup.file, 'utf8'))[0].nativeAcknowledged).toBe(false)
    const restarted = await setup.restart()
    expect((await restarted.list(setup.root, setup.authorize))[0].state).toBe('uncertain')
    expect((await restarted.create(setup.root, setup.request, setup.authorize)).state).toBe('uncertain')
    await expect(restarted.create(setup.root, { ...setup.request, operationId: randomUUID() }, setup.authorize)).rejects.toThrow('already has')
    const result = await restarted.status(setup.root, setup.request.operationId, setup.authorize)
    expect(result.state).toBe(state === 'ready' ? 'ready' : 'uncertain')
    expect(setup.native.creations).toHaveLength(1)
    if (state === 'creating') {
      expect(result.nativeLifecycle).toBe('creating')
      setup.native.setLifecycle('ready')
      expect((await restarted.status(setup.root, setup.request.operationId, setup.authorize)).state).toBe('ready')
    }
  })

  it('never replays an interrupted reservation even when no native request was sent', async () => {
    const setup = await fixture()
    const wait = setup.native.pausePreparation()
    await setup.service.create(setup.root, setup.request, setup.authorize)
    await expect.poll(() => setup.native.calls.some((call) => call.method === 'resolveSessionConfig')).toBe(true)
    const saved = await readFile(setup.file, 'utf8')
    await setup.service.close()
    wait.resolve()
    await writeFile(setup.file, saved)
    const restarted = await setup.restart()
    expect((await restarted.list(setup.root, setup.authorize))[0].state).toBe('uncertain')
    expect((await restarted.create(setup.root, setup.request, setup.authorize)).state).toBe('uncertain')
    expect((await restarted.status(setup.root, setup.request.operationId, setup.authorize)).state).toBe('uncertain')
    expect(setup.native.creations).toEqual([])
  })

  it('serializes duplicate requests, rejects altered IDs and blocks a second non-failed session per canonical root', async () => {
    const setup = await fixture()
    await Promise.all([setup.service.create(setup.root, setup.request, setup.authorize), setup.service.create(join(setup.root, '.'), setup.request, setup.authorize)])
    expect((await settled(setup)).state).toBe('ready')
    await expect(setup.service.create(setup.root, { ...setup.request, hostId: 'other-host-123' }, setup.authorize)).rejects.toThrow('different')
    await expect(setup.service.create(setup.otherRoot, setup.request, setup.authorize)).rejects.toThrow('different')
    await expect(setup.service.create(setup.root, { ...setup.request, operationId: randomUUID() }, setup.authorize)).rejects.toThrow('already has')
    const secondProcess = new LocalAgentHostCreationService(setup.profile, setup.registry)
    try { await expect(secondProcess.create(setup.root, { ...setup.request, operationId: randomUUID() }, setup.authorize)).rejects.toThrow('already has') }
    finally { await secondProcess.close() }
    expect(setup.native.creations).toHaveLength(1)
  })

  it('does not authorize arbitrary chats, different roots or another execution owner', async () => {
    const setup = await fixture()
    const target = await ready(setup)
    for (const value of [{ ...target, chatId: 'ahp-chat:/other' }, { ...target, sessionId: `copilotcli:/${randomUUID()}` },
      { ...target, hostId: 'unknown-host-123' }, { ...target, owner: { ...target.owner, machineName: 'Other-name' } }]) {
      await expect(setup.manager.authorize(setup.root, value)).rejects.toThrow()
    }
    await expect(setup.manager.authorize(setup.otherRoot, target)).rejects.toThrow()
    await expect(setup.service.status(setup.otherRoot, setup.request.operationId, setup.authorize)).rejects.toThrow('does not belong')
    setup.owner.clientId = randomUUID()
    await expect(setup.service.status(setup.root, setup.request.operationId, setup.authorize)).rejects.toThrow('owner')
    await expect(setup.manager.authorize(setup.root, target)).rejects.toThrow()
    await expect(readFile(join(setup.profile, 'local-session-link-receipts.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['missing', 'offline', 'provider', 'protocol', 'unsafe-config'] as const)('fails closed for %s Host preparation without native creation', async (reason) => {
    const setup = await fixture()
    if (reason === 'missing') setup.request.hostId = 'missing-host-123'
    if (reason === 'offline') await rm(join(setup.discovery, 'host.json'))
    if (reason === 'provider') setup.native.setProvider('different-provider')
    if (reason === 'protocol') setup.native.setProtocol('0.8.0')
    if (reason === 'unsafe-config') setup.native.setConfig({ schema: { type: 'object', properties: { isolation: { type: 'string', title: 'Isolation' } } }, values: { isolation: 'worktree' } })
    await setup.service.create(setup.root, setup.request, setup.authorize)
    expect((await settled(setup)).state).toBe('failed')
    expect(setup.native.creations).toEqual([])
    expect(setup.native.calls.filter((call) => call.method === 'dispatchAction')).toEqual([])
  })

  it.each(['directory', 'default-chat', 'read-only', 'chat-snapshot', 'failed'] as const)('does not grant access to a mismatched or %s native session', async (reason) => {
    const setup = await fixture()
    setup.native.editCreated(({ session, chat }) => {
      if (reason === 'directory') session.workingDirectories = [pathToFileURL(setup.otherRoot).href]
      if (reason === 'default-chat') session.defaultChat = 'ahp-chat:/different'
      if (reason === 'read-only') chat.interactivity = 'read-only' as typeof chat.interactivity
      if (reason === 'chat-snapshot') chat.resource = 'ahp-chat:/different'
      if (reason === 'failed') session.lifecycle = 'failed' as typeof session.lifecycle
    })
    await setup.service.create(setup.root, setup.request, setup.authorize)
    expect((await settled(setup)).state).toBe(reason === 'failed' ? 'failed' : 'uncertain')
    expect(await setup.service.authorizes(setup.root, { sessionId: setup.native.creations[0].channel,
      chatId: [...setup.native.sessions.values()][0].chat.resource, owner: setup.owner })).toBe(false)
    expect(setup.native.creations).toHaveLength(1)
  })

  it('revokes its private ready grant when inspection detects a changed chat and never selects a replacement', async () => {
    const setup = await fixture()
    const target = await ready(setup)
    const created = setup.native.sessions.get(target.sessionId)!
    created.session.chats[0].resource = 'ahp-chat:/replacement'
    created.session.defaultChat = created.session.chats[0].resource
    created.chat.resource = created.session.defaultChat
    expect((await setup.service.status(setup.root, setup.request.operationId, setup.authorize)).state).toBe('uncertain')
    await expect(setup.manager.authorize(setup.root, target)).rejects.toThrow()
    expect(setup.native.creations).toHaveLength(1)
  })

  it('retires an explicitly deleted original session and allows only an explicit new operation', async () => {
    const setup = await fixture()
    const target = await ready(setup)
    setup.native.deleteSession(target.sessionId)
    const deleted = await setup.service.status(setup.root, setup.request.operationId, setup.authorize)
    expect(deleted).toMatchObject({ state: 'failed', session: target, error: expect.stringContaining('explicitly deleted') })
    await expect(setup.manager.authorize(setup.root, target)).rejects.toThrow()
    expect(setup.native.creations).toHaveLength(1)
    const restarted = await setup.restart()
    expect(await restarted.list(setup.root, setup.authorize)).toEqual([deleted])
    expect(await restarted.create(setup.root, setup.request, setup.authorize)).toEqual(deleted)
    expect(setup.native.creations).toHaveLength(1)
    const request = { ...setup.request, operationId: randomUUID() }
    await restarted.create(setup.root, request, setup.authorize)
    await expect.poll(async () => (await restarted.list(setup.root, setup.authorize)).find((item) => item.operationId === request.operationId)?.state).toBe('ready')
    expect(setup.native.creations).toHaveLength(2)
    expect(setup.native.creations[1].channel).not.toBe(target.sessionId)
    expect((await restarted.list(setup.root, setup.authorize)).find((item) => item.operationId === setup.request.operationId)).toEqual(deleted)
    expect(setup.native.calls.filter((call) => call.method === 'dispatchAction')).toEqual([])
  })

  it.each(['missing', 'offline', 'different-session', 'different-error-code'] as const)('does not treat a %s result as confirmed deletion', async (reason) => {
    const setup = await fixture()
    const target = await ready(setup)
    if (reason === 'missing') setup.native.sessions.delete(target.sessionId)
    else if (reason === 'offline') await rm(join(setup.discovery, 'host.json'))
    else vi.spyOn(setup.registry, 'inspectCreation').mockRejectedValue(new RpcError(
      reason === 'different-error-code' ? -32603 : AhpErrorCodes.SessionNotFound,
      `Session was explicitly deleted: ${reason === 'different-session' ? `copilotcli:/${randomUUID()}` : target.sessionId}`,
    ))
    expect((await setup.service.status(setup.root, setup.request.operationId, setup.authorize)).state).toBe('uncertain')
    await expect(setup.manager.authorize(setup.root, target)).rejects.toThrow()
    await expect(setup.service.create(setup.root, { ...setup.request, operationId: randomUUID() }, setup.authorize)).rejects.toThrow('already has')
    expect(setup.native.creations).toHaveLength(1)
    expect(setup.native.calls.filter((call) => call.method === 'dispatchAction')).toEqual([])
  })

  it.each(['preparation', 'inspection'] as const)('rechecks the workspace/window guard after native %s awaits', async (phase) => {
    const setup = await fixture()
    const wait = phase === 'preparation' ? setup.native.pausePreparation() : setup.native.pauseSessionRead()
    await setup.service.create(setup.root, setup.request, setup.authorize)
    await expect.poll(() => setup.native.calls.some((call) => phase === 'preparation'
      ? call.method === 'resolveSessionConfig' : call.method === 'subscribe' && String(call.params?.channel).startsWith('copilotcli:/'))).toBe(true)
    setup.authorize.mockRejectedValue(new Error('The window or root changed.'))
    wait.resolve()
    const readGuard = async () => {}
    await expect.poll(async () => (await setup.service.list(setup.root, readGuard))[0].state).toBe(phase === 'preparation' ? 'failed' : 'uncertain')
    expect(setup.native.creations).toHaveLength(phase === 'preparation' ? 0 : 1)
  })

  it('rejects malformed/unknown operations and closed services without dispatch', async () => {
    const setup = await fixture()
    await expect(setup.service.create(setup.root, { ...setup.request, workspaceId: setup.otherRoot } as typeof setup.request, setup.authorize)).rejects.toThrow()
    await expect(setup.service.create(setup.root, { ...setup.request, operationId: '../arbitrary' }, setup.authorize)).rejects.toThrow()
    await expect(setup.service.status(setup.root, randomUUID(), setup.authorize)).rejects.toThrow('does not belong')
    await setup.service.close()
    await expect(setup.service.create(setup.root, setup.request, setup.authorize)).rejects.toThrow('closed')
    await expect(setup.service.list(setup.root, setup.authorize)).rejects.toThrow('closed')
    await expect(setup.service.hosts(setup.root, setup.authorize)).rejects.toThrow('closed')
    expect(setup.native.creations).toEqual([])
  })

  it('keeps corrupt, locked and oversized history intact and refuses new reservations', async () => {
    const setup = await fixture()
    await setup.service.list(setup.root, setup.authorize)
    const lock = join(setup.profile, 'local-agent-host-creations', 'operations.lock')
    await writeFile(lock, 'another-process')
    await expect(setup.service.create(setup.root, setup.request, setup.authorize)).rejects.toThrow('locked')
    expect(await readFile(lock, 'utf8')).toBe('another-process')
    await rm(lock)
    for (const content of ['not json', ' '.repeat(8 * 1024 * 1024 + 1)]) {
      await writeFile(setup.file, content)
      await expect(setup.service.create(setup.root, setup.request, setup.authorize)).rejects.toThrow('unreadable')
      expect(await readFile(setup.file, 'utf8')).toBe(content)
    }
    expect(setup.native.creations).toEqual([])
  })

  it('enforces the durable record count and rejects tampered ready identities or missing provisional ACKs', async () => {
    const setup = await fixture()
    setup.native.setLifecycle('creating')
    const target = await ready(setup)
    const [original] = JSON.parse(await readFile(setup.file, 'utf8'))
    for (const edit of [
      { ...original, nativeAcknowledged: false },
      { ...original, request: { ...original.request, hostId: 'different-host-123' } },
      { ...original, nativeSessionId: `copilotcli:/${randomUUID()}` },
    ]) {
      const saved = JSON.stringify([edit])
      await writeFile(setup.file, saved)
      await expect(setup.service.authorizes(setup.root, target)).rejects.toThrow('unreadable')
      await expect(setup.manager.authorize(setup.root, target)).rejects.toThrow('Enable Automatic workspace links')
      await expect(setup.service.status(setup.root, setup.request.operationId, setup.authorize)).rejects.toThrow('unreadable')
      expect(await readFile(setup.file, 'utf8')).toBe(saved)
    }
    const history = Array.from({ length: 1000 }, () => {
      const request = { ...setup.request, operationId: randomUUID() }
      return { ...original, request, nativeSessionId: `copilotcli:/${randomUUID()}`, nativeAcknowledged: false, phase: 'reserved',
        result: { ...request, state: 'failed' } }
    })
    const saved = JSON.stringify(history)
    await writeFile(setup.file, saved)
    await expect(setup.service.create(setup.root, { ...setup.request, operationId: randomUUID() }, setup.authorize)).rejects.toThrow('history limit')
    expect(await readFile(setup.file, 'utf8')).toBe(saved)
    expect(setup.native.creations).toHaveLength(1)
  })

  it('allows an explicit new operation after a definitive pre-dispatch failure but never retries that failed ID', async () => {
    const setup = await fixture()
    setup.native.setProvider('unsupported')
    await setup.service.create(setup.root, setup.request, setup.authorize)
    expect((await settled(setup)).state).toBe('failed')
    setup.native.setProvider('copilotcli')
    expect((await setup.service.create(setup.root, setup.request, setup.authorize)).state).toBe('failed')
    expect(setup.native.creations).toEqual([])
    const request = { ...setup.request, operationId: randomUUID() }
    await setup.service.create(setup.root, request, setup.authorize)
    await expect.poll(async () => (await setup.service.list(setup.root, setup.authorize)).find((item) => item.operationId === request.operationId)?.state).toBe('ready')
    expect(setup.native.creations).toHaveLength(1)
  })
})
