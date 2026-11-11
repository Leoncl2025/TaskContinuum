// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatState } from '@microsoft/agent-host-protocol'
import type { AhpTransport, JsonRpcMessage } from '@microsoft/agent-host-protocol/client'
import { expect, it, vi } from 'vitest'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { attachAgentHostGateway } from '../src/main/agentHostGateway'
import type { SnapshotTransferLimits } from '../src/main/agentHostSnapshotTransfer'
import { SNAPSHOT_TRANSFER_METHODS } from '../src/main/agentHostSnapshotTransfer'
import { connectAgentHostWebSocket, connectLocalAgentHost } from '../src/main/agentHostTransport'
import { agentHostKey } from '../src/shared/agentHost'
import type { AgentHostHistoryTransfer } from '../src/shared/agentHost'
import { startAgentHostFixture } from './agent-host-fixture'

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
