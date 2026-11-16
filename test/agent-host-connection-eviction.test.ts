// @vitest-environment node
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { MessageKind } from '@microsoft/agent-host-protocol'
import type { ChatState, RootState, SessionState, Snapshot } from '@microsoft/agent-host-protocol'
import type { AhpTransport } from '@microsoft/agent-host-protocol/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentHostTarget } from '../src/shared/agentHost'
import { agentHostKey } from '../src/shared/agentHost'
import type { AgentHostAuthorization } from '../src/main/agentHostAuthorization'
import { LOCAL_AGENT_HOST_LIMITS, AgentHostRegistry } from '../src/main/agentHostRegistry'
import { REMOTE_AGENT_HOST_LIMITS, AgentHostManager } from '../src/main/agentHostManager'
import { connectAgentHostWebSocket } from '../src/main/agentHostTransport'
import { canonicalPolicyRoot } from '../src/main/linkedSessionPolicy'
import type { VSCodeDeviceClient } from '../src/main/vscodeDeviceClient'

type HostedSession = {
  sessionId: string
  chatId: string
  lifecycle: SessionState['lifecycle']
  turns: ChatState['turns']
  activeTurn?: ChatState['activeTurn']
  draftText?: string
}

async function startMultiSessionHost() {
  const server = createServer()
  const sockets = new WebSocketServer({ server })
  const sessions = new Map<string, HostedSession>()
  const chats = new Map<string, HostedSession>()
  const root: RootState = {
    agents: [{
      provider: 'copilotcli',
      displayName: 'Copilot',
      description: '',
      models: [{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli' }],
    }],
    activeSessions: 0,
  }
  const sequence = 1

  function register(index: number, options?: { lifecycle?: 'creating' | 'ready'; empty?: boolean; activeTurn?: boolean; draftText?: string }): { sessionId: string; chatId: string } {
    const sessionId = `copilotcli:/session-${index}-${randomUUID()}`
    const chatId = `ahp-chat://default/${Buffer.from(sessionId).toString('base64url')}`
    const entry: HostedSession = {
      sessionId,
      chatId,
      lifecycle: (options?.lifecycle ?? 'ready') as SessionState['lifecycle'],
      turns: options?.empty ? [] : [{
        id: `turn-${index}`,
        message: { text: `Prompt ${index}`, origin: { kind: MessageKind.User } },
        state: 'complete',
        responseParts: [{ kind: 'markdown', id: `answer-${index}`, content: `Answer ${index}` }],
        usage: undefined,
      } as ChatState['turns'][number]],
      ...(options?.activeTurn ? {
        activeTurn: {
          id: `running-${index}`,
          startedAt: new Date().toISOString(),
          message: { text: `Running ${index}`, origin: { kind: MessageKind.User } },
          responseParts: [],
          usage: undefined,
          pendingRequests: {},
        } as unknown as NonNullable<ChatState['activeTurn']>,
      } : {}),
      ...(options?.draftText ? { draftText: options.draftText } : {}),
    }
    sessions.set(sessionId, entry)
    chats.set(chatId, entry)
    return { sessionId, chatId }
  }

  function snapshotFor(resource: string): Snapshot {
    if (resource === 'ahp-root://') return { resource, fromSeq: sequence, state: structuredClone(root) }
    const session = sessions.get(resource)
    if (session) {
      const now = new Date().toISOString()
      const state: SessionState = {
        provider: 'copilotcli',
        title: `Session ${session.sessionId}`,
        status: 1,
        lifecycle: session.lifecycle,
        activeClients: [],
        chats: [{ resource: session.chatId, title: `Chat ${session.chatId}`, status: 1, modifiedAt: now }],
        defaultChat: session.chatId,
      }
      return { resource, fromSeq: sequence, state }
    }
    const chat = chats.get(resource)
    if (!chat) throw new Error(`Unknown fixture resource: ${resource}`)
    const state: ChatState = {
      resource: chat.chatId,
      title: `Chat ${chat.chatId}`,
      status: 1,
      modifiedAt: new Date().toISOString(),
      turns: structuredClone(chat.turns),
      ...(chat.activeTurn ? { activeTurn: structuredClone(chat.activeTurn) } : {}),
      ...(chat.draftText ? { draft: { text: chat.draftText, origin: { kind: MessageKind.User } } } : {}),
    }
    return { resource, fromSeq: sequence, state }
  }

  sockets.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { id?: number | string; method: string; params?: { channel?: string } }
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '0.9.0',
            serverSeq: sequence,
            snapshots: [],
            _meta: {
              taskcontinuumCanSend: true,
              taskcontinuumModelSelection: true,
              taskcontinuumModelConfig: true,
              taskcontinuumStreamedSendValidation: true,
            },
          },
        }))
      } else if (message.method === 'ping' || message.method === 'unsubscribe') {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }))
      } else if (message.method === 'subscribe' && message.params?.channel) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { snapshot: snapshotFor(message.params.channel) } }))
      }
    })
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture address.')
  return {
    port: address.port,
    register,
    liveSocketCount: () => sockets.clients.size,
    close: async () => {
      for (const client of sockets.clients) client.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('Agent Host connection pool LRU eviction', () => {
  it('evicts idle remote connections across >32 chats, trims per-owner warm sockets, and preserves disk caches', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-remote-eviction-'))
    const workspace = await mkdtemp(join(tmpdir(), 'continuum-remote-workspace-'))
    const host = await startMultiSessionHost()
    const localOwner = { clientId: randomUUID(), machineName: 'Studio-Local' }
    const owners = Array.from({ length: 5 }, (_, index) => ({ clientId: randomUUID(), machineName: `Runner-${index + 1}` }))
    const targets: AgentHostTarget[] = []
    for (let index = 0; index < 40; index++) {
      const { sessionId, chatId } = host.register(index)
      targets.push({ sessionId, chatId, owner: owners[index % owners.length] })
    }
    const openByOwner = new Map<string, number>()
    const devices = {
      agentHostSessions: async () => ({ sessions: [], warnings: [] }),
      agentHostWorkers: async () => [],
      agentHostTransport: async (_root: string, target: AgentHostTarget, signal: AbortSignal) => {
        const transport = await connectAgentHostWebSocket(`ws://127.0.0.1:${host.port}`, {}, signal)
        openByOwner.set(target.owner.clientId, (openByOwner.get(target.owner.clientId) ?? 0) + 1)
        let counted = true
        const decrement = () => {
          if (!counted) return
          counted = false
          openByOwner.set(target.owner.clientId, (openByOwner.get(target.owner.clientId) ?? 1) - 1)
        }
        signal.addEventListener('abort', decrement, { once: true })
        const wrapped: AhpTransport = {
          send: (message) => transport.send(message),
          recv: () => transport.recv(),
          close: async () => { decrement(); await transport.close() },
        }
        return wrapped
      },
    } as unknown as VSCodeDeviceClient
    const access = {
      acquire: async () => ({ owner: localOwner, targets, localTargets: [], current: () => true }),
      close: () => {},
    } as unknown as AgentHostAuthorization
    const registry = new AgentHostRegistry(directory, [], async () => localOwner)
    const manager = new AgentHostManager(directory, registry, devices, async () => localOwner, undefined, access)
    cleanups.push(async () => {
      await manager.close()
      await host.close()
      await rm(directory, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    })

    // Keep target[0] actively watched while cycling through 39 other remote chats across 5 owners.
    const pinned = await manager.connection(workspace, targets[0])
    const unlistenPinned = pinned.listen(() => {})
    await pinned.open()
    expect(await pinned.models()).toEqual([{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli' }])

    for (let index = 1; index < targets.length; index++) {
      const connection = await manager.connection(workspace, targets[index])
      const release = connection.retain()
      const unlisten = connection.listen(() => {})
      await connection.open()
      expect(await connection.models()).toEqual([{ id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli' }])
      expect(connection.view.chat?.turns[0]?.responseParts[0]).toMatchObject({ content: `Answer ${index}` })
      unlisten()
      release()
    }

    // Pinned target[0] remained live, while idle connections were evicted under the 32 global / 8 per-owner caps.
    expect(pinned.state).toBe('connected')
    await expect.poll(() => host.liveSocketCount()).toBeLessThanOrEqual(REMOTE_AGENT_HOST_LIMITS.maxConnections)
    for (const count of openByOwner.values()) {
      expect(count).toBeLessThanOrEqual(REMOTE_AGENT_HOST_LIMITS.maxConnectionsPerOwner)
    }

    // Target[1] was evicted earlier; its offline .cache.json was flushed and revisiting it reconnects cleanly.
    const revisited = await manager.connection(workspace, targets[1])
    expect(revisited).not.toBe(pinned)
    await revisited.open()
    expect(revisited.view.chat?.turns[0]?.responseParts[0]).toMatchObject({ content: 'Answer 1' })
    unlistenPinned()
  })

  it('protects active watches and uncertain deliveries while allowing unwatched remote-busy fallback eviction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-remote-busy-'))
    const workspace = await mkdtemp(join(tmpdir(), 'continuum-remote-busy-ws-'))
    const host = await startMultiSessionHost()
    const localOwner = { clientId: randomUUID(), machineName: 'Studio-Local' }
    const targets: AgentHostTarget[] = Array.from({ length: REMOTE_AGENT_HOST_LIMITS.maxConnections + 2 }, (_, index) => {
      const { sessionId, chatId } = host.register(index, { activeTurn: true })
      return { sessionId, chatId, owner: { clientId: randomUUID(), machineName: `Worker-${index}` } }
    })
    const devices = {
      agentHostSessions: async () => ({ sessions: [], warnings: [] }),
      agentHostWorkers: async () => [],
      agentHostTransport: async (_root: string, _target: AgentHostTarget, signal: AbortSignal) => connectAgentHostWebSocket(`ws://127.0.0.1:${host.port}`, {}, signal),
    } as unknown as VSCodeDeviceClient
    const access = {
      acquire: async () => ({ owner: localOwner, targets, localTargets: [], current: () => true }),
      close: () => {},
    } as unknown as AgentHostAuthorization
    const registry = new AgentHostRegistry(directory, [], async () => localOwner)
    const manager = new AgentHostManager(directory, registry, devices, async () => localOwner, undefined, access)
    cleanups.push(async () => {
      await manager.close()
      await host.close()
      await rm(directory, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    })

    // Seed target[0] with an uncertain local delivery record so it must never be evicted, even in Tier-2 fallback.
    const scope = createHash('sha256').update(await canonicalPolicyRoot(workspace)).digest('hex')
    const targetZeroHash = createHash('sha256').update(agentHostKey(targets[0])).digest('hex')
    const ledgerDir = join(directory, 'agent-host-remotes', scope, 'agent-host')
    await rm(ledgerDir, { recursive: true, force: true })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(ledgerDir, { recursive: true })
    await writeFile(join(ledgerDir, `${targetZeroHash}.commands.json`), JSON.stringify({
      schemaVersion: 2,
      target: targets[0],
      commands: [{ id: randomUUID(), hash: 'a'.repeat(64), state: 'uncertain' }],
    }))

    const uncertainConnection = await manager.connection(workspace, targets[0])
    await uncertainConnection.open()
    expect(uncertainConnection.hasActiveWork).toBe(true)

    const releases: (() => void)[] = []
    for (let index = 1; index < REMOTE_AGENT_HOST_LIMITS.maxConnections; index++) {
      const connection = await manager.connection(workspace, targets[index])
      await connection.open()
      releases.push(connection.retain())
    }

    // All 32 slots are genuinely non-evictable (1 uncertain delivery + 31 actively retained).
    await expect(manager.connection(workspace, targets[REMOTE_AGENT_HOST_LIMITS.maxConnections])).rejects.toThrow('Remote Agent Host connection limit reached.')

    // Releasing one retainer leaves a remote-busy unwatched chat (activeTurn on remote Host), which Tier-2 safely evicts.
    releases[0]!()
    const next = await manager.connection(workspace, targets[REMOTE_AGENT_HOST_LIMITS.maxConnections])
    await next.open()
    expect(next.state).toBe('connected')
    // Uncertain local delivery on target[0] remained protected in the pool.
    expect(await manager.connection(workspace, targets[0])).toBe(uncertainConnection)
    for (const release of releases) release()
  })

  it('evicts completed idle local connections beyond 64 while protecting native empty sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-local-eviction-'))
    const discoveryDir = await mkdtemp(join(tmpdir(), 'continuum-local-discovery-'))
    const host = await startMultiSessionHost()
    const localOwner = { clientId: randomUUID(), machineName: 'Local-Owner' }
    await writeFile(join(discoveryDir, 'host.json'), JSON.stringify({
      schemaVersion: 2,
      type: 'standalone',
      pid: process.pid,
      instanceId: randomUUID(),
      connectionToken: 'test-only-local-connection-token',
      protocolVersion: '0.9.0',
      endpoint: { type: 'tcp', host: '127.0.0.1', port: host.port },
    }))
    const registry = new AgentHostRegistry(directory, [discoveryDir], async () => localOwner)
    cleanups.push(async () => {
      await registry.close()
      await host.close()
      await rm(directory, { recursive: true, force: true })
      await rm(discoveryDir, { recursive: true, force: true })
    })

    // Session 0 is an unprompted native draft (lifecycle === 'creating', empty turns): must stay subscribed so VS Code does not GC it.
    const emptyDraft = host.register(0, { lifecycle: 'creating', empty: true })
    const draftTarget: AgentHostTarget = { ...emptyDraft, owner: localOwner }
    const draftConnection = await registry.connection(draftTarget)
    await draftConnection.open()

    // Open 65 completed local sessions sequentially; idle completed ones are evicted while draftConnection stays connected.
    let firstCompletedTarget!: AgentHostTarget
    for (let index = 1; index <= LOCAL_AGENT_HOST_LIMITS.maxConnections + 1; index++) {
      const target: AgentHostTarget = { ...host.register(index), owner: localOwner }
      if (index === 1) firstCompletedTarget = target
      const connection = await registry.connection(target)
      await connection.open()
      expect(connection.state).toBe('connected')
    }

    expect(draftConnection.state).toBe('connected')
    expect(await registry.connection(draftTarget)).toBe(draftConnection)

    // Session 1 was cleanly evicted and wrote its offline cache to disk.
    const cacheHash = createHash('sha256').update(agentHostKey(firstCompletedTarget)).digest('hex')
    const cached = JSON.parse(await readFile(join(directory, 'agent-host', `${cacheHash}.cache.json`), 'utf8')) as { target: AgentHostTarget }
    expect(cached.target).toEqual(firstCompletedTarget)
  })
})
