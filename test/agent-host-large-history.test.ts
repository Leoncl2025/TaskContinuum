// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import WebSocket, { WebSocketServer } from 'ws'
import { expect, it, vi } from 'vitest'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { AgentHostRegistry } from '../src/main/agentHostRegistry'
import { attachAgentHostGateway } from '../src/main/agentHostGateway'
import type { AgentHostGatewayOptions } from '../src/main/agentHostGateway'
import { AGENT_HOST_LIMITS, AgentHostSizeLimitError, agentHostSizeLimit } from '../src/main/agentHostLimits'
import { agentHostKey } from '../src/shared/agentHost'
import { connectAgentHostWebSocket, connectLocalAgentHost } from '../src/main/agentHostTransport'
import { startAgentHostFixture } from './agent-host-fixture'

const originalSnapshotBytes = 42_045_143

it('receives and caches the complete 42,045,143-byte original chat without creating or replaying a turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-large-history-'))
  const host = await startAgentHostFixture(undefined, '1.0.0')
  const target = { sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
  const connection = new AgentHostConnection(target, directory, (signal) => connectLocalAgentHost(host.endpoint, signal))
  let offline: AgentHostConnection | undefined
  try {
    expect(host.historyBytes(originalSnapshotBytes)).toBe(originalSnapshotBytes)
    const expected = createHash('sha256').update(JSON.stringify(host.snapshot(host.chatId).state)).digest('hex')
    await connection.open()
    const restored = connection.view.chat!
    expect(connection.state).toBe('connected')
    expect(restored.turns).toHaveLength(32)
    expect(restored.turns[0].id).toBe('large-history-0')
    expect(restored.turns.at(-1)?.id).toBe('large-history-31')
    expect(createHash('sha256').update(JSON.stringify(restored)).digest('hex')).toBe(expected)
    await connection.close()
    const cache = (await readdir(join(directory, 'agent-host'))).find((name) => name.endsWith('.cache.json'))
    expect(cache).toBeDefined()
    expect((await stat(join(directory, 'agent-host', cache!))).size).toBeGreaterThan(40 * 1024 * 1024)
    offline = new AgentHostConnection(target, directory, async () => { throw new Error('Fixture offline.') })
    await expect(offline.open()).rejects.toThrow('Fixture offline.')
    expect(offline.view.chat?.turns).toHaveLength(32)
    expect(createHash('sha256').update(JSON.stringify(offline.view.chat)).digest('hex')).toBe(expected)
    expect(host.dispatches).toEqual([])
    expect(host.methods).not.toContain('createSession')
    expect(host.methods).not.toContain('dispatchAction')
  } finally {
    await offline?.close()
    await connection.close()
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

async function responseFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-response-budget-'))
  const host = await startAgentHostFixture(undefined, '1.0.0')
  const target = { sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
  const connection = new AgentHostConnection(target, directory, (signal) => connectLocalAgentHost(host.endpoint, signal))
  const server = createServer()
  let port = 0
  const clients: AhpClient[] = []
  const gateway = attachAgentHostGateway(server, {
    port: () => port, connection: async () => connection,
    authorize: async (_token, selected, send) => {
      if (send || agentHostKey(selected) !== agentHostKey(target)) throw new Error('Access denied.')
      return { canSend: false, actor: target.owner }
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing gateway port.')
  port = address.port
  return {
    host, connection,
    client: async () => {
      const url = `ws://127.0.0.1:${port}/device/agent-host?target=${Buffer.from(JSON.stringify(target)).toString('base64url')}`
      const client = new AhpClient(await connectAgentHostWebSocket(url, {}, new AbortController().signal))
      clients.push(client)
      client.connect()
      await client.initialize({ clientId: randomUUID(), protocolVersions: ['1.0.0'] })
      return client
    },
    close: async () => {
      await Promise.all(clients.map((client) => client.shutdown()))
      gateway.close()
      await connection.close()
      await host.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

it('bounds gateway response writes globally and releases capacity after completion', async () => {
  const f = await responseFixture()
  const completions: (() => void)[] = []
  const pending: Promise<unknown>[] = []
  let restore: (() => void) | undefined
  try {
    f.host.historyBytes(originalSnapshotBytes)
    await f.connection.open()
    const clients = await Promise.all(Array.from({ length: 4 }, () => f.client()))
    const originalSend = WebSocket.prototype.send
    const send = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, ...args: Parameters<WebSocket['send']>) {
      if (typeof args[0] === 'string' && Buffer.byteLength(args[0]) > 40 * 1024 * 1024) {
        const complete = args.at(-1)
        if (typeof complete !== 'function') throw new Error('Missing bounded-write callback.')
        completions.push(() => complete())
        return
      }
      Reflect.apply(originalSend, this, args)
    })
    restore = () => send.mockRestore()
    for (const [index, client] of clients.slice(0, 3).entries()) {
      pending.push(client.request('subscribe', { channel: f.host.chatId }).catch((error: unknown) => error))
      await expect.poll(() => completions.length).toBe(index + 1)
    }
    const failure = await clients[3].request('subscribe', { channel: f.host.chatId }).catch((error: unknown) => error)
    expect(agentHostSizeLimit(failure)).toMatchObject({ kind: 'send-buffer', limitBytes: AGENT_HOST_LIMITS.responseBufferGlobalBytes })
    expect(completions).toHaveLength(3)
    for (const complete of completions.splice(0)) complete()
    restore()
    const recovered = await f.client()
    const result = await recovered.request('subscribe', { channel: f.host.chatId })
    expect(result.snapshot?.resource).toBe(f.host.chatId)
    expect(f.host.dispatches).toEqual([])
  } finally {
    restore?.()
    for (const complete of completions.splice(0)) complete()
    await f.close()
    await Promise.all(pending)
  }
}, 30000)

it('returns a typed RPC size error when a later chat snapshot grows beyond the gateway response limit', async () => {
  const f = await responseFixture()
  try {
    const client = await f.client()
    f.host.historyBytes(AGENT_HOST_LIMITS.messageBytes + 1000)
    const original = f.connection.snapshot.bind(f.connection)
    vi.spyOn(f.connection, 'snapshot').mockImplementation((resource) => resource === f.host.chatId ? f.host.snapshot(resource) : original(resource))
    const failure = await client.request('subscribe', { channel: f.host.chatId }).catch((error: unknown) => error)
    expect(agentHostSizeLimit(failure)).toMatchObject({ kind: 'message', limitBytes: AGENT_HOST_LIMITS.messageBytes })
    await client.ping()
    expect(f.host.dispatches).toEqual([])
  } finally { await f.close() }
}, 30000)

it('locates the original large chat and restores it through the read-only gateway with later events and reconnect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-large-gateway-'))
  const host = await startAgentHostFixture(undefined, '1.0.0')
  const owner = { clientId: randomUUID(), machineName: 'Owner-B' }
  const target = { sessionId: host.sessionId, chatId: host.chatId, owner }
  const discovery = join(directory, 'discovery')
  await mkdir(discovery)
  await writeFile(join(discovery, 'host.json'), JSON.stringify(host.endpoint))
  const registry = new AgentHostRegistry(join(directory, 'owner'), [discovery], async () => owner)
  const server = createServer()
  let port = 0
  let allowed = true
  const authorize = vi.fn<AgentHostGatewayOptions['authorize']>(async (_token, selected, send) => {
    if (!allowed || send || agentHostKey(selected) !== agentHostKey(target)) throw new Error('Access denied.')
    return { canSend: false, actor: owner }
  })
  const gateway = attachAgentHostGateway(server, { port: () => port, authorize, connection: (selected) => registry.connection(selected) })
  let remote: AgentHostConnection | undefined
  try {
    host.historyBytes(originalSnapshotBytes)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture gateway port.')
    port = address.port
    const url = `ws://127.0.0.1:${port}/device/agent-host?target=${Buffer.from(JSON.stringify(target)).toString('base64url')}`
    remote = new AgentHostConnection(target, join(directory, 'caller'), (signal) => connectAgentHostWebSocket(url, {}, signal))
    await remote.open()
    expect(remote.view).toMatchObject({ target, state: 'connected', canSend: false, readOnly: true, protocolVersion: '1.0.0' })
    expect(remote.view.chat?.turns).toHaveLength(32)
    expect(createHash('sha256').update(JSON.stringify(remote.view.chat)).digest('hex'))
      .toBe(createHash('sha256').update(JSON.stringify(host.snapshot(host.chatId).state)).digest('hex'))
    expect(await remote.models()).toContainEqual(expect.objectContaining({ id: 'gpt-6' }))
    const ownerTurn = randomUUID()
    host.action({ type: 'chat/turnStarted', turnId: ownerTurn, startedAt: new Date().toISOString(), message: { text: 'Owner-originated fixture turn', origin: { kind: 'user' } } })
    await expect.poll(() => remote!.view.chat?.activeTurn?.id).toBe(ownerTurn)
    host.action({ type: 'chat/turnComplete', turnId: ownerTurn, duration: 1 })
    await expect.poll(() => remote!.view.chat?.turns.length).toBe(33)
    await remote.close()
    remote = new AgentHostConnection(target, join(directory, 'caller'), (signal) => connectAgentHostWebSocket(url, {}, signal))
    await remote.open()
    expect(remote.view.chat?.turns).toHaveLength(33)
    expect(remote.view.chat?.turns[0].id).toBe('large-history-0')
    expect(remote.view.chat?.turns.at(-1)?.id).toBe(ownerTurn)
    allowed = false
    gateway.revalidate()
    await expect.poll(() => remote!.state).toBe('offline')
    expect(authorize).toHaveBeenCalled()
    expect(host.dispatches).toEqual([])
    expect(host.methods).not.toContain('createSession')
  } finally {
    await remote?.close()
    gateway.close()
    await registry.close()
    await host.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

async function rawTransport() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: AGENT_HOST_LIMITS.requestBytes })
  await once(server, 'listening')
  const connected = new Promise<WebSocket>((resolve) => server.once('connection', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port.')
  const transport = await connectAgentHostWebSocket(`ws://127.0.0.1:${address.port}`, {}, new AbortController().signal)
  const socket = await connected
  const close = async () => {
    await transport.close()
    for (const peer of server.clients) peer.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return { transport, socket, close }
}

it.each([AGENT_HOST_LIMITS.messageBytes, AGENT_HOST_LIMITS.messageBytes + 1])('enforces the real WebSocket message boundary at %i bytes', async (bytes) => {
  const f = await rawTransport()
  try {
    const receiving = f.transport.recv()
    const checked = bytes > AGENT_HOST_LIMITS.messageBytes
      ? expect(receiving).rejects.toMatchObject({ name: 'AgentHostSizeLimitError', kind: 'message', limitBytes: AGENT_HOST_LIMITS.messageBytes })
      : expect(receiving.then((frame) => frame?.kind === 'text' ? Buffer.byteLength(frame.text) : -1)).resolves.toBe(bytes)
    f.socket.send(Buffer.alloc(bytes, 'x'), { binary: false }, () => {})
    await checked
  } finally { await f.close() }
}, 20000)

it('bounds unread history backlog instead of allowing unlimited large frames', async () => {
  const f = await rawTransport()
  try {
    const frame = Buffer.alloc(originalSnapshotBytes, 'x')
    await new Promise<void>((resolve, reject) => f.socket.send(frame, { binary: false }, (error) => error ? reject(error) : resolve()))
    await new Promise<void>((resolve, reject) => f.socket.send(frame, { binary: false }, (error) => error ? reject(error) : resolve()))
    await expect.poll(() => f.socket.readyState).toBe(WebSocket.CLOSED)
    await expect(f.transport.recv()).rejects.toMatchObject({
      kind: 'receive-buffer', limitBytes: AGENT_HOST_LIMITS.receiveBufferBytes, actualBytes: originalSnapshotBytes * 2,
    })
  } finally { await f.close() }
}, 20000)

it('retains the small outgoing request and receive message-count caps', async () => {
  const f = await rawTransport()
  try {
    expect(() => f.transport.send('x'.repeat(AGENT_HOST_LIMITS.requestBytes + 1))).toThrow('16 MiB')
    for (let index = 0; index <= AGENT_HOST_LIMITS.receiveBufferMessages; index++) f.socket.send('{"notification":true}')
    await expect.poll(() => f.socket.readyState).toBe(WebSocket.CLOSED)
    await expect(f.transport.recv()).rejects.toThrow('1024 messages')
  } finally { await f.close() }
})

it('reports cache limits explicitly without reading or replacing an oversized offline file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-cache-limit-'))
  const target = { sessionId: 'copilotcli:/original', chatId: 'ahp-chat:/original', owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
  const file = join(directory, 'agent-host', `${createHash('sha256').update(agentHostKey(target)).digest('hex')}.cache.json`)
  await mkdir(join(directory, 'agent-host'))
  const handle = await open(file, 'wx')
  await handle.truncate(AGENT_HOST_LIMITS.cacheBytes + 1)
  await handle.close()
  const connection = new AgentHostConnection(target, directory, async () => { throw new Error('Owner offline.') })
  try {
    await expect(connection.open()).rejects.toThrow('Owner offline.')
    expect(connection.view.error).toContain('Offline chat history')
    expect(connection.view.error).toContain(String(AGENT_HOST_LIMITS.cacheBytes))
    expect(connection.view.chat).toBeUndefined()
    expect((await stat(file)).size).toBe(AGENT_HOST_LIMITS.cacheBytes + 1)
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }) }
})

it('reports an oversized cache write and keeps the previous complete cache instead of silently skipping it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-cache-write-limit-'))
  const host = await startAgentHostFixture(undefined, '1.0.0')
  const target = { sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
  const file = join(directory, 'agent-host', `${createHash('sha256').update(agentHostKey(target)).digest('hex')}.cache.json`)
  host.historyText(3, 'Previous cached history')
  const previous = JSON.stringify({ schemaVersion: 2, target, chat: host.snapshot(host.chatId) })
  await mkdir(join(directory, 'agent-host'))
  await writeFile(file, previous)
  const connection = new AgentHostConnection(target, directory, (signal) => connectLocalAgentHost(host.endpoint, signal))
  let closed = false
  try {
    await connection.open()
    const turnId = randomUUID()
    host.action({ type: 'chat/turnStarted', turnId, startedAt: new Date().toISOString(), message: { text: 'Owner fixture turn', origin: { kind: 'user' } } })
    host.action({ type: 'chat/responsePart', turnId, part: { id: 'large', kind: 'markdown', content: 'x'.repeat(33 * 1024 * 1024) } })
    host.action({ type: 'chat/delta', turnId, partId: 'large', content: 'x'.repeat(33 * 1024 * 1024) })
    await expect.poll(() => {
      const part = connection.view.chat?.activeTurn?.responseParts[0]
      return part?.kind === 'markdown' ? part.content.length : 0
    }).toBe(66 * 1024 * 1024)
    closed = true
    await expect(connection.close()).rejects.toMatchObject({ name: 'AgentHostSizeLimitError', kind: 'cache', limitBytes: AGENT_HOST_LIMITS.cacheBytes })
    expect(await readFile(file, 'utf8')).toBe(previous)
    expect(host.dispatches).toEqual([])
    expect((await readdir(join(directory, 'agent-host'))).some((name) => name.endsWith('.tmp'))).toBe(false)
  } finally {
    if (!closed) await connection.close()
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

it('retains last verified offline history when a later reconnect exceeds the message limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-retained-history-'))
  const host = await startAgentHostFixture(undefined, '1.0.0')
  const target = { sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
  const connection = new AgentHostConnection(target, directory, (signal) => connectLocalAgentHost(host.endpoint, signal))
  try {
    host.historyText(3, 'Previously verified offline history')
    await connection.open()
    const before = connection.view.chat
    host.drop()
    await expect.poll(() => connection.state).toBe('offline')
    host.historyBytes(AGENT_HOST_LIMITS.messageBytes + 1)
    const failure = await connection.open().catch((error: unknown) => error)
    expect(agentHostSizeLimit(failure)).toMatchObject({ kind: 'message' })
    expect(connection.view.chat).toEqual(before)
    expect(connection.view.error).toContain('64 MiB')
    expect(connection.view.canSend).toBe(false)
    expect(host.dispatches).toEqual([])
  } finally { await connection.close(); await host.close(); await rm(directory, { recursive: true, force: true }) }
}, 20000)

it('preserves a native size failure across owner lookup and authorized HTTP upgrade without leaking to revoked callers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-history-error-'))
  const host = await startAgentHostFixture(undefined, '1.0.0')
  const discovery = join(directory, 'discovery')
  const owner = { clientId: randomUUID(), machineName: 'Owner-B' }
  const target = { sessionId: host.sessionId, chatId: host.chatId, owner }
  await mkdir(discovery)
  await writeFile(join(discovery, 'host.json'), JSON.stringify(host.endpoint))
  const registry = new AgentHostRegistry(join(directory, 'profile'), [discovery], async () => owner)
  const server = createServer()
  let port = 0
  let allowed = true
  let revokeAfterRead = false
  const authorize = vi.fn(async () => {
    if (!allowed) throw new Error('Private permission details.')
    return { canSend: false, actor: owner }
  })
  const native = await registry.connection(target)
  const nativeOpen = native.open.bind(native)
  vi.spyOn(native, 'open').mockImplementation(async () => {
    try { await nativeOpen() } finally { if (revokeAfterRead) allowed = false }
  })
  const gateway = attachAgentHostGateway(server, { port: () => port, authorize, connection: async () => native })
  let remote: AgentHostConnection | undefined
  const notify = vi.fn()
  try {
    host.historyBytes(AGENT_HOST_LIMITS.messageBytes + 1)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture gateway port.')
    port = address.port
    const url = `ws://127.0.0.1:${port}/device/agent-host?target=${Buffer.from(JSON.stringify(target)).toString('base64url')}`
    remote = new AgentHostConnection(target, join(directory, 'caller'), (signal) => connectAgentHostWebSocket(url, {}, signal))
    const unlisten = remote.listen(notify)
    await expect(remote.open()).rejects.toMatchObject({ kind: 'message', limitBytes: AGENT_HOST_LIMITS.messageBytes })
    expect(native.sizeLimitError).toBeInstanceOf(AgentHostSizeLimitError)
    expect(remote.view.error).toContain('64 MiB')
    expect(remote.view.error).not.toContain('no longer authorized')
    const attempts = host.initializations.length
    await new Promise<void>((resolve) => setTimeout(resolve, 1100))
    expect(host.initializations).toHaveLength(attempts)
    unlisten()
    revokeAfterRead = true
    await expect(connectAgentHostWebSocket(url, {}, new AbortController().signal)).rejects.toThrow('access was rejected')
    expect(host.methods).not.toContain('createSession')
    expect(host.dispatches).toEqual([])
  } finally {
    await remote?.close()
    gateway.close()
    await registry.close()
    await host.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
