// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatState } from '@microsoft/agent-host-protocol'
import WebSocket from 'ws'
import { expect, it, vi } from 'vitest'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { attachAgentHostGateway } from '../src/main/agentHostGateway'
import {
  AGENT_HOST_LIMITS, AgentHostSizeLimitError, decodeAgentHostSizeLimit, parseAgentHostSizeLimit,
} from '../src/main/agentHostLimits'
import { connectAgentHostWebSocket, connectLocalAgentHost } from '../src/main/agentHostTransport'
import { startAgentHostFixture, startAgentHostTransportFixture } from './agent-host-fixture'

const MiB = 1024 * 1024
const GiB = 1024 * MiB

it('uses one GiB snapshot budgets without increasing request or message-count limits', () => {
  expect(AGENT_HOST_LIMITS).toEqual({
    messageBytes: GiB,
    receiveBufferBytes: GiB + 16 * MiB,
    receiveBufferMessages: 1024,
    requestBytes: 16 * MiB,
    responseBufferBytes: GiB + 16 * MiB,
    responseBufferGlobalBytes: 2 * GiB,
    cacheBytes: GiB + 64 * 1024,
  })
})

it.each([
  ['message', GiB],
  ['receive-buffer', GiB + 16 * MiB],
  ['send-buffer', 2 * GiB],
  ['cache', GiB + 64 * 1024],
] as const)('round-trips one GiB-scale %s errors through RPC and HTTP metadata', (kind, limitBytes) => {
  const error = new AgentHostSizeLimitError(kind, limitBytes, limitBytes + 1)
  expect(parseAgentHostSizeLimit(error.toData())).toMatchObject({ kind, limitBytes, actualBytes: limitBytes + 1 })
  expect(decodeAgentHostSizeLimit(JSON.stringify(error.toData()))).toMatchObject({ kind, limitBytes, actualBytes: limitBytes + 1 })
  if (limitBytes === GiB) expect(error.message).toContain('1 GiB limit (1073741824 bytes)')
})

it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe byte counts: %s', (actualBytes) => {
  expect(parseAgentHostSizeLimit({ code: 'TC_AHP_LIMIT', kind: 'message', limitBytes: GiB, actualBytes })).toBeUndefined()
})

it.each([GiB, GiB + 1])('checks the actual WebSocket frame length at %i bytes without allocating a GiB payload', async (bytes) => {
  const f = await startAgentHostTransportFixture()
  try {
    const result = f.transport.recv().catch((error: unknown) => error)
    const header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(bytes), 2)
    f.stream.write(header)
    if (bytes > GiB) {
      expect(await result).toMatchObject({ name: 'AgentHostSizeLimitError', kind: 'message', limitBytes: GiB })
    } else {
      await new Promise<void>((resolve) => setTimeout(resolve, 30))
      expect(f.socket.readyState).toBe(WebSocket.OPEN)
      await f.transport.close()
      expect(await result).toBeNull()
    }
  } finally { await f.close() }
})

it('reports a runtime text-decoding failure without throwing out of the socket callback', async () => {
  const f = await startAgentHostTransportFixture()
  const frame = Buffer.from('{"fixture":"runtime-text-decoding-limit"}')
  const prototype: Pick<Buffer, 'toString'> = Buffer.prototype
  const original = prototype.toString
  const decoding = vi.spyOn(prototype, 'toString').mockImplementation(function (this: Buffer, ...args: Parameters<Buffer['toString']>) {
    if (this.equals(frame)) throw new RangeError('Fixture runtime string limit.')
    return original.apply(this, args)
  })
  try {
    const received = expect(f.transport.recv()).rejects.toThrow('runtime memory or string limits')
    f.socket.send(frame, { binary: false })
    await received
    await expect.poll(() => f.socket.readyState).toBe(WebSocket.CLOSED)
  } finally { decoding.mockRestore(); await f.close() }
})

function historyDigest(chat: ChatState): string {
  const hash = createHash('sha256')
  for (const turn of chat.turns) {
    hash.update(turn.id)
    for (const part of turn.responseParts) if (part.kind === 'markdown') hash.update(part.content)
  }
  return hash.digest('hex')
}

it('loads the reported 119,280,475-byte history through native and remote connections, models and cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'continuum-gib-history-'))
  const host = await startAgentHostFixture(undefined, '1.0.0')
  const target = { sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
  const native = new AgentHostConnection(target, join(directory, 'owner'), (signal) => connectLocalAgentHost(host.endpoint, signal))
  const server = createServer()
  let port = 0
  const gateway = attachAgentHostGateway(server, {
    port: () => port, connection: async () => native,
    authorize: async (_token, selected, send) => {
      if (send || selected.chatId !== target.chatId || selected.sessionId !== target.sessionId
        || selected.owner.clientId !== target.owner.clientId) throw new Error('Access denied.')
      return { canSend: false, actor: target.owner }
    },
  })
  let remote: AgentHostConnection | undefined
  try {
    expect(host.historyBytes(119_280_475)).toBe(119_280_475)
    const expected = historyDigest(host.snapshot(host.chatId).state as ChatState)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture gateway port.')
    port = address.port
    const url = `ws://127.0.0.1:${port}/device/agent-host?target=${Buffer.from(JSON.stringify(target)).toString('base64url')}`
    remote = new AgentHostConnection(target, join(directory, 'caller'), (signal) => connectAgentHostWebSocket(url, {}, signal))
    await remote.open()
    expect(remote.state).toBe('connected')
    expect(native.view.chat?.turns).toHaveLength(32)
    expect(remote.view.chat?.turns).toHaveLength(32)
    expect(historyDigest(native.view.chat!)).toBe(expected)
    expect(historyDigest(remote.view.chat!)).toBe(expected)
    expect(await remote.models()).toContainEqual(expect.objectContaining({ id: 'owner-model' }))
    await remote.close()
    const cacheDirectory = join(directory, 'caller', 'agent-host')
    const cache = (await readdir(cacheDirectory)).find((name) => name.endsWith('.cache.json'))
    expect(cache).toBeDefined()
    expect((await stat(join(cacheDirectory, cache!))).size).toBeGreaterThan(119_000_000)
    expect(host.dispatches).toEqual([])
    expect(host.methods).not.toContain('createSession')
  } finally {
    await remote?.close()
    gateway.close()
    await native.close()
    await host.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
