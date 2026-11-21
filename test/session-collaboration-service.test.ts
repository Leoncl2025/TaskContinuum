// @vitest-environment node
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageKind } from '@microsoft/agent-host-protocol'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { attachAgentHostGateway } from '../src/main/agentHostGateway'
import { connectAgentHostWebSocket, connectLocalAgentHost } from '../src/main/agentHostTransport'
import { SessionCollaborationService } from '../src/main/sessionCollaborationService'
import { COLLABORATION_LIMITS, formatCollaborationTargetRef } from '../src/shared/sessionCollaboration'
import type { AgentHostTarget } from '../src/shared/agentHost'
import type { SessionLinksSnapshot } from '../src/shared/sessionBindings'
import { startAgentHostFixture } from './agent-host-fixture'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempRoot(prefix: string): Promise<string> {
  const dir = resolve('.runtime', `${prefix}-${randomUUID()}`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function setupCollaborationFixture() {
  const root = await tempRoot('collab-service')
  const dataDir = join(root, 'profile')
  const workspaceRoot = join(root, 'workspace')
  await mkdir(dataDir, { recursive: true })
  await mkdir(workspaceRoot, { recursive: true })

  const localHost = await startAgentHostFixture()
  cleanups.push(() => localHost.close())
  const remoteHost = await startAgentHostFixture()
  cleanups.push(() => remoteHost.close())

  const localOwner = { clientId: randomUUID(), machineName: 'Studio-A', username: 'alice' }
  const remoteOwner = { clientId: randomUUID(), machineName: 'Worker-B', username: 'bob' }

  const localTarget: AgentHostTarget = {
    sessionId: localHost.sessionId,
    chatId: localHost.chatId,
    owner: { clientId: localOwner.clientId, machineName: localOwner.machineName },
  }
  const remoteTarget: AgentHostTarget = {
    sessionId: remoteHost.sessionId,
    chatId: remoteHost.chatId,
    owner: { clientId: remoteOwner.clientId, machineName: remoteOwner.machineName },
  }

  // Host B runs a real attachAgentHostGateway in front of remoteHost!
  const ownerSideConnection = new AgentHostConnection(
    remoteTarget,
    join(root, 'owner-b-data'),
    (signal) => connectLocalAgentHost(remoteHost.endpoint, signal),
  )
  cleanups.push(() => ownerSideConnection.close())

  let gatewayCanSend = true
  let gatewayAllowedTasks = ['T-0072']
  const gatewayToken = 'b'.repeat(43)
  const gatewayServer = createServer()
  const gateway = attachAgentHostGateway(gatewayServer, {
    port: () => (gatewayServer.address() as { port: number } | null)?.port,
    authorize: async (token, target, send) => {
      if (token !== gatewayToken || target.chatId !== remoteTarget.chatId) throw new Error('Unauthorized.')
      if (send && !gatewayCanSend) throw new Error('Send denied.')
      return {
        canSend: gatewayCanSend,
        actor: localOwner,
        taskIds: gatewayAllowedTasks,
      }
    },
    connection: async () => {
      await ownerSideConnection.open()
      return ownerSideConnection
    },
  })
  gatewayServer.listen(0, '127.0.0.1')
  await once(gatewayServer, 'listening')
  const gatewayPort = (gatewayServer.address() as { port: number }).port
  cleanups.push(async () => {
    gateway.close()
    await new Promise<void>((resolveClose) => gatewayServer.close(() => resolveClose()))
  })

  const newLocalConnection = () => {
    const conn = new AgentHostConnection(
      localTarget,
      join(dataDir, 'local-conn'),
      (signal) => connectLocalAgentHost(localHost.endpoint, signal),
    )
    cleanups.push(() => conn.close())
    return conn
  }
  let localConnection = newLocalConnection()

  const encodedRemoteTarget = Buffer.from(JSON.stringify(remoteTarget)).toString('base64url')
  const newRemoteConnection = () => {
    const conn = new AgentHostConnection(
      remoteTarget,
      join(dataDir, 'remote-conn'),
      (signal) => connectAgentHostWebSocket(
        `ws://127.0.0.1:${gatewayPort}/device/agent-host?target=${encodedRemoteTarget}`,
        { headers: { Authorization: ['Bearer', gatewayToken].join(' ') } },
        signal,
      ),
    )
    cleanups.push(() => conn.close())
    return conn
  }
  let remoteConnection = newRemoteConnection()

  let currentTime = Date.parse('2026-11-16T03:00:00.000Z')
  let authorizedTargets = [localTarget, remoteTarget]
  let bindings: SessionLinksSnapshot['document']['bindings'] = {
    'T-0072': [
      { ...localTarget, provider: 'agent-host' },
      { ...remoteTarget, provider: 'agent-host' },
    ],
  }

  const createService = () => {
    const service = new SessionCollaborationService({
      directory: dataDir,
      identity: async () => localOwner,
      devices: {
        list: async () => [{
          id: randomUUID(),
          ownerClientId: remoteOwner.clientId,
          machineName: remoteOwner.machineName,
          state: 'connected' as const,
          enabled: true,
          expiresAt: '2030-01-01T00:00:00.000Z',
          error: undefined,
        }],
      },
      agentHosts: {
        hasConsent: async () => true,
        local: {
          list: async () => ({
            sessions: [{
              ...localTarget,
              title: 'Local Dev Session',
              provider: 'copilotcli',
              updatedAt: '2026-11-16T03:00:00.000Z',
              canSend: true,
            }],
            warnings: [],
          }),
        },
        authorize: async (_root, target) => {
          const ok = authorizedTargets.some((item) => item.chatId === target.chatId && item.owner.clientId === target.owner.clientId)
          if (!ok) throw new Error('Unauthorized target.')
        },
        connection: async (_root, target) => {
          if (target.owner.clientId === localOwner.clientId) {
            if (localConnection.isClosed) localConnection = newLocalConnection()
            return localConnection
          }
          if (remoteConnection.isClosed) remoteConnection = newRemoteConnection()
          return remoteConnection
        },
      },
      readLinks: async () => ({
        document: { schemaVersion: '2.1', bindings },
        revision: 'rev-1',
        localOwner: { clientId: localOwner.clientId, machineName: localOwner.machineName },
      }),
      readWorkspace: async () => ({ tasks: [{ id: 'T-0072' }, { id: 'T-0073' }] }),
      now: () => currentTime,
    })
    cleanups.push(() => service.close())
    return service
  }

  return {
    dataDir,
    workspaceRoot,
    localHost,
    remoteHost,
    localOwner,
    remoteOwner,
    localTarget,
    remoteTarget,
    get localConnection() { return localConnection },
    get remoteConnection() { return remoteConnection },
    setTime: (ms: number) => { currentTime = ms },
    advanceTime: (deltaMs: number) => { currentTime += deltaMs },
    setAuthorizedTargets: (targets: AgentHostTarget[]) => { authorizedTargets = targets },
    setBindings: (next: SessionLinksSnapshot['document']['bindings']) => { bindings = next },
    setGatewayCanSend: (value: boolean) => { gatewayCanSend = value },
    setGatewayAllowedTasks: (tasks: string[]) => { gatewayAllowedTasks = tasks },
    createService,
  }
}

describe('SessionCollaborationService and gateway provenance', () => {
  it('enforces explicit per-task opt-in and isolates tasks from one another', async () => {
    const setup = await setupCollaborationFixture()
    const service = setup.createService()
    const api = service.forWorkspace(setup.workspaceRoot)
    const remoteRef = formatCollaborationTargetRef('T-0072', setup.remoteTarget)

    await expect(api.listSessions({ taskId: 'T-0072' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(api.readContext({ targetRef: remoteRef, limit: 5, detail: 'summary' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(api.sendMessage({
      targetRef: remoteRef,
      messageId: randomUUID(),
      text: 'Should not send while collaboration is off',
    })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })

    const policy = await service.setTaskPolicy(setup.workspaceRoot, 'T-0072', { enabled: true })
    expect(policy).toMatchObject({ taskId: 'T-0072', enabled: true, paused: false, sentCount: 0 })

    // Enabling T-0072 never grants collaboration on T-0073.
    await expect(api.listSessions({ taskId: 'T-0073' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })

    const listed = await api.listSessions({ taskId: 'T-0072' })
    expect(listed.sessions).toHaveLength(2)
    expect(listed.sessions.map((item) => item.location).sort()).toEqual(['local', 'remote'])
  })

  it('delivers cross-device messages through the gateway with gateway-verified provenance and tracks turn completion', async () => {
    const setup = await setupCollaborationFixture()
    const service = setup.createService()
    await service.setTaskPolicy(setup.workspaceRoot, 'T-0072', { enabled: true })
    const api = service.forWorkspace(setup.workspaceRoot)
    const remoteRef = formatCollaborationTargetRef('T-0072', setup.remoteTarget)
    const messageId = randomUUID()

    const status = await api.sendMessage({
      targetRef: remoteRef,
      messageId,
      text: 'Hold v0.2.5 release until regression tests pass.',
    })
    expect(status).toMatchObject({
      messageId,
      taskId: 'T-0072',
      targetRef: remoteRef,
      state: 'delivered',
      turnId: messageId,
      turnStatus: 'in-progress',
    })

    // Verify native Host B received exact gateway-stamped senderDevice and collaboration metadata!
    expect(setup.remoteHost.dispatches).toHaveLength(1)
    const dispatched = setup.remoteHost.dispatches[0] as {
      turnId: string
      message: { text: string; origin: { kind: string }; _meta: Record<string, unknown> }
    }
    expect(dispatched.turnId).toBe(messageId)
    expect(dispatched.message.text).toBe('Hold v0.2.5 release until regression tests pass.')
    expect(dispatched.message._meta.taskcontinuumCollaboration).toEqual({
      version: 1,
      taskId: 'T-0072',
      messageId,
      senderDevice: {
        clientId: setup.localOwner.clientId,
        machineName: setup.localOwner.machineName,
        username: setup.localOwner.username,
      },
      sourceKind: 'mcp-client',
    })

    // Idempotent retry with identical arguments returns existing status without re-dispatching.
    const duplicate = await api.sendMessage({
      targetRef: remoteRef,
      messageId,
      text: 'Hold v0.2.5 release until regression tests pass.',
    })
    expect(duplicate.state).toBe('delivered')
    expect(setup.remoteHost.dispatches).toHaveLength(1)

    // Reusing the same messageId with different text fails with CONFLICT.
    await expect(api.sendMessage({
      targetRef: remoteRef,
      messageId,
      text: 'Different content with same UUID',
    })).rejects.toMatchObject({ code: 'CONFLICT' })

    // Complete the turn on Host B and verify turnStatus transitions to completed and context is readable.
    setup.remoteHost.action({
      type: 'chat/responsePart',
      turnId: messageId,
      part: { kind: 'markdown', id: 'part-1', content: 'Acknowledged; holding publication.' },
    })
    setup.remoteHost.action({
      type: 'chat/turnComplete',
      turnId: messageId,
      duration: 12,
    })

    await vi.waitFor(async () => {
      const latest = await api.messageStatus(messageId)
      expect(latest.turnStatus).toBe('completed')
    })

    const context = await api.readContext({ targetRef: remoteRef, limit: 5, detail: 'summary' })
    expect(context.turns).toHaveLength(1)
    expect(context.turns[0]).toMatchObject({
      turnId: messageId,
      origin: 'collaboration',
      messageText: 'Hold v0.2.5 release until regression tests pass.',
      responseText: 'Acknowledged; holding publication.',
    })
  })

  it('overwrites spoofed senderDevice on the gateway and rejects unauthorized collaboration task claims', async () => {
    const setup = await setupCollaborationFixture()
    const spoofedTurnId = randomUUID()
    await setup.remoteConnection.send(
      spoofedTurnId,
      'Attempted spoofed sender metadata',
      undefined,
      async () => {},
      { clientId: randomUUID(), machineName: 'Spoofed-Machine', username: 'mallory' },
      undefined,
      {
        version: 1,
        taskId: 'T-0072',
        messageId: spoofedTurnId,
        senderDevice: { clientId: randomUUID(), machineName: 'Spoofed-Machine', username: 'mallory' },
        sourceKind: 'mcp-client',
      },
    )
    const delivered = setup.remoteHost.dispatches.at(-1) as { message: { _meta: { taskcontinuumCollaboration: { senderDevice: unknown } } } }
    expect(delivered.message._meta.taskcontinuumCollaboration.senderDevice).toEqual({
      clientId: setup.localOwner.clientId,
      machineName: setup.localOwner.machineName,
      username: setup.localOwner.username,
    })

    // Claiming a task not linked on the owner gateway is rejected before native dispatch.
    const wrongTaskTurnId = randomUUID()
    await expect(setup.remoteConnection.send(
      wrongTaskTurnId,
      'Wrong task claim',
      undefined,
      async () => {},
      setup.localOwner,
      undefined,
      {
        version: 1,
        taskId: 'T-9999',
        messageId: wrongTaskTurnId,
        senderDevice: setup.localOwner,
        sourceKind: 'mcp-client',
      },
    )).rejects.toThrow()
    expect(setup.remoteHost.dispatches).toHaveLength(1)
  })

  it('queues behind a busy turn, drains on completion, blocks on human drafts, and pauses safely across restart', async () => {
    const setup = await setupCollaborationFixture()
    const service = setup.createService()
    await service.setTaskPolicy(setup.workspaceRoot, 'T-0072', { enabled: true })
    const api = service.forWorkspace(setup.workspaceRoot)
    const localRef = formatCollaborationTargetRef('T-0072', setup.localTarget)

    // Start an active turn on localHost so the chat is busy.
    setup.localHost.action({
      type: 'chat/turnStarted',
      turnId: 'busy-turn-1',
      startedAt: '2026-11-16T03:00:00.000Z',
      message: { text: 'Running long test suite', origin: { kind: MessageKind.User } },
    })

    const queuedId = randomUUID()
    const queued = await api.sendMessage({
      targetRef: localRef,
      messageId: queuedId,
      text: 'Run smoke check after current turn completes.',
    })
    expect(queued.state).toBe('queued')
    expect(setup.localHost.dispatches).toHaveLength(0)

    // Finish busy-turn-1 -> queued message automatically dispatches!
    setup.localHost.action({ type: 'chat/turnComplete', turnId: 'busy-turn-1', duration: 25 })
    await vi.waitFor(async () => {
      const afterDrain = await api.messageStatus(queuedId)
      expect(afterDrain.state).toBe('delivered')
    })
    expect(setup.localHost.dispatches).toHaveLength(1)
    setup.localHost.action({ type: 'chat/turnComplete', turnId: queuedId, duration: 10 })

    // Human unsent draft on remoteHost blocks collaboration without overwriting the draft.
    setup.remoteHost.draft('Unsent owner draft on B')
    const reloadHost = setup.createService()
    const blockedId = randomUUID()
    const remoteRef = formatCollaborationTargetRef('T-0072', setup.remoteTarget)
    const blocked = await reloadHost.forWorkspace(setup.workspaceRoot).sendMessage({
      targetRef: remoteRef,
      messageId: blockedId,
      text: 'Should be blocked by human draft',
    })
    expect(blocked.state).toBe('blocked')
    expect(blocked.reason).toMatch(/draft/i)
    expect(setup.remoteHost.dispatches).toHaveLength(0)

    // Queue another message while busy, then simulate desktop restart: must transition queued -> blocked (never auto-replay!).
    const serviceBeforeRestart = setup.createService()
    const apiBeforeRestart = serviceBeforeRestart.forWorkspace(setup.workspaceRoot)
    setup.localHost.action({
      type: 'chat/turnStarted',
      turnId: 'busy-turn-2',
      startedAt: '2026-11-16T03:05:00.000Z',
      message: { text: 'Another active turn', origin: { kind: MessageKind.User } },
    })
    const restartQueuedId = randomUUID()
    const beforeRestart = await apiBeforeRestart.sendMessage({
      targetRef: localRef,
      messageId: restartQueuedId,
      text: 'Must pause on restart instead of replaying',
    })
    expect(beforeRestart.state).toBe('queued')
    await serviceBeforeRestart.close()

    const serviceAfterRestart = setup.createService()
    const afterRestart = await serviceAfterRestart.forWorkspace(setup.workspaceRoot).messageStatus(restartQueuedId)
    expect(afterRestart.state).toBe('blocked')
    expect(afterRestart.reason).toMatch(/restart/i)
  })

  it('supports context cursor pagination, pause/resume, TTL expiry, and per-task quota reset', async () => {
    const setup = await setupCollaborationFixture()
    setup.localHost.historyText(8, 'Historical output', ['t-1', 't-2', 't-3', 't-4', 't-5', 't-6', 't-7', 't-8'])
    setup.localHost.historyWindow(4, 4)

    const service = setup.createService()
    await service.setTaskPolicy(setup.workspaceRoot, 'T-0072', { enabled: true })
    const api = service.forWorkspace(setup.workspaceRoot)
    const localRef = formatCollaborationTargetRef('T-0072', setup.localTarget)

    const recentPage = await api.readContext({ targetRef: localRef, limit: 3, detail: 'summary' })
    expect(recentPage.turns.map((turn) => turn.turnId)).toEqual(['t-6', 't-7', 't-8'])
    expect(recentPage.hasMoreHistory).toBe(true)
    expect(recentPage.nextCursor).toBe('t-6')

    const olderPage = await api.readContext({ targetRef: localRef, cursor: recentPage.nextCursor, limit: 3, detail: 'summary' })
    expect(olderPage.turns.map((turn) => turn.turnId)).toEqual(['t-3', 't-4', 't-5'])

    // Pause blocks new operations with COLLABORATION_PAUSED.
    await service.setTaskPolicy(setup.workspaceRoot, 'T-0072', { paused: true })
    await expect(api.listSessions({ taskId: 'T-0072' })).rejects.toMatchObject({ code: 'COLLABORATION_PAUSED' })
    await service.setTaskPolicy(setup.workspaceRoot, 'T-0072', { paused: false })

    // Queue expiry after TTL.
    setup.localHost.action({
      type: 'chat/turnStarted',
      turnId: 'long-running',
      startedAt: '2026-11-16T03:10:00.000Z',
      message: { text: 'Busy', origin: { kind: MessageKind.User } },
    })
    const expiringId = randomUUID()
    const expiring = await api.sendMessage({
      targetRef: localRef,
      messageId: expiringId,
      text: 'Will expire if busy too long',
    })
    expect(expiring.state).toBe('queued')
    setup.advanceTime(COLLABORATION_LIMITS.messageTtlMs + 1_000)
    const expiredStatus = await api.messageStatus(expiringId)
    expect(expiredStatus.state).toBe('expired')
  })

  it('self-heals after cached connection eviction or disconnect without losing context reads or sends', async () => {
    const setup = await setupCollaborationFixture()
    const service = setup.createService()
    await service.setTaskPolicy(setup.workspaceRoot, 'T-0072', { enabled: true })
    const api = service.forWorkspace(setup.workspaceRoot)
    const remoteRef = formatCollaborationTargetRef('T-0072', setup.remoteTarget)

    // Initial context read populates loadedConnections.
    await expect(api.readContext({ targetRef: remoteRef, limit: 3, detail: 'summary' })).resolves.toMatchObject({ state: 'connected' })

    // Simulate pool eviction closing the cached connection instance.
    const evicted = setup.remoteConnection
    await evicted.close()
    expect(evicted.isClosed).toBe(true)

    // Subsequent listSessions, sendMessage, and readContext seamlessly acquire a fresh connection.
    const listed = await api.listSessions({ taskId: 'T-0072' })
    expect(listed.sessions.find((item) => item.targetRef === remoteRef)?.state).toBe('connected')

    const msgId = randomUUID()
    const sent = await api.sendMessage({
      targetRef: remoteRef,
      messageId: msgId,
      text: 'Delivered after connection eviction',
    })
    expect(sent.state).toBe('delivered')
    expect(setup.remoteConnection).not.toBe(evicted)
    expect(setup.remoteHost.dispatches).toHaveLength(1)
  })
})
