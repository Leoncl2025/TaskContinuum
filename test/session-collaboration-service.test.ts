// @vitest-environment node
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageKind } from '@microsoft/agent-host-protocol'
import type { ChatToolCallCompleteAction, SessionActiveClientSetAction } from '@microsoft/agent-host-protocol'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { attachAgentHostGateway } from '../src/main/agentHostGateway'
import { AgentHostManager } from '../src/main/agentHostManager'
import { AgentHostRegistry } from '../src/main/agentHostRegistry'
import { connectAgentHostWebSocket, connectLocalAgentHost } from '../src/main/agentHostTransport'
import { canonicalPolicyRoot, recordLocalLink } from '../src/main/linkedSessionPolicy'
import { registerRepositorySessionLinksBackend } from '../src/main/repositorySessionLinks'
import { SessionCollaborationService } from '../src/main/sessionCollaborationService'
import { TaskContinuumAgentHostTools } from '../src/main/taskContinuumAgentHostTools'
import { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import type { WorkspaceTaskMetadata } from '../src/main/workspaceReader'
import { COLLABORATION_LIMITS, formatCollaborationTargetRef } from '../src/shared/sessionCollaboration'
import type { AgentHostTarget } from '../src/shared/agentHost'
import type { SessionLinksSnapshot } from '../src/shared/sessionBindings'
import { startAgentHostFixture } from './agent-host-fixture'

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempRoot(prefix: string): Promise<string> {
  const dir = resolve('.runtime', `${prefix}-${randomUUID()}`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function setupCollaborationFixture(protocolVersion = '0.9.0', ownerTools?: TaskContinuumAgentHostTools) {
  const root = await tempRoot('collab-service')
  const dataDir = join(root, 'profile')
  const workspaceRoot = join(root, 'workspace')
  const otherWorkspaceRoot = join(root, 'other-workspace')
  await mkdir(dataDir, { recursive: true })
  await mkdir(workspaceRoot, { recursive: true })
  await mkdir(otherWorkspaceRoot, { recursive: true })
  const canonicalWorkspace = await canonicalPolicyRoot(workspaceRoot)

  const localHost = await startAgentHostFixture(undefined, protocolVersion)
  cleanups.push(() => localHost.close())
  const remoteHost = await startAgentHostFixture(undefined, ownerTools ? protocolVersion : '0.9.0')
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
    Boolean(ownerTools),
  )
  cleanups.push(() => ownerSideConnection.close())

  let gatewayCanSend = true
  let gatewayAllowedTasks = ['T-0072']
  const gatewayToken = 'b'.repeat(43)
  const gatewayServer = createServer()
  const gateway = attachAgentHostGateway(gatewayServer, {
    port: () => (gatewayServer.address() as { port: number } | null)?.port,
    nativeTools: ownerTools,
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
      true,
    )
    cleanups.push(() => conn.close())
    return conn
  }
  let localConnection = newLocalConnection()

  const connectRemote = (target: AgentHostTarget, signal: AbortSignal) => connectAgentHostWebSocket(
    `ws://127.0.0.1:${gatewayPort}/device/agent-host?target=${Buffer.from(JSON.stringify(target)).toString('base64url')}`,
    { headers: { Authorization: ['Bearer', gatewayToken].join(' ') } },
    signal,
  )
  const newRemoteConnection = () => {
    const conn = new AgentHostConnection(
      remoteTarget,
      join(dataDir, 'remote-conn'),
      (signal) => connectRemote(remoteTarget, signal),
    )
    cleanups.push(() => conn.close())
    return conn
  }
  let remoteConnection = newRemoteConnection()

  let currentTime = Date.parse('2026-11-16T03:00:00.000Z')
  let authorizedTargets = [localTarget, remoteTarget]
  let tasks: WorkspaceTaskMetadata[] = [{ id: 'T-0072', title: 'Release' }, { id: 'T-0073', title: 'Verification' }]
  let bindings: SessionLinksSnapshot['document']['bindings'] = {
    'T-0072': [
      { ...localTarget, provider: 'agent-host' },
      { ...remoteTarget, provider: 'agent-host' },
    ],
  }

  const authorize = vi.fn(async (_root: string, target: AgentHostTarget) => {
    const ok = authorizedTargets.some((item) => item.chatId === target.chatId && item.owner.clientId === target.owner.clientId)
    if (!ok) throw new Error('Unauthorized target.')
  })
  const readWorkspace = vi.fn(async () => ({ tasks }))
  const readLinks = vi.fn(async (root: string): Promise<SessionLinksSnapshot> => ({
    document: { schemaVersion: '2.1', bindings: root === canonicalWorkspace ? bindings : {} },
    revision: 'rev-1',
    localOwner: { clientId: localOwner.clientId, machineName: localOwner.machineName },
  }))

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
        authorize,
        connection: async (_root, target) => {
          if (target.owner.clientId === localOwner.clientId) {
            if (localConnection.isClosed) localConnection = newLocalConnection()
            return localConnection
          }
          if (remoteConnection.isClosed) remoteConnection = newRemoteConnection()
          return remoteConnection
        },
      },
      readLinks,
      readWorkspace,
      now: () => currentTime,
    })
    cleanups.push(() => service.close())
    return service
  }

  return {
    dataDir,
    workspaceRoot,
    otherWorkspaceRoot,
    localHost,
    remoteHost,
    localOwner,
    remoteOwner,
    localTarget,
    remoteTarget,
    ownerSideConnection,
    get localConnection() { return localConnection },
    get remoteConnection() { return remoteConnection },
    setTime: (ms: number) => { currentTime = ms },
    advanceTime: (deltaMs: number) => { currentTime += deltaMs },
    setAuthorizedTargets: (targets: AgentHostTarget[]) => { authorizedTargets = targets },
    setBindings: (next: SessionLinksSnapshot['document']['bindings']) => { bindings = next },
    setTasks: (next: WorkspaceTaskMetadata[]) => { tasks = next },
    setGatewayCanSend: (value: boolean) => { gatewayCanSend = value },
    setGatewayAllowedTasks: (tasks: string[]) => { gatewayAllowedTasks = tasks },
    authorize,
    readWorkspace,
    readLinks,
    connectRemote,
    createService,
  }
}

describe('SessionCollaborationService and gateway provenance', () => {
  it('sends collaboration and implicit remote turns without failing on VS Code internal model config keys or stale models', async () => {
    const f = await setupCollaborationFixture()
    f.remoteHost.setModels([{
      id: 'gpt-6',
      name: 'GPT-6',
      provider: 'copilotcli',
      configSchema: {
        type: 'object',
        properties: {
          thinkingLevel: { type: 'string', title: 'Thinking Level', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
          contextSize: { type: 'number', title: 'Context Size', enum: [272000, 872000] },
          lockedOption: { type: 'string', title: 'Locked Option', readOnly: true },
        },
      },
    }])
    await f.ownerSideConnection.models()

    // Simulate a previous turn authored in VS Code native UI carrying vscode.modelConfiguration.*.source metadata.
    const nativeUiTurn = randomUUID()
    f.remoteHost.action({
      type: 'chat/turnStarted', turnId: nativeUiTurn, startedAt: new Date().toISOString(),
      message: {
        text: '占位：测试seesion collab ',
        origin: { kind: MessageKind.User },
        model: {
          id: 'gpt-6',
          config: {
            contextSize: 872000,
            thinkingLevel: 'xhigh',
            lockedOption: 'managed',
            'vscode.modelConfiguration.thinkingLevel.source': 'explicit',
            'vscode.modelConfiguration.contextSize.source': 'explicit',
            staleUnknownOption: 'legacy',
          },
        },
      },
    })
    f.remoteHost.action({ type: 'chat/turnComplete', turnId: nativeUiTurn, duration: 1 })

    const api = f.createService().forWorkspace(f.workspaceRoot)
    const targetRef = formatCollaborationTargetRef('T-0072', f.remoteTarget)
    const collabId = randomUUID()
    await expect(api.sendMessage({ targetRef, messageId: collabId, text: 'Hi' }))
      .resolves.toMatchObject({ state: 'delivered', turnId: collabId })
    expect(f.remoteHost.dispatches[0]).toMatchObject({ turnId: collabId, message: { text: 'Hi' } })
    expect(f.remoteHost.dispatches[0]).not.toHaveProperty('message.model')
    f.remoteHost.action({ type: 'chat/turnComplete', turnId: collabId, duration: 1 })

    // Re-seed native UI turn and verify an implicit remote send delegates clean inheritance to the owner.
    const secondNativeTurn = randomUUID()
    f.remoteHost.action({
      type: 'chat/turnStarted', turnId: secondNativeTurn, startedAt: new Date().toISOString(),
      message: {
        text: 'Native UI turn 2',
        origin: { kind: MessageKind.User },
        model: {
          id: 'gpt-6',
          config: {
            contextSize: 872000,
            thinkingLevel: 'xhigh',
            lockedOption: 'managed',
            'vscode.modelConfiguration.thinkingLevel.source': 'explicit',
            'vscode.modelConfiguration.contextSize.source': 'explicit',
            staleUnknownOption: 'legacy',
          },
        },
      },
    })
    f.remoteHost.action({ type: 'chat/turnComplete', turnId: secondNativeTurn, duration: 1 })
    await vi.waitFor(() => {
      expect(f.remoteConnection.view.chat?.turns.at(-1)?.id).toBe(secondNativeTurn)
      expect(f.remoteConnection.view.chat?.activeTurn).toBeUndefined()
    })

    const followUpId = randomUUID()
    await f.remoteConnection.send(followUpId, 'Implicit remote follow-up', undefined, async () => {})
    expect(f.remoteHost.dispatches[1]).toMatchObject({
      turnId: followUpId,
      message: {
        text: 'Implicit remote follow-up',
        model: { id: 'gpt-6', config: { contextSize: 872000, thinkingLevel: 'xhigh' } },
      },
    })
    f.remoteHost.action({ type: 'chat/turnComplete', turnId: followUpId, duration: 1 })

    // Also verify collaboration succeeds when historical turn used a retired model and catalog queries fail.
    const retiredTurn = randomUUID()
    f.remoteHost.action({
      type: 'chat/turnStarted', turnId: retiredTurn, startedAt: new Date().toISOString(),
      message: { text: 'Retired model turn', origin: { kind: MessageKind.User }, model: { id: 'removed-model' } },
    })
    f.remoteHost.action({ type: 'chat/turnComplete', turnId: retiredTurn, duration: 1 })
    await vi.waitFor(() => {
      expect(f.remoteConnection.view.chat?.turns.at(-1)?.id).toBe(retiredTurn)
      expect(f.remoteConnection.view.chat?.activeTurn).toBeUndefined()
    })
    f.remoteHost.failModels(true)
    const messageId = randomUUID()
    await expect(api.sendMessage({ targetRef, messageId, text: 'Hi again' }))
      .resolves.toMatchObject({ state: 'delivered', turnId: messageId })
    expect(f.remoteHost.dispatches[2]).not.toHaveProperty('message.model')
  })

  it('keeps the gateway connected when its newer catalog definitively rejects a stale explicit model', async () => {
    const f = await setupCollaborationFixture()
    expect(await f.remoteConnection.models()).toContainEqual(expect.objectContaining({ id: 'gpt-6' }))
    f.remoteHost.setModels([{ id: 'owner-model', name: 'Owner model', provider: 'copilotcli' }])
    await f.ownerSideConnection.models()
    const id = randomUUID()
    await expect(f.remoteConnection.send(id, 'Use the explicit selection', undefined, async () => {}, undefined, { id: 'gpt-6' }))
      .rejects.toThrow('No turn was sent. The model or its configuration was rejected by the owner Host.')
    expect(f.remoteConnection.view.state).toBe('connected')
    expect(f.remoteConnection.view.pendingTurn).toBeUndefined()
    expect(f.remoteHost.dispatches).toHaveLength(0)

    await f.remoteConnection.send(randomUUID(), 'Use a currently available selection', undefined, async () => {}, undefined, { id: 'owner-model' })
    expect(f.remoteHost.dispatches).toHaveLength(1)
  })

  it('keeps a disconnected submission uncertain and does not replay its ID', async () => {
    const f = await setupCollaborationFixture()
    const api = f.createService().forWorkspace(f.workspaceRoot)
    const targetRef = formatCollaborationTargetRef('T-0072', f.remoteTarget)
    const messageId = randomUUID()
    const request = { targetRef, messageId, text: 'Hi' }
    f.remoteHost.loseNextSend()
    await expect(api.sendMessage(request)).resolves.toMatchObject({ state: 'uncertain', turnId: messageId })
    await expect(api.messageStatus(messageId)).resolves.toMatchObject({ state: 'uncertain', turnStatus: 'unknown' })
    await expect(api.sendMessage(request)).resolves.toMatchObject({ state: 'uncertain', turnId: messageId })

    const freshSender = new AgentHostConnection(f.remoteTarget, join(f.dataDir, 'fresh-sender'),
      (signal) => f.connectRemote(f.remoteTarget, signal))
    cleanups.push(() => freshSender.close())
    await expect(freshSender.send(messageId, request.text, undefined, async () => {})).rejects.toThrow()
    // The owner cannot issue a definite rejection for a turn it may previously have dispatched.
    expect(freshSender.view.pendingTurn).toEqual({ id: messageId, state: 'uncertain' })
    expect(f.remoteHost.dispatches).toMatchObject([{ turnId: messageId }])
  })

  it('lets a remotely started Run5 turn list and send through the Studio workspace without an owner-side view', async () => {
    const ownerApi = vi.fn(() => { throw new Error('Run5 must never execute tools with its owner’s permissions.') })
    const f = await setupCollaborationFixture('1.0.0', new TaskContinuumAgentHostTools(ownerApi))
    const taskId = 'T-0072'
    const canonical = await canonicalPolicyRoot(f.workspaceRoot)
    cleanups.push(await registerRepositorySessionLinksBackend(canonical, {
      read: () => f.readLinks(canonical),
      update: async () => { throw new Error('Collaboration must not write workspace bindings.') },
    }))
    await recordLocalLink(f.dataDir, canonical, taskId, { ...f.localTarget, provider: 'agent-host' }, f.localTarget.owner)
    const discovery = join(f.dataDir, 'discovery')
    await mkdir(discovery)
    await writeFile(join(discovery, 'fixture.json'), JSON.stringify(f.localHost.endpoint))
    const identity = async () => f.localTarget.owner
    const devices = new VSCodeDeviceClient(f.dataDir, {
      available: () => true, encrypt: (text) => Buffer.from(text), decrypt: (bytes) => bytes.toString(),
    }, async () => { throw new Error('Fixture uses a loopback gateway.') }, async () => {})
    vi.spyOn(devices, 'agentHostTransport').mockImplementation((_root, target, signal) => f.connectRemote(target, signal))
    const manager = new AgentHostManager(f.dataDir, new AgentHostRegistry(f.dataDir, [discovery], identity), devices, identity)
    cleanups.push(async () => { await manager.close(); devices.close() })
    const service = new SessionCollaborationService({
      directory: f.dataDir, agentHosts: manager, devices, identity, readWorkspace: f.readWorkspace,
    })
    cleanups.push(() => service.close())
    const studioTools = new TaskContinuumAgentHostTools((root, target, beforeAccept) => ({
      collaboration: service.forWorkspace(root, { target, beforeAccept }),
    }))
    const execute = vi.spyOn(studioTools, 'executeForCaller')
    manager.setToolRelay((root, target, request, verify) => studioTools.executeForCaller(root, target, request, verify))
    const run5 = await manager.connection(f.workspaceRoot, f.remoteTarget)
    await run5.open()
    const registration = () => (f.remoteHost.dispatches as SessionActiveClientSetAction[]).find(({ type }) => type === 'session/activeClientSet')
    await vi.waitFor(() => expect(registration()).toBeDefined())
    const clientId = registration()!.activeClient.clientId
    const turnId = randomUUID()
    await run5.send(turnId, 'Send Hi to the linked Studio session', undefined, () => manager.authorize(f.workspaceRoot, f.remoteTarget), f.localOwner)

    const request = (toolName: string, args: Record<string, unknown>, id = randomUUID(), activeTurn = turnId) => ({
      type: 'session/inputNeededSet',
      request: {
        kind: 'toolClientExecution', id, turnId: activeTurn, clientId, chat: f.remoteTarget.chatId,
        toolCall: { status: 'running', toolCallId: id, toolName, contributor: { kind: 'client', clientId }, toolInput: JSON.stringify(args) },
      },
    })
    const completed = (id: string) => (f.remoteHost.dispatches as ChatToolCallCompleteAction[]).find(
      (action) => action.type === 'chat/toolCallComplete' && action.toolCallId === id,
    )?.result
    const invoke = async (call: ReturnType<typeof request>, expected: object) => {
      f.remoteHost.sessionAction(call)
      await vi.waitFor(() => expect(completed(call.request.id)).toMatchObject(expected))
    }

    const targetRef = formatCollaborationTargetRef(taskId, f.localTarget)
    const list = request('taskcontinuum_collaboration_list_sessions', { taskId, query: 'Studio-A' })
    await invoke(list, { success: true, structuredContent: { result: { sessions: [{ targetRef, location: 'local' }] } } })
    expect(execute).toHaveBeenLastCalledWith(canonical, f.remoteTarget, expect.objectContaining({ turnId }), expect.any(Function))
    const send = 'taskcontinuum_collaboration_send_message'
    const messageId = randomUUID()
    const denied = request(send, { targetRef: formatCollaborationTargetRef(taskId, { ...f.localTarget, chatId: 'ahp-chat:/private-other' }), messageId, text: 'Hi' })
    await invoke(denied, { success: false, error: { code: 'NOT_FOUND' } })
    const call = request(send, { targetRef, messageId, text: 'Hi' })
    await invoke(call, { success: true, structuredContent: { result: { state: 'delivered', messageId } } })
    f.remoteHost.sessionAction(call)
    const wrongTurn = request('taskcontinuum_collaboration_list_sessions', {}, randomUUID(), randomUUID())
    await invoke(wrongTurn, { success: false, error: { code: 'ACCESS_DENIED' } })
    expect(f.localHost.dispatches).toMatchObject([{ turnId: messageId, message: { text: 'Hi', _meta: { taskcontinuumCollaboration: {
      senderDevice: { clientId: f.localOwner.clientId }, sourceKind: 'agent-host-client',
    } } } }])
    expect(execute).toHaveBeenCalledTimes(3)

    // The owner rechecks its existing send grant for every relay.
    f.setGatewayCanSend(false)
    await invoke(request('taskcontinuum_collaboration_list_sessions', {}), { success: false, error: { code: 'ACCESS_DENIED' } })
    expect(execute).toHaveBeenCalledTimes(3)

    // A reconnected client cannot inherit an old turn or replay its tool calls.
    await run5.close()
    await vi.waitFor(() => expect(f.remoteHost.dispatchChannels).toContainEqual({ channel: f.remoteTarget.sessionId, type: 'session/activeClientRemoved' }))
    f.setGatewayCanSend(true)
    const reconnected = await manager.connection(f.workspaceRoot, f.remoteTarget)
    await reconnected.open()
    const registrations = () => (f.remoteHost.dispatches as SessionActiveClientSetAction[]).filter(({ type }) => type === 'session/activeClientSet')
    await vi.waitFor(() => expect(registrations()).toHaveLength(2))
    const oldTurn = request('taskcontinuum_collaboration_list_sessions', {})
    oldTurn.request.clientId = oldTurn.request.toolCall.contributor.clientId = registrations()[1].activeClient.clientId
    await invoke(oldTurn, { success: false, error: { code: 'UNAVAILABLE', message: expect.stringContaining('No live TaskContinuum connection') } })
    expect(execute).toHaveBeenCalledTimes(3)
    expect(ownerApi).not.toHaveBeenCalled()
  })

  it('lists, reads, and sends to a repository binding through the real AgentHostManager', async () => {
    const f = await setupCollaborationFixture()
    const taskId = 'T-0072'
    const canonical = await canonicalPolicyRoot(f.workspaceRoot)
    const unregister = await registerRepositorySessionLinksBackend(canonical, {
      read: () => f.readLinks(canonical),
      update: async () => { throw new Error('Collaboration must not write workspace bindings.') },
    })
    cleanups.push(unregister)
    const identity = async () => f.localOwner
    const registry = new AgentHostRegistry(f.dataDir, [], identity)
    const devices = new VSCodeDeviceClient(f.dataDir, {
      available: () => true, encrypt: (text) => Buffer.from(text), decrypt: (bytes) => bytes.toString(),
    }, async () => { throw new Error('Fixture uses a loopback gateway.') }, async () => {})
    const transport = vi.spyOn(devices, 'agentHostTransport')
      .mockImplementation((_root, target, signal) => f.connectRemote(target, signal))
    const manager = new AgentHostManager(f.dataDir, registry, devices, identity)
    cleanups.push(async () => { await manager.close(); devices.close() })
    const service = new SessionCollaborationService({
      directory: f.dataDir, agentHosts: manager, devices, identity, readWorkspace: f.readWorkspace,
    })
    cleanups.push(() => service.close())
    const api = service.forWorkspace(f.workspaceRoot)

    f.remoteHost.historyText(1, 'Remote fixture response')
    const targetRef = formatCollaborationTargetRef(taskId, f.remoteTarget)
    // The local binding has no owner receipt, even though it is in the repository.
    const expected = { sessions: [{ targetRef, location: 'remote' }] }
    await expect(api.listSessions({ taskId })).resolves.toMatchObject(expected)
    await expect(api.listSessions({})).resolves.toMatchObject(expected)
    expect(transport).not.toHaveBeenCalled()
    await expect(api.readContext({ targetRef, limit: 1, detail: 'summary' })).resolves.toMatchObject({
      targetRef, turns: [{ responseText: 'Remote fixture response' }],
    })

    const unconfirmedRef = formatCollaborationTargetRef(taskId, f.localTarget)
    await expect(api.readContext({ targetRef: unconfirmedRef, limit: 1, detail: 'summary' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })

    const messageId = randomUUID()
    await expect(api.sendMessage({ targetRef, messageId, text: 'Hi' })).resolves.toMatchObject({
      targetRef, messageId, state: 'delivered',
    })
    expect(f.remoteHost.dispatches).toMatchObject([{ turnId: messageId, message: { text: 'Hi' } }])
  })

  it('sends from a native client tool through the remote gateway and revalidates the sender of queued messages', async () => {
    const f = await setupCollaborationFixture('1.0.0')
    f.setBindings({
      'T-0072': [{ ...f.localTarget, provider: 'agent-host' }],
      'T-0073': [{ ...f.remoteTarget, provider: 'agent-host' }],
    })
    f.setGatewayAllowedTasks(['T-0073'])
    const service = f.createService()
    const native = new TaskContinuumAgentHostTools((root, target, beforeAccept) => ({
      collaboration: service.forWorkspace(root, { target, beforeAccept }),
    }))
    cleanups.push(native.attach(f.workspaceRoot, f.localConnection, (root) => f.authorize(root, f.localTarget)))
    await f.localConnection.open()
    const registration = () => (f.localHost.dispatches as SessionActiveClientSetAction[]).find(({ type }) => type === 'session/activeClientSet')
    await vi.waitFor(() => expect(registration()).toBeDefined())
    const clientId = registration()!.activeClient.clientId
    const turnId = randomUUID()
    f.localHost.action({
      type: 'chat/turnStarted', turnId, startedAt: new Date().toISOString(),
      message: { text: 'Send the verification instructions', origin: { kind: MessageKind.User } },
    })
    const targetRef = formatCollaborationTargetRef('T-0073', f.remoteTarget)
    const send = async (messageId: string, state: 'delivered' | 'queued') => {
      const toolCallId = randomUUID()
      f.localHost.sessionAction({
        type: 'session/inputNeededSet',
        request: {
          kind: 'toolClientExecution', id: toolCallId, clientId, turnId, chat: f.localTarget.chatId,
          toolCall: {
            status: 'running', toolCallId, toolName: 'taskcontinuum_collaboration_send_message',
            contributor: { kind: 'client', clientId },
            toolInput: JSON.stringify({ targetRef, messageId, text: 'Verify the build.' }),
          },
        },
      })
      await vi.waitFor(() => {
        const complete = (f.localHost.dispatches as ChatToolCallCompleteAction[]).find((action) =>
          action.type === 'chat/toolCallComplete' && action.toolCallId === toolCallId)
        expect(complete?.result).toMatchObject({ success: true, structuredContent: { result: { messageId, state } } })
      })
    }

    const messageId = randomUUID()
    await send(messageId, 'delivered')
    await send(messageId, 'delivered')
    expect(f.remoteHost.dispatches).toHaveLength(1)
    expect(f.remoteHost.dispatches[0]).toMatchObject({
      turnId: messageId,
      message: { _meta: { taskcontinuumCollaboration: { sourceKind: 'agent-host-client', sourceTarget: f.localTarget } } },
    })

    const queuedId = randomUUID()
    await send(queuedId, 'queued')
    f.setAuthorizedTargets([f.remoteTarget])
    f.remoteHost.action({ type: 'chat/turnComplete', turnId: messageId, duration: 1 })
    await vi.waitFor(async () => expect(await service.forWorkspace(f.workspaceRoot).messageStatus(queuedId)).toMatchObject({
      state: 'failed', reason: 'The originating chat is no longer authorized for this workspace.',
    }))
    expect(f.remoteHost.dispatches).toHaveLength(1)
  })

  it('lists workspace sessions but still rejects unlinked and unauthorized targets', async () => {
    const setup = await setupCollaborationFixture()
    const service = setup.createService()
    const api = service.forWorkspace(setup.workspaceRoot)
    const remoteRef = formatCollaborationTargetRef('T-0072', setup.remoteTarget)

    const listed = await api.listSessions({ taskId: 'T-0072' })
    expect(listed.collaboration).toEqual({ queuedCount: 0 })
    expect(listed.sessions.map((item) => item.location).sort()).toEqual(['local', 'remote'])
    await expect(api.listSessions({ taskId: 'T-0073' })).resolves.toMatchObject({
      collaboration: { queuedCount: 0 },
      sessions: [{ taskId: 'T-0072', location: 'local' }, { taskId: 'T-0072', location: 'remote' }],
    })
    await expect(api.readContext({
      targetRef: formatCollaborationTargetRef('T-0073', setup.remoteTarget),
      limit: 5,
      detail: 'summary',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const other = service.forWorkspace(setup.otherWorkspaceRoot)
    await expect(other.listSessions({ taskId: 'T-0072' })).resolves.toMatchObject({ sessions: [] })
    await expect(other.readContext({ targetRef: remoteRef, limit: 5, detail: 'summary' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(other.sendMessage({ targetRef: remoteRef, messageId: randomUUID(), text: 'Wrong workspace' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })

    setup.setAuthorizedTargets([setup.localTarget])
    await expect(api.listSessions({ taskId: 'T-0072' })).resolves.toMatchObject({ sessions: [{ location: 'local' }] })
    await expect(api.sendMessage({
      targetRef: remoteRef,
      messageId: randomUUID(),
      text: 'Do not send to an unauthorized session',
    })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(setup.remoteHost.dispatches).toHaveLength(0)
  })

  it('searches current task, children, ancestors, then other tasks and stops authorizing at the page size', async () => {
    const setup = await setupCollaborationFixture()
    const tree = [
      { id: 'T-0080', title: 'Unrelated' },
      { id: 'T-0075', title: 'Grandchild', parentId: 'T-0073' },
      { id: 'T-0060', title: 'Root review' },
      { id: 'T-0061', title: 'Parent', parentId: 'T-0060' },
      { id: 'T-0072', title: 'Current', parentId: 'T-0061' },
      { id: 'T-0073', title: 'First child', parentId: 'T-0072' },
      { id: 'T-0074', title: 'Second child', parentId: 'T-0072' },
    ]
    const links = tree.map(({ id }) => ({
      sessionId: `copilotcli:/session-${id}`,
      chatId: `ahp-chat:/chat-${id}`,
      owner: setup.remoteTarget.owner,
      provider: 'agent-host' as const,
    }))
    setup.setTasks(tree)
    setup.setBindings(Object.fromEntries(tree.map(({ id }, index) => [id, [links[index]]])))
    setup.setAuthorizedTargets(links)
    const api = setup.createService().forWorkspace(setup.workspaceRoot)

    const first = await api.listSessions({ taskId: 'T-0072', limit: 2 })
    expect(first.sessions.map((session) => session.taskId)).toEqual(['T-0072', 'T-0073'])
    expect(first.nextOffset).toBe(2)
    expect(setup.readWorkspace).toHaveBeenCalledOnce()
    expect(setup.readLinks).toHaveBeenCalledOnce()
    expect(setup.authorize.mock.calls.map(([, target]) => target.sessionId))
      .toEqual(['copilotcli:/session-T-0072', 'copilotcli:/session-T-0073'])

    const rest = await api.listSessions({ taskId: 'T-0072', offset: first.nextOffset })
    expect(rest.sessions.map((session) => session.taskId)).toEqual(['T-0074', 'T-0075', 'T-0061', 'T-0060', 'T-0080'])
    expect(rest.nextOffset).toBeUndefined()
    await expect(api.listSessions({ query: 'root worker-b' }))
      .resolves.toMatchObject({ sessions: [{ taskId: 'T-0060' }] })
  })

  it('does not block collaboration based on previous task settings or rewrite them', async () => {
    const setup = await setupCollaborationFixture()
    const oldPolicyPath = join(setup.dataDir, 'session-collaboration-policy.json')
    const oldPolicy = JSON.stringify({
      schemaVersion: 1,
      workspaces: {
        [await canonicalPolicyRoot(setup.workspaceRoot)]: {
          'T-0072': { enabled: false, paused: false, sentCount: 32 },
          'T-0073': { enabled: true, paused: true, sentCount: 0 },
        },
      },
    })
    await writeFile(oldPolicyPath, oldPolicy)

    const api = setup.createService().forWorkspace(setup.workspaceRoot)
    const remoteRef = formatCollaborationTargetRef('T-0072', setup.remoteTarget)
    await expect(api.listSessions({ taskId: 'T-0073' })).resolves.toMatchObject({ sessions: [{ taskId: 'T-0072' }, { taskId: 'T-0072' }] })
    await expect(api.sendMessage({
      targetRef: remoteRef,
      messageId: randomUUID(),
      text: 'Collaborate without per-task setup',
    })).resolves.toMatchObject({ state: 'delivered' })
    expect(setup.remoteHost.dispatches).toHaveLength(1)
    expect(await readFile(oldPolicyPath, 'utf8')).toBe(oldPolicy)
  })

  it('delivers the 33rd message in the same task without a quota reset', async () => {
    const setup = await setupCollaborationFixture()
    const api = setup.createService().forWorkspace(setup.workspaceRoot)
    const targetRef = formatCollaborationTargetRef('T-0072', setup.localTarget)

    for (let index = 1; index <= 33; index++) {
      const messageId = randomUUID()
      await expect(api.sendMessage({ targetRef, messageId, text: `Collaboration message ${index}` }))
        .resolves.toMatchObject({ state: 'delivered', turnId: messageId })
      setup.localHost.action({ type: 'chat/turnComplete', turnId: messageId, duration: 10 })
      await vi.waitFor(() => expect(setup.localConnection.view.chat?.activeTurn).toBeUndefined(), { interval: 5 })
    }

    expect(setup.localHost.dispatches).toHaveLength(33)
  })

  it('delivers and reads across tasks through the original device gateway', async () => {
    const setup = await setupCollaborationFixture()
    setup.setBindings({
      'T-0072': [{ ...setup.localTarget, provider: 'agent-host' }],
      'T-0073': [{ ...setup.remoteTarget, provider: 'agent-host' }],
    })
    setup.setGatewayAllowedTasks(['T-0073'])
    const service = setup.createService()
    const api = service.forWorkspace(setup.workspaceRoot)
    const { sessions } = await api.listSessions({ taskId: 'T-0072', query: 'Worker-B' })
    expect(sessions).toMatchObject([{ taskId: 'T-0073', location: 'remote' }])
    const remoteRef = sessions[0].targetRef
    const messageId = randomUUID()

    const status = await api.sendMessage({
      targetRef: remoteRef,
      taskId: 'T-0072',
      messageId,
      text: 'Hold v0.2.5 release until regression tests pass.',
    })
    expect(status).toMatchObject({
      messageId,
      taskId: 'T-0073',
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
      taskId: 'T-0073',
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

    const context = await api.readContext({ targetRef: remoteRef, taskId: 'T-0072', limit: 5, detail: 'summary' })
    expect(context.taskId).toBe('T-0073')
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
    setup.remoteHost.action({ type: 'chat/turnComplete', turnId: spoofedTurnId, duration: 1 })
    await vi.waitFor(() => expect(setup.remoteConnection.view.chat?.activeTurn).toBeUndefined())

    // Claiming a task not linked on the owner gateway is rejected before native dispatch without locking the chat as uncertain.
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
    )).rejects.toThrow('No turn was sent. Access to the owner chat changed.')
    expect(setup.remoteConnection.view.state).toBe('connected')
    expect(setup.remoteConnection.view.pendingTurn).toBeUndefined()
    expect(setup.remoteHost.dispatches).toHaveLength(1)
  })

  it('queues behind a busy turn, drains on completion, blocks on human drafts, and pauses safely across restart', async () => {
    const setup = await setupCollaborationFixture()
    const service = setup.createService()
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

  it('pages context and reports a full message queue as temporarily busy until entries expire', async () => {
    const setup = await setupCollaborationFixture()
    setup.localHost.historyText(8, 'Historical output', ['t-1', 't-2', 't-3', 't-4', 't-5', 't-6', 't-7', 't-8'])
    setup.localHost.historyWindow(4, 4)

    const api = setup.createService().forWorkspace(setup.workspaceRoot)
    const localRef = formatCollaborationTargetRef('T-0072', setup.localTarget)

    const recentPage = await api.readContext({ targetRef: localRef, limit: 3, detail: 'summary' })
    expect(recentPage.turns.map((turn) => turn.turnId)).toEqual(['t-6', 't-7', 't-8'])
    expect(recentPage.hasMoreHistory).toBe(true)
    expect(recentPage.nextCursor).toBe('t-6')

    const olderPage = await api.readContext({ targetRef: localRef, cursor: recentPage.nextCursor, limit: 3, detail: 'summary' })
    expect(olderPage.turns.map((turn) => turn.turnId)).toEqual(['t-3', 't-4', 't-5'])

    setup.localHost.action({
      type: 'chat/turnStarted',
      turnId: 'long-running',
      startedAt: '2026-11-16T03:10:00.000Z',
      message: { text: 'Busy', origin: { kind: MessageKind.User } },
    })
    const pending = Array.from({ length: COLLABORATION_LIMITS.maxQueuedPerTask }, (_, index) => ({
      targetRef: localRef, messageId: randomUUID(), text: `Waiting message ${index}`,
    }))
    for (const request of pending) {
      await expect(api.sendMessage(request)).resolves.toMatchObject({ state: 'queued' })
    }
    const overflow = { targetRef: localRef, messageId: randomUUID(), text: 'Retry when the queue has space' }
    await expect(api.sendMessage(overflow)).rejects.toMatchObject({ code: 'BUSY' })
    setup.advanceTime(COLLABORATION_LIMITS.messageTtlMs + 1_000)
    const expiredStatus = await api.messageStatus(pending[0].messageId)
    expect(expiredStatus.state).toBe('expired')
    await expect(api.sendMessage(overflow)).resolves.toMatchObject({ state: 'queued' })
  })

  it('self-heals after cached connection eviction or disconnect without losing context reads or sends', async () => {
    const setup = await setupCollaborationFixture()
    const service = setup.createService()
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
