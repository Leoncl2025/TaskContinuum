// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatState } from '@microsoft/agent-host-protocol'
import type { AhpTransport, JsonRpcMessage } from '@microsoft/agent-host-protocol/client'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { expect, it, vi } from 'vitest'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { attachAgentHostGateway } from '../src/main/agentHostGateway'
import type { SnapshotTransferLimits } from '../src/main/agentHostSnapshotTransfer'
import { AgentHostSnapshotStore, SNAPSHOT_TRANSFER_METHODS } from '../src/main/agentHostSnapshotTransfer'
import { connectAgentHostWebSocket as connectPagedAgentHostWebSocket, connectLocalAgentHost } from '../src/main/agentHostTransport'
import { agentHostKey } from '../src/shared/agentHost'
import type { AgentHostHistoryTransfer } from '../src/shared/agentHost'
import { startAgentHostFixture } from './agent-host-fixture'
import { AgentHostChatState, CHAT_HISTORY_PAGE_LIMITS } from '../src/main/agentHostState'

// Keep byte-range regressions exercising a gateway without the newer paging capability.
async function connectAgentHostWebSocket(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<AhpTransport> {
  const inner = await connectPagedAgentHostWebSocket(url, headers, signal)
  return {
    send: (message) => inner.send(message),
    recv: async () => {
      const frame = await inner.recv()
      if (frame?.kind !== 'text') return frame
      const message = JSON.parse(frame.text) as { result?: { _meta?: Record<string, unknown> } }
      if (!message.result?._meta?.taskcontinuumPagedChatHistory) return frame
      delete message.result._meta.taskcontinuumPagedChatHistory
      return { ...frame, text: JSON.stringify(message) }
    },
    close: () => inner.close(),
  }
}

it('transfers the newest bounded window first and downloads older turns only on explicit demand', async () => {
  const f = await startChunkedGatewayFixture({ inlineBytes: 64 * 1024, minChunkBytes: 16 * 1024, initialChunkBytes: 16 * 1024, maxChunkBytes: 64 * 1024 }, true)
  let remote: AgentHostConnection | undefined
  let bytesReceived = 0
  const requests: string[] = []
  try {
    f.host.historyBytes(8 * 1024 * 1024)
    const expected = historyDigest(f.host.snapshot(f.host.chatId).state as ChatState)
    remote = new AgentHostConnection(f.target, f.callerDirectory, async (signal) => {
      const inner = await connectPagedAgentHostWebSocket(f.url, {}, signal)
      return {
        send: (message) => {
          const parsed = (typeof message === 'string' ? JSON.parse(message) : message) as { method?: string }
          if (parsed.method) requests.push(parsed.method)
          return inner.send(message)
        },
        recv: async () => {
          const frame = await inner.recv()
          if (frame?.kind === 'text') bytesReceived += Buffer.byteLength(frame.text)
          return frame
        },
        close: () => inner.close(),
      }
    })
    await remote.open()
    expect(remote.view.chat?.turns).toHaveLength(20)
    expect(remote.view.chat?.turns[0].id).toBe('large-history-12')
    expect(remote.view.history).toMatchObject({ hasMore: true, loadedTurns: 20, totalTurns: 32, loading: false })
    expect(remote.view.canSend).toBe(true)
    expect(bytesReceived).toBeLessThan(64 * 1024)
    expect(requests.filter((method) => method === SNAPSHOT_TRANSFER_METHODS.prepare)).toHaveLength(1)
    await remote.models()
    expect(requests.filter((method) => method === SNAPSHOT_TRANSFER_METHODS.prepare)).toHaveLength(1)

    await Promise.all([remote.loadHistory(), remote.loadHistory()])
    expect(remote.view.chat?.turns).toHaveLength(31)
    expect(remote.view.chat?.turns[0].id).toBe('large-history-1')
    expect(requests.filter((method) => method === SNAPSHOT_TRANSFER_METHODS.prepare)).toHaveLength(2)
    expect(bytesReceived).toBeLessThan(128 * 1024)
    await remote.loadHistory()
    expect(historyDigest(remote.view.chat!)).toBe(expected)
    expect(remote.view.history).toMatchObject({ hasMore: false, loadedTurns: 32, totalTurns: 32, loading: false })
    expect(bytesReceived).toBeGreaterThan(8 * 1024 * 1024)
    expect(f.host.dispatches).toEqual([])
  } finally {
    await remote?.close()
    await f.close()
  }
})

it('respects the completed-turn page budget without truncating oversized turns or dropping live send state', async () => {
  const f = await startChunkedGatewayFixture()
  try {
    f.host.historyText(50, 'r'.repeat(64 * 1024))
    f.host.draft('Keep this owner draft')
    f.host.action({ type: 'chat/turnStarted', turnId: randomUUID(), startedAt: new Date().toISOString(), message: { text: 'Current work', origin: { kind: 'user' } } })
    const source = new AgentHostChatState(f.target.chatId)
    source.snapshot(f.host.snapshot(f.target.chatId))
    const page = source.historySnapshot()
    const state = page.snapshot.state as ChatState
    expect(state.turns.length).toBeGreaterThan(0)
    expect(state.turns.length).toBeLessThanOrEqual(CHAT_HISTORY_PAGE_LIMITS.turns)
    expect(state.turns.reduce((bytes, turn) => bytes + Buffer.byteLength(JSON.stringify(turn)), 0)).toBeLessThanOrEqual(CHAT_HISTORY_PAGE_LIMITS.bytes)
    expect(state.activeTurn).toEqual((f.host.snapshot(f.target.chatId).state as ChatState).activeTurn)
    expect(state.draft?.text).toBe('Keep this owner draft')
    const displayed = new AgentHostChatState(f.target.chatId)
    displayed.snapshot(page.snapshot)
    const older = source.historySnapshot(page.beforeTurnId)
    const sequence = displayed.lastSequence
    displayed.prependHistory(older.snapshot, page.beforeTurnId!)
    expect(displayed.lastSequence).toBe(sequence)
    expect(displayed.sendState).toEqual(source.sendState)

    f.host.historyText(1, 'z'.repeat(700 * 1024))
    const oversized = new AgentHostChatState(f.target.chatId)
    oversized.snapshot(f.host.snapshot(f.target.chatId))
    expect(historyDigest(oversized.historySnapshot().snapshot.state as ChatState)).toBe(historyDigest(oversized.value!))
  } finally {
    await f.close()
  }
})

it.each(['native', 'remote'] as const)('honors native AHP cursors and fetchTurns while paging a %s view', async (mode) => {
  const f = await startChunkedGatewayFixture()
  let remote: AgentHostConnection | undefined
  try {
    f.host.historyText(20, 'Native retained history')
    f.host.historyWindow(3, 5)
    const connection = mode === 'native' ? f.native : remote = new AgentHostConnection(f.target, f.callerDirectory, (signal) => connectPagedAgentHostWebSocket(f.url, {}, signal))
    await connection.open()
    expect(connection.view.chat?.turns).toHaveLength(3)
    expect(connection.view.history).toMatchObject({ hasMore: true, loadedTurns: 3 })
    expect(connection.view.history?.totalTurns).toBeUndefined()
    await connection.loadHistory()
    expect(connection.view.chat?.turns).toHaveLength(8)
    expect(f.host.methods.filter((method) => method === 'fetchTurns')).toHaveLength(1)
    while (connection.view.history?.hasMore) await connection.loadHistory()
    expect(connection.view.chat?.turns).toHaveLength(20)
    expect(new Set(connection.view.chat?.turns.map((turn) => turn.id)).size).toBe(20)
    expect(f.host.dispatches).toEqual([])
  } finally {
    await remote?.close()
    await f.close()
  }
})

it('loads immutable earlier turns without replaying the live response or losing completed-turn counts', async () => {
  const f = await startChunkedGatewayFixture({ minChunkBytes: 8 * 1024, initialChunkBytes: 8 * 1024, maxChunkBytes: 16 * 1024 })
  let remote: AgentHostConnection | undefined
  let hold = false
  let completeTurn = false
  let release!: () => void
  let blocked!: () => void
  const block = new Promise<void>((resolve) => { blocked = resolve })
  const liveTurn = randomUUID()
  try {
    f.host.historyText(50, 'r'.repeat(64 * 1024))
    remote = new AgentHostConnection(f.target, f.callerDirectory, async (signal) => {
      const inner = await connectPagedAgentHostWebSocket(f.url, {}, signal)
      return {
        send: (message) => {
          const parsed = (typeof message === 'string' ? JSON.parse(message) : message) as { method?: string; params?: { offset?: number } }
          if (completeTurn && parsed.method === SNAPSHOT_TRANSFER_METHODS.chunk && (parsed.params?.offset ?? 0) >= 16 * 1024) {
            completeTurn = false
            f.host.action({ type: 'chat/turnComplete', turnId: liveTurn, duration: 1 })
          }
          return inner.send(message)
        },
        recv: async () => {
          const frame = await inner.recv()
          if (hold && frame?.kind === 'text' && frame.text.includes('"nextOffset"')) {
            hold = false
            blocked()
            await new Promise<void>((resolve) => { release = resolve })
          }
          return frame
        },
        close: () => { release?.(); return inner.close() },
      }
    })
    await remote.open()
    expect(remote.view.chat?.turns[0].id).toBe('history-43')
    hold = true
    const loading = remote.loadHistory()
    await block
    f.host.action({ type: 'chat/turnStarted', turnId: liveTurn, startedAt: new Date().toISOString(), message: { text: 'Newest question', origin: { kind: 'user' } } })
    f.host.action({ type: 'chat/responsePart', turnId: liveTurn, part: { kind: 'markdown', id: 'live-answer', content: '' } })
    f.host.action({ type: 'chat/delta', turnId: liveTurn, partId: 'live-answer', content: 'Newest response' })
    completeTurn = true
    release()
    await loading
    const chat = remote.view.chat!
    expect(chat.turns.find((turn) => turn.id === 'history-42')?.responseParts).toContainEqual({ kind: 'markdown', id: 'answer-42', content: 'r'.repeat(64 * 1024) })
    expect(chat.turns.filter((turn) => turn.id === liveTurn)).toHaveLength(1)
    expect(chat.turns.at(-1)?.responseParts).toContainEqual({ kind: 'markdown', id: 'live-answer', content: 'Newest response' })
    expect(remote.view.history?.totalTurns).toBe(51)
    expect(remote.view.history?.loading).toBe(false)
  } finally {
    release?.()
    await remote?.close()
    await f.close()
  }
})

it('retains already downloaded earlier pages across reconnect without downloading them again', async () => {
  const f = await startChunkedGatewayFixture()
  let remote: AgentHostConnection | undefined
  let prepares = 0
  const transport = async (signal: AbortSignal) => {
    const inner = await connectPagedAgentHostWebSocket(f.url, {}, signal)
    return {
      send: (message: JsonRpcMessage | string) => {
        const parsed = (typeof message === 'string' ? JSON.parse(message) : message) as { method?: string }
        if (parsed.method === SNAPSHOT_TRANSFER_METHODS.prepare) prepares++
        return inner.send(message)
      },
      recv: () => inner.recv(), close: () => inner.close(),
    }
  }
  try {
    f.host.historyText(60, 'Cached earlier page')
    remote = new AgentHostConnection(f.target, f.callerDirectory, transport)
    await remote.open()
    await remote.loadHistory()
    expect(remote.view.chat?.turns).toHaveLength(40)
    await remote.close()
    prepares = 0
    remote = new AgentHostConnection(f.target, f.callerDirectory, transport)
    await remote.open()
    expect(remote.view.chat?.turns).toHaveLength(40)
    expect(remote.view.chat?.turns[0].id).toBe('history-20')
    expect(prepares).toBe(1)
    expect(remote.view.history).toMatchObject({ hasMore: true, loadedTurns: 40, totalTurns: 60 })
  } finally {
    await remote?.close()
    await f.close()
  }
})

it('does not use a retained cache turn as authoritative proof of delivery', async () => {
  const f = await startChunkedGatewayFixture(undefined, true)
  let remote: AgentHostConnection | undefined
  const id = randomUUID()
  try {
    f.host.historyText(60, 'Retained source history')
    remote = new AgentHostConnection(f.target, f.callerDirectory, (signal) => connectPagedAgentHostWebSocket(f.url, {}, signal))
    await remote.open()
    await remote.loadHistory()
    await remote.close()
    const directory = join(f.callerDirectory, 'agent-host')
    const hash = createHash('sha256').update(agentHostKey(f.target)).digest('hex')
    const cachePath = join(directory, `${hash}.cache.json`)
    const cache = JSON.parse(await readFile(cachePath, 'utf8')) as { chat: { state: ChatState } }
    cache.chat.state.turns[1].id = id
    await writeFile(cachePath, JSON.stringify(cache))
    await writeFile(join(directory, `${hash}.commands.json`), JSON.stringify({
      schemaVersion: 2, target: f.target, commands: [{ id, hash: 'a'.repeat(64), state: 'uncertain' }],
    }))
    remote = new AgentHostConnection(f.target, f.callerDirectory, (signal) => connectPagedAgentHostWebSocket(f.url, {}, signal))
    await remote.open()
    expect(remote.view.chat?.turns.some((turn) => turn.id === id)).toBe(true)
    expect(remote.view.pendingTurn).toMatchObject({ id, state: 'uncertain' })
    f.host.action({ type: 'chat/activityChanged', activity: 'Live source update' })
    await expect.poll(() => remote!.view.chat?.activity).toBe('Live source update')
    expect(remote.view.pendingTurn).toMatchObject({ id, state: 'uncertain' })
    expect(await remote.resolveDelivery(id, 'check', async () => {})).toBe('not-found')
    expect(f.host.dispatches).toEqual([])
  } finally {
    await remote?.close()
    await f.close()
  }
})

it.each([false, true])('persists an explicit partial offline cache and rejects a corrupted boundary (%s)', async (corrupt) => {
  const f = await startChunkedGatewayFixture()
  let remote: AgentHostConnection | undefined
  try {
    f.host.historyText(60, 'Downloaded window')
    remote = new AgentHostConnection(f.target, f.callerDirectory, (signal) => connectPagedAgentHostWebSocket(f.url, {}, signal))
    await remote.open()
    await remote.close()
    const directory = join(f.callerDirectory, 'agent-host')
    const name = (await readdir(directory)).find((entry) => entry.endsWith('.cache.json'))!
    const path = join(directory, name)
    const cache = JSON.parse(await readFile(path, 'utf8')) as { schemaVersion: number; history: { beforeTurnId: string } }
    expect(cache.schemaVersion).toBe(3)
    expect(cache.history.beforeTurnId).toBe('history-40')
    if (corrupt) {
      cache.history.beforeTurnId = 'unknown-turn'
      await writeFile(path, JSON.stringify(cache))
    }
    remote = new AgentHostConnection(f.target, f.callerDirectory, async () => { throw new Error('Fixture owner unavailable.') })
    await expect(remote.open()).rejects.toThrow()
    if (corrupt) {
      expect(remote.view.chat).toBeUndefined()
      expect(remote.view.error).toContain('Offline chat history could not be read')
    } else {
      expect(remote.view.chat?.turns).toHaveLength(20)
      expect(remote.view.history).toMatchObject({ hasMore: true, loadedTurns: 20 })
      expect(() => remote!.loadHistory()).toThrow('Reconnect')
    }
  } finally {
    await remote?.close()
    await f.close()
  }
})

it.each([false, true])('checks original retained-turn membership instead of treating an unloaded turn as missing (%s)', async (found) => {
  const f = await startChunkedGatewayFixture(undefined, true)
  let remote: AgentHostConnection | undefined
  const turnId = randomUUID()
  const methods: string[] = []
  try {
    f.host.historyText(50, 'Original history', found ? [turnId] : undefined)
    const directory = join(f.callerDirectory, 'agent-host')
    await mkdir(directory, { recursive: true })
    const path = join(directory, `${createHash('sha256').update(agentHostKey(f.target)).digest('hex')}.commands.json`)
    await writeFile(path, JSON.stringify({ schemaVersion: 2, target: f.target, commands: [{ id: turnId, hash: 'a'.repeat(64), state: 'uncertain' }] }))
    remote = new AgentHostConnection(f.target, f.callerDirectory, async (signal) => {
      const inner = await connectPagedAgentHostWebSocket(f.url, {}, signal)
      return {
        send: (message) => {
          const parsed = (typeof message === 'string' ? JSON.parse(message) : message) as { method?: string }
          if (parsed.method) methods.push(parsed.method)
          return inner.send(message)
        },
        recv: () => inner.recv(), close: () => inner.close(),
      }
    })
    await remote.open()
    expect(remote.view.chat?.turns).toHaveLength(20)
    expect(remote.view.chat?.turns.some((turn) => turn.id === turnId)).toBe(false)
    expect(methods).toContain(SNAPSHOT_TRANSFER_METHODS.containsTurn)
    expect(await remote.resolveDelivery(turnId, 'check', async () => {})).toBe(found ? 'confirmed' : 'not-found')
    expect(methods.filter((method) => method === SNAPSHOT_TRANSFER_METHODS.prepare)).toHaveLength(1)
    expect(remote.view.pendingTurn === undefined).toBe(found)
    expect(f.host.dispatches).toEqual([])
  } finally {
    await remote?.close()
    await f.close()
  }
})

it('reconnects to the latest window after truncation outside the downloaded range', async () => {
  const f = await startChunkedGatewayFixture()
  let remote: AgentHostConnection | undefined
  let unlisten: (() => void) | undefined
  try {
    f.host.historyText(50, 'Before edit')
    remote = new AgentHostConnection(f.target, f.callerDirectory, (signal) => connectPagedAgentHostWebSocket(f.url, {}, signal))
    unlisten = remote.listen(() => {})
    await remote.open()
    f.host.action({ type: 'chat/truncated', turnId: 'history-4' })
    await expect.poll(() => remote!.state).toBe('offline')
    expect(remote.view.chat?.turns).toHaveLength(20)
    await remote.open()
    expect(remote.view.chat?.turns.map((turn) => turn.id)).toEqual(['history-0', 'history-1', 'history-2', 'history-3', 'history-4'])
    expect(remote.view.history?.hasMore).toBe(false)
    expect(f.host.dispatches).toEqual([])
  } finally {
    unlisten?.()
    await remote?.close()
    await f.close()
  }
})

function historyDigest(chat: ChatState): string {
  return createHash('sha256').update(JSON.stringify(chat)).digest('hex')
}

async function startChunkedGatewayFixture(snapshotLimits?: Partial<SnapshotTransferLimits>, canSend = false) {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-chunked-history-'))
  const host = await startAgentHostFixture(undefined, '1.0.0')
  const owner = { clientId: randomUUID(), machineName: 'Owner-B' }
  const target = { sessionId: host.sessionId, chatId: host.chatId, owner }
  const native = new AgentHostConnection(target, join(directory, 'owner'), (signal) => connectLocalAgentHost(host.endpoint, signal))
  const startServer = async (limits = snapshotLimits) => {
    const server = createServer()
    let port = 0
    const gateway = attachAgentHostGateway(server, {
      port: () => port,
      connection: async () => native,
      snapshotLimits: limits,
      authorize: async (_token, selected, send) => {
        if (send && !canSend || agentHostKey(selected) !== agentHostKey(target)) throw new Error('Access denied.')
        return { canSend, actor: owner }
      },
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing gateway port.')
    port = address.port
    const url = `ws://127.0.0.1:${port}/device/agent-host?target=${Buffer.from(JSON.stringify(target)).toString('base64url')}`
    return {
      url,
      gateway,
      closeServer: async () => {
        gateway.close()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      },
    }
  }
  const activeServer = await startServer()
  return {
    directory,
    host,
    target,
    native,
    callerDirectory: join(directory, 'caller'),
    url: activeServer.url,
    startServer,
    closeActiveServer: activeServer.closeServer,
    close: async () => {
      await activeServer.closeServer().catch(() => undefined)
      await native.close()
      await host.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

it('uses single-round-trip inline preparation for small snapshots without writing partial files', async () => {
  const f = await startChunkedGatewayFixture({ inlineBytes: 64 * 1024, minChunkBytes: 8 * 1024, initialChunkBytes: 8 * 1024, maxChunkBytes: 16 * 1024 })
  const seenMethods: string[] = []
  let remote: AgentHostConnection | undefined
  try {
    f.host.historyText(2, 'Small history reply')
    remote = new AgentHostConnection(f.target, f.callerDirectory, async (signal) => {
      const inner = await connectAgentHostWebSocket(f.url, {}, signal)
      return {
        send: (message: JsonRpcMessage | string) => {
          const parsed = typeof message === 'string' ? JSON.parse(message) as { method?: string } : message as { method?: string }
          if (parsed.method) seenMethods.push(parsed.method)
          return inner.send(message)
        },
        recv: () => inner.recv(),
        close: () => inner.close(),
      }
    })
    await remote.open()
    expect(remote.state).toBe('connected')
    expect(remote.view.chat?.turns).toHaveLength(2)
    expect(seenMethods).toContain(SNAPSHOT_TRANSFER_METHODS.prepare)
    expect(seenMethods).not.toContain(SNAPSHOT_TRANSFER_METHODS.chunk)
    expect(seenMethods).not.toContain(SNAPSHOT_TRANSFER_METHODS.activate)
    const liveTurn = randomUUID()
    f.host.action({ type: 'chat/turnStarted', turnId: liveTurn, startedAt: new Date().toISOString(), message: { text: 'Follow-up', origin: { kind: 'user' } } })
    await expect.poll(() => remote!.view.chat?.activeTurn?.id).toBe(liveTurn)
    const files = await readdir(join(f.callerDirectory, 'agent-host')).catch(() => [] as string[])
    expect(files.some((name) => name.includes('.snapshot.part'))).toBe(false)
  } finally {
    await remote?.close()
    await f.close()
  }
})

it('completes a slow multi-chunk transfer whose total duration exceeds the 60-second per-request timeout', async () => {
  const f = await startChunkedGatewayFixture({
    inlineBytes: 4 * 1024,
    minChunkBytes: 16 * 1024,
    initialChunkBytes: 16 * 1024,
    maxChunkBytes: 16 * 1024,
  })
  let remote: AgentHostConnection | undefined
  let releaseChunk!: () => void
  let waitingForChunk!: () => void
  let chunkCount = 0
  try {
    f.host.historyBytes(140 * 1024)
    const expected = historyDigest(f.host.snapshot(f.host.chatId).state as ChatState)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    remote = new AgentHostConnection(f.target, f.callerDirectory, async (signal) => {
      const inner = await connectAgentHostWebSocket(f.url, {}, signal)
      return {
        send: (message) => inner.send(message),
        recv: async () => {
          const frame = await inner.recv()
          if (frame?.kind === 'text' && frame.text.includes('"nextOffset"')) {
            chunkCount++
            const gate = new Promise<void>((resolve) => { releaseChunk = resolve })
            waitingForChunk()
            await gate
          }
          return frame
        },
        close: () => { releaseChunk?.(); return inner.close() },
      }
    })
    let nextChunkGate = new Promise<void>((resolve) => { waitingForChunk = resolve })
    const opening = remote.open()
    // 9 chunks * 10 seconds = 90 seconds > 60-second requestTimeoutMs.
    while (remote.state !== 'connected') {
      const done = await Promise.race([
        opening.then(() => 'done' as const),
        nextChunkGate.then(() => 'chunk' as const),
      ])
      if (done === 'done') break
      await vi.advanceTimersByTimeAsync(10_000)
      nextChunkGate = new Promise<void>((resolve) => { waitingForChunk = resolve })
      releaseChunk()
    }
    await opening
    expect(chunkCount).toBeGreaterThanOrEqual(8)
    expect(remote.state).toBe('connected')
    expect(historyDigest(remote.view.chat!)).toBe(expected)
    expect(f.host.dispatches).toEqual([])
  } finally {
    releaseChunk?.()
    vi.useRealTimers()
    await remote?.close()
    await f.close()
  }
})

it('steps down to minChunkBytes when a scaled chunk request hits RpcTimeoutError during sudden link congestion', async () => {
  const f = await startChunkedGatewayFixture({
    inlineBytes: 4 * 1024,
    minChunkBytes: 8 * 1024,
    initialChunkBytes: 32 * 1024,
    maxChunkBytes: 64 * 1024,
  })
  let remote: AgentHostConnection | undefined
  const requestedLengths: number[] = []
  let stalledOnce = false
  let stallNotice!: () => void
  const stalledPromise = new Promise<void>((resolve) => { stallNotice = resolve })
  try {
    f.host.historyBytes(90 * 1024)
    const expected = historyDigest(f.host.snapshot(f.host.chatId).state as ChatState)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    remote = new AgentHostConnection(f.target, f.callerDirectory, async (signal) => {
      const inner = await connectAgentHostWebSocket(f.url, {}, signal)
      return {
        send: (message) => {
          const parsed = typeof message === 'string' ? JSON.parse(message) as { method?: string; params?: { length?: number } } : message as { method?: string; params?: { length?: number } }
          if (parsed.method === SNAPSHOT_TRANSFER_METHODS.chunk && typeof parsed.params?.length === 'number') {
            requestedLengths.push(parsed.params.length)
            if (!stalledOnce && parsed.params.length >= 32 * 1024) {
              stalledOnce = true
              stallNotice()
              return
            }
          }
          inner.send(message)
        },
        recv: () => inner.recv(),
        close: () => inner.close(),
      }
    })
    const opening = remote.open()
    await stalledPromise
    await vi.advanceTimersByTimeAsync(60_000)
    await opening
    expect(requestedLengths[0]).toBe(32 * 1024)
    expect(requestedLengths[1]).toBe(8 * 1024)
    expect(remote.state).toBe('connected')
    expect(historyDigest(remote.view.chat!)).toBe(expected)
  } finally {
    vi.useRealTimers()
    await remote?.close()
    await f.close()
  }
})

it('resumes from the exact saved byte breakpoint after a mid-transfer disconnect while preserving multi-byte UTF-8 and live tail events', async () => {
  const f = await startChunkedGatewayFixture({
    inlineBytes: 4 * 1024,
    minChunkBytes: 16 * 1024,
    initialChunkBytes: 16 * 1024,
    maxChunkBytes: 16 * 1024,
  })
  const firstOffsets: number[] = []
  const secondOffsets: number[] = []
  const progressEvents: AgentHostHistoryTransfer[] = []
  let phase: 'initial' | 'drop-midway' | 'resume' = 'initial'
  let remote: AgentHostConnection | undefined
  try {
    // Seed a small verified history first so we also prove retained history stays visible across breakpoint resume.
    f.host.historyText(1, 'Initial verified turn')
    remote = new AgentHostConnection(f.target, f.callerDirectory, async (signal) => {
      const inner = await connectAgentHostWebSocket(f.url, {}, signal)
      let chunksOnAttempt = 0
      const transport: AhpTransport = {
        send: (message) => {
          const parsed = typeof message === 'string' ? JSON.parse(message) as { method?: string; params?: { offset?: number } } : message as { method?: string; params?: { offset?: number } }
          if (parsed.method === SNAPSHOT_TRANSFER_METHODS.chunk && typeof parsed.params?.offset === 'number') {
            if (phase === 'drop-midway') {
              firstOffsets.push(parsed.params.offset)
              chunksOnAttempt++
              if (chunksOnAttempt === 4) {
                void inner.close()
                throw new Error('Simulated tunnel drop mid-transfer.')
              }
            } else if (phase === 'resume') {
              secondOffsets.push(parsed.params.offset)
            }
          }
          inner.send(message)
        },
        recv: () => inner.recv(),
        close: () => inner.close(),
      }
      return transport
    })

    // Attempt 1: small history connects inline.
    await remote.open()
    expect(remote.view.chat?.turns).toHaveLength(1)

    // Drop and replace owner history with a multi-chunk UTF-8 payload containing multi-byte characters across chunk boundaries.
    f.host.drop()
    await expect.poll(() => remote!.state).toBe('offline')
    await expect.poll(() => f.native.state).toBe('offline')
    const multiByteText = '断点续传测试🚀跨国慢速链路恢复验证—'.repeat(3500)
    f.host.historyText(4, multiByteText)
    const expectedBase = f.host.snapshot(f.host.chatId).state as ChatState
    await f.native.open()

    const unlistenProgress = remote.listen(() => {
      if (remote?.view.historyTransfer) progressEvents.push(remote.view.historyTransfer)
    })
    phase = 'drop-midway'
    // Attempt 2: downloads 3 chunks (48 KiB), fails on 4th chunk.
    await expect(remote.open()).rejects.toThrow()
    unlistenProgress()
    expect(remote.state).toBe('offline')
    // Retained previous verified turn remains readable while offline!
    expect(remote.view.chat?.turns).toHaveLength(1)
    expect(firstOffsets).toEqual([0, 16 * 1024, 32 * 1024, 48 * 1024])

    const storageDir = join(f.callerDirectory, 'agent-host')
    const partName = (await readdir(storageDir)).find((name) => name.endsWith('.snapshot.part'))
    expect(partName).toBeDefined()
    expect((await stat(join(storageDir, partName!))).size).toBe(48 * 1024)

    // While the remote caller is disconnected mid-transfer, a new live turn happens on the owner chat!
    const liveTurnId = randomUUID()
    f.host.action({ type: 'chat/turnStarted', turnId: liveTurnId, startedAt: new Date().toISOString(), message: { text: 'Turn during disconnect', origin: { kind: 'user' } } })
    f.host.action({ type: 'chat/responsePart', turnId: liveTurnId, part: { kind: 'markdown', id: 'live-part', content: '增量补齐内容✨' } })
    f.host.action({ type: 'chat/turnComplete', turnId: liveTurnId, duration: 5 })

    // Attempt 3: resumes strictly from byte 49,152, downloads remaining chunks, and replays buffered tailEvents!
    const unlistenResume = remote.listen(() => {
      if (remote?.view.historyTransfer) progressEvents.push(remote.view.historyTransfer)
    })
    phase = 'resume'
    await remote.open()
    unlistenResume()
    expect(remote.state).toBe('connected')
    expect(secondOffsets[0]).toBe(48 * 1024)
    expect(secondOffsets.every((offset) => offset >= 48 * 1024)).toBe(true)
    expect(progressEvents.some((item) => item.resumed === true && item.receivedBytes >= 48 * 1024)).toBe(true)

    await expect.poll(() => remote!.view.chat?.turns).toHaveLength(5)
    expect(remote.view.chat?.turns.slice(0, 4)).toEqual(expectedBase.turns)
    expect(remote.view.chat?.turns[4].id).toBe(liveTurnId)
    expect(remote.view.chat?.turns[4].responseParts).toContainEqual({ kind: 'markdown', id: 'live-part', content: '增量补齐内容✨' })

    const afterFiles = await readdir(storageDir)
    expect(afterFiles.some((name) => name.includes('.snapshot.part'))).toBe(false)
    expect(f.host.dispatches).toEqual([])
  } finally {
    await remote?.close()
    await f.close()
  }
})

it('resumes from disk across both client and gateway restarts when the large snapshot SHA-256 is unchanged', async () => {
  const limits = { inlineBytes: 4 * 1024, minChunkBytes: 16 * 1024, initialChunkBytes: 16 * 1024, maxChunkBytes: 16 * 1024 }
  const f = await startChunkedGatewayFixture(limits)
  let firstClient: AgentHostConnection | undefined
  let restartedClient: AgentHostConnection | undefined
  let restartedServer: Awaited<ReturnType<typeof f.startServer>> | undefined
  const resumedOffsets: number[] = []
  try {
    f.host.historyBytes(110 * 1024)
    const expected = historyDigest(f.host.snapshot(f.host.chatId).state as ChatState)
    let count = 0
    firstClient = new AgentHostConnection(f.target, f.callerDirectory, async (signal) => {
      const inner = await connectAgentHostWebSocket(f.url, {}, signal)
      return {
        send: (message) => {
          const parsed = typeof message === 'string' ? JSON.parse(message) as { method?: string } : message as { method?: string }
          if (parsed.method === SNAPSHOT_TRANSFER_METHODS.chunk && ++count === 4) {
            void inner.close()
            throw new Error('Client closed mid-transfer.')
          }
          inner.send(message)
        },
        recv: () => inner.recv(),
        close: () => inner.close(),
      }
    })
    await expect(firstClient.open()).rejects.toThrow()
    await firstClient.close()

    // Restart the gateway completely so its in-memory transferId map is empty.
    await f.closeActiveServer()
    restartedServer = await f.startServer(limits)

    restartedClient = new AgentHostConnection(f.target, f.callerDirectory, async (signal) => {
      const inner = await connectAgentHostWebSocket(restartedServer!.url, {}, signal)
      return {
        send: (message) => {
          const parsed = typeof message === 'string' ? JSON.parse(message) as { method?: string; params?: { offset?: number } } : message as { method?: string; params?: { offset?: number } }
          if (parsed.method === SNAPSHOT_TRANSFER_METHODS.chunk && typeof parsed.params?.offset === 'number') {
            resumedOffsets.push(parsed.params.offset)
          }
          inner.send(message)
        },
        recv: () => inner.recv(),
        close: () => inner.close(),
      }
    })
    await restartedClient.open()
    expect(restartedClient.state).toBe('connected')
    expect(resumedOffsets[0]).toBe(48 * 1024)
    expect(historyDigest(restartedClient.view.chat!)).toBe(expected)
  } finally {
    await restartedClient?.close()
    await restartedServer?.closeServer()
    await f.close()
  }
})

it('restarts cleanly on the latest snapshot when tail events overflow the bounded catch-up window mid-transfer', async () => {
  const f = await startChunkedGatewayFixture({
    inlineBytes: 4 * 1024,
    minChunkBytes: 16 * 1024,
    initialChunkBytes: 16 * 1024,
    maxChunkBytes: 16 * 1024,
    maxTailEvents: 2,
  })
  let remote: AgentHostConnection | undefined
  let overflowed = false
  let prepareCalls = 0
  try {
    f.host.historyBytes(80 * 1024)
    remote = new AgentHostConnection(f.target, f.callerDirectory, async (signal) => {
      const inner = await connectAgentHostWebSocket(f.url, {}, signal)
      return {
        send: (message) => {
          const parsed = typeof message === 'string' ? JSON.parse(message) as { method?: string; params?: { offset?: number } } : message as { method?: string; params?: { offset?: number } }
          if (parsed.method === SNAPSHOT_TRANSFER_METHODS.prepare) prepareCalls++
          if (parsed.method === SNAPSHOT_TRANSFER_METHODS.chunk && parsed.params?.offset === 16 * 1024 && !overflowed) {
            overflowed = true
            const turnId = randomUUID()
            f.host.action({ type: 'chat/turnStarted', turnId, startedAt: new Date().toISOString(), message: { text: 'Overflow burst', origin: { kind: 'user' } } })
            f.host.action({ type: 'chat/responsePart', turnId, part: { kind: 'markdown', id: 'p1', content: '1' } })
            f.host.action({ type: 'chat/delta', turnId, partId: 'p1', content: '2' })
            f.host.action({ type: 'chat/turnComplete', turnId, duration: 1 })
          }
          inner.send(message)
        },
        recv: () => inner.recv(),
        close: () => inner.close(),
      }
    })
    await remote.open()
    expect(prepareCalls).toBe(2)
    expect(remote.state).toBe('connected')
    expect(remote.view.chat?.turns).toHaveLength(33)
    expect(remote.view.chat?.turns.at(-1)?.responseParts).toContainEqual({ kind: 'markdown', id: 'p1', content: '12' })
  } finally {
    await remote?.close()
    await f.close()
  }
})

it('rejects tampered chunk bytes, cleans partial files, and preserves uncertain-delivery review over chunked snapshots', async () => {
  const f = await startChunkedGatewayFixture({
    inlineBytes: 4 * 1024,
    minChunkBytes: 16 * 1024,
    initialChunkBytes: 16 * 1024,
    maxChunkBytes: 16 * 1024,
  }, true)
  let corruptNextChunk = true
  let remote: AgentHostConnection | undefined
  try {
    f.host.historyBytes(64 * 1024)
    remote = new AgentHostConnection(f.target, f.callerDirectory, async (signal) => {
      const inner = await connectAgentHostWebSocket(f.url, {}, signal)
      return {
        send: (message) => inner.send(message),
        recv: async () => {
          const frame = await inner.recv()
          if (corruptNextChunk && frame?.kind === 'text' && frame.text.includes('"nextOffset"')) {
            corruptNextChunk = false
            const parsed = JSON.parse(frame.text) as { result: { data: string } }
            const bytes = Buffer.from(parsed.result.data, 'base64')
            bytes[0] ^= 0xff
            parsed.result.data = bytes.toString('base64')
            return { kind: 'text', text: JSON.stringify(parsed) }
          }
          return frame
        },
        close: () => inner.close(),
      }
    })
    await expect(remote.open()).rejects.toThrow()
    const storageDir = join(f.callerDirectory, 'agent-host')
    const afterCorrupt = await readdir(storageDir).catch(() => [] as string[])
    expect(afterCorrupt.some((name) => name.includes('.snapshot.part'))).toBe(false)

    // Clean retry succeeds and supports uncertain delivery resolution over chunked snapshots.
    await remote.open()
    expect(remote.state).toBe('connected')
    const uncertainId = randomUUID()
    f.host.loseNextSend()
    await expect(remote.send(uncertainId, 'Check over chunked snapshot', undefined, async () => {}, f.target.owner, { id: 'gpt-6' })).rejects.toThrow()
    await f.native.open()
    await remote.open()
    expect(await remote.resolveDelivery(uncertainId, 'check', async () => {})).toBe('not-found')
    f.host.action({ type: 'chat/turnStarted', turnId: uncertainId, startedAt: new Date().toISOString(), message: { text: 'Check over chunked snapshot', origin: { kind: 'user' } } })
    f.host.action({ type: 'chat/turnComplete', turnId: uncertainId, duration: 1 })
    expect(await remote.resolveDelivery(uncertainId, 'check', async () => {})).toBe('confirmed')
  } finally {
    await remote?.close()
    await f.close()
  }
})

it('reclaims released or activated exports immediately so newer snapshots never evict a slow downloader', async () => {
  const f = await startChunkedGatewayFixture({
    inlineBytes: 4 * 1024,
    minChunkBytes: 16 * 1024,
    initialChunkBytes: 16 * 1024,
    maxChunkBytes: 16 * 1024,
    maxExportsPerTarget: 2,
  })
  let slowClient: AgentHostConnection | undefined
  let fastSubscriber: AgentHostConnection | undefined
  let rawReader: AhpClient | undefined
  let thirdSubscriber: AgentHostConnection | undefined
  const slowOffsets: number[] = []
  let slowPaused!: () => void
  let releaseSlow!: () => void
  const slowEntered = new Promise<void>((resolve) => { slowPaused = resolve })
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve })
  try {
    f.host.historyBytes(80 * 1024)
    slowClient = new AgentHostConnection(f.target, join(f.directory, 'slow-caller'), async (signal) => {
      const inner = await connectAgentHostWebSocket(f.url, {}, signal)
      return {
        send: (message) => {
          const parsed = typeof message === 'string' ? JSON.parse(message) as { method?: string; params?: { offset?: number } } : message as { method?: string; params?: { offset?: number } }
          if (parsed.method === SNAPSHOT_TRANSFER_METHODS.chunk && typeof parsed.params?.offset === 'number') {
            slowOffsets.push(parsed.params.offset)
            if (parsed.params.offset === 16 * 1024) {
              slowPaused()
              void slowGate.then(() => inner.send(message))
              return
            }
          }
          inner.send(message)
        },
        recv: () => inner.recv(),
        close: () => { releaseSlow(); return inner.close() },
      }
    })

    const slowOpening = slowClient.open()
    await slowEntered

    // Advance chat (Export #2): Client B reads and calls release; Export #2 must be freed immediately.
    const turnB = randomUUID()
    f.host.action({ type: 'chat/turnStarted', turnId: turnB, startedAt: new Date().toISOString(), message: { text: 'Turn B', origin: { kind: 'user' } } })
    f.host.action({ type: 'chat/turnComplete', turnId: turnB, duration: 1 })
    rawReader = new AhpClient(await connectAgentHostWebSocket(f.url, {}, new AbortController().signal))
    rawReader.connect()
    await rawReader.initialize({ clientId: randomUUID(), protocolVersions: ['1.0.0'] })
    const preparedB = await rawReader.request(
      SNAPSHOT_TRANSFER_METHODS.prepare as Parameters<AhpClient['request']>[0],
      { channel: f.target.chatId, subscribe: false } as never,
    ) as unknown as { mode: 'chunked'; transferId: string; leaseId: string }
    expect(preparedB.mode).toBe('chunked')
    await rawReader.request(
      SNAPSHOT_TRANSFER_METHODS.release as Parameters<AhpClient['request']>[0],
      { channel: f.target.chatId, transferId: preparedB.transferId, leaseId: preparedB.leaseId } as never,
    )

    // Advance chat again (Export #3): Fast subscriber connects and activates; Export #3 is also freed.
    const turnC = randomUUID()
    f.host.action({ type: 'chat/turnStarted', turnId: turnC, startedAt: new Date().toISOString(), message: { text: 'Turn C', origin: { kind: 'user' } } })
    f.host.action({ type: 'chat/turnComplete', turnId: turnC, duration: 1 })
    fastSubscriber = new AgentHostConnection(f.target, join(f.directory, 'fast-caller'), (signal) => connectAgentHostWebSocket(f.url, {}, signal))
    await fastSubscriber.open()

    // Advance chat a third time (Export #4): Third subscriber opens while slowClient is STILL paused on Export #1!
    const turnD = randomUUID()
    f.host.action({ type: 'chat/turnStarted', turnId: turnD, startedAt: new Date().toISOString(), message: { text: 'Turn D', origin: { kind: 'user' } } })
    f.host.action({ type: 'chat/turnComplete', turnId: turnD, duration: 1 })
    thirdSubscriber = new AgentHostConnection(f.target, join(f.directory, 'third-caller'), (signal) => connectAgentHostWebSocket(f.url, {}, signal))
    await thirdSubscriber.open()

    // Resume slowClient: Export #1 was NEVER evicted and slowClient never restarts from offset 0!
    releaseSlow()
    await slowOpening
    expect(slowClient.state).toBe('connected')
    expect(slowOffsets.filter((offset) => offset === 0)).toHaveLength(1)
    await expect.poll(() => slowClient!.view.chat?.turns.map((turn) => turn.id)).toContain(turnD)
  } finally {
    releaseSlow()
    await rawReader?.shutdown()
    await thirdSubscriber?.close()
    await fastSubscriber?.close()
    await slowClient?.close()
    await f.close()
  }
})

it('tracks per-consumer leases on shared exports, isolates cross-socket releases, and frees buffers on unsubscribe', async () => {
  const f = await startChunkedGatewayFixture({
    inlineBytes: 4 * 1024,
    minChunkBytes: 16 * 1024,
    initialChunkBytes: 16 * 1024,
    maxChunkBytes: 16 * 1024,
    maxExportsPerTarget: 2,
  })
  const store = new AgentHostSnapshotStore({
    inlineBytes: 4 * 1024,
    minChunkBytes: 16 * 1024,
    initialChunkBytes: 16 * 1024,
    maxChunkBytes: 16 * 1024,
    maxExportsPerTarget: 2,
  })
  try {
    f.host.historyBytes(64 * 1024)
    await f.native.open()
    const socketA = {}
    const socketB = {}
    const socketC = {}

    // A and B share the exact same snapshot export via distinct consumer leases.
    const prepA = store.prepare(f.target, f.native, { channel: f.target.chatId, subscribe: true }, socketA)
    const prepB = store.prepare(f.target, f.native, { channel: f.target.chatId, subscribe: false }, socketB)
    expect(prepA.mode === 'chunked' && prepB.mode === 'chunked').toBe(true)
    if (prepA.mode !== 'chunked' || prepB.mode !== 'chunked') throw new Error('Expected chunked mode.')
    expect(prepA.transferId).toBe(prepB.transferId)
    expect(prepA.leaseId).not.toBe(prepB.leaseId)
    expect(store.exportCount).toBe(1)
    expect(store.bufferedBytes).toBeGreaterThan(60 * 1024)

    // Unrelated socket C omitting leaseId cannot evict A or B's shared export.
    store.release(f.target, f.native, { channel: f.target.chatId, transferId: prepA.transferId }, socketC)
    expect(store.exportCount).toBe(1)

    // B releasing its lease keeps the shared export alive for A.
    store.release(f.target, f.native, { channel: f.target.chatId, transferId: prepB.transferId, leaseId: prepB.leaseId }, socketB)
    expect(store.exportCount).toBe(1)
    expect(store.chunk(f.target, f.native, { channel: f.target.chatId, transferId: prepA.transferId, leaseId: prepA.leaseId, offset: 0 }).nextOffset).toBe(16 * 1024)

    // A activating its lease drops remaining leases to 0 and immediately evicts the export buffer.
    store.activate(f.target, f.native, { channel: f.target.chatId, transferId: prepA.transferId, leaseId: prepA.leaseId }, socketA)
    expect(store.exportCount).toBe(0)
    expect(store.bufferedBytes).toBe(0)

    // Explicit unsubscribe (releaseOwner) immediately frees an in-flight subscription lease; abnormal disconnect retains it for resume.
    const socketCancel = {}
    const socketDrop = {}
    const cancelPrep = store.prepare(f.target, f.native, { channel: f.target.chatId, subscribe: true }, socketCancel)
    expect(cancelPrep.mode).toBe('chunked')
    expect(store.exportCount).toBe(1)
    store.releaseOwner(socketCancel, f.target.chatId)
    expect(store.exportCount).toBe(0)

    const dropPrep = store.prepare(f.target, f.native, { channel: f.target.chatId, subscribe: true }, socketDrop)
    if (dropPrep.mode !== 'chunked') throw new Error('Expected chunked mode.')
    store.disconnectOwner(socketDrop)
    expect(store.exportCount).toBe(1)
    const socketReconnect = {}
    const resumed = store.prepare(f.target, f.native, {
      channel: f.target.chatId,
      subscribe: true,
      resumeTransferId: dropPrep.transferId,
      resumeLeaseId: dropPrep.leaseId,
    }, socketReconnect)
    expect(resumed).toMatchObject({ mode: 'chunked', transferId: dropPrep.transferId, leaseId: dropPrep.leaseId, resumed: true })
    store.activate(f.target, f.native, { channel: f.target.chatId, transferId: dropPrep.transferId, leaseId: dropPrep.leaseId }, socketReconnect)
    expect(store.exportCount).toBe(0)
  } finally {
    store.close()
    await f.close()
  }
})
