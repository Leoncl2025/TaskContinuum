// @vitest-environment node
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import type { ChatTurnStartedAction } from '@microsoft/agent-host-protocol'
import { describe, expect, it } from 'vitest'
import { connectLocalAgentHost, discoverAgentHosts } from '../src/main/agentHostTransport'
import type { AgentHostEndpoint } from '../src/main/agentHostProtocol'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { startAgentHostFixture } from './agent-host-fixture'

describe('AHP original chat connection', () => {
  it('rejects an older remote gateway rather than letting it discard the explicit model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-ahp-old-gateway-'))
    const host = await startAgentHostFixture({ taskcontinuumCanSend: true })
    const target = { hostId: host.hostId, sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
    const connection = new AgentHostConnection(target, root, (signal) => connectLocalAgentHost(host.endpoint, signal))
    try {
      await expect(connection.models()).rejects.toThrow('Update Task Continuum on the owner device')
      await expect(connection.send(randomUUID(), 'Keep my selection', undefined, async () => {}, undefined, { id: 'gpt-6' })).rejects.toThrow('Update Task Continuum on the owner device')
      expect(host.dispatches).toHaveLength(0)
    } finally { await connection.close(); await host.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('sends an explicit model instead of a stale owner selection and includes it in replay identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-ahp-model-'))
    const host = await startAgentHostFixture()
    const target = { hostId: host.hostId, sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
    const connection = new AgentHostConnection(target, root, (signal) => connectLocalAgentHost(host.endpoint, signal))
    const model = { id: 'gpt-6', config: { reasoningEffort: 'high' } }
    try {
      host.draft('', { model: { id: 'owner-model' }, agent: { uri: 'file:///fixture/plan.agent.md' } })
      expect(await connection.models()).toEqual([{ id: 'owner-model', name: 'Owner model', provider: 'copilotcli' }, { id: 'gpt-6', name: 'GPT-6', provider: 'copilotcli' }])
      for (const id of ['disabled-model', 'private-model', 'missing-model']) {
        await expect(connection.send(randomUUID(), 'Do not silently fall back', undefined, async () => {}, undefined, { id })).rejects.toThrow('no longer available')
      }
      expect(host.dispatches).toHaveLength(0)
      const id = randomUUID()
      await connection.send(id, 'Explicit model', undefined, async () => {}, undefined, model)
      expect(host.dispatches).toEqual([expect.objectContaining({ message: expect.objectContaining({ model, agent: { uri: 'file:///fixture/plan.agent.md' } }) })])
      host.action({ type: 'chat/turnComplete', turnId: id, duration: 1 })
      await expect.poll(() => connection.view.chat?.activeTurn).toBeUndefined()
      await connection.send(id, 'Explicit model', undefined, async () => {}, undefined, model)
      await expect(connection.send(id, 'Explicit model', undefined, async () => {}, undefined, { id: 'owner-model' })).rejects.toThrow('different content')
      expect(host.dispatches).toHaveLength(1)
    } finally { await connection.close(); await host.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('retains and clears native model and agent selections without overwriting an owner draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-ahp-selection-'))
    const host = await startAgentHostFixture()
    const target = { hostId: host.hostId, sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
    const connection = new AgentHostConnection(target, root, (signal) => connectLocalAgentHost(host.endpoint, signal))
    const selection = { model: { id: 'owner-model', config: { reasoningEffort: 'high', contextSize: 128000 } }, agent: { uri: 'file:///fixture/plan.agent.md' } }
    try {
      host.draft('Unsaved owner prompt', selection)
      const original = host.snapshot(host.chatId)
      await connection.open()
      await expect(connection.send(randomUUID(), 'Do not replace the draft', undefined, async () => {})).rejects.toThrow('draft')
      expect(host.snapshot(host.chatId)).toEqual(original)
      expect(host.dispatches).toHaveLength(0)
      host.draft('', selection)
      const id = randomUUID()
      await connection.send(id, 'Use the owner selections', undefined, async () => {})
      expect(host.dispatches).toEqual([expect.objectContaining({ type: 'chat/turnStarted', turnId: id, message: expect.objectContaining({ text: 'Use the owner selections', ...selection }) })])
      host.action({ type: 'chat/turnComplete', turnId: id, duration: 1 })
      await expect.poll(() => connection.view.chat?.activeTurn).toBeUndefined()
      host.draft('')
      await connection.send(randomUUID(), 'Use the owner defaults', undefined, async () => {})
      const reset = host.dispatches[1] as ChatTurnStartedAction
      expect(reset.message.agent).toBeUndefined()
      expect(reset.message.model).toBeUndefined()
      expect(host.dispatches).toHaveLength(2)
    } finally { await connection.close(); await host.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('rechecks live state after authorization awaits and does not overwrite a newly started turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-ahp-race-'))
    const host = await startAgentHostFixture()
    const target = { hostId: host.hostId, sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
    const connection = new AgentHostConnection(target, root, (signal) => connectLocalAgentHost(host.endpoint, signal))
    let checks = 0
    try {
      await expect(connection.send(randomUUID(), 'Must not overlap', undefined, async () => {
        if (++checks !== 2) return
        host.action({ type: 'chat/turnStarted', turnId: 'owner-turn', startedAt: new Date().toISOString(), message: { text: 'Owner request', origin: { kind: 'user' } } })
        await expect.poll(() => connection.view.chat?.activeTurn?.id).toBe('owner-turn')
      })).rejects.toThrow('became busy')
      expect(host.dispatches).toHaveLength(0)
      expect(connection.view.pendingTurn).toBeUndefined()
    } finally { await connection.close(); await host.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('streams, deduplicates, recovers snapshots and refuses a native draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-ahp-client-'))
    const host = await startAgentHostFixture()
    const target = { hostId: host.hostId, sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
    const connection = new AgentHostConnection(target, root, (signal) => connectLocalAgentHost(host.endpoint, signal))
    const unlisten = connection.listen(() => {})
    const id = randomUUID()
    try {
      await connection.open()
      expect(connection.view.canSend).toBe(true)
      await connection.send(id, 'Continue original', undefined, async () => {})
      host.action({ type: 'chat/responsePart', turnId: id, part: { kind: 'markdown', id: 'answer', content: '' } })
      host.action({ type: 'chat/delta', turnId: id, partId: 'answer', content: 'Visible before completion' })
      await expect.poll(() => connection.view.chat?.activeTurn?.responseParts).toContainEqual({ kind: 'markdown', id: 'answer', content: 'Visible before completion' })
      await connection.send(id, 'Continue original', undefined, async () => {})
      expect(host.dispatches).toHaveLength(1)
      host.drop()
      await expect.poll(() => connection.view.state).toBe('offline')
      await connection.open()
      expect(connection.view.chat?.activeTurn?.id).toBe(id)
      expect(host.dispatches).toHaveLength(1)
      host.action({ type: 'chat/turnComplete', turnId: id, duration: 1 })
      await expect.poll(() => connection.view.chat?.activeTurn).toBeUndefined()
      host.draft('Draft in the owner editor')
      await expect(connection.send(randomUUID(), 'Must not overwrite', undefined, async () => {})).rejects.toThrow('draft')
      expect(host.dispatches).toHaveLength(1)
    } finally { unlisten(); await connection.close(); await host.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('persists unknown outcomes and never replays across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-ahp-uncertain-'))
    const host = await startAgentHostFixture()
    const target = { hostId: host.hostId, sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
    const first = new AgentHostConnection(target, root, (signal) => connectLocalAgentHost(host.endpoint, signal))
    const second = new AgentHostConnection(target, root, (signal) => connectLocalAgentHost(host.endpoint, signal))
    const id = randomUUID()
    try {
      host.loseNextSend()
      await expect(first.send(id, 'One attempt', undefined, async () => {})).rejects.toThrow('confirmation')
      await first.close()
      await second.open()
      expect(second.view.pendingTurn).toEqual({ id, state: 'uncertain' })
      await expect(second.send(id, 'One attempt', undefined, async () => {})).rejects.toThrow('not replayed')
      await expect(second.send(randomUUID(), 'Another attempt', undefined, async () => {})).rejects.toThrow('uncertain')
      expect(host.dispatches).toHaveLength(1)
    } finally { await first.close(); await second.close(); await host.close(); await rm(root, { recursive: true, force: true }) }
  })
})

describe('Agent Host endpoints', () => {
  it.skipIf(!process.env.TASKCONTINUUM_VERIFY_AHP_HOST)('reads the selected installed Host model catalog without sending a prompt', async () => {
    const endpoints = await discoverAgentHosts([join(process.env.APPDATA!, 'Code', 'agent-host', 'local-endpoint', 'entries')])
    const endpoint = endpoints.find((item) => item.instanceId === process.env.TASKCONTINUUM_VERIFY_AHP_HOST)
    expect(endpoint).toBeDefined()
    const abort = new AbortController()
    const client = new AhpClient(await connectLocalAgentHost(endpoint!, abort.signal), { requestTimeoutMs: 5000 })
    client.connect()
    try {
      await client.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'] })
      const { result, subscription } = await client.subscribe('ahp-root://')
      try {
        const root = result.snapshot?.state as import('@microsoft/agent-host-protocol').RootState
        process.stdout.write(`${JSON.stringify({ modelPrompts: 0, agents: root.agents.map((agent) => ({ provider: agent.provider, models: agent.models.map(({ id, name, provider, policyState }) => ({ id, name, provider, policyState })) })) })}\n`)
        expect(root.agents.some((agent) => agent.models.length)).toBe(true)
      } finally { await subscription.close() }
    } finally { await client.shutdown(); abort.abort() }
  })

  it.skipIf(process.env.TASKCONTINUUM_VERIFY_AHP_LOCAL !== '1')('initializes an already running installed editor Host without sending a prompt', async () => {
    const endpoints = (await discoverAgentHosts([join(process.env.APPDATA!, 'Code', 'agent-host', 'local-endpoint', 'entries')])).filter((endpoint) => endpoint.type === 'editor')
    expect(endpoints.length).toBeGreaterThan(0)
    let verified = 0
    for (const endpoint of endpoints) {
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), 5000)
      let client: AhpClient | undefined
      try {
        client = new AhpClient(await connectLocalAgentHost(endpoint, abort.signal), { requestTimeoutMs: 3000 })
        client.connect()
        const result = await client.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'] })
        expect(result.protocolVersion).toBe('0.9.0')
        await client.ping()
        verified++
      } catch { continue }
      finally { clearTimeout(timer); abort.abort(); await client?.shutdown() }
    }
    console.log(JSON.stringify({ installedEditorHostsVerified: verified, modelPrompts: 0 }))
    expect(verified).toBeGreaterThan(0)
  }, 60000)

  it.each(['tcp', 'socket'] as const)('uses authenticated %s endpoints without exposing credentials', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'continuum-ahp-transport-'))
    const server = createServer()
    const sockets = new WebSocketServer({ noServer: true })
    const token = randomUUID()
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== `/?tkn=${token}`) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
      sockets.handleUpgrade(request, socket, head, (client) => sockets.emit('connection', client))
    })
    sockets.on('connection', (socket) => socket.on('message', (data) => {
      const message = JSON.parse(data.toString())
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize' ? { protocolVersion: '0.9.0' } : {} }))
    }))
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\continuum-ahp-${randomUUID()}` : join(root, 'host.sock')
    if (kind === 'tcp') server.listen(0, '127.0.0.1')
    else server.listen(pipe)
    await once(server, 'listening')
    const address = server.address()
    const endpoint: AgentHostEndpoint = { schemaVersion: 2, type: 'editor', pid: process.pid, instanceId: randomUUID(), connectionToken: token, protocolVersion: '0.9.0', endpoint: kind === 'tcp' ? { type: 'tcp', host: '127.0.0.1', port: (address as { port: number }).port } : { type: 'socket', path: pipe } }
    let client: AhpClient | undefined
    try {
      await writeFile(join(root, 'host.json'), JSON.stringify(endpoint))
      await writeFile(join(root, 'unsafe.json'), JSON.stringify({ ...endpoint, instanceId: randomUUID(), endpoint: { type: 'tcp', host: 'example.com', port: 80 } }))
      expect(await discoverAgentHosts([root])).toEqual([endpoint])
      await expect(connectLocalAgentHost({ ...endpoint, connectionToken: randomUUID() }, new AbortController().signal)).rejects.toThrow('rejected')
      const abort = new AbortController()
      client = new AhpClient(await connectLocalAgentHost(endpoint, abort.signal))
      client.connect()
      expect((await client.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'] })).protocolVersion).toBe('0.9.0')
      await client.ping()
      abort.abort()
      await expect(client.ping()).rejects.toThrow()
    } finally {
      await client?.shutdown()
      for (const socket of sockets.clients) socket.terminate()
      sockets.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  })
})