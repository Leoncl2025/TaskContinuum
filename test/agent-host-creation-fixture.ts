import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { chatReducer } from '@microsoft/agent-host-protocol'
import type { ActionEnvelope, ChatState, CreateSessionParams, ResolveSessionConfigResult, SessionState } from '@microsoft/agent-host-protocol'
import type { AgentHostEndpoint } from '../src/main/agentHostProtocol'
import { AgentHostRegistry } from '../src/main/agentHostRegistry'
import { VSCodeDeviceHost } from '../src/main/vscodeDeviceHost'
import { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'
import { AgentHostCreationClient } from '../src/main/agentHostCreationClient'
import { deviceInvitationSchema } from '../src/main/vscodeDeviceProtocol'
import { deviceRequest } from '../src/main/vscodeDeviceHttp'
import { newSshKeyPair, openSessionSshBridge, startSessionSshHost } from '../src/main/devTunnel/sessionSsh'
import { canonicalPolicyRoot, locallyLinkedAgentHostSessions } from '../src/main/linkedSessionPolicy'
import { agentHostCreationResultSchema, agentHostWorkerCatalogSchema } from '../src/main/agentHostCreationProtocol'
import type { AgentHostCreateRequest } from '../src/shared/agentHostCreation'

export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
}

export function creationFixtureKey(): ReturnType<typeof newSshKeyPair> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try { return newSshKeyPair() } catch { /* ssh2 occasionally emits a noncanonical Ed25519 public key. */ }
  }
  throw new Error('Could not generate a canonical fixture SSH key.')
}

export async function startAgentHostCreationFixture() {
  const server = createServer()
  const sockets = new WebSocketServer({ server })
  const hostId = randomUUID()
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const creations: CreateSessionParams[] = []
  const sessions = new Map<string, { session: SessionState; chat: ChatState }>()
  const subscriptions = new Map<import('ws').WebSocket, Set<string>>()
  let sequence = 1
  let provider = 'copilotcli', protocolVersion = '0.9.0'
  let lifecycle: SessionState['lifecycle'] = 'ready' as SessionState['lifecycle']
  let loseAcknowledgement = false, omitCreatedSession = false
  let prepareWait: ReturnType<typeof deferred> | undefined
  let creationWait: ReturnType<typeof deferred> | undefined
  let sessionReadWait: ReturnType<typeof deferred> | undefined
  let acknowledgement: unknown = null
  let resolveFolderSelection = true
  let config: ResolveSessionConfigResult = { schema: { type: 'object', properties: {
    isolation: { type: 'string', title: 'Isolation', enum: ['folder', 'worktree'] },
    autoApprove: { type: 'string', title: 'Approval', enum: ['default', 'autoApprove'] },
    mode: { type: 'string', title: 'Mode', enum: ['interactive', 'autopilot'] },
  } }, values: { isolation: 'folder', autoApprove: 'default', mode: 'interactive' } }
  let editCreated: ((value: { session: SessionState; chat: ChatState }) => void) | undefined
  sockets.on('connection', (socket) => {
    subscriptions.set(socket, new Set())
    socket.on('close', () => subscriptions.delete(socket))
    socket.on('message', (data) => {
      void (async () => {
        const message = JSON.parse(data.toString())
        calls.push({ method: message.method, params: message.params })
        let result: unknown = {}
        const missing = () => { if (message.id !== undefined && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'The fixture has no such resource.' } })) }
        if (message.method === 'initialize') result = { protocolVersion, serverSeq: sequence, snapshots: [] }
        else if (message.method === 'resolveSessionConfig') {
          await prepareWait?.promise
          const resolved = structuredClone(config)
          if (resolveFolderSelection && message.params.config?.isolation === 'folder') resolved.values.isolation = 'folder'
          result = resolved
        } else if (message.method === 'createSession') {
          const command = structuredClone(message.params) as CreateSessionParams
          if (sessions.has(command.channel)) { missing(); return }
          creations.push(command)
          const chatId = `ahp-chat://default/${Buffer.from(command.channel).toString('base64url')}`
          const chat: ChatState = { resource: chatId, title: 'Created fixture chat', status: 1, modifiedAt: new Date().toISOString(), turns: [] }
          const session: SessionState = { provider: 'copilotcli', title: chat.title, status: 1, lifecycle, activeClients: [], workingDirectories: command.workingDirectories,
            chats: [{ resource: chatId, title: chat.title, status: 1, modifiedAt: chat.modifiedAt }], defaultChat: chatId }
          const created = { session, chat }
          editCreated?.(created)
          if (!omitCreatedSession) sessions.set(command.channel, created)
          await creationWait?.promise
          if (loseAcknowledgement) { socket.terminate(); return }
          result = acknowledgement
        } else if (message.method === 'subscribe') {
          const channel = message.params.channel
          if (channel.startsWith('copilotcli:/')) await sessionReadWait?.promise
          if (channel === 'ahp-root://') result = { snapshot: { resource: channel, fromSeq: sequence, state: { agents: [{ provider, displayName: 'Copilot', description: '', models: [] }], activeSessions: sessions.size } } }
          else if (sessions.has(channel)) result = { snapshot: { resource: channel, fromSeq: sequence, state: structuredClone(sessions.get(channel)!.session) } }
          else {
            const value = [...sessions.values()].find((value) => value.session.chats.some((chat) => chat.resource === channel))
            if (!value) { missing(); return }
            result = { snapshot: { resource: channel, fromSeq: sequence, state: structuredClone(value.chat) } }
          }
          subscriptions.get(socket)?.add(channel)
        } else if (message.method === 'unsubscribe') subscriptions.get(socket)?.delete(message.params.channel)
        else if (message.method === 'dispatchAction') {
          const value = [...sessions.values()].find((value) => value.chat.resource === message.params.channel)
          if (!value) { missing(); return }
          const envelope = { channel: value.chat.resource, serverSeq: ++sequence, origin: undefined, action: message.params.action } as ActionEnvelope
          value.chat = chatReducer(value.chat, envelope.action as Parameters<typeof chatReducer>[1])
          if (message.params.action.type === 'chat/turnStarted') value.session.lifecycle = 'ready' as SessionState['lifecycle']
          for (const [subscriber, channels] of subscriptions) if (channels.has(envelope.channel) && subscriber.readyState === subscriber.OPEN) {
            subscriber.send(JSON.stringify({ jsonrpc: '2.0', method: 'action', params: envelope }))
          }
        } else if (message.method === 'listSessions') {
          result = { items: [...sessions].map(([resource, value]) => ({ resource, ...value.session, createdAt: value.chat.modifiedAt, modifiedAt: value.chat.modifiedAt })) }
        } else if (!['ping', 'shutdown'].includes(message.method)) { missing(); return }
        if (message.id !== undefined && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      })().catch(() => socket.terminate())
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const endpoint: AgentHostEndpoint = { schemaVersion: 2, type: 'standalone', pid: process.pid, instanceId: hostId, connectionToken: randomUUID(), protocolVersion: '0.9.0',
    endpoint: { type: 'tcp', host: '127.0.0.1', port: (server.address() as { port: number }).port } }
  return {
    endpoint, hostId, calls, creations, sessions,
    setProvider: (value: string) => { provider = value },
    setProtocol: (value: string) => { protocolVersion = value },
    setConfig: (value: ResolveSessionConfigResult, honorFolderSelection = false) => { config = value; resolveFolderSelection = honorFolderSelection },
    setLifecycle: (value: 'ready' | 'creating' | 'failed') => { lifecycle = value as SessionState['lifecycle']; for (const entry of sessions.values()) entry.session.lifecycle = lifecycle },
    editCreated: (edit: typeof editCreated) => { editCreated = edit },
    pausePreparation: () => { prepareWait = deferred(); return prepareWait },
    pauseAcknowledgement: () => { creationWait = deferred(); return creationWait },
    pauseSessionRead: () => { sessionReadWait = deferred(); return sessionReadWait },
    setAcknowledgement: (value: unknown) => { acknowledgement = value },
    loseAcknowledgement: (missing = false) => { loseAcknowledgement = true; omitCreatedSession = missing },
    close: async () => {
      prepareWait?.resolve(); creationWait?.resolve(); sessionReadWait?.resolve()
      for (const socket of sockets.clients) socket.terminate()
      sockets.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export async function writeCreationTaskWorkspace(root: string, taskId = 'T-0007'): Promise<void> {
  await mkdir(join(root, '.agentdesk'), { recursive: true })
  await mkdir(join(root, 'tasks', taskId), { recursive: true })
  await writeFile(join(root, '.agentdesk', 'config.json'), JSON.stringify({ schemaVersion: '1.0', workspace: 'Creation fixture', paths: { tasks: 'tasks' } }))
  await writeFile(join(root, 'tasks', taskId, 'task.json'), JSON.stringify({ schemaVersion: '1.0', id: taskId, title: 'Create original Agent Host session', type: 'feature', status: 'ready', priority: 'P1', relations: { level: 'task' } }))
  for (const document of ['RequirementAnalysis.md', 'Plan.md', 'Checklist.md']) await writeFile(join(root, 'tasks', taskId, document), '')
}

export async function createPairedAgentHostCreationFixture() {
  const root = join(process.cwd(), 'artifacts', 'agent-host-creation', randomUUID())
  const workspace = join(root, 'workspace'), profile = join(root, 'profile'), discovery = join(root, 'discovery')
  await mkdir(discovery, { recursive: true })
  await writeCreationTaskWorkspace(workspace)
  const native = await startAgentHostCreationFixture()
  await writeFile(join(discovery, 'host.json'), JSON.stringify(native.endpoint))
  const owner = { clientId: randomUUID(), machineName: hostname() }
  const participant = { clientId: randomUUID(), username: 'Creation tester', machineName: 'Caller-A' }
  const key = creationFixtureKey()
  const protector = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
  let registry: AgentHostRegistry
  let host: VSCodeDeviceHost
  const makeHost = () => {
    registry = new AgentHostRegistry(profile, [discovery], async () => owner)
    host = new VSCodeDeviceHost(profile, protector)
    host.setAgentHostAccess(registry, (folder) => locallyLinkedAgentHostSessions(profile, folder, owner))
  }
  makeHost()
  const pair = await host!.pair(participant, key.publicKey)
  await host!.setWorkspace(pair.id, await canonicalPolicyRoot(workspace), true)
  let port = await host!.start()
  const call = (path: string, body: unknown, token = pair.token) => deviceRequest(port, port, token, path, body, AbortSignal.timeout(10000))
  const workers = () => call('/device/agent-host/workers', { taskId: 'T-0007' }).then((value) => agentHostWorkerCatalogSchema.parse(value))
  const catalog = await workers()
  const request: Omit<AgentHostCreateRequest, 'workerId'> = { operationId: randomUUID(), taskId: 'T-0007', workspaceId: catalog.workspaces[0].id, hostId: native.hostId, expectedRevision: null }
  return {
    root, workspace, profile, discovery, native, owner, participant, key, pair, protector, call, workers, request,
    get host() { return host },
    get registry() { return registry },
    get port() { return port },
    begin: (value = request) => call('/device/agent-host/create', value).then((result) => agentHostCreationResultSchema.parse(result)),
    status: (value = request) => call('/device/agent-host/creation-status', { operationId: value.operationId, workspaceId: value.workspaceId }).then((result) => agentHostCreationResultSchema.parse(result)),
    bind: (revision: string | null, value = request) => call('/device/agent-host/creation-bind', { operationId: value.operationId, workspaceId: value.workspaceId, expectedRevision: revision }).then((result) => agentHostCreationResultSchema.parse(result)),
    restart: async (beforeStart?: () => Promise<void>) => {
      await host.close()
      await registry.close()
      await beforeStart?.()
      makeHost()
      port = await host.start()
    },
    expire: async () => {
      await host.close()
      await registry.close()
      const file = join(profile, 'remote-vscode-device-host.json')
      const stored = JSON.parse(await readFile(file, 'utf8'))
      const data = JSON.parse(Buffer.from(stored.encrypted, 'base64').toString())
      data.pairs[0].expiresAt = new Date(Date.now() - 1000).toISOString()
      await writeFile(file, JSON.stringify({ encrypted: Buffer.from(JSON.stringify(data)).toString('base64') }))
      makeHost()
      port = await host.start()
    },
    close: async () => { await host.close(); await registry.close(); await native.close(); await rm(root, { recursive: true, force: true }) },
  }
}

export async function createAgentHostCreationCallerFixture(worker: Awaited<ReturnType<typeof createPairedAgentHostCreationFixture>>) {
  const workspace = join(worker.root, 'caller-workspace'), profile = join(worker.root, 'caller-profile')
  await writeCreationTaskWorkspace(workspace)
  const ssh = await startSessionSshHost(creationFixtureKey())
  ssh.allow(worker.pair.id, worker.key.publicKey, worker.port, worker.pair.expiresAt, true)
  let connections = 0
  let devices: VSCodeDeviceClient
  let client: AgentHostCreationClient
  const makeClient = () => {
    devices = new VSCodeDeviceClient(profile, worker.protector, (invitation, signal) => {
      connections++
      return openSessionSshBridge(createConnection(ssh.port, '127.0.0.1'), { key: worker.key, hostPublicKey: invitation.devTunnel.hostPublicKey, grantId: invitation.id, targetPort: invitation.port, signal })
    }, async (invitation) => {
      if (JSON.stringify(invitation.participant) !== JSON.stringify(worker.participant) || invitation.devTunnel.clientPublicKey !== worker.key.publicKey) throw new Error('Fixture invitation does not belong to the paired caller.')
    })
    client = new AgentHostCreationClient(profile, devices)
  }
  makeClient()
  try {
    await devices!.import(workspace, deviceInvitationSchema.parse({
      schemaVersion: 2, provider: 'vscode-copilot-device', id: worker.pair.id, ownerId: await worker.host.ownerId(), ownerClientId: worker.owner.clientId,
      machineName: worker.owner.machineName, participant: worker.participant, token: worker.pair.token, expiresAt: worker.pair.expiresAt, port: worker.port,
      devTunnel: { kind: 'dev-tunnel', tunnelId: `taskcontinuum-${'a'.repeat(32)}.jpe1`, sshPort: ssh.port, hostPublicKey: ssh.publicKey, clientPublicKey: worker.key.publicKey },
    }), true)
  } catch (error) { await client!.close(); devices!.close(); await ssh.close(); throw error }
  return {
    workspace, profile,
    get client() { return client },
    get devices() { return devices },
    get connections() { return connections },
    restart: async () => { await client.close(); devices.close(); makeClient() },
    close: async () => { await client.close(); devices.close(); await ssh.close() },
  }
}
