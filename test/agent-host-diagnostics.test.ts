// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { AGENT_HOST_TRACE_HEADER } from '../src/main/agentHostDiagnostics'
import { attachAgentHostGateway } from '../src/main/agentHostGateway'
import { connectAgentHostWebSocket, connectLocalAgentHost } from '../src/main/agentHostTransport'
import { startAgentHostFixture } from './agent-host-fixture'
import {
  agentHostDiagnosticChannel, agentHostDiagnosticMethod, flushAgentHostDiagnostics,
  logAgentHostDiagnostic, startAgentHostDiagnostics, stopAgentHostDiagnostics, captureAgentHostDiagnostics,
} from '../src/main/agentHostDiagnostics'

afterEach(async () => { await stopAgentHostDiagnostics() })

describe('Agent Host diagnostic logs', () => {
  it('exports separate send-phase timings without messages, model IDs or raw errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-ahp-send-phase-'))
    const host = await startAgentHostFixture()
    const target = { sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Private-owner' } }
    const connection = new AgentHostConnection(target, directory, (signal) => connectLocalAgentHost(host.endpoint, signal))
    const id = randomUUID()
    try {
      await startAgentHostDiagnostics(directory)
      await connection.models()
      await connection.send(id, 'secret message contents', undefined, async () => {}, undefined, { id: 'gpt-6' })
      const capture = await captureAgentHostDiagnostics(directory, {}, new AbortController().signal)
      const text = capture.jsonl.toString('utf8')
      expect(capture.truncated).toBe(false)
      for (const secret of ['secret message contents', 'gpt-6', id, host.chatId, host.sessionId]) expect(text).not.toContain(secret)
      const events = text.trim().split('\n').map((line) => JSON.parse(line) as { event: string; step: string; elapsedMs: number; status: string })
      const phases = events.filter((event) => event.event === 'connection.send.phase')
      expect(phases.map((event) => event.step)).toEqual(['load', 'authorization', 'models', 'snapshot', 'snapshot-apply', 'reconcile', 'validation', 'ledger', 'authorization', 'validation', 'dispatch', 'confirmation'])
      for (const event of phases) {
        expect(event.status).toBe('ok')
        expect(event.elapsedMs).toBeGreaterThanOrEqual(0)
      }
      host.action({ type: 'chat/turnComplete', turnId: id, duration: 1 })
      await expect.poll(() => connection.view.chat?.activeTurn).toBeUndefined()
      await expect(connection.send(randomUUID(), 'other secret', undefined, async () => { throw new Error('secret permission detail') })).rejects.toThrow()
      const failure = await captureAgentHostDiagnostics(directory, {}, new AbortController().signal)
      expect(failure.jsonl.toString()).not.toContain('secret permission detail')
      expect(failure.jsonl.toString()).toContain('"errorKind":"other"')
    } finally { await connection.close(); await host.close(); await stopAgentHostDiagnostics(); await rm(directory, { recursive: true, force: true }) }
  })

  it('records only allowlisted metadata and sanitizes error text and untrusted identifiers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-ahp-diagnostics-'))
    const target = { sessionId: `copilotcli:/${randomUUID()}`, chatId: 'ahp-chat://private-chat', owner: { clientId: randomUUID(), machineName: 'private-machine' } }
    const traceId = randomUUID()
    try {
      await startAgentHostDiagnostics(directory)
      const failure = new Error('secret token, filesystem path, and prompt contents')
      failure.name = 'RpcTimeoutError'
      logAgentHostDiagnostic('gateway.request', {
        target, ownerId: target.owner.clientId, traceId, status: 'error', step: 'native',
        method: agentHostDiagnosticMethod('not-an-allowed-method'), channel: agentHostDiagnosticChannel(target.chatId, target),
        elapsedMs: 15000.3, queueMs: 12, error: failure,
        ...{ message: 'private message', authorization: 'Bearer private token', params: { text: 'private prompt' } },
      })
      logAgentHostDiagnostic('gateway.request', { target, traceId: 'not-a-uuid', status: 'error', channel: agentHostDiagnosticChannel('ahp-terminal:/private', target), error: new Error('secret') })
      await flushAgentHostDiagnostics()
      const text = await readFile(join(directory, 'agent-host-diagnostics', 'agent-host.jsonl'), 'utf8')
      for (const secret of [target.sessionId, target.chatId, target.owner.clientId, target.owner.machineName, 'secret', 'private message', 'Bearer', 'not-a-uuid']) {
        expect(text).not.toContain(secret)
      }
      const records = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(records).toContainEqual(expect.objectContaining({
        event: 'gateway.request', traceId, status: 'error', method: 'other', channel: 'chat', errorKind: 'timeout', elapsedMs: 15000, queueMs: 12,
      }))
      expect(records).toContainEqual(expect.objectContaining({ event: 'gateway.request', channel: 'terminal', errorKind: 'other' }))
      expect(records.find((record) => record.channel === 'terminal')).not.toHaveProperty('traceId')
      expect(records.find((record) => record.traceId === traceId)).toHaveProperty('targetHash', expect.stringMatching(/^[0-9a-f]{16}$/))
    } finally { await stopAgentHostDiagnostics(); await rm(directory, { recursive: true, force: true }) }
  })

  it('rotates bounded files and rejects a multiply linked destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-ahp-diagnostics-'))
    const output = join(directory, 'agent-host-diagnostics')
    try {
      await startAgentHostDiagnostics(directory, 768)
      for (let index = 0; index < 40; index++) logAgentHostDiagnostic('connection.heartbeat', { traceId: randomUUID(), status: 'ok', elapsedMs: index })
      await stopAgentHostDiagnostics()
      for (const name of ['agent-host.jsonl', 'agent-host.1.jsonl', 'agent-host.2.jsonl']) {
        const file = join(output, name)
        expect((await stat(file)).size).toBeLessThanOrEqual(768)
        for (const line of (await readFile(file, 'utf8')).trim().split('\n')) expect(JSON.parse(line)).toHaveProperty('schemaVersion', 1)
      }
      await rm(join(output, 'agent-host.jsonl'))
      const outside = join(directory, 'outside.jsonl')
      await writeFile(outside, '')
      await link(outside, join(output, 'agent-host.jsonl'))
      await expect(startAgentHostDiagnostics(directory)).rejects.toThrow('not a private regular file')
      expect((await readFile(outside, 'utf8'))).toBe('')
      await rm(join(output, 'agent-host.jsonl'))
      await writeFile(join(output, 'agent-host.1.jsonl'), 'x'.repeat(769))
      await expect(startAgentHostDiagnostics(directory, 768)).rejects.toThrow('exceeds the size limit')
    } finally { await stopAgentHostDiagnostics(); await rm(directory, { recursive: true, force: true }) }
  })

  it('does not create files when diagnostics have not been enabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-ahp-diagnostics-'))
    try {
      logAgentHostDiagnostic('connection.open', { status: 'begin', traceId: randomUUID() })
      await expect(stat(join(directory, 'agent-host-diagnostics'))).rejects.toMatchObject({ code: 'ENOENT' })
      await mkdir(join(directory, 'agent-host-diagnostics'))
      await expect(stat(join(directory, 'agent-host-diagnostics', 'agent-host.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('pinpoints a native root subscription timeout while the chat stays connected', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-ahp-diagnostics-'))
    const host = await startAgentHostFixture()
    const target = { sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
    const connection = new AgentHostConnection(target, directory, (signal) => connectLocalAgentHost(host.endpoint, signal))
    try {
      await startAgentHostDiagnostics(directory)
      await connection.open()
      host.stallRoot()
      await expect(connection.models()).rejects.toThrow('Request "subscribe" timed out after 15000ms')
      expect(connection.view.state).toBe('connected')
      expect(host.dispatches).toHaveLength(0)
      await flushAgentHostDiagnostics()
      const records = (await readFile(join(directory, 'agent-host-diagnostics', 'agent-host.jsonl'), 'utf8'))
        .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
      const failure = records.find((record) => record.event === 'connection.models' && record.status === 'error')
      expect(failure).toMatchObject({ step: 'root', errorKind: 'timeout', timeoutMs: 15000, errorMethod: 'subscribe' })
      expect(failure?.elapsedMs).toBeGreaterThanOrEqual(15000)
      expect(records).toContainEqual(expect.objectContaining({ event: 'connection.subscribe', channel: 'chat', status: 'ok', traceId: failure?.traceId }))
    } finally {
      await connection.close()
      await host.close()
      await stopAgentHostDiagnostics()
      await rm(directory, { recursive: true, force: true })
    }
  }, 25000)

  it('keeps ping responsive while an owner model lookup is blocked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'continuum-ahp-diagnostics-'))
    const host = await startAgentHostFixture()
    const target = { sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
    const connection = new AgentHostConnection(target, directory, (signal) => connectLocalAgentHost(host.endpoint, signal))
    const server = createServer()
    let port = 0
    const actor = { clientId: randomUUID(), machineName: 'Test client' }
    const gateway = attachAgentHostGateway(server, {
      port: () => port,
      authorize: async (token) => {
        if (token !== 'test-token') throw new Error('Denied.')
        return { canSend: true, actor }
      },
      connection: async () => connection,
    })
    let client: AhpClient | undefined
    const abort = new AbortController()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const upstreamStarted = new Promise<void>((resolve) => { entered = resolve })
    try {
      await startAgentHostDiagnostics(directory)
      await connection.open()
      const originalModels = connection.models.bind(connection)
      vi.spyOn(connection, 'models').mockImplementation(async (parentTraceId) => {
        entered()
        await blocked
        return originalModels(parentTraceId)
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      port = (server.address() as AddressInfo).port
      const traceId = randomUUID()
      const encoded = Buffer.from(JSON.stringify(target)).toString('base64url')
      client = new AhpClient(await connectAgentHostWebSocket(`ws://127.0.0.1:${port}/device/agent-host?target=${encoded}`, {
        headers: { Host: `127.0.0.1:${port}`, Authorization: 'Bearer test-token', [AGENT_HOST_TRACE_HEADER]: traceId },
      }, abort.signal), { requestTimeoutMs: 5000 })
      client.connect()
      await client.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'] })
      const models = client.request('subscribe', { channel: 'ahp-root://' })
      await upstreamStarted
      const ping = client.ping()
      await new Promise<void>((resolve) => setTimeout(resolve, 60))
      await ping
      release()
      await models
      expect(host.dispatches).toHaveLength(0)
      await flushAgentHostDiagnostics()
      const records = (await readFile(join(directory, 'agent-host-diagnostics', 'agent-host.jsonl'), 'utf8'))
        .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
      const responsivePing = records.find((record) => record.event === 'gateway.request' && record.method === 'ping' && record.status === 'ok')
      expect(responsivePing).toMatchObject({ traceId, channel: 'root', queueMs: expect.any(Number) })
      expect(responsivePing?.queueMs).toBeLessThan(500)
      expect(records).toContainEqual(expect.objectContaining({ event: 'gateway.models', traceId, status: 'ok', step: 'native' }))
      expect(records).toContainEqual(expect.objectContaining({ event: 'connection.models', parentTraceId: traceId, status: 'ok' }))
    } finally {
      release()
      await client?.shutdown()
      abort.abort()
      gateway.close()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      await connection.close()
      await host.close()
      await stopAgentHostDiagnostics()
      await rm(directory, { recursive: true, force: true })
    }
  }, 10000)
})
