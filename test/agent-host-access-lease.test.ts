// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { describe, expect, it, vi } from 'vitest'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { attachAgentHostGateway } from '../src/main/agentHostGateway'
import { GATEWAY_LIMITS } from '../src/main/agentHostGatewayScheduler'
import { connectAgentHostWebSocket, connectLocalAgentHost } from '../src/main/agentHostTransport'
import { startAgentHostFixture } from './agent-host-fixture'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'continuum-access-lease-'))
  const native = await startAgentHostFixture()
  const target = { sessionId: native.sessionId, chatId: native.chatId, owner: { clientId: randomUUID(), machineName: 'Owner' } }
  const connection = new AgentHostConnection(target, root, (signal) => connectLocalAgentHost(native.endpoint, signal))
  const policy = { version: 0, allowed: true, canSend: true, expiresAt: Infinity }
  const actor = { clientId: randomUUID(), machineName: 'Reader' }
  const authorize = vi.fn(async () => {
    if (!policy.allowed || Date.now() >= policy.expiresAt) throw new Error('Access revoked or expired.')
    const version = policy.version
    const canSend = policy.canSend
    return { canSend, actor, current: () => policy.allowed && Date.now() < policy.expiresAt && version === policy.version && canSend === policy.canSend }
  })
  const acquireConnection = vi.fn(async () => connection)
  const server = createServer()
  let port = 0
  const gateway = attachAgentHostGateway(server, { port: () => port, authorize, connection: acquireConnection })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as AddressInfo).port
  const url = `ws://127.0.0.1:${port}/device/agent-host?target=${Buffer.from(JSON.stringify(target)).toString('base64url')}`
  const headers = { Host: `127.0.0.1:${port}`, Authorization: 'Bearer fixture-token' }
  const clients: AhpClient[] = []
  const abort = new AbortController()
  return {
    native, target, policy, authorize, acquireConnection, gateway, url, headers,
    client: async () => {
      const client = new AhpClient(await connectAgentHostWebSocket(url, { headers }, abort.signal), { requestTimeoutMs: 15000 })
      clients.push(client)
      client.connect()
      await client.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0', '1.0.0'] })
      return client
    },
    close: async () => {
      abort.abort()
      await Promise.all(clients.map((client) => client.shutdown()))
      gateway.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await connection.close()
      await native.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe('verified live gateway access', () => {
  it('keeps ping and model reads under 250ms without renewing a still-current access lease', async () => {
    const setup = await fixture()
    try {
      const client = await setup.client()
      const { subscription } = await client.subscribe(setup.target.chatId)
      setup.authorize.mockClear()
      const start = performance.now()
      for (let index = 0; index < 20; index++) await client.ping()
      await client.subscribe('ahp-root://')
      setup.gateway.revalidate()
      await new Promise<void>((resolve) => setImmediate(resolve))
      setup.native.action({ type: 'chat/turnStarted', turnId: randomUUID(), startedAt: new Date().toISOString(), message: { text: 'Owner activity', origin: { kind: 'user' } } })
      expect((await subscription.next()).value).toMatchObject({ type: 'action', params: { action: { type: 'chat/turnStarted' } } })
      const elapsedMs = performance.now() - start
      expect(elapsedMs).toBeLessThan(250)
      expect(setup.authorize).not.toHaveBeenCalled()
      expect(setup.native.dispatches).toHaveLength(0)
      console.log(JSON.stringify({ heartbeatChecks: 20, elapsedMs: Math.round(elapsedMs), fullAccessRenewals: setup.authorize.mock.calls.length }))
    } finally { await setup.close() }
  })

  it.each(['revoked', 'expired', 'read-only'] as const)('rejects a previously authorized connection when access becomes %s', async (change) => {
    const setup = await fixture()
    try {
      const client = await setup.client()
      setup.authorize.mockClear()
      setup.policy.version++
      if (change === 'revoked') setup.policy.allowed = false
      else if (change === 'expired') setup.policy.expiresAt = Date.now() - 1
      else setup.policy.canSend = false
      await expect(client.ping()).rejects.toThrow()
      expect(setup.authorize).toHaveBeenCalled()
      expect(setup.native.dispatches).toHaveLength(0)
    } finally { await setup.close() }
  })

  it('does not open a native connection after the peer abandons a pending handshake', async () => {
    const setup = await fixture()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const authorize = setup.authorize.getMockImplementation()!
    setup.authorize.mockImplementation(async () => { entered(); await gate; return authorize() })
    const socket = new WebSocket(setup.url, { headers: setup.headers })
    socket.on('error', () => {})
    try {
      await started
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
      socket.terminate()
      await closed
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      release()
      await new Promise<void>((resolve) => setTimeout(resolve, 30))
      expect(setup.acquireConnection).not.toHaveBeenCalled()
      expect(setup.native.dispatches).toHaveLength(0)
    } finally { release(); socket.terminate(); await setup.close() }
  })

  it('cancels a pending authorization upgrade when the gateway closes', async () => {
    const setup = await fixture()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const authorize = setup.authorize.getMockImplementation()!
    setup.authorize.mockImplementation(async () => { entered(); await gate; return authorize() })
    const socket = new WebSocket(setup.url, { headers: setup.headers })
    socket.on('error', () => {})
    try {
      await started
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
      setup.gateway.close()
      await closed
      release()
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      expect(setup.acquireConnection).not.toHaveBeenCalled()
      expect(setup.native.dispatches).toHaveLength(0)
    } finally { release(); socket.terminate(); await setup.close() }
  })

  it('bounds a stalled upgrade by the existing 10-second connection deadline', async () => {
    const setup = await fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const authorize = setup.authorize.getMockImplementation()!
    setup.authorize.mockImplementation(async () => { await gate; return authorize() })
    const setTimer = globalThis.setTimeout
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
      setTimer(callback, delay === GATEWAY_LIMITS.queueWaitMs ? 50 : delay, ...args))
    const socket = new WebSocket(setup.url, { headers: setup.headers, handshakeTimeout: 0 })
    const errors: string[] = []
    socket.on('error', (error) => errors.push(error.message))
    try {
      await new Promise<void>((resolve) => socket.once('close', () => resolve()))
      expect(errors).toContain('Unexpected server response: 403')
      release()
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      expect(setup.acquireConnection).not.toHaveBeenCalled()
      expect(setup.native.dispatches).toHaveLength(0)
    } finally { timer.mockRestore(); release(); socket.terminate(); await setup.close() }
  })
})
