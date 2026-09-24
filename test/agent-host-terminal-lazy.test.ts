// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageKind } from '@microsoft/agent-host-protocol'
import type { ChatTurnCancelledAction, ChatTurnStartedAction } from '@microsoft/agent-host-protocol'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { describe, expect, it, vi } from 'vitest'
import { AgentHostConnection } from '../src/main/agentHostConnection'
import { attachAgentHostGateway } from '../src/main/agentHostGateway'
import { connectAgentHostWebSocket, connectLocalAgentHost } from '../src/main/agentHostTransport'
import { startAgentHostFixture } from './agent-host-fixture'

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function gatewaySetup(delayMs = 0) {
  const root = await mkdtemp(join(tmpdir(), 'continuum-ahp-lazy-'))
  const host = await startAgentHostFixture()
  const target = { sessionId: host.sessionId, chatId: host.chatId, owner: { clientId: randomUUID(), machineName: 'Owner-B' } }
  const connection = new AgentHostConnection(target, root, (signal) => connectLocalAgentHost(host.endpoint, signal))
  const policy: { allowed: boolean; canSend: boolean; pauseNext?: Promise<void>; onPause?: () => void } = { allowed: true, canSend: true }
  const server = createServer()
  let port = 0
  const gateway = attachAgentHostGateway(server, {
    port: () => port,
    authorize: async (token, _target, send) => {
      if (token !== 'test-token' || !policy.allowed || send && !policy.canSend) throw new Error('Denied.')
      const pause = policy.pauseNext
      if (pause) { policy.pauseNext = undefined; policy.onPause?.(); await pause }
      if (delayMs) await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      if (!policy.allowed) throw new Error('Access revoked.')
      return { canSend: policy.canSend, actor: { clientId: randomUUID(), machineName: 'Test client' } }
    },
    connection: async () => connection,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as AddressInfo).port
  const clients: { client: AhpClient; abort: AbortController }[] = []
  const transport = (signal: AbortSignal) => connectAgentHostWebSocket(`ws://127.0.0.1:${port}/device/agent-host?target=${Buffer.from(JSON.stringify(target)).toString('base64url')}`, {
    headers: { Host: `127.0.0.1:${port}`, Authorization: 'Bearer test-token' },
  }, signal)
  return {
    root, host, target, connection, policy, transport,
    client: async (initialize = true) => {
      const abort = new AbortController()
      const client = new AhpClient(await transport(abort.signal), { requestTimeoutMs: 15000 })
      clients.push({ client, abort })
      client.connect()
      if (initialize) await client.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'] })
      return client
    },
    close: async () => {
      for (const { client, abort } of clients) { abort.abort(); await client.shutdown() }
      gateway.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await connection.close()
      await host.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe('Agent Host terminal demand', () => {
  it('sends through the gateway without model queries on either side after catalog loading', async () => {
    const setup = await gatewaySetup()
    const remote = new AgentHostConnection(setup.target, setup.root, (signal) => setup.transport(signal))
    const models = vi.spyOn(setup.connection, 'models')
    try {
      await remote.models()
      expect(models).toHaveBeenCalledOnce()
      expect(setup.host.modelQueries()).toBe(1)
      setup.host.failModels(true)
      for (let index = 0; index < 2; index++) {
        const id = randomUUID()
        await remote.send(id, 'Reuse the selected model', undefined, async () => {}, undefined, { id: 'gpt-6' })
        setup.host.action({ type: 'chat/turnComplete', turnId: id, duration: 1 })
        await expect.poll(() => remote.view.chat?.activeTurn).toBeUndefined()
      }
      expect(models).toHaveBeenCalledOnce()
      expect(setup.host.modelQueries()).toBe(1)
      expect(setup.host.dispatches).toHaveLength(2)
      setup.host.failModels(false)
      setup.host.setModels([{ id: 'owner-model', name: 'Owner model', provider: 'copilotcli' }])
      await remote.models()
      await expect(remote.send(randomUUID(), 'Do not fall back', undefined, async () => {}, undefined, { id: 'gpt-6' })).rejects.toThrow('no longer available')
      expect(models).toHaveBeenCalledTimes(2)
      expect(setup.host.modelQueries()).toBe(2)
      expect(setup.host.dispatches).toHaveLength(2)
    } finally { await remote.close(); await setup.close() }
  })

  it('does not replay 16 failed history subscriptions on open or reconnect and retries only on demand', async () => {
    const setup = await gatewaySetup()
    const resources = setup.host.historyTerminals(16, true)
    try {
      await setup.connection.open()
      expect(resources.map(setup.host.terminalSubscriptions)).toEqual(Array(16).fill(0))
      expect(await setup.connection.models()).toContainEqual(expect.objectContaining({ id: 'gpt-6' }))
      setup.connection.retainTerminal(resources[0])
      await expect(setup.connection.terminal(resources[0])).rejects.toThrow('-32001')
      expect(setup.connection.view.state).toBe('connected')
      expect(setup.connection.view.terminalStatus?.[resources[0]]).toMatchObject({ state: 'error', error: expect.stringContaining('Retry manually') })
      await expect(setup.connection.terminal(resources[0])).rejects.toThrow('Retry manually')
      expect(setup.host.terminalSubscriptions(resources[0])).toBe(1)
      setup.host.restoreTerminal(resources[0])
      const snapshot = await setup.connection.terminal(resources[0], true)
      expect(snapshot.state).toMatchObject({ content: [{ value: 'Full historical output 0' }] })
      expect(setup.host.terminalSubscriptions(resources[0])).toBe(2)
      setup.connection.releaseTerminal(resources[0])
      await expect.poll(() => setup.connection.view.terminals[resources[0]]).toBeUndefined()
      setup.host.drop()
      await expect.poll(() => setup.connection.view.state).toBe('offline')
      await setup.connection.open()
      expect(resources.map(setup.host.terminalSubscriptions)).toEqual([2, ...Array(15).fill(0)])
      expect(setup.connection.view.chat?.turns).toHaveLength(16)
      expect(setup.host.dispatches).toHaveLength(0)
    } finally { await setup.close() }
  })

  it('does not treat a stale running label in a completed turn as a live terminal', async () => {
    const setup = await gatewaySetup()
    const [resource] = setup.host.historyTerminals(1, true, 'running')
    try {
      await setup.connection.open()
      await setup.connection.models()
      expect(setup.host.terminalSubscriptions(resource)).toBe(0)
      expect(setup.connection.view.state).toBe('connected')
    } finally { await setup.close() }
  })

  it('automatically subscribes a running terminal and applies live output events', async () => {
    const setup = await gatewaySetup()
    const resource = `ahp-terminal:/running-${randomUUID()}`
    setup.host.addTerminal(resource, 'Initial ')
    try {
      await setup.connection.open()
      const turnId = randomUUID()
      setup.host.action({ type: 'chat/turnStarted', turnId, startedAt: new Date().toISOString(), message: { text: 'Run checks', origin: { kind: 'user' } } })
      setup.host.action({ type: 'chat/responsePart', turnId, part: { kind: 'toolCall', toolCall: {
        toolCallId: 'running-tool', toolName: 'terminal', displayName: 'Run checks', status: 'running',
        content: [{ type: 'terminal', resource, title: 'Output' }],
      } } })
      await expect.poll(() => setup.host.terminalSubscriptions(resource)).toBe(1)
      setup.host.terminalAction(resource, 'live update')
      await expect.poll(() => JSON.stringify(setup.connection.view.terminals[resource]?.content)).toContain('Initial live update')
      expect(setup.connection.view.state).toBe('connected')
    } finally { await setup.close() }
  })

  it('streams a live terminal from the owner through the gateway to the remote chat', async () => {
    const setup = await gatewaySetup()
    const resource = `ahp-terminal:/remote-running-${randomUUID()}`
    const turnId = randomUUID()
    setup.host.addTerminal(resource, 'Owner start ')
    setup.host.action({ type: 'chat/turnStarted', turnId, startedAt: new Date().toISOString(), message: { text: 'Run checks', origin: { kind: 'user' } } })
    setup.host.action({ type: 'chat/responsePart', turnId, part: { kind: 'toolCall', toolCall: {
      toolCallId: 'remote-tool', toolName: 'terminal', displayName: 'Run checks', status: 'running',
      content: [{ type: 'terminal', resource, title: 'Output' }],
    } } })
    const remote = new AgentHostConnection(setup.target, setup.root, (signal) => setup.transport(signal))
    try {
      await remote.open()
      await expect.poll(() => JSON.stringify(remote.view.terminals[resource]?.content)).toContain('Owner start')
      setup.host.terminalAction(resource, 'live update')
      await expect.poll(() => JSON.stringify(remote.view.terminals[resource]?.content)).toContain('Owner start live update')
      expect(setup.host.terminalSubscriptions(resource)).toBe(1)
      expect(remote.view.state).toBe('connected')
    } finally { await remote.close(); await setup.close() }
  })

  it('coalesces simultaneous requests for one terminal into one native subscription', async () => {
    const setup = await gatewaySetup()
    const [resource] = setup.host.historyTerminals(1)
    const release = setup.host.holdTerminal(resource)
    try {
      await setup.connection.open()
      setup.connection.retainTerminal(resource)
      const first = setup.connection.terminal(resource)
      await expect.poll(() => setup.host.terminalSubscriptions(resource)).toBe(1)
      const second = setup.connection.terminal(resource)
      expect(setup.host.terminalSubscriptions(resource)).toBe(1)
      release()
      const [one, two] = await Promise.all([first, second])
      expect(two).toEqual(one)
      expect(setup.connection.view.terminals[resource]).toBeDefined()
      setup.connection.releaseTerminal(resource)
    } finally { release(); await setup.close() }
  })

  it('waits for initialization before serving models and forbids history in initial subscriptions', async () => {
    const setup = await gatewaySetup()
    const [resource] = setup.host.historyTerminals(1)
    const blocked = deferred()
    const entered = deferred()
    try {
      const client = await setup.client(false)
      const models = vi.spyOn(setup.connection, 'models')
      setup.policy.pauseNext = blocked.promise
      setup.policy.onPause = entered.release
      const initializing = client.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'], initialSubscriptions: [setup.target.sessionId] })
      await entered.promise
      const catalog = client.request('subscribe', { channel: 'ahp-root://' })
      await new Promise<void>((resolve) => setTimeout(resolve, 30))
      expect(models).not.toHaveBeenCalled()
      blocked.release()
      await expect(initializing).resolves.toMatchObject({ snapshots: [{ resource: setup.target.sessionId }] })
      await expect(catalog).resolves.toMatchObject({ snapshot: { resource: 'ahp-root://' } })
      const invalid = await setup.client(false)
      await expect(invalid.initialize({ clientId: randomUUID(), protocolVersions: ['0.9.0'], initialSubscriptions: [resource] })).rejects.toThrow('not authorized')
      expect(setup.host.terminalSubscriptions(resource)).toBe(0)
    } finally { blocked.release(); await setup.close() }
  })

  it('keeps models and ping within 15 seconds with 16 failing historical resources and one-second authorization', async () => {
    const setup = await gatewaySetup(1000)
    const resources = setup.host.historyTerminals(16, true)
    const remote = new AgentHostConnection(setup.target, setup.root, (signal) => setup.transport(signal))
    try {
      await remote.open()
      expect(resources.map(setup.host.terminalSubscriptions)).toEqual(Array(16).fill(0))
      const started = performance.now()
      await expect(remote.models()).resolves.toContainEqual(expect.objectContaining({ id: 'gpt-6' }))
      expect(performance.now() - started).toBeLessThan(15_000)
      const raw = await setup.client()
      const failures = resources.map((resource) => raw.request('subscribe', { channel: resource }).catch((error: unknown) => error))
      const concurrent = performance.now()
      await Promise.all([raw.ping(), raw.request('subscribe', { channel: 'ahp-root://' })])
      expect(performance.now() - concurrent).toBeLessThan(15_000)
      await Promise.all(failures)
      expect(resources.reduce((total, resource) => total + setup.host.terminalSubscriptions(resource), 0)).toBeLessThan(16)
      expect(setup.host.dispatches).toHaveLength(0)
    } finally { await remote.close(); await setup.close() }
  }, 45000)

  it('rejects unrelated terminals and mismatched native claims without exposing another chat', async () => {
    const setup = await gatewaySetup()
    const [allowed, wrongClaim] = setup.host.historyTerminals(2)
    const unrelated = `ahp-terminal:/unrelated-${randomUUID()}`
    setup.host.addTerminal(unrelated, 'Private sibling output')
    setup.host.moveTerminalToOtherChat(wrongClaim)
    try {
      const client = await setup.client()
      await expect(client.subscribe(unrelated)).rejects.toThrow('not authorized')
      expect(setup.host.terminalSubscriptions(unrelated)).toBe(0)
      await expect(client.subscribe(wrongClaim)).rejects.toThrow('Terminal output is unavailable')
      expect(setup.connection.view.terminals[wrongClaim]).toBeUndefined()
      expect((await client.subscribe(allowed)).result.snapshot?.state).toMatchObject({ claim: { chat: setup.target.chatId } })
      await client.ping()
      setup.policy.allowed = false
      await expect(client.ping()).rejects.toThrow()
      expect(setup.host.dispatches).toHaveLength(0)
    } finally { await setup.close() }
  })

  it('permits read-only subscriptions but never dispatches a send', async () => {
    const setup = await gatewaySetup()
    const [resource] = setup.host.historyTerminals(1)
    setup.policy.canSend = false
    try {
      const client = await setup.client()
      expect((await client.subscribe(resource)).result.snapshot?.resource).toBe(resource)
      expect((await client.subscribe('ahp-root://')).result.snapshot?.resource).toBe('ahp-root://')
      client.dispatch(setup.target.chatId, { type: 'chat/turnStarted' as ChatTurnStartedAction['type'], turnId: randomUUID(),
        startedAt: new Date().toISOString(), message: { text: 'Not allowed', origin: { kind: MessageKind.User } } })
      await expect.poll(() => client.connectionState.status).toBe('closed')
      expect(setup.host.dispatches).toHaveLength(0)
    } finally { await setup.close() }
  })

  it('includes events received during an on-demand snapshot in the snapshot before streaming later actions', async () => {
    const setup = await gatewaySetup()
    const [resource] = setup.host.historyTerminals(1)
    const gate = deferred()
    const entered = deferred()
    try {
      const client = await setup.client()
      const original = setup.connection.terminal.bind(setup.connection)
      vi.spyOn(setup.connection, 'terminal').mockImplementationOnce(async (...args) => {
        const snapshot = await original(...args)
        entered.release()
        await gate.promise
        return snapshot
      })
      const pending = client.subscribe(resource)
      await entered.promise
      setup.host.terminalAction(resource, ' during snapshot')
      await expect.poll(() => JSON.stringify(setup.connection.view.terminals[resource]?.content)).toContain('during snapshot')
      gate.release()
      const { result, subscription } = await pending
      expect(JSON.stringify(result.snapshot?.state)).toContain('during snapshot')
      const firstEvent = subscription.next()
      setup.host.terminalAction(resource, ' after snapshot')
      const delivered = await firstEvent
      expect(delivered.done).toBe(false)
      if (delivered.done) throw new Error('Terminal event stream closed.')
      expect(delivered.value.type).toBe('action')
      if (delivered.value.type !== 'action') throw new Error('Expected an action after the snapshot.')
      expect(delivered.value.params.serverSeq).toBeGreaterThan(result.snapshot!.fromSeq)
      expect(delivered.value.params.action).toMatchObject({ type: 'terminal/data', data: ' after snapshot' })
      await client.unsubscribe(resource)
      await expect.poll(() => setup.connection.view.terminals[resource]).toBeUndefined()
    } finally { gate.release(); await setup.close() }
  })

  it('does not resurrect a subscription cancelled while its native snapshot is in flight', async () => {
    const setup = await gatewaySetup()
    const [resource] = setup.host.historyTerminals(1)
    const gate = deferred()
    const entered = deferred()
    try {
      const client = await setup.client()
      const original = setup.connection.terminal.bind(setup.connection)
      vi.spyOn(setup.connection, 'terminal').mockImplementationOnce(async (...args) => {
        const snapshot = await original(...args)
        entered.release()
        await gate.promise
        return snapshot
      })
      const pending = client.subscribe(resource)
      await entered.promise
      await client.unsubscribe(resource)
      const reopened = client.subscribe(resource)
      await expect.poll(() => setup.connection.view.terminals[resource]).toBeUndefined()
      gate.release()
      await expect(pending).rejects.toThrow('not authorized')
      expect((await reopened).result.snapshot?.state).toMatchObject({ claim: { chat: setup.target.chatId } })
      expect(setup.host.terminalSubscriptions(resource)).toBe(2)
    } finally { gate.release(); await setup.close() }
  })

  it('rechecks authorization after a native terminal request before returning any output', async () => {
    const setup = await gatewaySetup()
    const [resource] = setup.host.historyTerminals(1)
    const gate = deferred()
    const entered = deferred()
    try {
      const client = await setup.client()
      const original = setup.connection.terminal.bind(setup.connection)
      vi.spyOn(setup.connection, 'terminal').mockImplementationOnce(async (...args) => {
        const snapshot = await original(...args)
        entered.release()
        await gate.promise
        return snapshot
      })
      const pending = client.subscribe(resource)
      await entered.promise
      setup.policy.allowed = false
      gate.release()
      await expect(pending).rejects.toThrow()
      expect(setup.host.dispatches).toHaveLength(0)
    } finally { gate.release(); await setup.close() }
  })

  it('orders send before cancel without letting execution hold a ping', async () => {
    const setup = await gatewaySetup()
    const gate = deferred()
    const order: string[] = []
    try {
      const client = await setup.client()
      const actualSend = setup.connection.send.bind(setup.connection)
      const actualCancel = setup.connection.cancel.bind(setup.connection)
      vi.spyOn(setup.connection, 'send').mockImplementation(async (...args) => {
        order.push('send')
        await gate.promise
        return actualSend(...args)
      })
      vi.spyOn(setup.connection, 'cancel').mockImplementation(async (...args) => {
        order.push('cancel')
        return actualCancel(...args)
      })
      const turnId = randomUUID()
      client.dispatch(setup.target.chatId, { type: 'chat/turnStarted' as ChatTurnStartedAction['type'], turnId, startedAt: new Date().toISOString(),
        message: { text: 'Run once', origin: { kind: MessageKind.User } } })
      client.dispatch(setup.target.chatId, { type: 'chat/turnCancelled' as ChatTurnCancelledAction['type'], turnId, duration: 0 })
      await expect.poll(() => order).toEqual(['send'])
      await client.ping()
      expect(order).toEqual(['send'])
      gate.release()
      await expect.poll(() => order).toEqual(['send', 'cancel'])
      await expect.poll(() => setup.host.dispatches).toHaveLength(2)
      expect(setup.host.dispatches).toEqual([expect.objectContaining({ type: 'chat/turnStarted' }), expect.objectContaining({ type: 'chat/turnCancelled' })])
    } finally { gate.release(); await setup.close() }
  })

  it('caps simultaneous history fetches across different connected clients without blocking models', async () => {
    const setup = await gatewaySetup()
    const resources = setup.host.historyTerminals(6)
    const gate = deferred()
    let running = 0
    let peak = 0
    try {
      const clients = await Promise.all(resources.map(() => setup.client()))
      const original = setup.connection.terminal.bind(setup.connection)
      vi.spyOn(setup.connection, 'terminal').mockImplementation(async (...args) => {
        peak = Math.max(peak, ++running)
        await gate.promise
        try { return await original(...args) } finally { running-- }
      })
      const terminalRequests = clients.map((client, index) => client.subscribe(resources[index]))
      await expect.poll(() => running).toBe(4)
      await clients[5].ping()
      expect((await clients[5].subscribe('ahp-root://')).result.snapshot?.resource).toBe('ahp-root://')
      gate.release()
      await Promise.all(terminalRequests)
      expect(peak).toBe(4)
    } finally { gate.release(); await setup.close() }
  })

  it('bounds retained history subscriptions and frees capacity on unsubscribe', async () => {
    const setup = await gatewaySetup()
    const resources = setup.host.historyTerminals(33)
    try {
      const client = await setup.client()
      for (const resource of resources.slice(0, 32)) expect((await client.subscribe(resource)).result.snapshot?.resource).toBe(resource)
      await expect(client.subscribe(resources[32])).rejects.toThrow('not authorized')
      expect(setup.host.terminalSubscriptions(resources[32])).toBe(0)
      await client.ping()
      await client.unsubscribe(resources[0])
      await expect.poll(() => setup.connection.view.terminals[resources[0]]).toBeUndefined()
      expect((await client.subscribe(resources[32])).result.snapshot?.resource).toBe(resources[32])
      expect(setup.host.terminalSubscriptions(resources[32])).toBe(1)
    } finally { await setup.close() }
  })
})
